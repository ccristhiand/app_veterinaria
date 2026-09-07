'use strict';

/**
 * VetNetcodip SaaS — WhatsApp Gateway v3
 * Nuevas funciones:
 * - Upload de imágenes/documentos a Azure Blob Storage
 * - Publicación de historias (WhatsApp Status)
 * - Programador de historias (cada 60s revisa pendientes)
 * - WebSocket mejorado con log en vivo de campañas
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
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino      = require('pino');

// ── Azure Blob Storage ────────────────────────────────────────
const { BlobServiceClient } = require('@azure/storage-blob');

const AZURE_CONN      = process.env.AZURE_WA_STORAGE_CONNECTION || process.env.AZURE_STORAGE_CONNECTION;
const AZURE_CONTAINER = process.env.AZURE_WA_CONTAINER          || 'wa-media';

let blobServiceClient = null;
let containerClient   = null;

if (AZURE_CONN) {
  try {
    blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONN);
    containerClient   = blobServiceClient.getContainerClient(AZURE_CONTAINER);
    containerClient.createIfNotExists({ access: 'blob' })
      .then(() => console.log(`[WA] Azure Blob OK — container: ${AZURE_CONTAINER}`))
      .catch(e  => console.error('[WA] Azure Blob error:', e.message));
  } catch (e) {
    console.error('[WA] Azure config inválida:', e.message);
  }
} else {
  console.warn('[WA] AZURE_WA_STORAGE_CONNECTION no configurado — upload deshabilitado');
}

/**
 * Subir buffer a Azure Blob Storage
 * El gateway descarga con credenciales SDK — no necesita URL pública ni SAS
 * @returns {string} URL del blob (requiere credenciales para acceder)
 */
async function subirBlob(buffer, blobName, contentType = 'image/jpeg') {
  if (!containerClient) throw new Error('Azure Blob no configurado');
  const blockBlob = containerClient.getBlockBlobClient(blobName);
  await blockBlob.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return blockBlob.url; // URL base sin SAS — el gateway usa SDK para descargar
}

/**
 * Eliminar blob de Azure
 */
async function eliminarBlob(blobName) {
  if (!containerClient || !blobName) return;
  try {
    await containerClient.deleteBlob(blobName);
  } catch {}
}

// ── Express + Socket.io ───────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '25mb' }));

const PORT         = process.env.WA_PORT         || 5000;
const SESSIONS_DIR = process.env.WA_SESSIONS_DIR || '/var/www/app_veterinaria/wa-sessions';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── Pool DB master ────────────────────────────────────────────
const masterPool = mysql.createPool({
  host              : process.env.MASTER_DB_HOST,
  port              : process.env.MASTER_DB_PORT || 3306,
  user              : process.env.MASTER_DB_USER,
  password          : process.env.MASTER_DB_PASS,
  database          : process.env.MASTER_DB_NAME,
  waitForConnections: true,
  connectionLimit   : 5,
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

// ── Estado de sesiones en memoria ────────────────────────────
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
      [tipo, propietarioId || null, telefono, mensaje || '[media]', estado, error,
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
    await masterQuery('UPDATE wa_config_global SET msgs_usados=0, mes_actual=? WHERE tenant_id=?', [mesActual, tenantId]);
    return { ok: true };
  }
  if (cfg.msgs_usados >= cfg.msgs_incluidos)
    return { ok: false, razon: `Cuota agotada: ${cfg.msgs_usados}/${cfg.msgs_incluidos} mensajes este mes` };
  return { ok: true, restantes: cfg.msgs_incluidos - cfg.msgs_usados };
}

async function incrementarCuota(tenantId) {
  await masterQuery('UPDATE wa_config_global SET msgs_usados=msgs_usados+1 WHERE tenant_id=?', [tenantId]);
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
    browser         : Browsers.baileys('Desktop'),
    syncFullHistory : false,
  });

  const sesion = { socket: sock, estado: 'conectando', numero: null, qr: null, slug: tenantSlug };
  sesiones.set(tenantId, sesion);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      sesion.qr = qr; sesion.estado = 'conectando';
      io.to(`tenant:${tenantId}`).emit('wa:qr', { tenantId, qr });
      await masterQuery('UPDATE wa_sesiones SET estado=? WHERE tenant_id=?', ['conectando', tenantId]);
    }
    if (connection === 'open') {
      const numero = sock.user?.id?.split(':')[0] || null;
      sesion.estado = 'conectado'; sesion.numero = numero; sesion.qr = null;
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
      if (debeReconectar) {
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
  if (!sesion || sesion.estado !== 'conectado') throw new Error('WhatsApp no conectado');
  const jid = formatTelefono(telefono, codigoPais);
  if (!jid) throw new Error('Teléfono inválido');
  await sesion.socket.sendMessage(jid, { text: mensaje });
  await masterQuery('UPDATE wa_sesiones SET ultima_actividad=NOW() WHERE tenant_id=?', [tenantId]);
}

// ── Enviar imagen desde URL ───────────────────────────────────
async function enviarImagen(tenantId, telefono, imagenUrl, caption, codigoPais = '+51') {
  const sesion = sesiones.get(tenantId);
  if (!sesion || sesion.estado !== 'conectado') throw new Error('WhatsApp no conectado');
  const jid = formatTelefono(telefono, codigoPais);
  if (!jid) throw new Error('Teléfono inválido');

  let buffer, mimetype;

  // Si es URL de Azure y tenemos credenciales → descargar con SDK (sin acceso público)
  if (containerClient && imagenUrl && imagenUrl.includes('.blob.core.windows.net')) {
    try {
      // Extraer blobName de la URL
      const urlObj = new URL(imagenUrl.split('?')[0]); // quitar SAS si tiene
      const pathParts = urlObj.pathname.split('/');
      // pathname = /container/blob/name → quitar primer slash y container
      const blobName = pathParts.slice(2).join('/');
      const blobClient = containerClient.getBlobClient(blobName);
      const download = await blobClient.download();
      const chunks = [];
      for await (const chunk of download.readableStreamBody) chunks.push(chunk);
      buffer   = Buffer.concat(chunks);
      mimetype = download.contentType || 'image/jpeg';
    } catch (e) {
      console.error('[WA] Error descargando blob Azure:', e.message);
      throw new Error('No se pudo descargar la imagen de Azure: ' + e.message);
    }
  } else {
    // URL externa — descarga HTTP normal
    const dl = await descargarImagen(imagenUrl);
    buffer   = dl.buffer;
    mimetype = dl.mimetype;
  }

  await sesion.socket.sendMessage(jid, { image: buffer, mimetype, caption: caption || '' });
  await masterQuery('UPDATE wa_sesiones SET ultima_actividad=NOW() WHERE tenant_id=?', [tenantId]);
}

// ── Enviar imagen desde base64 (sin Azure, directo en memoria) ─
async function enviarImagenBase64(tenantId, telefono, base64, mimetype, caption, codigoPais = '+51') {
  const sesion = sesiones.get(tenantId);
  if (!sesion || sesion.estado !== 'conectado') throw new Error('WhatsApp no conectado');
  const jid = formatTelefono(telefono, codigoPais);
  if (!jid) throw new Error('Teléfono inválido');
  const buffer = Buffer.from(base64, 'base64');
  await sesion.socket.sendMessage(jid, { image: buffer, mimetype: mimetype || 'image/jpeg', caption: caption || '' });
  await masterQuery('UPDATE wa_sesiones SET ultima_actividad=NOW() WHERE tenant_id=?', [tenantId]);
}

// ── Publicar historia (WhatsApp Status) ───────────────────────
async function publicarHistoria(tenantId, imagenUrl, texto) {
  const sesion = sesiones.get(tenantId);
  if (!sesion || sesion.estado !== 'conectado') throw new Error('WhatsApp no conectado');

  // Baileys v7: statusJidList en las OPTIONS (3er param de sendMessage)
  // Sin store, obtenemos los contactos directo de la BD del tenant
  let statusJidList = [];
  try {
    const conn = await getTenantConn(tenantId);
    const [props] = await conn.execute(
      "SELECT telefono FROM propietarios WHERE telefono IS NOT NULL AND telefono != '' LIMIT 500"
    );
    await conn.end();
    // Formatear teléfonos como JIDs de WA (+51 -> 51XXXXXXXXX@s.whatsapp.net)
    statusJidList = props
      .map(p => {
        let t = (p.telefono || '').replace(/[^\d]/g, '');
        if (t.length === 9) t = '51' + t;      // número peruano sin código
        return t ? t + '@s.whatsapp.net' : null;
      })
      .filter(Boolean);
    console.log('[WA Historia] Contactos para statusJidList: ' + statusJidList.length);
  } catch (e) {
    console.warn('[WA Historia] No se pudo obtener contactos, publicando sin lista:', e.message);
  }

  // Opciones comunes para el status
  const opts = statusJidList.length ? { statusJidList } : {};

  if (imagenUrl) {
    let buffer, mimetype;

    // Descargar imagen desde Azure con SDK (credenciales servidor)
    if (containerClient && imagenUrl.includes('.blob.core.windows.net')) {
      try {
        const urlObj   = new URL(imagenUrl.split('?')[0]);
        const blobName = urlObj.pathname.split('/').slice(2).join('/');
        const dl       = await containerClient.getBlobClient(blobName).download();
        const chunks   = [];
        for await (const chunk of dl.readableStreamBody) chunks.push(chunk);
        buffer   = Buffer.concat(chunks);
        mimetype = dl.contentType || 'image/jpeg';
      } catch (e) {
        throw new Error('No se pudo descargar imagen de Azure: ' + e.message);
      }
    } else {
      const dl = await descargarImagen(imagenUrl);
      buffer = dl.buffer; mimetype = dl.mimetype;
    }

    // Baileys v7: imagen como status
    await sesion.socket.sendMessage(
      'status@broadcast',
      { image: buffer, mimetype, caption: texto || '' },
      opts
    );

  } else {
    // Baileys v7: texto como status
    // backgroundColor va en OPTIONS, no en el mensaje
    await sesion.socket.sendMessage(
      'status@broadcast',
      { text: texto || '' },
      { ...opts, backgroundColor: '#1f8c3d', font: 2 }
    );
  }

  await masterQuery('UPDATE wa_sesiones SET ultima_actividad=NOW() WHERE tenant_id=?', [tenantId]);
  console.log('[WA Historia] ✅ Estado publicado para tenant:' + tenantId);
}

// ══════════════════════════════════════════════════════════════
// RUTAS HTTP
// ══════════════════════════════════════════════════════════════

// ── Sesión ────────────────────────────────────────────────────
app.post('/wa/sesion/iniciar', authInternal, async (req, res) => {
  try {
    const { tenantId, tenantSlug, tenantNombre } = req.body;
    if (!tenantId || !tenantSlug)
      return res.status(422).json({ success: false, message: 'tenantId y tenantSlug requeridos' });
    const result = await crearSesion(parseInt(tenantId), tenantSlug, tenantNombre);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/wa/sesion/desconectar', authInternal, async (req, res) => {
  try {
    const { tenantId, tenantSlug } = req.body;
    await limpiarSesion(parseInt(tenantId), tenantSlug, 'desconectado');
    res.json({ success: true, message: 'Sesión cerrada.' });
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
    res.json({ success: true, data: {
      en_memoria      : !!sesion,
      estado          : sesion?.estado || dbSesion?.estado || 'desconectado',
      numero          : sesion?.numero || dbSesion?.numero_wa || null,
      tiene_qr        : !!sesion?.qr,
      ultima_conexion : dbSesion?.ultima_conexion || null,
      ultima_actividad: dbSesion?.ultima_actividad || null,
    }});
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/wa/sesion/:tenantId/qr', authInternal, async (req, res) => {
  const sesion = sesiones.get(parseInt(req.params.tenantId));
  if (!sesion?.qr) return res.status(404).json({ success: false, message: 'QR no disponible.' });
  res.json({ success: true, data: { qr: sesion.qr } });
});

// ── Enviar mensaje / imagen ───────────────────────────────────
app.post('/wa/enviar', authInternal, async (req, res) => {
  try {
    const { tenantId, telefono, mensaje, imagen_url, imagen_base64, imagen_mimetype, propietarioId, tipo, codigoPais } = req.body;
    if (!tenantId || !telefono)
      return res.status(422).json({ success: false, message: 'tenantId y telefono requeridos' });
    if (!mensaje && !imagen_url && !imagen_base64)
      return res.status(422).json({ success: false, message: 'mensaje o imagen requerido' });

    const cuota = await verificarCuota(parseInt(tenantId));
    if (!cuota.ok) return res.status(422).json({ success: false, message: cuota.razon, code: 'CUOTA_AGOTADA' });

    if (imagen_base64) {
      // Envío directo en memoria — sin Azure
      await enviarImagenBase64(parseInt(tenantId), telefono, imagen_base64, imagen_mimetype, mensaje, codigoPais || '+51');
    } else if (imagen_url) {
      await enviarImagen(parseInt(tenantId), telefono, imagen_url, mensaje, codigoPais || '+51');
    } else {
      await enviarMensaje(parseInt(tenantId), telefono, mensaje, codigoPais || '+51');
    }

    await incrementarCuota(parseInt(tenantId));
    await logMensaje(parseInt(tenantId), tipo || 'manual', propietarioId, telefono, mensaje || '[imagen]', 'enviado');
    res.json({ success: true, message: 'Mensaje enviado.' });
  } catch (err) {
    await logMensaje(
      parseInt(req.body.tenantId), req.body.tipo || 'manual',
      req.body.propietarioId, req.body.telefono, req.body.mensaje || '[media]', 'fallido', err.message
    );
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Upload de media a Azure Blob ──────────────────────────────
// Acepta base64 en JSON { tenantId, base64, contentType, filename }
app.post('/wa/upload', authInternal, async (req, res) => {
  try {
    if (!containerClient)
      return res.status(503).json({ success: false, message: 'Azure Blob no configurado. Revisa AZURE_WA_STORAGE_CONNECTION en .env' });

    const { tenantId, base64, contentType = 'image/jpeg', filename } = req.body;
    if (!tenantId || !base64)
      return res.status(422).json({ success: false, message: 'tenantId y base64 requeridos' });

    const buffer   = Buffer.from(base64, 'base64');
    const ext      = contentType.split('/')[1] || 'jpg';
    const blobName = `tenant-${tenantId}/${Date.now()}-${filename || 'media'}.${ext}`;

    const url = await subirBlob(buffer, blobName, contentType);
    res.json({ success: true, data: { url, blobName } });
  } catch (err) {
    console.error('[WA upload]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Eliminar blob de Azure ────────────────────────────────────
app.delete('/wa/upload/:blobName', authInternal, async (req, res) => {
  try {
    const blobName = decodeURIComponent(req.params.blobName);
    await eliminarBlob(blobName);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Estado general ────────────────────────────────────────────
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
    res.json({ success: true, data: sesionesDB.map(s => ({
      ...s,
      en_memoria    : sesiones.has(s.tenant_id),
      estado_memoria: sesiones.get(s.tenant_id)?.estado || null,
    }))});
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Progreso campaña (de wa-campanas.js → WebSocket clientes) ─
app.post('/wa/campana/progreso', authInternal, (req, res) => {
  const { tenantId, campanaId, ...datos } = req.body;
  if (tenantId && campanaId)
    io.to(`tenant:${tenantId}`).emit('wa:campana:progreso', { campanaId, ...datos });
  res.json({ success: true });
});

// ── Log en vivo de envío ──────────────────────────────────────
app.post('/wa/campana/log', authInternal, (req, res) => {
  const { tenantId, campanaId, ...entrada } = req.body;
  if (tenantId && campanaId)
    io.to(`tenant:${tenantId}`).emit('wa:campana:log', { campanaId, ...entrada });
  res.json({ success: true });
});

// ── Historias — publicar ahora ────────────────────────────────
app.post('/wa/historia/publicar', authInternal, async (req, res) => {
  try {
    const { tenantId, historiaId, imagenUrl, texto } = req.body;
    if (!tenantId) return res.status(422).json({ success: false, message: 'tenantId requerido' });

    await publicarHistoria(parseInt(tenantId), imagenUrl, texto);

    // Actualizar estado en BD si viene con historiaId
    if (historiaId) {
      const conn = await getTenantConn(parseInt(tenantId));
      await conn.execute(
        "UPDATE wa_historias SET estado='publicada', publicada_at=NOW() WHERE id=?",
        [historiaId]
      );
      await conn.end();
    }

    io.to(`tenant:${tenantId}`).emit('wa:historia:publicada', { historiaId });
    res.json({ success: true, message: 'Historia publicada.' });
  } catch (err) {
    // Marcar como fallida
    if (req.body.historiaId) {
      try {
        const conn = await getTenantConn(parseInt(req.body.tenantId));
        await conn.execute(
          "UPDATE wa_historias SET estado='fallida', error_msg=? WHERE id=?",
          [err.message.substring(0, 500), req.body.historiaId]
        );
        await conn.end();
      } catch {}
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status   : 'ok',
    sesiones : sesiones.size,
    uptime   : process.uptime(),
    azure    : !!containerClient,
  });
});

// ══════════════════════════════════════════════════════════════
// WEBSOKET
// ══════════════════════════════════════════════════════════════
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

  socket.on('wa:suscribir:campana', ({ tenantId, campanaId }) => {
    socket.join(`campana:${campanaId}`);
  });
});

function emitirProgresoCampana(tenantId, campanaId, datos) {
  io.to(`tenant:${tenantId}`).emit('wa:campana:progreso', { campanaId, ...datos });
}

function emitirLogCampana(tenantId, campanaId, entrada) {
  io.to(`tenant:${tenantId}`).emit('wa:campana:log', { campanaId, ...entrada });
}

module.exports = { io, emitirProgresoCampana, emitirLogCampana };

// ══════════════════════════════════════════════════════════════
// PROGRAMADOR DE HISTORIAS (cada 60s)
// ══════════════════════════════════════════════════════════════
async function procesarHistoriasProgramadas() {
  try {
    // Buscar todos los tenants con sesión activa
    const tenants = await masterQuery(
      "SELECT tenant_id FROM wa_sesiones WHERE estado='conectado'"
    );

    for (const { tenant_id } of tenants) {
      const sesion = sesiones.get(tenant_id);
      if (!sesion || sesion.estado !== 'conectado') continue;

      const conn = await getTenantConn(tenant_id);
      try {
        const [historias] = await conn.execute(
          `SELECT id, imagen_url, texto
           FROM wa_historias
           WHERE estado = 'programada'
             AND programada_at <= NOW()
           LIMIT 3`
        );

        for (const h of historias) {
          try {
            await publicarHistoria(tenant_id, h.imagen_url, h.texto);
            await conn.execute(
              "UPDATE wa_historias SET estado='publicada', publicada_at=NOW() WHERE id=?",
              [h.id]
            );
            io.to(`tenant:${tenant_id}`).emit('wa:historia:publicada', { historiaId: h.id });
            console.log(`[WA Historias] ✅ tenant:${tenant_id} historia:${h.id}`);
          } catch (e) {
            await conn.execute(
              "UPDATE wa_historias SET estado='fallida', error_msg=? WHERE id=?",
              [e.message.substring(0, 500), h.id]
            );
            console.error(`[WA Historias] ❌ historia:${h.id}:`, e.message);
          }
          await new Promise(r => setTimeout(r, 2000));
        }
      } finally {
        await conn.end();
      }
    }
  } catch (e) {
    console.error('[WA Historias scheduler]', e.message);
  }
}

setInterval(procesarHistoriasProgramadas, 60 * 1000);

// ══════════════════════════════════════════════════════════════
// RESTAURAR SESIONES AL INICIAR
// ══════════════════════════════════════════════════════════════
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
    console.log(`[WA] Restaurando ${activas.length} sesiones...`);
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

// Health check de sesiones cada 5 min
setInterval(async () => {
  for (const [tenantId, sesion] of sesiones.entries()) {
    if (sesion.estado === 'error') {
      const [t] = await masterQuery('SELECT slug FROM tenants WHERE id=?', [tenantId]);
      if (t) await limpiarSesion(tenantId, t.slug, 'error');
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, async () => {
  console.log(`[WA Gateway v3] ✅ Puerto ${PORT}`);
  console.log(`[WA Gateway v3] Sessions: ${SESSIONS_DIR}`);
  console.log(`[WA Gateway v3] Azure: ${containerClient ? '✅ ' + AZURE_CONTAINER : '❌ No configurado'}`);
  await restaurarSesiones();
});

process.on('uncaughtException',  (err) => console.error('[WA uncaught]',  err.message));
process.on('unhandledRejection', (err) => console.error('[WA unhandled]', err?.message));