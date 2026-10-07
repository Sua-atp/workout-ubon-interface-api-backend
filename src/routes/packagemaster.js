const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const express = require('express');
const multer = require('multer');
const { executeMySql } = require('../db/mysqlPool');
const { sendOrderSelectQuery } = require('../db/queries/sendOrder');
const { buildHisTransXml, sendHisTransData, formatHisDateTime } = require('../integrations/hisConsis');

const OCS_OUTPUT_DIR = process.env.OCS_OUTPUT_DIR || path.join(__dirname, '../../ocs-output');
const HOSPITAL_NAME_OCS = process.env.HOSPITAL_NAME_OCS || '';

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 1024 * 1024
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

const packageMasterSelectQuery = `
    SELECT
        packagemaster.prescriptionno,
        packagemaster.seq,
        packagemaster.seqmax,
        packagemaster.orderitembarcode,
        packagemaster.patientname,
        packagemaster.sex,
        packagemaster.patientdob,
        packagemaster.hn,
        packagemaster.an,
        packagemaster.wardcode,
        packagemaster.wardname,
        packagemaster.bedcode,
        packagemaster.prioritycode,
        packagemaster.prioritydesc,
        packagemaster.takedate,
        packagemaster.enddate,
        packagemaster.ordercreatedate,
        packagemaster.orderitemcode,
        packagemaster.orderitemname,
        packagemaster.orderqty,
        packagemaster.orderunitcode,
        packagemaster.orderunitdesc,
        packagemaster.instructioncode,
        packagemaster.instructiondesc,
        packagemaster.dosage,
        packagemaster.dosageunitcode,
        packagemaster.dosageunitdesc,
        packagemaster.frequencycode,
        packagemaster.frequencydesc,
        packagemaster.timecode,
        packagemaster.timedesc,
        packagemaster.frequencyTime,
        packagemaster.frequencyTimedesc,
        packagemaster.durationcode,
        packagemaster.durationdesc,
        packagemaster.fromlocationname,
        packagemaster.usercreatecode,
        packagemaster.usercreatename,
        packagemaster.orderacceptfromip,
        packagemaster.computername,
        packagemaster.itemlotcode,
        packagemaster.itemlotexpire,
        packagemaster.doctorcode,
        packagemaster.doctorname,
        packagemaster.pharmacyitemcode,
        packagemaster.pharmacyitemdesc,
        packagemaster.freetext1,
        packagemaster.freetext2,
        packagemaster.itemidentify,
        packagemaster.lastmodified,
        packagemaster.language,
        packagemaster.multidosestatus,
        packagemaster.highalert,
        packagemaster.locationcode,
        packagemaster.shelfzone,
        packagemaster.shelfname,
        packagemaster.printstatus,
        packagemaster.varymeal,
        packagemaster.varymealtime,
        packagemaster.voiddatetime,
        packagemaster.genOCSdatetime,
        packagemaster.printdatetime,
        packagemaster.matchingdatetime,
        packagemaster.matchinguserid,
        packagemaster.checkoutdatetime,
        packagemaster.checkoutuserid,
        packagemaster.medtransferdatetime,
        packagemaster.medtransferuserid,
        packagemaster.leddatetime,
        packagemaster.leduserid,
        packagemaster.haddatetime,
        packagemaster.haduserid,
        packagemaster.JVMdatetime,
        packagemaster.JVMuserid,
        packagemaster.forcash,
        packagemaster.frequencycount,
        packagemaster.itemindex,
        packagemaster.tmtcode,
        packagemaster.rowpatient,
        packagemaster.cartname,
        packagemaster.leddispensedatetime,
        packagemaster.haddispensedatetime,
        packagemaster.holddatetime,
        packagemaster.freetext3,
        packagemaster.ordertype,
        packagemaster.printauto,
        packagemaster.printdrp,
        packagemaster.verifydatetime,
        packagemaster.verifyuserid,
        packagemaster.printdrugdatetime,
        packagemaster.printdruguserid,
        COALESCE(packagemaster.checkdatetime, packagemaster.verifydatetime) AS checkdatetime,
        COALESCE(packagemaster.checkuserid, packagemaster.verifyuserid) AS checkuserid,
        ms_drug.sendmachine AS ms_drug_sendmachine,
        ms_drug.highalert AS ms_drug_highalert,
        ms_drug.shelfzone AS ms_drug_shelfzone,
        ms_drug.shelfname2 AS ms_drug_shelfname2,
        packagemaster.receive_userID,
        packagemaster.receive_datetime,
        packagemaster.return_userID,
        packagemaster.return_datetime,
        packagemaster.current_qty,
        packagemaster.statuscode,
        packagemaster.order_status
    FROM packagemaster
    LEFT JOIN ms_drug ON packagemaster.orderitemcode = ms_drug.orderitemcode
`;

function uploadJsonFile(req, res, next) {
    upload.single('file')(req, res, (error) => {
        if (error) {
            res.status(400).json({
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

function isFalseValue(value) {
    return value === false || value === 'false';
}

async function handlePackageMasterRequest(req, res) {
    try {
        const payload = req.method === 'GET' ? (req.query ?? {}) : getJsonPayload(req);
        const filters = [];
        const params = [];
        const startDate = payload.startDate || payload.ordercreatedate || '2026-04-18';

        if (startDate) {
            filters.push('packagemaster.ordercreatedate >= ?');
            params.push(startDate);
        }

        if (!isFalseValue(payload.leddatetimeIsNull)) {
            filters.push('packagemaster.leddatetime IS NULL');
        }

        if (payload.prescriptionno) {
            filters.push('packagemaster.prescriptionno = ?');
            params.push(payload.prescriptionno);
        }

        if (payload.packageno) {
            filters.push('packagemaster.packageno = ?');
            params.push(payload.packageno);
        }

        const whereClause = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
        const result = await executeMySql(`${packageMasterSelectQuery}${whereClause}`, params);

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
}

router.get('/api/packagemaster', handlePackageMasterRequest);
router.post('/api/packagemaster', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        if (Array.isArray(payload.ans) && payload.ans.length > 0) {
            const results = await executeSendByPres(payload);
            return res.json({ success: true, results });
        }
        if (Array.isArray(payload.items) && payload.items.length > 0) {
            const frequencyCounters = new Map();
            for (const item of payload.items) {
                await insertPackageMasterRow(item, { frequencyCounters });
            }
            return res.json({ success: true, insertedCount: payload.items.length });
        }
        return handlePackageMasterRequest(req, res);
    } catch (error) {
        const status = error.message && error.message.includes('required') ? 400 : 500;
        return res.status(status).json({ success: false, message: error.message });
    }
});

function pad2(value) {
    return String(value).padStart(2, '0');
}

function pad3(value) {
    return String(value).padStart(3, '0');
}

function toDateOnly(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// VB: AdminStartDate/AdminEndDate = takedate.ToString("yyMMdd")
function formatYYMMDD(value) {
    const d = toDateOnly(value);
    if (!d) return '';
    return `${pad2(d.getFullYear() % 100)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

// VB ChangeBODDatetime: if d <> "" then d = Year & "-" & ToString("MM-dd")
function formatBirthDay(value) {
    const raw = value === null || value === undefined ? '' : String(value).trim();
    if (raw === '') return raw;

    const d = toDateOnly(raw);
    if (!d) return raw;

    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// VB: OCSfilename timestamp = Date.Now.ToString("yyMMddhhmmssfff")
function formatFilenameTimestamp(date) {
    return `${pad2(date.getFullYear() % 100)}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
        `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}${pad3(date.getMilliseconds())}`;
}

function calcAgeYears(dob) {
    const d = toDateOnly(dob);
    if (!d) return '';
    const today = new Date();
    let years = today.getFullYear() - d.getFullYear();
    let months = today.getMonth() - d.getMonth();
    let days = today.getDate() - d.getDate();
    if (days < 0) {
        months--;
        days += new Date(today.getFullYear(), today.getMonth(), 0).getDate();
    }
    if (months < 0) {
        years--;
        months += 12;
    }
    if (years < 0) return '';
    return `${years}ปี ${months}เดือน ${days}วัน`;
}

// VB: AdminTime = Mid(frequencyTime, 1, 2) & ":" & Mid(frequencyTime, 3, 2); "00:00" if blank
function formatAdminTime(frequencyTime) {
    const raw = String(frequencyTime || '').trim();
    const time = `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
    return time === ':' ? '00:00' : time;
}

function buildOcsLine(row, hospitalName) {
    const dosageRaw = String(row.dosage || '').trim();
    const qty = dosageRaw !== '' ? String(Number(dosageRaw)) : '1';
    const instructionDesc = String(row.instructiondesc || '');

    const fields = [
        String(row.patientname || ''),           // PatientName
        String(row.hn || ''),                     // PatientID
        String(row.prescriptionno || ''),         // OrderNumber
        formatBirthDay(row.patientdob),           // BirthDay
        String(row.wardname || ''),               // Location
        String(row.bedcode || ''),                // RoomNumber
        String(row.bedcode || ''),                // BedNumber
        calcAgeYears(row.patientdob),              // Age
        String(row.an || ''),                     // AdmissionNumber
        '',                                        // VisitNumber
        'I',                                       // InOutPatient
        qty,                                       // QTY
        String(row.orderitemcode || ''),          // Mnemonic
        String(row.orderitemname || '').replace(/}/g, ''), // DrugName
        formatYYMMDD(row.takedate),               // AdminStartDate
        formatYYMMDD(row.takedate),               // AdminEndDate
        formatAdminTime(row.frequencyTime),       // AdminTime
        String(row.frequencyTimedesc || ''),      // AdminTimeDescription
        '',                                        // WarningMessage
        hospitalName,                              // HospitalNameOCS
        '',                                        // PrescriptionAddCancel
        '0',                                       // UnitDoseState
        '',                                        // MedicineBarcode
        'Drug For Continue',                       // OrderType
        '2',                                       // DispensePriority
        String(row.itemidentify || ''),           // Temp1
        `เวลา:${formatAdminTime(row.frequencyTime)}`, // Temp2
        instructionDesc ? instructionDesc.replace(/ครั้งละ/g, '').trim() : '', // Temp3
        String(row.freetext3 || ''),              // Temp4
        '',                                        // Temp5
    ];

    return fields.join('|') + '|';
}

async function generateOcsFile(an, ordercreatedate, continueFinished) {
    const filters = [
        'packagemaster.an = ?',
        "packagemaster.printstatus = '0'",
        continueFinished ? 'packagemaster.genOCSdatetime IS NOT NULL' : 'packagemaster.genOCSdatetime IS NULL'
    ];
    const params = [an];
    if (ordercreatedate && String(ordercreatedate).trim() !== '') {
        filters.push('DATE(packagemaster.ordercreatedate) = ?');
        params.push(String(ordercreatedate).trim());
    }

    const rows = await executeMySql(`${packageMasterSelectQuery} WHERE ${filters.join(' AND ')}`, params);

    if (rows.length === 0) {
        return { generated: false, recordCount: 0 };
    }

    const ocsContent = rows.map((row) => buildOcsLine(row, HOSPITAL_NAME_OCS)).join('\r\n');
    const lastPatientId = String(rows[rows.length - 1].hn || '');
    const fileName = `${formatFilenameTimestamp(new Date())}_${lastPatientId}.txt`;

    const filePath = path.join(OCS_OUTPUT_DIR, fileName);
    console.log(`[OCS] writing to: ${filePath}`);
    fs.mkdirSync(OCS_OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(filePath, iconv.encode(ocsContent, 'cp874'));
    console.log(`[OCS] file written: ${filePath}`);

    const updateFilters = ['an = ?', "printstatus = '0'", 'genOCSdatetime IS NULL'];
    const updateParams = [an];
    if (ordercreatedate && String(ordercreatedate).trim() !== '') {
        updateFilters.push('DATE(ordercreatedate) = ?');
        updateParams.push(String(ordercreatedate).trim());
    }
    await executeMySql(
        `UPDATE packagemaster SET genOCSdatetime = NOW() WHERE ${updateFilters.join(' AND ')}`,
        updateParams
    );

    return { generated: true, fileName, recordCount: rows.length };
}

router.post('/api/packagemaster/gen-ocs-file', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const an = payload.an;
        const ordercreatedate = payload.ordercreatedate || payload.date;
        const continueFinished = payload.continueFinished === true;

        if (!an || !ordercreatedate) {
            return res.status(400).json({ success: false, message: 'an and ordercreatedate are required' });
        }

        const result = await generateOcsFile(an, ordercreatedate, continueFinished);

        if (!result.generated) {
            return res.json({ success: true, generated: false, message: 'No records found', recordCount: 0 });
        }

        return res.json({
            success: true,
            generated: true,
            fileName: result.fileName,
            recordCount: result.recordCount
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/mark-gen-ocs', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const itemindexes = Array.isArray(payload.itemindexes)
            ? [...new Set(payload.itemindexes.map((itemindex) => String(itemindex || '').trim()).filter(Boolean))]
            : [];

        if (itemindexes.length === 0) {
            return res.status(400).json({ success: false, message: 'itemindexes (array) is required' });
        }

        const result = await executeMySql(
            `UPDATE packagemaster SET genOCSdatetime = NOW()
             WHERE itemindex IN (${itemindexes.map(() => '?').join(', ')})
             AND genOCSdatetime IS NULL`,
            itemindexes
        );

        return res.json({ success: true, updated: result.affectedRows ?? 0 });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

/* ─── send-by-pres: screen prescriptions by AN, insert into packagemaster, generate OCS ─── */

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function stripZeroDigits(value) {
    return String(value || '').split('').filter((ch) => ch !== '0').join('');
}

// VB ChangeDatetime: normalizes a date/datetime string for storage. Exact source not provided —
// implemented as a straightforward "yyyy-MM-dd HH:mm:ss" passthrough; adjust if legacy format differs.
function toMySqlDateTime(value) {
    if (value === null || value === undefined || value === '') return null;
    const d = toDateOnly(value);
    if (!d) return null;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function toMySqlDate(value) {
    const dt = toMySqlDateTime(value);
    return dt ? dt.slice(0, 10) : null;
}

function nullIfBlank(value) {
    return value === '' ? null : value;
}

function isHighAlertValue(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) return false;
    return !['0', 'n', 'false', 'no'].includes(normalized);
}

function isHadRow(row) {
    if (!row) return false;
    if (isHighAlertValue(row.highalert)) return true;
    const sz = String(row.shelfzone ?? '').trim().toUpperCase();
    if (sz === 'HAD') return true;
    const loc = String(row.locationcode ?? '').trim().toUpperCase();
    if (loc === 'HAD') return true;
    return false;
}

function getUniqueHadPrescriptionRows(rows) {
    const seen = new Set();
    const uniqueRows = [];
    for (const row of rows) {
        if (!isHadRow(row)) continue;
        const key = `${String(row.prescriptionno || '').trim()}|${row.seq ?? ''}|${String(row.orderitemcode || '').trim()}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueRows.push(row);
        }
    }
    return uniqueRows;
}

function isJvmRow(row) {
    if (!row) return false;
    const zone = String(row.shelfzone ?? '').trim().toUpperCase();
    if (zone === 'JVM') return true;
    const loc = String(row.locationcode ?? '').trim().toUpperCase();
    if (loc === 'JVM') return true;
    const shelf = String(row.shelfname ?? '').trim().toUpperCase();
    if (shelf === 'JVM') return true;
    return false;
}

function isPrnRow(row) {
    if (!row) return false;
    return String(row.timecode ?? '').trim().toLowerCase().includes('prn');
}

function isNbRow(row) {
    if (!row) return false;
    return String(row.timecode ?? '').trim().toUpperCase().includes('NB');
}

function getPackageRowKey(row) {
    return `${String(row.prescriptionno || '').trim()}|${row.seq ?? ''}|${String(row.orderitemcode || '').trim()}`;
}

// NB และ PRN ที่อยู่ location JVM อาจได้หลายแถวจาก ms_timedetail แต่ต้องการซองยาเดียวต่อรายการ
function dedupeSinglePackageRows(rows) {
    const nbGroups = new Set(rows.filter(isNbRow).map(getPackageRowKey));
    const seenGroups = new Set();
    const result = [];
    for (const row of rows) {
        const key = getPackageRowKey(row);
        if ((isPrnRow(row) && isJvmRow(row)) || nbGroups.has(key)) {
            if (seenGroups.has(key)) continue;
            seenGroups.add(key);
        }
        result.push(row);
    }
    return result;
}

// FrequencyTime ของ timetype=1/JVM และ prn/JVM ต้องไม่ซ้ำกันใน AN เดียวกัน จึงหาเลขล่าสุดที่เคยใช้ (ขึ้นต้นด้วย 22)
// แล้ววิ่งเลขต่อไปเรื่อยๆ เช่น 2201 -> 2202 -> 2203
async function getNextPrnFrequencyTimeCounter(an) {
    const result = await executeMySql(
        "SELECT frequencyTime FROM packagemaster WHERE an = ? AND frequencyTime LIKE '22%'",
        [an]
    );
    let maxVal = 2200;
    for (const r of result) {
        const n = parseInt(r.frequencyTime, 10);
        if (!isNaN(n) && n > maxVal) maxVal = n;
    }
    return maxVal;
}

function toHisDateOnly(value) {
    const formatted = formatHisDateTime(value);
    return formatted ? formatted.slice(0, 10) : '';
}

function buildHadHisXml(rows, userId) {
    const hadRows = Array.isArray(rows) ? (rows.length > 0 && rows.every((r) => isHadRow(r)) ? rows : getUniqueHadPrescriptionRows(rows)) : [];
    if (hadRows.length === 0) {
        return null;
    }

    const grouped = new Map();
    for (const row of hadRows) {
        const prescriptionNo = String(row.prescriptionno || '').trim() || 'UNKNOWN';
        const bucket = grouped.get(prescriptionNo) || [];
        bucket.push(row);
        grouped.set(prescriptionNo, bucket);
    }

    const firstRow = hadRows[0];
    const opManNo = userId || firstRow.doctorcode || firstRow.usercreatecode || '';
    const opManName = firstRow.doctorname || firstRow.usercreatename || '';

    const prescriptions = Array.from(grouped.entries()).map(([prescNo, groupRows]) => {
        const head = groupRows[0];
        return {
            header: {
                prescDate: formatHisDateTime(head.ordercreatedate || new Date()),
                prescNo,
                patientId: head.hn || head.an || '',
                patientName: head.patientname || '',
                dob: toHisDateOnly(head.patientdob),
                sex: head.sex || '',
                orderedBy: userId || head.doctorcode || head.usercreatecode || '',
                orderedByName: head.doctorname || head.usercreatename || '',
                enteredBy: head.usercreatename || head.doctorname || '',
            },
            items: groupRows.map((row, index) => ({
                prescNo,
                itemNo: index + 1,
                drugCode: row.orderitemcode || row.pharmacyitemcode || '',
                drugName: row.orderitemname || row.pharmacyitemdesc || '',
                unit: row.orderunitdesc || row.orderunitcode || row.dosageunitdesc || '',
                quantity: row.orderqty || '1',
                dosage: row.dosage || row.orderqty || '',
                dosageUnit: row.dosageunitdesc || row.dosageunitcode || '',
                administration: row.instructiondesc || row.timedesc || '',
                frequency: row.frequencydesc || row.frequencycode || '',
            })),
        };
    });

    return buildHisTransXml({ opManNo, opManName, prescriptions });
}

async function sendHadXmlIfNeeded(rows, userId) {
    const hadRows = getUniqueHadPrescriptionRows(rows);
    if (hadRows.length === 0) {
        return { sent: false, count: 0 };
    }

    const xmlValue = buildHadHisXml(hadRows, userId);
    if (!xmlValue) {
        return { sent: false, count: 0 };
    }

    const firstRow = hadRows[0] || {};
    const prescNo = String(firstRow.prescriptionno || firstRow.an || 'UNKNOWN').trim();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // Write XML file to logs/xml directory
    let xmlFilePath = null;
    try {
        const logDir = path.join(__dirname, '../../logs/xml');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const fileName = `HIS_HAD_${prescNo}_${timestamp}.xml`;
        xmlFilePath = path.join(logDir, fileName);
        fs.writeFileSync(xmlFilePath, xmlValue, 'utf8');
        console.log(`[send-by-pres] Saved HAD XML log file: ${fileName}`);
    } catch (logErr) {
        console.error('[send-by-pres] Failed to write HAD XML log file:', logErr.message);
    }

    // Write execution log entry
    function writeLogEntry(statusMsg, extraDetails = '') {
        try {
            const logFile = path.join(__dirname, '../../logs/had_his_send.log');
            const logDir = path.dirname(logFile);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const logText = `[${new Date().toISOString()}] PRESC_NO: ${prescNo} | USER: ${userId || 'N/A'} | HAD_ITEMS: ${hadRows.length} | STATUS: ${statusMsg} ${extraDetails ? '| ' + extraDetails : ''}\n`;
            fs.appendFileSync(logFile, logText, 'utf8');
        } catch (e) {
            console.error('[send-by-pres] Failed to append HAD log:', e.message);
        }
    }

    console.log(`[send-by-pres] Sending XML for ${hadRows.length} HAD medication(s) (PrescNo: ${prescNo})...`);

    try {
        const response = await sendHisTransData(xmlValue);
        writeLogEntry('SUCCESS', `SOAP_RESULT: ${response.result || 'OK'} | XML_FILE: ${xmlFilePath || 'N/A'}`);
        console.log(`[send-by-pres] HAD XML sent successfully for PrescNo ${prescNo}. Result:`, response.result);
        return { sent: true, count: hadRows.length, xmlFile: xmlFilePath, response: response.result };
    } catch (sendErr) {
        writeLogEntry('ERROR', `MSG: ${sendErr.message} | XML_FILE: ${xmlFilePath || 'N/A'}`);
        console.error(`[send-by-pres] Error sending HAD XML to HIS for PrescNo ${prescNo}:`, sendErr.message);
        return { sent: false, count: hadRows.length, error: sendErr.message, xmlFile: xmlFilePath };
    }
}

function buildPackageMasterRow(row, index, totalCount, now, frontMed) {
    const takedateDate = toDateOnly(row.takedate);
    let takedateOut = takedateDate;

    const timedetailcodeRaw = String(row.timedetailcode || '').trim();
    const tt = timedetailcodeRaw === '' ? 0 : (parseInt(timedetailcodeRaw, 10) || 0);

    if (takedateDate) {
        takedateOut = tt <= 1500 ? addDays(takedateDate, 1) : takedateDate;
    }

    let frequencyTime = String(row.timedetailcode || '');
    let frequencyTimedesc = String(row.timedetailTH || '');
    let multidosestatus = '0';

    const timetype = String(row.timetype || '').trim();
    if ((timetype === '1' || timetype === '2') && timedetailcodeRaw !== '0001') {
        multidosestatus = timetype;

        let stripped = stripZeroDigits(row.timedetailcode);
        if (stripped === '') stripped = '59';
        if (stripped === '2359') stripped = '59';

        const padded = String(parseInt(stripped, 10) || 0).padStart(2, '0');
        frequencyTime = (timetype === '1' ? '22' : '23') + padded;
        frequencyTimedesc = String(row.timedetailTH || '');

        if (takedateDate) takedateOut = addDays(takedateDate, 1);
    }

    let locationcode = String(row.locationcode || '');
    let shelfname = String(row.shelfname || '');
    let printstatus;

    let forcedLocation = null;
    let forcedShelfname = null;
    if (frontMed && typeof frontMed.shelfname === 'string') {
        const fnLoc = frontMed.shelfname.toUpperCase();
        if (fnLoc.startsWith('LED')) {
            forcedLocation = 'LED';
            forcedShelfname = frontMed.shelfname;
        } else if (fnLoc.startsWith('JVM')) {
            forcedLocation = 'JVM';
            forcedShelfname = frontMed.shelfname;
        } else if (fnLoc.startsWith('HAD')) {
            forcedLocation = 'HAD';
            forcedShelfname = frontMed.shelfname;
        }
    }

    const isHighAlertRow = forcedLocation === 'HAD' || (!forcedLocation && (String(row.highalert || '').toLowerCase() === 'y' || String(row.highalert || '') === '1' || String(row.shelfzone || '') === 'HAD' || String(row.locationcode || '') === 'HAD'));
    const isJVM = forcedLocation === 'JVM' || (!forcedLocation && (String(row.sendmachine || '').toLowerCase() === 'y' || String(row.shelfzone || '').toUpperCase() === 'JVM' || String(row.locationcode || '') === '2' || String(row.locationcode || '').toUpperCase() === 'JVM' || String(row.shelfname || '').toUpperCase() === 'JVM'));
    const isLED = forcedLocation === 'LED' || (!forcedLocation && !isHighAlertRow && !isJVM);

    if (isJVM) {
        locationcode = '2';
        printstatus = '0';
        if (forcedShelfname) {
            shelfname = forcedShelfname;
        } else if (String(row.shelfzone || '') === 'HAD') {
            shelfname = String(row.shelfzone || '');
        } else {
            shelfname = String(row.shelfname2 || '');
        }
    } else if (isHighAlertRow) {
        locationcode = '3';
        printstatus = '1';
        if (forcedShelfname) {
            shelfname = forcedShelfname;
        }
    } else if (isLED) {
        locationcode = '4';
        printstatus = '1';
        if (forcedShelfname) {
            shelfname = forcedShelfname;
        }
    } else {
        printstatus = '1';
    }

    const varymealDosage = String(row.varymeal_dosage || '').trim();
    let dosage = varymealDosage !== '' ? row.varymeal_dosage : row.dosage;

    if (isHadRow(row)) {
        const dosageStr = String(dosage ?? '').trim();
        if (!dosageStr) {
            dosage = row.orderqty ?? row.qty ?? null;
        }
    }

    const seq = index + 1;
    const orderitembarcode = [
        row.prescriptionno, seq, totalCount,
        formatYYMMDD(now),
        row.orderitemcode, row.an, row.prioritycode
    ].join('|');

    return {
        prescriptionno: row.prescriptionno,
        seq,
        seqmax: totalCount,
        itemindex: row.itemindex,
        orderitembarcode,
        patientname: row.patientname,
        sex: row.sex,
        patientdob: toMySqlDateTime(row.patientdob),
        hn: row.hn,
        an: row.an,
        wardcode: row.wardcode,
        wardname: row.wardname,
        bedcode: row.bedcode,
        prioritycode: row.prioritycode,
        prioritydesc: row.prioritydesc,
        takedate: toMySqlDate(takedateOut),
        enddate: toMySqlDate(takedateDate),
        ordercreatedate: toMySqlDateTime(row.ordercreatedate),
        orderitemcode: row.orderitemcode,
        orderitemname: row.orderitemname,
        orderqty: row.orderqty,
        orderunitcode: row.orderunitcode,
        orderunitdesc: row.orderunitdesc,
        instructioncode: row.instructioncode,
        instructiondesc: row.instructiondesc,
        dosage,
        dosageunitcode: row.dosageunitcode,
        dosageunitdesc: row.dosageunitdesc,
        frequencycode: row.frequencycode,
        frequencydesc: row.frequencydesc,
        timecode: row.timecode,
        timedesc: row.timedesc,
        frequencyTime,
        frequencyTimedesc,
        durationcode: '1',
        durationdesc: '1 วัน',
        fromlocationname: 'ห้องยา IPD',
        usercreatecode: row.usercreatecode,
        usercreatename: row.usercreatename,
        orderacceptfromip: row.orderacceptfromip,
        computername: row.computername,
        itemlotcode: row.itemlotcode,
        itemlotexpire: nullIfBlank(row.itemlotexpire),
        doctorcode: row.doctorcode,
        doctorname: row.doctorname,
        pharmacyitemcode: row.pharmacyitemcode,
        pharmacyitemdesc: row.pharmacyitemdesc,
        freetext1: row.freetext1,
        freetext2: row.freetext2,
        freetext3: row.freetext3,
        itemidentify: row.itemidentify,
        lastmodified: toMySqlDateTime(now),
        language: row.language,
        multidosestatus,
        highalert: '0',
        locationcode,
        shelfzone: row.shelfzone,
        shelfname,
        printstatus,
        varymeal: row.varymeal,
        varymealtime: row.varymealtime,
        voiddatetime: null,
        genOCSdatetime: null,
        printdatetime: null,
        matchingdatetime: null,
        matchinguserid: null,
        checkoutdatetime: null,
        checkoutuserid: null,
        medtransferdatetime: null,
        medtransferuserid: null,
        leddatetime: null,
        haddatetime: null,
        forcash: row.forcash,
        frequencycount: null,
        receive_userID: null,
        receive_datetime: null,
        return_userID: null,
        return_datetime: null,
        current_qty: row.orderqty,
    };
}

async function insertPackageMasterRow(rowData, options = {}) {
    const locationcode = String(rowData.locationcode ?? '').trim().toUpperCase();
    const isJvmPackage = locationcode === '2' || locationcode === 'JVM' || (!locationcode && isJvmRow(rowData));
    let timetype = options.timetype;
    if (isJvmPackage && timetype === undefined) {
        const timeRows = await executeMySql(
            'SELECT timetype FROM ms_time WHERE LOWER(timecode) = LOWER(?)',
            [rowData.timecode ?? null]
        );
        timetype = timeRows[0]?.timetype;
    }
    if ((isJvmPackage && String(timetype ?? '').trim() === '1') || options.separatePrn) {
        if (!rowData.an || String(rowData.an).trim() === '') {
            throw new Error('an is required to assign a separate JVM frequencyTime');
        }
        const an = String(rowData.an).trim();
        const frequencyCounters = options.frequencyCounters || new Map();
        if (!frequencyCounters.has(an)) {
            frequencyCounters.set(an, await getNextPrnFrequencyTimeCounter(an));
        }
        const nextFrequencyTime = frequencyCounters.get(an) + 1;
        rowData.frequencyTime = String(nextFrequencyTime);
        frequencyCounters.set(an, nextFrequencyTime);
        if (options.separatePrn || isPrnRow(rowData)) {
            rowData.frequencyTimedesc = 'PRN';
        }
    }
    if (rowData && isHadRow(rowData)) {
        const dosageStr = String(rowData.dosage ?? '').trim();
        if (!dosageStr) {
            rowData.dosage = rowData.orderqty ?? rowData.qty ?? null;
        }
    }
    const columns = Object.keys(rowData);
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map((col) => (rowData[col] === undefined ? null : rowData[col]));
    await executeMySql(
        `INSERT INTO packagemaster (${columns.join(', ')}) VALUES (${placeholders})`,
        values
    );
}

// ยาตัวเดียวกันอาจมีหลายบรรทัดในใบสั่งเดียว (orderitemcode ซ้ำ) จึง mark ด้วย itemindex ซึ่งไม่ซ้ำต่อบรรทัด
async function markPrescriptionGenOrder(an, ordercreatedate, itemindex, userId) {
    const filters = [
        '(an = ? OR hn = ?)',
        'itemindex = ?',
        'genorderdatetime IS NULL'
    ];
    const params = [an, an, itemindex || null];
    if (ordercreatedate && String(ordercreatedate).trim() !== '') {
        filters.push('DATE(ordercreatedate) = DATE(?)');
        params.push(String(ordercreatedate).trim());
    }
    await executeMySql(
        `UPDATE prescription SET genorderdatetime = NOW(), genorderuserid = ? WHERE ${filters.join(' AND ')}`,
        [userId ?? null, ...params]
    );
}

async function executeSendByPres(payload) {
    const ans = Array.isArray(payload.ans) ? payload.ans.filter(Boolean) : [];
    const rawDate = payload.ordercreatedate || payload.date;
    const ordercreatedate = (typeof rawDate === 'string' ? rawDate.trim() : rawDate) || null;
    const userId = payload.userId || payload.userID || null;
    const itemindexes = Array.isArray(payload.itemindexes)
        ? [...new Set(payload.itemindexes.map((v) => String(v ?? '').trim()).filter(Boolean))]
        : [];

    const frontendMedications = Array.isArray(payload.medications) ? payload.medications : [];
    const medMap = {};
    for (const med of frontendMedications) {
        const key = String(med.itemindex ?? '').trim();
        if (key) {
            medMap[key] = med;
        }
    }

    if (ans.length === 0) {
        throw new Error('ans (array) is required');
    }

    const now = new Date();
    const results = [];
    const frequencyCounters = new Map();

    for (const an of ans) {
        try {
            const filters = [
                '(prescription.an = ? OR prescription.hn = ?)',
                'prescription.voiddatetime IS NULL'
            ];
            const params = [an, an];

            if (ordercreatedate && String(ordercreatedate).trim() !== '') {
                filters.push('DATE(prescription.ordercreatedate) = DATE(?)');
                params.push(String(ordercreatedate).trim());
            }

            if (itemindexes.length > 0) {
                filters.push(`prescription.itemindex IN (${itemindexes.map(() => '?').join(', ')})`);
                params.push(...itemindexes);
            } else {
                filters.push('prescription.genorderdatetime IS NULL');
            }

            const rows = await executeMySql(
                `${sendOrderSelectQuery} WHERE ${filters.join(' AND ')}`,
                params
            );

            if (rows.length === 0) {
                console.log(`[send-by-pres] No matching prescriptions found for id/AN/HN: ${an}, date: ${ordercreatedate || 'ALL'}`);
                results.push({ an, recordCount: 0, ocsGenerated: false });
                continue;
            }

            const hadXmlResult = await sendHadXmlIfNeeded(rows, userId);

            // prn ที่อยู่ location JVM: gen ซองเดียวต่อรายการยา ไม่แยกแถวตาม timedetail
            const packageRows = dedupeSinglePackageRows(rows);

            console.log(`[send-by-pres] Found ${rows.length} rows (${packageRows.length} packages) for ${an}. Inserting into packagemaster...`);
            let insertedCount = 0;
            const rowWarnings = [];
            const generatedBarcodes = {};

            for (let i = 0; i < packageRows.length; i++) {
                try {
                    const frontMed = medMap[String(packageRows[i].itemindex ?? '').trim()];
                    const rowData = buildPackageMasterRow(packageRows[i], i, packageRows.length, now, frontMed);
                    await insertPackageMasterRow(rowData, {
                        timetype: packageRows[i].timetype ?? null,
                        separatePrn: isPrnRow(packageRows[i]) && isJvmRow(packageRows[i]),
                        frequencyCounters
                    });
                    if (packageRows[i].itemindex) {
                        generatedBarcodes[packageRows[i].itemindex] = rowData.orderitembarcode;
                    }
                    try {
                        await markPrescriptionGenOrder(an, ordercreatedate, packageRows[i].itemindex, userId);
                    } catch (markErr) {
                        console.error(`[send-by-pres] markPrescriptionGenOrder failed for ${an} / ${packageRows[i].itemindex}:`, markErr.message);
                        rowWarnings.push(`ยา ${packageRows[i].orderitemcode || `รายการที่ ${i + 1}`}: อัปเดต genorderdatetime ไม่สำเร็จ`);
                    }
                    insertedCount++;
                } catch (rowErr) {
                    console.error(`[send-by-pres] insertPackageMasterRow failed for ${an} row ${i + 1}:`, rowErr.message);
                    rowWarnings.push(`ยา ${packageRows[i].orderitemcode || `รายการที่ ${i + 1}`}: บันทึกไม่สำเร็จ — ${rowErr.message}`);
                }
            }

            // ไฟล์ OCS (.txt) ถูกสร้างฝั่ง Client เอง (ocs-file-writer.js บน localhost:3001)
            // ไม่ใช่ที่นี่ - เก็บ field ไว้เพื่อ backward-compat ของ response shape เท่านั้น
            const ocsResult = { generated: false, fileName: null };

            results.push({
                an,
                recordCount: insertedCount,
                skippedCount: packageRows.length - insertedCount,
                warnings: rowWarnings.length > 0 ? rowWarnings : undefined,
                ocsGenerated: ocsResult.generated,
                ocsFileName: ocsResult.fileName || null,
                ocsError: null,
                hadXmlSent: hadXmlResult.sent,
                hadXmlRecordCount: hadXmlResult.count,
                generatedBarcodes: Object.keys(generatedBarcodes).length > 0 ? generatedBarcodes : undefined,
            });
        } catch (anErr) {
            console.error(`[send-by-pres] Error processing ${an}:`, anErr.message);
            results.push({ an, recordCount: 0, error: anErr.message, warnings: [`ไม่สามารถประมวลผล ${an}: ${anErr.message}`] });
        }
    }

    return results;
}

router.post('/api/packagemaster/send-by-pres', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const results = await executeSendByPres(payload);
        return res.json({ success: true, results });
    } catch (error) {
        const status = error.message.includes('required') ? 400 : 500;
        return res.status(status).json({ success: false, message: error.message });
    }
});

/* ─── Matching page routes ─── */

router.post('/api/packagemaster/matching/ward-summary', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const filters = ['matchingdatetime IS NULL', 'voiddatetime IS NULL'];
        const params = [];
        if (payload.ordercreatedate) {
            filters.push('DATE(ordercreatedate) = ?');
            params.push(payload.ordercreatedate);
        }
        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT wardcode, wardname,
                   COUNT(DISTINCT COALESCE(NULLIF(TRIM(prescriptionno), ''), NULLIF(TRIM(an), ''), NULLIF(TRIM(hn), ''))) AS prescription_count,
                   COUNT(DISTINCT COALESCE(an, hn)) AS patient_count,
                   COUNT(*) AS drug_count
            FROM packagemaster ${where}
            GROUP BY wardcode, wardname
            ORDER BY wardname
        `, params);
        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/matching/patients', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const filters = ['matchingdatetime IS NULL', 'voiddatetime IS NULL'];
        const params = [];
        if (payload.wardcode) {
            filters.push('wardcode = ?');
            params.push(payload.wardcode);
        }
        const keyFilter = buildPatientKeyFilter(payload.keys, 'matchingdatetime IS NULL AND voiddatetime IS NULL');
        if (keyFilter) {
            filters.push(keyFilter.sql);
            params.push(...keyFilter.params);
        }
        if (payload.ordercreatedate) {
            filters.push('DATE(ordercreatedate) = ?');
            params.push(payload.ordercreatedate);
        }
        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT an, hn, COALESCE(an, hn) AS id, patientname, bedcode,
                   COUNT(*) AS drug_count
            FROM packagemaster ${where}
            GROUP BY an, hn, patientname, bedcode
            ORDER BY bedcode, patientname
        `, params);
        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/matching/drugs', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        if (!payload.an) return res.status(400).json({ success: false, message: 'an is required' });
        const filters = ['(an = ? OR hn = ?)', 'matchingdatetime IS NULL', 'voiddatetime IS NULL'];
        const params = [payload.an, payload.an];
        if (payload.ordercreatedate) {
            filters.push('DATE(ordercreatedate) = ?');
            params.push(payload.ordercreatedate);
        }
        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`${packageMasterSelectQuery} ${where} ORDER BY seq`, params);
        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ค้นผู้ป่วยข้ามทุกหอผู้ป่วยด้วยค่าที่สแกน (AN / HN / prescriptionno) โดยยังนับ drug_count ของผู้ป่วยทั้งคน
function buildPatientKeyFilter(keys, baseConditions) {
    const list = [...new Set((Array.isArray(keys) ? keys : []).map((k) => String(k ?? '').trim()).filter(Boolean))];
    if (list.length === 0) return null;
    const ph = list.map(() => '?').join(', ');
    return {
        sql: `COALESCE(an, hn) IN (SELECT COALESCE(an, hn) FROM packagemaster WHERE ${baseConditions} AND (an IN (${ph}) OR hn IN (${ph}) OR prescriptionno IN (${ph})))`,
        params: [...list, ...list, ...list]
    };
}

// ระบุซองยาด้วยคู่ (itemindex, orderitembarcode) — orderitemcode ซ้ำได้เมื่อยาตัวเดียวกันมีหลายบรรทัดในใบสั่งเดียว
function buildPackageItemFilter(items) {
    const pairs = (Array.isArray(items) ? items : [])
        .map((it) => ({
            itemindex: String(it?.itemindex ?? '').trim(),
            orderitembarcode: String(it?.orderitembarcode ?? '').trim()
        }))
        .filter((it) => it.itemindex && it.orderitembarcode);
    if (pairs.length === 0) return null;
    return {
        sql: `(${pairs.map(() => '(itemindex = ? AND orderitembarcode = ?)').join(' OR ')})`,
        params: pairs.flatMap((it) => [it.itemindex, it.orderitembarcode])
    };
}

router.put('/api/packagemaster/confirm-matching', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const { an, items, userId, userName } = payload;
        if (!an) return res.status(400).json({ success: false, message: 'an is required' });
        const itemFilter = buildPackageItemFilter(items);
        if (!itemFilter) {
            return res.status(400).json({ success: false, message: 'items (itemindex + orderitembarcode) is required' });
        }
        const matchingUserId = [userId, userName].filter(Boolean).join('|');
        const filters = [
            '(an = ? OR hn = ?)',
            itemFilter.sql,
            'voiddatetime IS NULL'
        ];
        const params = [matchingUserId, an, an, ...itemFilter.params];
        const result = await executeMySql(
            `UPDATE packagemaster SET matchingdatetime = NOW(), matchinguserid = ? WHERE ${filters.join(' AND ')}`,
            params
        );
        return res.json({ success: true, affectedRows: result?.affectedRows ?? 0 });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

/* ─── Checkout routes (using packagemaster table where matchingdatetime IS NOT NULL AND checkoutdatetime IS NULL) ─── */

router.post('/api/packagemaster/checkout/ward-summary', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const filters = ['matchingdatetime IS NOT NULL', 'checkoutdatetime IS NULL', 'voiddatetime IS NULL'];
        const params = [];
        if (payload.ordercreatedate) {
            filters.push('DATE(ordercreatedate) = ?');
            params.push(payload.ordercreatedate);
        }
        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT wardcode, wardname,
                   COUNT(DISTINCT COALESCE(NULLIF(TRIM(prescriptionno), ''), NULLIF(TRIM(an), ''), NULLIF(TRIM(hn), ''))) AS prescription_count,
                   COUNT(DISTINCT COALESCE(an, hn)) AS patient_count,
                   COUNT(*) AS drug_count
            FROM packagemaster ${where}
            GROUP BY wardcode, wardname
            ORDER BY wardname
        `, params);
        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/checkout/patients', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const filters = ['matchingdatetime IS NOT NULL', 'checkoutdatetime IS NULL', 'voiddatetime IS NULL'];
        const params = [];
        if (payload.wardcode) {
            filters.push('wardcode = ?');
            params.push(payload.wardcode);
        }
        const keyFilter = buildPatientKeyFilter(payload.keys, 'matchingdatetime IS NOT NULL AND checkoutdatetime IS NULL AND voiddatetime IS NULL');
        if (keyFilter) {
            filters.push(keyFilter.sql);
            params.push(...keyFilter.params);
        }
        if (payload.ordercreatedate) {
            filters.push('DATE(ordercreatedate) = ?');
            params.push(payload.ordercreatedate);
        }
        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT an, hn, COALESCE(an, hn) AS id, patientname, bedcode,
                   COUNT(*) AS drug_count
            FROM packagemaster ${where}
            GROUP BY an, hn, patientname, bedcode
            ORDER BY bedcode, patientname
        `, params);
        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/checkout/drugs', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        if (!payload.an) return res.status(400).json({ success: false, message: 'an is required' });
        const filters = ['(an = ? OR hn = ?)', 'matchingdatetime IS NOT NULL', 'checkoutdatetime IS NULL', 'voiddatetime IS NULL'];
        const params = [payload.an, payload.an];
        if (payload.ordercreatedate) {
            filters.push('DATE(ordercreatedate) = ?');
            params.push(payload.ordercreatedate);
        }
        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`${packageMasterSelectQuery} ${where} ORDER BY seq`, params);
        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.put('/api/packagemaster/confirm-checkout', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const { an, items, userId, userName } = payload;
        if (!an) return res.status(400).json({ success: false, message: 'an is required' });
        const itemFilter = buildPackageItemFilter(items);
        if (!itemFilter) {
            return res.status(400).json({ success: false, message: 'items (itemindex + orderitembarcode) is required' });
        }
        const checkoutUserId = [userId, userName].filter(Boolean).join('|');
        const filters = [
            '(an = ? OR hn = ?)',
            itemFilter.sql,
            'voiddatetime IS NULL'
        ];
        const params = [checkoutUserId, an, an, ...itemFilter.params];
        const result = await executeMySql(
            `UPDATE packagemaster SET checkoutdatetime = NOW(), checkoutuserid = ? WHERE ${filters.join(' AND ')}`,
            params
        );
        return res.json({ success: true, affectedRows: result?.affectedRows ?? 0 });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

/* ─── Screening Check routes (using prescription table where genorderdatetime IS NULL) ─── */

let checkColumnsEnsured = false;
async function ensureCheckColumnsExist() {
    if (checkColumnsEnsured) return;
    try {
        await executeMySql('ALTER TABLE packagemaster ADD COLUMN checkdatetime DATETIME NULL, ADD COLUMN checkuserid VARCHAR(255) NULL, ADD COLUMN checkoutdatetime DATETIME NULL, ADD COLUMN checkoutuserid VARCHAR(255) NULL');
    } catch (e) {
        // Ignore if already exists
    }
    try {
        await executeMySql('ALTER TABLE prescription ADD COLUMN checkdatetime DATETIME NULL, ADD COLUMN checkuserid VARCHAR(255) NULL, ADD COLUMN medtransferdatetime DATETIME NULL, ADD COLUMN medtransferuserid VARCHAR(255) NULL, ADD COLUMN matchingdatetime DATETIME NULL, ADD COLUMN matchinguserid VARCHAR(255) NULL, ADD COLUMN checkoutdatetime DATETIME NULL, ADD COLUMN checkoutuserid VARCHAR(255) NULL');
    } catch (e) {
        // Ignore if already exists
    } finally {
        checkColumnsEnsured = true;
    }
}

router.post('/api/packagemaster/check/ward-summary', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const filters = [
            'genorderdatetime IS NULL',
            'COALESCE(checkdatetime, confirmdatetime) IS NULL',
            'voiddatetime IS NULL'
        ];
        const params = [];
        if (payload.ordercreatedate) {
            filters.push('DATE(ordercreatedate) = ?');
            params.push(payload.ordercreatedate);
        }
        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT wardcode, wardname,
                   COUNT(DISTINCT COALESCE(NULLIF(TRIM(prescriptionno), ''), NULLIF(TRIM(an), ''), NULLIF(TRIM(hn), ''))) AS prescription_count,
                   COUNT(DISTINCT COALESCE(an, hn)) AS patient_count,
                   COUNT(*) AS drug_count
            FROM prescription ${where}
            GROUP BY wardcode, wardname
            ORDER BY wardname
        `, params);
        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/check/patients', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const filters = [
            'genorderdatetime IS NULL',
            'COALESCE(checkdatetime, confirmdatetime) IS NULL',
            'voiddatetime IS NULL'
        ];
        const params = [];
        if (payload.wardcode) {
            filters.push('wardcode = ?');
            params.push(payload.wardcode);
        }
        if (payload.ordercreatedate) {
            filters.push('DATE(ordercreatedate) = ?');
            params.push(payload.ordercreatedate);
        }
        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT an, hn, COALESCE(an, hn) AS id, patientname, bedcode,
                   COUNT(*) AS drug_count
            FROM prescription ${where}
            GROUP BY an, hn, patientname, bedcode
            ORDER BY bedcode, patientname
        `, params);
        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/check/drugs', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        if (!payload.an && !payload.hn) return res.status(400).json({ success: false, message: 'an or hn is required' });
        const targetId = payload.an || payload.hn;
        const filters = [
            '(an = ? OR hn = ?)',
            'genorderdatetime IS NULL',
            'COALESCE(checkdatetime, confirmdatetime) IS NULL',
            'voiddatetime IS NULL'
        ];
        const params = [targetId, targetId];
        if (payload.ordercreatedate) {
            filters.push('DATE(ordercreatedate) = ?');
            params.push(payload.ordercreatedate);
        }
        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT
                prescriptionno,
                seq,
                itemindex,
                orderitemcode,
                orderitemname,
                orderitembarcode,
                dosage,
                dosageunitdesc,
                orderqty,
                orderunitdesc,
                timecode,
                timedesc,
                fromlocationname AS shelfname,
                fromlocationname AS locationcode,
                ordertype,
                confirmdatetime,
                checkdatetime,
                medtransferdatetime,
                matchingdatetime,
                'N' AS highalert,
                hn,
                an,
                patientname,
                wardcode,
                wardname,
                bedcode
            FROM prescription
            ${where}
            ORDER BY seq
        `, params);
        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/verify-screen-match', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const { barcode, expectedPatientId, ordercreatedate } = payload;
        if (!barcode) return res.status(400).json({ success: false, message: 'barcode is required' });

        const filters = [
            '(orderitembarcode = ? OR an = ? OR hn = ? OR prescriptionno = ?)',
            'genorderdatetime IS NULL',
            'voiddatetime IS NULL'
        ];
        const params = [barcode, barcode, barcode, barcode];
        if (ordercreatedate) {
            filters.push('DATE(ordercreatedate) = ?');
            params.push(ordercreatedate);
        }
        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT
                prescriptionno,
                seq,
                itemindex,
                orderitemcode,
                orderitemname,
                orderitembarcode,
                dosage,
                dosageunitdesc,
                orderqty,
                orderunitdesc,
                timecode,
                timedesc,
                fromlocationname AS shelfname,
                fromlocationname AS locationcode,
                ordertype,
                confirmdatetime,
                checkdatetime,
                medtransferdatetime,
                matchingdatetime,
                'N' AS highalert,
                hn,
                an,
                patientname,
                wardcode,
                wardname,
                bedcode
            FROM prescription
            ${where}
        `, params);

        if (!rows || rows.length === 0) {
            return res.json({
                success: true,
                matched: false,
                reason: 'not_found',
                message: `ไม่พบข้อมูลใบสั่งยาหรือบาร์โค้ด (${barcode}) ในตาราง prescription (ที่ genorderdatetime IS NULL) สำหรับเงื่อนไขที่เลือก`
            });
        }

        if (expectedPatientId) {
            const patientMatch = rows.some(r => r.an === expectedPatientId || r.hn === expectedPatientId);
            if (!patientMatch) {
                const foundRow = rows[0];
                return res.json({
                    success: true,
                    matched: false,
                    reason: 'patient_mismatch',
                    message: `ข้อมูลผู้ป่วยไม่ตรงกัน! บาร์โค้ดนี้เป็นของผู้ป่วย: ${foundRow.patientname || ''} (AN: ${foundRow.an || foundRow.hn || ''})`,
                    foundRow
                });
            }
        }

        const medTransferValid = rows.every(r => r.medtransferdatetime !== null && r.medtransferdatetime !== undefined);
        const medTransferMissingItems = rows.filter(r => !r.medtransferdatetime).map(r => r.orderitemname || r.orderitemcode);

        return res.json({
            success: true,
            matched: true,
            medTransferValid,
            medTransferMissingItems,
            data: rows
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.put('/api/packagemaster/confirm-check', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const { an, hn, itemindexes: rawItemindexes, userId, userName } = payload;
        const targetId = an || hn;
        if (!targetId) return res.status(400).json({ success: false, message: 'an or hn is required' });
        const itemindexes = Array.isArray(rawItemindexes)
            ? [...new Set(rawItemindexes.map((v) => String(v ?? '').trim()).filter(Boolean))]
            : [];
        if (itemindexes.length === 0) {
            return res.status(400).json({ success: false, message: 'itemindexes is required' });
        }
        const checkUserId = [userId, userName].filter(Boolean).join('|');
        const filters = [
            '(an = ? OR hn = ?)',
            `itemindex IN (${itemindexes.map(() => '?').join(', ')})`,
            'genorderdatetime IS NULL',
            'voiddatetime IS NULL'
        ];
        const params = [checkUserId, checkUserId, checkUserId, checkUserId, checkUserId, checkUserId, targetId, targetId, ...itemindexes];
        const result = await executeMySql(
            `UPDATE prescription SET checkdatetime = NOW(), checkuserid = ?, confirmdatetime = NOW(), confirmuserid = ?, genorderdatetime = NOW(), genorderuserid = ? WHERE ${filters.join(' AND ')}`,
            params
        );
        return res.json({ success: true, affectedRows: result?.affectedRows ?? 0 });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

/* ─── Screen User Report routes (using prescription table where genorderdatetime IS NOT NULL) ─── */

router.post('/api/packagemaster/report/screen-users', async (req, res) => {
    try {
        await ensureCheckColumnsExist();
        const payload = req.body || {};
        const filters = [
            'prescription.genorderdatetime IS NOT NULL',
            'prescription.voiddatetime IS NULL'
        ];
        const params = [];

        if (payload.dateFrom) {
            filters.push('COALESCE(prescription.checkdatetime, prescription.confirmdatetime, prescription.genorderdatetime) >= ?');
            params.push(`${payload.dateFrom} 00:00:00`);
        }
        if (payload.dateTo) {
            filters.push('COALESCE(prescription.checkdatetime, prescription.confirmdatetime, prescription.genorderdatetime) <= ?');
            params.push(`${payload.dateTo} 23:59:59`);
        }
        if (payload.an && String(payload.an).trim() !== '') {
            filters.push('prescription.an LIKE ?');
            params.push(`%${String(payload.an).trim()}%`);
        }
        if (payload.hn && String(payload.hn).trim() !== '') {
            filters.push('prescription.hn LIKE ?');
            params.push(`%${String(payload.hn).trim()}%`);
        }
        if (payload.patientname && String(payload.patientname).trim() !== '') {
            filters.push('prescription.patientname LIKE ?');
            params.push(`%${String(payload.patientname).trim()}%`);
        }

        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT
                COALESCE(prescription.checkuserid, prescription.confirmuserid, prescription.genorderuserid, 'Unknown User') AS screen_user,
                prescription.prescriptionno,
                prescription.seq,
                prescription.orderitemcode,
                prescription.orderitemname,
                prescription.orderqty,
                prescription.orderunitdesc,
                prescription.hn,
                prescription.an,
                prescription.patientname,
                prescription.wardcode,
                prescription.wardname,
                prescription.bedcode,
                prescription.medtransferdatetime,
                prescription.matchingdatetime,
                prescription.genorderdatetime,
                COALESCE(prescription.checkdatetime, prescription.confirmdatetime, prescription.genorderdatetime) AS check_datetime
            FROM prescription
            ${where}
            ORDER BY check_datetime DESC, prescription.prescriptionno ASC
        `, params);

        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/report/matching-history', async (req, res) => {
    try {
        const payload = req.body || {};
        const filters = [
            'packagemaster.matchingdatetime IS NOT NULL',
            'packagemaster.voiddatetime IS NULL'
        ];
        const params = [];

        if (payload.dateFrom) {
            filters.push('packagemaster.matchingdatetime >= ?');
            params.push(`${payload.dateFrom} 00:00:00`);
        }
        if (payload.dateTo) {
            filters.push('packagemaster.matchingdatetime <= ?');
            params.push(`${payload.dateTo} 23:59:59`);
        }
        if (payload.an && String(payload.an).trim() !== '') {
            filters.push('packagemaster.an LIKE ?');
            params.push(`%${String(payload.an).trim()}%`);
        }
        if (payload.hn && String(payload.hn).trim() !== '') {
            filters.push('packagemaster.hn LIKE ?');
            params.push(`%${String(payload.hn).trim()}%`);
        }
        if (payload.patientname && String(payload.patientname).trim() !== '') {
            filters.push('packagemaster.patientname LIKE ?');
            params.push(`%${String(payload.patientname).trim()}%`);
        }

        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT
                packagemaster.matchinguserid AS match_user,
                packagemaster.matchingdatetime AS match_datetime,
                packagemaster.prescriptionno,
                packagemaster.seq,
                packagemaster.orderitemcode,
                packagemaster.orderitemname,
                packagemaster.orderqty,
                packagemaster.orderunitdesc,
                packagemaster.hn,
                packagemaster.an,
                packagemaster.patientname,
                packagemaster.wardcode,
                packagemaster.wardname,
                packagemaster.bedcode
            FROM packagemaster
            ${where}
            ORDER BY match_datetime DESC, packagemaster.prescriptionno ASC
        `, params);

        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/report/checkout-history', async (req, res) => {
    try {
        const payload = req.body || {};
        const filters = [
            'packagemaster.checkoutdatetime IS NOT NULL',
            'packagemaster.voiddatetime IS NULL'
        ];
        const params = [];

        if (payload.dateFrom) {
            filters.push('packagemaster.checkoutdatetime >= ?');
            params.push(`${payload.dateFrom} 00:00:00`);
        }
        if (payload.dateTo) {
            filters.push('packagemaster.checkoutdatetime <= ?');
            params.push(`${payload.dateTo} 23:59:59`);
        }
        if (payload.an && String(payload.an).trim() !== '') {
            filters.push('packagemaster.an LIKE ?');
            params.push(`%${String(payload.an).trim()}%`);
        }
        if (payload.hn && String(payload.hn).trim() !== '') {
            filters.push('packagemaster.hn LIKE ?');
            params.push(`%${String(payload.hn).trim()}%`);
        }
        if (payload.patientname && String(payload.patientname).trim() !== '') {
            filters.push('packagemaster.patientname LIKE ?');
            params.push(`%${String(payload.patientname).trim()}%`);
        }

        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT
                packagemaster.checkoutuserid AS checkout_user,
                packagemaster.checkoutdatetime AS checkout_datetime,
                packagemaster.prescriptionno,
                packagemaster.seq,
                packagemaster.orderitemcode,
                packagemaster.orderitemname,
                packagemaster.orderqty,
                packagemaster.orderunitdesc,
                packagemaster.hn,
                packagemaster.an,
                packagemaster.patientname,
                packagemaster.wardcode,
                packagemaster.wardname,
                packagemaster.bedcode
            FROM packagemaster
            ${where}
            ORDER BY checkout_datetime DESC, packagemaster.prescriptionno ASC
        `, params);

        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/report/transfer-history', async (req, res) => {
    try {
        const payload = req.body || {};
        const filters = [
            'packagemaster.medtransferdatetime IS NOT NULL',
            'packagemaster.voiddatetime IS NULL'
        ];
        const params = [];

        if (payload.dateFrom) {
            filters.push('packagemaster.medtransferdatetime >= ?');
            params.push(`${payload.dateFrom} 00:00:00`);
        }
        if (payload.dateTo) {
            filters.push('packagemaster.medtransferdatetime <= ?');
            params.push(`${payload.dateTo} 23:59:59`);
        }
        if (payload.an && String(payload.an).trim() !== '') {
            filters.push('packagemaster.an LIKE ?');
            params.push(`%${String(payload.an).trim()}%`);
        }
        if (payload.hn && String(payload.hn).trim() !== '') {
            filters.push('packagemaster.hn LIKE ?');
            params.push(`%${String(payload.hn).trim()}%`);
        }
        if (payload.patientname && String(payload.patientname).trim() !== '') {
            filters.push('packagemaster.patientname LIKE ?');
            params.push(`%${String(payload.patientname).trim()}%`);
        }

        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT
                packagemaster.medtransferuserid AS transfer_user,
                packagemaster.medtransferdatetime AS transfer_datetime,
                packagemaster.prescriptionno,
                packagemaster.seq,
                packagemaster.orderitemcode,
                packagemaster.orderitemname,
                packagemaster.orderqty,
                packagemaster.orderunitdesc,
                packagemaster.hn,
                packagemaster.an,
                packagemaster.patientname,
                packagemaster.wardcode,
                packagemaster.wardname,
                packagemaster.bedcode
            FROM packagemaster
            ${where}
            ORDER BY transfer_datetime DESC, packagemaster.prescriptionno ASC
        `, params);

        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/api/packagemaster/report/tracking', async (req, res) => {
    try {
        const payload = req.body || {};
        const filters = ['prescription.voiddatetime IS NULL'];
        const params = [];

        if (payload.dateFrom) {
            filters.push('COALESCE(prescription.checkdatetime, prescription.confirmdatetime, prescription.genorderdatetime, prescription.ordercreatedate) >= ?');
            params.push(`${payload.dateFrom} 00:00:00`);
        }
        if (payload.dateTo) {
            filters.push('COALESCE(prescription.checkdatetime, prescription.confirmdatetime, prescription.genorderdatetime, prescription.ordercreatedate) <= ?');
            params.push(`${payload.dateTo} 23:59:59`);
        }
        if (payload.an && String(payload.an).trim() !== '') {
            filters.push('prescription.an LIKE ?');
            params.push(`%${String(payload.an).trim()}%`);
        }
        if (payload.hn && String(payload.hn).trim() !== '') {
            filters.push('prescription.hn LIKE ?');
            params.push(`%${String(payload.hn).trim()}%`);
        }
        if (payload.patientname && String(payload.patientname).trim() !== '') {
            filters.push('prescription.patientname LIKE ?');
            params.push(`%${String(payload.patientname).trim()}%`);
        }

        const where = `WHERE ${filters.join(' AND ')}`;
        const rows = await executeMySql(`
            SELECT
                prescription.prescriptionno,
                prescription.seq,
                prescription.orderitemcode,
                prescription.orderitemname,
                prescription.orderqty,
                prescription.orderunitdesc,
                prescription.hn,
                prescription.an,
                prescription.patientname,
                prescription.wardcode,
                prescription.wardname,
                prescription.bedcode,
                COALESCE(prescription.checkdatetime, prescription.confirmdatetime, prescription.genorderdatetime) AS screen_dt,
                COALESCE(prescription.checkuserid, prescription.confirmuserid, prescription.genorderuserid, 'Unknown User') AS screen_user,
                MAX(packagemaster.matchingdatetime) AS match_dt,
                MAX(packagemaster.matchinguserid) AS match_user,
                MAX(packagemaster.checkoutdatetime) AS checkout_dt,
                MAX(packagemaster.checkoutuserid) AS checkout_user,
                MAX(packagemaster.medtransferdatetime) AS transfer_dt,
                MAX(packagemaster.medtransferuserid) AS transfer_user
            FROM prescription
            LEFT JOIN packagemaster ON (prescription.prescriptionno = packagemaster.prescriptionno AND (prescription.seq = packagemaster.seq OR prescription.orderitemcode = packagemaster.orderitemcode) AND packagemaster.voiddatetime IS NULL)
            ${where}
            GROUP BY
                prescription.prescriptionno,
                prescription.seq,
                prescription.orderitemcode,
                prescription.orderitemname,
                prescription.orderqty,
                prescription.orderunitdesc,
                prescription.hn,
                prescription.an,
                prescription.patientname,
                prescription.wardcode,
                prescription.wardname,
                prescription.bedcode,
                prescription.checkdatetime,
                prescription.confirmdatetime,
                prescription.genorderdatetime,
                prescription.checkuserid,
                prescription.confirmuserid,
                prescription.genorderuserid,
                prescription.ordercreatedate
            ORDER BY COALESCE(prescription.checkdatetime, prescription.confirmdatetime, prescription.genorderdatetime, prescription.ordercreatedate) DESC, prescription.prescriptionno DESC, prescription.seq ASC
        `, params);

        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
