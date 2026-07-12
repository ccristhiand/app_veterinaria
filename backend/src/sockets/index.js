'use strict';

const { verifySocketToken } = require('../middlewares/auth.middleware');
const { query }             = require('../config/database');
const logger                = require('../config/logger');

// ── Nombres de eventos (contrato frontend ↔ backend) ────────────────────────
const EVENTS = {
  // Citas
  CITA_NUEVA       : 'cita:nueva',
  CITA_ACTUALIZADA : 'cita:actualizada',
  CITA_CANCELADA   : 'cita:cancelada',
  // Notificaciones
  NOTIF_STOCK      : 'notif:stock_minimo',
  NOTIF_VACUNA     : 'notif:vacuna_recordatorio',
  NOTIF_SISTEMA    : 'notif:sistema',
  // Sala por rol (para salas de Socket.io)
  ROOM_VETS        : 'sala:veterinarios',
  ROOM_RECEP       : 'sala:recepcionistas',
  ROOM_ADMIN       : 'sala:admin',
};

/**
 * Inicializa Socket.io con autenticación JWT middleware
 * y registra los manejadores de eventos.
 */
function initSocket(io) {

  // ── Middleware de autenticación para CADA conexión ─────────────────────────
  io.use(async (socket, next) => {
    try {
      // Token enviado en handshake: io({ auth: { token } }) o como query param
      const token = socket.handshake.auth?.token
                 || socket.handshake.query?.token;

      const user = await verifySocketToken(token);
      socket.user = user;  // disponible en todos los handlers de este socket
      next();
    } catch (err) {
      logger.warn(`Socket rechazado (auth fallida): ${err.message}`);
      next(new Error('UNAUTHORIZED'));
    }
  });

  // ── Conexión establecida ───────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const { id: userId, nombre, rol } = socket.user;
    logger.info(`🔗  Socket conectado | user=${nombre} (${rol}) | socket=${socket.id}`);

    // Unir al usuario a su sala de rol (para broadcast segmentado)
    const roomByRol = {
      admin          : [EVENTS.ROOM_ADMIN, EVENTS.ROOM_VETS, EVENTS.ROOM_RECEP],
      veterinario    : [EVENTS.ROOM_VETS],
      recepcionista  : [EVENTS.ROOM_RECEP],
    };
    (roomByRol[rol] || []).forEach((room) => socket.join(room));

    // Sala personal (para notificaciones privadas)
    socket.join(`user:${userId}`);

    // ── Ping para verificar que sigue vivo ──────────────────────────────────
    socket.on('ping', (cb) => {
      if (typeof cb === 'function') cb({ pong: true, ts: Date.now() });
    });

    socket.on('disconnect', (reason) => {
      logger.info(`🔌  Socket desconectado | user=${nombre} | motivo=${reason}`);
    });
  });

  logger.info('Socket.io inicializado correctamente');
}

// ── Helpers de emisión (usados desde los controladores) ───────────────────────

/**
 * Emite evento de nueva cita a los veterinarios y admins.
 * @param {import('socket.io').Server} io
 * @param {Object} cita - datos completos de la cita (JOIN con mascota/propietario)
 */
async function emitirNuevaCita(io, cita) {
  // Guardar notificación en BD
  await query(
    `INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje)
     VALUES (?, 'cita_nueva', ?, ?)`,
    [
      cita.veterinario_id,
      `Nueva cita: ${cita.mascota_nombre}`,
      `${cita.motivo} — ${formatFecha(cita.fecha_hora)}`,
    ],
  );

  // Emitir a la sala de veterinarios Y al veterinario específico
  io.to(EVENTS.ROOM_VETS)
    .to(EVENTS.ROOM_ADMIN)
    .to(`user:${cita.veterinario_id}`)
    .emit(EVENTS.CITA_NUEVA, {
      type: EVENTS.CITA_NUEVA,
      payload: cita,
      ts: new Date().toISOString(),
    });

  logger.info(`📅  Evento ${EVENTS.CITA_NUEVA} emitido para cita #${cita.id}`);
}

/**
 * Emite alerta de stock mínimo a admins y recepcionistas.
 * @param {import('socket.io').Server} io
 * @param {Object} item - { id, nombre, cantidad, stock_minimo }
 */
async function emitirAlertaStock(io, item) {
  await query(
    `INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje)
     VALUES (NULL, 'stock_minimo', ?, ?)`,
    [
      `⚠️ Stock bajo: ${item.nombre}`,
      `Quedan ${item.cantidad} ${item.unidad}. Mínimo: ${item.stock_minimo}.`,
    ],
  );

  io.to(EVENTS.ROOM_ADMIN)
    .to(EVENTS.ROOM_RECEP)
    .emit(EVENTS.NOTIF_STOCK, {
      type: EVENTS.NOTIF_STOCK,
      payload: item,
      ts: new Date().toISOString(),
    });
}

/**
 * Emite recordatorio de vacuna (llamado desde un job diario o al registrar vacuna).
 * @param {import('socket.io').Server} io
 * @param {Object} vacuna
 */
async function emitirRecordatorioVacuna(io, vacuna) {
  io.to(EVENTS.ROOM_VETS)
    .to(EVENTS.ROOM_ADMIN)
    .emit(EVENTS.NOTIF_VACUNA, {
      type: EVENTS.NOTIF_VACUNA,
      payload: vacuna,
      ts: new Date().toISOString(),
    });
}

// ── Utilidades ────────────────────────────────────────────────────────────────
function formatFecha(fecha) {
  return new Date(fecha).toLocaleString('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

module.exports = {
  initSocket,
  emitirNuevaCita,
  emitirAlertaStock,
  emitirRecordatorioVacuna,
  EVENTS,
};
