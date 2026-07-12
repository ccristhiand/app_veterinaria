'use strict';

const mysql  = require('mysql2/promise');
const logger = require('./logger');

// ── Pool de conexiones ───────────────────────────────────────────────────────
const pool = mysql.createPool({
  host              : process.env.DB_HOST     || 'localhost',
  port              : parseInt(process.env.DB_PORT || '3306', 10),
  user              : process.env.DB_USER     || 'root',
  password          : process.env.DB_PASSWORD || '',
  database          : process.env.DB_NAME     || 'vet_system',
  waitForConnections: true,
  connectionLimit   : parseInt(process.env.DB_POOL_MAX  || '10', 10),
  queueLimit        : 0,
  idleTimeout       : parseInt(process.env.DB_POOL_IDLE || '10000', 10),
  timezone          : '+00:00',
  charset           : 'utf8mb4',
  decimalNumbers    : true,
});

/**
 * Verifica la conexión al iniciar la aplicación.
 * Lanza una excepción si no puede conectarse (falla fast al boot).
 */
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    logger.info('✅  MySQL conectado correctamente');
    conn.release();
  } catch (err) {
    logger.error('❌  Error conectando a MySQL:', err.message);
    throw err;
  }
}

/**
 * Helper para ejecutar queries con parámetros de forma segura.
 * @param {string}  sql    - Query SQL con placeholders (?)
 * @param {Array}   params - Parámetros de la query
 * @returns {Promise<Array>} rows
 */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * Helper para transacciones.
 * Ejecuta `fn(connection)` dentro de BEGIN/COMMIT.
 * Si `fn` lanza, hace ROLLBACK automático.
 */
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, testConnection, query, withTransaction };
