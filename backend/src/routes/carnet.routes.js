'use strict';

const { Router } = require('express');
const crypto     = require('crypto');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();

// ── GET PÚBLICO /api/v1/carnet/:token ────────────────────────────
// Sin autenticación — acceso público para el propietario
router.get('/:token', async (req, res, next) => {
  try {
    // Necesitamos un pool genérico — el token identifica al tenant
    // En multitenant, el tenant viene del header X-Tenant-Host
    const [carnet] = await req.db.query(
      `SELECT c.*, m.nombre AS mascota_nombre, m.especie, m.raza,
              m.sexo, m.fecha_nacimiento, m.peso_kg, m.color, m.microchip,
              m.alergias, m.alertas_medicas,
              CONCAT(p.nombre,' ',p.apellido) AS propietario,
              p.telefono, p.email
       FROM carnets_digitales c
       JOIN mascotas m ON m.id = c.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE c.token = ? AND c.activo = 1`, [req.params.token]
    );

    if (!carnet) return res.status(404).json({ success:false, message:'Carnet no encontrado o desactivado.' });

    // Vacunas
    const vacunas = await req.db.query(
      `SELECT nombre, fabricante, lote, fecha_aplicacion, proxima_dosis, notas
       FROM vacunas WHERE mascota_id = ?
       ORDER BY fecha_aplicacion DESC`, [carnet.mascota_id]
    );

    // Próximas citas
    const citas = await req.db.query(
      `SELECT c.fecha_hora, c.motivo, c.estado, u.nombre AS veterinario
       FROM citas c JOIN usuarios u ON u.id = c.veterinario_id
       WHERE c.mascota_id = ? AND c.fecha_hora >= NOW() AND c.estado NOT IN ('cancelada','completada')
       ORDER BY c.fecha_hora ASC LIMIT 3`, [carnet.mascota_id]
    );

    // Última consulta
    const [ultimaConsulta] = await req.db.query(
      `SELECT h.fecha, h.diagnostico, h.tratamiento, u.nombre AS veterinario
       FROM historia_clinica h JOIN usuarios u ON u.id = h.veterinario_id
       WHERE h.mascota_id = ?
       ORDER BY h.fecha DESC LIMIT 1`, [carnet.mascota_id]
    );

    // Incrementar vistas
    await req.db.query('UPDATE carnets_digitales SET vistas=vistas+1 WHERE token=?', [req.params.token]);

    return res.json({
      success: true,
      data: { carnet, vacunas, citas, ultima_consulta: ultimaConsulta || null },
    });
  } catch(err) { next(err); }
});

// ── Rutas protegidas (requieren login) ───────────────────────────
router.use(authenticate);

// GET /api/v1/carnet/mascota/:id — obtener o crear carnet de una mascota
router.get('/mascota/:id', async (req, res, next) => {
  try {
    let [carnet] = await req.db.query(
      'SELECT * FROM carnets_digitales WHERE mascota_id=?', [req.params.id]
    );
    if (!carnet) {
      // Crear token único
      const token = crypto.randomBytes(24).toString('hex');
      await req.db.query(
        'INSERT INTO carnets_digitales (mascota_id, token) VALUES (?,?)',
        [req.params.id, token]
      );
      [carnet] = await req.db.query('SELECT * FROM carnets_digitales WHERE mascota_id=?', [req.params.id]);
    }
    return res.json({ success:true, data:carnet });
  } catch(err) { next(err); }
});

// PATCH /api/v1/carnet/mascota/:id/toggle — activar/desactivar carnet
router.patch('/mascota/:id/toggle', authorize('admin'), async (req, res, next) => {
  try {
    const [carnet] = await req.db.query('SELECT * FROM carnets_digitales WHERE mascota_id=?', [req.params.id]);
    if (!carnet) return res.status(404).json({ success:false, message:'Carnet no encontrado.' });
    const nuevo = carnet.activo ? 0 : 1;
    await req.db.query('UPDATE carnets_digitales SET activo=? WHERE mascota_id=?', [nuevo, req.params.id]);
    return res.json({ success:true, data:{ activo:nuevo }, message: nuevo ? 'Carnet activado.' : 'Carnet desactivado.' });
  } catch(err) { next(err); }
});

// POST /api/v1/carnet/mascota/:id/regenerar — nuevo token
router.post('/mascota/:id/regenerar', authorize('admin'), async (req, res, next) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    await req.db.query(
      'UPDATE carnets_digitales SET token=?, vistas=0 WHERE mascota_id=?',
      [token, req.params.id]
    );
    return res.json({ success:true, data:{ token }, message:'Token regenerado.' });
  } catch(err) { next(err); }
});

module.exports = router;