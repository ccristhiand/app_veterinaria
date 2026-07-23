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
    const subdominioFull = subdominio.includes('.') ? subdominio : `${subdominio}.netcodip.com`;

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
      modulo_consentimientos, modulo_carnet,
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
         modulo_vacunas=?, modulo_consentimientos=?, modulo_carnet=?
       WHERE tenant_id=?`,
      [
        nombre_clinica||'VetClinic', ruc||null, razon_social||null,
        telefono||null, email||null, direccion||null, web||null,
        logo_url||null, favicon_url||null,
        color_primario||'#10b981', color_sidebar||'#0d3b2e', color_acento||'#059669',
        max_usuarios||5, moneda||'PEN', simbolo_moneda||'S/.', igv_porcentaje||18,
        modulo_estetica?1:0, modulo_facturacion?1:0, modulo_inventario?1:0,
        modulo_vacunas?1:0, modulo_consentimientos?1:0, modulo_carnet?1:0,
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
    const [total]   = await masterQuery('SELECT COUNT(*) AS n FROM tenants');
    const [activos] = await masterQuery('SELECT COUNT(*) AS n FROM tenants WHERE activo=1');
    const porPlan   = await masterQuery('SELECT plan, COUNT(*) AS n FROM tenants GROUP BY plan');
    const poolStats = getPoolStats();
    return res.json({
      success: true,
      data: { total_tenants: total.n, activos: activos.n, por_plan: porPlan, pools_activos: poolStats.length },
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

module.exports = router;