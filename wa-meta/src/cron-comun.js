'use strict';

/**
 * VetNetcodip — wa-meta: utilidades compartidas por los procesos de envío por Meta
 * (wa-meta-recordatorios y wa-meta-campanas). No usan nada de wa-gateway (QR / Baileys):
 * envían solo por el servidor interno de wa-meta (127.0.0.1:5003).
 *
 * Usa el .env del backend, igual que wa-meta.js (así la clave interna es la misma en ambos lados).
 */

const path  = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../backend/.env') });

const http  = require('http');
const mysql = require('mysql2/promise');

const INTERNAL_KEY    = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';
const WA_META_INTERNO = process.env.WA_META_INTERNAL_URL || `http://127.0.0.1:${process.env.WA_META_INTERNAL_PORT || 5003}`;

const masterPool = mysql.createPool({
  host    : process.env.MASTER_DB_HOST || 'localhost',
  port    : parseInt(process.env.MASTER_DB_PORT || '3306', 10),
  user    : process.env.MASTER_DB_USER,
  password: process.env.MASTER_DB_PASS,
  database: process.env.MASTER_DB_NAME || 'vet_master',
  connectionLimit: 3,
});

async function masterQuery(sql, params = []) {
  const [rows] = await masterPool.execute(sql, params);
  return rows;
}

const TZ_OFFSETS = {
  'America/Lima'                   : '-05:00',
  'America/Bogota'                 : '-05:00',
  'America/Guayaquil'              : '-05:00',
  'America/Mexico_City'            : '-06:00',
  'America/Santiago'               : '-04:00',
  'America/Argentina/Buenos_Aires' : '-03:00',
  'America/Caracas'                : '-04:00',
  'America/La_Paz'                 : '-04:00',
  'America/Asuncion'               : '-04:00',
  'America/Montevideo'             : '-03:00',
  'America/Panama'                 : '-05:00',
  'America/Guatemala'              : '-06:00',
  'America/New_York'               : '-05:00',
  'America/Chicago'                : '-06:00',
  'America/Denver'                 : '-07:00',
  'America/Los_Angeles'            : '-08:00',
  'Europe/Madrid'                  : '+01:00',
};

async function getTenantConn(t) {
  return mysql.createConnection({
    host    : t.db_host,
    port    : t.db_port || 3306,
    user    : t.db_user,
    password: t.db_pass,
    database: t.db_name,
    timezone: TZ_OFFSETS[t.zona_horaria] || '-05:00',
  });
}

// Clínicas que envían por Meta: cuenta conectada y pantalla Meta habilitada por el admin SaaS
// (wa-gateway excluye estas mismas clínicas de sus recordatorios por QR)
const SQL_TENANTS_META = `
  SELECT t.id, t.slug, t.db_host, t.db_port, t.db_user, t.db_pass, t.db_name,
         tc.nombre_clinica, tc.telefono AS tel_clinica, tc.zona_horaria
  FROM tenants t
  JOIN tenant_config tc     ON tc.tenant_id  = t.id
  JOIN wa_config_global wcg ON wcg.tenant_id = t.id
  JOIN wa_meta_cuentas wmc  ON wmc.tenant_id = t.id
  WHERE t.activo = 1 AND wcg.activo = 1 AND COALESCE(wcg.ver_meta, 0) = 1 AND wmc.estado = 'conectado'`;

/**
 * Envía una plantilla por wa-meta (POST /interno/enviar-plantilla).
 * Nunca lanza: devuelve { success, message, reintentar }.
 */
function enviarPlantilla(body) {
  return new Promise(resolve => {
    const bodyStr = JSON.stringify(body);
    const url     = new URL(WA_META_INTERNO + '/interno/enviar-plantilla');
    const req = http.request({
      hostname: url.hostname, port: parseInt(url.port, 10) || 5003, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY, 'Content-Length': Buffer.byteLength(bodyStr) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(data); } catch { j = { success: false, message: `wa-meta respondió ${res.statusCode}`, reintentar: true }; }
        resolve({ status: res.statusCode, ...j });
      });
    });
    req.on('error', e => resolve({ success: false, message: 'wa-meta no responde: ' + e.message, reintentar: true }));
    req.setTimeout(20000, () => req.destroy(new Error('Timeout wa-meta')));
    req.write(bodyStr);
    req.end();
  });
}

function fDate(d, tz) {
  return new Date(d).toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric', timeZone: tz || 'America/Lima' });
}

function fHora(d, tz) {
  return new Date(d).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: tz || 'America/Lima' });
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

module.exports = { masterQuery, getTenantConn, SQL_TENANTS_META, enviarPlantilla, fDate, fHora, esperar };
