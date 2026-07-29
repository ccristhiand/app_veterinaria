'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);

// ── Helper: filtro de sede ────────────────────────────────────────
function getSedeFiltro(req) {
  const user   = req.user;
  const header = req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null;
  if (user.rol === 'admin') return header || null;
  return user.sede_id || header || null;
}

// ── GET /api/v1/facturas/resumen ──────────────────────────────────
router.get('/resumen', async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const hoy    = desde || new Date().toISOString().split('T')[0];
    const hasta_ = hasta || hoy;
    const sedeId = getSedeFiltro(req);
    const sf     = sedeId ? 'AND f.sede_id = ?' : '';
    const sp     = sedeId ? [sedeId] : [];

    const [totales] = await req.db.query(
      `SELECT
         COUNT(*)                                                             AS total_docs,
         COALESCE(SUM(CASE WHEN estado='pagado'    THEN total ELSE 0 END),0) AS ingresos,
         COALESCE(SUM(CASE WHEN estado='pendiente' THEN total ELSE 0 END),0) AS pendiente,
         COUNT(CASE WHEN estado='pagado'    THEN 1 END) AS docs_pagados,
         COUNT(CASE WHEN estado='pendiente' THEN 1 END) AS docs_pendientes,
         COUNT(CASE WHEN estado='anulado'   THEN 1 END) AS docs_anulados
       FROM facturas
       WHERE fecha BETWEEN ? AND ? AND estado != 'anulado' ${sf}`,
      [hoy, hasta_, ...sp]
    );

    const porMetodo = await req.db.query(
      `SELECT fp.metodo_pago, SUM(fp.monto) AS monto, COUNT(*) AS cantidad
       FROM factura_pagos fp
       JOIN facturas f ON f.id = fp.factura_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado = 'pagado' ${sf}
       GROUP BY fp.metodo_pago ORDER BY monto DESC`,
      [hoy, hasta_, ...sp]
    );

    const por7dias = await req.db.query(
      `SELECT DATE(fecha) AS dia, SUM(total) AS monto, COUNT(*) AS cantidad
       FROM facturas
       WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) AND estado = 'pagado' ${sf}
       GROUP BY DATE(fecha) ORDER BY dia ASC`,
      [...sp]
    );

    const topServicios = await req.db.query(
      `SELECT fi.descripcion,
              SUM(fi.cantidad) AS cantidad_total,
              SUM(fi.subtotal) AS monto_total
       FROM factura_items fi
       JOIN facturas f ON f.id = fi.factura_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado = 'pagado' ${sf}
       GROUP BY fi.descripcion ORDER BY monto_total DESC LIMIT 8`,
      [hoy, hasta_, ...sp]
    );

    return res.json({
      success: true,
      data: { totales, porMetodo, por7dias, topServicios, periodo: { desde: hoy, hasta: hasta_ } },
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/facturas — listar ─────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { fecha, estado, tipo, propietario_id, page = 1, limit = 30 } = req.query;
    const limitN  = Math.min(parseInt(limit) || 30, 100);
    const offsetN = (Math.max(parseInt(page) || 1, 1) - 1) * limitN;
    const sedeId  = getSedeFiltro(req);

    let sql = `
      SELECT f.id, f.numero, f.tipo, f.fecha, f.subtotal, f.igv, f.total,
             f.estado, f.metodo_pago, f.created_at, f.updated_at,
             f.observaciones, f.anulado_por,
             f.sunat_estado, f.sunat_mensaje, f.enlace_pdf, f.enlace_xml, f.sunat_enviado_at,
             CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
             CONCAT(p.nombre,' ',p.apellido) AS cliente_nombre,
             p.dni AS cliente_dni,
             m.nombre AS mascota_nombre, m.especie,
             u.nombre AS emitido_por_nombre,
             s.nombre AS sede_nombre
      FROM facturas f
      JOIN propietarios p ON p.id = f.propietario_id
      LEFT JOIN mascotas m ON m.id = f.mascota_id
      JOIN usuarios u ON u.id = f.emitido_por_id
      LEFT JOIN sedes s ON s.id = f.sede_id
      WHERE 1=1`;
    const params = [];

    if (sedeId)         { sql += ' AND f.sede_id = ?';          params.push(sedeId); }
    if (fecha)          { sql += ' AND f.fecha = ?';            params.push(fecha); }
    if (estado)         { sql += ' AND f.estado = ?';           params.push(estado); }
    if (tipo)           { sql += ' AND f.tipo = ?';             params.push(tipo); }
    if (propietario_id) { sql += ' AND f.propietario_id = ?';   params.push(propietario_id); }

    sql += ` ORDER BY f.created_at DESC LIMIT ${limitN} OFFSET ${offsetN}`;

    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/v1/facturas/:id — detalle ───────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [factura] = await req.db.query(
      `SELECT f.*,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
              p.dni, p.telefono, p.email AS propietario_email,
              p.direccion AS propietario_dir,
              p.ruc AS propietario_ruc,
              p.razon_social AS propietario_razon_social,
              p.direccion_fiscal AS propietario_dir_fiscal,
              m.nombre AS mascota_nombre, m.especie,
              u.nombre AS emitido_por_nombre,
              s.nombre AS sede_nombre
       FROM facturas f
       JOIN propietarios p ON p.id = f.propietario_id
       LEFT JOIN mascotas m ON m.id = f.mascota_id
       JOIN usuarios u ON u.id = f.emitido_por_id
       LEFT JOIN sedes s ON s.id = f.sede_id
       WHERE f.id = ?`, [req.params.id]
    );
    if (!factura) return res.status(404).json({ success: false, message: 'Factura no encontrada.' });

    const items = await req.db.query(
      'SELECT * FROM factura_items WHERE factura_id = ? ORDER BY id', [req.params.id]
    );
    const pagos = await req.db.query(
      'SELECT * FROM factura_pagos WHERE factura_id = ? ORDER BY id', [req.params.id]
    );

    return res.json({ success: true, data: { ...factura, items, pagos } });
  } catch (err) { next(err); }
});

// ── POST /api/v1/facturas — crear ────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      tipo = 'boleta', propietario_id, mascota_id, cita_id, fecha,
      items = [], igv_incluido = true, pagos = [], notas,
      cliente_ruc, cliente_razon_social, cliente_direccion_fiscal,
    } = req.body;

    if (!propietario_id) return res.status(422).json({ success: false, message: 'propietario_id requerido.' });
    if (!fecha)          return res.status(422).json({ success: false, message: 'fecha requerida.' });
    if (!items.length)   return res.status(422).json({ success: false, message: 'Debe incluir al menos un ítem.' });

    if (tipo === 'factura') {
      const rucFinal = cliente_ruc?.trim() || '';
      if (!rucFinal || !/^\d{11}$/.test(rucFinal))
        return res.status(422).json({ success: false, message: 'Para emitir una factura se requiere RUC válido de 11 dígitos.' });
      if (!cliente_razon_social?.trim())
        return res.status(422).json({ success: false, message: 'Para emitir una factura se requiere la razón social.' });
    }

    // Sede del usuario que emite
    const sedeId = req.user.sede_id ||
                   (req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null);

    const result = await req.db.withTransaction(async (conn) => {
      for (const it of items) {
        if (it.inventario_id) {
          const [[inv]] = await conn.execute(
            'SELECT nombre, cantidad, unidad FROM inventario WHERE id = ?', [it.inventario_id]
          );
          if (inv && parseFloat(it.cantidad) > parseFloat(inv.cantidad)) {
            throw Object.assign(
              new Error(`Stock insuficiente para "${inv.nombre}": solicitado ${it.cantidad} ${inv.unidad||''}, disponible ${inv.cantidad} ${inv.unidad||''}.`),
              { status: 422 }
            );
          }
        }
      }

      const [[cfg]] = await conn.execute('SELECT * FROM empresa_config LIMIT 1');
      if (!cfg) throw Object.assign(new Error('Configuración de empresa no encontrada.'), { status: 500 });

      const igvPct = parseFloat(cfg.igv_porcentaje) / 100;

      let numero;
      if (tipo === 'factura') {
        numero = `${cfg.serie_factura}-${String(cfg.correlativo_f).padStart(5, '0')}`;
        await conn.execute('UPDATE empresa_config SET correlativo_f = correlativo_f + 1 WHERE id = ?', [cfg.id]);
      } else {
        numero = `${cfg.serie_boleta}-${String(cfg.correlativo_b).padStart(5, '0')}`;
        await conn.execute('UPDATE empresa_config SET correlativo_b = correlativo_b + 1 WHERE id = ?', [cfg.id]);
      }

      let totalPrecios = 0;
      const itemsCalc = items.map(it => {
        const cant = parseFloat(it.cantidad) || 1;
        const pu   = parseFloat(it.precio_unit) || 0;
        const sub  = parseFloat((cant * pu).toFixed(2));
        totalPrecios += sub;
        return { descripcion: it.descripcion, cantidad: cant, precio_unit: pu, subtotal: sub, inventario_id: it.inventario_id || null };
      });
      totalPrecios = parseFloat(totalPrecios.toFixed(2));

      let subtotal, igv, total;
      if (igv_incluido) {
        subtotal = parseFloat((totalPrecios / (1 + igvPct)).toFixed(2));
        igv      = parseFloat((totalPrecios - subtotal).toFixed(2));
        total    = totalPrecios;
      } else {
        subtotal = totalPrecios;
        igv      = parseFloat((subtotal * igvPct).toFixed(2));
        total    = parseFloat((subtotal + igv).toFixed(2));
      }

      const pagosValidos    = pagos.filter(p => p.metodo_pago && parseFloat(p.monto) > 0);
      const totalPagado     = pagosValidos.reduce((a, p) => a + parseFloat(p.monto), 0);
      const estado          = totalPagado >= total || pagosValidos.length > 0 ? 'pagado' : 'pendiente';
      const metodoPrincipal = pagosValidos.length > 0
        ? pagosValidos.reduce((a, b) => parseFloat(b.monto) > parseFloat(a.monto) ? b : a).metodo_pago
        : null;

      // INSERT con sede_id
      const [ins] = await conn.execute(
        `INSERT INTO facturas
           (numero, tipo, propietario_id, mascota_id, cita_id, emitido_por_id, sede_id,
            fecha, subtotal, igv, total, estado, metodo_pago, notas,
            cliente_ruc, cliente_razon_social, cliente_direccion_fiscal)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          numero, tipo, propietario_id, mascota_id || null, cita_id || null,
          req.user.id, sedeId,
          fecha, subtotal, igv, total, estado, metodoPrincipal, notas?.trim() || null,
          cliente_ruc?.trim() || null, cliente_razon_social?.trim() || null, cliente_direccion_fiscal?.trim() || null,
        ]
      );
      const facturaId = ins.insertId;

      for (const it of itemsCalc) {
        const invId = it.inventario_id ? parseInt(it.inventario_id) : null;
        await conn.execute(
          'INSERT INTO factura_items (factura_id, descripcion, cantidad, precio_unit, subtotal, inventario_id) VALUES (?,?,?,?,?,?)',
          [facturaId, it.descripcion, it.cantidad, it.precio_unit, it.subtotal, invId]
        );
        if (invId) {
          await conn.execute(
            'UPDATE inventario SET cantidad = GREATEST(0, cantidad - ?) WHERE id = ?',
            [it.cantidad, invId]
          );
          const [[inv]] = await conn.execute(
            'SELECT nombre, cantidad, stock_minimo, unidad FROM inventario WHERE id = ?', [invId]
          );
          if (inv) {
            const io = req.app.get('io');
            if (io) {
              const payload = { id: invId, nombre: inv.nombre, cantidad: inv.cantidad, unidad: inv.unidad };
              io.to('sala:admin').emit('inventario:actualizado', payload);
              io.to('sala:veterinarios').emit('inventario:actualizado', payload);
              io.to('sala:recepcionistas').emit('inventario:actualizado', payload);
              if (parseFloat(inv.cantidad) < parseFloat(inv.stock_minimo)) {
                io.to('sala:admin').emit('notif:stock_minimo', {
                  nombre: inv.nombre, cantidad: inv.cantidad,
                  stock_minimo: inv.stock_minimo, unidad: inv.unidad,
                });
              }
            }
          }
        }
      }

      for (const pago of pagosValidos) {
        await conn.execute(
          'INSERT INTO factura_pagos (factura_id, metodo_pago, monto, referencia) VALUES (?,?,?,?)',
          [facturaId, pago.metodo_pago, parseFloat(pago.monto), pago.referencia?.trim() || null]
        );
      }

      return { id: facturaId, numero, subtotal, igv, total, estado, pagos: pagosValidos.length };
    });

    return res.status(201).json({ success: true, data: result, message: 'Documento emitido correctamente.' });
  } catch (err) { next(err); }
});

// ── PATCH /api/v1/facturas/:id/pagar ─────────────────────────────
router.patch('/:id/pagar', async (req, res, next) => {
  try {
    const { pagos = [], metodo_pago } = req.body;
    const [fac] = await req.db.query('SELECT id, estado, total FROM facturas WHERE id = ?', [req.params.id]);
    if (!fac)                     return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
    if (fac.estado === 'anulado') return res.status(422).json({ success: false, message: 'No se puede pagar una factura anulada.' });
    if (fac.estado === 'pagado')  return res.status(422).json({ success: false, message: 'La factura ya está pagada.' });

    await req.db.withTransaction(async (conn) => {
      await conn.execute('DELETE FROM factura_pagos WHERE factura_id = ?', [req.params.id]);

      let pagosValidos = [];
      if (pagos.length > 0) {
        pagosValidos = pagos.filter(p => p.metodo_pago && parseFloat(p.monto) > 0);
      } else if (metodo_pago) {
        pagosValidos = [{ metodo_pago, monto: fac.total, referencia: null }];
      }
      if (!pagosValidos.length)
        throw Object.assign(new Error('Debes ingresar al menos un método de pago con monto.'), { status: 422 });

      for (const pago of pagosValidos) {
        await conn.execute(
          'INSERT INTO factura_pagos (factura_id, metodo_pago, monto, referencia) VALUES (?,?,?,?)',
          [req.params.id, pago.metodo_pago, parseFloat(pago.monto), pago.referencia?.trim() || null]
        );
      }

      const metodoPrincipal = pagosValidos.reduce((a, b) => parseFloat(b.monto) > parseFloat(a.monto) ? b : a).metodo_pago;
      await conn.execute(
        "UPDATE facturas SET estado = 'pagado', metodo_pago = ? WHERE id = ?",
        [metodoPrincipal, req.params.id]
      );
    });

    return res.json({ success: true, message: 'Pago registrado correctamente.' });
  } catch (err) { next(err); }
});

// ── PATCH /api/v1/facturas/:id/anular — solo admin ───────────────
router.patch('/:id/anular', authorize('admin'), async (req, res, next) => {
  try {
    const { observaciones } = req.body;
    if (!observaciones?.trim())
      return res.status(422).json({ success: false, message: 'El motivo de anulación es obligatorio.' });

    const [fac] = await req.db.query(
      `SELECT f.id, f.estado, f.numero, f.total, f.tipo,
              CONCAT(p.nombre,' ',p.apellido) AS cliente
       FROM facturas f JOIN propietarios p ON p.id = f.propietario_id
       WHERE f.id = ?`, [req.params.id]
    );
    if (!fac)                       return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
    if (fac.estado === 'anulado')   return res.status(422).json({ success: false, message: 'Ya está anulada.' });

    await req.db.query(
      "UPDATE facturas SET estado='anulado', observaciones=?, anulado_por=?, updated_at=NOW() WHERE id=?",
      [observaciones.trim(), req.user.nombre, req.params.id]
    );

    const items = await req.db.query(
      'SELECT inventario_id, cantidad FROM factura_items WHERE factura_id = ? AND inventario_id IS NOT NULL',
      [req.params.id]
    );
    const io = req.app.get('io');
    for (const item of items) {
      await req.db.query(
        'UPDATE inventario SET cantidad = cantidad + ?, updated_at=NOW() WHERE id = ?',
        [item.cantidad, item.inventario_id]
      );
      if (io) {
        const [inv] = await req.db.query(
          'SELECT nombre, cantidad, unidad FROM inventario WHERE id = ?', [item.inventario_id]
        );
        if (inv) {
          const payload = { id: item.inventario_id, nombre: inv.nombre, cantidad: inv.cantidad, unidad: inv.unidad };
          io.to('sala:admin').emit('inventario:actualizado', payload);
          io.to('sala:veterinarios').emit('inventario:actualizado', payload);
          io.to('sala:recepcionistas').emit('inventario:actualizado', payload);
        }
      }
    }

    const mensaje = `${fac.tipo === 'factura' ? 'Factura' : 'Boleta'} ${fac.numero} anulada por ${req.user.nombre}. Motivo: ${observaciones.trim()}. Total: S/. ${parseFloat(fac.total).toFixed(2)}`;
    const admins  = await req.db.query("SELECT id FROM usuarios WHERE rol='admin' AND activo=1");
    for (const admin of admins) {
      await req.db.query(
        "INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje) VALUES (?, 'anulacion', '🚫 Documento anulado', ?)",
        [admin.id, mensaje]
      );
    }
    if (io) {
      io.to('sala:admin').emit('notif:anulacion', {
        tipo: 'anulacion', titulo: '🚫 Documento anulado',
        mensaje, numero: fac.numero, total: fac.total,
      });
    }

    return res.json({ success: true, message: `Documento ${fac.numero} anulado correctamente.` });
  } catch (err) { next(err); }
});

module.exports = router;