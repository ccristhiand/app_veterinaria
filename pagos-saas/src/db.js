'use strict';

const mysql = require('mysql2/promise');

const masterPool = mysql.createPool({
  host              : process.env.MASTER_DB_HOST     || 'localhost',
  port              : process.env.MASTER_DB_PORT     || 3306,
  user              : process.env.MASTER_DB_USER     || 'vetnetcodip',
  password          : process.env.MASTER_DB_PASS     || '',
  database          : process.env.MASTER_DB_NAME     || 'vet_master',
  waitForConnections: true,
  connectionLimit   : 10,
  timezone          : '-05:00',
});

async function query(sql, params = []) {
  const [rows] = await masterPool.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function withTransaction(fn) {
  const conn = await masterPool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// Generar número de cobro único: VN-2026-0001
async function generarNumeroCobro() {
  const anio  = new Date().getFullYear();
  const [last] = await query(
    `SELECT numero_cobro FROM saas_cobros
     WHERE numero_cobro LIKE ? ORDER BY id DESC LIMIT 1`,
    [`VN-${anio}-%`]
  );
  const siguiente = last
    ? parseInt(last.numero_cobro.split('-')[2]) + 1
    : 1;
  return `VN-${anio}-${String(siguiente).padStart(4, '0')}`;
}

// Generar número de comprobante de pago: VNP-2026-0001
async function generarNumeroComprobante() {
  const anio  = new Date().getFullYear();
  const [last] = await query(
    `SELECT numero_comprobante FROM saas_pagos
     WHERE numero_comprobante LIKE ? ORDER BY id DESC LIMIT 1`,
    [`VNP-${anio}-%`]
  );
  const siguiente = last
    ? parseInt(last.numero_comprobante.split('-')[2]) + 1
    : 1;
  return `VNP-${anio}-${String(siguiente).padStart(4, '0')}`;
}

module.exports = { masterPool, query, queryOne, withTransaction, generarNumeroCobro, generarNumeroComprobante };