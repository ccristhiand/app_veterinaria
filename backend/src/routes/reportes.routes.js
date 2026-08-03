'use strict';

/**
 * VetNetcodip SaaS — Reportes con soporte multi-sedes
 * Parámetro opcional: ?sede_id=N  → filtra esa sede
 * Sin sede_id (o sede_id=all)     → datos de todas las sedes
 * Solo accesible para rol 'admin'
 */

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);
// Nota: dashboard-stats es accesible para todos los roles
// Los demás endpoints de reportes requieren admin — se aplica por ruta

// ── Helper: construir filtro de sede ─────────────────────────────
// Devuelve { sql: 'AND tabla.sede_id = ?', params: [N] }
// o        { sql: '', params: [] }  cuando se pide todo
function sedeFilter(sedeId, col = 'sede_id') {
  const sid = sedeId && sedeId !== 'all' ? parseInt(sedeId, 10) : null;
  if (sid && !isNaN(sid)) return { sql: `AND ${col} = ?`, params: [sid] };
  return { sql: '', params: [] };
}

// ── GET /api/v1/reportes/sedes — listado de sedes para el selector ─
router.get('/sedes', async (req, res, next) => {
  try {
    const sedes = await req.db.query(
      'SELECT id, nombre, ciudad FROM sedes WHERE activo = 1 ORDER BY es_principal DESC, nombre ASC'
    );
    return res.json({ success: true, data: sedes });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/citas ────────────────────────────────────
router.get('/citas', authorize('admin'), async (req, res, next) => {
  try {
    const { desde, hasta, sede_id } = req.query;
    const d = desde || new Date().toISOString().split('T')[0];
    const h = hasta || d;
    const sf = sedeFilter(sede_id);

    const [resumen] = await req.db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(estado='completada')  AS completadas,
         SUM(estado='cancelada')   AS canceladas,
         SUM(estado='pendiente')   AS pendientes,
         SUM(estado='confirmada')  AS confirmadas,
         SUM(estado='en_curso')    AS en_curso
       FROM citas WHERE DATE(fecha_hora) BETWEEN ? AND ? ${sf.sql}`,
      [d, h, ...sf.params]
    );

    const porVeterinario = await req.db.query(
      `SELECT u.nombre AS veterinario, COUNT(*) AS total,
              SUM(c.estado='completada') AS completadas
       FROM citas c JOIN usuarios u ON u.id = c.veterinario_id
       WHERE DATE(c.fecha_hora) BETWEEN ? AND ? ${sf.sql}
       GROUP BY u.id, u.nombre ORDER BY total DESC`,
      [d, h, ...sf.params]
    );

    const porDia = await req.db.query(
      `SELECT DATE(fecha_hora) AS dia, COUNT(*) AS total,
              SUM(estado='completada') AS completadas
       FROM citas WHERE DATE(fecha_hora) BETWEEN ? AND ? ${sf.sql}
       GROUP BY DATE(fecha_hora) ORDER BY dia ASC`,
      [d, h, ...sf.params]
    );

    const porEstado = await req.db.query(
      `SELECT estado, COUNT(*) AS total
       FROM citas WHERE DATE(fecha_hora) BETWEEN ? AND ? ${sf.sql}
       GROUP BY estado ORDER BY total DESC`,
      [d, h, ...sf.params]
    );

    // Si no se filtra por sede, mostrar desglose por sede
    let porSede = [];
    if (!sf.sql) {
      porSede = await req.db.query(
        `SELECT
           s.nombre AS sede,
           s.id     AS sede_id,
           COUNT(c.id)                        AS total_citas,
           SUM(c.estado='completada')         AS completadas,
           SUM(c.estado IN ('pendiente','confirmada')) AS pendientes
         FROM sedes s
         LEFT JOIN citas c ON COALESCE(c.sede_id,
           (SELECT u.sede_id FROM usuarios u WHERE u.id = c.veterinario_id LIMIT 1)
         ) = s.id
         AND DATE(CONVERT_TZ(c.fecha_hora,'+00:00',?)) BETWEEN ? AND ?
         WHERE s.activo = 1
         GROUP BY s.id, s.nombre
         ORDER BY total_citas DESC`,
        [tz, d, h]
      );
    }

    return res.json({ success:true, data:{ resumen, porVeterinario, porDia, porEstado, porSede, periodo:{desde:d, hasta:h}, sede_id: sede_id||null } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/financiero ──────────────────────────────
router.get('/financiero', authorize('admin'), async (req, res, next) => {
  try {
    const { desde, hasta, sede_id } = req.query;
    const d = desde || new Date().toISOString().split('T')[0];
    const h = hasta || d;
    const sf = sedeFilter(sede_id);

    const [resumen] = await req.db.query(
      `SELECT
         COUNT(*) AS total_documentos,
         SUM(estado='pagado')    AS pagados,
         SUM(estado='pendiente') AS pendientes,
         SUM(estado='anulado')   AS anulados,
         COALESCE(SUM(CASE WHEN estado='pagado'    THEN total END),0) AS ingresos,
         COALESCE(SUM(CASE WHEN estado='pendiente' THEN total END),0) AS por_cobrar,
         COALESCE(SUM(CASE WHEN estado='pagado'    THEN igv   END),0) AS total_igv,
         COALESCE(SUM(CASE WHEN estado='pagado' AND tipo='boleta'  THEN total END),0) AS boletas,
         COALESCE(SUM(CASE WHEN estado='pagado' AND tipo='factura' THEN total END),0) AS facturas
       FROM facturas WHERE fecha BETWEEN ? AND ? ${sf.sql}`,
      [d, h, ...sf.params]
    );

    const porDia = await req.db.query(
      `SELECT fecha AS dia,
              SUM(CASE WHEN estado='pagado' THEN total ELSE 0 END) AS ingresos,
              COUNT(*) AS documentos
       FROM facturas WHERE fecha BETWEEN ? AND ? ${sf.sql}
       GROUP BY fecha ORDER BY fecha ASC`,
      [d, h, ...sf.params]
    );

    const porMetodo = await req.db.query(
      `SELECT fp.metodo_pago, SUM(fp.monto) AS monto, COUNT(*) AS transacciones
       FROM factura_pagos fp
       JOIN facturas f ON f.id = fp.factura_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado='pagado' ${sf.sql ? sf.sql.replace('AND sede_id', 'AND f.sede_id') : ''}
       GROUP BY fp.metodo_pago ORDER BY monto DESC`,
      [d, h, ...sf.params]
    );

    const topServicios = await req.db.query(
      `SELECT fi.descripcion, SUM(fi.cantidad) AS cantidad,
              SUM(fi.subtotal) AS monto_total
       FROM factura_items fi
       JOIN facturas f ON f.id = fi.factura_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado='pagado' ${sf.sql ? sf.sql.replace('AND sede_id', 'AND f.sede_id') : ''}
       GROUP BY fi.descripcion ORDER BY monto_total DESC LIMIT 10`,
      [d, h, ...sf.params]
    );

    const pendientes = await req.db.query(
      `SELECT f.numero, f.fecha, f.total, f.tipo,
              CONCAT(p.nombre,' ',p.apellido) AS cliente
       FROM facturas f
       JOIN propietarios p ON p.id = f.propietario_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado='pendiente' ${sf.sql ? sf.sql.replace('AND sede_id', 'AND f.sede_id') : ''}
       ORDER BY f.fecha ASC`,
      [d, h, ...sf.params]
    );

    // Desglose por sede cuando se pide todo
    let porSede = [];
    if (!sf.sql) {
      porSede = await req.db.query(
        `SELECT
           s.nombre AS sede,
           s.id     AS sede_id,
           COALESCE(SUM(CASE WHEN f.estado='pagado' THEN f.total ELSE 0 END),0) AS ingresos,
           COUNT(CASE WHEN f.estado='pagado' THEN 1 END)                         AS documentos,
           COALESCE(SUM(CASE WHEN f.estado='pendiente' THEN f.total ELSE 0 END),0) AS pendiente
         FROM sedes s
         LEFT JOIN facturas f ON f.sede_id = s.id AND f.fecha BETWEEN ? AND ?
         WHERE s.activo = 1
         GROUP BY s.id, s.nombre
         ORDER BY ingresos DESC`,
        [d, h]
      );
    }

    return res.json({ success:true, data:{ resumen, porDia, porMetodo, topServicios, pendientes, porSede, periodo:{desde:d,hasta:h}, sede_id: sede_id||null } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/mascotas ─────────────────────────────────
// Mascotas no tiene sede_id — este reporte siempre es global
router.get('/mascotas', authorize('admin'), async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const d = desde || new Date().toISOString().split('T')[0];
    const h = hasta || d;

    const [resumen] = await req.db.query(
      `SELECT COUNT(*) AS total,
              SUM(especie='perro') AS perros,
              SUM(especie='gato')  AS gatos,
              SUM(especie='ave')   AS aves,
              SUM(especie='reptil')AS reptiles,
              SUM(especie NOT IN ('perro','gato','ave','reptil')) AS otros
       FROM mascotas`
    );

    const porEspecie = await req.db.query(
      `SELECT especie, COUNT(*) AS total
       FROM mascotas GROUP BY especie ORDER BY total DESC`
    );

    const nuevasPorMes = await req.db.query(
      `SELECT DATE_FORMAT(created_at,'%Y-%m') AS mes, COUNT(*) AS total
       FROM mascotas
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
       GROUP BY mes ORDER BY mes ASC`
    );

    const masAtendidas = await req.db.query(
      `SELECT m.nombre, m.especie, m.raza,
              CONCAT(p.nombre,' ',p.apellido) AS propietario,
              COUNT(h.id) AS consultas
       FROM mascotas m
       JOIN propietarios p ON p.id = m.propietario_id
       LEFT JOIN historia_clinica h ON h.mascota_id = m.id
         AND DATE(h.fecha) BETWEEN ? AND ?
       GROUP BY m.id ORDER BY consultas DESC LIMIT 10`, [d, h]
    );

    return res.json({ success:true, data:{ resumen, porEspecie, nuevasPorMes, masAtendidas, periodo:{desde:d,hasta:h} } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/vacunas ──────────────────────────────────
router.get('/vacunas', authorize('admin'), async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const d = desde || new Date().toISOString().split('T')[0];
    const h = hasta || d;

    const [resumen] = await req.db.query(
      `SELECT COUNT(*) AS total_aplicadas,
              SUM(proxima_dosis < CURDATE()) AS vencidas,
              SUM(proxima_dosis BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)) AS proximas_30dias
       FROM vacunas WHERE fecha_aplicacion BETWEEN ? AND ?`, [d, h]
    );

    const porNombre = await req.db.query(
      `SELECT nombre, COUNT(*) AS total
       FROM vacunas WHERE fecha_aplicacion BETWEEN ? AND ?
       GROUP BY nombre ORDER BY total DESC LIMIT 10`, [d, h]
    );

    const proximasVencer = await req.db.query(
      `SELECT v.nombre AS vacuna, v.proxima_dosis,
              m.nombre AS mascota, m.especie,
              CONCAT(p.nombre,' ',p.apellido) AS propietario, p.telefono
       FROM vacunas v
       JOIN mascotas m ON m.id = v.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE v.proxima_dosis BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
       ORDER BY v.proxima_dosis ASC LIMIT 20`
    );

    const vencidas = await req.db.query(
      `SELECT v.nombre AS vacuna, v.proxima_dosis,
              m.nombre AS mascota, m.especie,
              CONCAT(p.nombre,' ',p.apellido) AS propietario, p.telefono
       FROM vacunas v
       JOIN mascotas m ON m.id = v.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE v.proxima_dosis < CURDATE()
       ORDER BY v.proxima_dosis DESC LIMIT 20`
    );

    return res.json({ success:true, data:{ resumen, porNombre, proximasVencer, vencidas, periodo:{desde:d,hasta:h} } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/inventario ──────────────────────────────
router.get('/inventario', authorize('admin'), async (req, res, next) => {
  try {
    const { sede_id } = req.query;
    const sf = sedeFilter(sede_id);

    const [resumen] = await req.db.query(
      `SELECT COUNT(*) AS total_items,
              SUM(cantidad <= stock_minimo) AS stock_bajo,
              SUM(fecha_vencimiento < CURDATE()) AS vencidos,
              SUM(fecha_vencimiento BETWEEN CURDATE() AND DATE_ADD(CURDATE(),INTERVAL 30 DAY)) AS por_vencer
       FROM inventario WHERE 1=1 ${sf.sql}`,
      [...sf.params]
    );

    const stockBajo = await req.db.query(
      `SELECT i.nombre, i.categoria, i.cantidad, i.stock_minimo, i.unidad, i.proveedor,
              s.nombre AS sede
       FROM inventario i LEFT JOIN sedes s ON s.id = i.sede_id
       WHERE i.cantidad <= i.stock_minimo ${sf.sql}
       ORDER BY (i.cantidad/i.stock_minimo) ASC`,
      [...sf.params]
    );

    const porVencer = await req.db.query(
      `SELECT i.nombre, i.categoria, i.cantidad, i.unidad, i.fecha_vencimiento, i.proveedor,
              s.nombre AS sede
       FROM inventario i LEFT JOIN sedes s ON s.id = i.sede_id
       WHERE i.fecha_vencimiento BETWEEN CURDATE() AND DATE_ADD(CURDATE(),INTERVAL 30 DAY) ${sf.sql}
       ORDER BY i.fecha_vencimiento ASC`,
      [...sf.params]
    );

    const porCategoria = await req.db.query(
      `SELECT categoria, COUNT(*) AS items, SUM(cantidad) AS total_unidades
       FROM inventario WHERE 1=1 ${sf.sql}
       GROUP BY categoria ORDER BY items DESC`,
      [...sf.params]
    );

    return res.json({ success:true, data:{ resumen, stockBajo, porVencer, porCategoria, sede_id: sede_id||null } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/estetica ────────────────────────────────
router.get('/estetica', authorize('admin'), async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const d = desde || new Date().toISOString().split('T')[0];
    const h = hasta || d;

    const [resumen] = await req.db.query(
      `SELECT COUNT(*) AS total,
              SUM(tipo_bano='basico')    AS basicos,
              SUM(tipo_bano='completo')  AS completos,
              SUM(tipo_bano='medicado')  AS medicados,
              SUM(incluye_corte=1)       AS con_corte,
              COALESCE(SUM(precio),0)    AS ingresos
       FROM servicios_estetica WHERE fecha BETWEEN ? AND ?`, [d, h]
    );

    const porDia = await req.db.query(
      `SELECT fecha AS dia, COUNT(*) AS total, COALESCE(SUM(precio),0) AS ingresos
       FROM servicios_estetica WHERE fecha BETWEEN ? AND ?
       GROUP BY fecha ORDER BY fecha ASC`, [d, h]
    );

    const porTipo = await req.db.query(
      `SELECT tipo_bano, COUNT(*) AS total, COALESCE(SUM(precio),0) AS ingresos
       FROM servicios_estetica WHERE fecha BETWEEN ? AND ?
       GROUP BY tipo_bano ORDER BY total DESC`, [d, h]
    );

    return res.json({ success:true, data:{ resumen, porDia, porTipo, periodo:{desde:d,hasta:h} } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/veterinarios ────────────────────────────
router.get('/veterinarios', authorize('admin'), async (req, res, next) => {
  try {
    const { desde, hasta, sede_id } = req.query;
    const d = desde || new Date().toISOString().split('T')[0];
    const h = hasta || d;
    const sf = sedeFilter(sede_id, 'u.sede_id');

    const veterinarios = await req.db.query(
      `SELECT u.id, u.nombre, s.nombre AS sede,
              COUNT(DISTINCT c.id) AS citas_total,
              SUM(c.estado='completada') AS citas_completadas,
              SUM(c.estado='cancelada')  AS citas_canceladas,
              COUNT(DISTINCT hc.id)      AS consultas,
              COUNT(DISTINCT v.id)       AS vacunas
       FROM usuarios u
       LEFT JOIN sedes s ON s.id = u.sede_id
       LEFT JOIN citas c ON c.veterinario_id = u.id
         AND DATE(c.fecha_hora) BETWEEN ? AND ?
       LEFT JOIN historia_clinica hc ON hc.veterinario_id = u.id
         AND DATE(hc.fecha) BETWEEN ? AND ?
       LEFT JOIN vacunas v ON v.veterinario_id = u.id
         AND v.fecha_aplicacion BETWEEN ? AND ?
       WHERE u.rol = 'veterinario' AND u.activo = 1 ${sf.sql}
       GROUP BY u.id, u.nombre, s.nombre
       ORDER BY citas_total DESC`,
      [d, h, d, h, d, h, ...sf.params]
    );

    return res.json({ success:true, data:{ veterinarios, periodo:{desde:d,hasta:h}, sede_id: sede_id||null } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/dashboard-stats ─────────────────────────
// Endpoint especial para el dashboard: admin ve por sede o todo,
// otros roles ven solo su sede automáticamente
router.get('/dashboard-stats', async (req, res, next) => {
  try {
    const tz   = req.tzOffset || '-05:00';
    // Fecha de hoy en la zona horaria del tenant
    const hoy  = new Intl.DateTimeFormat('en-CA', {
      timeZone: req.tenant?.zona_horaria || 'America/Lima',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const user = req.user;
    console.log('[dashboard-stats] user.id:', user.id, '| user.rol:', user.rol, '| user.sede_id:', user.sede_id, '| tz:', req.tzOffset, '| hoy:', hoy);

    // Admin sin sede_id en query → todas las sedes; con sede_id → filtra
    // Otros roles → siempre su sede del JWT (req.user.sede_id)
    const sedeIdParam = req.query.sede_id;
    const sedeId = user.rol === 'admin'
      ? (sedeIdParam && sedeIdParam !== 'all' ? parseInt(sedeIdParam) : null)
      : (req.user.sede_id || null);

    const sf = sedeId ? { sql: 'AND sede_id = ?', params: [sedeId] } : { sql: '', params: [] };

    // Citas: filtra por sede de la cita, o sede del vet si la cita no tiene sede
    const sfCitas = sedeId
      ? { sql: 'AND COALESCE(c.sede_id, u.sede_id) = ?', params: [sedeId] }
      : { sql: '', params: [] };

    console.log('[dashboard-stats] sedeId:', sedeId, '| sfCitas:', JSON.stringify(sfCitas));
    const [citas] = await req.db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(c.estado IN ('pendiente','confirmada')) AS pendientes,
         SUM(c.estado='completada') AS completadas
       FROM citas c
       JOIN usuarios u ON u.id = c.veterinario_id
       WHERE DATE(CONVERT_TZ(c.fecha_hora, '+00:00', ?)) = ? ${sfCitas.sql}`,
      [tz, hoy, ...sfCitas.params]
    );

    // Stock bajo
    const [stock] = await req.db.query(
      `SELECT COUNT(*) AS bajo_stock FROM inventario
       WHERE cantidad <= stock_minimo ${sf.sql}`,
      [...sf.params]
    );

    // Desglose por sedes (solo admin sin filtro de sede)
    // Agrupa por sede de la cita, o sede del veterinario si la cita no tiene sede
    let sedes = [];
    if (user.rol === 'admin' && !sedeId) {
      sedes = await req.db.query(
        `SELECT s.id, s.nombre AS sede,
                COUNT(DISTINCT c.id) AS citas_hoy,
                SUM(c.estado IN ('pendiente','confirmada')) AS pendientes,
                SUM(c.estado='completada') AS completadas
         FROM sedes s
         LEFT JOIN citas c ON COALESCE(c.sede_id, (
           SELECT u.sede_id FROM usuarios u WHERE u.id = c.veterinario_id
         )) = s.id AND DATE(CONVERT_TZ(c.fecha_hora, '+00:00', ?)) = ?
         WHERE s.activo = 1
         GROUP BY s.id, s.nombre
         ORDER BY s.es_principal DESC, s.nombre ASC`,
        [tz, hoy]
      );
    }

    console.log('[dashboard-stats] resultado citas:', JSON.stringify(citas));
    return res.json({
      success: true,
      data: {
        citas_hoy   : citas.total       || 0,
        pendientes  : citas.pendientes  || 0,
        completadas : citas.completadas || 0,
        stock_bajo  : stock.bajo_stock  || 0,
        sedes,
        sede_id     : sedeId,
      },
    });
  } catch (err) { next(err); }
});


// ── GET /api/v1/reportes/atenciones-por-sede ─────────────────────
router.get('/atenciones-por-sede', authorize('admin'), async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const d = desde || new Date().toISOString().split('T')[0];
    const h = hasta || d;

    const porSede = await req.db.query(
      `SELECT
         s.nombre AS sede,
         s.id     AS sede_id,
         COUNT(hc.id) AS total_atenciones
       FROM sedes s
       LEFT JOIN historia_clinica hc ON hc.sede_id = s.id
         AND DATE(hc.fecha) BETWEEN ? AND ?
       WHERE s.activo = 1
       GROUP BY s.id, s.nombre
       ORDER BY total_atenciones DESC`,
      [d, h]
    );

    return res.json({ success: true, data: porSede });
  } catch (err) { next(err); }
});

module.exports = router;