'use strict';

/**
 * VetNetcodip — wa-meta (WhatsApp Cloud API oficial de Meta)
 * v1: webhook
 *   GET  /webhook  → verificación de Meta (hub.challenge)
 *   POST /webhook  → avisos de Meta (mensajes, estados, plantillas, cuenta),
 *                    con firma X-Hub-Signature-256 comprobada y guardados en
 *                    vet_master.wa_meta_webhook_log para procesarlos.
 *   GET  /health   → estado del servicio
 *
 * Usa el .env del backend (base maestra + ENCRYPTION_KEY): no necesita .env propio.
 * La configuración de Meta (App Secret, token de verificación) se lee de
 * vet_master.saas_config, la que se guarda desde el panel admin.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../backend/.env') });

const crypto  = require('crypto');
const express = require('express');
const mysql   = require('mysql2/promise');
const { decrypt } = require('../../backend/src/services/crypto.service');

const PORT = parseInt(process.env.WA_META_PORT || '5002', 10);

// ── Base maestra ────────────────────────────────────────────────────
const master = mysql.createPool({
  host    : process.env.MASTER_DB_HOST || 'localhost',
  port    : parseInt(process.env.MASTER_DB_PORT || '3306', 10),
  user    : process.env.MASTER_DB_USER,
  password: process.env.MASTER_DB_PASS,
  database: process.env.MASTER_DB_NAME || 'vet_master',
  waitForConnections: true,
  connectionLimit   : 5,
  timezone          : '-05:00',
  enableKeepAlive   : true,
});
const q = async (sql, params = []) => (await master.execute(sql, params))[0];

const log = (...a) => console.log(new Date().toISOString(), '[wa-meta]', ...a);

// ── Configuración de Meta (cache de 60 s) ───────────────────────────
let _cfg = null, _cfgAt = 0;
async function getConfig() {
  if (_cfg && Date.now() - _cfgAt < 60000) return _cfg;
  const rows = await q(
    `SELECT clave, valor FROM saas_config
     WHERE clave IN ('meta_app_id','meta_app_secret','meta_verify_token','meta_graph_version')`
  );
  const m = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
  let appSecret = null;
  if (m.meta_app_secret) {
    try { appSecret = decrypt(m.meta_app_secret); }
    catch (e) { log('No se pudo descifrar meta_app_secret:', e.message); }
  }
  _cfg = {
    appId      : m.meta_app_id || null,
    appSecret,
    verifyToken: m.meta_verify_token || null,
    graphVer   : m.meta_graph_version || 'v25.0',
  };
  _cfgAt = Date.now();
  return _cfg;
}

// ── Tabla de avisos recibidos (se crea sola la primera vez) ─────────
async function prepararTablas() {
  await q(`CREATE TABLE IF NOT EXISTS wa_meta_webhook_log (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    recibido_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    waba_id         VARCHAR(40)   NULL,
    phone_number_id VARCHAR(40)   NULL,
    campo           VARCHAR(60)   NULL COMMENT 'messages, account_update, history...',
    tenant_id       INT UNSIGNED  NULL,
    payload         MEDIUMTEXT    NOT NULL,
    procesado       TINYINT(1)    NOT NULL DEFAULT 0,
    error           TEXT          NULL,
    INDEX idx_wl_fecha     (recibido_at),
    INDEX idx_wl_phone     (phone_number_id),
    INDEX idx_wl_procesado (procesado)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// Clínica dueña del aviso (por número o por cuenta de WhatsApp)
async function buscarTenant(phoneNumberId, wabaId) {
  if (phoneNumberId) {
    const [r] = await q('SELECT tenant_id FROM wa_meta_cuentas WHERE phone_number_id = ? LIMIT 1', [phoneNumberId]);
    if (r) return r.tenant_id;
  }
  if (wabaId) {
    const [r] = await q('SELECT tenant_id FROM wa_meta_cuentas WHERE waba_id = ? LIMIT 1', [wabaId]);
    if (r) return r.tenant_id;
  }
  return null;
}

// ── App ─────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/', (_req, res) => res.type('text').send('VetNetcodip wa-meta'));

app.get('/health', async (_req, res) => {
  try {
    await q('SELECT 1');
    const cfg = await getConfig();
    res.json({
      status: 'ok', uptime: Math.round(process.uptime()),
      config: { app_id: !!cfg.appId, app_secret: !!cfg.appSecret, verify_token: !!cfg.verifyToken },
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// 1) Verificación del webhook (Meta la hace al guardar la URL)
app.get('/webhook', async (req, res) => {
  try {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const cfg = await getConfig();

    if (mode === 'subscribe' && cfg.verifyToken && token === cfg.verifyToken) {
      log('Webhook verificado por Meta ✅');
      await q(
        `INSERT INTO saas_config (clave, valor, descripcion) VALUES ('meta_webhook_ok_at', ?, 'Última verificación del webhook por Meta')
         ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
        [new Date().toISOString()]
      ).catch(() => {});
      return res.status(200).type('text').send(String(challenge || ''));
    }
    log('Verificación rechazada (token incorrecto o falta configurar)');
    return res.sendStatus(403);
  } catch (e) {
    log('Error en verificación:', e.message);
    return res.sendStatus(500);
  }
});

// 2) Avisos de Meta — cuerpo crudo para poder comprobar la firma
app.post('/webhook', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  let cfg;
  try { cfg = await getConfig(); }
  catch (e) { log('Error leyendo config:', e.message); return res.sendStatus(500); }

  if (!cfg.appSecret) {
    log('Aviso recibido pero falta la clave secreta en el panel admin');
    return res.sendStatus(503);
  }

  const raw   = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const firma = String(req.get('x-hub-signature-256') || '');
  const esperada = 'sha256=' + crypto.createHmac('sha256', cfg.appSecret).update(raw).digest('hex');
  const valida = firma.length === esperada.length &&
                 crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
  if (!valida) {
    log('Firma inválida — aviso descartado');
    return res.sendStatus(401);
  }

  // Responder a Meta de inmediato; guardar después
  res.sendStatus(200);

  try {
    const body = JSON.parse(raw.toString('utf8'));
    for (const entry of body.entry || []) {
      for (const ch of entry.changes || []) {
        const phoneId  = ch.value?.metadata?.phone_number_id || null;
        const wabaId   = entry.id || null;
        const tenantId = await buscarTenant(phoneId, wabaId).catch(() => null);
        await q(
          `INSERT INTO wa_meta_webhook_log (waba_id, phone_number_id, campo, tenant_id, payload)
           VALUES (?,?,?,?,?)`,
          [wabaId, phoneId, ch.field || null, tenantId, JSON.stringify({ object: body.object, entry_id: entry.id, change: ch })]
        );
        log(`Aviso guardado: ${ch.field || '?'} | phone=${phoneId || '-'} | clínica=${tenantId || 'sin asignar'}`);
      }
    }
  } catch (e) {
    log('Error guardando aviso:', e.message);
  }
});

// ── Arranque ────────────────────────────────────────────────────────
(async () => {
  try {
    await prepararTablas();
    app.listen(PORT, '127.0.0.1', () => log(`Escuchando en 127.0.0.1:${PORT}`));
  } catch (e) {
    log('No se pudo iniciar:', e.message);
    process.exit(1);
  }
})();