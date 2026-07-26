'use strict';

const { Router } = require('express');
const crypto     = require('crypto');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();

// Helper para formatear fechas DATE de MySQL
function formatDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return String(val).split('T')[0];
}

// ── Rutas PROTEGIDAS primero (evitan ser capturadas por /:token) ──
router.get('/mascota/:id', authenticate, async (req, res, next) => {
  try {
    let [carnet] = await req.db.query(
      'SELECT * FROM carnets_digitales WHERE mascota_id=?', [req.params.id]
    );
    if (!carnet) {
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

router.patch('/mascota/:id/toggle', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const [carnet] = await req.db.query('SELECT * FROM carnets_digitales WHERE mascota_id=?', [req.params.id]);
    if (!carnet) return res.status(404).json({ success:false, message:'Carnet no encontrado.' });
    const nuevo = carnet.activo ? 0 : 1;
    await req.db.query('UPDATE carnets_digitales SET activo=? WHERE mascota_id=?', [nuevo, req.params.id]);
    return res.json({ success:true, data:{ activo:nuevo }, message: nuevo ? 'Carnet activado.' : 'Carnet desactivado.' });
  } catch(err) { next(err); }
});

router.post('/mascota/:id/regenerar', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    await req.db.query(
      'UPDATE carnets_digitales SET token=?, vistas=0 WHERE mascota_id=?',
      [token, req.params.id]
    );
    return res.json({ success:true, data:{ token }, message:'Token regenerado.' });
  } catch(err) { next(err); }
});

// ── GET PÚBLICO /api/v1/carnet/:token — al final para no capturar /mascota/* ──
router.get('/:token', async (req, res, next) => {
  try {
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

    if (carnet.fecha_nacimiento) carnet.fecha_nacimiento = formatDate(carnet.fecha_nacimiento);

    const [branding] = await req.db.query(
      'SELECT nombre, logo_url, color_primario, color_acento FROM empresa_config LIMIT 1'
    ).catch(() => [null]);

    const { masterQuery } = require('../config/masterDB');
    const host = req.headers['x-tenant-host'] || req.hostname || '';
    const [tenantBranding] = await masterQuery(
      `SELECT tc.nombre_clinica, tc.logo_url, tc.color_primario, tc.color_acento
       FROM tenants t JOIN tenant_config tc ON tc.tenant_id = t.id
       WHERE t.subdominio = ? LIMIT 1`, [host]
    ).catch(() => [null]);

    const clinicaBranding = {
      nombre_clinica: tenantBranding?.nombre_clinica || branding?.nombre || 'VetClinic',
      logo_url      : tenantBranding?.logo_url       || branding?.logo_url || null,
      color_primario: tenantBranding?.color_primario || branding?.color_primario || '#166534',
      color_acento  : tenantBranding?.color_acento   || branding?.color_acento  || '#15803d',
    };

    // Vacunas
    const vacunasRaw = await req.db.query(
      `SELECT nombre, fabricante, lote, fecha_aplicacion, proxima_dosis, notas
       FROM vacunas WHERE mascota_id = ?
       ORDER BY fecha_aplicacion DESC`, [carnet.mascota_id]
    );
    const vacunas = vacunasRaw.map(v => ({
      ...v,
      fecha_aplicacion: formatDate(v.fecha_aplicacion),
      proxima_dosis   : formatDate(v.proxima_dosis),
    }));

    // Desparasitaciones
    const despaRaw = await req.db.query(
      `SELECT d.tipo, d.producto, d.dosis, d.fecha_aplicacion, d.proxima_dosis, d.notas,
              u.nombre AS veterinario_nombre
       FROM desparasitaciones d
       JOIN usuarios u ON u.id = d.veterinario_id
       WHERE d.mascota_id = ?
       ORDER BY d.fecha_aplicacion DESC`, [carnet.mascota_id]
    ).catch(() => []);
    const desparasitaciones = despaRaw.map(d => ({
      ...d,
      fecha_aplicacion: formatDate(d.fecha_aplicacion),
      proxima_dosis   : formatDate(d.proxima_dosis),
    }));

    // Próximas citas
    const citas = await req.db.query(
      `SELECT c.fecha_hora, c.motivo, c.estado, u.nombre AS veterinario
       FROM citas c JOIN usuarios u ON u.id = c.veterinario_id
       WHERE c.mascota_id = ? AND c.fecha_hora >= NOW() AND c.estado NOT IN ('cancelada','completada')
       ORDER BY c.fecha_hora ASC LIMIT 3`, [carnet.mascota_id]
    );

    // Historial de citas
    const citas_historial_raw = await req.db.query(
      `SELECT c.id AS cita_id, c.fecha_hora, c.motivo AS motivo_cita, c.estado,
              u.nombre AS veterinario,
              MAX(h.id) AS historia_id,
              MAX(h.diagnostico) AS diagnostico,
              MAX(h.tratamiento) AS tratamiento,
              MAX(h.observaciones) AS observaciones,
              MAX(h.peso_kg) AS peso_kg,
              MAX(h.temperatura_c) AS temperatura_c,
              MAX(h.motivo) AS motivo_historia
       FROM citas c
       JOIN usuarios u ON u.id = c.veterinario_id
       LEFT JOIN historia_clinica h ON h.cita_id = c.id
       WHERE c.mascota_id = ? AND c.estado = 'completada'
       GROUP BY c.id, c.fecha_hora, c.motivo, c.estado, u.nombre
       ORDER BY c.fecha_hora DESC LIMIT 10`, [carnet.mascota_id]
    );

    const historias_sin_cita = await req.db.query(
      `SELECT h.id AS historia_id, h.fecha AS fecha_hora, h.motivo AS motivo_cita,
              h.diagnostico, h.tratamiento, h.observaciones, h.peso_kg, h.temperatura_c,
              u.nombre AS veterinario
       FROM historia_clinica h
       JOIN usuarios u ON u.id = h.veterinario_id
       WHERE h.mascota_id = ? AND h.cita_id IS NULL
       ORDER BY h.fecha DESC LIMIT 5`, [carnet.mascota_id]
    );

    const citas_historial = await Promise.all(
      citas_historial_raw.map(async c => {
        if (!c.historia_id) return { ...c, recetas: [] };
        const recetas = await req.db.query(
          `SELECT medicamento, dosis, frecuencia, duracion_dias, instrucciones
           FROM recetas WHERE historia_clinica_id = ?`, [c.historia_id]
        );
        return { ...c, recetas };
      })
    );

    const historias_con_recetas = await Promise.all(
      historias_sin_cita.map(async h => {
        const recetas = await req.db.query(
          `SELECT medicamento, dosis, frecuencia, duracion_dias, instrucciones
           FROM recetas WHERE historia_clinica_id = ?`, [h.historia_id]
        );
        return { ...h, recetas, sin_cita: true };
      })
    );

    // Baños/estética
    const banosRaw = await req.db.query(
      `SELECT s.fecha, s.tipo_bano, s.incluye_corte, s.incluye_unas,
              s.incluye_dental, s.productos, s.observaciones, s.precio,
              u.nombre AS atendido_por
       FROM servicios_estetica s JOIN usuarios u ON u.id = s.atendido_por_id
       WHERE s.mascota_id = ?
       ORDER BY s.fecha DESC LIMIT 10`, [carnet.mascota_id]
    );
    const banos = banosRaw.map(b => ({ ...b, fecha: formatDate(b.fecha) }));

    const [ultimaConsulta] = await req.db.query(
      `SELECT h.fecha, h.diagnostico, h.tratamiento, u.nombre AS veterinario
       FROM historia_clinica h JOIN usuarios u ON u.id = h.veterinario_id
       WHERE h.mascota_id = ?
       ORDER BY h.fecha DESC LIMIT 1`, [carnet.mascota_id]
    );

    await req.db.query('UPDATE carnets_digitales SET vistas=vistas+1 WHERE token=?', [req.params.token]);

    return res.json({
      success: true,
      data: {
        carnet,
        vacunas,
        desparasitaciones,
        citas,
        citas_historial,
        historias_sin_cita: historias_con_recetas,
        banos,
        ultima_consulta: ultimaConsulta || null,
        branding       : clinicaBranding,
      },
    });
  } catch(err) { next(err); }
});

module.exports = router;