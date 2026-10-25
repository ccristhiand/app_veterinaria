'use strict';

/**
 * VetNetcodip — wa-meta (WhatsApp Cloud API oficial de Meta)
 * v2:
 *   Público (wameta.netcodip.com → 127.0.0.1:5002)
 *     GET  /webhook  → verificación de Meta (hub.challenge)
 *     POST /webhook  → avisos de Meta con firma X-Hub-Signature-256 comprobada;
 *                      se guardan en vet_master.wa_meta_webhook_log y se procesan:
 *                        · plantilla aprobada / rechazada / pausada  → wa_meta_plantillas
 *                        · mensaje enviado / entregado / leído / fallido → wa_mensajes_log
 *     GET  /health
 *   Interno (solo 127.0.0.1:5003, no pasa por Nginx)
 *     POST /interno/enviar-plantilla → lo usan wa-recordatorios y wa-campanas
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

const PORT          = parseInt(process.env.WA_META_PORT || '5002', 10);
const PORT_INTERNO  = parseInt(process.env.WA_META_INTERNAL_PORT || '5003', 10);
const INTERNAL_KEY  = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';
const GRAPH_BASE    = (process.env.META_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');

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

// ── Base de cada clínica (pool pequeño por clínica) ─────────────────
const pools = new Map();
async function tenantDB(tenantId) {
  if (pools.has(tenantId)) return pools.get(tenantId);
  const [t] = await q('SELECT db_host, db_port, db_user, db_pass, db_name FROM tenants WHERE id = ?', [tenantId]);
  if (!t) throw new Error('Clínica no encontrada: ' + tenantId);
  const pool = mysql.createPool({
    host: t.db_host, port: t.db_port || 3306, user: t.db_user, password: t.db_pass, database: t.db_name,
    connectionLimit: 2, waitForConnections: true, timezone: '-05:00', enableKeepAlive: true,
  });
  pools.set(tenantId, pool);
  return pool;
}
const tq = async (tenantId, sql, params = []) => (await (await tenantDB(tenantId)).execute(sql, params))[0];

// ── Procesar un aviso de Meta ───────────────────────────────────────
const ESTADO_PLANTILLA = {
  APPROVED: 'aprobada', PENDING: 'pendiente', IN_APPEAL: 'pendiente', REJECTED: 'rechazada', PAUSED: 'pausada',
  DISABLED: 'deshabilitada', FLAGGED: 'pausada', PENDING_DELETION: 'deshabilitada', DELETED: 'deshabilitada',
  REINSTATED: 'aprobada', LIMIT_EXCEEDED: 'deshabilitada',
};
const ESTADO_MENSAJE = { sent: 'enviado', delivered: 'entregado', read: 'leido', failed: 'fallido' };
const RANGO_MENSAJE  = { pendiente: 0, enviado: 1, entregado: 2, leido: 3, fallido: 4 };

// Devuelve el valor de "procesado": 1 = listo, 2 = mensaje entrante (para la bandeja)
async function procesarCambio(tenantId, campo, v) {
  if (!tenantId) return 0;

  if (campo === 'message_template_status_update') {
    const estado = ESTADO_PLANTILLA[String(v.event || '').toUpperCase()];
    if (!estado) return 1;
    const motivo = estado === 'rechazada' || estado === 'pausada' || estado === 'deshabilitada'
      ? (v.reason && v.reason !== 'NONE' ? String(v.reason) : (v.other_info?.title || null)) : null;
    await tq(tenantId,
      `UPDATE wa_meta_plantillas SET estado = ?, motivo_rechazo = ?, activo = IF(? = 'DELETED', 0, activo)
       WHERE meta_template_id = ? OR (nombre_meta = ? AND idioma = ?)`,
      [estado, motivo, String(v.event || '').toUpperCase(), String(v.message_template_id || ''),
       String(v.message_template_name || ''), String(v.message_template_language || 'es')]);
    log(`Plantilla ${v.message_template_name} → ${estado} (clínica ${tenantId})`);
    return 1;
  }

  if (campo === 'template_category_update') {
    const cat = String(v.new_category || '').toUpperCase();
    if (['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(cat)) {
      await tq(tenantId, 'UPDATE wa_meta_plantillas SET categoria = ? WHERE meta_template_id = ?', [cat, String(v.message_template_id || '')]);
    }
    return 1;
  }

  if (campo === 'messages') {
    for (const st of v.statuses || []) {
      const estado = ESTADO_MENSAJE[st.status];
      if (!estado || !st.id) continue;
      const err = st.errors?.[0];
      const detalle = err ? `(${err.code}) ${err.error_data?.details || err.message || err.title || ''}`.trim() : null;
      await tq(tenantId,
        `UPDATE wa_mensajes_log SET estado = ?, error = COALESCE(?, error)
         WHERE wamid = ? AND (CASE estado WHEN 'pendiente' THEN 0 WHEN 'enviado' THEN 1 WHEN 'entregado' THEN 2
                                          WHEN 'leido' THEN 3 WHEN 'fallido' THEN 4 ELSE 0 END) < ?`,
        [estado, detalle, st.id, RANGO_MENSAJE[estado]]);
    }
    if ((v.messages || []).length) return 2;   // mensaje del cliente: se guarda para la bandeja
    return 1;
  }

  return 1;   // account_update, history, smb_*: quedan guardados en el log
}

async function procesarFila(fila, campo, valor) {
  try {
    const p = await procesarCambio(fila.tenant_id, campo, valor);
    if (p) await q('UPDATE wa_meta_webhook_log SET procesado = ?, error = NULL WHERE id = ?', [p, fila.id]);
  } catch (e) {
    await q('UPDATE wa_meta_webhook_log SET error = ? WHERE id = ?', [String(e.message).slice(0, 1000), fila.id]).catch(() => {});
    log(`Error procesando aviso #${fila.id}: ${e.message}`);
  }
}

// Reintento de avisos pendientes (p. ej. llegaron antes de que la clínica terminara de conectarse)
async function barrerPendientes() {
  try {
    const filas = await q(
      `SELECT id, tenant_id, phone_number_id, waba_id, campo, payload FROM wa_meta_webhook_log
       WHERE procesado = 0 AND recibido_at < NOW() - INTERVAL 1 MINUTE AND recibido_at > NOW() - INTERVAL 3 DAY
       ORDER BY id LIMIT 100`);
    for (const f of filas) {
      if (!f.tenant_id) {
        f.tenant_id = await buscarTenant(f.phone_number_id, f.waba_id).catch(() => null);
        if (!f.tenant_id) continue;
        await q('UPDATE wa_meta_webhook_log SET tenant_id = ? WHERE id = ?', [f.tenant_id, f.id]);
      }
      let ch = {};
      try { ch = JSON.parse(f.payload).change || {}; } catch { /* payload dañado */ }
      await procesarFila(f, f.campo, ch.value || {});
    }
  } catch (e) { log('Error barriendo avisos:', e.message); }
}

// ── Envío de plantillas (para recordatorios y campañas) ──────────────
const REINTENTABLES = new Set([130429, 131056, 131048, 131000, 131016, 133004, 80007, 1, 2]);

function normalizarTelefono(tel, codigoPais) {
  let t = String(tel || '').replace(/\D/g, '');
  if (!t) return null;
  if (t.startsWith('00')) t = t.slice(2);
  if (t.length === 9) t = String(codigoPais || '51').replace(/\D/g, '') + t;
  else if (t.length === 10 && t.startsWith('0')) t = String(codigoPais || '51').replace(/\D/g, '') + t.slice(1);
  return t.length >= 10 && t.length <= 15 ? t : null;
}
const limpiarVariable = v => String(v ?? '').replace(/[\n\t\r]+/g, ' ').replace(/ {4,}/g, '   ').trim();

async function registrarLog(tenantId, d) {
  const enviado = d.estado === 'enviado';
  try {
    await tq(tenantId,
      `INSERT INTO wa_mensajes_log (tipo, campana_id, propietario_id, telefono, mensaje, estado, error, enviado_at, proveedor, wamid)
       VALUES (?,?,?,?,?,?,?,${enviado ? 'NOW()' : 'NULL'},'meta',?)`,
      [d.tipo, d.campanaId || null, d.propietarioId || null, d.telefono, d.mensaje, d.estado, d.error || null, d.wamid || null]);
  } catch {
    try {   // clínica sin migración v18
      await tq(tenantId,
        `INSERT INTO wa_mensajes_log (tipo, campana_id, propietario_id, telefono, mensaje, estado, error, enviado_at)
         VALUES (?,?,?,?,?,?,?,${enviado ? 'NOW()' : 'NULL'})`,
        [d.tipo, d.campanaId || null, d.propietarioId || null, d.telefono, d.mensaje, d.estado, d.error || null]);
    } catch (e) { log('No se pudo registrar el envío:', e.message); }
  }
}

async function enviarPlantilla(b) {
  const tenantId = parseInt(b.tenantId, 10);
  const tipo = ['recordatorio_cita', 'recordatorio_vacuna', 'manual', 'campana'].includes(b.tipo) ? b.tipo : 'manual';
  const [c] = await q("SELECT * FROM wa_meta_cuentas WHERE tenant_id = ? AND estado = 'conectado'", [tenantId]);
  if (!c || !c.access_token || !c.phone_number_id) return { status: 409, success: false, message: 'La clínica no está conectada a Meta.' };

  const telefono = normalizarTelefono(b.telefono, b.codigoPais);
  const resumen  = String(b.resumen || `[plantilla ${b.plantilla}]`).slice(0, 2000);
  if (!telefono) {
    await registrarLog(tenantId, { tipo, campanaId: b.campanaId, propietarioId: b.propietarioId, telefono: String(b.telefono || '').slice(0, 20),
      mensaje: resumen, estado: 'fallido', error: 'Número de teléfono inválido' });
    return { status: 422, success: false, message: 'Número de teléfono inválido.', reintentar: false };
  }
  if (!/^[a-z0-9_]{1,512}$/.test(String(b.plantilla || ''))) return { status: 422, success: false, message: 'Plantilla inválida.' };

  const cfg = await getConfig();
  let token;
  try { token = decrypt(c.access_token); } catch { return { status: 409, success: false, message: 'Token de Meta ilegible: vuelve a conectar.' }; }

  const vars = Array.isArray(b.variables) ? b.variables.map(limpiarVariable) : [];
  const payload = {
    messaging_product: 'whatsapp', to: telefono, type: 'template',
    template: { name: b.plantilla, language: { code: String(b.idioma || 'es') } },
  };
  const comps = [];
  // Plantilla con imagen en el encabezado (id de la imagen subida a Meta)
  if (b.imagenMediaId && /^\d{5,30}$/.test(String(b.imagenMediaId))) {
    comps.push({ type: 'header', parameters: [{ type: 'image', image: { id: String(b.imagenMediaId) } }] });
  }
  if (vars.length) comps.push({ type: 'body', parameters: vars.map(v => ({ type: 'text', text: v || '-' })) });
  if (comps.length) payload.template.components = comps;

  let r, d;
  try {
    r = await fetch(`${GRAPH_BASE}/${cfg.graphVer}/${c.phone_number_id}/messages`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    d = await r.json().catch(() => ({}));
  } catch (e) {
    return { status: 502, success: false, message: 'No se pudo conectar con Meta: ' + e.message, reintentar: true };
  }

  if (!r.ok || d.error) {
    const code = d.error?.code;
    const msg  = `(${code || r.status}) ${d.error?.error_data?.details || d.error?.message || 'Error de Meta'}`;
    const reintentar = REINTENTABLES.has(code);
    if (!reintentar) {
      await registrarLog(tenantId, { tipo, campanaId: b.campanaId, propietarioId: b.propietarioId, telefono, mensaje: resumen, estado: 'fallido', error: msg });
    }
    return { status: 422, success: false, code, message: msg, reintentar };
  }

  const wamid = d.messages?.[0]?.id || null;
  await registrarLog(tenantId, { tipo, campanaId: b.campanaId, propietarioId: b.propietarioId, telefono, mensaje: resumen, estado: 'enviado', wamid });
  return { status: 200, success: true, wamid, telefono };
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
        const ins = await q(
          `INSERT INTO wa_meta_webhook_log (waba_id, phone_number_id, campo, tenant_id, payload)
           VALUES (?,?,?,?,?)`,
          [wabaId, phoneId, ch.field || null, tenantId, JSON.stringify({ object: body.object, entry_id: entry.id, change: ch })]
        );
        log(`Aviso guardado: ${ch.field || '?'} | phone=${phoneId || '-'} | clínica=${tenantId || 'sin asignar'}`);
        if (tenantId) await procesarFila({ id: ins.insertId, tenant_id: tenantId }, ch.field, ch.value || {});
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

    // Servidor interno: solo accesible desde el propio servidor (no está en Nginx)
    const interno = express();
    interno.disable('x-powered-by');
    interno.use(express.json({ limit: '200kb' }));
    interno.use((req, res, next) => {
      if (req.get('x-internal-key') !== INTERNAL_KEY) return res.status(401).json({ success: false, message: 'No autorizado' });
      next();
    });
    interno.post('/interno/enviar-plantilla', async (req, res) => {
      try {
        const r = await enviarPlantilla(req.body || {});
        const { status, ...cuerpo } = r;
        res.status(status).json(cuerpo);
      } catch (e) {
        log('Error enviando plantilla:', e.message);
        res.status(500).json({ success: false, message: e.message, reintentar: true });
      }
    });
    interno.listen(PORT_INTERNO, '127.0.0.1', () => log(`Interno en 127.0.0.1:${PORT_INTERNO}`));

    setInterval(barrerPendientes, 5 * 60 * 1000);
    setTimeout(barrerPendientes, 20 * 1000);
  } catch (e) {
    log('No se pudo iniciar:', e.message);
    process.exit(1);
  }
})();