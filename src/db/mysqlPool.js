const mysql = require('mysql2/promise');
const mysqlConfig = require('../config/mysql');

let pool;

function getMySqlPool() {
    if (!mysqlConfig.database) {
        throw new Error('MySQL is not configured. Set MYSQL_DATABASE or MYSQL_DB_NAME.');
    }

    if (!pool) {
        pool = mysql.createPool(mysqlConfig);
    }

    return pool;
}

async function executeMySql(query, params = []) {
    const [rows] = await getMySqlPool().execute(query, params);
    return rows;
}

module.exports = {
    getMySqlPool,
    executeMySql
};
