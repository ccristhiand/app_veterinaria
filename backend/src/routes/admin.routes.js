'use strict';

const { Router }    = require('express');
const bcrypt        = require('bcryptjs');
const jwt           = require('jsonwebtoken');
const { masterQuery } = require('../config/masterDB');
const { getPoolForTenant, createDBHelper, evictTenantPool, getPoolStats } = require('../config/tenantDB');
const { invalidateTenantCache } = require('../middlewares/tenant.middleware');
const logger        = require('../config/logger');
const mysql         = require('mysql2/promise');
const path          = require('path');
const fs            = require('fs');

const router       = Router();
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'admin-secret';

// ── Auth admin ────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.slice(7);
  if (!token) return res.status(401).json({ success: false, message: 'Token requerido.' });
  try {
    req.adminUser = jwt.verify(token, ADMIN_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Token inválido.' });
  }
}

// POST /admin/api/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [user] = await masterQuery(
      'SELECT * FROM admin_usuarios WHERE email = ? AND activo = 1', [email]
    );
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
    }
    const token = jwt.sign({ id: user.id, rol: user.rol, nombre: user.nombre }, ADMIN_SECRET, { expiresIn: '12h' });
    return res.json({ success: true, data: { token, nombre: user.nombre, rol: user.rol } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.use(adminAuth);

// ── GET /admin/api/tenants ────────────────────────────────────────
router.get('/tenants', async (req, res) => {
  try {
    const tenants = await masterQuery(
      `SELECT t.*, tc.nombre_clinica, tc.logo_url, tc.color_primario, tc.color_acento,
              tc.modulo_facturacion, tc.modulo_estetica, tc.modulo_inventario,
              tc.modulo_vacunas, tc.modulo_consentimientos, tc.modulo_carnet,
              tc.max_usuarios, tc.moneda, tc.simbolo_moneda, tc.igv_porcentaje,
              tc.ruc, tc.razon_social, tc.telefono, tc.email, tc.direccion,
              tc.web, tc.favicon_url, tc.color_sidebar
       FROM tenants t
       LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
       ORDER BY t.created_at DESC`
    );
    return res.json({ success: true, data: tenants });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /admin/api/tenants/:id ────────────────────────────────────
router.get('/tenants/:id', async (req, res) => {
  try {
    const [tenant] = await masterQuery(
      `SELECT t.*, tc.*
       FROM tenants t
       LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
       WHERE t.id = ?`, [req.params.id]
    );
    if (!tenant) return res.status(404).json({ success: false, message: 'No encontrado.' });
    return res.json({ success: true, data: tenant });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /admin/api/tenants — crear nueva clínica ─────────────────
router.post('/tenants', async (req, res) => {
  try {
    const {
      nombre_clinica, subdominio,
      plan, color_primario, color_sidebar, color_acento,
      logo_url, moneda, simbolo_moneda, igv_porcentaje,
      max_usuarios, modulo_estetica, modulo_facturacion, modulo_inventario,
      modulo_vacunas, modulo_consentimientos, modulo_carnet,
      admin_nombre, admin_email, admin_password,
    } = req.body;

    if (!nombre_clinica || !subdominio) {
      return res.status(422).json({ success: false, message: 'nombre_clinica y subdominio son obligatorios.' });
    }
    if (!admin_email || !admin_password) {
      return res.status(422).json({ success: false, message: 'Se requiere email y password del admin inicial.' });
    }

    // ── Generar slug y nombre de BD desde subdominio ──────────────
    // subdominio puede venir como "prueba" o "prueba.netcodip.com"
    // Extraer solo la primera parte
    const slugBase = subdominio.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '_');
    const slug     = slugBase;
    const dbName   = `vet_${slugBase}`;
    const dominioBase    = process.env.SAAS_DOMAIN || 'netcodip.com';
    const subdominioFull = subdominio.includes('.') ? subdominio : `${subdominio}.${dominioBase}`;

    // 1. Verificar que no existe
    const [existe] = await masterQuery(
      'SELECT id FROM tenants WHERE slug = ? OR subdominio = ?', [slug, subdominioFull]
    );
    if (existe) return res.status(422).json({ success: false, message: 'El subdominio ya existe.' });

    // 2. Crear la BD del tenant
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbUser = process.env.DB_USER || 'cadc';
    const dbPass = process.env.DB_PASS || '';

    const tempConn = await mysql.createConnection({
      host: dbHost, user: dbUser, password: dbPass,
    });
    await tempConn.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await tempConn.end();

    // 3. Ejecutar schema base — statement por statement
    const schemaPath = path.join(__dirname, '../../sql/tenant_schema.sql');
    if (fs.existsSync(schemaPath)) {
      let schema = fs.readFileSync(schemaPath, 'utf8');

      // Limpiar el schema — solo hasta el final del SQL válido
      // Eliminar cualquier código JS o texto que no sea SQL
      const jsIndex = schema.indexOf("'use strict'");
      if (jsIndex > 0) schema = schema.substring(0, jsIndex);

      const tenantConn = await mysql.createConnection({
        host: dbHost, user: dbUser, password: dbPass,
        database: dbName, multipleStatements: false,
      });

      const statements = schema
        .replace(/--[^\n]*/g, '')   // eliminar comentarios --
        .replace(/\/\*[\s\S]*?\*\//g, '') // eliminar comentarios /* */
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 10);

      try {
        for (const stmt of statements) {
          await tenantConn.execute(stmt);
        }
      } finally {
        await tenantConn.end();
      }
    }

    // 4. Registrar en vet_master
    const result = await masterQuery(
      `INSERT INTO tenants (slug, subdominio, db_name, db_host, db_user, db_pass, plan)
       VALUES (?,?,?,?,?,?,?)`,
      [slug, subdominioFull, dbName, dbHost, dbUser, dbPass, plan || 'pro']
    );
    const tenantId = result.insertId;

    // 5. Config inicial en tenant_config
    await masterQuery(
      `INSERT INTO tenant_config
         (tenant_id, nombre_clinica, logo_url, color_primario, color_sidebar, color_acento,
          moneda, simbolo_moneda, igv_porcentaje, max_usuarios,
          modulo_estetica, modulo_facturacion, modulo_inventario,
          modulo_vacunas, modulo_consentimientos, modulo_carnet)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tenantId, nombre_clinica, logo_url||null,
       color_primario||'#10b981', color_sidebar||'#0d3b2e', color_acento||'#059669',
       moneda||'PEN', simbolo_moneda||'S/.', igv_porcentaje||18, max_usuarios||5,
       modulo_estetica?1:0, modulo_facturacion?1:0, modulo_inventario?1:0,
       modulo_vacunas?1:0, modulo_consentimientos?1:0, modulo_carnet?1:0]
    );

    // 6. Crear usuario admin inicial en la BD del tenant
    const tenantConn2 = await mysql.createConnection({
      host: dbHost, user: dbUser, password: dbPass, database: dbName,
    });
    const hashedPass = await bcrypt.hash(admin_password, 10);
    await tenantConn2.execute(
      "INSERT INTO usuarios (nombre, email, password, rol, must_change_password) VALUES (?,?,?,'admin',0)",
      [admin_nombre || 'Administrador', admin_email, hashedPass]
    );

    // 7. Actualizar empresa_config con nombre de la clínica
    await tenantConn2.execute(
      'UPDATE empresa_config SET nombre=?, simbolo_moneda=?, igv_porcentaje=? WHERE id=1',
      [nombre_clinica, simbolo_moneda||'S/.', igv_porcentaje||18]
    );
    await tenantConn2.end();

    // 8. Config de backup por defecto
    await masterQuery(
      `INSERT IGNORE INTO tenant_backup_config (tenant_id) VALUES (?)`, [tenantId]
    ).catch(() => {});

    logger.info(`✅ Tenant creado: ${slug} → ${dbName}`);

    // ── Crear usuario del portal de pagos automáticamente ────────
    try {
      const bcrypt = require('bcryptjs');
      const hash   = await bcrypt.hash(admin_password || 'Vet2024!', 10);
      await masterQuery(
        `INSERT IGNORE INTO saas_portal_usuarios (tenant_id, nombre, email, password, activo)
         VALUES (?,?,?,?,1)`,
        [tenantId, admin_nombre || 'Administrador', admin_email, hash]
      );
      // Suscripción inicial (30 días trial)
      // Mapear códigos viejos a los nuevos
      const planMap = { basic: 'basico', pro: 'profesional', enterprise: 'clinica_pro' };
      const planCodigo = planMap[plan] || plan || 'profesional';
      const [planRow] = await masterQuery(
        'SELECT id, precio_mensual FROM saas_planes WHERE codigo=? AND activo=1 LIMIT 1',
        [planCodigo]
      );
      if (planRow) {
        const hoy   = new Date().toISOString().split('T')[0];
        const vence = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        // Crear suscripción trial 30 días
        await masterQuery(
          `INSERT IGNORE INTO saas_suscripciones
             (tenant_id, plan_id, precio_acordado, fecha_inicio, fecha_vencimiento, estado)
           VALUES (?,?,?,?,?,'trial')`,
          [tenantId, planRow.id, planRow.precio_mensual, hoy, vence]
        );

        // Sincronizar trial_hasta en tenant_config para acceso al sistema
        await masterQuery(
          'UPDATE tenant_config SET trial_hasta=? WHERE tenant_id=?',
          [vence, tenantId]
        );

        // Obtener la suscripción recién creada
        const [sus] = await masterQuery(
          'SELECT id FROM saas_suscripciones WHERE tenant_id=? LIMIT 1',
          [tenantId]
        );

        // Generar primer cobro (vence al finalizar el trial)
        if (sus) {
          const anio      = new Date().getFullYear();
          const [lastCob] = await masterQuery(
            `SELECT numero_cobro FROM saas_cobros WHERE numero_cobro LIKE ? ORDER BY id DESC LIMIT 1`,
            [`VN-${anio}-%`]
          ).catch(() => [null]);
          const siguiente = lastCob
            ? parseInt(lastCob.numero_cobro.split('-')[2]) + 1 : 1;
          const numeroCobro = `VN-${anio}-${String(siguiente).padStart(4,'0')}`;
          const periodo     = vence.slice(0,7); // mes de vencimiento

          await masterQuery(
            `INSERT IGNORE INTO saas_cobros
               (tenant_id, suscripcion_id, periodo, meses, monto_base, descuento_pct,
                monto_final, estado, fecha_emision, fecha_vencimiento, numero_cobro)
             VALUES (?,?,?,1,?,0,?,'pendiente',?,?,?)`,
            [tenantId, sus.id, periodo, planRow.precio_mensual,
             planRow.precio_mensual, hoy, vence, numeroCobro]
          );
        }
      }

      // Enviar email de bienvenida si el módulo de pagos está disponible
      try {
        const emailPath = require('path').join(__dirname, '../../../pagos-saas/src/services/email.service');
        const emailSvc  = require(emailPath);
        await emailSvc.enviarBienvenida({
          email             : admin_email,
          nombre            : admin_nombre || 'Administrador',
          clinica_nombre    : nombre_clinica,
          password_temporal : admin_password,
        });
      } catch(emailErr) {
        // El módulo de pagos puede no estar disponible aún, no es crítico
        console.warn('[Admin] Email de bienvenida no enviado:', emailErr.message);
      }

    } catch(e) {
      console.warn('[Admin] Error creando usuario portal:', e.message);
    }

    return res.status(201).json({
      success: true,
      message: `Clínica "${nombre_clinica}" creada correctamente.`,
      data: { tenantId, dbName, subdominio: subdominioFull, url: `https://${subdominioFull}` },
    });
  } catch (err) {
    logger.error(`Error creando tenant: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /admin/api/tenants/:id ────────────────────────────────────
router.put('/tenants/:id', async (req, res) => {
  try {
    const {
      nombre_clinica, ruc, razon_social, telefono, email, direccion, web,
      logo_url, favicon_url, color_primario, color_sidebar, color_acento,
      plan, activo, trial_hasta, max_usuarios, moneda, simbolo_moneda, igv_porcentaje,
      modulo_estetica, modulo_facturacion, modulo_inventario, modulo_vacunas,
      modulo_consentimientos, modulo_carnet, zona_horaria, pais,
    } = req.body;

    await masterQuery(
      'UPDATE tenants SET plan=?, activo=?, trial_hasta=? WHERE id=?',
      [plan||'pro', activo !== undefined ? (activo?1:0) : 1, trial_hasta||null, req.params.id]
    );

    await masterQuery(
      `UPDATE tenant_config SET
         nombre_clinica=?, ruc=?, razon_social=?, telefono=?, email=?, direccion=?, web=?,
         logo_url=?, favicon_url=?,
         color_primario=?, color_sidebar=?, color_acento=?,
         max_usuarios=?, moneda=?, simbolo_moneda=?, igv_porcentaje=?,
         modulo_estetica=?, modulo_facturacion=?, modulo_inventario=?,
         modulo_vacunas=?, modulo_consentimientos=?, modulo_carnet=?,
         zona_horaria=?, pais=?
       WHERE tenant_id=?`,
      [
        nombre_clinica||'VetClinic', ruc||null, razon_social||null,
        telefono||null, email||null, direccion||null, web||null,
        logo_url||null, favicon_url||null,
        color_primario||'#10b981', color_sidebar||'#0d3b2e', color_acento||'#059669',
        max_usuarios||5, moneda||'PEN', simbolo_moneda||'S/.', igv_porcentaje||18,
        modulo_estetica?1:0, modulo_facturacion?1:0, modulo_inventario?1:0,
        modulo_vacunas?1:0, modulo_consentimientos?1:0, modulo_carnet?1:0,
        zona_horaria||'America/Lima', pais||'Peru',
        req.params.id
      ]
    );

    // Sincronizar con empresa_config del tenant
    try {
      const [t] = await masterQuery(
        'SELECT db_host, db_port, db_user, db_pass, db_name FROM tenants WHERE id=?',
        [req.params.id]
      );
      if (t) {
        const conn = await mysql.createConnection({
          host: t.db_host, port: t.db_port||3306,
          user: t.db_user, password: t.db_pass, database: t.db_name,
        });
        await conn.execute(
          'UPDATE empresa_config SET nombre=?, simbolo_moneda=?, igv_porcentaje=? WHERE id=1',
          [nombre_clinica||'VetClinic', simbolo_moneda||'S/.', igv_porcentaje||18]
        );
        await conn.end();
      }
    } catch(e) {
      console.warn('[admin] No se pudo sincronizar empresa_config:', e.message);
    }

    const [t2] = await masterQuery('SELECT subdominio FROM tenants WHERE id=?', [req.params.id]);
    if (t2) invalidateTenantCache(t2.subdominio);

    return res.json({ success: true, message: 'Clínica actualizada.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── PATCH /admin/api/tenants/:id/toggle ──────────────────────────
router.patch('/tenants/:id/toggle', async (req, res) => {
  try {
    const [t] = await masterQuery('SELECT * FROM tenants WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ success: false, message: 'No encontrado.' });
    const nuevoEstado = t.activo ? 0 : 1;
    await masterQuery('UPDATE tenants SET activo=? WHERE id=?', [nuevoEstado, req.params.id]);
    invalidateTenantCache(t.subdominio);
    evictTenantPool(t.db_name);
    return res.json({ success: true, message: nuevoEstado ? 'Clínica activada.' : 'Clínica suspendida.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /admin/api/tenants/:id/suspender ────────────────────────
router.post('/tenants/:id/suspender', async (req, res) => {
  try {
    const { motivo } = req.body;
    if (!motivo?.trim())
      return res.status(422).json({ success: false, message: 'El motivo es obligatorio.' });
    const [t] = await masterQuery('SELECT * FROM tenants WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ success: false, message: 'No encontrado.' });
    if (!t.activo) return res.status(422).json({ success: false, message: 'Ya está suspendida.' });
    await masterQuery('UPDATE tenants SET activo=0 WHERE id=?', [req.params.id]);
    await masterQuery(
      'UPDATE tenant_config SET motivo_suspension=? WHERE tenant_id=?',
      [motivo.trim(), req.params.id]
    ).catch(() => {});
    invalidateTenantCache(t.subdominio);
    evictTenantPool(t.db_name);
    return res.json({ success: true, message: `Clínica suspendida.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /admin/api/tenants/:id/reactivar ────────────────────────
router.post('/tenants/:id/reactivar', async (req, res) => {
  try {
    const [t] = await masterQuery('SELECT * FROM tenants WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ success: false, message: 'No encontrado.' });
    if (t.activo) return res.status(422).json({ success: false, message: 'Ya está activa.' });
    await masterQuery('UPDATE tenants SET activo=1 WHERE id=?', [req.params.id]);
    await masterQuery(
      'UPDATE tenant_config SET motivo_suspension=NULL WHERE tenant_id=?',
      [req.params.id]
    ).catch(() => {});
    invalidateTenantCache(t.subdominio);
    return res.json({ success: true, message: 'Clínica reactivada.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /admin/api/stats ──────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [total]      = await masterQuery('SELECT COUNT(*) AS n FROM tenants');
    const [activos]    = await masterQuery('SELECT COUNT(*) AS n FROM tenants WHERE activo=1');
    const [suspendidos]= await masterQuery('SELECT COUNT(*) AS n FROM tenants WHERE activo=0');
    const porPlan      = await masterQuery('SELECT plan, COUNT(*) AS n FROM tenants GROUP BY plan');
    const poolStats    = getPoolStats();

    // Próximos a vencer en trial (próximos 7 días)
    const proximosVencer = await masterQuery(
      `SELECT t.id, t.slug, tc.nombre_clinica, t.trial_hasta, t.plan
       FROM tenants t
       LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
       WHERE t.activo = 1
         AND t.trial_hasta IS NOT NULL
         AND t.trial_hasta BETWEEN CURDATE() AND CURDATE() + INTERVAL 7 DAY
       ORDER BY t.trial_hasta ASC`
    );

    // Último backup por tenant
    const ultimosBackups = await masterQuery(
      `SELECT tenant_id, MAX(created_at) AS ultimo, COUNT(*) AS total,
              SUM(CASE WHEN estado='exitoso' THEN 1 ELSE 0 END) AS exitosos
       FROM tenant_backups
       WHERE created_at >= NOW() - INTERVAL 24 HOUR
       GROUP BY tenant_id`
    );

    // WA conectadas
    const [waConectadas] = await masterQuery(
      "SELECT COUNT(*) AS n FROM wa_sesiones WHERE estado='conectado'"
    );

    // Actividad reciente por clínica (logs últimas 24h)
    const actividadHoy = await masterQuery(
      `SELECT tenant_nombre, COUNT(*) AS acciones,
              SUM(CASE WHEN resultado='error' THEN 1 ELSE 0 END) AS errores
       FROM tenant_logs
       WHERE created_at >= NOW() - INTERVAL 24 HOUR
       GROUP BY tenant_nombre
       ORDER BY acciones DESC
       LIMIT 10`
    );

    return res.json({
      success: true,
      data: {
        total_tenants  : total.n,
        activos        : activos.n,
        suspendidos    : suspendidos.n,
        por_plan       : porPlan,
        pools_activos  : poolStats.length,
        proximos_vencer: proximosVencer,
        backups_hoy    : ultimosBackups.length,
        wa_conectadas  : waConectadas.n,
        actividad_hoy  : actividadHoy,
      },
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /admin/api/tenants/:id/stats ─────────────────────────────
router.get('/tenants/:id/stats', async (req, res) => {
  try {
    const [tenant] = await masterQuery('SELECT * FROM tenants WHERE id=?', [req.params.id]);
    if (!tenant) return res.status(404).json({ success: false, message: 'No encontrado.' });

    const conn = await mysql.createConnection({
      host: tenant.db_host, port: tenant.db_port||3306,
      user: tenant.db_user, password: tenant.db_pass, database: tenant.db_name,
    });

    const [[{ propietarios }]]  = await conn.execute('SELECT COUNT(*) AS propietarios FROM propietarios');
    const [[{ mascotas }]]      = await conn.execute('SELECT COUNT(*) AS mascotas FROM mascotas');
    const [[{ citas_hoy }]]     = await conn.execute("SELECT COUNT(*) AS citas_hoy FROM citas WHERE DATE(fecha_hora)=CURDATE()");
    const [[{ facturas_mes }]]  = await conn.execute("SELECT COUNT(*) AS facturas_mes FROM facturas WHERE MONTH(fecha)=MONTH(CURDATE()) AND YEAR(fecha)=YEAR(CURDATE()) AND estado='pagado'");
    const [[{ ingresos_mes }]]  = await conn.execute("SELECT COALESCE(SUM(total),0) AS ingresos_mes FROM facturas WHERE MONTH(fecha)=MONTH(CURDATE()) AND YEAR(fecha)=YEAR(CURDATE()) AND estado='pagado'");
    const [[{ usuarios_total }]]= await conn.execute('SELECT COUNT(*) AS usuarios_total FROM usuarios WHERE activo=1');
    await conn.end();

    const io = req.app?.get('io');
    let usuarios_online = 0;
    if (io) {
      const sockets = await io.fetchSockets();
      usuarios_online = sockets.filter(s => s.data?.tenantId == req.params.id).length;
    }

    return res.json({
      success: true,
      data: {
        propietarios   : parseInt(propietarios),
        mascotas       : parseInt(mascotas),
        citas_hoy      : parseInt(citas_hoy),
        facturas_mes   : parseInt(facturas_mes),
        ingresos_mes   : parseFloat(ingresos_mes),
        usuarios_total : parseInt(usuarios_total),
        usuarios_online,
      }
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// ── GET /admin/api/tenants/consumo ────────────────────────────────
router.get('/tenants/consumo', async (req, res, next) => {
  try {
    const { tenant_id, mes, tipo, fuente } = req.query;
    if (!tenant_id) return res.status(422).json({ success: false, message: 'tenant_id requerido.' });

    let where  = 'WHERE tenant_id = ?';
    const vals = [tenant_id];
    if (mes)    { where += ' AND DATE_FORMAT(created_at, "%Y-%m") = ?'; vals.push(mes); }
    if (tipo)   { where += ' AND tipo = ?';   vals.push(tipo); }
    if (fuente) { where += ' AND fuente = ?'; vals.push(fuente); }

    const rows = await masterQuery(
      `SELECT id, tipo, fuente, numero, created_at
       FROM tenant_api_consumo ${where}
       ORDER BY created_at DESC LIMIT 200`, vals
    );
    const [totales] = await masterQuery(
      `SELECT COUNT(*) AS total, SUM(fuente='cache') AS cache, SUM(fuente='api') AS api
       FROM tenant_api_consumo ${where}`, vals
    );
    return res.json({ success: true, data: rows, totales });
  } catch (err) { next(err); }
});

// ── GET /admin/api/tenants/:id/integraciones ──────────────────────
router.get('/tenants/:id/integraciones', async (req, res, next) => {
  try {
    const [cfg] = await masterQuery(
      'SELECT integracion_reniec_activo, integracion_sunat_activo FROM tenant_config WHERE tenant_id = ?',
      [req.params.id]
    );
    return res.json({ success: true, data: cfg || {} });
  } catch (err) { next(err); }
});

// ── PUT /admin/api/tenants/:id/integraciones ──────────────────────
router.put('/tenants/:id/integraciones', async (req, res, next) => {
  try {
    const { integracion_reniec_activo, integracion_sunat_activo } = req.body;
    const sets = [];
    const vals = [];
    if (integracion_reniec_activo !== undefined) { sets.push('integracion_reniec_activo=?'); vals.push(integracion_reniec_activo ? 1 : 0); }
    if (integracion_sunat_activo  !== undefined) { sets.push('integracion_sunat_activo=?');  vals.push(integracion_sunat_activo  ? 1 : 0); }
    if (!sets.length) return res.status(422).json({ success: false, message: 'Nada que actualizar.' });
    vals.push(req.params.id);
    await masterQuery(`UPDATE tenant_config SET ${sets.join(',')} WHERE tenant_id = ?`, vals);
    return res.json({ success: true, message: 'Integración actualizada.' });
  } catch (err) { next(err); }
});

module.exports = router;