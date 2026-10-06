const express = require('express');
const { executeMySql } = require('../db/mysqlPool');

const router = express.Router();

const RETENTION_DAYS = 2;

router.post('/insert-log', async (req, res) => {
    try {
        const { status, message, run_id } = req.body ?? {};
        if (status !== 'success' && status !== 'fail') {
            return res.status(400).json({ success: false, message: "status must be 'success' or 'fail'" });
        }

        await executeMySql(
            'INSERT INTO api_logs (timestamp, status, message, run_id) VALUES (NOW(), ?, ?, ?)',
            [status, message ?? null, run_id ?? null]
        );

        await executeMySql(
            `DELETE FROM api_logs WHERE timestamp < NOW() - INTERVAL ${RETENTION_DAYS} DAY`
        );

        res.json({ success: true, message: 'Log inserted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
