const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { exec } = require('child_process');
const { executeMySql } = require('../db/mysqlPool');
const { resolveClientInfo } = require('../utils/clientInfo');

const router = express.Router();

/* ─── Image upload (multer disk storage) ────────────────────────── */
const DRUG_IMG_DIR = process.env.DRUG_IMG_DIR || path.join(__dirname, '../../public/images/drugs');
if (!fs.existsSync(DRUG_IMG_DIR)) fs.mkdirSync(DRUG_IMG_DIR, { recursive: true });

const drugImgStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, DRUG_IMG_DIR),
    filename: (req, file, cb) => {
        const code = (req.body.orderitemcode || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        cb(null, `${code}${ext}`);
    },
});
const drugImgUpload = multer({
    storage: drugImgStorage,
    limits: { fileSize: 8 * 1024 * 1024 },   // 8 MB max
    fileFilter: (_req, file, cb) => {
        const ok = /image\/(jpeg|png|gif|webp)/i.test(file.mimetype);
        cb(ok ? null : new Error('Only image files allowed'), ok);
    },
});

/* ─── ms_drug (existing table) ──────────────────────────────────── */

async function ensureDrugTableColumns() {
    try {
        const cols = await executeMySql('DESCRIBE ms_drug');
        const existing = new Set(cols.map(c => c.Field.toLowerCase()));
        const needed = [
            { col: 'imageurl', def: 'VARCHAR(500) NULL' },
            { col: 'instruction', def: 'VARCHAR(500) NULL' },
            { col: 'orderqty', def: 'VARCHAR(50) NULL' },
            { col: 'orderunitcode', def: 'VARCHAR(50) NULL' },
            { col: 'startdate', def: 'VARCHAR(50) NULL' },
            { col: 'doctor', def: 'VARCHAR(255) NULL' }
        ];
        for (const { col, def } of needed) {
            if (!existing.has(col)) {
                try {
                    await executeMySql(`ALTER TABLE ms_drug ADD COLUMN ${col} ${def}`);
                } catch (_) { }
            }
        }
    } catch (e) {
        console.error('ensureDrugTableColumns error:', e.message);
    }
}

router.get('/api/settings/drugs/columns', async (req, res) => {
    try {
        await ensureDrugTableColumns();
        const cols = await executeMySql('DESCRIBE ms_drug');
        res.json({ success: true, data: cols });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/api/settings/drugs', async (req, res) => {
    try {
        await ensureDrugTableColumns();
        const cols = await executeMySql('DESCRIBE ms_drug');
        const colNames = cols.map((c) => c.Field);

        const search = req.query.search ? `%${req.query.search}%` : null;
        let sql = `
            SELECT *, 
                   (SELECT GROUP_CONCAT(CONCAT(b.boxid, ' ', b.location) SEPARATOR ', ') 
                    FROM ms_bin b 
                    WHERE b.orderitemcode = ms_drug.orderitemcode) as bin_locations
            FROM ms_drug
        `;
        const params = [];

        if (search) {
            const textCols = cols
                .filter((c) => /char|text|varchar/i.test(c.Type))
                .map((c) => c.Field);
            if (textCols.length > 0) {
                sql += ' WHERE ' + textCols.map((col) => `${col} LIKE ?`).join(' OR ');
                textCols.forEach(() => params.push(search));
            }
        }

        const orderCol = colNames.includes('drugcode') ? 'drugcode'
            : colNames.includes('code') ? 'code'
                : colNames[0];
        sql += ` ORDER BY ${orderCol}`;

        const result = await executeMySql(sql, params);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/api/settings/drugs', async (req, res) => {
    try {
        const cols = await executeMySql('DESCRIBE ms_drug');
        const validCols = cols.map(c => c.Field);
        const pkCol = cols.find((c) => c.Key === 'PRI')?.Field ?? 'id';
        const body = req.body;
        const setCols = Object.keys(body).filter((k) => k !== pkCol && validCols.includes(k));
        if (setCols.length === 0) return res.status(400).json({ success: false, message: 'No fields provided' });
        const placeholders = setCols.map(() => '?').join(', ');
        const values = setCols.map((k) => body[k] ?? null);
        await executeMySql(
            `INSERT INTO ms_drug (${setCols.join(', ')}) VALUES (${placeholders})`,
            values
        );
        res.status(201).json({ success: true, message: 'Drug created' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put('/api/settings/drugs/:id', async (req, res) => {
    try {
        const cols = await executeMySql('DESCRIBE ms_drug');
        const pkCol = cols.find((c) => c.Key === 'PRI')?.Field ?? 'id';
        const validCols = cols.map(c => c.Field);
        const body = req.body;
        const setCols = Object.keys(body).filter((k) => k !== pkCol && validCols.includes(k));
        if (setCols.length === 0) return res.status(400).json({ success: false, message: 'No fields provided' });
        const setParts = setCols.map((k) => `${k} = ?`).join(', ');
        const values = [...setCols.map((k) => body[k] ?? null), req.params.id];
        const result = await executeMySql(`UPDATE ms_drug SET ${setParts} WHERE ${pkCol} = ?`, values);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Not found' });
        res.json({ success: true, message: 'Drug updated' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put('/api/settings/drugs/by-orderitemcode/:orderitemcode', async (req, res) => {
    try {
        const cols = await executeMySql('DESCRIBE ms_drug');
        const validCols = cols.map(c => c.Field);
        const body = req.body;
        const setCols = Object.keys(body).filter((k) => k !== 'orderitemcode' && validCols.includes(k));
        if (setCols.length === 0) return res.status(400).json({ success: false, message: 'No fields provided' });
        const setParts = setCols.map((k) => `${k} = ?`).join(', ');
        const values = [...setCols.map((k) => body[k] ?? null), req.params.orderitemcode];
        const result = await executeMySql(`UPDATE ms_drug SET ${setParts} WHERE orderitemcode = ?`, values);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Drug not found by orderitemcode' });
        res.json({ success: true, message: 'Drug updated' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete('/api/settings/drugs/:id', async (req, res) => {
    try {
        const cols = await executeMySql('DESCRIBE ms_drug');
        const pkCol = cols.find((c) => c.Key === 'PRI')?.Field ?? 'id';
        const result = await executeMySql(`DELETE FROM ms_drug WHERE ${pkCol} = ?`, [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Not found' });
        res.json({ success: true, message: 'Drug deleted' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* ─── Drug image upload ──────────────────────────────────────────── */

router.post('/api/settings/drugs/upload-image', drugImgUpload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No image file uploaded' });
        const orderitemcode = (req.body.orderitemcode || '').trim();
        if (!orderitemcode) return res.status(400).json({ success: false, message: 'orderitemcode required' });

        const imagepath = `/images/drugs/${req.file.filename}`;

        // Persist path to ms_drug.imageurl (if column exists)
        try {
            await executeMySql('UPDATE ms_drug SET imageurl = ? WHERE orderitemcode = ?', [imagepath, orderitemcode]);
        } catch (_) { /* column may not exist yet — ignore */ }

        res.json({ success: true, imagepath });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete('/api/settings/drugs/remove-image/:orderitemcode', async (req, res) => {
    try {
        const orderitemcode = decodeURIComponent(req.params.orderitemcode || '').trim();
        if (!orderitemcode) return res.status(400).json({ success: false, message: 'orderitemcode required' });

        // Fetch current path from DB
        const rows = await executeMySql('SELECT imageurl FROM ms_drug WHERE orderitemcode = ? LIMIT 1', [orderitemcode]);
        const imagepath = rows[0]?.imageurl;

        if (imagepath) {
            const abs = path.join(DRUG_IMG_DIR, path.basename(imagepath));
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
            await executeMySql('UPDATE ms_drug SET imageurl = NULL WHERE orderitemcode = ?', [orderitemcode]);
        }

        res.json({ success: true, message: 'Image removed' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* ─── ms_time (instruction master) ──────────────────────────────── */

router.get('/api/settings/times', async (req, res) => {
    try {
        const search = req.query.search ? `%${req.query.search}%` : null;
        const sql = search
            ? 'SELECT * FROM ms_time WHERE timecode LIKE ? OR timeTH LIKE ? OR timeEN LIKE ? ORDER BY timecode'
            : 'SELECT * FROM ms_time ORDER BY timecode';
        const params = search ? [search, search, search] : [];
        const rows = await executeMySql(sql, params);

        // Fetch every detail row in a single query and group in memory instead of
        // one extra round-trip per timecode - avoids the endpoint stalling when
        // there are many timecodes configured.
        const allDetails = await executeMySql('SELECT * FROM ms_timedetail ORDER BY timecode, timedetailcode');
        const detailsByTimecode = new Map();
        for (const d of allDetails) {
            const list = detailsByTimecode.get(d.timecode) ?? [];
            list.push({
                id: d.timedetailcode,
                time_value: d.timedetailcode,
                label_th: d.timedetailTH,
                label_en: d.timedetailEN,
                dose_varymeal: d.varymeal_dosage,
                varymeal_dosage_unit: d.varymeal_dosage_unit
            });
            detailsByTimecode.set(d.timecode, list);
        }

        const typeMap = { 1: 'prn', 2: 'hourly', 3: 'meal', 4: 'schedule', 6: 'stat' };
        const data = rows.map((row) => ({
            id: row.timecode,
            timecode: row.timecode,
            name_th: row.timeTH,
            name_en: row.timeEN,
            dose_count: row.timecount,
            dose: row.timedose,
            is_active: row.status === '1' || row.status === 1,
            usage_type: typeMap[row.timetype] || 'schedule',
            details: detailsByTimecode.get(row.timecode) ?? []
        }));
        res.json({ success: true, data: data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/api/settings/times', async (req, res) => {
    try {
        const { timecode, name_th, name_en, dose_count, dose, usage_type, is_active, details = [] } = req.body;
        if (!timecode || !name_th) return res.status(400).json({ success: false, message: 'timecode and name_th are required' });

        const usageMap = { 'prn': 1, 'hourly': 2, 'meal': 3, 'schedule': 4, 'stat': 6 };
        const timetype = usageMap[usage_type] || 4;
        const status = is_active ? '1' : '0';
        // timedose is a DECIMAL column - an empty string (not just null/undefined) makes MySQL reject the insert.
        const timedose = dose === '' || dose == null ? null : dose;

        await executeMySql(
            'INSERT INTO ms_time (timecode, timeTH, timeEN, timecount, timedose, timetype, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [timecode, name_th, name_en ?? null, dose_count ?? 1, timedose, timetype, status]
        );

        for (const d of details) {
            await executeMySql(
                'INSERT INTO ms_timedetail (timecode, timedetailcode, timedetailTH, timedetailEN, varymeal_dosage, varymeal_dosage_unit) VALUES (?, ?, ?, ?, ?, ?)',
                [timecode, d.time_value, d.label_th ?? null, d.label_en ?? null, d.dose_varymeal ?? null, d.varymeal_dosage_unit ?? null]
            );
        }
        res.status(201).json({ success: true, message: 'Time created', id: timecode });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put('/api/settings/times/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const { timecode, name_th, name_en, dose_count, dose, usage_type, is_active, details = [] } = req.body;

        const usageMap = { 'prn': 1, 'hourly': 2, 'meal': 3, 'schedule': 4, 'stat': 6 };
        const timetype = usageMap[usage_type] || 4;
        const status = is_active ? '1' : '0';
        // timedose is a DECIMAL column - an empty string (not just null/undefined) makes MySQL reject the update.
        const timedose = dose === '' || dose == null ? null : dose;

        const result = await executeMySql(
            'UPDATE ms_time SET timecode=?, timeTH=?, timeEN=?, timecount=?, timedose=?, timetype=?, status=? WHERE timecode=?',
            [timecode, name_th, name_en ?? null, dose_count ?? 1, timedose, timetype, status, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Not found' });

        await executeMySql('DELETE FROM ms_timedetail WHERE timecode = ?', [id]);

        for (const d of details) {
            await executeMySql(
                'INSERT INTO ms_timedetail (timecode, timedetailcode, timedetailTH, timedetailEN, varymeal_dosage, varymeal_dosage_unit) VALUES (?, ?, ?, ?, ?, ?)',
                [timecode, d.time_value, d.label_th ?? null, d.label_en ?? null, d.dose_varymeal ?? null, d.varymeal_dosage_unit ?? null]
            );
        }
        res.json({ success: true, message: 'Time updated' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete('/api/settings/times/:id', async (req, res) => {
    try {
        const result = await executeMySql('DELETE FROM ms_time WHERE timecode = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Not found' });
        await executeMySql('DELETE FROM ms_timedetail WHERE timecode = ?', [req.params.id]);
        res.json({ success: true, message: 'Time deleted' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/api/settings/meals', async (req, res) => {
    try {
        const sql = 'SELECT mealcode, mealtimecode, mealdetailTH, mealdetailEN FROM ms_meals ORDER BY mealtimecode';
        const result = await executeMySql(sql);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* ─── ms_time (direct table query) ──────────────────────────────── */

const msTimeSelectQuery = `
    SELECT
        ms_time.timecode,
        ms_time.timeTH,
        ms_time.timeEN,
        ms_time.timecount,
        ms_time.timetype,
        ms_time.timedose,
        ms_time.\`status\`,
        ms_time.lastupdate,
        ms_time.timestatus
    FROM ms_time
`;

router.get('/api/ms-time', async (req, res) => {
    try {
        const filters = [];
        const params = [];

        if (req.query.timecode) {
            filters.push('ms_time.timecode = ?');
            params.push(req.query.timecode);
        }

        if (req.query.timestatus) {
            filters.push('ms_time.timestatus = ?');
            params.push(req.query.timestatus);
        }

        if (req.query.status) {
            filters.push('ms_time.`status` = ?');
            params.push(req.query.status);
        }

        const whereClause = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
        const result = await executeMySql(`${msTimeSelectQuery}${whereClause} ORDER BY ms_time.timecode`, params);

        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* ─── ms_timedetail (direct table query) ─────────────────────────── */

const msTimeDetailSelectQuery = `
    SELECT
        ms_timedetail.timecode,
        ms_timedetail.timedetailcode,
        ms_timedetail.timedetailTH,
        ms_timedetail.timedetailEN,
        ms_timedetail.lastupdate,
        ms_timedetail.timedetailTHold,
        ms_timedetail.varymeal_dosage
    FROM ms_timedetail
`;

router.get('/api/ms-timedetail', async (req, res) => {
    try {
        const filters = [];
        const params = [];

        if (req.query.timecode) {
            filters.push('ms_timedetail.timecode = ?');
            params.push(req.query.timecode);
        }

        if (req.query.timedetailcode) {
            filters.push('ms_timedetail.timedetailcode = ?');
            params.push(req.query.timedetailcode);
        }

        const whereClause = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
        const result = await executeMySql(`${msTimeDetailSelectQuery}${whereClause} ORDER BY ms_timedetail.timecode, ms_timedetail.timedetailcode`, params);

        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* ─── ms_print (printer & computer mapping) ──────────────────────── */

async function ensureMsPrintTable() {
    await executeMySql(`
        CREATE TABLE IF NOT EXISTS ms_print (
            id INT AUTO_INCREMENT PRIMARY KEY,
            computername VARCHAR(150) NULL,
            printstickername VARCHAR(150) NULL,
            printsummaryname VARCHAR(150) NULL,
            lastmodify DATETIME NULL,
            roomcode VARCHAR(50) NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

/* ─── Direct print queue ──────────────────────────────────────────
   Concurrent print requests used to each spawn their own headless
   browser + print-spooler call with no timeout, so simultaneous prints
   from multiple users would pile up and one stuck job could hang forever,
   requiring an API restart. Jobs now run one at a time, and every step
   (PDF conversion, pdf-to-printer, Out-Printer fallback) has a hard
   timeout so a stuck job gets abandoned instead of blocking the queue. */
const PRINT_CONVERT_TIMEOUT_MS = 15000;
const PRINT_SEND_TIMEOUT_MS = 20000;
const PRINT_FALLBACK_TIMEOUT_MS = 20000;

let printQueueTail = Promise.resolve();

function enqueuePrintJob(job) {
    const run = () => job().catch((err) => console.error('[DirectPrint] job failed:', err.message));
    printQueueTail = printQueueTail.then(run, run);
    return printQueueTail;
}

function execWithTimeout(cmd, timeoutMs) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: timeoutMs }, (err) => resolve(err || null));
    });
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

async function printViaOutPrinter(htmlPath, targetPrinter) {
    const cmd = `powershell -NoProfile -Command "Get-Content -LiteralPath '${htmlPath}' | Out-Printer -Name '${targetPrinter}'"`;
    const err = await execWithTimeout(cmd, PRINT_FALLBACK_TIMEOUT_MS);
    if (err) throw err;
}

async function runDirectPrintJob({ browserPath, pdfPrinter, htmlPath, pdfPath, targetPrinter }) {
    if (browserPath && pdfPrinter) {
        const convertCmd = `"${browserPath}" --headless --print-to-pdf="${pdfPath}" "${htmlPath}"`;
        await execWithTimeout(convertCmd, PRINT_CONVERT_TIMEOUT_MS);

        if (fs.existsSync(pdfPath)) {
            try {
                await withTimeout(pdfPrinter.print(pdfPath, { printer: targetPrinter }), PRINT_SEND_TIMEOUT_MS, 'pdf-to-printer');
                console.log(`[DirectPrint] Printed ${pdfPath} to ${targetPrinter}`);
                return;
            } catch (printErr) {
                console.error('[DirectPrint] pdf-to-printer error:', printErr.message);
            }
        }
    }

    await withTimeout(printViaOutPrinter(htmlPath, targetPrinter), PRINT_FALLBACK_TIMEOUT_MS, 'Out-Printer fallback');
}

router.get('/api/settings/print/devices', async (req, res) => {
    try {
        const clientInfo = await resolveClientInfo(req);
        const hostname = clientInfo.computername;
        await ensureMsPrintTable();

        const existingComs = await executeMySql('SELECT DISTINCT computername FROM ms_print WHERE computername IS NOT NULL AND computername != ""');
        const comList = Array.from(new Set([hostname, ...existingComs.map(r => r.computername)]));

        exec('powershell -NoProfile -Command "Get-WmiObject -Class Win32_Printer | Select-Object -ExpandProperty Name"', { timeout: 5000 }, async (err, stdout) => {
            let sysPrinters = [];
            if (!err && stdout) {
                sysPrinters = stdout
                    .split(/\r?\n/)
                    .map(s => s.trim())
                    .filter(s => s.length > 0 && s !== 'Name');
            }

            const existingPrinters = await executeMySql('SELECT DISTINCT printstickername, printsummaryname FROM ms_print');
            const dbPrinters = [];
            existingPrinters.forEach(r => {
                if (r.printstickername) dbPrinters.push(r.printstickername);
                if (r.printsummaryname) dbPrinters.push(r.printsummaryname);
            });

            const allPrinters = Array.from(new Set([...sysPrinters, ...dbPrinters].filter(Boolean)));

            res.json({
                success: true,
                data: {
                    computername: hostname,
                    ip: clientInfo.ip,
                    computers: comList,
                    printers: allPrinters
                }
            });
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/api/settings/print/auto', async (req, res) => {
    try {
        await ensureMsPrintTable();
        const clientInfo = await resolveClientInfo(req);
        const computername = String(req.body.computername || clientInfo.computername || os.hostname() || '').trim();
        const type = req.body.type || 'sticker'; // 'sticker' or 'summary'
        const html = req.body.html || '';

        let rows = await executeMySql('SELECT * FROM ms_print WHERE LOWER(TRIM(computername)) = LOWER(TRIM(?)) LIMIT 1', [computername]);
        if (rows.length === 0 && clientInfo.ip && clientInfo.ip !== computername) {
            rows = await executeMySql('SELECT * FROM ms_print WHERE LOWER(TRIM(computername)) = LOWER(TRIM(?)) LIMIT 1', [clientInfo.ip]);
        }
        if (rows.length === 0) {
            rows = await executeMySql('SELECT * FROM ms_print WHERE LOWER(TRIM(computername)) = LOWER(TRIM(?)) LIMIT 1', [String(os.hostname()).trim()]);
        }
        if (rows.length === 0) {
            rows = await executeMySql('SELECT * FROM ms_print LIMIT 1');
        }
        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: `ไม่พบการตั้งค่าเครื่องพิมพ์ในตาราง ms_print กรุณาตั้งค่าเครื่องพิมพ์สำหรับคอมพิวเตอร์ "${computername}" ก่อน`
            });
        }

        const row = rows[0];
        const targetPrinter = type === 'summary' ? (row.printsummaryname || row.printstickername) : (row.printstickername || row.printsummaryname);
        if (!targetPrinter) {
            return res.status(404).json({
                success: false,
                message: `ไม่ได้ตั้งค่าชื่อเครื่องพิมพ์ (${type}) สำหรับคอมพิวเตอร์ "${row.computername || computername}"`
            });
        }

        const isLocalClient = clientInfo.ip !== '127.0.0.1' && clientInfo.ip !== 'localhost' && clientInfo.ip !== '::1' && clientInfo.computername !== os.hostname();

        if (!isLocalClient) {
            const tempDir = path.join(__dirname, '../../logs/print');
            fs.mkdirSync(tempDir, { recursive: true });
            const timestamp = Date.now();
            const htmlPath = path.join(tempDir, `print_${timestamp}.html`);
            const pdfPath = path.join(tempDir, `print_${timestamp}.pdf`);
            fs.writeFileSync(htmlPath, html, 'utf8');

            const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
            const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
            const browserPath = fs.existsSync(edgePath) ? edgePath : (fs.existsSync(chromePath) ? chromePath : null);

            let pdfPrinter;
            try {
                pdfPrinter = require('pdf-to-printer');
            } catch (_) { }

            enqueuePrintJob(() => runDirectPrintJob({ browserPath, pdfPrinter, htmlPath, pdfPath, targetPrinter }));
        }

        res.json({
            success: true,
            computername: row.computername || computername,
            printerName: targetPrinter,
            clientIp: clientInfo.ip,
            printOnClient: isLocalClient,
            message: isLocalClient
                ? `สั่งพิมพ์ผ่าน Local Driver ไปที่เครื่องพิมพ์ "${targetPrinter}" ของเครื่อง "${row.computername || computername}" เรียบร้อยแล้ว`
                : `สั่งพิมพ์อัตโนมัติออกเครื่อง "${targetPrinter}" เรียบร้อยแล้ว`
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/api/settings/print', async (req, res) => {
    try {
        await ensureMsPrintTable();
        const search = req.query.search ? `%${req.query.search}%` : null;
        let sql = 'SELECT * FROM ms_print';
        const params = [];

        if (search) {
            sql += ' WHERE computername LIKE ? OR printstickername LIKE ? OR printsummaryname LIKE ? OR roomcode LIKE ?';
            params.push(search, search, search, search);
        }

        sql += ' ORDER BY id DESC LIMIT 500';
        const result = await executeMySql(sql, params);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/api/settings/print', async (req, res) => {
    try {
        await ensureMsPrintTable();
        const { computername, printstickername, printsummaryname, roomcode } = req.body;
        await executeMySql(
            `INSERT INTO ms_print (computername, printstickername, printsummaryname, lastmodify, roomcode)
             VALUES (?, ?, ?, NOW(), ?)`,
            [computername || null, printstickername || null, printsummaryname || null, roomcode || null]
        );
        res.status(201).json({ success: true, message: 'Printer mapping created' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put('/api/settings/print/:id', async (req, res) => {
    try {
        await ensureMsPrintTable();
        const { id } = req.params;
        const { computername, printstickername, printsummaryname, roomcode } = req.body;
        await executeMySql(
            `UPDATE ms_print
             SET computername = ?, printstickername = ?, printsummaryname = ?, lastmodify = NOW(), roomcode = ?
             WHERE id = ?`,
            [computername || null, printstickername || null, printsummaryname || null, roomcode || null, id]
        );
        res.json({ success: true, message: 'Printer mapping updated' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete('/api/settings/print/:id', async (req, res) => {
    try {
        await ensureMsPrintTable();
        const { id } = req.params;
        await executeMySql('DELETE FROM ms_print WHERE id = ?', [id]);
        res.json({ success: true, message: 'Printer mapping deleted' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
