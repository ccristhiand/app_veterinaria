'use strict';

/**
 * VetClinic SaaS — WhatsApp Gateway
 * Proceso SEPARADO del API principal
 * Puerto: 5000
 * PM2: pm2 start wa-gateway.js --name wa-gateway
 * 
 * Cada tenant tiene su propia sesión Baileys
 * Sesiones guardadas en /var/www/app_veterinaria/wa-sessions/{tenant_slug}/
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mysql      = require('mysql2/promise');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Baileys
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidDecode,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino      = require('pino');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

const PORT         = process.env.WA_PORT || 5000;
const SESSIONS_DIR = process.env.WA_SESSIONS_DIR || '/var/www/app_veterinaria/wa-sessions';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';

// Asegurar que existe el directorio de sesiones
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
    host    : t.db_host,
    port    : t.db_port || 3306,
    user    : t.db_user,
    password: t.db_pass,
    database: t.db_name,
  });
}

// ── Estado de sesiones en memoria ─────────────────────────────
// { tenantId: { socket, estado, numero, qr } }
const sesiones = new Map();

// ── Middleware autenticación interna ──────────────────────────
function authInternal(req, res, next) {
  const key = req.headers['x-internal-key'];
  if (key !== INTERNAL_KEY) {
    return res.status(401).json({ success: false, message: 'No autorizado' });
  }
  next();
}

// ── Helpers ───────────────────────────────────────────────────
function sessionDir(slug) {
  return path.join(SESSIONS_DIR, slug);
}

function formatTelefono(telefono, codigoPais = '+51') {
  if (!telefono) return null;
  // Limpiar todo excepto dígitos y +
  let clean = telefono.replace(/[^\d+]/g, '');
  // Si ya tiene código de país
  if (clean.startsWith('+')) return clean.replace('+', '') + '@s.whatsapp.net';
  // Si empieza con 0 (número local) → quitar el 0
  if (clean.startsWith('0')) clean = clean.substring(1);
  // Agregar código de país
  const codigo = codigoPais.replace('+', '');
  return `${codigo}${clean}@s.whatsapp.net`;
}

async function logMensaje(tenantId, tipo, propietarioId, telefono, mensaje, estado, error = null) {
  try {
    const conn = await getTenantConn(tenantId);
    await conn.execute(
      `INSERT INTO wa_mensajes_log (tipo, propietario_id, telefono, mensaje, estado, error, enviado_at)
       VALUES (?,?,?,?,?,?,?)`,
      [tipo, propietarioId || null, telefono, mensaje, estado, error, estado === 'enviado' ? new Date() : null]
    );
    await conn.end();
  } catch (e) {
    console.error('[WA log]', e.message);
  }
}

async function verificarCuota(tenantId) {
  const [cfg] = await masterQuery(
    'SELECT ilimitado, msgs_incluidos, msgs_usados, mes_actual FROM wa_config_global WHERE tenant_id=?',
    [tenantId]
  );
  if (!cfg) return { ok: false, razon: 'Sin config WA' };
  if (cfg.ilimitado) return { ok: true };

  const mesActual = new Date().toISOString().slice(0, 7);
  // Reset si cambió el mes
  if (cfg.mes_actual !== mesActual) {
    await masterQuery(
      'UPDATE wa_config_global SET msgs_usados=0, mes_actual=? WHERE tenant_id=?',
      [mesActual, tenantId]
    );
    return { ok: true };
  }
  if (cfg.msgs_usados >= cfg.msgs_incluidos) {
    return { ok: false, razon: `Cuota agotada: ${cfg.msgs_usados}/${cfg.msgs_incluidos} mensajes este mes` };
  }
  return { ok: true, restantes: cfg.msgs_incluidos - cfg.msgs_usados };
}

async function incrementarCuota(tenantId) {
  await masterQuery(
    'UPDATE wa_config_global SET msgs_usados = msgs_usados + 1 WHERE tenant_id=?',
    [tenantId]
  );
}

// ── Crear / restaurar sesión Baileys ──────────────────────────
async function crearSesion(tenantId, tenantSlug, tenantNombre) {
  // Si ya hay sesión activa, no crear otra
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
    auth        : state,
    logger      : pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser     : ['VetClinic', 'Chrome', '1.0'],
    syncFullHistory: false,
  });

  const sesion = { socket: sock, estado: 'conectando', numero: null, qr: null, slug: tenantSlug };
  sesiones.set(tenantId, sesion);

  // ── Eventos Baileys ───────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR generado
    if (qr) {
      sesion.qr     = qr;
      sesion.estado = 'conectando';
      console.log(`[WA] QR generado: ${tenantSlug}`);
      // Emitir QR via WebSocket al frontend
      io.to(`tenant:${tenantId}`).emit('wa:qr', { tenantId, qr });
      await masterQuery(
        'UPDATE wa_sesiones SET estado=? WHERE tenant_id=?',
        ['conectando', tenantId]
      );
    }

    // Conectado
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

    // Desconectado
    if (connection === 'close') {
      const codigo = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : null;
      const debeReconectar = codigo !== DisconnectReason.loggedOut;

      console.log(`[WA] ❌ Desconectado: ${tenantSlug} — código: ${codigo}`);

      if (debeReconectar) {
        // Reconexión automática por caída temporal
        console.log(`[WA] 🔄 Reconectando: ${tenantSlug}`);
        sesiones.delete(tenantId);
        setTimeout(() => crearSesion(tenantId, tenantSlug, tenantNombre), 3000);
      } else {
        // Logout explícito — limpiar todo
        await limpiarSesion(tenantId, tenantSlug, 'desconectado');
        io.to(`tenant:${tenantId}`).emit('wa:desconectado', { tenantId });
      }
    }
  });

  return { ok: true, message: 'Sesión iniciada, espera el QR' };
}

// ── Limpiar sesión ────────────────────────────────────────────
async function limpiarSesion(tenantId, tenantSlug, estadoFinal = 'desconectado') {
  console.log(`[WA] 🧹 Limpiando sesión: ${tenantSlug}`);

  // Cerrar socket si existe
  const sesion = sesiones.get(tenantId);
  if (sesion?.socket) {
    try { await sesion.socket.logout(); } catch {}
    try { sesion.socket.end(undefined); } catch {}
  }
  sesiones.delete(tenantId);

  // Eliminar archivos de sesión del disco
  const dir = sessionDir(tenantSlug);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[WA] 🗑️  Archivos eliminados: ${dir}`);
  }

  // Actualizar BD
  await masterQuery(
    'UPDATE wa_sesiones SET estado=?, numero_wa=NULL, error_msg=NULL, updated_at=NOW() WHERE tenant_id=?',
    [estadoFinal, tenantId]
  );
}

// ── Enviar mensaje ────────────────────────────────────────────
async function enviarMensaje(tenantId, telefono, mensaje, codigoPais = '+51') {
  const sesion = sesiones.get(tenantId);
  if (!sesion || sesion.estado !== 'conectado') {
    throw new Error('WhatsApp no conectado para este tenant');
  }

  const jid = formatTelefono(telefono, codigoPais);
  if (!jid) throw new Error('Teléfono inválido');

  await sesion.socket.sendMessage(jid, { text: mensaje });
  sesion.estado_actividad = new Date();

  // Actualizar ultima actividad
  await masterQuery(
    'UPDATE wa_sesiones SET ultima_actividad=NOW() WHERE tenant_id=?',
    [tenantId]
  );
}

// ── RUTAS HTTP (consumidas por el API principal) ──────────────

// POST /wa/sesion/iniciar
app.post('/wa/sesion/iniciar', authInternal, async (req, res) => {
  try {
    const { tenantId, tenantSlug, tenantNombre } = req.body;
    if (!tenantId || !tenantSlug) {
      return res.status(422).json({ success: false, message: 'tenantId y tenantSlug requeridos' });
    }
    const result = await crearSesion(parseInt(tenantId), tenantSlug, tenantNombre);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[WA iniciar]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /wa/sesion/desconectar
app.post('/wa/sesion/desconectar', authInternal, async (req, res) => {
  try {
    const { tenantId, tenantSlug } = req.body;
    await limpiarSesion(parseInt(tenantId), tenantSlug, 'desconectado');
    return res.json({ success: true, message: 'Sesión cerrada y limpiada.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /wa/sesion/:tenantId/estado
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
        en_memoria   : !!sesion,
        estado       : sesion?.estado || dbSesion?.estado || 'desconectado',
        numero       : sesion?.numero || dbSesion?.numero_wa || null,
        tiene_qr     : !!sesion?.qr,
        ultima_conexion  : dbSesion?.ultima_conexion || null,
        ultima_actividad : dbSesion?.ultima_actividad || null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /wa/sesion/:tenantId/qr
app.get('/wa/sesion/:tenantId/qr', authInternal, async (req, res) => {
  const tenantId = parseInt(req.params.tenantId);
  const sesion   = sesiones.get(tenantId);
  if (!sesion?.qr) {
    return res.status(404).json({ success: false, message: 'QR no disponible aún. Inicia la sesión primero.' });
  }
  return res.json({ success: true, data: { qr: sesion.qr } });
});

// POST /wa/enviar
app.post('/wa/enviar', authInternal, async (req, res) => {
  try {
    const { tenantId, telefono, mensaje, propietarioId, tipo, codigoPais } = req.body;
    if (!tenantId || !telefono || !mensaje) {
      return res.status(422).json({ success: false, message: 'tenantId, telefono y mensaje requeridos' });
    }

    // Verificar cuota
    const cuota = await verificarCuota(parseInt(tenantId));
    if (!cuota.ok) {
      return res.status(422).json({ success: false, message: cuota.razon, code: 'CUOTA_AGOTADA' });
    }

    await enviarMensaje(parseInt(tenantId), telefono, mensaje, codigoPais || '+51');
    await incrementarCuota(parseInt(tenantId));
    await logMensaje(parseInt(tenantId), tipo || 'manual', propietarioId, telefono, mensaje, 'enviado');

    return res.json({ success: true, message: 'Mensaje enviado.' });
  } catch (err) {
    await logMensaje(
      parseInt(req.body.tenantId), req.body.tipo || 'manual',
      req.body.propietarioId, req.body.telefono, req.body.mensaje, 'fallido', err.message
    );
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /wa/estado — estado general de todas las sesiones
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
      en_memoria: sesiones.has(s.tenant_id),
      estado_memoria: sesiones.get(s.tenant_id)?.estado || null,
    }));
    return res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status  : 'ok',
    sesiones: sesiones.size,
    uptime  : process.uptime(),
  });
});

// ── WebSocket — tenant se suscribe a sus eventos ──────────────
io.on('connection', (socket) => {
  socket.on('wa:suscribir', (tenantId) => {
    socket.join(`tenant:${tenantId}`);
    // Enviar estado actual
    const sesion = sesiones.get(parseInt(tenantId));
    socket.emit('wa:estado', {
      tenantId,
      estado: sesion?.estado || 'desconectado',
      numero: sesion?.numero || null,
    });
  });
});

// ── Restaurar sesiones activas al arrancar ────────────────────
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
        await new Promise(r => setTimeout(r, 1000)); // esperar entre reconexiones
      } else {
        // No hay archivos de sesión — marcar como desconectado
        await masterQuery(
          'UPDATE wa_sesiones SET estado=? WHERE tenant_id=?',
          ['desconectado', s.tenant_id]
        );
      }
    }
  } catch (e) {
    console.error('[WA restore]', e.message);
  }
}

// ── Limpieza periódica — cada 5 minutos ──────────────────────
// Elimina del Map sesiones que están en error sin reconectarse
setInterval(async () => {
  for (const [tenantId, sesion] of sesiones.entries()) {
    if (sesion.estado === 'error') {
      console.log(`[WA] 🧹 Limpiando sesión en error: ${sesion.slug}`);
      const [t] = await masterQuery('SELECT slug FROM tenants WHERE id=?', [tenantId]);
      if (t) await limpiarSesion(tenantId, t.slug, 'error');
    }
  }
}, 5 * 60 * 1000);

// ── Arrancar servidor ─────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`[WA Gateway] ✅ Puerto ${PORT}`);
  console.log(`[WA Gateway] Sesiones en: ${SESSIONS_DIR}`);
  await restaurarSesiones();
});

process.on('uncaughtException', (err) => console.error('[WA uncaught]', err.message));
process.on('unhandledRejection', (err) => console.error('[WA unhandled]', err?.message));