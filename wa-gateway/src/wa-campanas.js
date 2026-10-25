'use strict';

/**
 * VetNetcodip SaaS — Procesador de Campañas WA v4
 * Fixes:
 * - Loop recursivo con await: el siguiente ciclo solo arranca cuando el anterior terminó
 * - Reserva atómica con SELECT ... FOR UPDATE SKIP LOCKED dentro de transacción
 * - Sin cambios al schema — no se necesitan columnas ni estados nuevos
 * - Límite diario leído desde la tabla real, no desde objeto en memoria
 * v5 (WhatsApp Meta):
 * - Campañas con proveedor='meta' se envían con una plantilla aprobada por Meta
 *   (vía wa-meta, puerto interno 5003). Las de QR siguen igual.
 * - Segmentos: corregido "sin citas en 60 días" y agregado "citas de la semana".
 */

const mysql = require('mysql2/promise');
const http  = require('http');
const path  = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WA_GATEWAY   = process.env.WA_GATEWAY_URL  || 'http://localhost:5001';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY  || 'wa-internal-secret-2026';
const WA_META_INTERNO = process.env.WA_META_INTERNAL_URL || 'http://127.0.0.1:5003';
// Meta: límite diario por campaña (los números nuevos empiezan con 250 clientes/día) y pausa entre envíos
const META_LIMITE_DIA = parseInt(process.env.WA_META_CAMPANA_LIMITE_DIA || '250', 10);
const META_DELAY_MS   = parseInt(process.env.WA_META_CAMPANA_DELAY_MS   || '1000', 10);

const masterPool = mysql.createPool({
  host            : process.env.MASTER_DB_HOST,
  port            : process.env.MASTER_DB_PORT || 3306,
  user            : process.env.MASTER_DB_USER,
  password        : process.env.MASTER_DB_PASS,
  database        : process.env.MASTER_DB_NAME,
  connectionLimit : 3,
});

async function masterQuery(sql, params = []) {
  const [rows] = await masterPool.execute(sql, params);
  return rows;
}

async function getTenantConn(t) {
  return mysql.createConnection({
    host: t.db_host, port: t.db_port || 3306,
    user: t.db_user, password: t.db_pass, database: t.db_name,
  });
}

function callGateway(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const url     = new URL(WA_GATEWAY + path);
    const options = {
      hostname: url.hostname,
      port    : parseInt(url.port) || 5001,
      path    : url.pathname,
      method,
      headers : {
        'Content-Type'  : 'application/json',
        'x-internal-key': INTERNAL_KEY,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout gateway')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function callMeta(body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const url     = new URL(WA_META_INTERNO + '/interno/enviar-plantilla');
    const req = http.request({
      hostname: url.hostname, port: parseInt(url.port) || 5003, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY, 'Content-Length': Buffer.byteLength(bodyStr) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { let j = {}; try { j = JSON.parse(data); } catch {} resolve({ status: res.statusCode, ...j }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout wa-meta')); });
    req.write(bodyStr);
    req.end();
  });
}

async function emitirProgreso(tenantId, campanaId, datos) {
  try { await callGateway('POST', '/wa/campana/progreso', { tenantId, campanaId, ...datos }); } catch {}
}

async function emitirLog(tenantId, campanaId, entrada) {
  try { await callGateway('POST', '/wa/campana/log', { tenantId, campanaId, ...entrada }); } catch {}
}

function rellenarPlantilla(msg, vars) {
  return (msg || '')
    .replace(/\[nombre\]/gi,   vars.nombre   || '')
    .replace(/\[mascota\]/gi,  vars.mascota  || '')
    .replace(/\[clinica\]/gi,  vars.clinica  || '')
    .replace(/\[telefono\]/gi, vars.telefono || '');
}

async function getConfigCampana(conn) {
  // [[cfg]]: execute devuelve [filas, campos] (antes se tomaba la lista entera y nunca se leía la configuración)
  const [[cfg]] = await conn.execute(
    `SELECT campana_limite_dia, campana_delay_ms, campana_hora_inicio, campana_hora_fin
     FROM wa_config LIMIT 1`
  );
  return {
    limite_dia  : cfg?.campana_limite_dia  || 30,
    delay_ms    : cfg?.campana_delay_ms    || 4000,
    hora_inicio : cfg?.campana_hora_inicio || '08:00:00',
    hora_fin    : cfg?.campana_hora_fin    || '20:00:00',
  };
}

// Hora actual en la zona horaria de la clínica (no la del servidor)
function dentroDeHorario(horaInicio, horaFin, zona) {
  let horaActual;
  try {
    horaActual = new Date().toLocaleTimeString('en-GB', { timeZone: zona || 'America/Lima', hour12: false, hour: '2-digit', minute: '2-digit' }) + ':00';
  } catch {
    horaActual = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Lima', hour12: false, hour: '2-digit', minute: '2-digit' }) + ':00';
  }
  const ini = String(horaInicio).padStart(8, '0');
  const fin = String(horaFin).padStart(8, '0');
  return horaActual >= ini && horaActual <= fin;
}

// ── Límite diario leído desde la tabla real, no desde objeto cacheado ──────
async function verificarLimiteDiario(conn, campanaId, limiteDia) {
  const hoy = new Date().toISOString().split('T')[0];

  const [[{ enviados_hoy }]] = await conn.execute(
    `SELECT COUNT(*) AS enviados_hoy
     FROM wa_campana_contactos
     WHERE campana_id = ? AND estado = 'enviado' AND DATE(enviado_at) = ?`,
    [campanaId, hoy]
  );

  const disponible = limiteDia - (enviados_hoy || 0);
  return {
    disponible : Math.max(disponible, 0),
    agotado    : disponible <= 0,
    enviados_hoy,
  };
}

// Misma lógica que GET /api/v1/wa-meta/campanas/contar del backend (mantener iguales)
async function obtenerContactosCampana(conn, campana) {
  const nombre = `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)),''), p.razon_social)`;
  const base = (joins, where, params = []) => conn.execute(
    `SELECT p.id, ${nombre} AS nombre, p.telefono,
            GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
     FROM propietarios p ${joins}
     WHERE p.telefono IS NOT NULL AND TRIM(p.telefono) <> '' ${where}
     GROUP BY p.id`, params
  ).then(([r]) => r);

  switch (campana.segmento) {
    case 'todos':
      return base('LEFT JOIN mascotas m ON m.propietario_id = p.id', '');
    case 'por_especie':
      return base('JOIN mascotas m ON m.propietario_id = p.id', 'AND m.especie = ?', [campana.segmento_valor || '']);
    case 'vacunas_vencidas':
      return base('JOIN mascotas m ON m.propietario_id = p.id JOIN vacunas v ON v.mascota_id = m.id',
                  'AND v.proxima_dosis < CURDATE() AND v.notificado = 0');
    case 'citas_semana':
      return base('JOIN mascotas m ON m.propietario_id = p.id JOIN citas c ON c.mascota_id = m.id',
                  "AND c.fecha_hora BETWEEN NOW() AND NOW() + INTERVAL 7 DAY AND c.estado IN ('pendiente','confirmada')");
    case 'sin_citas_60d':
      return base('LEFT JOIN mascotas m ON m.propietario_id = p.id',
                  `AND NOT EXISTS (SELECT 1 FROM citas c2 JOIN mascotas m2 ON m2.id = c2.mascota_id
                                   WHERE m2.propietario_id = p.id AND c2.fecha_hora >= NOW() - INTERVAL 60 DAY)`);
    case 'personalizado':
      // propietarios_ids viene serializado en segmento_valor como JSON
      try {
        const ids = JSON.parse(campana.segmento_valor || '[]').map(Number).filter(Number.isInteger);
        if (!ids.length) return [];
        return base('LEFT JOIN mascotas m ON m.propietario_id = p.id', `AND p.id IN (${ids.map(() => '?').join(',')})`, ids);
      } catch { return []; }
    default:
      return [];
  }
}

async function procesarCampanas() {
  try {
    const tenants = await masterQuery(
      `SELECT t.id AS tenant_id, t.slug, t.db_host, t.db_port, t.db_user, t.db_pass, t.db_name,
              tc.nombre_clinica, tc.telefono AS tel_clinica, tc.zona_horaria
       FROM tenants t
       LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
       JOIN wa_config_global wcg ON wcg.tenant_id = t.id AND wcg.activo = 1`
    );

    for (const tenant of tenants) {
      let conn;
      try {
        conn = await getTenantConn(tenant);
        await procesarCampanasTenant(tenant, conn);
      } catch (e) {
        console.error(`[WA Campanas] Error tenant ${tenant.slug}:`, e.message);
      } finally {
        if (conn) await conn.end().catch(() => {});
      }
    }
  } catch (e) {
    console.error('[WA Campanas] Error general:', e.message);
  }
}

async function procesarCampanasTenant(tenant, conn) {
  // Activar campañas programadas cuya fecha ya llegó
  await conn.execute(
    `UPDATE wa_campanas
     SET estado='enviando', iniciada_at=NOW()
     WHERE estado='programada'
       AND programada_at IS NOT NULL
       AND programada_at <= NOW()`
  );

  let campanas;
  try {
    [campanas] = await conn.execute(
      `SELECT c.id, c.nombre, c.mensaje, c.imagen_url, c.segmento, c.segmento_valor,
              c.estado, c.total, c.enviados, c.fallidos,
              c.proveedor, c.meta_variables, p.nombre_meta, p.idioma AS meta_idioma, p.estado AS meta_estado, p.cuerpo AS meta_cuerpo
       FROM wa_campanas c
       LEFT JOIN wa_meta_plantillas p ON p.id = c.meta_plantilla_id
       WHERE c.estado = 'enviando'
       ORDER BY c.id ASC`
    );
  } catch {
    // Clínica sin migración v18: solo campañas por QR
    [campanas] = await conn.execute(
      `SELECT id, nombre, mensaje, imagen_url, segmento, segmento_valor,
              estado, total, enviados, fallidos, 'qr' AS proveedor
       FROM wa_campanas
       WHERE estado = 'enviando'
       ORDER BY id ASC`
    );
  }

  if (!campanas.length) return;

  const cfg = await getConfigCampana(conn);

  if (!dentroDeHorario(cfg.hora_inicio, cfg.hora_fin, tenant.zona_horaria)) return;

  for (const campana of campanas) {
    campana.tenant_id      = tenant.tenant_id;
    campana.nombre_clinica = tenant.nombre_clinica;
    const cfgCampana = campana.proveedor === 'meta'
      ? { ...cfg, limite_dia: META_LIMITE_DIA, delay_ms: META_DELAY_MS }
      : cfg;
    await procesarCampana(campana, conn, cfgCampana, tenant);
  }
}

async function procesarCampana(campana, conn, cfg, tenant) {
  try {
    // ── Verificar límite diario leyendo desde la tabla real ────────────────
    const limite = await verificarLimiteDiario(conn, campana.id, cfg.limite_dia);

    if (limite.agotado) {
      console.log(`[WA Campanas] ⏳ Campaña #${campana.id} — límite diario alcanzado (${limite.enviados_hoy}/${cfg.limite_dia}). Retomará mañana.`);
      await emitirProgreso(tenant.tenant_id, campana.id, {
        estado      : 'limite_diario',
        enviados    : campana.enviados,
        fallidos    : campana.fallidos,
        total       : campana.total,
        enviados_hoy: limite.enviados_hoy,
        limite_dia  : cfg.limite_dia,
        mensaje     : `Límite diario alcanzado. Retomará mañana.`,
      });
      return;
    }

    // ── Meta: la plantilla tiene que seguir aprobada ──────────────────────
    if (campana.proveedor === 'meta' && (!campana.nombre_meta || campana.meta_estado !== 'aprobada')) {
      await conn.execute("UPDATE wa_campanas SET estado='pausada', pausada_at=NOW() WHERE id=?", [campana.id]);
      console.log(`[WA Campanas] ⏸️  Campaña #${campana.id} pausada: la plantilla de Meta no está aprobada (${campana.meta_estado || 'sin plantilla'})`);
      return;
    }

    // ── Cargar contactos si aún no se hizo ────────────────────────────────
    const [[{ n }]] = await conn.execute(
      'SELECT COUNT(*) AS n FROM wa_campana_contactos WHERE campana_id=?', [campana.id]
    );
    if (!n) {
      await cargarContactosCampana(campana, conn);
    }

    // ── RESERVA ATÓMICA con transacción + FOR UPDATE ─────────────────────────
    // FOR UPDATE no es compatible con GROUP BY, por eso se hace en dos pasos:
    // 1) Seleccionar y lockear solo el ID del contacto (sin JOIN ni GROUP BY)
    // 2) Marcar como 'enviado' dentro de la misma transacción
    // 3) Hacer COMMIT — recién ahí otro ciclo puede ver ese contacto
    await conn.beginTransaction();
    let contacto = null;
    try {
      // Paso 1: lockear solo el ID — sin GROUP BY ni JOIN para que FOR UPDATE funcione
      const [[candidatoId]] = await conn.execute(
        `SELECT id FROM wa_campana_contactos
         WHERE campana_id=? AND estado='pendiente'
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [campana.id]
      );

      if (!candidatoId) {
        await conn.commit();
        // No quedan pendientes — verificar si completó
        const [[{ pendientes }]] = await conn.execute(
          `SELECT COUNT(*) AS pendientes
           FROM wa_campana_contactos
           WHERE campana_id=? AND estado='pendiente'`,
          [campana.id]
        );
        if (!pendientes) {
          await conn.execute(
            "UPDATE wa_campanas SET estado='completada', completada_at=NOW() WHERE id=?",
            [campana.id]
          );
          await emitirProgreso(tenant.tenant_id, campana.id, {
            estado: 'completada', enviados: campana.enviados,
            fallidos: campana.fallidos, total: campana.total, porcentaje: 100,
          });
          console.log(`[WA Campanas] ✅ Completada: "${campana.nombre}" (tenant: ${tenant.slug})`);
        }
        return;
      }

      // Paso 2: marcar como 'enviado' dentro de la misma transacción
      await conn.execute(
        "UPDATE wa_campana_contactos SET estado='enviado', enviado_at=NOW() WHERE id=?",
        [candidatoId.id]
      );
      await conn.commit();

      // Paso 3: obtener los datos completos del contacto ya reservado
      const [[datos]] = await conn.execute(
        `SELECT wcc.id, wcc.propietario_id, wcc.telefono, wcc.nombre,
                GROUP_CONCAT(m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
         FROM wa_campana_contactos wcc
         LEFT JOIN mascotas m ON m.propietario_id = wcc.propietario_id
         WHERE wcc.id=?
         GROUP BY wcc.id`,
        [candidatoId.id]
      );
      contacto = datos;
    } catch (e) {
      await conn.rollback();
      throw e;
    }

    if (!contacto) return;

    // Verificar que la campaña sigue en estado 'enviando'
    const [[estadoActual]] = await conn.execute(
      'SELECT estado FROM wa_campanas WHERE id=?', [campana.id]
    );
    if (!estadoActual || estadoActual.estado !== 'enviando') {
      console.log(`[WA Campanas] ⏸️  Campaña ${campana.id} pausada`);
      return;
    }

    const msg = rellenarPlantilla(campana.mensaje, {
      nombre  : contacto.nombre,
      mascota : contacto.mascotas || '',
      clinica : campana.nombre_clinica || 'VetNetcodip',
      telefono: tenant.tel_clinica || '',
    });

    const inicio = Date.now();
    let ok = false;

    // ── Meta: plantilla aprobada con sus variables ──────────────────────────
    if (campana.proveedor === 'meta') {
      let mapeo = [];
      try { mapeo = JSON.parse(campana.meta_variables || '[]'); } catch { mapeo = []; }
      const datos = {
        nombre : contacto.nombre || 'cliente',
        mascota: contacto.mascotas || 'tu mascota',
        clinica: campana.nombre_clinica || 'VetNetcodip',
      };
      const variables = mapeo.map(m => m.tipo === 'dato' ? (datos[m.valor] || '-') : String(m.valor || '-'));
      const resumen = (campana.meta_cuerpo || campana.mensaje || '')
        .replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => variables[n - 1] || '');
      let r;
      try {
        r = await callMeta({
          tenantId: campana.tenant_id, telefono: contacto.telefono, plantilla: campana.nombre_meta,
          idioma: campana.meta_idioma || 'es', variables, tipo: 'campana', campanaId: campana.id,
          imagenMediaId: String(campana.imagen_url || '').startsWith('meta-media:') ? campana.imagen_url.slice(11) : null,
          propietarioId: contacto.propietario_id, resumen, codigoPais: '+51',
        });
      } catch (e) { r = { success: false, reintentar: true, message: e.message }; }

      if (r.success) {
        await conn.execute(
          `UPDATE wa_campanas SET enviados=enviados+1, enviados_hoy=enviados_hoy+1, fecha_ultimo_envio=CURDATE() WHERE id=?`,
          [campana.id]
        );
        ok = true;
        console.log(`[WA Campanas] ✅ Meta → ${contacto.telefono} (${contacto.nombre})`);
      } else if (r.reintentar) {
        // Límite de Meta o falla temporal: vuelve a pendiente y se reintenta en el próximo ciclo
        await conn.execute(
          "UPDATE wa_campana_contactos SET estado='pendiente', enviado_at=NULL, error=? WHERE id=?",
          [String(r.message || '').substring(0, 255), contacto.id]
        );
        console.warn(`[WA Campanas] ⏳ Meta → ${contacto.telefono}: ${r.message} (se reintenta)`);
        await new Promise(res => setTimeout(res, 15000));
        return;
      } else {
        // Rechazo definitivo (número sin WhatsApp, etc.): no se reintenta
        await conn.execute(
          "UPDATE wa_campana_contactos SET estado='fallido', error=? WHERE id=?",
          [String(r.message || '').substring(0, 255), contacto.id]
        );
        await conn.execute('UPDATE wa_campanas SET fallidos=fallidos+1 WHERE id=?', [campana.id]);
        console.error(`[WA Campanas] ❌ Meta → ${contacto.telefono}: ${r.message}`);
      }
    } else try {
      await callGateway('POST', '/wa/enviar', {
        tenantId  : campana.tenant_id,
        telefono  : contacto.telefono,
        mensaje   : msg || null,
        imagen_url: campana.imagen_url || null,
        tipo      : 'campana',
        codigoPais: '+51',
      });

      await conn.execute(
        `UPDATE wa_campanas
         SET enviados=enviados+1, enviados_hoy=enviados_hoy+1, fecha_ultimo_envio=CURDATE()
         WHERE id=?`,
        [campana.id]
      );
      ok = true;
      console.log(`[WA Campanas] ✅ → ${contacto.telefono} (${contacto.nombre})`);
    } catch (e) {
      // Si falló el gateway, revertir a pendiente para reintentar en el próximo ciclo
      await conn.execute(
        "UPDATE wa_campana_contactos SET estado='pendiente', enviado_at=NULL, error=? WHERE id=?",
        [e.message.substring(0, 255), contacto.id]
      );
      await conn.execute(
        'UPDATE wa_campanas SET fallidos=fallidos+1 WHERE id=?', [campana.id]
      );
      console.error(`[WA Campanas] ❌ → ${contacto.telefono}: ${e.message}`);
    }

    // Emitir progreso en tiempo real
    const [[prog]] = await conn.execute(
      'SELECT enviados, fallidos, total, enviados_hoy FROM wa_campanas WHERE id=?', [campana.id]
    );
    if (prog) {
      const pct = prog.total > 0 ? Math.round((prog.enviados / prog.total) * 100) : 0;
      await emitirProgreso(campana.tenant_id, campana.id, {
        estado      : 'enviando',
        enviados    : prog.enviados,
        fallidos    : prog.fallidos,
        total       : prog.total,
        enviados_hoy: prog.enviados_hoy,
        limite_dia  : cfg.limite_dia,
        porcentaje  : pct,
      });
      await emitirLog(campana.tenant_id, campana.id, {
        telefono   : contacto.telefono,
        nombre     : contacto.nombre,
        estado     : ok ? 'enviado' : 'fallido',
        timestamp  : new Date().toISOString(),
        duracion_ms: Date.now() - inicio,
      });
    }

    // Delay anti-spam
    await new Promise(r => setTimeout(r, cfg.delay_ms));

  } catch (e) {
    console.error(`[WA Campanas] Error campaña ${campana.id}:`, e.message);
  }
}

async function cargarContactosCampana(campana, conn) {
  console.log(`[WA Campanas] Cargando contactos para campaña #${campana.id}`);
  const contactos = await obtenerContactosCampana(conn, campana);

  if (!contactos.length) {
    await conn.execute(
      "UPDATE wa_campanas SET estado='completada', completada_at=NOW() WHERE id=?",
      [campana.id]
    );
    return;
  }

  for (const c of contactos) {
    await conn.execute(
      'INSERT IGNORE INTO wa_campana_contactos (campana_id, propietario_id, telefono, nombre) VALUES (?,?,?,?)',
      [campana.id, c.id, c.telefono, c.nombre]
    );
  }
  await conn.execute(
    'UPDATE wa_campanas SET total=? WHERE id=?', [contactos.length, campana.id]
  );
  console.log(`[WA Campanas] ${contactos.length} contactos cargados para campaña #${campana.id}`);
}

// ── LOOP RECURSIVO CON AWAIT ───────────────────────────────────────────────
// El próximo ciclo solo arranca cuando el anterior terminó completamente.
// Esto elimina la posibilidad de que setInterval acumule ejecuciones paralelas.
async function loop() {
  console.log('[WA Campanas v4] ✅ Procesador activo — loop recursivo con await');
  while (true) {
    try {
      await procesarCampanas();
    } catch (e) {
      console.error('[WA Campanas] Error en loop principal:', e.message);
    }
    // Esperar 10s DESPUÉS de que terminó el ciclo — nunca se solapan
    await new Promise(r => setTimeout(r, 10000));
  }
}

loop();

module.exports = { procesarCampanas };