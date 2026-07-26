'use strict';

/**
 * VetClinic SaaS — Procesador de Campañas WA
 * Las campañas viven en la BD de cada tenant, NO en vet_master
 */

const mysql = require('mysql2/promise');
const http  = require('http');
const path  = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WA_GATEWAY   = process.env.WA_GATEWAY_URL  || 'http://localhost:5001';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';
const DELAY_MS     = 4000;

const masterPool = mysql.createPool({
  host    : process.env.MASTER_DB_HOST,
  port    : process.env.MASTER_DB_PORT || 3306,
  user    : process.env.MASTER_DB_USER,
  password: process.env.MASTER_DB_PASS,
  database: process.env.MASTER_DB_NAME,
  connectionLimit: 3,
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
    const url = new URL(WA_GATEWAY + path);
    const options = {
      hostname: url.hostname, port: url.port || 5001, path: url.pathname, method,
      headers: {
        'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function rellenarPlantilla(msg, vars) {
  return msg
    .replace(/\[nombre\]/gi,   vars.nombre   || '')
    .replace(/\[mascota\]/gi,  vars.mascota  || '')
    .replace(/\[clinica\]/gi,  vars.clinica  || '')
    .replace(/\[telefono\]/gi, vars.telefono || '');
}

async function obtenerContactosCampana(conn, campana) {
  let sql = '';
  const params = [];

  switch (campana.segmento) {
    case 'todos':
      sql = `SELECT DISTINCT p.id, CONCAT(p.nombre,' ',p.apellido) AS nombre,
               p.telefono, GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
             FROM propietarios p
             LEFT JOIN mascotas m ON m.propietario_id = p.id
             WHERE p.telefono IS NOT NULL AND p.telefono != ''
             GROUP BY p.id`;
      break;
    case 'por_especie':
      sql = `SELECT DISTINCT p.id, CONCAT(p.nombre,' ',p.apellido) AS nombre,
               p.telefono, GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
             FROM propietarios p
             JOIN mascotas m ON m.propietario_id = p.id
             WHERE p.telefono IS NOT NULL AND m.especie = ?
             GROUP BY p.id`;
      params.push(campana.segmento_valor || 'perro');
      break;
    case 'vacunas_vencidas':
      sql = `SELECT DISTINCT p.id, CONCAT(p.nombre,' ',p.apellido) AS nombre,
               p.telefono, GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
             FROM propietarios p
             JOIN mascotas m ON m.propietario_id = p.id
             JOIN vacunas v ON v.mascota_id = m.id
             WHERE p.telefono IS NOT NULL AND v.proxima_dosis <= CURDATE() AND v.notificado = 0
             GROUP BY p.id`;
      break;
    case 'citas_semana':
      sql = `SELECT DISTINCT p.id, CONCAT(p.nombre,' ',p.apellido) AS nombre,
               p.telefono, GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
             FROM propietarios p
             JOIN mascotas m ON m.propietario_id = p.id
             JOIN citas c ON c.mascota_id = m.id
             WHERE p.telefono IS NOT NULL
               AND c.fecha_hora BETWEEN NOW() AND NOW() + INTERVAL 7 DAY
               AND c.estado IN ('pendiente','confirmada')
             GROUP BY p.id`;
      break;
    case 'sin_citas_60d':
      sql = `SELECT p.id, CONCAT(p.nombre,' ',p.apellido) AS nombre,
               p.telefono, GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
             FROM propietarios p
             LEFT JOIN mascotas m ON m.propietario_id = p.id
             WHERE p.telefono IS NOT NULL
               AND p.id NOT IN (
                 SELECT DISTINCT m2.propietario_id FROM citas c2
                 JOIN mascotas m2 ON m2.id = c2.mascota_id
                 WHERE c2.fecha_hora >= NOW() - INTERVAL 60 DAY
               )
             GROUP BY p.id`;
      break;
    default:
      sql = `SELECT p.id, CONCAT(p.nombre,' ',p.apellido) AS nombre, p.telefono, '' AS mascotas
             FROM propietarios p WHERE p.telefono IS NOT NULL`;
  }

  const [rows] = await conn.execute(sql, params);
  return rows;
}

// ── Procesar campañas ─────────────────────────────────────────
async function procesarCampanas() {
  try {
    // Obtener tenants con WA conectado
    const tenants = await masterQuery(
      `SELECT t.id, t.slug, t.db_host, t.db_port, t.db_user, t.db_pass, t.db_name,
              tc.nombre_clinica
       FROM tenants t
       JOIN tenant_config tc ON tc.tenant_id = t.id
       JOIN wa_sesiones ws ON ws.tenant_id = t.id
       JOIN wa_config_global wcg ON wcg.tenant_id = t.id
       WHERE t.activo = 1 AND ws.estado = 'conectado' AND wcg.activo = 1`
    );

    for (const tenant of tenants) {
      let conn;
      try {
        conn = await getTenantConn(tenant);

        // Activar campañas programadas cuya hora llegó
        await conn.execute(
          `UPDATE wa_campanas SET estado='enviando', iniciada_at=NOW()
           WHERE estado='programada' AND programada_at <= NOW()`
        );

        // Obtener campañas activas del tenant
        const [campanas] = await conn.execute(
          `SELECT *, ? AS tenant_id, ? AS slug, ? AS nombre_clinica
           FROM wa_campanas WHERE estado='enviando' LIMIT 3`,
          [tenant.id, tenant.slug, tenant.nombre_clinica]
        );

        for (const campana of campanas) {
          campana.db_host = tenant.db_host;
          campana.db_port = tenant.db_port;
          campana.db_user = tenant.db_user;
          campana.db_pass = tenant.db_pass;
          campana.db_name = tenant.db_name;
          await procesarCampana(campana, conn);
        }
      } catch (e) {
        console.error(`[WA Campanas] Error tenant ${tenant.slug}: ${e.message}`);
      } finally {
        await conn?.end();
      }
    }
  } catch (e) {
    console.error('[WA Campanas] Error general:', e.message);
  }
}

async function procesarCampana(campana, conn) {
  console.log(`[WA Campanas] Procesando: "${campana.nombre}" (${campana.slug})`);

  try {
    const [contactosPendientes] = await conn.execute(
      `SELECT id, propietario_id, telefono, nombre FROM wa_campana_contactos
       WHERE campana_id=? AND estado='pendiente' ORDER BY id ASC LIMIT 50`,
      [campana.id]
    );

    if (!contactosPendientes.length) {
      const [[total]] = await conn.execute(
        'SELECT COUNT(*) AS n FROM wa_campana_contactos WHERE campana_id=?', [campana.id]
      );
      if (!total?.n) {
        await cargarContactosCampana(campana, conn);
      } else {
        await conn.execute(
          "UPDATE wa_campanas SET estado='completada', completada_at=NOW() WHERE id=?", [campana.id]
        );
        console.log(`[WA Campanas] ✅ Completada: "${campana.nombre}"`);
      }
      return;
    }

    for (const contacto of contactosPendientes) {
      // Verificar si fue pausada/cancelada
      const [[estadoActual]] = await conn.execute(
        'SELECT estado FROM wa_campanas WHERE id=?', [campana.id]
      );
      if (!estadoActual || estadoActual.estado !== 'enviando') {
        console.log(`[WA Campanas] ⏸️  Campaña ${campana.id} pausada — deteniendo`);
        break;
      }

      const msg = rellenarPlantilla(campana.mensaje, {
        nombre : contacto.nombre,
        clinica: campana.nombre_clinica || 'VetClinic',
      });

      try {
        await callGateway('POST', '/wa/enviar', {
          tenantId  : campana.tenant_id,
          telefono  : contacto.telefono,
          mensaje   : msg,
          tipo      : 'campana',
          codigoPais: '+51',
        });
        await conn.execute(
          "UPDATE wa_campana_contactos SET estado='enviado', enviado_at=NOW() WHERE id=?",
          [contacto.id]
        );
        await conn.execute(
          'UPDATE wa_campanas SET enviados=enviados+1 WHERE id=?', [campana.id]
        );
        console.log(`[WA Campanas] ✅ → ${contacto.telefono}`);
      } catch (e) {
        await conn.execute(
          'UPDATE wa_campana_contactos SET estado=?, error=? WHERE id=?',
          ['fallido', e.message.substring(0, 255), contacto.id]
        );
        await conn.execute(
          'UPDATE wa_campanas SET fallidos=fallidos+1 WHERE id=?', [campana.id]
        );
        console.error(`[WA Campanas] ❌ → ${contacto.telefono}: ${e.message}`);
      }

      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  } catch (e) {
    console.error(`[WA Campanas] Error campaña ${campana.id}: ${e.message}`);
  }
}

async function cargarContactosCampana(campana, conn) {
  console.log(`[WA Campanas] Cargando contactos: "${campana.nombre}"`);
  const contactos = await obtenerContactosCampana(conn, campana);

  if (!contactos.length) {
    await conn.execute(
      "UPDATE wa_campanas SET estado='completada', completada_at=NOW() WHERE id=?", [campana.id]
    );
    console.log(`[WA Campanas] ⚠️  Sin contactos para campaña ${campana.id}`);
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

  console.log(`[WA Campanas] ${contactos.length} contactos cargados`);
}

setInterval(procesarCampanas, 10000);
procesarCampanas();

console.log('[WA Campanas] ✅ Procesador activo');

module.exports = { procesarCampanas };