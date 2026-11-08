'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');
const { emitirTenant } = require('../sockets/emitir');

const { filtroSede, sedeEscritura, exigirAcceso } = require('../services/sede.service');

const router = Router();
router.use(authenticate);

// GET /api/v1/citas
router.get('/', async (req, res, next) => {
  try {
    const { fecha, desde, hasta, estado, veterinario_id, mascota_id, tipo_cita, search } = req.query;

    let sql = `
      SELECT c.*, m.nombre AS mascota_nombre, m.especie,
             CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre, p.telefono,
             u.nombre AS veterinario_nombre,
             s.nombre AS sede_nombre
      FROM citas c
      JOIN mascotas m ON m.id = c.mascota_id
      JOIN propietarios p ON p.id = m.propietario_id
      JOIN usuarios u ON u.id = c.veterinario_id
      LEFT JOIN sedes s ON s.id = c.sede_id
      WHERE 1=1`;
    const params = [];

    const fs = filtroSede(req, 'c.sede_id');
    sql += ` ${fs.sql}`; params.push(...fs.params);
    const tz = req.tzOffset || '-05:00';
    if (fecha)          { sql += ' AND DATE(CONVERT_TZ(c.fecha_hora, \'+00:00\', ?)) = ?'; params.push(tz, fecha); }
    if (desde && !fecha){ sql += ' AND DATE(CONVERT_TZ(c.fecha_hora, \'+00:00\', ?)) >= ?'; params.push(tz, desde); }
    if (hasta && !fecha){ sql += ' AND DATE(CONVERT_TZ(c.fecha_hora, \'+00:00\', ?)) <= ?'; params.push(tz, hasta); }
    if (estado)         { sql += ' AND c.estado = ?';          params.push(estado); }
    if (veterinario_id) { sql += ' AND c.veterinario_id = ?';  params.push(veterinario_id); }
    if (mascota_id)     { sql += ' AND c.mascota_id = ?';      params.push(mascota_id); }
    if (tipo_cita)      { sql += ' AND c.tipo_cita = ?';       params.push(tipo_cita); }
    if (req.user.rol === 'groomer') sql += " AND c.tipo_cita = 'estetica'";
    if (search) {
      sql += ` AND (m.nombre LIKE ? OR p.nombre LIKE ? OR p.apellido LIKE ?
               OR p.dni LIKE ? OR p.telefono LIKE ? OR c.motivo LIKE ?)`;
      const q = `%${search}%`;
      params.push(q, q, q, q, q, q);
    }

    sql += ' ORDER BY c.fecha_hora ASC';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// Groomer: solo trabaja con citas de estética (las ve, crea, edita y cambia de estado)
const esGroomer = req => req.user?.rol === 'groomer';
async function citaAjenaAlGroomer(req) {
  if (!esGroomer(req)) return false;
  const [c] = await req.db.query('SELECT tipo_cita FROM citas WHERE id = ?', [req.params.id]);
  return !c || c.tipo_cita !== 'estetica';
}
async function exigirSedeDeCita(req) {
  const [c] = await req.db.query('SELECT sede_id FROM citas WHERE id = ?', [req.params.id]);
  if (c) exigirAcceso(req, c.sede_id);
}

// Un veterinario inactivo no recibe citas nuevas; al editar se permite conservar el que ya tenía la cita
async function veterinarioInactivo(req, veterinarioId, citaId = null) {
  const [u] = await req.db.query(
    `SELECT 1 AS inactivo FROM usuarios u
     WHERE u.id = ? AND u.activo = 0
       AND NOT EXISTS (SELECT 1 FROM citas c WHERE c.id = ? AND c.veterinario_id = u.id)`,
    [veterinarioId, citaId]
  );
  return !!u;
}

// GET /api/v1/citas/:id
router.get('/:id', async (req, res, next) => {
  try {
    const [cita] = await req.db.query(
      `SELECT c.*, m.nombre AS mascota_nombre, m.especie, m.raza,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre, p.telefono,
              u.nombre AS veterinario_nombre,
              s.nombre AS sede_nombre
       FROM citas c
       JOIN mascotas m ON m.id = c.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       JOIN usuarios u ON u.id = c.veterinario_id
       LEFT JOIN sedes s ON s.id = c.sede_id
       WHERE c.id = ?`, [req.params.id]
    );
    if (!cita || (esGroomer(req) && cita.tipo_cita !== 'estetica'))
      return res.status(404).json({ success: false, message: 'Cita no encontrada.' });
    exigirAcceso(req, cita.sede_id);
    return res.json({ success: true, data: cita });
  } catch (err) { next(err); }
});

// POST /api/v1/citas
router.post('/', auditMiddleware('citas:creado', 'citas'), async (req, res, next) => {
  try {
    const { mascota_id, veterinario_id, fecha_hora, duracion_min, motivo, notas,
            tipo_cita = 'medica' } = req.body;

    if (!mascota_id || !veterinario_id || !fecha_hora || !motivo)
      return res.status(422).json({ success: false, message: 'Campos obligatorios faltantes.' });
    if (await veterinarioInactivo(req, veterinario_id))
      return res.status(422).json({ success: false, message: 'El veterinario seleccionado está inactivo.' });

    const tiposValidos = ['medica','vacuna','desparasitacion','estetica'];
    const tipoCitaFinal = esGroomer(req) ? 'estetica' : (tiposValidos.includes(tipo_cita) ? tipo_cita : 'medica');

    const sedeId = sedeEscritura(req);

    const result = await req.db.query(
      `INSERT INTO citas
         (mascota_id, veterinario_id, creada_por_id, sede_id, fecha_hora, duracion_min, motivo, notas, tipo_cita)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [mascota_id, veterinario_id, req.user.id, sedeId,
       fecha_hora, duracion_min || 30, motivo, notas || null, tipoCitaFinal]
    );

    const io = req.app.get('io');
    if (io) {
      const [cita] = await req.db.query(
        `SELECT c.*, m.nombre AS mascota_nombre,
                CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre
         FROM citas c
         JOIN mascotas m ON m.id = c.mascota_id
         JOIN propietarios p ON p.id = m.propietario_id
         WHERE c.id = ?`, [result.insertId]
      );
      emitirTenant(req, 'cita:nueva', { type: 'cita:nueva', payload: cita });
    }

    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
});

// PUT /api/v1/citas/:id
router.put('/:id', auditMiddleware('citas:actualizado', 'citas'), async (req, res, next) => {
  try {
    const { fecha_hora, duracion_min, motivo, notas, estado, veterinario_id,
            tipo_cita } = req.body;

    if (await citaAjenaAlGroomer(req))
      return res.status(404).json({ success: false, message: 'Cita no encontrada.' });
    await exigirSedeDeCita(req);
    if (await veterinarioInactivo(req, veterinario_id, req.params.id))
      return res.status(422).json({ success: false, message: 'El veterinario seleccionado está inactivo.' });
    const tiposValidos = ['medica','vacuna','desparasitacion','estetica'];
    const tipoCitaFinal = esGroomer(req) ? 'estetica' : (tiposValidos.includes(tipo_cita) ? tipo_cita : 'medica');

    await req.db.query(
      `UPDATE citas
         SET fecha_hora=?, duracion_min=?, motivo=?, notas=?, estado=?,
             veterinario_id=?, tipo_cita=?
       WHERE id=?`,
      [fecha_hora, duracion_min || 30, motivo, notas || null,
       estado || 'pendiente', veterinario_id, tipoCitaFinal, req.params.id]
    );

    const io = req.app.get('io');
    if (io) emitirTenant(req, 'cita:actualizada', { type: 'cita:actualizada', payload: { id: req.params.id } });
    return res.json({ success: true, message: 'Cita actualizada.' });
  } catch (err) { next(err); }
});

// PATCH /api/v1/citas/:id/estado
router.patch('/:id/estado', auditMiddleware('citas:actualizado', 'citas'), async (req, res, next) => {
  try {
    const { estado } = req.body;
    if (await citaAjenaAlGroomer(req))
      return res.status(404).json({ success: false, message: 'Cita no encontrada.' });
    await exigirSedeDeCita(req);
    await req.db.query('UPDATE citas SET estado=? WHERE id=?', [estado, req.params.id]);
    const io = req.app.get('io');
    if (io) emitirTenant(req, 'cita:actualizada', { type: 'cita:actualizada', payload: { id: req.params.id, estado } });
    return res.json({ success: true, message: 'Estado actualizado.' });
  } catch (err) { next(err); }
});

// ── Eliminación de citas ──────────────────────────────────────────
// Solo se elimina una cita que NO tuvo atención. Si ya se atendió (consulta, estética,
// comprobante, o quedó en curso/completada) se rechaza: forma parte del historial.
const ROLES_ELIMINAR_CITA = ['admin', 'recepcionista', 'veterinario', 'veterinario_recepcionista'];

async function analizarEliminacion(db, id) {
  const [cita] = await db.query(
    `SELECT c.id, c.estado, c.tipo_cita, c.fecha_hora, c.motivo, c.mascota_id, c.sede_id,
            m.nombre AS mascota_nombre, m.especie,
            CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
            u.nombre AS veterinario_nombre
     FROM citas c
     JOIN mascotas m     ON m.id = c.mascota_id
     JOIN propietarios p ON p.id = m.propietario_id
     JOIN usuarios u     ON u.id = c.veterinario_id
     WHERE c.id = ?`, [id]
  );
  if (!cita) return null;

  const [[hc], [est], facturas] = await Promise.all([
    db.query('SELECT COUNT(*) AS n FROM historia_clinica   WHERE cita_id = ?', [id]),
    db.query('SELECT COUNT(*) AS n FROM servicios_estetica WHERE cita_id = ?', [id]),
    db.query("SELECT numero FROM facturas WHERE cita_id = ? ORDER BY id LIMIT 5", [id]),
  ]);

  const motivos = [];
  if (hc.n  > 0) motivos.push(`Tiene ${hc.n > 1 ? hc.n + ' consultas registradas' : 'una consulta registrada'} en la historia clínica.`);
  if (est.n > 0) motivos.push(`Tiene ${est.n > 1 ? est.n + ' servicios' : 'un servicio'} de estética registrado.`);
  if (facturas.length) motivos.push(`Está vinculada al comprobante ${facturas.map(f => f.numero).join(', ')}.`);
  if (cita.estado === 'completada') motivos.push('La cita figura como completada (ya fue atendida).');
  if (cita.estado === 'en_curso')   motivos.push('La cita está en curso de atención.');

  return { cita, eliminable: motivos.length === 0, motivos };
}

// GET /api/v1/citas/:id/eliminable — verificación previa para el modal
router.get('/:id/eliminable', authorize(...ROLES_ELIMINAR_CITA), async (req, res, next) => {
  try {
    const r = await analizarEliminacion(req.db, req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Cita no encontrada.' });
    exigirAcceso(req, r.cita.sede_id);
    return res.json({ success: true, data: r });
  } catch (err) { next(err); }
});

// DELETE /api/v1/citas/:id   { motivo? }
router.delete('/:id', authorize(...ROLES_ELIMINAR_CITA), auditMiddleware('citas:eliminado', 'citas'), async (req, res, next) => {
  try {
    const r = await analizarEliminacion(req.db, req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Cita no encontrada.' });
    exigirAcceso(req, r.cita.sede_id);
    if (!r.eliminable) {
      return res.status(409).json({
        success: false,
        code   : 'CITA_CON_ATENCION',
        message: 'No se puede eliminar esta cita porque ya tiene una atención registrada.',
        motivos: r.motivos,
      });
    }

    await req.db.query('DELETE FROM citas WHERE id = ?', [req.params.id]);

    const io = req.app.get('io');
    if (io) emitirTenant(req, 'cita:eliminada', { type: 'cita:eliminada', payload: { id: Number(req.params.id) } });
    return res.json({ success: true, message: 'Cita eliminada.' });
  } catch (err) { next(err); }
});

module.exports = router;