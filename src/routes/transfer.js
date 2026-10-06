const express = require('express');
const { executeMySql } = require('../db/mysqlPool');

const router = express.Router();

async function ensureTransferTable() {
    try {
        await executeMySql(`
            CREATE TABLE IF NOT EXISTS transfer_log (
                transfer_id INT AUTO_INCREMENT PRIMARY KEY,
                transfer_no VARCHAR(50) NOT NULL,
                transfer_type VARCHAR(20) NOT NULL,
                prescription_no VARCHAR(100) NULL,
                ward_code VARCHAR(50) NULL,
                ward_name VARCHAR(255) NULL,
                recipient_id VARCHAR(100) NULL,
                recipient_name VARCHAR(255) NOT NULL,
                transfer_datetime DATETIME NOT NULL,
                transfer_userid VARCHAR(100) NULL,
                item_count INT DEFAULT 0,
                notes TEXT NULL,
                INDEX idx_transfer_dt (transfer_datetime),
                INDEX idx_rx_no (prescription_no),
                INDEX idx_ward (ward_code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        // Ensure prescription & packagemaster have medtransferdatetime and medtransferuserid
        for (const tbl of ['prescription', 'packagemaster']) {
            try {
                const cols = await executeMySql(`DESCRIBE ${tbl}`);
                const existing = new Set(cols.map(c => c.Field.toLowerCase()));
                if (!existing.has('medtransferdatetime')) {
                    await executeMySql(`ALTER TABLE ${tbl} ADD COLUMN medtransferdatetime DATETIME NULL`);
                }
                if (!existing.has('medtransferuserid')) {
                    await executeMySql(`ALTER TABLE ${tbl} ADD COLUMN medtransferuserid VARCHAR(255) NULL`);
                }
            } catch (_) {}
        }
    } catch (err) {
        console.error('ensureTransferTable error:', err.message);
    }
}

// 1. Get wards with pending transfer prescriptions
router.post('/api/transfer/pending-wards', async (req, res) => {
    try {
        await ensureTransferTable();
        const payload = req.body || {};
        const search = payload.search ? `%${String(payload.search).trim()}%` : null;

        const sql = `
            SELECT 
                COALESCE(prescription.wardcode, 'UNKNOWN') AS wardcode,
                COALESCE(prescription.wardname, 'ไม่ระบุวอร์ด') AS wardname,
                COUNT(DISTINCT prescription.prescriptionno) AS total_prescriptions,
                COUNT(DISTINCT CASE WHEN packagemaster.checkoutdatetime IS NOT NULL AND packagemaster.medtransferdatetime IS NULL THEN prescription.prescriptionno END) AS pending_transfer_rx,
                SUM(CASE WHEN packagemaster.checkoutdatetime IS NOT NULL AND packagemaster.medtransferdatetime IS NULL THEN 1 ELSE 0 END) AS pending_transfer_items
            FROM prescription
            LEFT JOIN packagemaster ON prescription.prescriptionno = packagemaster.prescriptionno AND packagemaster.voiddatetime IS NULL
            WHERE prescription.voiddatetime IS NULL
            ${search ? 'AND (prescription.wardcode LIKE ? OR prescription.wardname LIKE ?)' : ''}
            GROUP BY prescription.wardcode, prescription.wardname
            HAVING pending_transfer_rx > 0 OR pending_transfer_items > 0
            ORDER BY pending_transfer_rx DESC, wardname ASC
        `;
        const params = search ? [search, search] : [];
        const rows = await executeMySql(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Get pending prescriptions (or lookup by barcode)
router.post('/api/transfer/pending-prescriptions', async (req, res) => {
    try {
        await ensureTransferTable();
        const payload = req.body || {};
        const filters = ['prescription.voiddatetime IS NULL'];
        const params = [];

        if (payload.wardCode && String(payload.wardCode).trim() !== '') {
            filters.push('prescription.wardcode = ?');
            params.push(String(payload.wardCode).trim());
        }
        if (payload.barcode && String(payload.barcode).trim() !== '') {
            const bc = String(payload.barcode).trim();
            filters.push('(prescription.prescriptionno = ? OR prescription.hn = ? OR prescription.an = ?)');
            params.push(bc, bc, bc);
        } else if (payload.search && String(payload.search).trim() !== '') {
            const q = `%${String(payload.search).trim()}%`;
            filters.push('(prescription.prescriptionno LIKE ? OR prescription.hn LIKE ? OR prescription.patientname LIKE ?)');
            params.push(q, q, q);
        } else if (!payload.wardCode) {
            // Default: only those with checked out items awaiting transfer
            filters.push('packagemaster.checkoutdatetime IS NOT NULL');
            filters.push('packagemaster.medtransferdatetime IS NULL');
        }

        const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

        const sql = `
            SELECT
                prescription.prescriptionno,
                prescription.hn,
                prescription.an,
                prescription.patientname,
                prescription.wardcode,
                prescription.wardname,
                prescription.bedcode,
                COUNT(DISTINCT prescription.seq) AS item_count,
                MAX(COALESCE(prescription.checkdatetime, prescription.confirmdatetime, prescription.ordercreatedate)) AS screen_dt,
                MAX(packagemaster.matchingdatetime) AS match_dt,
                MAX(packagemaster.checkoutdatetime) AS checkout_dt,
                MAX(packagemaster.medtransferdatetime) AS transfer_dt,
                MAX(packagemaster.checkoutuserid) AS checkout_user,
                MAX(packagemaster.medtransferuserid) AS transfer_user
            FROM prescription
            LEFT JOIN packagemaster ON prescription.prescriptionno = packagemaster.prescriptionno AND packagemaster.voiddatetime IS NULL
            ${where}
            GROUP BY
                prescription.prescriptionno,
                prescription.hn,
                prescription.an,
                prescription.patientname,
                prescription.wardcode,
                prescription.wardname,
                prescription.bedcode
            ORDER BY checkout_dt DESC, prescription.prescriptionno DESC
            LIMIT 200
        `;
        const rows = await executeMySql(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Execute transfer
router.post('/api/transfer/execute', async (req, res) => {
    try {
        await ensureTransferTable();
        const payload = req.body || {};
        const transferType = payload.transferType || 'individual';
        const recipientId = (payload.recipientId || '').trim();
        const recipientName = (payload.recipientName || '').trim();
        const transferUserid = (payload.transferUserid || 'System').trim();
        const wardCode = (payload.wardCode || '').trim();
        const wardName = (payload.wardName || '').trim();
        const notes = (payload.notes || '').trim();
        const prescriptionNos = Array.isArray(payload.prescriptionNos) ? payload.prescriptionNos.filter(Boolean) : [];

        if (!recipientName) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อผู้รับยา' });
        }
        if (prescriptionNos.length === 0) {
            return res.status(400).json({ success: false, message: 'ไม่พบรายการใบสั่งยาที่ต้องการส่งมอบ' });
        }

        const nowStr = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8);
        const rand = Math.floor(1000 + Math.random() * 9000);
        const transferNo = `TR-${nowStr}-${rand}`;

        // Insert log entries for each prescription (or combined if bulk)
        for (const rx of prescriptionNos) {
            await executeMySql(`
                INSERT INTO transfer_log 
                (transfer_no, transfer_type, prescription_no, ward_code, ward_name, recipient_id, recipient_name, transfer_datetime, transfer_userid, item_count, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, 1, ?)
            `, [
                transferNo,
                transferType,
                rx,
                wardCode || null,
                wardName || null,
                recipientId || null,
                recipientName,
                transferUserid,
                notes || null
            ]);
        }

        // Update prescription and packagemaster tables
        const placeholders = prescriptionNos.map(() => '?').join(', ');
        await executeMySql(`
            UPDATE prescription
            SET medtransferdatetime = NOW(), medtransferuserid = ?
            WHERE prescriptionno IN (${placeholders}) AND voiddatetime IS NULL
        `, [transferUserid, ...prescriptionNos]);

        await executeMySql(`
            UPDATE packagemaster
            SET medtransferdatetime = NOW(), medtransferuserid = ?
            WHERE prescriptionno IN (${placeholders}) AND voiddatetime IS NULL
        `, [transferUserid, ...prescriptionNos]);

        res.json({
            success: true,
            transfer_no: transferNo,
            updated_count: prescriptionNos.length,
            message: `บันทึกส่งมอบยาเรียบร้อย (${transferNo})`
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. Get transfer history/audit logs
router.post('/api/transfer/history', async (req, res) => {
    try {
        await ensureTransferTable();
        const payload = req.body || {};
        const filters = ['1 = 1'];
        const params = [];

        if (payload.dateFrom) {
            filters.push('transfer_datetime >= ?');
            params.push(`${payload.dateFrom} 00:00:00`);
        }
        if (payload.dateTo) {
            filters.push('transfer_datetime <= ?');
            params.push(`${payload.dateTo} 23:59:59`);
        }
        if (payload.wardCode && String(payload.wardCode).trim() !== '') {
            filters.push('ward_code = ?');
            params.push(String(payload.wardCode).trim());
        }
        if (payload.transferType && String(payload.transferType).trim() !== '') {
            filters.push('transfer_type = ?');
            params.push(String(payload.transferType).trim());
        }
        if (payload.search && String(payload.search).trim() !== '') {
            const q = `%${String(payload.search).trim()}%`;
            filters.push('(transfer_no LIKE ? OR prescription_no LIKE ? OR recipient_name LIKE ? OR ward_name LIKE ?)');
            params.push(q, q, q, q);
        }

        const where = `WHERE ${filters.join(' AND ')}`;
        const sql = `
            SELECT
                transfer_id,
                transfer_no,
                transfer_type,
                prescription_no,
                ward_code,
                ward_name,
                recipient_id,
                recipient_name,
                transfer_datetime,
                transfer_userid,
                item_count,
                notes
            FROM transfer_log
            ${where}
            ORDER BY transfer_datetime DESC, transfer_id DESC
            LIMIT 300
        `;
        const rows = await executeMySql(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
