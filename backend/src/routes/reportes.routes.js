'use strict';

/**
 * VetNetcodip SaaS — Reportes con soporte multi-sedes
 * Parámetro opcional: ?sede_id=N  → filtra esa sede
 * Sin sede_id (o sede_id=all)     → datos de todas las sedes
 * Solo accesible para rol 'admin' (salvo /sedes y /dashboard-stats)
 *
 * Fechas: ?desde / ?hasta (YYYY-MM-DD) en la zona horaria de la clínica.
 * citas.fecha_hora se guarda en UTC → se filtra con límites UTC (usa índice).
 */

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);

// ── Helpers de período ───────────────────────────────────────────
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS = 731;   // 2 años

function hoyTenant(req) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: req.tenant?.zona_horaria || 'America/Lima',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function sumarDias(fecha, n) {
  const t = new Date(`${fecha}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
}

/** Período pedido, validado. h1 = día siguiente a `hasta` (límite exclusivo). */
function periodo(req) {
  const hoy = hoyTenant(req);
  let d = FECHA_RE.test(req.query.desde || '') ? req.query.desde : hoy;
  let h = FECHA_RE.test(req.query.hasta || '') ? req.query.hasta : d;
  if (d > h) [d, h] = [h, d];
  if (diasEntre(d, h) > MAX_DIAS) {
    throw Object.assign(new Error('El rango máximo de un reporte es de 2 años.'), { status: 422 });
  }
  return { d, h, h1: sumarDias(h, 1), tz: req.tzOffset || '-05:00', hoy };
}

/**
 * Período con el que comparar. Si empieza un día 1 ("este mes", "este año"…) se compara
 * contra los mismos días del mes anterior (1–3 nov vs 1–3 oct); si no, contra el período
 * de igual duración inmediatamente anterior.
 */
function periodoAnterior(d, h) {
  if (d.endsWith('-01')) {
    let meses = (Number(h.slice(0, 4)) - Number(d.slice(0, 4))) * 12 + (Number(h.slice(5, 7)) - Number(d.slice(5, 7))) + 1;
    if (d.endsWith('-01-01') && meses > 1) meses = 12;   // "este año" → mismo tramo del año anterior
    const mover = (f, m) => {
      const [y, mo, dd] = f.split('-').map(Number);
      const ultimo = new Date(Date.UTC(y, mo - 1 - m + 1, 0)).getUTCDate();
      return new Date(Date.UTC(y, mo - 1 - m, Math.min(dd, ultimo))).toISOString().slice(0, 10);
    };
    return { d: mover(d, meses), h: mover(h, meses) };
  }
  const n = diasEntre(d, h) + 1;
  return { d: sumarDias(d, -n), h: sumarDias(d, -1) };
}

/** Límites UTC ['YYYY-MM-DD HH:MM:SS'] de [d 00:00, h1 00:00) en la zona de la clínica. */
function limitesUtc(d, h1, tz) {
  const f = x => x.toISOString().slice(0, 19).replace('T', ' ');
  return [f(new Date(`${d}T00:00:00${tz}`)), f(new Date(`${h1}T00:00:00${tz}`))];
}

function sedeId(v) {
  const n = v && v !== 'all' ? parseInt(v, 10) : null;
  return n && !isNaN(n) ? n : null;
}
// Filtro de sede con alias: sedeFilter(id, 'f.sede_id') → { sql: 'AND f.sede_id = ?', params: [id] }
function sedeFilter(sid, col = 'sede_id') {
  return sid ? { sql: `AND ${col} = ?`, params: [sid] } : { sql: '', params: [] };
}
// Citas sin sede propia se atribuyen a la sede del veterinario (requiere JOIN usuarios u)
const SEDE_CITA = 'COALESCE(c.sede_id, u.sede_id)';

const num = v => parseFloat(v) || 0;
const variacion = (act, ant) => (ant > 0 ? +(((act - ant) / ant) * 100).toFixed(1) : (act > 0 ? null : 0));

// Vacuna "pendiente": no existe una aplicación posterior de la misma vacuna para esa mascota
const VACUNA_PENDIENTE = `NOT EXISTS (
  SELECT 1 FROM vacunas v2
  WHERE v2.mascota_id = v.mascota_id AND v2.nombre = v.nombre AND v2.fecha_aplicacion > v.fecha_aplicacion)`;

// ── GET /api/v1/reportes/sedes — listado de sedes para el selector ─
router.get('/sedes', async (req, res, next) => {
  try {
    const sedes = await req.db.query(
      'SELECT id, nombre, ciudad FROM sedes WHERE activo = 1 ORDER BY es_principal DESC, nombre ASC'
    );
    return res.json({ success: true, data: sedes });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
//  RESUMEN EJECUTIVO — KPIs del período vs. período anterior + alertas
// ════════════════════════════════════════════════════════════════
async function kpisPeriodo(db, d, h, tz, sid) {
  const h1 = sumarDias(h, 1);
  const [ini, fin] = limitesUtc(d, h1, tz);
  const sf = sedeFilter(sid, 'f.sede_id');
  const sc = sedeFilter(sid, SEDE_CITA);

  const [fac] = await db.query(
    `SELECT COALESCE(SUM(f.total),0) AS ingresos, COUNT(*) AS documentos,
            COUNT(DISTINCT CASE WHEN pr.es_generico = 0 THEN f.propietario_id END) AS clientes
     FROM facturas f JOIN propietarios pr ON pr.id = f.propietario_id
     WHERE f.estado = 'pagado' AND f.fecha BETWEEN ? AND ? ${sf.sql}`,
    [d, h, ...sf.params]
  );
  const [cit] = await db.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(c.estado='completada'),0) AS completadas,
            COALESCE(SUM(c.estado='cancelada'),0) AS canceladas
     FROM citas c JOIN usuarios u ON u.id = c.veterinario_id
     WHERE c.fecha_hora >= ? AND c.fecha_hora < ? ${sc.sql}`,
    [ini, fin, ...sc.params]
  );
  const [cli] = await db.query(
    'SELECT COUNT(*) AS n FROM propietarios WHERE es_generico = 0 AND created_at >= ? AND created_at < ?', [d, h1]
  );
  const [mas] = await db.query(
    'SELECT COUNT(*) AS n FROM mascotas WHERE created_at >= ? AND created_at < ?', [d, h1]
  );
  const [con] = await db.query(
    'SELECT COUNT(*) AS n FROM historia_clinica WHERE fecha >= ? AND fecha < ?', [d, h1]
  );

  const ingresos = num(fac.ingresos), documentos = +fac.documentos || 0, citas = +cit.total || 0;
  return {
    ingresos,
    documentos,
    ticket_promedio : documentos ? +(ingresos / documentos).toFixed(2) : 0,
    clientes_atendidos: +fac.clientes || 0,
    clientes_nuevos : +cli.n || 0,
    mascotas_nuevas : +mas.n || 0,
    consultas       : +con.n || 0,
    citas,
    citas_completadas: +cit.completadas || 0,
    tasa_cancelacion: citas ? +((cit.canceladas / citas) * 100).toFixed(1) : 0,
  };
}

router.get('/resumen', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h, tz, hoy } = periodo(req);
    const sid = sedeId(req.query.sede_id);
    const ant = periodoAnterior(d, h);

    const [actual, anterior] = await Promise.all([
      kpisPeriodo(req.db, d, h, tz, sid),
      kpisPeriodo(req.db, ant.d, ant.h, tz, sid),
    ]);
    const cambio = {};
    for (const k of Object.keys(actual)) cambio[k] = variacion(actual[k], anterior[k]);

    // Alertas accionables (estado actual, no dependen del período)
    const si = sedeFilter(sid, 'sede_id');
    const sf = sedeFilter(sid, 'f.sede_id');
    const [inv] = await req.db.query(
      `SELECT COALESCE(SUM(cantidad <= stock_minimo),0) AS stock_bajo,
              COALESCE(SUM(fecha_vencimiento BETWEEN ? AND ?),0) AS por_vencer_30
       FROM inventario WHERE 1=1 ${si.sql}`,
      [hoy, sumarDias(hoy, 30), ...si.params]
    );
    const [vac] = await req.db.query(
      `SELECT COALESCE(SUM(v.proxima_dosis BETWEEN ? AND ?),0) AS proximas_7,
              COALESCE(SUM(v.proxima_dosis BETWEEN ? AND ?),0) AS vencidas_30
       FROM vacunas v
       WHERE v.proxima_dosis BETWEEN ? AND ? AND ${VACUNA_PENDIENTE}`,
      [hoy, sumarDias(hoy, 7), sumarDias(hoy, -30), sumarDias(hoy, -1), sumarDias(hoy, -30), sumarDias(hoy, 7)]
    );
    const [cob] = await req.db.query(
      `SELECT COALESCE(SUM(f.total),0) AS total, COALESCE(SUM(CASE WHEN f.fecha < ? THEN f.total END),0) AS mas_30
       FROM facturas f WHERE f.estado = 'pendiente' ${sf.sql}`,
      [sumarDias(hoy, -30), ...sf.params]
    );

    // Ingresos por día del período (para la tendencia)
    const porDia = await req.db.query(
      `SELECT f.fecha AS dia, COALESCE(SUM(f.total),0) AS ingresos, COUNT(*) AS documentos
       FROM facturas f WHERE f.estado = 'pagado' AND f.fecha BETWEEN ? AND ? ${sf.sql}
       GROUP BY f.fecha ORDER BY f.fecha ASC`,
      [d, h, ...sf.params]
    );

    return res.json({ success: true, data: {
      actual, anterior, cambio, porDia,
      alertas: {
        stock_bajo        : +inv.stock_bajo || 0,
        inventario_por_vencer: +inv.por_vencer_30 || 0,
        vacunas_proximas_7: +vac.proximas_7 || 0,
        vacunas_vencidas_30: +vac.vencidas_30 || 0,
        por_cobrar        : num(cob.total),
        por_cobrar_30     : num(cob.mas_30),
      },
      periodo: { desde: d, hasta: h }, periodo_anterior: { desde: ant.d, hasta: ant.h },
      sede_id: sid,
    } });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
//  CLIENTES — nuevos vs. recurrentes, frecuencia, top e inactivos
// ════════════════════════════════════════════════════════════════
router.get('/clientes', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h, hoy } = periodo(req);
    const sid  = sedeId(req.query.sede_id);
    const sf   = sedeFilter(sid, 'f.sede_id');
    const dias = Math.min(Math.max(parseInt(req.query.dias_inactivo, 10) || 180, 60), 720);

    // Un cliente por fila con lo que gastó en el período y su primera compra histórica
    const porCliente = `
      SELECT f.propietario_id, SUM(f.total) AS gasto, COUNT(*) AS compras, MAX(f.fecha) AS ultima,
             (SELECT MIN(f2.fecha) FROM facturas f2
               WHERE f2.propietario_id = f.propietario_id AND f2.estado = 'pagado') AS primera
      FROM facturas f JOIN propietarios pr ON pr.id = f.propietario_id
      WHERE f.estado = 'pagado' AND f.fecha BETWEEN ? AND ? AND pr.es_generico = 0 ${sf.sql}
      GROUP BY f.propietario_id`;
    const pc = [d, h, ...sf.params];

    const [resumen] = await req.db.query(
      `SELECT COUNT(*) AS atendidos,
              COALESCE(SUM(primera >= ?),0) AS nuevos,
              COALESCE(SUM(gasto),0)   AS gasto,
              COALESCE(SUM(compras),0) AS compras,
              COALESCE(SUM(compras = 1),0)              AS f1,
              COALESCE(SUM(compras = 2),0)              AS f2,
              COALESCE(SUM(compras BETWEEN 3 AND 5),0)  AS f3_5,
              COALESCE(SUM(compras >= 6),0)             AS f6
       FROM (${porCliente}) x`,
      [d, ...pc]
    );
    const [sinCliente] = await req.db.query(
      `SELECT COALESCE(SUM(f.total),0) AS ingresos
       FROM facturas f JOIN propietarios pr ON pr.id = f.propietario_id
       WHERE f.estado = 'pagado' AND f.fecha BETWEEN ? AND ? AND pr.es_generico = 1 ${sf.sql}`,
      pc
    );

    const top = await req.db.query(
      `SELECT x.propietario_id, CONCAT(p.nombre,' ',p.apellido) AS cliente, p.telefono,
              x.gasto, x.compras, x.ultima, (x.primera >= ?) AS es_nuevo
       FROM (${porCliente}) x JOIN propietarios p ON p.id = x.propietario_id
       ORDER BY x.gasto DESC LIMIT 15`,
      [d, ...pc]
    );

    // Inactivos: vinieron alguna vez (compra o consulta) pero no en los últimos N días.
    // Se ordenan por lo que gastaron en total: los más valiosos primero.
    const inactivos = await req.db.query(
      `SELECT p.id, CONCAT(p.nombre,' ',p.apellido) AS cliente, p.telefono,
              GREATEST(COALESCE(fx.ult,'1970-01-01'), COALESCE(hx.ult,'1970-01-01')) AS ultima_visita,
              COALESCE(fx.gasto,0) AS gasto_total, COALESCE(fx.compras,0) AS compras,
              (SELECT GROUP_CONCAT(m.nombre ORDER BY m.nombre SEPARATOR ', ')
                 FROM mascotas m WHERE m.propietario_id = p.id) AS mascotas
       FROM propietarios p
       LEFT JOIN (SELECT propietario_id, MAX(fecha) AS ult, SUM(total) AS gasto, COUNT(*) AS compras
                  FROM facturas WHERE estado = 'pagado' GROUP BY propietario_id) fx ON fx.propietario_id = p.id
       LEFT JOIN (SELECT m.propietario_id, MAX(DATE(h.fecha)) AS ult
                  FROM historia_clinica h JOIN mascotas m ON m.id = h.mascota_id
                  GROUP BY m.propietario_id) hx ON hx.propietario_id = p.id
       WHERE p.es_generico = 0 AND (fx.ult IS NOT NULL OR hx.ult IS NOT NULL)
       HAVING ultima_visita < ? AND ultima_visita >= ?
       ORDER BY gasto_total DESC, ultima_visita DESC
       LIMIT 100`,
      [sumarDias(hoy, -dias), sumarDias(hoy, -730)]
    );

    const atendidos = +resumen.atendidos || 0, gasto = num(resumen.gasto), compras = +resumen.compras || 0;
    return res.json({ success: true, data: {
      resumen: {
        atendidos,
        nuevos      : +resumen.nuevos || 0,
        recurrentes : atendidos - (+resumen.nuevos || 0),
        gasto_promedio : atendidos ? +(gasto / atendidos).toFixed(2) : 0,
        ticket_promedio: compras ? +(gasto / compras).toFixed(2) : 0,
        ingresos_identificados: gasto,
        ingresos_sin_cliente  : num(sinCliente.ingresos),
      },
      frecuencia: [
        { rango: '1 compra',    clientes: +resumen.f1 || 0 },
        { rango: '2 compras',   clientes: +resumen.f2 || 0 },
        { rango: '3 a 5',       clientes: +resumen.f3_5 || 0 },
        { rango: '6 o más',     clientes: +resumen.f6 || 0 },
      ],
      top, inactivos, dias_inactivo: dias,
      periodo: { desde: d, hasta: h }, sede_id: sid,
    } });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
//  COBRANZAS — cuentas por cobrar con antigüedad (estado actual)
// ════════════════════════════════════════════════════════════════
router.get('/cobranzas', authorize('admin'), async (req, res, next) => {
  try {
    const { hoy } = periodo(req);
    const sid = sedeId(req.query.sede_id);
    const sf  = sedeFilter(sid, 'f.sede_id');

    const [r] = await req.db.query(
      `SELECT COUNT(*) AS documentos, COUNT(DISTINCT f.propietario_id) AS clientes,
              COALESCE(SUM(f.total),0) AS total,
              COALESCE(SUM(CASE WHEN DATEDIFF(?, f.fecha) <= 30 THEN f.total END),0) AS t0_30,
              COALESCE(SUM(CASE WHEN DATEDIFF(?, f.fecha) BETWEEN 31 AND 60 THEN f.total END),0) AS t31_60,
              COALESCE(SUM(CASE WHEN DATEDIFF(?, f.fecha) BETWEEN 61 AND 90 THEN f.total END),0) AS t61_90,
              COALESCE(SUM(CASE WHEN DATEDIFF(?, f.fecha) > 90 THEN f.total END),0) AS t90,
              COALESCE(SUM(DATEDIFF(?, f.fecha) <= 30),0) AS n0_30,
              COALESCE(SUM(DATEDIFF(?, f.fecha) BETWEEN 31 AND 60),0) AS n31_60,
              COALESCE(SUM(DATEDIFF(?, f.fecha) BETWEEN 61 AND 90),0) AS n61_90,
              COALESCE(SUM(DATEDIFF(?, f.fecha) > 90),0) AS n90
       FROM facturas f WHERE f.estado = 'pendiente' ${sf.sql}`,
      [hoy, hoy, hoy, hoy, hoy, hoy, hoy, hoy, ...sf.params]
    );

    const porCliente = await req.db.query(
      `SELECT f.propietario_id, CONCAT(p.nombre,' ',p.apellido) AS cliente, p.telefono,
              COUNT(*) AS documentos, SUM(f.total) AS total, MAX(DATEDIFF(?, f.fecha)) AS dias_max
       FROM facturas f JOIN propietarios p ON p.id = f.propietario_id
       WHERE f.estado = 'pendiente' ${sf.sql}
       GROUP BY f.propietario_id, p.nombre, p.apellido, p.telefono
       ORDER BY total DESC LIMIT 20`,
      [hoy, ...sf.params]
    );

    const detalle = await req.db.query(
      `SELECT f.numero, f.tipo, f.fecha, f.total, DATEDIFF(?, f.fecha) AS dias,
              CONCAT(p.nombre,' ',p.apellido) AS cliente, p.telefono
       FROM facturas f JOIN propietarios p ON p.id = f.propietario_id
       WHERE f.estado = 'pendiente' ${sf.sql}
       ORDER BY f.fecha ASC LIMIT 300`,
      [hoy, ...sf.params]
    );

    return res.json({ success: true, data: {
      resumen: { total: num(r.total), documentos: +r.documentos || 0, clientes: +r.clientes || 0 },
      tramos: [
        { tramo: '0 a 30 días',  monto: num(r.t0_30),  documentos: +r.n0_30 || 0 },
        { tramo: '31 a 60 días', monto: num(r.t31_60), documentos: +r.n31_60 || 0 },
        { tramo: '61 a 90 días', monto: num(r.t61_90), documentos: +r.n61_90 || 0 },
        { tramo: 'Más de 90',    monto: num(r.t90),    documentos: +r.n90 || 0 },
      ],
      porCliente, detalle, fecha_corte: hoy, sede_id: sid,
    } });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
//  DEMANDA — cuándo llegan las citas (día × hora), tipos y motivos
// ════════════════════════════════════════════════════════════════
router.get('/demanda', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h, h1, tz } = periodo(req);
    const sid = sedeId(req.query.sede_id);
    const sc  = sedeFilter(sid, SEDE_CITA);
    const [ini, fin] = limitesUtc(d, h1, tz);
    const base = `FROM citas c JOIN usuarios u ON u.id = c.veterinario_id
                  WHERE c.fecha_hora >= ? AND c.fecha_hora < ? ${sc.sql}`;
    const p = [ini, fin, ...sc.params];

    // DAYOFWEEK: 1=domingo … 7=sábado
    const mapa = await req.db.query(
      `SELECT DAYOFWEEK(CONVERT_TZ(c.fecha_hora,'+00:00',?)) AS dow,
              HOUR(CONVERT_TZ(c.fecha_hora,'+00:00',?))      AS hora,
              COUNT(*) AS total, SUM(c.estado='cancelada') AS canceladas
       ${base} GROUP BY dow, hora`,
      [tz, tz, ...p]
    );
    const porTipo = await req.db.query(
      `SELECT c.tipo_cita, COUNT(*) AS total, SUM(c.estado='completada') AS completadas,
              SUM(c.estado='cancelada') AS canceladas
       ${base} GROUP BY c.tipo_cita ORDER BY total DESC`, p
    );
    const motivos = await req.db.query(
      `SELECT LOWER(TRIM(c.motivo)) AS motivo, COUNT(*) AS total
       ${base} GROUP BY LOWER(TRIM(c.motivo)) ORDER BY total DESC LIMIT 10`, p
    );

    return res.json({ success: true, data: {
      mapa, porTipo, motivos, periodo: { desde: d, hasta: h }, sede_id: sid,
    } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/citas ────────────────────────────────────
router.get('/citas', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h, h1, tz } = periodo(req);
    const sid = sedeId(req.query.sede_id);
    const sc  = sedeFilter(sid, SEDE_CITA);
    const [ini, fin] = limitesUtc(d, h1, tz);
    const base = `FROM citas c JOIN usuarios u ON u.id = c.veterinario_id
                  WHERE c.fecha_hora >= ? AND c.fecha_hora < ? ${sc.sql}`;
    const p = [ini, fin, ...sc.params];

    const [resumen] = await req.db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(c.estado='completada')  AS completadas,
         SUM(c.estado='cancelada')   AS canceladas,
         SUM(c.estado='pendiente')   AS pendientes,
         SUM(c.estado='confirmada')  AS confirmadas,
         SUM(c.estado='en_curso')    AS en_curso
       ${base}`, p
    );

    const porVeterinario = await req.db.query(
      `SELECT u.nombre AS veterinario, COUNT(*) AS total,
              SUM(c.estado='completada') AS completadas
       ${base} GROUP BY u.id, u.nombre ORDER BY total DESC`, p
    );

    const porDia = await req.db.query(
      `SELECT DATE(CONVERT_TZ(c.fecha_hora,'+00:00',?)) AS dia, COUNT(*) AS total,
              SUM(c.estado='completada') AS completadas
       ${base} GROUP BY dia ORDER BY dia ASC`, [tz, ...p]
    );

    const porEstado = await req.db.query(
      `SELECT c.estado, COUNT(*) AS total ${base} GROUP BY c.estado ORDER BY total DESC`, p
    );

    // Sin filtro de sede: desglose por sede (antes fallaba: usaba una variable `tz` inexistente)
    let porSede = [];
    if (!sid) {
      porSede = await req.db.query(
        `SELECT s.nombre AS sede, s.id AS sede_id,
                COUNT(x.estado) AS total_citas,
                COALESCE(SUM(x.estado='completada'),0) AS completadas,
                COALESCE(SUM(x.estado IN ('pendiente','confirmada')),0) AS pendientes
         FROM sedes s
         LEFT JOIN (SELECT ${SEDE_CITA} AS sede_id, c.estado
                    FROM citas c JOIN usuarios u ON u.id = c.veterinario_id
                    WHERE c.fecha_hora >= ? AND c.fecha_hora < ?) x ON x.sede_id = s.id
         WHERE s.activo = 1
         GROUP BY s.id, s.nombre
         ORDER BY total_citas DESC`,
        [ini, fin]
      );
    }

    return res.json({ success:true, data:{ resumen, porVeterinario, porDia, porEstado, porSede, periodo:{desde:d, hasta:h}, sede_id: sid } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/financiero ──────────────────────────────
router.get('/financiero', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h } = periodo(req);
    const sid = sedeId(req.query.sede_id);
    const sf  = sedeFilter(sid, 'f.sede_id');

    const [resumen] = await req.db.query(
      `SELECT
         COUNT(*) AS total_documentos,
         SUM(f.estado='pagado')    AS pagados,
         SUM(f.estado='pendiente') AS pendientes,
         SUM(f.estado='anulado')   AS anulados,
         COALESCE(SUM(CASE WHEN f.estado='pagado'    THEN f.total END),0) AS ingresos,
         COALESCE(SUM(CASE WHEN f.estado='pendiente' THEN f.total END),0) AS por_cobrar,
         COALESCE(SUM(CASE WHEN f.estado='pagado'    THEN f.igv   END),0) AS total_igv,
         COALESCE(SUM(CASE WHEN f.estado='pagado' AND f.tipo='boleta'  THEN f.total END),0) AS boletas,
         COALESCE(SUM(CASE WHEN f.estado='pagado' AND f.tipo='factura' THEN f.total END),0) AS facturas
       FROM facturas f WHERE f.fecha BETWEEN ? AND ? ${sf.sql}`,
      [d, h, ...sf.params]
    );

    const porDia = await req.db.query(
      `SELECT f.fecha AS dia,
              SUM(CASE WHEN f.estado='pagado' THEN f.total ELSE 0 END) AS ingresos,
              COUNT(*) AS documentos
       FROM facturas f WHERE f.fecha BETWEEN ? AND ? ${sf.sql}
       GROUP BY f.fecha ORDER BY f.fecha ASC`,
      [d, h, ...sf.params]
    );

    const porMetodo = await req.db.query(
      `SELECT fp.metodo_pago, SUM(fp.monto) AS monto, COUNT(*) AS transacciones
       FROM factura_pagos fp
       JOIN facturas f ON f.id = fp.factura_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado='pagado' ${sf.sql}
       GROUP BY fp.metodo_pago ORDER BY monto DESC`,
      [d, h, ...sf.params]
    );

    const topServicios = await req.db.query(
      `SELECT fi.descripcion, SUM(fi.cantidad) AS cantidad,
              SUM(fi.subtotal) AS monto_total
       FROM factura_items fi
       JOIN facturas f ON f.id = fi.factura_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado='pagado' ${sf.sql}
       GROUP BY fi.descripcion ORDER BY monto_total DESC LIMIT 10`,
      [d, h, ...sf.params]
    );

    const pendientes = await req.db.query(
      `SELECT f.numero, f.fecha, f.total, f.tipo,
              CONCAT(p.nombre,' ',p.apellido) AS cliente
       FROM facturas f
       JOIN propietarios p ON p.id = f.propietario_id
       WHERE f.fecha BETWEEN ? AND ? AND f.estado='pendiente' ${sf.sql}
       ORDER BY f.fecha ASC LIMIT 200`,
      [d, h, ...sf.params]
    );

    let porSede = [];
    if (!sid) {
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

    return res.json({ success:true, data:{ resumen, porDia, porMetodo, topServicios, pendientes, porSede, periodo:{desde:d,hasta:h}, sede_id: sid } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/gastos ───────────────────────────────────
// En qué se gasta: por tipo, método de pago, día/mes, sede y conceptos; ingresos vs gastos.
router.get('/gastos', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h } = periodo(req);
    const ant = periodoAnterior(d, h);
    const sid = sedeId(req.query.sede_id);
    const sg  = sedeFilter(sid, 'g.sede_id');
    const sf  = sedeFilter(sid, 'f.sede_id');
    const base = `FROM gastos g WHERE g.anulado = 0 AND g.fecha BETWEEN ? AND ? ${sg.sql}`;
    const p    = [d, h, ...sg.params];

    const [[resumen], [anterior], [ingresos], [anulados]] = await Promise.all([
      req.db.query(`SELECT COALESCE(SUM(g.monto),0) AS total, COUNT(*) AS cantidad,
                           COALESCE(MAX(g.monto),0) AS mayor ${base}`, p),
      req.db.query(`SELECT COALESCE(SUM(g.monto),0) AS total
                    FROM gastos g WHERE g.anulado = 0 AND g.fecha BETWEEN ? AND ? ${sg.sql}`,
                   [ant.d, ant.h, ...sg.params]),
      req.db.query(`SELECT COALESCE(SUM(f.total),0) AS total FROM facturas f
                    WHERE f.estado = 'pagado' AND f.fecha BETWEEN ? AND ? ${sf.sql}`, [d, h, ...sf.params]),
      req.db.query(`SELECT COUNT(*) AS cantidad, COALESCE(SUM(g.monto),0) AS total
                    FROM gastos g WHERE g.anulado = 1 AND g.fecha BETWEEN ? AND ? ${sg.sql}`, p),
    ]);

    const agruparMes = diasEntre(d, h) > 62;
    const fmtPeriodo = agruparMes ? '%Y-%m' : '%Y-%m-%d';

    const [porCategoria, porMetodo, porPeriodo, topConceptos, detalle] = await Promise.all([
      req.db.query(
        `SELECT gc.id, gc.nombre, gc.icono, gc.color, SUM(g.monto) AS total, COUNT(*) AS cantidad
         FROM gastos g JOIN gastos_categorias gc ON gc.id = g.categoria_id
         WHERE g.anulado = 0 AND g.fecha BETWEEN ? AND ? ${sg.sql}
         GROUP BY gc.id, gc.nombre, gc.icono, gc.color ORDER BY total DESC`, p),
      req.db.query(
        `SELECT g.metodo_pago, SUM(g.monto) AS total, COUNT(*) AS cantidad ${base}
         GROUP BY g.metodo_pago ORDER BY total DESC`, p),
      req.db.query(
        `SELECT DATE_FORMAT(g.fecha, '${fmtPeriodo}') AS periodo, SUM(g.monto) AS total, COUNT(*) AS cantidad ${base}
         GROUP BY periodo ORDER BY periodo ASC`, p),
      req.db.query(
        `SELECT g.descripcion, gc.nombre AS categoria, SUM(g.monto) AS total, COUNT(*) AS veces
         FROM gastos g JOIN gastos_categorias gc ON gc.id = g.categoria_id
         WHERE g.anulado = 0 AND g.fecha BETWEEN ? AND ? ${sg.sql}
         GROUP BY g.descripcion, gc.nombre ORDER BY total DESC LIMIT 10`, p),
      req.db.query(
        `SELECT g.id, DATE_FORMAT(g.fecha, '%Y-%m-%d') AS fecha, g.descripcion, g.monto, g.metodo_pago,
                g.proveedor, g.comprobante, gc.nombre AS categoria, gc.icono AS categoria_icono,
                u.nombre AS registrado_por, s.nombre AS sede
         FROM gastos g
         JOIN gastos_categorias gc ON gc.id = g.categoria_id
         JOIN usuarios u ON u.id = g.registrado_por_id
         LEFT JOIN sedes s ON s.id = g.sede_id
         WHERE g.anulado = 0 AND g.fecha BETWEEN ? AND ? ${sg.sql}
         ORDER BY g.fecha DESC, g.created_at DESC LIMIT 500`, p),
    ]);

    let gastosPorSede = [];
    if (!sid) {
      gastosPorSede = await req.db.query(
        `SELECT COALESCE(s.nombre, 'Sin sede') AS sede, SUM(g.monto) AS total, COUNT(*) AS cantidad
         FROM gastos g LEFT JOIN sedes s ON s.id = g.sede_id
         WHERE g.anulado = 0 AND g.fecha BETWEEN ? AND ?
         GROUP BY s.id, s.nombre ORDER BY total DESC`, [d, h]);
    }

    const total   = num(resumen.total);
    const ingreso = num(ingresos.total);
    const dias    = diasEntre(d, h) + 1;
    const conPct  = rows => rows.map(r => ({ ...r, total: num(r.total), pct: total ? +((num(r.total) / total) * 100).toFixed(1) : 0 }));

    return res.json({ success: true, data: {
      resumen: {
        total, cantidad: +resumen.cantidad || 0, mayor: num(resumen.mayor),
        promedio_diario: +(total / dias).toFixed(2),
        anterior: num(anterior.total), variacion: variacion(total, num(anterior.total)),
        ingresos: ingreso, utilidad: +(ingreso - total).toFixed(2),
        margen: ingreso > 0 ? +(((ingreso - total) / ingreso) * 100).toFixed(1) : null,
        anulados: +anulados.cantidad || 0, anulados_monto: num(anulados.total),
      },
      porCategoria: conPct(porCategoria), porMetodo: conPct(porMetodo),
      porPeriodo: porPeriodo.map(r => ({ ...r, total: num(r.total) })), agrupacion: agruparMes ? 'mes' : 'dia',
      topConceptos: topConceptos.map(r => ({ ...r, total: num(r.total) })),
      detalle, gastosPorSede,
      periodo: { desde: d, hasta: h }, periodo_anterior: ant, sede_id: sid,
    } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/mascotas ─────────────────────────────────
// Mascotas no tiene sede_id — este reporte siempre es global
router.get('/mascotas', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h, h1 } = periodo(req);

    const [resumen] = await req.db.query(
      `SELECT COUNT(*) AS total,
              SUM(especie='perro') AS perros,
              SUM(especie='gato')  AS gatos,
              SUM(especie='ave')   AS aves,
              SUM(especie='reptil')AS reptiles,
              SUM(especie NOT IN ('perro','gato','ave','reptil')) AS otros,
              SUM(created_at >= ? AND created_at < ?) AS nuevas_periodo
       FROM mascotas`, [d, h1]
    );
    const [atendidas] = await req.db.query(
      'SELECT COUNT(DISTINCT mascota_id) AS n FROM historia_clinica WHERE fecha >= ? AND fecha < ?', [d, h1]
    );
    resumen.atendidas_periodo = +atendidas.n || 0;

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
       FROM historia_clinica h
       JOIN mascotas m ON m.id = h.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE h.fecha >= ? AND h.fecha < ?
       GROUP BY m.id, m.nombre, m.especie, m.raza, p.nombre, p.apellido
       ORDER BY consultas DESC LIMIT 10`, [d, h1]
    );

    return res.json({ success:true, data:{ resumen, porEspecie, nuevasPorMes, masAtendidas, periodo:{desde:d,hasta:h} } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/vacunas ──────────────────────────────────
// Próximas y vencidas excluyen las que ya se volvieron a aplicar (antes salían como vencidas)
router.get('/vacunas', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h, hoy } = periodo(req);
    const en30 = sumarDias(hoy, 30);

    const [aplicadas] = await req.db.query(
      'SELECT COUNT(*) AS total_aplicadas FROM vacunas WHERE fecha_aplicacion BETWEEN ? AND ?', [d, h]
    );
    const [pend] = await req.db.query(
      `SELECT COALESCE(SUM(v.proxima_dosis < ?),0) AS vencidas,
              COALESCE(SUM(v.proxima_dosis BETWEEN ? AND ?),0) AS proximas_30dias
       FROM vacunas v
       WHERE v.proxima_dosis IS NOT NULL AND v.proxima_dosis <= ?
         AND v.proxima_dosis >= DATE_SUB(?, INTERVAL 12 MONTH)
         AND ${VACUNA_PENDIENTE}`,
      [hoy, hoy, en30, en30, hoy]
    );
    const resumen = { total_aplicadas: +aplicadas.total_aplicadas || 0, vencidas: +pend.vencidas || 0, proximas_30dias: +pend.proximas_30dias || 0 };

    const porNombre = await req.db.query(
      `SELECT nombre, COUNT(*) AS total
       FROM vacunas WHERE fecha_aplicacion BETWEEN ? AND ?
       GROUP BY nombre ORDER BY total DESC LIMIT 10`, [d, h]
    );

    const listado = (cond, orden, params) => req.db.query(
      `SELECT v.nombre AS vacuna, v.proxima_dosis,
              m.nombre AS mascota, m.especie,
              CONCAT(p.nombre,' ',p.apellido) AS propietario, p.telefono
       FROM vacunas v
       JOIN mascotas m ON m.id = v.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE ${cond} AND ${VACUNA_PENDIENTE}
       ORDER BY v.proxima_dosis ${orden} LIMIT 100`, params
    );
    const proximasVencer = await listado('v.proxima_dosis BETWEEN ? AND ?', 'ASC', [hoy, en30]);
    const vencidas = await listado('v.proxima_dosis < ? AND v.proxima_dosis >= DATE_SUB(?, INTERVAL 12 MONTH)', 'DESC', [hoy, hoy]);

    return res.json({ success:true, data:{ resumen, porNombre, proximasVencer, vencidas, periodo:{desde:d,hasta:h} } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/inventario ──────────────────────────────
router.get('/inventario', authorize('admin'), async (req, res, next) => {
  try {
    const { hoy } = periodo(req);
    const sid = sedeId(req.query.sede_id);
    const sf  = sedeFilter(sid, 'i.sede_id');
    const en30 = sumarDias(hoy, 30);

    const [resumen] = await req.db.query(
      `SELECT COUNT(*) AS total_items,
              SUM(i.cantidad <= i.stock_minimo) AS stock_bajo,
              SUM(i.fecha_vencimiento < ?) AS vencidos,
              SUM(i.fecha_vencimiento BETWEEN ? AND ?) AS por_vencer
       FROM inventario i WHERE 1=1 ${sf.sql}`,
      [hoy, hoy, en30, ...sf.params]
    );

    const stockBajo = await req.db.query(
      `SELECT i.nombre, i.categoria, i.cantidad, i.stock_minimo, i.unidad, i.proveedor,
              s.nombre AS sede
       FROM inventario i LEFT JOIN sedes s ON s.id = i.sede_id
       WHERE i.cantidad <= i.stock_minimo ${sf.sql}
       ORDER BY (i.cantidad / NULLIF(i.stock_minimo,0)) ASC`,
      [...sf.params]
    );

    const porVencer = await req.db.query(
      `SELECT i.nombre, i.categoria, i.cantidad, i.unidad, i.fecha_vencimiento, i.proveedor,
              s.nombre AS sede
       FROM inventario i LEFT JOIN sedes s ON s.id = i.sede_id
       WHERE i.fecha_vencimiento BETWEEN ? AND ? ${sf.sql}
       ORDER BY i.fecha_vencimiento ASC`,
      [hoy, en30, ...sf.params]
    );

    const porCategoria = await req.db.query(
      `SELECT i.categoria, COUNT(*) AS items, SUM(i.cantidad) AS total_unidades
       FROM inventario i WHERE 1=1 ${sf.sql}
       GROUP BY i.categoria ORDER BY items DESC`,
      [...sf.params]
    );

    return res.json({ success:true, data:{ resumen, stockBajo, porVencer, porCategoria, sede_id: sid } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/estetica ────────────────────────────────
router.get('/estetica', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h } = periodo(req);
    const sf = sedeFilter(sedeId(req.query.sede_id), 'sede_id');
    const p  = [d, h, ...sf.params];

    const [resumen] = await req.db.query(
      `SELECT COUNT(*) AS total,
              SUM(tipo_bano='basico')    AS basicos,
              SUM(tipo_bano='completo')  AS completos,
              SUM(tipo_bano='medicado')  AS medicados,
              SUM(incluye_corte=1)       AS con_corte,
              COALESCE(SUM(precio),0)    AS ingresos
       FROM servicios_estetica WHERE fecha BETWEEN ? AND ? ${sf.sql}`, p
    );

    const porDia = await req.db.query(
      `SELECT fecha AS dia, COUNT(*) AS total, COALESCE(SUM(precio),0) AS ingresos
       FROM servicios_estetica WHERE fecha BETWEEN ? AND ? ${sf.sql}
       GROUP BY fecha ORDER BY fecha ASC`, p
    );

    const porTipo = await req.db.query(
      `SELECT tipo_bano, COUNT(*) AS total, COALESCE(SUM(precio),0) AS ingresos
       FROM servicios_estetica WHERE fecha BETWEEN ? AND ? ${sf.sql}
       GROUP BY tipo_bano ORDER BY total DESC`, p
    );

    return res.json({ success:true, data:{ resumen, porDia, porTipo, periodo:{desde:d,hasta:h} } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/veterinarios ────────────────────────────
// Cada métrica se agrega por separado: antes los JOIN múltiples multiplicaban filas
// e inflaban completadas/canceladas.
router.get('/veterinarios', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h, h1, tz } = periodo(req);
    const sf = sedeFilter(sedeId(req.query.sede_id), 'u.sede_id');
    const [ini, fin] = limitesUtc(d, h1, tz);

    const veterinarios = await req.db.query(
      `SELECT u.id, u.nombre, s.nombre AS sede,
              COALESCE(c.total,0)       AS citas_total,
              COALESCE(c.completadas,0) AS citas_completadas,
              COALESCE(c.canceladas,0)  AS citas_canceladas,
              COALESCE(hc.n,0)          AS consultas,
              COALESCE(v.n,0)           AS vacunas,
              COALESCE(ing.monto,0)     AS ingresos
       FROM usuarios u
       LEFT JOIN sedes s ON s.id = u.sede_id
       LEFT JOIN (SELECT veterinario_id, COUNT(*) AS total,
                         SUM(estado='completada') AS completadas, SUM(estado='cancelada') AS canceladas
                  FROM citas WHERE fecha_hora >= ? AND fecha_hora < ?
                  GROUP BY veterinario_id) c ON c.veterinario_id = u.id
       LEFT JOIN (SELECT veterinario_id, COUNT(*) AS n FROM historia_clinica
                  WHERE fecha >= ? AND fecha < ? GROUP BY veterinario_id) hc ON hc.veterinario_id = u.id
       LEFT JOIN (SELECT veterinario_id, COUNT(*) AS n FROM vacunas
                  WHERE fecha_aplicacion BETWEEN ? AND ? GROUP BY veterinario_id) v ON v.veterinario_id = u.id
       LEFT JOIN (SELECT ci.veterinario_id, SUM(f.total) AS monto
                  FROM facturas f JOIN citas ci ON ci.id = f.cita_id
                  WHERE f.estado = 'pagado' AND f.fecha BETWEEN ? AND ?
                  GROUP BY ci.veterinario_id) ing ON ing.veterinario_id = u.id
       WHERE u.rol = 'veterinario' AND u.activo = 1 ${sf.sql}
       ORDER BY citas_total DESC`,
      [ini, fin, d, h1, d, h, d, h, ...sf.params]
    );

    return res.json({ success:true, data:{ veterinarios, periodo:{desde:d,hasta:h}, sede_id: sedeId(req.query.sede_id) } });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/dashboard-stats ─────────────────────────
// Endpoint especial para el dashboard: admin ve por sede o todo,
// otros roles ven solo su sede automáticamente
router.get('/dashboard-stats', async (req, res, next) => {
  try {
    const tz   = req.tzOffset || '-05:00';
    const hoy  = hoyTenant(req);
    const user = req.user;

    // Admin sin sede_id en query → todas las sedes; con sede_id → filtra
    // Otros roles → siempre su sede del JWT (req.user.sede_id)
    const sid = user.rol === 'admin' ? sedeId(req.query.sede_id) : (req.user.sede_id || null);
    const sf  = sedeFilter(sid, 'sede_id');
    const sc  = sedeFilter(sid, SEDE_CITA);
    const [ini, fin] = limitesUtc(hoy, sumarDias(hoy, 1), tz);

    const [citas] = await req.db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(c.estado IN ('pendiente','confirmada')) AS pendientes,
         SUM(c.estado='completada') AS completadas
       FROM citas c
       JOIN usuarios u ON u.id = c.veterinario_id
       WHERE c.fecha_hora >= ? AND c.fecha_hora < ? ${sc.sql}`,
      [ini, fin, ...sc.params]
    );

    const [stock] = await req.db.query(
      `SELECT COUNT(*) AS bajo_stock FROM inventario
       WHERE cantidad <= stock_minimo ${sf.sql}`,
      [...sf.params]
    );

    // Desglose por sedes (solo admin sin filtro de sede)
    let sedes = [];
    if (user.rol === 'admin' && !sid) {
      sedes = await req.db.query(
        `SELECT s.id, s.nombre AS sede,
                COUNT(x.estado) AS citas_hoy,
                COALESCE(SUM(x.estado IN ('pendiente','confirmada')),0) AS pendientes,
                COALESCE(SUM(x.estado='completada'),0) AS completadas
         FROM sedes s
         LEFT JOIN (SELECT ${SEDE_CITA} AS sede_id, c.estado
                    FROM citas c JOIN usuarios u ON u.id = c.veterinario_id
                    WHERE c.fecha_hora >= ? AND c.fecha_hora < ?) x ON x.sede_id = s.id
         WHERE s.activo = 1
         GROUP BY s.id, s.nombre
         ORDER BY s.es_principal DESC, s.nombre ASC`,
        [ini, fin]
      );
    }

    return res.json({
      success: true,
      data: {
        citas_hoy   : citas.total       || 0,
        pendientes  : citas.pendientes  || 0,
        completadas : citas.completadas || 0,
        stock_bajo  : stock.bajo_stock  || 0,
        sedes,
        sede_id     : sid,
      },
    });
  } catch (err) { next(err); }
});


// ── GET /api/v1/reportes/atenciones-por-sede ─────────────────────
router.get('/atenciones-por-sede', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h1 } = periodo(req);

    const porSede = await req.db.query(
      `SELECT
         s.nombre AS sede,
         s.id     AS sede_id,
         COUNT(hc.id) AS total_atenciones
       FROM sedes s
       LEFT JOIN historia_clinica hc ON hc.sede_id = s.id
         AND hc.fecha >= ? AND hc.fecha < ?
       WHERE s.activo = 1
       GROUP BY s.id, s.nombre
       ORDER BY total_atenciones DESC`,
      [d, h1]
    );

    return res.json({ success: true, data: porSede });
  } catch (err) { next(err); }
});

// ── GET /api/v1/reportes/rentabilidad ────────────────────────────
// El margen se calcula solo sobre ítems con costo conocido (productos con precio de compra).
// Antes los servicios (sin costo) contaban con 100% de margen e inflaban el total.
router.get('/rentabilidad', authorize('admin'), async (req, res, next) => {
  try {
    const { d, h } = periodo(req);
    const filtro = ['productos', 'servicios'].includes(req.query.filtro) ? req.query.filtro : 'todos';
    const sid = sedeId(req.query.sede_id);

    let sf = 'WHERE f.fecha BETWEEN ? AND ? AND f.estado = \'pagado\'';
    const p = [d, h];
    if (sid) { sf += ' AND f.sede_id = ?'; p.push(sid); }

    let filtroItems = '';
    if (filtro === 'productos') {
      filtroItems = 'AND fi.inventario_id IS NOT NULL AND fi.precio_compra_snapshot > 0';
    } else if (filtro === 'servicios') {
      filtroItems = 'AND fi.inventario_id IS NULL';
    }

    const CON_COSTO = 'fi.inventario_id IS NOT NULL AND fi.precio_compra_snapshot > 0';
    const COSTO     = `CASE WHEN ${CON_COSTO} THEN fi.precio_compra_snapshot * fi.cantidad ELSE 0 END`;

    const [kpis] = await req.db.query(
      `SELECT
         COALESCE(SUM(fi.subtotal), 0) AS ingreso_total,
         COALESCE(SUM(${COSTO}), 0) AS costo_total,
         COALESCE(SUM(CASE WHEN ${CON_COSTO} THEN fi.subtotal ELSE 0 END), 0) AS ingreso_con_costo,
         COALESCE(SUM(fi.subtotal), 0) - COALESCE(SUM(${COSTO}), 0) AS ganancia_neta,
         COUNT(CASE WHEN ${CON_COSTO} THEN 1 END) AS items_con_costo,
         COUNT(fi.id) AS items_total
       FROM facturas f
       JOIN factura_items fi ON fi.factura_id = f.id
       ${sf} ${filtroItems}`,
      p
    );

    const ingreso     = num(kpis.ingreso_total);
    const ingresoCC   = num(kpis.ingreso_con_costo);
    const costo       = num(kpis.costo_total);
    kpis.margen_pct   = ingresoCC > 0 ? +(((ingresoCC - costo) / ingresoCC) * 100).toFixed(2) : 0;
    kpis.ganancia_productos = +(ingresoCC - costo).toFixed(2);
    kpis.cobertura_costo_pct = ingreso > 0 ? +((ingresoCC / ingreso) * 100).toFixed(1) : 0;

    const porDia = await req.db.query(
      `SELECT
         f.fecha AS dia,
         COALESCE(SUM(fi.subtotal), 0) AS ingreso,
         COALESCE(SUM(${COSTO}), 0) AS costo,
         COALESCE(SUM(fi.subtotal), 0) - COALESCE(SUM(${COSTO}), 0) AS ganancia
       FROM facturas f
       JOIN factura_items fi ON fi.factura_id = f.id
       ${sf} ${filtroItems}
       GROUP BY f.fecha ORDER BY f.fecha ASC`,
      p
    );

    let topProductos = [];
    if (filtro !== 'servicios') {
      topProductos = await req.db.query(
        `SELECT
           fi.descripcion,
           SUM(fi.cantidad) AS cantidad_total,
           SUM(fi.subtotal) AS ingreso_total,
           SUM(fi.precio_compra_snapshot * fi.cantidad) AS costo_total,
           SUM(fi.subtotal) - SUM(fi.precio_compra_snapshot * fi.cantidad) AS ganancia,
           CASE WHEN SUM(fi.subtotal) > 0
                THEN ROUND((SUM(fi.subtotal) - SUM(fi.precio_compra_snapshot * fi.cantidad)) / SUM(fi.subtotal) * 100, 2)
                ELSE 0 END AS margen_pct
         FROM facturas f
         JOIN factura_items fi ON fi.factura_id = f.id
         ${sf} AND ${CON_COSTO}
         GROUP BY fi.descripcion
         ORDER BY ganancia DESC
         LIMIT 10`,
        p
      );
    }

    let topServicios = [];
    if (filtro !== 'productos') {
      topServicios = await req.db.query(
        `SELECT
           fi.descripcion,
           SUM(fi.cantidad) AS cantidad_total,
           SUM(fi.subtotal) AS ingreso_total
         FROM facturas f
         JOIN factura_items fi ON fi.factura_id = f.id
         ${sf} AND fi.inventario_id IS NULL
         GROUP BY fi.descripcion
         ORDER BY ingreso_total DESC
         LIMIT 10`,
        p
      );
    }

    return res.json({
      success: true,
      data: { kpis, porDia, topProductos, topServicios, periodo: { desde: d, hasta: h }, filtro },
    });
  } catch (err) { next(err); }
});

module.exports = router;
