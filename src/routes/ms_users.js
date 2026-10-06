const express = require('express');
const multer = require('multer');
const { executeMySql } = require('../db/mysqlPool');

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
const userColumns = [
    'fullname',
    'positioncode',
    'userbarcode',
    'username',
    'password',
    'photo',
    'adminid',
    'pathphoto',
    'wardcode',
    'roomcode',
    'firstname',
    'lastname',
    'departmentcode'
];
const userSelectQuery = `
      SELECT
        ms_users.userID,
        ms_users.fullname,
        ms_users.positioncode,
        ms_users.userbarcode,
        ms_users.username,
        ms_users.password,
        ms_users.photo,
        ms_users.adminid,
        ms_users.pathphoto,
        ms_users.wardcode,
        ms_users.roomcode,
        ms_users.firstname,
        ms_users.lastname,
        ms_users.departmentcode
      FROM ms_users
`;

function getUserValues(payload, includeUserId = false) {
    const values = [];

    if (includeUserId) {
        values.push(payload.userID);
    }

    for (const column of userColumns) {
        values.push(payload[column] ?? null);
    }

    return values;
}

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

router.post('/api/users', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const conditions = [];
        const params = [];
        const isLoginAttempt = Boolean(payload.username && payload.password);

        if (payload.username) {
            conditions.push('ms_users.username = ?');
            params.push(payload.username);
        }

        if (payload.password) {
            conditions.push('ms_users.password = ?');
            params.push(payload.password);
        }

        if (payload.userbarcode) {
            conditions.push('ms_users.userbarcode = ?');
            params.push(payload.userbarcode);
        }

        if (payload.userID) {
            conditions.push('ms_users.userID = ?');
            params.push(payload.userID);
        }

        const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
        const result = await executeMySql(`${userSelectQuery}${whereClause}`, params);

        if (isLoginAttempt && result.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or password'
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

router.post('/api/users/:userID', uploadJsonFile, async (req, res) => {
    try {
        const payload = getJsonPayload(req);
        const userID = payload.userID || req.params.userID;

        if (!userID) {
            return res.status(400).json({
                success: false,
                message: 'userID is required'
            });
        }

        const result = await executeMySql(`${userSelectQuery} WHERE ms_users.userID = ?`, [userID]);

        if (result.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        return res.json({
            success: true,
            data: result[0]
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/api/users/create', async (req, res) => {
    const { userID } = req.body;

    if (!userID) {
        return res.status(400).json({
            success: false,
            message: 'userID is required'
        });
    }

    try {
        const values = getUserValues(req.body, true);

        await executeMySql(`
      INSERT INTO ms_users (
        userID,
        fullname,
        positioncode,
        userbarcode,
        username,
        password,
        photo,
        adminid,
        pathphoto,
        wardcode,
        roomcode,
        firstname,
        lastname,
        departmentcode
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `, values);

        return res.status(201).json({
            success: true,
            message: 'User created successfully'
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.put('/api/users/:userID', async (req, res) => {
    try {
        const values = getUserValues(req.body);
        values.push(req.params.userID);

        const result = await executeMySql(`
      UPDATE ms_users
      SET
        fullname = ?,
        positioncode = ?,
        userbarcode = ?,
        username = ?,
        password = ?,
        photo = ?,
        adminid = ?,
        pathphoto = ?,
        wardcode = ?,
        roomcode = ?,
        firstname = ?,
        lastname = ?,
        departmentcode = ?
      WHERE userID = ?
    `, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        return res.json({
            success: true,
            message: 'User updated successfully'
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.delete('/api/users/:userID', async (req, res) => {
    try {
        const result = await executeMySql(`
        DELETE FROM ms_users
        WHERE userID = ?
      `, [req.params.userID]);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        return res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;