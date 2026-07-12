'use strict';

const mysql  = require('mysql2/promise');
const logger = require('./logger');

// Cache de pools: { dbName: pool }
const poolCache = new Map();

/**
 * Obtiene (o crea) un pool de conexiones para un tenant específico.
 * Usa caché para no crear pools nuevos en cada request.
 */
function getPoolForTenant(tenant) {
  const key = tenant.db_name;

  if (poolCache.has(key)) {
    return poolCache.get(key);
  }

  logger.info(`🔗 Creando pool para tenant: ${tenant.slug} (${key})`);

  const pool = mysql.createPool({
    host    : tenant.db_host || process.env.DB_HOST || 'localhost',
    port    : tenant.db_port || parseInt(process.env.DB_PORT || '3306'),
    user    : tenant.db_user || process.env.DB_USER || 'root',
    password: tenant.db_pass || process.env.DB_PASS || '',
    database: key,
    waitForConnections: true,
    connectionLimit   : 10,
    queueLimit        : 50,
    timezone          : 'Z',
    // Reconexión automática
    enableKeepAlive   : true,
    keepAliveInitialDelay: 30000,
  });

  // Manejar errores del pool sin crashear
  pool.on('error', (err) => {
    logger.error(`Error en pool de ${key}: ${err.message}`);
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
      poolCache.delete(key);
    }
  });

  poolCache.set(key, pool);
  return pool;
}

/**
 * Helper query para usar en controladores/rutas:
 * await req.db.query(sql, params)
 */
function createDBHelper(pool) {
  return {
    async query(sql, params = []) {
      const [rows] = await pool.execute(sql, params);
      return rows;
    },
    async withTransaction(fn) {
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
    },
  };
}

/**
 * Elimina el pool de un tenant del caché (útil si cambia la config).
 */
function evictTenantPool(dbName) {
  if (poolCache.has(dbName)) {
    const pool = poolCache.get(dbName);
    pool.end();
    poolCache.delete(dbName);
    logger.info(`Pool de ${dbName} eliminado del caché`);
  }
}

/**
 * Estadísticas de pools activos (para el panel admin).
 */
function getPoolStats() {
  const stats = [];
  for (const [dbName, pool] of poolCache.entries()) {
    stats.push({
      dbName,
      total    : pool.pool?._allConnections?.length || 0,
      free     : pool.pool?._freeConnections?.length || 0,
      queue    : pool.pool?._connectionQueue?.length || 0,
    });
  }
  return stats;
}

module.exports = { getPoolForTenant, createDBHelper, evictTenantPool, getPoolStats };