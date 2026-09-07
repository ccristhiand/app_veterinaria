'use strict';

/**
 * VetNetcodip SaaS — Procesador de Campañas WA v3
 * Mejoras:
 * - Límite diario anti-spam configurable por tenant
 * - Respeto de horario de envío (hora_inicio / hora_fin)
 * - Log en vivo por WebSocket de cada envío
 * - Reset automático del contador diario
 * - Soporte imagen Azure Blob
 */

const mysql = require('mysql2/promise');
const http  = require('http');
const path  = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WA_GATEWAY   = process.env.WA_GATEWAY_URL  || 'http://localhost:5001';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY  || 'wa-internal-secret-2026';

const masterPool = mysql.createPool({
  host              : process.env.MASTER_DB_HOST,
  port              : process.env.MASTER_DB_PORT || 3306,
  user              : process.env.MASTER_DB_USER,
  password          : process.env.MASTER_DB_PASS,
  database          : process.env.MASTER_DB_NAME,
  connectionLimit   : 3,
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

// ── Obtener config anti-spam del tenant ───────────────────────
async function getConfigCampana(conn) {
  const [cfg] = await conn.execute(
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

// ── Verificar si estamos en horario permitido ─────────────────
function dentroDeHorario(horaInicio, horaFin) {
  const ahora = new Date();
  const hh    = ahora.getHours().toString().padStart(2, '0');
  const mm    = ahora.getMinutes().toString().padStart(2, '0');
  const horaActual = `${hh}:${mm}:00`;
  return horaActual >= horaInicio && horaActual <= horaFin;
}

// ── Verificar y resetear contador diario ─────────────────────
async function verificarLimiteDiario(conn, campana, limiteDia) {
  const hoy = new Date().toISOString().split('T')[0];

  // Si el último envío fue otro día → resetear enviados_hoy
  if (!campana.fecha_ultimo_envio ||
      campana.fecha_ultimo_envio.toString().substring(0, 10) !== hoy) {
    await conn.execute(
      'UPDATE wa_campanas SET enviados_hoy=0, fecha_ultimo_envio=? WHERE id=?',
      [hoy, campana.id]
    );
    campana.enviados_hoy = 0;
  }

  const disponibleHoy = limiteDia - (campana.enviados_hoy || 0);
  return { disponible: Math.max(disponibleHoy, 0), agotado: disponibleHoy <= 0 };
}

// ── Obtener contactos de la campaña ──────────────────────────
async function obtenerContactosCampana(conn, campana) {
  switch (campana.segmento) {
    case 'todos':
      return conn.execute(
        `SELECT DISTINCT p.id, CONCAT(p.nombre,' ',p.apellido) AS nombre,
                p.telefono, GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
         FROM propietarios p LEFT JOIN mascotas m ON m.propietario_id = p.id
         WHERE p.telefono IS NOT NULL AND p.telefono != ''
         GROUP BY p.id`
      ).then(([r]) => r);
    case 'por_especie':
      return conn.execute(
        `SELECT DISTINCT p.id, CONCAT(p.nombre,' ',p.apellido) AS nombre,
                p.telefono, GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
         FROM propietarios p JOIN mascotas m ON m.propietario_id = p.id
         WHERE m.especie = ? AND p.telefono IS NOT NULL AND p.telefono != ''
         GROUP BY p.id`,
        [campana.segmento_valor || '']
      ).then(([r]) => r);
    case 'vacunas_vencidas':
      return conn.execute(
        `SELECT DISTINCT p.id, CONCAT(p.nombre,' ',p.apellido) AS nombre,
                p.telefono, m.nombre AS mascotas
         FROM propietarios p
         JOIN mascotas m ON m.propietario_id = p.id
         JOIN vacunas v ON v.mascota_id = m.id
         WHERE v.proxima_dosis < CURDATE() AND v.notificado = 0
           AND p.telefono IS NOT NULL AND p.telefono != ''
         GROUP BY p.id`
      ).then(([r]) => r);
    case 'sin_citas_60d':
      return conn.execute(
        `SELECT DISTINCT p.id, CONCAT(p.nombre,' ',p.apellido) AS nombre,
                p.telefono, GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
         FROM propietarios p LEFT JOIN mascotas m ON m.propietario_id = p.id
         WHERE p.id NOT IN (
           SELECT DISTINCT mascota_id FROM citas
           WHERE fecha_hora >= DATE_SUB(NOW(), INTERVAL 60 DAY)
         ) AND p.telefono IS NOT NULL AND p.telefono != ''
         GROUP BY p.id`
      ).then(([r]) => r);
    default:
      return [];
  }
}

// ── Procesar todas las campañas de todos los tenants ──────────
async function procesarCampanas() {
  try {
    const tenants = await masterQuery(
      `SELECT t.id AS tenant_id, t.slug, t.db_host, t.db_port, t.db_user, t.db_pass, t.db_name,
              tc.nombre_clinica, tc.telefono AS tel_clinica
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

  const [campanas] = await conn.execute(
    `SELECT id, nombre, mensaje, imagen_url, segmento, segmento_valor,
            estado, total, enviados, fallidos, enviados_hoy,
            fecha_ultimo_envio
     FROM wa_campanas
     WHERE estado = 'enviando'
     ORDER BY id ASC`
  );

  if (!campanas.length) return;

  const cfg = await getConfigCampana(conn);

  // Verificar horario
  if (!dentroDeHorario(cfg.hora_inicio, cfg.hora_fin)) {
    // Fuera de horario — no procesar
    return;
  }

  for (const campana of campanas) {
    campana.tenant_id      = tenant.tenant_id;
    campana.nombre_clinica = tenant.nombre_clinica;
    await procesarCampana(campana, conn, cfg, tenant);
  }
}

async function procesarCampana(campana, conn, cfg, tenant) {
  try {
    // Verificar límite diario
    const limite = await verificarLimiteDiario(conn, campana, cfg.limite_dia);

    if (limite.agotado) {
      console.log(`[WA Campanas] ⏳ Campaña #${campana.id} — límite diario alcanzado (${cfg.limite_dia}/día). Retomará mañana.`);
      await emitirProgreso(tenant.tenant_id, campana.id, {
        estado    : 'limite_diario',
        enviados  : campana.enviados,
        fallidos  : campana.fallidos,
        total     : campana.total,
        enviados_hoy: campana.enviados_hoy,
        limite_dia: cfg.limite_dia,
        mensaje   : `Límite diario alcanzado. Los ${campana.total - campana.enviados} mensajes restantes se enviarán mañana.`,
      });
      return;
    }

    // Obtener lote de contactos pendientes respetando el disponible de hoy
    // JOIN mascotas a demanda — sin columna extra en la tabla
    const [contactos] = await conn.execute(
      `SELECT wcc.id, wcc.propietario_id, wcc.telefono, wcc.nombre,
              GROUP_CONCAT(m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
       FROM wa_campana_contactos wcc
       LEFT JOIN mascotas m ON m.propietario_id = wcc.propietario_id
       WHERE wcc.campana_id=? AND wcc.estado='pendiente'
       GROUP BY wcc.id
       ORDER BY wcc.id ASC
       LIMIT ${parseInt(limite.disponible)}`,
      [campana.id]
    );

    if (!contactos.length) {
      // ¿Ya cargamos contactos?
      const [[{ n }]] = await conn.execute(
        'SELECT COUNT(*) AS n FROM wa_campana_contactos WHERE campana_id=?', [campana.id]
      );
      if (!n) {
        await cargarContactosCampana(campana, conn);
      } else {
        const [[{ pendientes }]] = await conn.execute(
          "SELECT COUNT(*) AS pendientes FROM wa_campana_contactos WHERE campana_id=? AND estado='pendiente'",
          [campana.id]
        );
        if (!pendientes) {
          await conn.execute(
            "UPDATE wa_campanas SET estado='completada', completada_at=NOW() WHERE id=?",
            [campana.id]
          );
          await emitirProgreso(tenant.tenant_id, campana.id, {
            estado: 'completada', enviados: campana.enviados, fallidos: campana.fallidos,
            total: campana.total, porcentaje: 100,
          });
          console.log(`[WA Campanas] ✅ Completada: "${campana.nombre}" (tenant: ${tenant.slug})`);
        }
      }
      return;
    }

    // Enviar lote
    for (const contacto of contactos) {
      // Verificar que sigue en estado enviando
      const [[estadoActual]] = await conn.execute(
        'SELECT estado, enviados_hoy FROM wa_campanas WHERE id=?', [campana.id]
      );
      if (!estadoActual || estadoActual.estado !== 'enviando') {
        console.log(`[WA Campanas] ⏸️  Campaña ${campana.id} pausada — deteniendo`);
        break;
      }

      const msg = rellenarPlantilla(campana.mensaje, {
        nombre  : contacto.nombre,
        mascota : contacto.mascotas || '',
        clinica : campana.nombre_clinica || 'VetNetcodip',
        telefono: tenant.tel_clinica || '',
      });

      const inicio = Date.now();
      let ok = false;

      try {
        await callGateway('POST', '/wa/enviar', {
          tenantId  : campana.tenant_id,
          telefono  : contacto.telefono,
          mensaje   : msg || null,
          imagen_url: campana.imagen_url || null,
          tipo      : 'campana',
          codigoPais: '+51',
        });

        await conn.execute(
          "UPDATE wa_campana_contactos SET estado='enviado', enviado_at=NOW() WHERE id=?",
          [contacto.id]
        );
        await conn.execute(
          'UPDATE wa_campanas SET enviados=enviados+1, enviados_hoy=enviados_hoy+1, fecha_ultimo_envio=CURDATE() WHERE id=?',
          [campana.id]
        );
        ok = true;
        console.log(`[WA Campanas] ✅ → ${contacto.telefono} (${contacto.nombre})`);
      } catch (e) {
        await conn.execute(
          "UPDATE wa_campana_contactos SET estado='fallido', error=? WHERE id=?",
          [e.message.substring(0, 255), contacto.id]
        );
        await conn.execute(
          'UPDATE wa_campanas SET fallidos=fallidos+1 WHERE id=?', [campana.id]
        );
        console.error(`[WA Campanas] ❌ → ${contacto.telefono}: ${e.message}`);
      }

      // Emitir progreso + log en vivo
      const [[prog]] = await conn.execute(
        'SELECT enviados, fallidos, total, enviados_hoy FROM wa_campanas WHERE id=?', [campana.id]
      );
      if (prog) {
        const pct = prog.total > 0 ? Math.round((prog.enviados / prog.total) * 100) : 0;
        await emitirProgreso(campana.tenant_id, campana.id, {
          estado    : 'enviando',
          enviados  : prog.enviados,
          fallidos  : prog.fallidos,
          total     : prog.total,
          enviados_hoy: prog.enviados_hoy,
          limite_dia: cfg.limite_dia,
          porcentaje: pct,
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
    }
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

setInterval(procesarCampanas, 10000);
procesarCampanas();

console.log(`[WA Campanas v3] ✅ Procesador activo`);
module.exports = { procesarCampanas };