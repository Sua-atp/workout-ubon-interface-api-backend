const fs = require('fs');
const path = require('path');
const soap = require('soap');

const HIS_WSDL_URL = process.env.HIS_WSDL_URL || 'http://192.168.11.15:8000/ConsisWebService/ServiceHis.svc?wsdl';
const HIS_XML_OUTPUT_DIR = process.env.HIS_XML_OUTPUT_DIR || path.join(__dirname, '../../his-xml-log');

let clientPromise = null;

function getHisClient() {
    if (!clientPromise) {
        clientPromise = soap.createClientAsync(HIS_WSDL_URL);
    }
    return clientPromise;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function pad3(n) {
    return String(n).padStart(3, '0');
}

function formatFilenameTimestamp(date) {
    return `${pad2(date.getFullYear() % 100)}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
        `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}${pad3(date.getMilliseconds())}`;
}

function saveXmlLog(methodName, requestXml, responseXml) {
    const dir = path.join(HIS_XML_OUTPUT_DIR, methodName);
    fs.mkdirSync(dir, { recursive: true });

    const timestamp = formatFilenameTimestamp(new Date());
    if (requestXml) {
        fs.writeFileSync(path.join(dir, `${timestamp}_request.xml`), requestXml, 'utf8');
    }
    if (responseXml) {
        fs.writeFileSync(path.join(dir, `${timestamp}_response.xml`), responseXml, 'utf8');
    }
}

async function callHisMethod(methodName, args) {
    const client = await getHisClient();
    const asyncMethodName = `${methodName}Async`;

    if (typeof client[asyncMethodName] !== 'function') {
        throw new Error(`SOAP method "${methodName}" not found on ServiceHis client`);
    }

    try {
        const [result] = await client[asyncMethodName](args);
        saveXmlLog(methodName, client.lastRequest, client.lastResponse);
        return result;
    } catch (error) {
        saveXmlLog(methodName, client.lastRequest, client.lastResponse);
        throw error;
    }
}

module.exports = {
    getHisClient,
    callHisMethod
};
