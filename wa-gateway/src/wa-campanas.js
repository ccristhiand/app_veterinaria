'use strict';

/**
 * VetClinic SaaS — Procesador de Campañas WA
 * Pausa/reanuda, envía a 1 msg cada 4 segundos
 */

const mysql = require('mysql2/promise');
const http  = require('http');
const path  = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WA_GATEWAY   = process.env.WA_GATEWAY_URL  || 'http://localhost:5000';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';
const DELAY_MS     = 4000; // 4 segundos entre mensajes

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
      hostname: url.hostname, port: url.port || 5000, path: url.pathname, method,
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
             WHERE p.telefono IS NOT NULL
               AND v.proxima_dosis <= CURDATE()
               AND v.notificado = 0
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
                 SELECT DISTINCT m2.propietario_id
                 FROM citas c2
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

// ── Procesar campañas programadas / en espera ─────────────────
async function procesarCampanas() {
  try {
    // Activar campañas programadas cuya hora llegó
    await masterQuery(
      `UPDATE wa_campanas
       SET estado='enviando', iniciada_at=NOW()
       WHERE estado='programada' AND programada_at <= NOW()`
    );

    // Obtener campañas activas (enviando o reanudadas)
    const campanas = await masterQuery(
      `SELECT wc.*, t.id AS tenant_id, t.slug, t.db_host, t.db_port, t.db_user, t.db_pass, t.db_name,
               tc.nombre_clinica, twacc.codigo_pais, twacc.activo AS wa_activo
       FROM wa_campanas wc
       JOIN tenants t ON t.id = wc.tenant_id
       LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
       LEFT JOIN wa_sesiones ws ON ws.tenant_id = t.id
       LEFT JOIN wa_config_global wcg ON wcg.tenant_id = t.id
       WHERE wc.estado = 'enviando'
         AND ws.estado = 'conectado'
         AND wcg.activo = 1
       LIMIT 5` // procesar hasta 5 campañas simultáneas
    );

    for (const campana of campanas) {
      await procesarCampana(campana);
    }
  } catch (e) {
    console.error('[WA Campanas] Error:', e.message);
  }
}

async function procesarCampana(campana) {
  console.log(`[WA Campanas] Procesando: "${campana.nombre}" (${campana.tenant_nombre})`);
  let conn;

  try {
    conn = await getTenantConn(campana);

    // Obtener contactos pendientes desde donde quedó (usando último id procesado)
    const contactosPendientes = await conn.execute(
      `SELECT wcc.id, wcc.propietario_id, wcc.telefono, wcc.nombre
       FROM wa_campana_contactos wcc
       WHERE wcc.campana_id = ? AND wcc.estado = 'pendiente'
       ORDER BY wcc.id ASC
       LIMIT 50`, // procesar de a 50 por ciclo
      [campana.id]
    );

    const contactos = contactosPendientes[0] || [];

    // Si no hay contactos pendientes pero la campaña dice enviando
    // → verificar si hay que cargarlos primero
    if (!contactos.length) {
      const [[total]] = await conn.execute(
        'SELECT COUNT(*) AS n FROM wa_campana_contactos WHERE campana_id=?',
        [campana.id]
      );
      if (!total?.n) {
        // Primera vez — cargar contactos
        await cargarContactosCampana(campana, conn);
        return;
      } else {
        // Todos enviados — completar
        await masterQuery(
          'UPDATE wa_campanas SET estado=?, completada_at=NOW() WHERE id=?',
          ['completada', campana.id]
        );
        console.log(`[WA Campanas] ✅ Completada: "${campana.nombre}"`);
        return;
      }
    }

    for (const contacto of contactos) {
      // Verificar si la campaña fue pausada o cancelada
      const [estadoActual] = await masterQuery(
        'SELECT estado FROM wa_campanas WHERE id=?', [campana.id]
      );
      if (!estadoActual || !['enviando'].includes(estadoActual.estado)) {
        console.log(`[WA Campanas] ⏸️  Campaña ${campana.id} pausada/cancelada`);
        break;
      }

      const msg = rellenarPlantilla(campana.mensaje, {
        nombre  : contacto.nombre,
        mascota : '', // se puede enriquecer
        clinica : campana.nombre_clinica || 'VetClinic',
      });

      try {
        await callGateway('POST', '/wa/enviar', {
          tenantId  : campana.tenant_id,
          telefono  : contacto.telefono,
          mensaje   : msg,
          tipo      : 'campana',
          codigoPais: campana.codigo_pais || '+51',
        });

        // Marcar como enviado
        await conn.execute(
          'UPDATE wa_campana_contactos SET estado=?, enviado_at=NOW() WHERE id=?',
          ['enviado', contacto.id]
        );
        await masterQuery(
          'UPDATE wa_campanas SET enviados=enviados+1 WHERE id=?',
          [campana.id]
        );

        console.log(`[WA Campanas] ✅ → ${contacto.telefono}`);
      } catch (e) {
        await conn.execute(
          'UPDATE wa_campana_contactos SET estado=?, error=? WHERE id=?',
          ['fallido', e.message, contacto.id]
        );
        await masterQuery(
          'UPDATE wa_campanas SET fallidos=fallidos+1 WHERE id=?',
          [campana.id]
        );
        console.error(`[WA Campanas] ❌ → ${contacto.telefono}: ${e.message}`);
      }

      // Esperar 4 segundos entre mensajes (anti-ban)
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  } catch (e) {
    console.error(`[WA Campanas] Error campaña ${campana.id}: ${e.message}`);
  } finally {
    await conn?.end();
  }
}

async function cargarContactosCampana(campana, conn) {
  console.log(`[WA Campanas] Cargando contactos para: "${campana.nombre}"`);
  const contactos = await obtenerContactosCampana(conn, campana);

  if (!contactos.length) {
    await masterQuery(
      "UPDATE wa_campanas SET estado='completada', completada_at=NOW() WHERE id=?",
      [campana.id]
    );
    return;
  }

  // Insertar contactos en wa_campana_contactos
  for (const c of contactos) {
    await conn.execute(
      'INSERT IGNORE INTO wa_campana_contactos (campana_id, propietario_id, telefono, nombre) VALUES (?,?,?,?)',
      [campana.id, c.id, c.telefono, c.nombre]
    );
  }

  // Actualizar total
  await masterQuery(
    'UPDATE wa_campanas SET total=? WHERE id=?',
    [contactos.length, campana.id]
  );

  console.log(`[WA Campanas] ${contactos.length} contactos cargados`);
}

// Scheduler — cada 10 segundos
setInterval(procesarCampanas, 10000);
procesarCampanas();

console.log('[WA Campanas] ✅ Procesador activo');

module.exports = { procesarCampanas };