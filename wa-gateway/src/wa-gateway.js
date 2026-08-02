'use strict';

/**
 * VetNetcodip SaaS — WhatsApp Gateway v2
 * Puerto: 5000
 * Mejoras: soporte imágenes/media, WebSocket progreso campañas, control cuota
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mysql      = require('mysql2/promise');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino      = require('pino');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '20mb' }));

const PORT         = process.env.WA_PORT        || 5000;
const SESSIONS_DIR = process.env.WA_SESSIONS_DIR || '/var/www/app_veterinaria/wa-sessions';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── Pool DB ───────────────────────────────────────────────────
const masterPool = mysql.createPool({
  host    : process.env.MASTER_DB_HOST,
  port    : process.env.MASTER_DB_PORT || 3306,
  user    : process.env.MASTER_DB_USER,
  password: process.env.MASTER_DB_PASS,
  database: process.env.MASTER_DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
});

async function masterQuery(sql, params = []) {
  const [rows] = await masterPool.execute(sql, params);
  return rows;
}

async function getTenantConn(tenantId) {
  const [t] = await masterQuery(
    'SELECT db_host, db_port, db_user, db_pass, db_name FROM tenants WHERE id=?',
    [tenantId]
  );
  if (!t) throw new Error('Tenant no encontrado');
  return mysql.createConnection({
    host: t.db_host, port: t.db_port || 3306,
    user: t.db_user, password: t.db_pass, database: t.db_name,
  });
}

// ── Estado de sesiones en memoria ─────────────────────────────
const sesiones = new Map();

// ── Auth interna ──────────────────────────────────────────────
function authInternal(req, res, next) {
  if (req.headers['x-internal-key'] !== INTERNAL_KEY)
    return res.status(401).json({ success: false, message: 'No autorizado' });
  next();
}

function sessionDir(slug) { return path.join(SESSIONS_DIR, slug); }

function formatTelefono(telefono, codigoPais = '+51') {
  if (!telefono) return null;
  let clean = telefono.replace(/[^\d+]/g, '');
  if (clean.startsWith('+')) return clean.replace('+', '') + '@s.whatsapp.net';
  if (clean.startsWith('0')) clean = clean.substring(1);
  const codigo = codigoPais.replace('+', '');
  return `${codigo}${clean}@s.whatsapp.net`;
}

async function logMensaje(tenantId, tipo, propietarioId, telefono, mensaje, estado, error = null) {
  try {
    const conn = await getTenantConn(tenantId);
    await conn.execute(
      `INSERT INTO wa_mensajes_log (tipo, propietario_id, telefono, mensaje, estado, error, enviado_at)
       VALUES (?,?,?,?,?,?,?)`,
      [tipo, propietarioId || null, telefono, mensaje || '[imagen]', estado, error,
       estado === 'enviado' ? new Date() : null]
    );
    await conn.end();
  } catch (e) { console.error('[WA log]', e.message); }
}

async function verificarCuota(tenantId) {
  const [cfg] = await masterQuery(
    'SELECT ilimitado, msgs_incluidos, msgs_usados, mes_actual FROM wa_config_global WHERE tenant_id=?',
    [tenantId]
  );
  if (!cfg) return { ok: false, razon: 'Sin config WA' };
  if (cfg.ilimitado) return { ok: true };
  const mesActual = new Date().toISOString().slice(0, 7);
  if (cfg.mes_actual !== mesActual) {
    await masterQuery(
      'UPDATE wa_config_global SET msgs_usados=0, mes_actual=? WHERE tenant_id=?',
      [mesActual, tenantId]
    );
    return { ok: true };
  }
  if (cfg.msgs_usados >= cfg.msgs_incluidos)
    return { ok: false, razon: `Cuota agotada: ${cfg.msgs_usados}/${cfg.msgs_incluidos} mensajes este mes` };
  return { ok: true, restantes: cfg.msgs_incluidos - cfg.msgs_usados };
}

async function incrementarCuota(tenantId) {
  await masterQuery(
    'UPDATE wa_config_global SET msgs_usados = msgs_usados + 1 WHERE tenant_id=?',
    [tenantId]
  );
}

// ── Descargar imagen desde URL ────────────────────────────────
function descargarImagen(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : require('http');
    proto.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        buffer  : Buffer.concat(chunks),
        mimetype: res.headers['content-type'] || 'image/jpeg',
      }));
    }).on('error', reject);
  });
}

// ── Crear / restaurar sesión Baileys ──────────────────────────
async function crearSesion(tenantId, tenantSlug, tenantNombre) {
  if (sesiones.has(tenantId)) {
    const s = sesiones.get(tenantId);
    if (s.estado === 'conectado') return { ok: true, message: 'Ya conectado' };
  }

  console.log(`[WA] Iniciando sesión: ${tenantSlug}`);
  const dir = sessionDir(tenantSlug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  await masterQuery(
    `INSERT INTO wa_sesiones (tenant_id, tenant_nombre, estado)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE estado='conectando', updated_at=NOW()`,
    [tenantId, tenantNombre, 'conectando']
  );

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth            : state,
    logger          : pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser         : ['VetNetcodip', 'Chrome', '1.0'],
    syncFullHistory : false,
  });

  const sesion = { socket: sock, estado: 'conectando', numero: null, qr: null, slug: tenantSlug };
  sesiones.set(tenantId, sesion);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sesion.qr     = qr;
      sesion.estado = 'conectando';
      console.log(`[WA] QR generado: ${tenantSlug}`);
      io.to(`tenant:${tenantId}`).emit('wa:qr', { tenantId, qr });
      await masterQuery('UPDATE wa_sesiones SET estado=? WHERE tenant_id=?', ['conectando', tenantId]);
    }

    if (connection === 'open') {
      const numero = sock.user?.id?.split(':')[0] || null;
      sesion.estado = 'conectado';
      sesion.numero = numero;
      sesion.qr     = null;
      console.log(`[WA] ✅ Conectado: ${tenantSlug} → ${numero}`);
      await masterQuery(
        'UPDATE wa_sesiones SET estado=?, numero_wa=?, ultima_conexion=NOW(), error_msg=NULL WHERE tenant_id=?',
        ['conectado', numero, tenantId]
      );
      io.to(`tenant:${tenantId}`).emit('wa:conectado', { tenantId, numero });
    }

    if (connection === 'close') {
      const codigo = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode : null;
      const debeReconectar = codigo !== DisconnectReason.loggedOut;
      console.log(`[WA] ❌ Desconectado: ${tenantSlug} — código: ${codigo}`);
      if (debeReconectar) {
        console.log(`[WA] 🔄 Reconectando: ${tenantSlug}`);
        sesiones.delete(tenantId);
        setTimeout(() => crearSesion(tenantId, tenantSlug, tenantNombre), 5000);
      } else {
        await limpiarSesion(tenantId, tenantSlug, 'desconectado');
        io.to(`tenant:${tenantId}`).emit('wa:desconectado', { tenantId });
      }
    }
  });

  return { ok: true, message: 'Sesión iniciada, espera el QR' };
}

async function limpiarSesion(tenantId, tenantSlug, estadoFinal = 'desconectado') {
  console.log(`[WA] 🧹 Limpiando sesión: ${tenantSlug}`);
  const sesion = sesiones.get(tenantId);
  if (sesion?.socket) {
    try { await sesion.socket.logout(); } catch {}
    try { sesion.socket.end(undefined); } catch {}
  }
  sesiones.delete(tenantId);
  const dir = sessionDir(tenantSlug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  await masterQuery(
    'UPDATE wa_sesiones SET estado=?, numero_wa=NULL, error_msg=NULL, updated_at=NOW() WHERE tenant_id=?',
    [estadoFinal, tenantId]
  );
}

// ── Enviar mensaje texto ──────────────────────────────────────
async function enviarMensaje(tenantId, telefono, mensaje, codigoPais = '+51') {
  const sesion = sesiones.get(tenantId);
  if (!sesion || sesion.estado !== 'conectado')
    throw new Error('WhatsApp no conectado para este tenant');
  const jid = formatTelefono(telefono, codigoPais);
  if (!jid) throw new Error('Teléfono inválido');
  await sesion.socket.sendMessage(jid, { text: mensaje });
  await masterQuery('UPDATE wa_sesiones SET ultima_actividad=NOW() WHERE tenant_id=?', [tenantId]);
}

// ── Enviar imagen ─────────────────────────────────────────────
async function enviarImagen(tenantId, telefono, imagenUrl, caption, codigoPais = '+51') {
  const sesion = sesiones.get(tenantId);
  if (!sesion || sesion.estado !== 'conectado')
    throw new Error('WhatsApp no conectado para este tenant');
  const jid = formatTelefono(telefono, codigoPais);
  if (!jid) throw new Error('Teléfono inválido');

  const { buffer, mimetype } = await descargarImagen(imagenUrl);

  await sesion.socket.sendMessage(jid, {
    image  : buffer,
    mimetype,
    caption: caption || '',
  });
  await masterQuery('UPDATE wa_sesiones SET ultima_actividad=NOW() WHERE tenant_id=?', [tenantId]);
}

// ── RUTAS HTTP ────────────────────────────────────────────────

app.post('/wa/sesion/iniciar', authInternal, async (req, res) => {
  try {
    const { tenantId, tenantSlug, tenantNombre } = req.body;
    if (!tenantId || !tenantSlug)
      return res.status(422).json({ success: false, message: 'tenantId y tenantSlug requeridos' });
    const result = await crearSesion(parseInt(tenantId), tenantSlug, tenantNombre);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[WA iniciar]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/wa/sesion/desconectar', authInternal, async (req, res) => {
  try {
    const { tenantId, tenantSlug } = req.body;
    await limpiarSesion(parseInt(tenantId), tenantSlug, 'desconectado');
    return res.json({ success: true, message: 'Sesión cerrada y limpiada.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/wa/sesion/:tenantId/estado', authInternal, async (req, res) => {
  try {
    const tenantId = parseInt(req.params.tenantId);
    const sesion   = sesiones.get(tenantId);
    const [dbSesion] = await masterQuery(
      'SELECT estado, numero_wa, ultima_conexion, ultima_actividad FROM wa_sesiones WHERE tenant_id=?',
      [tenantId]
    );
    return res.json({
      success: true,
      data: {
        en_memoria      : !!sesion,
        estado          : sesion?.estado || dbSesion?.estado || 'desconectado',
        numero          : sesion?.numero || dbSesion?.numero_wa || null,
        tiene_qr        : !!sesion?.qr,
        ultima_conexion : dbSesion?.ultima_conexion || null,
        ultima_actividad: dbSesion?.ultima_actividad || null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/wa/sesion/:tenantId/qr', authInternal, async (req, res) => {
  const tenantId = parseInt(req.params.tenantId);
  const sesion   = sesiones.get(tenantId);
  if (!sesion?.qr)
    return res.status(404).json({ success: false, message: 'QR no disponible aún.' });
  return res.json({ success: true, data: { qr: sesion.qr } });
});

// POST /wa/enviar — texto o imagen
app.post('/wa/enviar', authInternal, async (req, res) => {
  try {
    const { tenantId, telefono, mensaje, imagen_url, propietarioId, tipo, codigoPais } = req.body;
    if (!tenantId || !telefono)
      return res.status(422).json({ success: false, message: 'tenantId y telefono requeridos' });
    if (!mensaje && !imagen_url)
      return res.status(422).json({ success: false, message: 'mensaje o imagen_url requerido' });

    const cuota = await verificarCuota(parseInt(tenantId));
    if (!cuota.ok)
      return res.status(422).json({ success: false, message: cuota.razon, code: 'CUOTA_AGOTADA' });

    if (imagen_url) {
      await enviarImagen(parseInt(tenantId), telefono, imagen_url, mensaje, codigoPais || '+51');
    } else {
      await enviarMensaje(parseInt(tenantId), telefono, mensaje, codigoPais || '+51');
    }

    await incrementarCuota(parseInt(tenantId));
    await logMensaje(parseInt(tenantId), tipo || 'manual', propietarioId, telefono, mensaje || '[imagen]', 'enviado');

    return res.json({ success: true, message: 'Mensaje enviado.' });
  } catch (err) {
    await logMensaje(
      parseInt(req.body.tenantId), req.body.tipo || 'manual',
      req.body.propietarioId, req.body.telefono, req.body.mensaje || '[imagen]', 'fallido', err.message
    );
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /wa/estado
app.get('/wa/estado', authInternal, async (req, res) => {
  try {
    const sesionesDB = await masterQuery(
      `SELECT ws.tenant_id, ws.estado, ws.numero_wa, ws.ultima_conexion,
              tc.nombre_clinica, wcg.activo, wcg.msgs_usados, wcg.msgs_incluidos, wcg.ilimitado
       FROM wa_sesiones ws
       LEFT JOIN tenant_config tc ON tc.tenant_id = ws.tenant_id
       LEFT JOIN wa_config_global wcg ON wcg.tenant_id = ws.tenant_id
       ORDER BY tc.nombre_clinica`
    );
    const data = sesionesDB.map(s => ({
      ...s,
      en_memoria    : sesiones.has(s.tenant_id),
      estado_memoria: sesiones.get(s.tenant_id)?.estado || null,
    }));
    return res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// POST /wa/campana/progreso — recibe progreso de wa-campanas.js y lo emite via WS
app.post('/wa/campana/progreso', authInternal, (req, res) => {
  const { tenantId, campanaId, ...datos } = req.body;
  if (tenantId && campanaId) {
    io.to(`tenant:${tenantId}`).emit('wa:campana:progreso', { campanaId, ...datos });
  }
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', sesiones: sesiones.size, uptime: process.uptime() });
});

// ── WebSocket ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('wa:suscribir', (tenantId) => {
    socket.join(`tenant:${tenantId}`);
    const sesion = sesiones.get(parseInt(tenantId));
    socket.emit('wa:estado', {
      tenantId,
      estado: sesion?.estado || 'desconectado',
      numero: sesion?.numero || null,
    });
  });
});

// Función pública para emitir progreso de campaña desde wa-campanas.js
function emitirProgresoCampana(tenantId, campanaId, datos) {
  io.to(`tenant:${tenantId}`).emit('wa:campana:progreso', { campanaId, ...datos });
}

module.exports = { io, emitirProgresoCampana };

// ── Restaurar sesiones ────────────────────────────────────────
async function restaurarSesiones() {
  try {
    const activas = await masterQuery(
      `SELECT ws.tenant_id, t.slug, tc.nombre_clinica
       FROM wa_sesiones ws
       JOIN tenants t ON t.id = ws.tenant_id
       LEFT JOIN tenant_config tc ON tc.tenant_id = ws.tenant_id
       JOIN wa_config_global wcg ON wcg.tenant_id = ws.tenant_id
       WHERE ws.estado = 'conectado' AND wcg.activo = 1`
    );
    console.log(`[WA] Restaurando ${activas.length} sesiones activas...`);
    for (const s of activas) {
      const dir = sessionDir(s.slug);
      if (fs.existsSync(dir)) {
        await crearSesion(s.tenant_id, s.slug, s.nombre_clinica);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        await masterQuery('UPDATE wa_sesiones SET estado=? WHERE tenant_id=?', ['desconectado', s.tenant_id]);
      }
    }
  } catch (e) { console.error('[WA restore]', e.message); }
}

setInterval(async () => {
  for (const [tenantId, sesion] of sesiones.entries()) {
    if (sesion.estado === 'error') {
      const [t] = await masterQuery('SELECT slug FROM tenants WHERE id=?', [tenantId]);
      if (t) await limpiarSesion(tenantId, t.slug, 'error');
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, async () => {
  console.log(`[WA Gateway] ✅ Puerto ${PORT}`);
  console.log(`[WA Gateway] Sesiones en: ${SESSIONS_DIR}`);
  await restaurarSesiones();
});

process.on('uncaughtException',  (err) => console.error('[WA uncaught]',    err.message));
process.on('unhandledRejection', (err) => console.error('[WA unhandled]',   err?.message));