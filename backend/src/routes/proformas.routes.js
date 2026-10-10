'use strict';

/**
 * VetNetcodip SaaS — Proformas (cotizaciones / presupuestos)
 * Base: /api/v1/proformas
 *
 * - No es comprobante SUNAT: no descuenta stock ni entra a caja.
 * - Se convierte en boleta/factura desde Facturación (POST /facturas con proforma_id).
 * - Roles: admin, recepcionista, veterinario_recepcionista.
 *
 * Estados:
 *   borrador → enviada → aceptada / rechazada
 *   borrador/enviada vencen solas al pasar validez_hasta → vencida
 *   al facturar → facturada (bloqueada)
 */

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');

const router = Router();
const ROLES  = ['admin', 'recepcionista', 'veterinario_recepcionista'];

router.use(authenticate);
router.use(authorize(...ROLES));

const VALIDEZ_DEFAULT     = 30;
const CONDICIONES_DEFAULT =
  'Precios referenciales. El monto final puede variar según la evolución del paciente o ' +
  'complicaciones durante el procedimiento. Esta proforma no constituye comprobante de pago.';

// Transiciones de estado permitidas manualmente
const TRANSICIONES = {
  borrador : ['enviada', 'aceptada', 'rechazada'],
  enviada  : ['aceptada', 'rechazada', 'borrador'],
  aceptada : ['enviada', 'rechazada'],
  rechazada: ['borrador'],
  vencida  : ['rechazada'],
  facturada: [],
};

// ── Helpers de fecha (siempre hora de Lima) ───────────────────────
function hoyLima(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());                                   // YYYY-MM-DD
}

function ahoraLima(tz) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz || 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());                                   // YYYY-MM-DD HH:mm:ss
}

function sumarDias(fechaISO, dias) {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

function fechaValida(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function tz(req) { return req.tenant?.zona_horaria || 'America/Lima'; }

// ── Helpers de sede (mismo criterio que facturas) ─────────────────
function getSedeFiltro(req) {
  const header = req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null;
  if (req.user.rol === 'admin') return header || null;
  return req.user.sede_id || header || null;
}

function sedeSQL(sedeId, col = 'sede_id') {
  if (!sedeId) return { sql: '', params: [] };
  return { sql: `AND ${col} = ?`, params: [sedeId] };
}

// ── Marcar como vencidas las proformas cuyo plazo pasó ────────────
async function marcarVencidas(db, hoy) {
  await db.query(
    `UPDATE proformas SET estado = 'vencida'
     WHERE estado IN ('borrador','enviada') AND validez_hasta < ?`,
    [hoy]
  );
}

// ── Cálculo de totales (misma lógica que facturas.routes.js) ──────
function calcular(items, descuentoGlobalPct, igvIncluido, igvPorcentaje) {
  const igvPct = (parseFloat(igvPorcentaje) || 18) / 100;
  let subtotalBruto  = 0;
  let totalDescItems = 0;

  const itemsCalc = items.map((it, idx) => {
    const cant      = parseFloat(it.cantidad)    || 1;
    const pu        = parseFloat(it.precio_unit) || 0;
    const descPct   = Math.min(Math.max(parseFloat(it.descuento_pct) || 0, 0), 100);
    const bruto     = parseFloat((cant * pu).toFixed(2));
    const descMonto = parseFloat((bruto * descPct / 100).toFixed(2));
    const sub       = parseFloat((bruto - descMonto).toFixed(2));
    subtotalBruto  += bruto;
    totalDescItems += descMonto;

    const servicioId   = parseInt(it.servicio_id)   || null;
    const inventarioId = parseInt(it.inventario_id) || null;
    const tipo = inventarioId ? 'producto' : servicioId ? 'servicio' : 'libre';

    return {
      orden: idx, tipo,
      servicio_id   : servicioId,
      inventario_id : inventarioId,
      descripcion   : String(it.descripcion || '').trim().slice(0, 255),
      cantidad      : cant,
      precio_unit   : pu,
      descuento_pct : descPct,
      descuento_monto: descMonto,
      subtotal      : sub,
    };
  });

  subtotalBruto  = parseFloat(subtotalBruto.toFixed(2));
  totalDescItems = parseFloat(totalDescItems.toFixed(2));

  const descGlobalPct   = Math.min(Math.max(parseFloat(descuentoGlobalPct) || 0, 0), 100);
  const baseTrasItems   = parseFloat((subtotalBruto - totalDescItems).toFixed(2));
  const descGlobalMonto = parseFloat((baseTrasItems * descGlobalPct / 100).toFixed(2));
  const precioFinal     = parseFloat((baseTrasItems - descGlobalMonto).toFixed(2));

  let subtotal, igv, total;
  if (igvIncluido) {
    subtotal = parseFloat((precioFinal / (1 + igvPct)).toFixed(2));
    igv      = parseFloat((precioFinal - subtotal).toFixed(2));
    total    = precioFinal;
  } else {
    subtotal = precioFinal;
    igv      = parseFloat((subtotal * igvPct).toFixed(2));
    total    = parseFloat((subtotal + igv).toFixed(2));
  }

  return {
    itemsCalc,
    subtotal_bruto      : subtotalBruto,
    descuento_items     : totalDescItems,
    descuento_global    : descGlobalMonto,
    descuento_global_pct: descGlobalPct,
    subtotal, igv, total,
  };
}

// ── Validar el cuerpo de crear/editar ─────────────────────────────
async function validarBody(db, body) {
  const { propietario_id, mascota_id, items = [], validez_dias, fecha } = body;

  if (!parseInt(propietario_id)) return 'Selecciona un propietario.';
  if (!Array.isArray(items) || !items.length) return 'Agrega al menos un ítem.';
  if (items.length > 100) return 'Máximo 100 ítems por proforma.';
  for (const it of items) {
    if (!String(it.descripcion || '').trim()) return 'Todos los ítems deben tener descripción.';
    if ((parseFloat(it.cantidad) || 0) <= 0)  return 'La cantidad de cada ítem debe ser mayor a 0.';
    if ((parseFloat(it.precio_unit) || 0) < 0) return 'El precio no puede ser negativo.';
  }
  if (validez_dias !== undefined && validez_dias !== null && validez_dias !== '') {
    const v = parseInt(validez_dias);
    if (!v || v < 1 || v > 365) return 'La validez debe estar entre 1 y 365 días.';
  }
  if (fecha && !fechaValida(fecha)) return 'Fecha inválida.';

  const [prop] = await db.query('SELECT id FROM propietarios WHERE id = ?', [propietario_id]);
  if (!prop) return 'Propietario no encontrado.';

  if (mascota_id) {
    const [masc] = await db.query(
      'SELECT id FROM mascotas WHERE id = ? AND propietario_id = ?', [mascota_id, propietario_id]
    );
    if (!masc) return 'La mascota no pertenece a este propietario.';
  }
  return null;
}

async function insertarItems(conn, proformaId, itemsCalc) {
  for (const it of itemsCalc) {
    await conn.execute(
      `INSERT INTO proforma_items
         (proforma_id, orden, tipo, servicio_id, inventario_id, descripcion,
          cantidad, precio_unit, descuento_pct, descuento_monto, subtotal)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [proformaId, it.orden, it.tipo, it.servicio_id, it.inventario_id, it.descripcion,
       it.cantidad, it.precio_unit, it.descuento_pct, it.descuento_monto, it.subtotal]
    );
  }
}

// Columnas de cabecera con fechas como texto (evita desfase de zona horaria)
const SELECT_CABECERA = `
  p.id, p.numero, p.propietario_id, p.mascota_id, p.historia_clinica_id,
  p.creado_por_id, p.sede_id,
  DATE_FORMAT(p.fecha,'%Y-%m-%d')         AS fecha,
  p.validez_dias,
  DATE_FORMAT(p.validez_hasta,'%Y-%m-%d') AS validez_hasta,
  p.estado, p.igv_incluido,
  p.subtotal_bruto, p.descuento_items, p.descuento_global, p.descuento_global_pct,
  p.subtotal, p.igv, p.total,
  p.notas, p.condiciones, p.motivo_rechazo, p.factura_id,
  DATE_FORMAT(p.enviada_at,  '%Y-%m-%d %H:%i') AS enviada_at,
  DATE_FORMAT(p.aceptada_at, '%Y-%m-%d %H:%i') AS aceptada_at,
  DATE_FORMAT(p.rechazada_at,'%Y-%m-%d %H:%i') AS rechazada_at,
  DATE_FORMAT(p.facturada_at,'%Y-%m-%d %H:%i') AS facturada_at,
  CONCAT(pr.nombre,' ',pr.apellido) AS propietario_nombre,
  pr.dni, pr.telefono, pr.email,
  m.nombre  AS mascota_nombre, m.especie AS mascota_especie, m.raza AS mascota_raza,
  u.nombre  AS creado_por_nombre,
  f.numero  AS factura_numero, f.tipo AS factura_tipo, f.estado AS factura_estado`;

const FROM_CABECERA = `
  FROM proformas p
  JOIN propietarios pr ON pr.id = p.propietario_id
  LEFT JOIN mascotas m ON m.id = p.mascota_id
  LEFT JOIN usuarios u ON u.id = p.creado_por_id
  LEFT JOIN facturas f ON f.id = p.factura_id`;

async function obtenerProforma(db, id) {
  const [pf] = await db.query(`SELECT ${SELECT_CABECERA} ${FROM_CABECERA} WHERE p.id = ?`, [id]);
  if (!pf) return null;
  pf.items = await db.query(
    `SELECT id, orden, tipo, servicio_id, inventario_id, descripcion, cantidad,
            precio_unit, descuento_pct, descuento_monto, subtotal
     FROM proforma_items WHERE proforma_id = ? ORDER BY orden, id`, [id]
  );
  return pf;
}

// ══════════════════════════════════════════════════════════════════
// GET /api/v1/proformas/config — valores por defecto para el formulario
// ══════════════════════════════════════════════════════════════════
router.get('/config', async (req, res, next) => {
  try {
    const [cfg] = await req.db.query('SELECT * FROM empresa_config LIMIT 1');
    return res.json({
      success: true,
      data: {
        validez_dias: parseInt(cfg?.proforma_validez_dias) || VALIDEZ_DEFAULT,
        condiciones : cfg?.proforma_condiciones || CONDICIONES_DEFAULT,
        serie       : cfg?.serie_proforma || 'P001',
        hoy         : hoyLima(tz(req)),
      },
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/v1/proformas/resumen?desde&hasta — indicadores del período
// ══════════════════════════════════════════════════════════════════
router.get('/resumen', async (req, res, next) => {
  try {
    const hoy = hoyLima(tz(req));
    await marcarVencidas(req.db, hoy);

    const desde = fechaValida(req.query.desde) ? req.query.desde : hoy.slice(0, 8) + '01';
    const hasta = fechaValida(req.query.hasta) ? req.query.hasta : hoy;
    const { sql: sf, params: sp } = sedeSQL(getSedeFiltro(req), 'sede_id');

    const [r] = await req.db.query(
      `SELECT
         COUNT(*)                                                      AS total,
         COALESCE(SUM(total),0)                                        AS monto_cotizado,
         SUM(estado IN ('borrador','enviada'))                         AS abiertas,
         COALESCE(SUM(CASE WHEN estado IN ('borrador','enviada') THEN total END),0) AS monto_abierto,
         SUM(estado = 'aceptada')                                      AS aceptadas,
         SUM(estado = 'facturada')                                     AS facturadas,
         COALESCE(SUM(CASE WHEN estado = 'facturada' THEN total END),0) AS monto_facturado,
         SUM(estado = 'rechazada')                                     AS rechazadas,
         SUM(estado = 'vencida')                                       AS vencidas
       FROM proformas
       WHERE fecha BETWEEN ? AND ? ${sf}`,
      [desde, hasta, ...sp]
    );

    const total    = parseInt(r.total) || 0;
    const cerradas = (parseInt(r.aceptadas) || 0) + (parseInt(r.facturadas) || 0);
    const decididas = cerradas + (parseInt(r.rechazadas) || 0) + (parseInt(r.vencidas) || 0);

    return res.json({
      success: true,
      data: {
        desde, hasta, total,
        monto_cotizado : parseFloat(r.monto_cotizado),
        abiertas       : parseInt(r.abiertas)   || 0,
        monto_abierto  : parseFloat(r.monto_abierto),
        aceptadas      : parseInt(r.aceptadas)  || 0,
        facturadas     : parseInt(r.facturadas) || 0,
        monto_facturado: parseFloat(r.monto_facturado),
        rechazadas     : parseInt(r.rechazadas) || 0,
        vencidas       : parseInt(r.vencidas)   || 0,
        tasa_cierre    : decididas ? Math.round(cerradas * 100 / decididas) : 0,
      },
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/v1/proformas?estado&search&desde&hasta&page&limit
// ══════════════════════════════════════════════════════════════════
router.get('/', async (req, res, next) => {
  try {
    await marcarVencidas(req.db, hoyLima(tz(req)));

    const { estado, search, desde, hasta } = req.query;
    const page   = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit  = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];

    if (estado && TRANSICIONES[estado] !== undefined) {
      where += ' AND p.estado = ?'; params.push(estado);
    } else if (estado === 'abiertas') {
      where += " AND p.estado IN ('borrador','enviada')";
    }
    if (fechaValida(desde)) { where += ' AND p.fecha >= ?'; params.push(desde); }
    if (fechaValida(hasta)) { where += ' AND p.fecha <= ?'; params.push(hasta); }
    if (search?.trim()) {
      const q = `%${search.trim()}%`;
      where += ` AND (p.numero LIKE ? OR pr.nombre LIKE ? OR pr.apellido LIKE ?
                      OR CONCAT(pr.nombre,' ',pr.apellido) LIKE ? OR pr.dni LIKE ? OR m.nombre LIKE ?)`;
      params.push(q, q, q, q, q, q);
    }
    const { sql: sf, params: sp } = sedeSQL(getSedeFiltro(req), 'p.sede_id');
    where += ` ${sf}`; params.push(...sp);

    const [{ total }] = await req.db.query(
      `SELECT COUNT(*) AS total
       FROM proformas p
       JOIN propietarios pr ON pr.id = p.propietario_id
       LEFT JOIN mascotas m ON m.id = p.mascota_id
       ${where}`, params
    );

    const rows = await req.db.query(
      `SELECT ${SELECT_CABECERA} ${FROM_CABECERA}
       ${where}
       ORDER BY p.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return res.json({
      success: true,
      data: rows,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/v1/proformas/:id
// ══════════════════════════════════════════════════════════════════
router.get('/:id', async (req, res, next) => {
  try {
    await marcarVencidas(req.db, hoyLima(tz(req)));
    const pf = await obtenerProforma(req.db, req.params.id);
    if (!pf) return res.status(404).json({ success: false, message: 'Proforma no encontrada.' });
    return res.json({ success: true, data: pf });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/v1/proformas — crear
// ══════════════════════════════════════════════════════════════════
router.post('/', auditMiddleware('proformas:creado', 'proformas'), async (req, res, next) => {
  try {
    const error = await validarBody(req.db, req.body);
    if (error) return res.status(422).json({ success: false, message: error });

    const {
      propietario_id, mascota_id, historia_clinica_id,
      items, igv_incluido = true, descuento_global_pct = 0,
      notas, condiciones,
    } = req.body;

    const sedeId = req.user.sede_id ||
                   (req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null);
    const fecha  = fechaValida(req.body.fecha) ? req.body.fecha : hoyLima(tz(req));

    const result = await req.db.withTransaction(async (conn) => {
      // Bloquea la fila para que dos usuarios no saquen el mismo número
      const [[cfg]] = await conn.execute('SELECT * FROM empresa_config LIMIT 1 FOR UPDATE');
      if (!cfg) throw Object.assign(new Error('Configuración de empresa no encontrada.'), { status: 500 });

      const validezDias = parseInt(req.body.validez_dias) || parseInt(cfg.proforma_validez_dias) || VALIDEZ_DEFAULT;
      const serie       = cfg.serie_proforma || 'P001';
      const correlativo = parseInt(cfg.correlativo_p) || 1;
      const numero      = `${serie}-${String(correlativo).padStart(5, '0')}`;
      await conn.execute('UPDATE empresa_config SET correlativo_p = ? WHERE id = ?', [correlativo + 1, cfg.id]);

      const calc = calcular(items, descuento_global_pct, !!igv_incluido, cfg.igv_porcentaje);
      const condFinal = (condiciones ?? '').toString().trim() || cfg.proforma_condiciones || CONDICIONES_DEFAULT;

      const [ins] = await conn.execute(
        `INSERT INTO proformas
           (numero, propietario_id, mascota_id, historia_clinica_id, creado_por_id, sede_id,
            fecha, validez_dias, validez_hasta, estado, igv_incluido,
            subtotal_bruto, descuento_items, descuento_global, descuento_global_pct,
            subtotal, igv, total, notas, condiciones)
         VALUES (?,?,?,?,?,?,?,?,?,'borrador',?,?,?,?,?,?,?,?,?,?)`,
        [
          numero, propietario_id, mascota_id || null, parseInt(historia_clinica_id) || null,
          req.user.id, sedeId,
          fecha, validezDias, sumarDias(fecha, validezDias), igv_incluido ? 1 : 0,
          calc.subtotal_bruto, calc.descuento_items, calc.descuento_global, calc.descuento_global_pct,
          calc.subtotal, calc.igv, calc.total,
          notas?.toString().trim() || null, condFinal,
        ]
      );
      await insertarItems(conn, ins.insertId, calc.itemsCalc);
      return { id: ins.insertId, numero, total: calc.total };
    });

    return res.status(201).json({ success: true, data: result, message: `Proforma ${result.numero} creada.` });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// PUT /api/v1/proformas/:id — editar (borrador, enviada o vencida)
// Si estaba vencida, se renueva la validez y vuelve a borrador.
// ══════════════════════════════════════════════════════════════════
router.put('/:id', auditMiddleware('proformas:actualizado', 'proformas'), async (req, res, next) => {
  try {
    const [actual] = await req.db.query('SELECT id, estado FROM proformas WHERE id = ?', [req.params.id]);
    if (!actual) return res.status(404).json({ success: false, message: 'Proforma no encontrada.' });
    if (!['borrador', 'enviada', 'vencida'].includes(actual.estado)) {
      return res.status(422).json({
        success: false,
        message: `No se puede editar una proforma ${actual.estado}. Usa "Duplicar" para crear una nueva.`,
      });
    }

    const error = await validarBody(req.db, req.body);
    if (error) return res.status(422).json({ success: false, message: error });

    const {
      propietario_id, mascota_id, items, igv_incluido = true,
      descuento_global_pct = 0, notas, condiciones,
    } = req.body;
    const fecha = fechaValida(req.body.fecha) ? req.body.fecha : hoyLima(tz(req));

    await req.db.withTransaction(async (conn) => {
      const [[pf]] = await conn.execute('SELECT id, estado FROM proformas WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!pf || !['borrador', 'enviada', 'vencida'].includes(pf.estado)) {
        throw Object.assign(new Error('La proforma cambió de estado. Recarga la página.'), { status: 409 });
      }
      const [[cfg]] = await conn.execute('SELECT * FROM empresa_config LIMIT 1');

      const validezDias = parseInt(req.body.validez_dias) || parseInt(cfg?.proforma_validez_dias) || VALIDEZ_DEFAULT;
      const validezHasta = sumarDias(fecha, validezDias);
      let nuevoEstado = pf.estado;
      if (pf.estado === 'vencida') nuevoEstado = validezHasta >= hoyLima(tz(req)) ? 'borrador' : 'vencida';

      const calc = calcular(items, descuento_global_pct, !!igv_incluido, cfg?.igv_porcentaje);
      const condFinal = (condiciones ?? '').toString().trim() || cfg?.proforma_condiciones || CONDICIONES_DEFAULT;

      await conn.execute(
        `UPDATE proformas SET
           propietario_id=?, mascota_id=?, fecha=?, validez_dias=?, validez_hasta=?, estado=?,
           igv_incluido=?, subtotal_bruto=?, descuento_items=?, descuento_global=?, descuento_global_pct=?,
           subtotal=?, igv=?, total=?, notas=?, condiciones=?
         WHERE id=?`,
        [
          propietario_id, mascota_id || null, fecha, validezDias, validezHasta, nuevoEstado,
          igv_incluido ? 1 : 0, calc.subtotal_bruto, calc.descuento_items, calc.descuento_global,
          calc.descuento_global_pct, calc.subtotal, calc.igv, calc.total,
          notas?.toString().trim() || null, condFinal, req.params.id,
        ]
      );
      await conn.execute('DELETE FROM proforma_items WHERE proforma_id = ?', [req.params.id]);
      await insertarItems(conn, req.params.id, calc.itemsCalc);
    });

    const pf = await obtenerProforma(req.db, req.params.id);
    return res.json({ success: true, data: pf, message: `Proforma ${pf.numero} actualizada.` });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// PATCH /api/v1/proformas/:id/estado — { estado, motivo_rechazo }
// ══════════════════════════════════════════════════════════════════
router.patch('/:id/estado', auditMiddleware('proformas:estado', 'proformas'), async (req, res, next) => {
  try {
    const { estado, motivo_rechazo } = req.body;
    const [pf] = await req.db.query(
      "SELECT id, numero, estado, DATE_FORMAT(validez_hasta,'%Y-%m-%d') AS validez_hasta FROM proformas WHERE id = ?",
      [req.params.id]
    );
    if (!pf) return res.status(404).json({ success: false, message: 'Proforma no encontrada.' });

    const permitidos = TRANSICIONES[pf.estado] || [];
    if (!permitidos.includes(estado)) {
      return res.status(422).json({
        success: false,
        message: `No se puede pasar de "${pf.estado}" a "${estado}".`,
      });
    }
    if (estado === 'rechazada' && !motivo_rechazo?.trim()) {
      return res.status(422).json({ success: false, message: 'Indica el motivo del rechazo.' });
    }
    if (['borrador', 'enviada'].includes(estado) && pf.validez_hasta < hoyLima(tz(req))) {
      return res.status(422).json({
        success: false,
        message: 'La proforma ya venció. Edítala para renovar la validez o usa "Duplicar".',
      });
    }

    const ahora = ahoraLima(tz(req));
    const sets  = ['estado = ?'];
    const vals  = [estado];
    if (estado === 'enviada')   { sets.push('enviada_at = ?');   vals.push(ahora); }
    if (estado === 'aceptada')  { sets.push('aceptada_at = ?');  vals.push(ahora); }
    if (estado === 'rechazada') {
      sets.push('rechazada_at = ?', 'motivo_rechazo = ?');
      vals.push(ahora, motivo_rechazo.trim().slice(0, 255));
    }
    if (estado === 'borrador')  { sets.push('motivo_rechazo = NULL', 'rechazada_at = NULL'); }

    await req.db.query(`UPDATE proformas SET ${sets.join(', ')} WHERE id = ?`, [...vals, req.params.id]);

    const etiquetas = { enviada: 'marcada como enviada', aceptada: 'aceptada', rechazada: 'rechazada', borrador: 'reabierta' };
    return res.json({ success: true, message: `Proforma ${pf.numero} ${etiquetas[estado] || estado}.` });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/v1/proformas/:id/duplicar — copia como borrador nuevo
// (útil para renovar una vencida o rehacer una rechazada)
// ══════════════════════════════════════════════════════════════════
router.post('/:id/duplicar', auditMiddleware('proformas:duplicado', 'proformas'), async (req, res, next) => {
  try {
    const orig = await obtenerProforma(req.db, req.params.id);
    if (!orig) return res.status(404).json({ success: false, message: 'Proforma no encontrada.' });

    const sedeId = req.user.sede_id ||
                   (req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null) || orig.sede_id;
    const fecha  = hoyLima(tz(req));

    const result = await req.db.withTransaction(async (conn) => {
      const [[cfg]] = await conn.execute('SELECT * FROM empresa_config LIMIT 1 FOR UPDATE');
      const serie       = cfg.serie_proforma || 'P001';
      const correlativo = parseInt(cfg.correlativo_p) || 1;
      const numero      = `${serie}-${String(correlativo).padStart(5, '0')}`;
      await conn.execute('UPDATE empresa_config SET correlativo_p = ? WHERE id = ?', [correlativo + 1, cfg.id]);

      const validezDias = parseInt(orig.validez_dias) || parseInt(cfg.proforma_validez_dias) || VALIDEZ_DEFAULT;
      const calc = calcular(orig.items, orig.descuento_global_pct, !!orig.igv_incluido, cfg.igv_porcentaje);

      const [ins] = await conn.execute(
        `INSERT INTO proformas
           (numero, propietario_id, mascota_id, historia_clinica_id, creado_por_id, sede_id,
            fecha, validez_dias, validez_hasta, estado, igv_incluido,
            subtotal_bruto, descuento_items, descuento_global, descuento_global_pct,
            subtotal, igv, total, notas, condiciones)
         VALUES (?,?,?,?,?,?,?,?,?,'borrador',?,?,?,?,?,?,?,?,?,?)`,
        [
          numero, orig.propietario_id, orig.mascota_id, orig.historia_clinica_id,
          req.user.id, sedeId,
          fecha, validezDias, sumarDias(fecha, validezDias), orig.igv_incluido ? 1 : 0,
          calc.subtotal_bruto, calc.descuento_items, calc.descuento_global, calc.descuento_global_pct,
          calc.subtotal, calc.igv, calc.total,
          orig.notas, orig.condiciones,
        ]
      );
      await insertarItems(conn, ins.insertId, calc.itemsCalc);
      return { id: ins.insertId, numero };
    });

    return res.status(201).json({
      success: true, data: result,
      message: `Se creó ${result.numero} como copia de ${orig.numero}.`,
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// DELETE /api/v1/proformas/:id — solo borradores
// (admin cualquiera, otros roles solo las que crearon)
// ══════════════════════════════════════════════════════════════════
router.delete('/:id', auditMiddleware('proformas:eliminado', 'proformas'), async (req, res, next) => {
  try {
    const [pf] = await req.db.query(
      'SELECT id, numero, estado, creado_por_id FROM proformas WHERE id = ?', [req.params.id]
    );
    if (!pf) return res.status(404).json({ success: false, message: 'Proforma no encontrada.' });
    if (pf.estado !== 'borrador') {
      return res.status(422).json({
        success: false,
        message: 'Solo se pueden eliminar proformas en borrador. Las demás se marcan como rechazadas.',
      });
    }
    if (req.user.rol !== 'admin' && pf.creado_por_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Solo puedes eliminar las proformas que creaste.' });
    }
    await req.db.query('DELETE FROM proformas WHERE id = ?', [req.params.id]);
    return res.json({ success: true, message: `Proforma ${pf.numero} eliminada.` });
  } catch (err) { next(err); }
});

module.exports = router;