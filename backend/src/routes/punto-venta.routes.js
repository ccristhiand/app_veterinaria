'use strict';

/**
 * VetNetcodip SaaS — Punto de Venta (ventas de mostrador)
 * Base: /api/v1/punto-venta
 *
 * El cobro NO tiene endpoint propio: el frontend llama a POST /api/v1/facturas
 * con origen = 'punto_venta'. Así cada venta es una boleta/factura normal que
 * descuenta stock y entra sola al Cierre de Caja y a Reportes.
 *
 * Este router solo da lo que la pantalla necesita para ser rápida:
 *   GET /config      → cliente "Público General", datos de empresa para el ticket
 *   GET /buscar?q=   → productos + servicios (nombre o código de barras exacto)
 *   GET /favoritos   → botones rápidos
 *   GET /ventas-hoy  → últimas ventas del día (para reimprimir ticket)
 */

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'recepcionista', 'veterinario_recepcionista'));

const LIMITE_SIN_DNI = 700;   // SUNAT: boleta ≥ S/ 700 requiere identificar al cliente

function hoyLima(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Misma regla de sede que inventario: el usuario con sede ve su sede + ítems sin sede
function getSedeFiltro(req) {
  const header = req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null;
  if (req.user.rol === 'admin') return header || null;
  return req.user.sede_id || header || null;
}

function migracionFaltante(err) {
  return err && err.code === 'ER_BAD_FIELD_ERROR';
}

function errorMigracion(res) {
  return res.status(409).json({
    success: false,
    code   : 'MIGRACION_PENDIENTE',
    message: 'El Punto de Venta aún no está activado para esta clínica. Falta ejecutar la migración punto_venta_migracion.sql.',
  });
}

// Obtiene (o crea si falta) el cliente "Público General"
async function clienteGenerico(db) {
  const [c] = await db.query(
    'SELECT id, nombre, apellido FROM propietarios WHERE es_generico = 1 ORDER BY id LIMIT 1'
  );
  if (c) return c;
  const r = await db.query(
    "INSERT INTO propietarios (tipo_documento, nombre, apellido, es_generico) VALUES ('OTRO','Público','General',1)"
  );
  return { id: r.insertId, nombre: 'Público', apellido: 'General' };
}

function mapProducto(i) {
  return {
    tipo         : 'producto',
    id           : i.id,
    nombre       : i.nombre,
    categoria    : i.categoria,
    precio       : parseFloat(i.precio_unitario) || 0,
    stock        : parseFloat(i.cantidad) || 0,
    unidad       : i.unidad || 'unidad',
    codigo_barras: i.codigo_barras || null,
    favorito     : !!i.favorito,
  };
}

function mapServicio(s) {
  return {
    tipo     : 'servicio',
    id       : s.id,
    nombre   : s.nombre,
    categoria: s.categoria,
    precio   : parseFloat(s.precio) || 0,
    stock    : null,
  };
}

// ══════════════════════════════════════════════════════════════════
// GET /api/v1/punto-venta/config
// ══════════════════════════════════════════════════════════════════
router.get('/config', async (req, res, next) => {
  try {
    let cliente;
    try { cliente = await clienteGenerico(req.db); }
    catch (e) { if (migracionFaltante(e)) return errorMigracion(res); throw e; }

    const [emp] = await req.db.query('SELECT * FROM empresa_config LIMIT 1');
    return res.json({
      success: true,
      data: {
        cliente_generico: { id: cliente.id, nombre: `${cliente.nombre} ${cliente.apellido}` },
        limite_sin_dni  : LIMITE_SIN_DNI,
        hoy             : hoyLima(req.tenant?.zona_horaria),
        empresa: {
          nombre        : emp?.nombre || req.tenant?.nombre_clinica || 'Clínica veterinaria',
          razon_social  : emp?.razon_social || null,
          ruc           : emp?.ruc || null,
          direccion     : emp?.direccion || null,
          distrito      : emp?.distrito || null,
          telefono      : emp?.telefono || null,
          logo_url      : emp?.logo_url || null,
          igv_porcentaje: parseFloat(emp?.igv_porcentaje) || 18,
          simbolo_moneda: emp?.simbolo_moneda || 'S/.',
          pie_documento : emp?.pie_documento || null,
          sunat_activo  : !!emp?.sunat_activo,
        },
      },
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/v1/punto-venta/buscar?q=
//   - Si q coincide EXACTO con un código de barras → { exacto: producto }
//   - Si no → productos y servicios por nombre
// ══════════════════════════════════════════════════════════════════
router.get('/buscar', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (!q) return res.json({ success: true, data: { exacto: null, resultados: [] } });

    const sedeId   = getSedeFiltro(req);
    const sedeSql  = sedeId ? ' AND (sede_id = ? OR sede_id IS NULL)' : '';
    const sedePar  = sedeId ? [sedeId] : [];

    // 1) Código de barras exacto
    let exacto = null;
    try {
      const [p] = await req.db.query(
        `SELECT * FROM inventario WHERE codigo_barras = ? ${sedeSql} ORDER BY cantidad DESC LIMIT 1`,
        [q, ...sedePar]
      );
      if (p) exacto = mapProducto(p);
    } catch (e) { if (migracionFaltante(e)) return errorMigracion(res); throw e; }

    if (exacto) return res.json({ success: true, data: { exacto, resultados: [exacto] } });

    // 2) Por nombre
    const like = `%${q}%`;
    const productos = await req.db.query(
      `SELECT * FROM inventario
       WHERE (nombre LIKE ? OR codigo_barras LIKE ?) ${sedeSql}
       ORDER BY (nombre LIKE ?) DESC, cantidad > 0 DESC, nombre
       LIMIT 15`,
      [like, `${q}%`, ...sedePar, `${q}%`]
    );
    const servicios = await req.db.query(
      `SELECT id, nombre, categoria, precio FROM servicios_catalogo
       WHERE activo = 1 AND nombre LIKE ?
       ORDER BY (nombre LIKE ?) DESC, nombre
       LIMIT 10`,
      [like, `${q}%`]
    );

    return res.json({
      success: true,
      data: { exacto: null, resultados: [...productos.map(mapProducto), ...servicios.map(mapServicio)] },
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/v1/punto-venta/favoritos
// ══════════════════════════════════════════════════════════════════
router.get('/favoritos', async (req, res, next) => {
  try {
    const sedeId  = getSedeFiltro(req);
    const sedeSql = sedeId ? ' AND (sede_id = ? OR sede_id IS NULL)' : '';
    let rows;
    try {
      rows = await req.db.query(
        `SELECT * FROM inventario WHERE favorito = 1 ${sedeSql} ORDER BY nombre LIMIT 24`,
        sedeId ? [sedeId] : []
      );
    } catch (e) { if (migracionFaltante(e)) return errorMigracion(res); throw e; }
    return res.json({ success: true, data: rows.map(mapProducto) });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/v1/punto-venta/ventas-hoy — últimas 20 ventas de mostrador
// ══════════════════════════════════════════════════════════════════
router.get('/ventas-hoy', async (req, res, next) => {
  try {
    const sedeId = getSedeFiltro(req);
    let rows;
    try {
      rows = await req.db.query(
        `SELECT f.id, f.numero, f.tipo, f.total, f.estado, f.metodo_pago,
                UNIX_TIMESTAMP(f.created_at) AS ts,   -- epoch: la hora se formatea en Lima en el navegador
                CONCAT(p.nombre,' ',p.apellido) AS cliente, u.nombre AS vendedor
         FROM facturas f
         JOIN propietarios p ON p.id = f.propietario_id
         LEFT JOIN usuarios u ON u.id = f.emitido_por_id
         WHERE f.origen = 'punto_venta' AND f.fecha = ? ${sedeId ? 'AND f.sede_id = ?' : ''}
         ORDER BY f.id DESC LIMIT 20`,
        [hoyLima(req.tenant?.zona_horaria), ...(sedeId ? [sedeId] : [])]
      );
    } catch (e) { if (migracionFaltante(e)) return errorMigracion(res); throw e; }

    const total = rows.filter(r => r.estado !== 'anulado').reduce((a, r) => a + parseFloat(r.total), 0);
    return res.json({ success: true, data: rows, meta: { total_vendido: parseFloat(total.toFixed(2)) } });
  } catch (err) { next(err); }
});

module.exports = router;