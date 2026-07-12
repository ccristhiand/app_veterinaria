'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);
router.use(authorize('admin'));

// ── GET /api/v1/reportes/citas ────────────────────────────────────
router.get('/citas', async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const d = desde || new Date().toISOString().split('T')[0];
    const h = hasta || d;

    const [resumen] = await req.db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(estado='completada')  AS completadas,
         SUM(estado='cancelada')   AS canceladas,
         SUM(estado='pendiente')   AS pendientes,
         SUM(estado='confirmada')  AS confirmadas,
         SUM(estado='en_curso')    AS en_curso
       FROM citas WHERE DATE(fecha_hora) BETWEEN ? AND ?`, [d, h]
    );

    const porVeterinario = await req.db.query(
      `SELECT u.nombre AS veterinario, COUNT(*) AS total,
              SUM(c.estado='completada') AS completadas
       FROM citas c JOIN usuarios u ON u.id = c.veterinario_id
       WHERE DATE(c.fecha_hora) BETWEEN ? AND ?
       GROUP BY u.id, u.nombre ORDER BY total DESC`, [d, h]
    );

    const porDia = await req.db.query(
      `SELECT DATE(fecha_hora) AS dia, COUNT(*) AS total,
              SUM(estado='completada') AS completadas
       FROM citas WHERE DATE(fecha_hora) BETWEEN ? AND ?
       GROUP BY DATE(fecha_hora) ORDER BY dia ASC`, [d, h]
    );

    const porEstado = await req.db.query(
      `SELECT estado, COUNT(*) AS total
       FROM citas WHERE DATE(fecha_hora) BETWEEN ? AND ?
       GROUP BY estado ORDER BY total DESC`, [d, h]
    );

    return res.json({ success:true, data:{ resumen, porVeterinario, porDia, porEstado, periodo:{desde:d, hasta:h} } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/financiero ──────────────────────────────
router.get('/financiero', async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const d = desde || new Date().toISOString().split('T')[0];
    const h = hasta || d;

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
       FROM facturas WHERE fecha BETWEEN ? AND ?`, [d, h]
    );

    const porDia = await req.db.query(
      `SELECT fecha AS dia,
              SUM(CASE WHEN estado='pagado' THEN total ELSE 0 END) AS ingresos,
              COUNT(*) AS documentos
       FROM facturas WHERE fecha BETWEEN ? AND ?
       GROUP BY fecha ORDER BY fecha ASC`, [d, h]
    );

    const porMetodo = await req.db.query(
      `SELECT fp.metodo_pago, SUM(fp.monto) AS monto, COUNT(*) AS transacciones
       FROM factura_pagos fp
       JOIN facturas f ON f.id = fp.factura_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado='pagado'
       GROUP BY fp.metodo_pago ORDER BY monto DESC`, [d, h]
    );

    const topServicios = await req.db.query(
      `SELECT fi.descripcion, SUM(fi.cantidad) AS cantidad,
              SUM(fi.subtotal) AS monto_total
       FROM factura_items fi
       JOIN facturas f ON f.id = fi.factura_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado='pagado'
       GROUP BY fi.descripcion ORDER BY monto_total DESC LIMIT 10`, [d, h]
    );

    const pendientes = await req.db.query(
      `SELECT f.numero, f.fecha, f.total, f.tipo,
              CONCAT(p.nombre,' ',p.apellido) AS cliente
       FROM facturas f
       JOIN propietarios p ON p.id = f.propietario_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado='pendiente'
       ORDER BY f.fecha ASC`, [d, h]
    );

    return res.json({ success:true, data:{ resumen, porDia, porMetodo, topServicios, pendientes, periodo:{desde:d,hasta:h} } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/mascotas ─────────────────────────────────
router.get('/mascotas', async (req, res, next) => {
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
router.get('/vacunas', async (req, res, next) => {
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
router.get('/inventario', async (req, res, next) => {
  try {
    const [resumen] = await req.db.query(
      `SELECT COUNT(*) AS total_items,
              SUM(cantidad <= stock_minimo) AS stock_bajo,
              SUM(fecha_vencimiento < CURDATE()) AS vencidos,
              SUM(fecha_vencimiento BETWEEN CURDATE() AND DATE_ADD(CURDATE(),INTERVAL 30 DAY)) AS por_vencer
       FROM inventario`
    );

    const stockBajo = await req.db.query(
      `SELECT nombre, categoria, cantidad, stock_minimo, unidad, proveedor
       FROM inventario WHERE cantidad <= stock_minimo
       ORDER BY (cantidad/stock_minimo) ASC`
    );

    const porVencer = await req.db.query(
      `SELECT nombre, categoria, cantidad, unidad, fecha_vencimiento, proveedor
       FROM inventario
       WHERE fecha_vencimiento BETWEEN CURDATE() AND DATE_ADD(CURDATE(),INTERVAL 30 DAY)
       ORDER BY fecha_vencimiento ASC`
    );

    const porCategoria = await req.db.query(
      `SELECT categoria, COUNT(*) AS items, SUM(cantidad) AS total_unidades
       FROM inventario GROUP BY categoria ORDER BY items DESC`
    );

    return res.json({ success:true, data:{ resumen, stockBajo, porVencer, porCategoria } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/estetica ────────────────────────────────
router.get('/estetica', async (req, res, next) => {
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
router.get('/veterinarios', async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const d = desde || new Date().toISOString().split('T')[0];
    const h = hasta || d;

    const veterinarios = await req.db.query(
      `SELECT u.id, u.nombre,
              COUNT(DISTINCT c.id) AS citas_total,
              SUM(c.estado='completada') AS citas_completadas,
              SUM(c.estado='cancelada')  AS citas_canceladas,
              COUNT(DISTINCT h.id)       AS consultas,
              COUNT(DISTINCT v.id)       AS vacunas
       FROM usuarios u
       LEFT JOIN citas c ON c.veterinario_id = u.id
         AND DATE(c.fecha_hora) BETWEEN ? AND ?
       LEFT JOIN historia_clinica h ON h.veterinario_id = u.id
         AND DATE(h.fecha) BETWEEN ? AND ?
       LEFT JOIN vacunas v ON v.veterinario_id = u.id
         AND v.fecha_aplicacion BETWEEN ? AND ?
       WHERE u.rol = 'veterinario' AND u.activo = 1
       GROUP BY u.id, u.nombre
       ORDER BY citas_total DESC`, [d, h, d, h, d, h]
    );

    return res.json({ success:true, data:{ veterinarios, periodo:{desde:d,hasta:h} } });
  } catch (err) { next(err); }
});

module.exports = router;