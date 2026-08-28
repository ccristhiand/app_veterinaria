'use strict';

/**
 * VetNetcodip SaaS — Módulo de Asistencia del Personal
 * Base: /api/v1/asistencia
 *
 * Admin : gestiona turnos, ve reportes de todos
 * Empleado: ve su turno del día y marca asistencia (irreversible, 1 vez/día)
 */

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');

const router = Router();
router.use(authenticate);

// ── Helpers ───────────────────────────────────────────────────────

// Fecha actual en Lima (YYYY-MM-DD)
function hoyLima() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Lima' });
}

// Hora actual en Lima (HH:MM:SS)
function horaLima() {
  return new Date().toLocaleTimeString('sv-SE', { timeZone: 'America/Lima' });
}

// Diferencia en minutos entre hora_marcada y hora_inicio del turno
// Positivo = tarde, Negativo = adelantado
function calcMinDiff(horaTurno, horaMarcada) {
  const [h1, m1] = horaTurno.split(':').map(Number);
  const [h2, m2] = horaMarcada.split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}

// Estado según diferencia (tolerancia ±5 min)
function calcEstado(minDiff) {
  if (minDiff <= 5)  return 'puntual';
  if (minDiff > 5)   return 'tarde';
  return 'adelantado'; // minDiff < -5 (nunca llega aquí con la lógica anterior)
}
function calcEstadoCompleto(minDiff) {
  if (minDiff > 5)   return 'tarde';
  if (minDiff < -5)  return 'adelantado';
  return 'puntual';
}

// ══════════════════════════════════════════════════════════════════
// TURNOS — gestión por admin
// ══════════════════════════════════════════════════════════════════

// ── GET /api/v1/asistencia/turnos — listar turnos ─────────────────
// ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&sede_id=N&usuario_id=N
router.get('/turnos', authorize('admin'), async (req, res, next) => {
  try {
    const { desde, hasta, sede_id, usuario_id } = req.query;
    const hoy   = hoyLima();
    const d     = desde || hoy;
    const h     = hasta || hoy;

    let sql = `
      SELECT t.id, t.fecha, t.hora_inicio, t.hora_fin, t.notas,
             t.sede_id, s.nombre AS sede_nombre,
             t.usuario_id,
             u.nombre AS usuario_nombre, u.rol AS usuario_rol,
             a.id AS asistencia_id, a.hora_marcada, a.estado, a.minutos_diff
      FROM turnos t
      JOIN usuarios u ON u.id = t.usuario_id
      LEFT JOIN sedes s ON s.id = t.sede_id
      LEFT JOIN asistencias a ON a.turno_id = t.id
      WHERE t.fecha BETWEEN ? AND ?`;
    const params = [d, h];

    if (sede_id)    { sql += ' AND t.sede_id = ?';   params.push(parseInt(sede_id)); }
    if (usuario_id) { sql += ' AND t.usuario_id = ?'; params.push(parseInt(usuario_id)); }

    sql += ' ORDER BY t.fecha ASC, t.hora_inicio ASC, u.nombre ASC';

    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/v1/asistencia/turnos/semana — vista semanal ──────────
// ?fecha=YYYY-MM-DD (cualquier día de la semana)&sede_id=N
router.get('/turnos/semana', authorize('admin'), async (req, res, next) => {
  try {
    const { fecha, sede_id } = req.query;
    const base  = new Date((fecha || hoyLima()) + 'T12:00:00');
    const dia   = base.getDay(); // 0=dom
    const lunes = new Date(base);
    lunes.setDate(base.getDate() - (dia === 0 ? 6 : dia - 1));
    const domingo = new Date(lunes);
    domingo.setDate(lunes.getDate() + 6);

    const fmt = d => d.toLocaleDateString('sv-SE');
    const desde = fmt(lunes);
    const hasta  = fmt(domingo);

    let sql = `
      SELECT t.id, t.fecha, t.hora_inicio, t.hora_fin, t.notas,
             t.sede_id, s.nombre AS sede_nombre,
             t.usuario_id,
             u.nombre AS usuario_nombre, u.rol AS usuario_rol,
             a.id AS asistencia_id, a.hora_marcada, a.estado, a.minutos_diff
      FROM turnos t
      JOIN usuarios u ON u.id = t.usuario_id
      LEFT JOIN sedes s ON s.id = t.sede_id
      LEFT JOIN asistencias a ON a.turno_id = t.id
      WHERE t.fecha BETWEEN ? AND ?`;
    const params = [desde, hasta];
    if (sede_id) { sql += ' AND t.sede_id = ?'; params.push(parseInt(sede_id)); }
    sql += ' ORDER BY t.fecha ASC, t.hora_inicio ASC';

    const turnos = await req.db.query(sql, params);
    return res.json({ success: true, data: turnos, semana: { desde, hasta } });
  } catch (err) { next(err); }
});

// ── POST /api/v1/asistencia/turnos — crear turno ─────────────────
router.post('/turnos', authorize('admin'), auditMiddleware('asistencia:turno_creado', 'asistencia'), async (req, res, next) => {
  try {
    const { usuario_id, sede_id, fecha, hora_inicio, hora_fin, notas } = req.body;

    if (!usuario_id) return res.status(422).json({ success: false, message: 'usuario_id requerido.' });
    if (!fecha)      return res.status(422).json({ success: false, message: 'fecha requerida.' });
    if (!hora_inicio || !hora_fin)
      return res.status(422).json({ success: false, message: 'hora_inicio y hora_fin requeridos.' });
    if (hora_fin <= hora_inicio)
      return res.status(422).json({ success: false, message: 'hora_fin debe ser mayor que hora_inicio.' });

    // Verificar que el usuario existe
    const [usr] = await req.db.query('SELECT id, nombre FROM usuarios WHERE id = ? AND activo = 1', [usuario_id]);
    if (!usr) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });

    const result = await req.db.query(
      `INSERT INTO turnos (usuario_id, sede_id, fecha, hora_inicio, hora_fin, notas, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         hora_inicio = VALUES(hora_inicio),
         hora_fin    = VALUES(hora_fin),
         sede_id     = VALUES(sede_id),
         notas       = VALUES(notas),
         updated_at  = NOW()`,
      [usuario_id, sede_id || null, fecha, hora_inicio, hora_fin, notas?.trim() || null, req.user.id]
    );

    return res.status(201).json({
      success: true,
      message: `Turno asignado a ${usr.nombre} para el ${fecha}.`,
      data: { id: result.insertId || null },
    });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/asistencia/turnos/:id — editar turno ─────────────
router.put('/turnos/:id', authorize('admin'), auditMiddleware('asistencia:turno_actualizado', 'asistencia'), async (req, res, next) => {
  try {
    const { hora_inicio, hora_fin, sede_id, notas } = req.body;
    if (!hora_inicio || !hora_fin)
      return res.status(422).json({ success: false, message: 'hora_inicio y hora_fin requeridos.' });
    if (hora_fin <= hora_inicio)
      return res.status(422).json({ success: false, message: 'hora_fin debe ser mayor que hora_inicio.' });

    const [turno] = await req.db.query('SELECT id FROM turnos WHERE id = ?', [req.params.id]);
    if (!turno) return res.status(404).json({ success: false, message: 'Turno no encontrado.' });

    // No editar si ya tiene asistencia marcada
    const [asis] = await req.db.query('SELECT id FROM asistencias WHERE turno_id = ?', [req.params.id]);
    if (asis) return res.status(422).json({ success: false, message: 'No puedes editar un turno que ya tiene asistencia marcada.' });

    await req.db.query(
      'UPDATE turnos SET hora_inicio=?, hora_fin=?, sede_id=?, notas=? WHERE id=?',
      [hora_inicio, hora_fin, sede_id || null, notas?.trim() || null, req.params.id]
    );
    return res.json({ success: true, message: 'Turno actualizado.' });
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/asistencia/turnos/:id — eliminar turno ─────────
router.delete('/turnos/:id', authorize('admin'), auditMiddleware('asistencia:turno_eliminado', 'asistencia'), async (req, res, next) => {
  try {
    const [turno] = await req.db.query('SELECT id FROM turnos WHERE id = ?', [req.params.id]);
    if (!turno) return res.status(404).json({ success: false, message: 'Turno no encontrado.' });

    const [asis] = await req.db.query('SELECT id FROM asistencias WHERE turno_id = ?', [req.params.id]);
    if (asis) return res.status(422).json({ success: false, message: 'No puedes eliminar un turno con asistencia ya marcada.' });

    await req.db.query('DELETE FROM turnos WHERE id = ?', [req.params.id]);
    return res.json({ success: true, message: 'Turno eliminado.' });
  } catch (err) { next(err); }
});

// ── POST /api/v1/asistencia/turnos/lote — crear turnos en lote ───
// Asignar el mismo horario a múltiples usuarios y/o múltiples fechas
router.post('/turnos/lote', authorize('admin'), async (req, res, next) => {
  try {
    const { usuarios, fechas, sede_id, hora_inicio, hora_fin, notas } = req.body;
    if (!usuarios?.length) return res.status(422).json({ success: false, message: 'Selecciona al menos un usuario.' });
    if (!fechas?.length)   return res.status(422).json({ success: false, message: 'Selecciona al menos una fecha.' });
    if (!hora_inicio || !hora_fin) return res.status(422).json({ success: false, message: 'Horario requerido.' });

    let creados = 0;
    for (const uid of usuarios) {
      for (const fecha of fechas) {
        await req.db.query(
          `INSERT INTO turnos (usuario_id, sede_id, fecha, hora_inicio, hora_fin, notas, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             hora_inicio=VALUES(hora_inicio), hora_fin=VALUES(hora_fin),
             sede_id=VALUES(sede_id), notas=VALUES(notas), updated_at=NOW()`,
          [uid, sede_id || null, fecha, hora_inicio, hora_fin, notas?.trim() || null, req.user.id]
        );
        creados++;
      }
    }
    return res.status(201).json({ success: true, message: `${creados} turno(s) asignados correctamente.` });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// ASISTENCIA — marcado por el empleado
// ══════════════════════════════════════════════════════════════════

// ── GET /api/v1/asistencia/mi-turno — turno del día del usuario ───
router.get('/mi-turno', async (req, res, next) => {
  try {
    const hoy = hoyLima();
    const [turno] = await req.db.query(
      `SELECT t.id, t.fecha, t.hora_inicio, t.hora_fin, t.notas,
              s.nombre AS sede_nombre,
              a.id AS asistencia_id, a.hora_marcada, a.estado, a.minutos_diff
       FROM turnos t
       LEFT JOIN sedes s ON s.id = t.sede_id
       LEFT JOIN asistencias a ON a.turno_id = t.id AND a.usuario_id = ?
       WHERE t.usuario_id = ? AND t.fecha = ?`,
      [req.user.id, req.user.id, hoy]
    );
    return res.json({ success: true, data: turno || null, hoy });
  } catch (err) { next(err); }
});

// ── POST /api/v1/asistencia/marcar — marcar asistencia ───────────
// Irreversible: solo se puede marcar una vez por día
router.post('/marcar', async (req, res, next) => {
  try {
    const hoy  = hoyLima();
    const hora = horaLima().substring(0, 8); // HH:MM:SS

    // Verificar que tiene turno hoy
    const [turno] = await req.db.query(
      'SELECT id, hora_inicio, hora_fin FROM turnos WHERE usuario_id = ? AND fecha = ?',
      [req.user.id, hoy]
    );
    if (!turno) {
      return res.status(404).json({ success: false, message: 'No tienes turno asignado para hoy.' });
    }

    // Verificar que no haya marcado ya
    const [existente] = await req.db.query(
      'SELECT id FROM asistencias WHERE usuario_id = ? AND fecha = ?',
      [req.user.id, hoy]
    );
    if (existente) {
      return res.status(422).json({ success: false, message: 'Ya registraste tu asistencia hoy. Solo se puede marcar una vez.' });
    }

    const minDiff = calcMinDiff(turno.hora_inicio, hora);
    const estado  = calcEstadoCompleto(minDiff);
    const ip      = req.ip || req.headers['x-real-ip'] || null;

    await req.db.query(
      `INSERT INTO asistencias (turno_id, usuario_id, fecha, hora_marcada, estado, minutos_diff, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [turno.id, req.user.id, hoy, hora, estado, minDiff, ip]
    );

    const msgs = {
      puntual    : '✅ Asistencia registrada — llegaste puntual.',
      tarde      : `⚠️ Asistencia registrada — llegaste ${Math.abs(minDiff)} min tarde.`,
      adelantado : `🌟 Asistencia registrada — llegaste ${Math.abs(minDiff)} min antes.`,
    };

    return res.status(201).json({
      success: true,
      message: msgs[estado],
      data: { estado, minutos_diff: minDiff, hora_marcada: hora, hora_turno: turno.hora_inicio },
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// REPORTES — solo admin
// ══════════════════════════════════════════════════════════════════

// ── GET /api/v1/asistencia/reporte — KPIs y detalle ──────────────
// ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&sede_id=N&usuario_id=N
router.get('/reporte', authorize('admin'), async (req, res, next) => {
  try {
    const { desde, hasta, sede_id, usuario_id } = req.query;
    const hoy = hoyLima();
    const d   = desde || hoy;
    const h   = hasta || hoy;

    let sfTurno = 'WHERE t.fecha BETWEEN ? AND ?';
    const params = [d, h];
    if (sede_id)    { sfTurno += ' AND t.sede_id = ?';    params.push(parseInt(sede_id)); }
    if (usuario_id) { sfTurno += ' AND t.usuario_id = ?'; params.push(parseInt(usuario_id)); }

    // KPIs globales
    const [kpis] = await req.db.query(
      `SELECT
         COUNT(t.id)                                   AS total_turnos,
         COUNT(a.id)                                   AS total_marcados,
         COUNT(t.id) - COUNT(a.id)                     AS total_ausentes,
         SUM(CASE WHEN a.estado='puntual'    THEN 1 ELSE 0 END) AS puntuales,
         SUM(CASE WHEN a.estado='tarde'      THEN 1 ELSE 0 END) AS tardanzas,
         SUM(CASE WHEN a.estado='adelantado' THEN 1 ELSE 0 END) AS adelantados,
         ROUND(COUNT(a.id) * 100.0 / NULLIF(COUNT(t.id),0), 1) AS pct_asistencia
       FROM turnos t
       LEFT JOIN asistencias a ON a.turno_id = t.id
       ${sfTurno}`,
      params
    );

    // Por usuario
    const porUsuario = await req.db.query(
      `SELECT
         u.id, u.nombre, u.rol,
         s.nombre AS sede_nombre,
         COUNT(t.id)                                   AS turnos,
         COUNT(a.id)                                   AS marcados,
         COUNT(t.id) - COUNT(a.id)                     AS ausentes,
         SUM(CASE WHEN a.estado='puntual'    THEN 1 ELSE 0 END) AS puntuales,
         SUM(CASE WHEN a.estado='tarde'      THEN 1 ELSE 0 END) AS tardanzas,
         SUM(CASE WHEN a.estado='adelantado' THEN 1 ELSE 0 END) AS adelantados,
         ROUND(AVG(CASE WHEN a.estado='tarde' THEN a.minutos_diff END), 0) AS avg_tardanza_min,
         ROUND(COUNT(a.id) * 100.0 / NULLIF(COUNT(t.id),0), 1)            AS pct_asistencia
       FROM turnos t
       JOIN usuarios u ON u.id = t.usuario_id
       LEFT JOIN sedes s ON s.id = t.sede_id
       LEFT JOIN asistencias a ON a.turno_id = t.id
       ${sfTurno}
       GROUP BY u.id, u.nombre, u.rol, s.nombre
       ORDER BY pct_asistencia DESC, u.nombre ASC`,
      params
    );

    // Detalle diario
    const detalle = await req.db.query(
      `SELECT
         t.fecha, t.hora_inicio, t.hora_fin,
         u.id AS usuario_id, u.nombre AS usuario_nombre, u.rol,
         s.nombre AS sede_nombre,
         a.hora_marcada, a.estado, a.minutos_diff,
         CASE WHEN a.id IS NULL THEN 'ausente' ELSE a.estado END AS estado_final
       FROM turnos t
       JOIN usuarios u ON u.id = t.usuario_id
       LEFT JOIN sedes s ON s.id = t.sede_id
       LEFT JOIN asistencias a ON a.turno_id = t.id
       ${sfTurno}
       ORDER BY t.fecha DESC, t.hora_inicio ASC`,
      params
    );

    return res.json({
      success: true,
      data: { kpis, porUsuario, detalle, periodo: { desde: d, hasta: h } },
    });
  } catch (err) { next(err); }
});

module.exports = router;