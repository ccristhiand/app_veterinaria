'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');

const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { search = '', page = 1, limit = 20 } = req.query;
    const limitN  = Math.min(parseInt(limit) || 20, 100);
    const offsetN = (Math.max(parseInt(page) || 1, 1) - 1) * limitN;
    const q = `%${search}%`;

    const rows = await req.db.query(
      `SELECT m.*, CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
              p.telefono, p.dni AS propietario_dni
       FROM mascotas m
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE m.nombre LIKE ? OR m.raza LIKE ? OR m.microchip LIKE ?
          OR p.nombre LIKE ? OR p.apellido LIKE ? OR p.dni LIKE ?
       ORDER BY m.nombre
       LIMIT ${limitN} OFFSET ${offsetN}`,
      [q, q, q, q, q, q]
    );

    const [{ total }] = await req.db.query(
      `SELECT COUNT(*) AS total
       FROM mascotas m
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE m.nombre LIKE ? OR m.raza LIKE ? OR m.microchip LIKE ?
          OR p.nombre LIKE ? OR p.apellido LIKE ? OR p.dni LIKE ?`,
      [q, q, q, q, q, q]
    );

    return res.json({ success: true, data: rows, total, page: parseInt(page), limit: limitN });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [m] = await req.db.query(
      `SELECT m.*, CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
              p.telefono, p.email, p.dni AS propietario_dni
       FROM mascotas m
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE m.id = ?`,
      [req.params.id]
    );
    if (!m) return res.status(404).json({ success: false, message: 'Mascota no encontrada.' });

    const vacunas = await req.db.query(
      `SELECT v.*, u.nombre AS veterinario_nombre
       FROM vacunas v JOIN usuarios u ON u.id = v.veterinario_id
       WHERE v.mascota_id = ? ORDER BY v.fecha_aplicacion DESC LIMIT 10`,
      [req.params.id]
    );
    return res.json({ success: true, data: { ...m, vacunas } });
  } catch (err) { next(err); }
});

router.post('/', auditMiddleware('mascotas:creado', 'mascotas'), async (req, res, next) => {
  try {
    const { propietario_id, nombre, especie, raza, sexo, fecha_nacimiento,
            peso_kg, color, microchip, alergias, alertas_medicas } = req.body;
    if (!propietario_id) return res.status(422).json({ success: false, message: 'propietario_id requerido.' });
    if (!nombre?.trim()) return res.status(422).json({ success: false, message: 'Nombre obligatorio.' });
    if (!especie)        return res.status(422).json({ success: false, message: 'Especie obligatoria.' });

    const result = await req.db.query(
      `INSERT INTO mascotas (propietario_id, nombre, especie, raza, sexo, fecha_nacimiento,
       peso_kg, color, microchip, alergias, alertas_medicas)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [propietario_id, nombre.trim(), especie, raza?.trim()||null,
       sexo||'desconocido', fecha_nacimiento||null, peso_kg||null,
       color?.trim()||null, microchip?.trim()||null,
       alergias?.trim()||null, alertas_medicas?.trim()||null]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
});

router.put('/:id', auditMiddleware('mascotas:actualizado', 'mascotas'), async (req, res, next) => {
  try {
    const { nombre, especie, raza, sexo, fecha_nacimiento,
            peso_kg, color, microchip, alergias, alertas_medicas } = req.body;
    if (!nombre?.trim()) return res.status(422).json({ success: false, message: 'Nombre obligatorio.' });
    if (!especie)        return res.status(422).json({ success: false, message: 'Especie obligatoria.' });

    await req.db.query(
      `UPDATE mascotas SET nombre=?, especie=?, raza=?, sexo=?, fecha_nacimiento=?,
       peso_kg=?, color=?, microchip=?, alergias=?, alertas_medicas=? WHERE id=?`,
      [nombre.trim(), especie, raza?.trim()||null, sexo||'desconocido',
       fecha_nacimiento||null, peso_kg||null, color?.trim()||null,
       microchip?.trim()||null, alergias?.trim()||null,
       alertas_medicas?.trim()||null, req.params.id]
    );
    return res.json({ success: true, message: 'Mascota actualizada.' });
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/mascotas/:id ───────────────────────────────────
router.delete('/:id', auditMiddleware('mascotas:eliminado', 'mascotas'), async (req, res, next) => {
  try {
    const [masc] = await req.db.query('SELECT id, nombre FROM mascotas WHERE id = ?', [req.params.id]);
    if (!masc) return res.status(404).json({ success: false, message: 'Mascota no encontrada.' });

    // Verificar registros vinculados
    const checks = await Promise.all([
      req.db.query('SELECT COUNT(*) AS n FROM citas WHERE mascota_id = ?', [req.params.id]),
      req.db.query('SELECT COUNT(*) AS n FROM historia_clinica WHERE mascota_id = ?', [req.params.id]),
      req.db.query('SELECT COUNT(*) AS n FROM desparasitaciones WHERE mascota_id = ?', [req.params.id]),
      req.db.query('SELECT COUNT(*) AS n FROM vacunas WHERE mascota_id = ?', [req.params.id]),
      req.db.query('SELECT COUNT(*) AS n FROM servicios_estetica WHERE mascota_id = ?', [req.params.id]),
    ]);

    const [citas, historia, desparasitaciones, vacunas, estetica] = checks.map(r => r[0].n);
    const impedimentos = [];

    if (citas          > 0) impedimentos.push(`${citas} cita${citas > 1 ? 's' : ''}`);
    if (historia       > 0) impedimentos.push(`${historia} registro${historia > 1 ? 's' : ''} de historia clínica`);
    if (desparasitaciones > 0) impedimentos.push(`${desparasitaciones} desparasitación${desparasitaciones > 1 ? 'es' : ''}`);
    if (vacunas        > 0) impedimentos.push(`${vacunas} vacuna${vacunas > 1 ? 's' : ''}`);
    if (estetica       > 0) impedimentos.push(`${estetica} servicio${estetica > 1 ? 's' : ''} de estética`);

    if (impedimentos.length > 0) {
      return res.status(409).json({
        success      : false,
        code         : 'TIENE_REGISTROS',
        message      : `No se puede eliminar a ${masc.nombre} porque tiene: ${impedimentos.join(', ')}. Elimina primero esos registros.`,
        detalle      : { citas, historia, desparasitaciones, vacunas, estetica },
      });
    }

    // Sin registros vinculados — eliminar también el carnet digital si existe
    await req.db.query('DELETE FROM carnets_digitales WHERE mascota_id = ?', [req.params.id]);
    await req.db.query('DELETE FROM mascotas WHERE id = ?', [req.params.id]);
    return res.json({ success: true, message: 'Mascota eliminada correctamente.' });
  } catch (err) { next(err); }
});

module.exports = router;