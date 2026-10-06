const express = require('express');
const multer = require('multer');
const { executeMySql, getMySqlPool } = require('../db/mysqlPool');
const { sendOrderSelectQuery } = require('../db/queries/sendOrder');

const router = express.Router();
const JSON_UPLOAD_MAX_BYTES = Number(process.env.JSON_UPLOAD_MAX_BYTES || (20 * 1024 * 1024));
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: JSON_UPLOAD_MAX_BYTES
    },
    fileFilter: (req, file, callback) => {
        const isJsonFile = file.mimetype === 'application/json' || file.originalname.toLowerCase().endsWith('.json');

        if (!isJsonFile) {
            callback(new Error('Only .json files are allowed'));
            return;
        }

        callback(null, true);
    }
});

const prescriptionSelectQuery = `
      SELECT
        prescription.prescriptionno,
        prescription.seq,
        prescription.seqmax,
        COALESCE(packagemaster.orderitembarcode, prescription.orderitembarcode) AS orderitembarcode,
        prescription.patientname,
        prescription.sex,
        prescription.patientdob,
        prescription.hn,
        prescription.an,
        prescription.wardcode,
        prescription.wardname,
        prescription.bedcode,
        prescription.prioritycode,
        prescription.prioritydesc,
        prescription.takedate,
        prescription.enddate,
        prescription.ordercreatedate,
        prescription.orderitemcode,
        prescription.orderitemname,
        prescription.orderqty,
        prescription.orderunitcode,
        prescription.orderunitdesc,
        prescription.instructioncode,
        prescription.instructiondesc,
        prescription.dosage,
        prescription.dosageunitcode,
        prescription.dosageunitdesc,
        prescription.frequencycode,
        prescription.frequencydesc,
        prescription.timecode,
        prescription.timedesc,
        prescription.timecount,
        prescription.fromlocationname,
        prescription.usercreatecode,
        prescription.usercreatename,
        prescription.orderacceptfromip,
        prescription.computername,
        prescription.itemlotcode,
        prescription.itemlotexpire,
        prescription.doctorcode,
        prescription.doctorname,
        prescription.pharmacyitemcode,
        prescription.pharmacyitemdesc,
        prescription.freetext1,
        prescription.freetext2,
        prescription.itemidentify,
        prescription.tomachineno,
        prescription.lastmodified,
        prescription.language,
        prescription.statuscode,
        prescription.ordertype,
        prescription.varymeal,
        prescription.varymealtime,
        prescription.dispensestatus,
        prescription.voiddatetime,
        prescription.genorderdatetime,
        prescription.forcash,
        prescription.itemindex,
        prescription.tmtcode,
        prescription.confirmdatetime,
        prescription.confirmuserid,
        prescription.sendmix,
        prescription.printstatus,
        prescription.rowpatient,
        prescription.meditemindex,
        prescription.groupdrug,
        prescription.diluentadd,
        prescription.IVStatus,
        prescription.holddatetime,
        prescription.startdate,
        prescription.itemcreatedate,
        prescription.freetext3,
        prescription.printauto,
        prescription.DIDcode,
        prescription.continuestatus,
        prescription.printdrp,
        COALESCE(ms_drug.sendmachine, prescription.sendmachine) AS sendmachine,
        ms_drug.highalert,
        CASE
            WHEN UPPER(COALESCE(ms_drug.highalert, '')) = 'Y' THEN 'Y'
            ELSE 'N'
        END AS had,
        ms_drug.locationcode,
        ms_drug.shelfzone,
        ms_drug.shelfname,
        ms_bin_loc.bin_location,
        ms_bin_loc.bin_boxid,
        packagemaster.frequencytime,
        ms_time.timecode AS ms_time_code,
        ms_time.timetype,
        ms_timedetail.timedetailcode,
        ms_timedetail.timedetailTH,
        ms_timedetail.timedetailEN,
        ms_timedetail.varymeal_dosage
      FROM prescription
      LEFT JOIN packagemaster ON prescription.prescriptionno = packagemaster.prescriptionno AND prescription.seq = packagemaster.seq
      LEFT JOIN ms_drug ON prescription.orderitemcode = ms_drug.orderitemcode
      LEFT JOIN (
        SELECT orderitemcode, MIN(location) AS bin_location, MIN(boxid) AS bin_boxid
        FROM ms_bin
        WHERE orderitemcode IS NOT NULL
        GROUP BY orderitemcode
      ) ms_bin_loc ON prescription.orderitemcode = ms_bin_loc.orderitemcode
      LEFT JOIN ms_time ON LOWER(prescription.timecode) = LOWER(ms_time.timecode)
      LEFT JOIN ms_timedetail ON LOWER(ms_time.timecode) = LOWER(ms_timedetail.timecode)
`;

const prescriptionWardSummaryQuery = `
    SELECT
        p.wardcode,
        p.wardname,
        DATE(p.ordercreatedate) AS orderdate,
        COUNT(DISTINCT p.prescriptionno) AS total_orders
    FROM prescription p
`;

function uploadJsonFile(req, res, next) {
    upload.single('file')(req, res, (error) => {
        if (error) {
            const isFileTooLarge = error.code === 'LIMIT_FILE_SIZE';
            res.status(isFileTooLarge ? 413 : 400).json({
                success: false,
                message: error.message
            });
            return;
        }

        next();
    });
}

function getJsonPayload(req) {
    if (!req.file) {
        return req.body ?? {};
    }

    if (!req.file.buffer || req.file.buffer.length === 0) {
        return {};
    }

    const parsedPayload = JSON.parse(req.file.buffer.toString('utf8'));

    if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
        throw new Error('JSON file must contain an object');
    }

    return parsedPayload;
}

function toLocalDateStamp(date = new Date()) {
    const localNow = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
    return localNow.toISOString().slice(0, 10).replace(/-/g, '');
}

function parseItemIndex(itemindex) {
    const raw = String(itemindex ?? '').trim();
    const match = raw.match(/^(\d{8})(\d{6})$/);
    if (!match) {
        return { datePart: null, runNo: 0 };
    }

    return {
        datePart: match[1],
        runNo: Number.parseInt(match[2], 10) || 0
    };
}

function getEmbeddedWardCode(prescriptionno) {
    const parts = String(prescriptionno ?? '').trim().split('-');
    if (parts.length !== 3 || parts.some((part) => part === '')) return null;
    return parts[0];
}

function normalizeImportedItems(items) {
    return items.map((item) => {
        const embeddedWardCode = getEmbeddedWardCode(item.prescriptionno ?? item.prescriptionNo ?? item.PRESCRIPTIONNO);
        if (!embeddedWardCode) return item;

        const alreadyNormalized = String(item.wardcode ?? '').trim() === embeddedWardCode
            && (item.wardname === null || item.wardname === undefined || String(item.wardname).trim() === '');
        if (alreadyNormalized) return item;

        const originalWardText = [item.wardcode, item.wardname]
            .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
            .map((value) => String(value).trim())
            .join('|');
        const existingFreeText = String(item.freetext1 ?? '').trim();

        return {
            ...item,
            wardcode: embeddedWardCode,
            wardname: null,
            freetext1: [existingFreeText, originalWardText].filter(Boolean).join('|')
        };
    });
}

async function getWardNames(connection, items) {
    const wardCodes = [...new Set(items
        .filter((item) => getEmbeddedWardCode(item.prescriptionno ?? item.prescriptionNo ?? item.PRESCRIPTIONNO))
        .map((item) => getEmbeddedWardCode(item.prescriptionno ?? item.prescriptionNo ?? item.PRESCRIPTIONNO))
        .filter((wardcode) => typeof wardcode === 'string' && wardcode.trim() !== ''))];
    if (wardCodes.length === 0) return new Map();

    const placeholders = wardCodes.map(() => '?').join(', ');
    const [rows] = await connection.execute(
        `SELECT wardcode, warddescfull FROM ms_ward WHERE wardcode IN (${placeholders})`,
        wardCodes
    );
    return new Map(rows.map((row) => [String(row.wardcode), row.warddescfull]));
}

router.post('/api/prescriptions', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const filters = [];
        const params = [];

        if (payload.prescriptionno) {
            filters.push('prescription.prescriptionno = ?');
            params.push(payload.prescriptionno);
        }

        if (payload.hn) {
            filters.push('prescription.hn = ?');
            params.push(payload.hn);
        }

        if (payload.an) {
            filters.push('prescription.an = ?');
            params.push(payload.an);
        }

        if (payload.orderitembarcode) {
            filters.push('prescription.orderitembarcode = ?');
            params.push(payload.orderitembarcode);
        }

        if (payload.ordercreatedate && String(payload.ordercreatedate).trim() !== '') {
            filters.push('DATE(prescription.ordercreatedate) = ?');
            params.push(String(payload.ordercreatedate).trim());
        }

        if (payload.genorderdatetimeIsNull === true) {
            filters.push('prescription.genorderdatetime IS NULL');
        } else if (payload.genorderdatetimeIsNull === false) {
            filters.push('prescription.genorderdatetime IS NOT NULL');
        }

        if (payload.confirmdatetimeIsNotNull === true) {
            filters.push('prescription.confirmdatetime IS NOT NULL');
        }

        if (payload.ordertype !== undefined && payload.ordertype !== null && payload.ordertype !== '') {
            filters.push('prescription.ordertype = ?');
            params.push(payload.ordertype);
        }

        const whereClause = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
        const result = await executeMySql(`${prescriptionSelectQuery}${whereClause} ORDER BY prescription.orderitemname`, params);

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/api/prescriptions/ward-summary', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const filters = [];
        const params = [];

        if (payload.ordercreatedate && String(payload.ordercreatedate).trim() !== '') {
            filters.push('DATE(p.ordercreatedate) = ?');
            params.push(String(payload.ordercreatedate).trim());
        }

        if (payload.wardcode) {
            filters.push('p.wardcode = ?');
            params.push(payload.wardcode);
        }

        if (payload.wardname) {
            filters.push('p.wardname = ?');
            params.push(payload.wardname);
        }

        if (payload.genorderdatetimeIsNull === false) {
            filters.push('p.genorderdatetime IS NOT NULL');
        } else {
            filters.push('p.genorderdatetime IS NULL');
        }

        if (payload.ordertype !== undefined && payload.ordertype !== null && payload.ordertype !== '') {
            filters.push('p.ordertype = ?');
            params.push(payload.ordertype);
        }

        const whereClause = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
        const result = await executeMySql(`
${prescriptionWardSummaryQuery}
${whereClause}
    GROUP BY
        p.wardcode,
        p.wardname,
        DATE(p.ordercreatedate)
    ORDER BY
         p.wardcode
`, params);

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/api/prescriptions/ward-patients', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const filters = [];
        const params = [];

        if (!payload.wardCode) {
            return res.status(400).json({ success: false, message: 'wardCode is required' });
        }

        filters.push('p.wardcode = ?');
        params.push(payload.wardCode);

        if (payload.ordercreatedate && String(payload.ordercreatedate).trim() !== '') {
            filters.push('DATE(p.ordercreatedate) = ?');
            params.push(String(payload.ordercreatedate).trim());
        }

        if (payload.genorderdatetimeIsNull === false) {
            filters.push('p.genorderdatetime IS NOT NULL');
        } else {
            filters.push('p.genorderdatetime IS NULL');
        }

        if (payload.ordertype !== undefined && payload.ordertype !== null && payload.ordertype !== '') {
            filters.push('p.ordertype = ?');
            params.push(payload.ordertype);
        }

        if (payload.search) {
            filters.push('(p.patientname LIKE ? OR p.hn LIKE ? OR p.an LIKE ?)');
            const term = `%${payload.search}%`;
            params.push(term, term, term);
        }

        const whereClause = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';

        const result = await executeMySql(`
            SELECT
                p.hn,
                p.an,
                p.patientname,
                p.bedcode,
                p.wardcode,
                p.wardname,
                COUNT(DISTINCT p.prescriptionno) AS prescription_count,
                COUNT(*) AS item_count
            FROM prescription p
            ${whereClause}
            GROUP BY p.hn, p.an, p.patientname, p.bedcode, p.wardcode, p.wardname
            ORDER BY p.bedcode, p.patientname
        `, params);

        return res.json({ success: true, data: result });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/prescriptions/send-order', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const filters = [];
        const params = [];

        if (payload.prescriptionno) {
            filters.push('prescription.prescriptionno = ?');
            params.push(payload.prescriptionno);
        }

        if (payload.hn) {
            filters.push('prescription.hn = ?');
            params.push(payload.hn);
        }

        if (payload.an) {
            filters.push('prescription.an = ?');
            params.push(payload.an);
        }

        if (payload.ordercreatedate && String(payload.ordercreatedate).trim() !== '') {
            filters.push('DATE(prescription.ordercreatedate) = ?');
            params.push(String(payload.ordercreatedate).trim());
        }

        if (payload.genorderdatetimeIsNull === true) {
            filters.push('prescription.genorderdatetime IS NULL');
        } else if (payload.genorderdatetimeIsNull === false) {
            filters.push('prescription.genorderdatetime IS NOT NULL');
        }

        if (payload.sendmachine) {
            filters.push('ms_drug.sendmachine = ?');
            params.push(payload.sendmachine);
        }

        const whereClause = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
        const result = await executeMySql(`${sendOrderSelectQuery}${whereClause}`, params);

        return res.json({ success: true, data: result });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ป้องกัน race condition ตอนเช็คซ้ำ (SELECT existingKeys แล้วค่อย INSERT ไม่มี lock ระดับ DB
// รองรับ) — ถ้ามี 2 request เข้ามาพร้อมกัน (เช่น auto-sync กับ import มือจาก UI ชนกัน)
// ให้ประมวลผลทีละ request เท่านั้น ไม่ overlap กัน
let importChain = Promise.resolve();

router.post('/api/prescriptions/import-medauto', uploadJsonFile, (req, res) => {
    importChain = importChain.catch(() => { }).then(() => handleImportMedauto(req, res));
});

async function handleImportMedauto(req, res) {
    const pool = getMySqlPool();
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const payload = getJsonPayload(req);
        const rawItems = Array.isArray(payload.items) ? payload.items : (Array.isArray(payload) ? payload : []);
        const items = normalizeImportedItems(rawItems);
        if (items.length === 0) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ไม่พบรายการยาที่ต้องการบันทึก' });
        }

        const wardNames = await getWardNames(connection, items);

        const datetimeCols = new Set([
            'patientdob', 'takedate', 'enddate', 'ordercreatedate', 'itemlotexpire',
            'lastmodified', 'voiddatetime', 'genorderdatetime', 'confirmdatetime'
        ]);

        const allowedCols = [
            'prescriptionno', 'seq', 'seqmax', 'orderitembarcode', 'patientname', 'sex', 'patientdob',
            'hn', 'an', 'wardcode', 'wardname', 'bedcode', 'prioritycode', 'prioritydesc',
            'takedate', 'enddate', 'ordercreatedate', 'orderitemcode', 'orderitemname',
            'orderqty', 'orderunitcode', 'orderunitdesc', 'instructioncode', 'instructiondesc',
            'dosage', 'dosageunitcode', 'dosageunitdesc', 'frequencycode', 'frequencydesc',
            'timecode', 'timedesc', 'timecount', 'fromlocationname', 'usercreatecode',
            'usercreatename', 'orderacceptfromip', 'computername', 'itemlotcode', 'itemlotexpire',
            'doctorcode', 'doctorname', 'pharmacyitemcode', 'pharmacyitemdesc', 'freetext1',
            'freetext2', 'freetext3', 'itemidentify', 'tomachineno', 'lastmodified', 'language', 'statuscode',
            'ordertype', 'varymeal', 'varymealtime', 'dispensestatus', 'voiddatetime',
            'genorderdatetime', 'forcash', 'itemindex', 'tmtcode', 'confirmdatetime', 'sendmachine'
        ];

        const prescriptionItemCounts = new Map();
        for (const rawItem of items) {
            if (!rawItem || typeof rawItem !== 'object') continue;
            const prescriptionNo = String(rawItem.prescriptionno ?? rawItem.prescriptionNo ?? rawItem.PRESCRIPTIONNO ?? '').trim();
            if (!prescriptionNo) continue;
            prescriptionItemCounts.set(prescriptionNo, (prescriptionItemCounts.get(prescriptionNo) || 0) + 1);
        }

        // กันบันทึกซ้ำด้วยคีย์: prescriptionno + seq + dosage + timecode + orderitemcode
        const normalizeKeyPart = (value, toLower = false) => {
            const normalized = String(value ?? '').trim();
            return toLower ? normalized.toLowerCase() : normalized;
        };
        const dedupKey = (prescriptionNo, seq, dosage, timecode, orderitemcode) =>
            [
                normalizeKeyPart(prescriptionNo),
                normalizeKeyPart(seq),
                normalizeKeyPart(dosage),
                normalizeKeyPart(timecode, true),
                normalizeKeyPart(orderitemcode, true)
            ].join('|');

        const existingKeys = new Set();
        const prescriptionNosForDedup = [...prescriptionItemCounts.keys()];
        if (prescriptionNosForDedup.length > 0) {
            const placeholders = prescriptionNosForDedup.map(() => '?').join(', ');
            const [existingRows] = await connection.execute(
                `SELECT prescriptionno, seq, dosage, timecode, orderitemcode FROM prescription WHERE prescriptionno IN (${placeholders})`,
                prescriptionNosForDedup
            );
            for (const row of existingRows) {
                existingKeys.add(dedupKey(row.prescriptionno, row.seq, row.dosage, row.timecode, row.orderitemcode));
            }
        }

        const [generatorRows] = await connection.execute(
            'SELECT itemindex FROM ms_generateprescription WHERE id = ? FOR UPDATE',
            ['1']
        );
        const lastItemIndex = generatorRows[0]?.itemindex || null;
        const parsedLastItemIndex = parseItemIndex(lastItemIndex);
        let itemIndexDatePart = toLocalDateStamp();
        let itemIndexRunNo = parsedLastItemIndex.datePart === itemIndexDatePart ? parsedLastItemIndex.runNo : 0;

        let insertedCount = 0;
        let latestGeneratedItemIndex = null;
        const failedItems = [];
        const skippedItems = [];
        for (const rawItem of items) {
            if (!rawItem || typeof rawItem !== 'object') continue;
            const norm = {};
            for (const [k, v] of Object.entries(rawItem)) {
                norm[k.toLowerCase()] = v;
            }

            // instructioncode & instructiondesc เอาไปใส่ timecode & timedesc ตาม requirement
            if (norm.instructioncode) norm.timecode = norm.instructioncode;
            if (norm.instructiondesc) norm.timedesc = norm.instructiondesc;

            // ตั้ง instructioncode/instructiondesc เป็น null ตาม Requirement
            norm.instructioncode = null;
            norm.instructiondesc = null;

            // map lastmodify to lastmodified
            if (norm.lastmodify && !norm.lastmodified) norm.lastmodified = norm.lastmodify;

            // map status_drug ไปเก็บใน freetext3
            if (norm.status_drug !== undefined) {
                norm.freetext3 = norm.status_drug;
            } else if (norm.statusdrug !== undefined) {
                norm.freetext3 = norm.statusdrug;
            }

            const embeddedWardCode = getEmbeddedWardCode(norm.prescriptionno);
            if (embeddedWardCode) {
                norm.wardcode = embeddedWardCode;
                norm.wardname = wardNames.get(embeddedWardCode) ?? null;
            }

            const prescriptionNo = String(norm.prescriptionno || '').trim();
            norm.seqmax = prescriptionNo ? (prescriptionItemCounts.get(prescriptionNo) || 0) : 0;

            const parsedTimeCount = Number.parseInt(String(norm.timecount ?? ''), 10);
            norm.timecount = Number.isFinite(parsedTimeCount) && parsedTimeCount > 0 ? parsedTimeCount : 1;

            const parsedMachineNo = Number.parseInt(String(norm.tomachineno ?? ''), 10);
            norm.tomachineno = Number.isFinite(parsedMachineNo) ? parsedMachineNo : 0;

            norm.language = 0;
            norm.ordertype = norm.ordertype === undefined || norm.ordertype === null || norm.ordertype === ''
                ? 1
                : norm.ordertype;
            norm.dispensestatus = 0;
            norm.forcash = 0;

            // กำหนดค่าตาม Requirement ตอนบันทึก:
            // takedate เป็นวันล่าสุด, enddate ค่า null, ordercreatedate ใส่วันปัจจุบัน, genorderdatetime เป็น null, confirmdatetime เป็น null
            const now = new Date();
            const localNow = new Date(now.getTime() - (now.getTimezoneOffset() * 60000));
            const nowStr = localNow.toISOString().slice(0, 19).replace('T', ' ');

            norm.takedate = nowStr;
            norm.enddate = null;
            norm.ordercreatedate = nowStr;
            norm.genorderdatetime = null;
            norm.confirmdatetime = null;

            for (const col of datetimeCols) {
                if (norm[col] === '') {
                    norm[col] = null;
                }
            }

            // lastmodified เป็น NOT NULL ในตาราง prescription — ถ้าต้นทางไม่ส่งมา/ว่าง ใช้เวลาที่บันทึกแทน
            if (!norm.lastmodified) {
                norm.lastmodified = nowStr;
            }

            const itemKey = dedupKey(prescriptionNo, norm.seq, norm.dosage, norm.timecode, norm.orderitemcode);
            if (existingKeys.has(itemKey)) {
                skippedItems.push({ prescriptionno: prescriptionNo, orderitemcode: norm.orderitemcode, orderitemname: norm.orderitemname, reason: 'duplicate' });
                continue;
            }

            // itemindex: yyyyMMdd + running number 6 หลัก (ต่อเนื่องจาก ms_generateprescription)
            const nextRunNo = itemIndexRunNo + 1;
            const generatedItemIndex = `${itemIndexDatePart}${String(nextRunNo).padStart(6, '0')}`;
            norm.itemindex = generatedItemIndex;

            const cols = [];
            const placeholders = [];
            const values = [];

            for (const col of allowedCols) {
                if (norm[col] !== undefined) {
                    cols.push(col);
                    placeholders.push('?');
                    values.push(norm[col]);
                }
            }

            if (cols.length > 0) {
                const query = `INSERT INTO prescription (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
                try {
                    await connection.execute(query, values);
                    insertedCount++;
                    itemIndexRunNo = nextRunNo;
                    latestGeneratedItemIndex = generatedItemIndex;
                    existingKeys.add(itemKey);
                } catch (itemErr) {
                    if (itemErr.code === 'ER_DUP_ENTRY') {
                        existingKeys.add(itemKey);
                        skippedItems.push({ prescriptionno: prescriptionNo, orderitemcode: norm.orderitemcode, orderitemname: norm.orderitemname, reason: 'duplicate' });
                    } else {
                        console.error(`Error inserting prescription item (prescriptionno=${prescriptionNo}):`, itemErr.message);
                        failedItems.push({ prescriptionno: prescriptionNo, orderitemcode: norm.orderitemcode, orderitemname: norm.orderitemname, error: itemErr.message });
                    }
                }
            }
        }

        if (latestGeneratedItemIndex) {
            await connection.execute(
                `INSERT INTO ms_generateprescription (id, itemindex, itemindexdate, lastmodify)
                 VALUES (?, ?, NOW(), NOW())
                 ON DUPLICATE KEY UPDATE itemindex = VALUES(itemindex), itemindexdate = NOW(), lastmodify = NOW()`,
                ['1', latestGeneratedItemIndex]
            );
        }

        const patients = Array.isArray(payload.patients) ? payload.patients : [];
        const patientAdmits = Array.isArray(payload.patientAdmits) ? payload.patientAdmits : [];

        const pickFirstNonEmpty = (...values) => {
            for (const value of values) {
                const normalized = String(value ?? '').trim();
                if (normalized) return normalized;
            }
            return null;
        };

        // สำรองข้อมูลเตียง/วอร์ดจาก items ตามคู่ hn+an เพื่อใช้กับ ms_patientadmit
        const itemAdmitInfoByHnAn = new Map();
        for (const rawItem of items) {
            if (!rawItem || typeof rawItem !== 'object') continue;

            const itemHn = pickFirstNonEmpty(rawItem.hn, rawItem.HN);
            const itemAn = pickFirstNonEmpty(rawItem.an, rawItem.AN);
            if (!itemHn || !itemAn) continue;

            const itemBed = pickFirstNonEmpty(rawItem.activebed, rawItem.bedcode, rawItem.bed, rawItem.bedno);
            const itemWard = pickFirstNonEmpty(rawItem.activewardcode, rawItem.wardcode);

            if (!itemBed && !itemWard) continue;
            itemAdmitInfoByHnAn.set(`${itemHn}|${itemAn}`, {
                activebed: itemBed,
                activewardcode: itemWard
            });
        }

        let insertedPatients = 0;
        let insertedPatientAdmits = 0;

        for (const patient of patients) {
            const hn = String(patient.hn ?? '').trim();
            if (!hn) continue;

            const [existingPatient] = await connection.execute(
                'SELECT 1 FROM ms_patient WHERE hn = ? LIMIT 1',
                [hn]
            );
            if (existingPatient.length > 0) continue;

            await connection.execute(
                `INSERT INTO ms_patient
                (hn, title, patientnameTH, idcard, sex, patientdob, patientage, blood,
                 congenital_disease, allergy, diagnosis, RightId, imgpath, lastmodified,
                 s_hn, _rightname, patientimage)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    hn, patient.title ?? null, patient.patientnameTH ?? null, patient.idcard ?? null,
                    patient.sex ?? null, patient.patientdob ?? null, patient.patientage ?? null,
                    patient.blood ?? null, patient.congenital_disease ?? null, patient.allergy ?? null,
                    patient.diagnosis ?? null, patient.RightId ?? null, patient.imgpath ?? null,
                    patient.lastmodified ?? toMySqlDateTime(new Date()), patient.s_hn ?? null,
                    patient._rightname ?? null, patient.patientimage ?? null
                ]
            );
            insertedPatients++;
        }

        for (const admit of patientAdmits) {
            const hn = String(admit.hn ?? '').trim();
            const an = String(admit.an ?? '').trim();
            if (!hn || !an) continue;

            const itemAdmitInfo = itemAdmitInfoByHnAn.get(`${hn}|${an}`) || {};
            const activeWardCode = pickFirstNonEmpty(
                admit.activewardcode,
                admit.wardcode,
                itemAdmitInfo.activewardcode
            );
            const activeBed = pickFirstNonEmpty(
                admit.activebed,
                admit.bedcode,
                admit.bed,
                admit.bedno,
                itemAdmitInfo.activebed
            );

            const [existingAdmit] = await connection.execute(
                'SELECT 1 FROM ms_patientadmit WHERE hn = ? AND an = ? LIMIT 1',
                [hn, an]
            );
            if (existingAdmit.length > 0) continue;

            await connection.execute(
                `INSERT INTO ms_patientadmit
                (transid, hn, an, activewardcode, activebed, wardcode_out, bedcode_out,
                 activitylog, acceptby, acceptdate, transferstatus, admitteddate,
                 dischargeddate, lastmodified)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    admit.transid ?? null, hn, an, activeWardCode,
                    activeBed, admit.wardcode_out ?? null, admit.bedcode_out ?? null,
                    admit.activitylog ?? null, admit.acceptby ?? null, admit.acceptdate ?? null,
                    admit.transferstatus ?? null, admit.admitteddate ?? toMySqlDateTime(new Date()),
                    admit.dischargeddate ?? null, admit.lastmodified ?? toMySqlDateTime(new Date())
                ]
            );
            insertedPatientAdmits++;
        }

        await connection.commit();

        const MAX_LISTED = 8;
        const describeItem = (i) => `${i.orderitemname || i.orderitemcode || '?'} (${i.prescriptionno})`;
        const listWithCap = (arr) => {
            const shown = arr.slice(0, MAX_LISTED).map(describeItem).join(', ');
            const extra = arr.length > MAX_LISTED ? ` และอีก ${arr.length - MAX_LISTED} รายการ` : '';
            return shown + extra;
        };

        let message = `บันทึกข้อมูลใบสั่งยาเข้าตาราง prescription สำเร็จ (${insertedCount} รายการ), ms_patient (${insertedPatients} รายการ), ms_patientadmit (${insertedPatientAdmits} รายการ)`;
        if (skippedItems.length) message += ` | ข้ามรายการซ้ำ ${skippedItems.length} รายการ: ${listWithCap(skippedItems)}`;
        if (failedItems.length) message += ` | บันทึกไม่สำเร็จ ${failedItems.length} รายการ: ${listWithCap(failedItems)}`;

        return res.json({
            success: true,
            message,
            count: insertedCount,
            skipped: skippedItems,
            failed: failedItems
        });
    } catch (err) {
        await connection.rollback();
        console.error('Error importing prescriptions to database:', err);
        return res.status(500).json({ success: false, message: err.message || 'บันทึกข้อมูลลง Database ไม่สำเร็จ' });
    } finally {
        connection.release();
    }
}

// จุดเก็บ cursor ("recivedatetime") ของรอบ sync ล่าสุด เก็บในตาราง ms_generateprescription
// แถวเดียว (id='1') ใช้เป็น date_from ของรอบดึงข้อมูลถัดไป
router.get('/api/prescriptions/sync-cursor', async (req, res) => {
    try {
        const rows = await executeMySql('SELECT recivedatetime FROM ms_generateprescription WHERE id = ?', ['1']);
        res.json({ success: true, recivedatetime: rows[0]?.recivedatetime || null });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/prescriptions/sync-cursor', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const recivedatetime = payload.recivedatetime;
        if (!recivedatetime) {
            return res.status(400).json({ success: false, message: 'recivedatetime is required' });
        }
        await executeMySql('UPDATE ms_generateprescription SET recivedatetime = ? WHERE id = ?', [recivedatetime, '1']);
        res.json({ success: true, recivedatetime });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


router.post('/api/prescriptions/void', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const { prescriptionno, orderitemcode, isCancel } = payload;

        if (!prescriptionno) {
            return res.status(400).json({ success: false, message: 'prescriptionno is required' });
        }

        const voidValue = isCancel ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;

        let sql = 'UPDATE prescription SET voiddatetime = ? WHERE prescriptionno = ?';
        const params = [voidValue, prescriptionno];

        if (orderitemcode) {
            sql += ' AND orderitemcode = ?';
            params.push(orderitemcode);
        }

        await executeMySql(sql, params);

        let sqlPkg = 'UPDATE packagemaster SET voiddatetime = ? WHERE prescriptionno = ?';
        const paramsPkg = [voidValue, prescriptionno];
        if (orderitemcode) {
            sqlPkg += ' AND orderitemcode = ?';
            paramsPkg.push(orderitemcode);
        }
        await executeMySql(sqlPkg, paramsPkg);

        res.json({ success: true, message: isCancel ? 'ยกเลิกรายการสำเร็จ' : 'นำรายการกลับมาเป็นปกติสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/prescriptions/:prescriptionno', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const prescriptionno = payload.prescriptionno || req.params.prescriptionno;

        if (!prescriptionno) {
            return res.status(400).json({
                success: false,
                message: 'prescriptionno is required'
            });
        }

        const result = await executeMySql(
            `${prescriptionSelectQuery} WHERE prescription.prescriptionno = ?`,
            [prescriptionno]
        );

        if (result.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Prescription not found'
            });
        }

        return res.json({
            success: true,
            data: result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
