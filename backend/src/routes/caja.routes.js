'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');
const { qConn, gastosParaCierre, gastosAfectanCaja, totalesPorMetodo } = require('../services/gastos.service');
const { filtroSede, filtroUnaSede, sedeEscritura, exigirAcceso } = require('../services/sede.service');
const { diaPagoSql, PAGADO_SQL } = require('../services/pagos.service');

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'recepcionista'));

// Gastos vigentes ligados a cada cierre → { cierreId: [gastos] }
async function gastosDeCierres(req, ids) {
  if (!ids.length) return {};
  const rows = await req.db.query(
    `SELECT g.id, g.cierre_id, g.descripcion, g.monto, g.metodo_pago, g.proveedor, g.comprobante,
            gc.nombre AS categoria_nombre, gc.icono AS categoria_icono
     FROM gastos g JOIN gastos_categorias gc ON gc.id = g.categoria_id
     WHERE g.anulado = 0 AND g.cierre_id IN (${ids.map(() => '?').join(',')})
     ORDER BY g.created_at ASC`,
    ids
  );
  const map = {};
  for (const g of rows) (map[g.cierre_id] = map[g.cierre_id] || []).push(g);
  return map;
}

// GET /api/v1/caja/resumen-dia
router.get('/resumen-dia', async (req, res, next) => {
  try {
    const { fecha, turno } = req.query;
    const dia    = fecha || new Date().toISOString().split('T')[0];
    // En "Todas" se ve el consolidado; cerrar caja exige una sede concreta
    const sedeId = req.sede.activa;
    const { sql: sff, params: spf } = filtroSede(req, 'f.sede_id');
    const { sql: sf,  params: sp  } = filtroSede(req, 'sede_id');

    const [totales] = await req.db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN fp.metodo_pago='efectivo'      THEN fp.monto ELSE 0 END),0) AS efectivo,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='tarjeta'       THEN fp.monto ELSE 0 END),0) AS tarjeta,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='transferencia' THEN fp.monto ELSE 0 END),0) AS transferencia,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='yape'          THEN fp.monto ELSE 0 END),0) AS yape,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='plin'          THEN fp.monto ELSE 0 END),0) AS plin,
         COALESCE(SUM(fp.monto), 0)  AS total,
         COUNT(DISTINCT f.id)         AS total_documentos
       FROM factura_pagos fp
       JOIN facturas f ON f.id = fp.factura_id
       WHERE ${diaPagoSql(req)} = ? AND f.estado != 'anulado' ${sff}`,
      [dia, ...spf]
    );

    let cierreExistente = null;
    if (sedeId) {
      [cierreExistente] = await req.db.query(
        `SELECT id, estado, conteo_fisico, diferencia, total_gastos, gastos_efectivo, monto_inicial, observaciones
         FROM caja_cierres
         WHERE fecha = ? AND turno = ? AND sede_id = ?
         ORDER BY created_at DESC LIMIT 1`,
        [dia, turno || 'dia_completo', sedeId]
      );
    }

    const [pendientes] = await req.db.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(f.total - ${PAGADO_SQL}),0) AS monto
       FROM facturas f WHERE f.fecha = ? AND f.estado = 'pendiente' ${sff}`,
      [dia, ...spf]
    );

    // Gastos del módulo Gastos diarios que entran a este cierre
    const afectan = await gastosAfectanCaja(req.db.query);
    let gastos;
    if (cierreExistente?.estado === 'cerrado') {
      gastos = await req.db.query(
        `SELECT g.*, gc.nombre AS categoria_nombre, gc.icono AS categoria_icono
         FROM gastos g JOIN gastos_categorias gc ON gc.id = g.categoria_id
         WHERE g.cierre_id = ? AND g.anulado = 0 ORDER BY g.created_at ASC`,
        [cierreExistente.id]
      );
    } else if (afectan) {
      gastos = await gastosParaCierre(req.db.query, { fecha: dia, filtro: filtroSede(req, 'g.sede_id'), cierreId: cierreExistente?.id });
    } else {
      gastos = [];
    }

    return res.json({
      success: true,
      data: { fecha: dia, turno: turno || 'dia_completo', totales, pendientes,
              cierre_existente: cierreExistente || null, gastos, gastos_totales: totalesPorMetodo(gastos),
              // Un cierre ya cerrado conserva los gastos con los que se cerró
              gastos_afectan_caja: afectan || gastos.length > 0,
              consolidado: !sedeId },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/caja/cierres
router.get('/cierres', async (req, res, next) => {
  try {
    const { desde, hasta, page = 1 } = req.query;
    const limit   = 20;
    const offset  = (parseInt(page) - 1) * limit;

    let sql = `SELECT cc.*, u.nombre AS realizado_por, s.nombre AS sede_nombre
               FROM caja_cierres cc
               JOIN usuarios u ON u.id = cc.realizado_por_id
               LEFT JOIN sedes s ON s.id = cc.sede_id
               WHERE 1=1`;
    const params = [];

    const fs = filtroSede(req, 'cc.sede_id');
    sql += ` ${fs.sql}`; params.push(...fs.params);
    if (desde)  { sql += ' AND cc.fecha >= ?';  params.push(desde); }
    if (hasta)  { sql += ' AND cc.fecha <= ?';  params.push(hasta); }

    sql += ` ORDER BY cc.fecha DESC, cc.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const rows = await req.db.query(sql, params);
    const gastosPorCierre = await gastosDeCierres(req, rows.map(r => r.id));
    for (const row of rows) row.gastos = gastosPorCierre[row.id] || [];
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/caja/cierres/:id
router.get('/cierres/:id', async (req, res, next) => {
  try {
    const [cierre] = await req.db.query(
      `SELECT cc.*, u.nombre AS realizado_por, s.nombre AS sede_nombre
       FROM caja_cierres cc
       JOIN usuarios u ON u.id = cc.realizado_por_id
       LEFT JOIN sedes s ON s.id = cc.sede_id
       WHERE cc.id = ?`, [req.params.id]
    );
    if (!cierre) return res.status(404).json({ success: false, message: 'No encontrado.' });
    exigirAcceso(req, cierre.sede_id);
    cierre.gastos = (await gastosDeCierres(req, [cierre.id]))[cierre.id] || [];
    return res.json({ success: true, data: cierre });
  } catch (err) { next(err); }
});

// POST /api/v1/caja/cierres
router.post('/cierres', auditMiddleware('caja:creado', 'caja'), async (req, res, next) => {
  try {
    // Los gastos ya no vienen en el body: se toman del módulo Gastos diarios
    const { fecha, turno = 'dia_completo', monto_inicial = 0, conteo_fisico, observaciones, cerrar = false } = req.body;
    if (!fecha) return res.status(422).json({ success: false, message: 'fecha requerida.' });
    if (conteo_fisico === undefined || conteo_fisico === null)
      return res.status(422).json({ success: false, message: 'conteo_fisico requerido.' });

    // Cada cierre es de una sede concreta: la seleccionada
    const sedeId = sedeEscritura(req);
    const { sql: sff, params: spf } = filtroUnaSede(sedeId, 'f.sede_id');

    const [totales] = await req.db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN fp.metodo_pago='efectivo'      THEN fp.monto ELSE 0 END),0) AS efectivo,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='tarjeta'       THEN fp.monto ELSE 0 END),0) AS tarjeta,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='transferencia' THEN fp.monto ELSE 0 END),0) AS transferencia,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='yape'          THEN fp.monto ELSE 0 END),0) AS yape,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='plin'          THEN fp.monto ELSE 0 END),0) AS plin,
         COALESCE(SUM(fp.monto), 0) AS total
       FROM factura_pagos fp
       JOIN facturas f ON f.id = fp.factura_id
       WHERE ${diaPagoSql(req)} = ? AND f.estado != 'anulado' ${sff}`,
      [fecha, ...spf]
    );

    const result = await req.db.withTransaction(async (conn) => {
      const [[existente]] = await conn.execute(
        `SELECT id, estado FROM caja_cierres
         WHERE fecha=? AND turno=? AND sede_id=?
         ORDER BY created_at DESC LIMIT 1`,
        [fecha, turno, sedeId]
      );
      if (existente?.estado === 'cerrado')
        throw Object.assign(new Error('Ya existe un cierre definitivo para este día/turno.'), { status: 422 });

      // Gastos del día/sede que entran a este cierre, desglosados por método de pago.
      // Solo el efectivo sale de la caja física; el resto se descuenta de su propio método.
      // Con la opción apagada en Configuración, los gastos no entran al cierre.
      const afectan = await gastosAfectanCaja(qConn(conn));
      const gastos  = afectan
        ? await gastosParaCierre(qConn(conn), { fecha, filtro: filtroUnaSede(sedeId, 'g.sede_id'), cierreId: existente?.id })
        : [];
      const gt     = totalesPorMetodo(gastos);
      const efectivoEsperado = parseFloat(monto_inicial) + parseFloat(totales.efectivo) - gt.efectivo;
      const diferencia       = parseFloat((parseFloat(conteo_fisico) - efectivoEsperado).toFixed(2));

      const estado = cerrar ? 'cerrado' : 'borrador';
      let cierreId;

      if (existente?.estado === 'borrador') {
        await conn.execute(
          `UPDATE caja_cierres SET monto_inicial=?,sistema_efectivo=?,sistema_tarjeta=?,
           sistema_transferencia=?,sistema_yape=?,sistema_plin=?,sistema_total=?,
           total_gastos=?,gastos_efectivo=?,gastos_tarjeta=?,gastos_transferencia=?,gastos_yape=?,gastos_plin=?,
           conteo_fisico=?,diferencia=?,estado=?,observaciones=? WHERE id=?`,
          [monto_inicial, totales.efectivo, totales.tarjeta, totales.transferencia,
           totales.yape, totales.plin, totales.total,
           gt.total, gt.efectivo, gt.tarjeta, gt.transferencia, gt.yape, gt.plin,
           conteo_fisico, diferencia, estado, observaciones || null, existente.id]
        );
        cierreId = existente.id;
        if (!afectan) await conn.execute('UPDATE gastos SET cierre_id = NULL WHERE cierre_id = ?', [cierreId]);
      } else {
        const [ins] = await conn.execute(
          `INSERT INTO caja_cierres
             (fecha, turno, realizado_por_id, sede_id, monto_inicial,
              sistema_efectivo, sistema_tarjeta, sistema_transferencia,
              sistema_yape, sistema_plin, sistema_total,
              total_gastos, gastos_efectivo, gastos_tarjeta, gastos_transferencia, gastos_yape, gastos_plin,
              conteo_fisico, diferencia, estado, observaciones)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [fecha, turno, req.user.id, sedeId,
           monto_inicial, totales.efectivo, totales.tarjeta, totales.transferencia,
           totales.yape, totales.plin, totales.total,
           gt.total, gt.efectivo, gt.tarjeta, gt.transferencia, gt.yape, gt.plin,
           conteo_fisico, diferencia, estado, observaciones || null]
        );
        cierreId = ins.insertId;
      }

      // Ligar los gastos a este cierre (al cerrarlo quedan bloqueados para edición)
      if (gastos.length) {
        const ids = gastos.map(g => g.id);
        await conn.execute(
          `UPDATE gastos SET cierre_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
          [cierreId, ...ids]
        );
      }
      return { id: cierreId, diferencia, estado, gastos: gt };
    });

    return res.json({
      success: true,
      message: cerrar ? '✅ Caja cerrada correctamente.' : '💾 Borrador guardado.',
      data: result,
    });
  } catch (err) { next(err); }
});

// PATCH /api/v1/caja/cierres/:id/cerrar
router.patch('/cierres/:id/cerrar', authorize('admin'), auditMiddleware('caja:actualizado', 'caja'), async (req, res, next) => {
  try {
    const [c] = await req.db.query('SELECT id, estado, sede_id FROM caja_cierres WHERE id=?', [req.params.id]);
    if (!c) return res.status(404).json({ success: false, message: 'No encontrado.' });
    exigirAcceso(req, c.sede_id);
    if (c.estado === 'cerrado') return res.status(422).json({ success: false, message: 'Ya está cerrado.' });
    await req.db.query("UPDATE caja_cierres SET estado='cerrado' WHERE id=?", [req.params.id]);
    return res.json({ success: true, message: 'Caja cerrada definitivamente.' });
  } catch (err) { next(err); }
});

module.exports = router;