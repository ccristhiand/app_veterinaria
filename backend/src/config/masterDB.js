'use strict';
const mysql  = require('mysql2/promise');
const logger = require('./logger');

const masterPool = mysql.createPool({
  host    : process.env.MASTER_DB_HOST || 'localhost',
  port    : parseInt(process.env.MASTER_DB_PORT || '3306'),
  user    : process.env.MASTER_DB_USER || 'root',
  password: process.env.MASTER_DB_PASS || '',
  database: process.env.MASTER_DB_NAME || 'vet_master',
  waitForConnections   : true,
  connectionLimit      : 5,
  queueLimit           : 0,
  timezone             : '+00:00',  // No convertir — fechas vienen en Lima desde nowTz()
  enableKeepAlive      : true,
  keepAliveInitialDelay: 30000,
  connectTimeout       : 10000,
});

masterPool.on('error', (err) => {
  logger.error(`Error en pool master: ${err.message}`);
});

async function masterQuery(sql, params = []) {
  try {
    const [rows] = await masterPool.execute(sql, params);
    return rows;
  } catch (err) {
    if (err.code === 'ECONNRESET' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ENOTFOUND') {
      logger.warn(`[masterDB] Reconectando tras error: ${err.code}`);
      const [rows] = await masterPool.execute(sql, params);
      return rows;
    }
    throw err;
  }
}

async function testMasterConnection() {
  const conn = await masterPool.getConnection();
  logger.info('✅ Conectado a DB maestra (vet_master)');
  conn.release();
}

module.exports = { masterPool, masterQuery, testMasterConnection };