'use strict';
// Configuración via variables de entorno (.env)
// DESARROLLO: MASTER_DB_HOST=161.132.39.207, MASTER_DB_USER=cadc
// PRODUCCIÓN: configurar en .env del VPS

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
  timezone             : 'Z',
  // ── Prevenir ECONNRESET por conexiones idle ──────────────────
  enableKeepAlive      : true,
  keepAliveInitialDelay: 30000,   // 30 seg antes del primer keepalive
  connectTimeout       : 10000,   // 10 seg timeout de conexión
});

// Manejar errores del pool sin crashear el servidor
masterPool.on('error', (err) => {
  logger.error(`Error en pool master: ${err.message}`);
});

async function masterQuery(sql, params = []) {
  try {
    const [rows] = await masterPool.execute(sql, params);
    return rows;
  } catch (err) {
    // Si la conexión se perdió, reintentar una vez
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