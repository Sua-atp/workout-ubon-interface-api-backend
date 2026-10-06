const http = require('http');
const https = require('https');
const { URL } = require('url');

const HIS_ENDPOINT = process.env.HIS_SOAP_ENDPOINT ||
    (process.env.HIS_WSDL_URL ? process.env.HIS_WSDL_URL.replace(/\?wsdl$/i, '') : 'http://192.168.11.15:8000/ConsisWebService/ServiceHis.svc');
const HIS_SOAP_ACTION = 'http://tempuri.org/IHisService/HisTransData';
const HIS_OPSYSTEM = process.env.HIS_OPSYSTEM || 'HIS';
const HIS_OPTYPE = process.env.HIS_OPTYPE || '201';
const HIS_TIMEOUT_MS = Number(process.env.HIS_TIMEOUT_MS) || 8000;


function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatHisDateTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function buildPrescDtlXml(item) {
    return [
        '\t\t<CONSIS_PRESC_DTLVW>',
        `\t\t\t<PRESC_NO>${escapeXml(item.prescNo)}</PRESC_NO>`,
        `\t\t\t<ITEM_NO>${escapeXml(item.itemNo)}</ITEM_NO>`,
        '\t\t\t<ADVICE_CODE></ADVICE_CODE>',
        `\t\t\t<DRUG_CODE>${escapeXml(item.drugCode)}</DRUG_CODE>`,
        '\t\t\t<DRUG_SPEC></DRUG_SPEC>',
        `\t\t\t<DRUG_NAME>${escapeXml(item.drugName)}</DRUG_NAME>`,
        '\t\t\t<FIRM_ID></FIRM_ID>',
        '\t\t\t<FIRM_NAME></FIRM_NAME>',
        '\t\t\t<PACKAGE_SPEC></PACKAGE_SPEC>',
        `\t\t\t<PACKAGE_UNITS>${escapeXml(item.unit)}</PACKAGE_UNITS>`,
        `\t\t\t<QUANTITY>${escapeXml(item.quantity)}</QUANTITY>`,
        `\t\t\t<UNIT>${escapeXml(item.unit)}</UNIT>`,
        '\t\t\t<COSTS>0</COSTS>',
        '\t\t\t<PAYMENTS>0</PAYMENTS>',
        `\t\t\t<DOSAGE>${escapeXml(item.dosage)}</DOSAGE>`,
        `\t\t\t<DOSAGE_UNITS>${escapeXml(item.dosageUnit)}</DOSAGE_UNITS>`,
        `\t\t\t<ADMINISTRATION>${escapeXml(item.administration)}</ADMINISTRATION>`,
        `\t\t\t<FREQUENCY>${escapeXml(item.frequency)}</FREQUENCY>`,
        '\t\t\t<ADDITIONUSAGE></ADDITIONUSAGE>',
        '\t\t\t<RCPT_REMARK></RCPT_REMARK>',
        '\t\t</CONSIS_PRESC_DTLVW>',
    ].join('\n');
}

function buildPrescMstXml(header, items) {
    const dtl = items.map((item) => buildPrescDtlXml(item)).join('\n');
    return [
        '\t<CONSIS_PRESC_MSTVW>',
        `\t\t<PRESC_DATE>${escapeXml(header.prescDate)}</PRESC_DATE>`,
        `\t\t<PRESC_NO>${escapeXml(header.prescNo)}</PRESC_NO>`,
        '\t\t<DISPENSARY>01</DISPENSARY>',
        `\t\t<PATIENT_ID>${escapeXml(header.patientId)}</PATIENT_ID>`,
        `\t\t<PATIENT_NAME>${escapeXml(header.patientName)}</PATIENT_NAME>`,
        '\t\t<INVOICE_NO></INVOICE_NO>',
        '\t\t<PATIENT_TYPE></PATIENT_TYPE>',
        `\t\t<DATE_OF_BIRTH>${escapeXml(header.dob)}</DATE_OF_BIRTH>`,
        `\t\t<SEX>${escapeXml(header.sex)}</SEX>`,
        '\t\t<PRESC_IDENTITY></PRESC_IDENTITY>',
        '\t\t<CHARGE_TYPE></CHARGE_TYPE>',
        '\t\t<PRESC_ATTR></PRESC_ATTR>',
        '\t\t<PRESC_INFO></PRESC_INFO>',
        '\t\t<RCPT_INFO></RCPT_INFO>',
        '\t\t<RCPT_REMARK></RCPT_REMARK>',
        '\t\t<REPETITION>0</REPETITION>',
        '\t\t<COSTS>0</COSTS>',
        '\t\t<PAYMENTS>0</PAYMENTS>',
        `\t\t<ORDERED_BY>${escapeXml(header.orderedBy)}</ORDERED_BY>`,
        `\t\t<ORDERED_BY_NAME>${escapeXml(header.orderedByName)}</ORDERED_BY_NAME>`,
        `\t\t<PRESCRIBED_BY>${escapeXml(header.orderedByName)}</PRESCRIBED_BY>`,
        `\t\t<ENTERED_BY>${escapeXml(header.enteredBy)}</ENTERED_BY>`,
        '\t\t<DISPENSE_PRI>0</DISPENSE_PRI>',
        dtl,
        '\t</CONSIS_PRESC_MSTVW>',
    ].join('\n');
}

function buildHisTransXml({ opManNo, opManName, prescriptions }) {
    const body = prescriptions.map((p) => buildPrescMstXml(p.header, p.items)).join('\n');
    return [
        '<ROOT>',
        `\t<OPSYSTEM>${escapeXml(HIS_OPSYSTEM)}</OPSYSTEM>`,
        '\t<OPWINID></OPWINID>',
        `\t<OPTYPE>${escapeXml(HIS_OPTYPE)}</OPTYPE>`,
        '\t<OPIP></OPIP>',
        `\t<OPMANNO>${escapeXml(opManNo)}</OPMANNO>`,
        `\t<OPMANNAME>${escapeXml(opManName)}</OPMANNAME>`,
        body,
        '</ROOT>',
    ].join('\n');
}

function buildSoapEnvelope(xmlValue) {
    const safeXmlValue = String(xmlValue ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://tempuri.org/">',
        '  <soap:Body>',
        '    <tns:HisTransData>',
        '      <tns:value><![CDATA[',
        safeXmlValue,
        ']]></tns:value>',
        '    </tns:HisTransData>',
        '  </soap:Body>',
        '</soap:Envelope>',
    ].join('\n');
}

function extractSoapResult(responseText) {
    const match = responseText.match(/<[^:>]*:?HisTransDataResult[^>]*>([\s\S]*?)<\/[^:>]*:?HisTransDataResult>/);
    return match ? match[1] : null;
}

async function sendHisTransData(xmlValue) {
    const envelope = buildSoapEnvelope(xmlValue);
    const targetUrl = new URL(HIS_ENDPOINT);
    const bodyBuffer = Buffer.from(envelope, 'utf8');
    const client = targetUrl.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const options = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': `"${HIS_SOAP_ACTION}"`,
                'Content-Length': bodyBuffer.length,
            },
            timeout: HIS_TIMEOUT_MS,
        };

        const req = client.request(options, (res) => {
            let responseText = '';
            res.on('data', (chunk) => { responseText += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HIS service responded with HTTP ${res.statusCode}: ${responseText.slice(0, 500)}`));
                }
                resolve({
                    result: extractSoapResult(responseText),
                    raw: responseText,
                });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`HIS service request timed out after ${HIS_TIMEOUT_MS}ms`));
        });

        req.on('error', (err) => {
            reject(new Error(`HIS service network error: ${err.message}`));
        });

        req.write(bodyBuffer);
        req.end();
    });
}

module.exports = {
    buildHisTransXml,
    sendHisTransData,
    formatHisDateTime,
    escapeXml,
};
