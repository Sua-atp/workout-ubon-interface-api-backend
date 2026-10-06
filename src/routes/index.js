const express = require('express');
const { getMySqlPool } = require('../db/mysqlPool');
const { resolveClientInfo } = require('../utils/clientInfo');
const msUsersRoutes = require('./ms_users');
const prescriptionRoutes = require('./prescription');
const packageMasterRoutes = require('./packagemaster');
const msSettingsRoutes = require('./ms_settings');
const transferRoutes = require('./transfer');
const apiLogsRoutes = require('./apiLogs');

const router = express.Router();
router.use(transferRoutes);

router.get('/', (req, res) => {
    res.json({
        message: 'MySQL API is running',
        database: process.env.MYSQL_DATABASE || null
    });
});

router.get('/health', async (req, res) => {
    try {
        const pool = getMySqlPool();
        await pool.query('SELECT 1 AS ok');
        res.json({ status: 'ok' });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

router.get('/api/client-info', async (req, res) => {
    try {
        const clientInfo = await resolveClientInfo(req);
        res.json({
            success: true,
            data: clientInfo
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.get('/api/db-test', async (req, res) => {
    try {
        const pool = getMySqlPool();
        const [rows] = await pool.query('SELECT DATABASE() AS database_name, NOW() AS server_time');
        res.json({
            success: true,
            data: rows[0]
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

const http = require('http');
const fs = require('fs');
const path = require('path');

router.post('/api/his-proxy', (req, res) => {
    try {
        const xmlData = req.body.xml;
        if (!xmlData) {
            return res.status(400).json({ error: 'No XML data provided' });
        }

        // --- Save XML to log folder ---
        try {
            const logDir = path.join(__dirname, '../../logs/xml');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            // Try to extract patient ID or prescription NO to make the file name more meaningful, if possible
            const prescMatch = xmlData.match(/<PRESC_NO>(.*?)<\/PRESC_NO>/);
            const prescNo = prescMatch ? prescMatch[1] : 'Unknown';
            const fileName = `HIS_${prescNo}_${timestamp}.xml`;

            fs.writeFileSync(path.join(logDir, fileName), xmlData, 'utf8');
        } catch (logErr) {
            console.error('Failed to write HIS XML log:', logErr.message);
        }
        // ------------------------------

        const options = {
            hostname: '192.168.11.15',
            port: 8000,
            path: '/ConsisWebService/ServiceHis.svc',
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': '"http://tempuri.org/IHisService/HisTransData"',
                'Content-Length': Buffer.byteLength(xmlData)
            },
            timeout: Number(process.env.HIS_TIMEOUT_MS) || 15000
        };

        const proxyReq = http.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => { data += chunk; });
            proxyRes.on('end', () => {
                res.status(proxyRes.statusCode || 200).send(data);
            });
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy(new Error(`HIS service request timed out after ${options.timeout}ms`));
        });

        proxyReq.on('error', (e) => {
            console.error('HIS Proxy Error:', e.message);
            res.status(500).json({ error: 'Failed to contact HIS server', details: e.message });
        });

        proxyReq.write(xmlData);
        proxyReq.end();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/api/medauto-proxy/auth/login', (req, res) => {
    try {
        const payload = JSON.stringify(req.body || {});
        const options = {
            hostname: '192.168.19.63',
            port: 8094,
            path: '/api/auth/login',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const proxyReq = http.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => { data += chunk; });
            proxyRes.on('end', () => {
                res.status(proxyRes.statusCode || 200);
                try {
                    res.json(JSON.parse(data));
                } catch {
                    res.send(data);
                }
            });
        });

        proxyReq.on('error', (e) => {
            console.error('MedAuto Login Proxy Error:', e.message);
            res.status(500).json({ success: false, message: 'เชื่อมต่อ 192.168.19.63:8094 ไม่สำเร็จ: ' + e.message });
        });

        proxyReq.write(payload);
        proxyReq.end();
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/api/medauto-proxy/prescriptions', (req, res) => {
    try {
        const payload = JSON.stringify(req.body || {});
        const options = {
            hostname: '192.168.19.63',
            port: 8094,
            path: '/api/prescriptions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        if (req.headers.authorization) {
            options.headers['Authorization'] = req.headers.authorization;
        }

        const proxyReq = http.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => { data += chunk; });
            proxyRes.on('end', () => {
                res.status(proxyRes.statusCode || 200);
                try {
                    res.json(JSON.parse(data));
                } catch {
                    res.send(data);
                }
            });
        });

        proxyReq.on('error', (e) => {
            console.error('MedAuto Prescriptions Proxy Error:', e.message);
            res.status(500).json({ success: false, message: 'เชื่อมต่อ 192.168.19.63:8094 ไม่สำเร็จ: ' + e.message });
        });

        proxyReq.write(payload);
        proxyReq.end();
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/api/medauto-proxy/prescriptions', (req, res) => {
    try {
        const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
        const options = {
            hostname: '192.168.19.63',
            port: 8094,
            path: `/api/prescriptions${queryString}`,
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        };
        if (req.headers.authorization) {
            options.headers['Authorization'] = req.headers.authorization;
        }

        const proxyReq = http.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => { data += chunk; });
            proxyRes.on('end', () => {
                res.status(proxyRes.statusCode || 200);
                try {
                    res.json(JSON.parse(data));
                } catch {
                    res.send(data);
                }
            });
        });

        proxyReq.on('error', (e) => {
            console.error('MedAuto Prescriptions GET Proxy Error:', e.message);
            res.status(500).json({ success: false, message: 'เชื่อมต่อ 192.168.19.63:8094 ไม่สำเร็จ: ' + e.message });
        });

        proxyReq.end();
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.use(msUsersRoutes);
router.use(prescriptionRoutes);
router.use(packageMasterRoutes);
router.use(msSettingsRoutes);
router.use(apiLogsRoutes);

module.exports = router;