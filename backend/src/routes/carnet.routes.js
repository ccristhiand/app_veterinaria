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

    // Branding del tenant
    const [branding] = await req.db.query(
      'SELECT nombre, logo_url, color_primario, color_acento FROM empresa_config LIMIT 1'
    ).catch(() => [null]);

    // También intentar desde tenant_config en vet_master
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

    // Historial de citas pasadas con historia clínica y recetas (últimas 10)
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

    // También cargar historias clínicas sin cita vinculada
    const historias_sin_cita = await req.db.query(
      `SELECT h.id AS historia_id, h.fecha AS fecha_hora, h.motivo AS motivo_cita,
              h.diagnostico, h.tratamiento, h.observaciones, h.peso_kg, h.temperatura_c,
              u.nombre AS veterinario
       FROM historia_clinica h
       JOIN usuarios u ON u.id = h.veterinario_id
       WHERE h.mascota_id = ? AND h.cita_id IS NULL
       ORDER BY h.fecha DESC LIMIT 5`, [carnet.mascota_id]
    );

    // Cargar recetas para cada historia clínica
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

    // Cargar recetas para historias sin cita
    const historias_con_recetas = await Promise.all(
      historias_sin_cita.map(async h => {
        const recetas = await req.db.query(
          `SELECT medicamento, dosis, frecuencia, duracion_dias, instrucciones
           FROM recetas WHERE historia_clinica_id = ?`, [h.historia_id]
        );
        return { ...h, recetas, sin_cita: true };
      })
    );

    // Historial de baños/estética (últimos 10)
    const banos = await req.db.query(
      `SELECT s.fecha, s.tipo_bano, s.incluye_corte, s.incluye_unas,
              s.incluye_dental, s.productos, s.observaciones, s.precio,
              u.nombre AS atendido_por
       FROM servicios_estetica s JOIN usuarios u ON u.id = s.atendido_por_id
       WHERE s.mascota_id = ?
       ORDER BY s.fecha DESC LIMIT 10`, [carnet.mascota_id]
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
      data: { carnet, vacunas, citas, citas_historial, historias_sin_cita: historias_con_recetas, banos, ultima_consulta: ultimaConsulta || null, branding: clinicaBranding },
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