const sql = require('mssql');
const dbConfig = require('../config/db');

const pool = new sql.ConnectionPool(dbConfig);
const poolConnect = pool.connect();

module.exports = {
    sql,
    pool,
    poolConnect
};