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

const router = Router();
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

// ── Usar adminAuth en todas las rutas siguientes ──────────────────
router.use(adminAuth);

// ── GET /admin/api/tenants — listar todos ─────────────────────────
router.get('/tenants', async (req, res) => {
  try {
    const tenants = await masterQuery(
      `SELECT t.*, tc.nombre_clinica, tc.logo_url, tc.color_primario,
              tc.modulo_facturacion, tc.modulo_estetica, tc.modulo_inventario
       FROM tenants t
       LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
       ORDER BY t.created_at DESC`
    );
    return res.json({ success: true, data: tenants });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /admin/api/tenants/:id — detalle ──────────────────────────
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
      slug, subdominio, nombre_clinica,
      db_host, db_user, db_pass,
      plan, color_primario, color_sidebar, color_acento,
      logo_url, moneda, simbolo_moneda, pais, zona_horaria,
      // Admin inicial de la clínica
      admin_nombre, admin_email, admin_password,
    } = req.body;

    if (!slug || !subdominio || !nombre_clinica) {
      return res.status(422).json({ success: false, message: 'slug, subdominio y nombre_clinica son obligatorios.' });
    }
    if (!admin_email || !admin_password) {
      return res.status(422).json({ success: false, message: 'Se requiere email y password del administrador inicial.' });
    }

    const dbName = `vet_${slug.replace(/-/g,'_')}`;

    // 1. Verificar que no existe
    const [existe] = await masterQuery('SELECT id FROM tenants WHERE slug = ? OR subdominio = ?', [slug, subdominio]);
    if (existe) return res.status(422).json({ success: false, message: 'El slug o subdominio ya existe.' });

    // 2. Crear la base de datos del tenant
    const tempConn = await mysql.createConnection({
      host: db_host || process.env.DB_HOST || 'localhost',
      user: db_user || process.env.DB_USER || 'root',
      password: db_pass || process.env.DB_PASS || '',
    });
    await tempConn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await tempConn.end();

    // 3. Ejecutar schema base
    const schemaPath = path.join(__dirname, '../../sql/tenant_schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      const tenantPool = await mysql.createPool({
        host: db_host || process.env.DB_HOST || 'localhost',
        user: db_user || process.env.DB_USER || 'root',
        password: db_pass || process.env.DB_PASS || '',
        database: dbName, multipleStatements: true,
      });
      await tenantPool.execute(schema);
      await tenantPool.end();
    }

    // 4. Registrar en tabla maestra
    const result = await masterQuery(
      `INSERT INTO tenants (slug, subdominio, db_name, db_host, db_user, db_pass, plan)
       VALUES (?,?,?,?,?,?,?)`,
      [slug, subdominio, dbName,
       db_host || process.env.DB_HOST || 'localhost',
       db_user || process.env.DB_USER || 'root',
       db_pass || process.env.DB_PASS || '',
       plan || 'basic']
    );
    const tenantId = result.insertId;

    // 5. Config inicial
    await masterQuery(
      `INSERT INTO tenant_config
         (tenant_id, nombre_clinica, logo_url, color_primario, color_sidebar, color_acento,
          moneda, simbolo_moneda, pais, zona_horaria)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [tenantId, nombre_clinica, logo_url||null,
       color_primario||'#10b981', color_sidebar||'#0d3b2e', color_acento||'#059669',
       moneda||'PEN', simbolo_moneda||'S/.', pais||'Peru', zona_horaria||'America/Lima']
    );

    // 6. Crear usuario admin inicial en la DB del tenant
    const tenantObj = {
      db_name: dbName,
      db_host: db_host || process.env.DB_HOST || 'localhost',
      db_user: db_user || process.env.DB_USER || 'root',
      db_pass: db_pass || process.env.DB_PASS || '',
    };
    const tenantDB  = createDBHelper(getPoolForTenant(tenantObj));
    const hashedPass = await bcrypt.hash(admin_password, 10);
    await tenantDB.query(
      "INSERT INTO usuarios (nombre, email, password, rol) VALUES (?,?,?,'admin')",
      [admin_nombre || 'Administrador', admin_email, hashedPass]
    );

    // 7. Config empresa inicial
    await tenantDB.query(
      "INSERT INTO empresa_config (nombre) VALUES (?)",
      [nombre_clinica]
    );

    logger.info(`✅ Tenant creado: ${slug} → ${dbName}`);

    return res.status(201).json({
      success: true,
      message: `Clínica "${nombre_clinica}" creada correctamente.`,
      data: { tenantId, dbName, subdominio },
    });
  } catch (err) {
    logger.error(`Error creando tenant: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /admin/api/tenants/:id — actualizar config ────────────────
router.put('/tenants/:id', async (req, res) => {
  try {
    const {
      nombre_clinica, logo_url, color_primario, color_sidebar, color_acento,
      plan, activo, trial_hasta, max_usuarios,
      modulo_estetica, modulo_facturacion, modulo_inventario, modulo_vacunas,
      modulo_consentimientos, modulo_carnet,
    } = req.body;

    await masterQuery(
      "UPDATE tenants SET plan=?, activo=?, trial_hasta=? WHERE id=?",
      [plan, activo?1:0, trial_hasta||null, req.params.id]
    );
    await masterQuery(
      `UPDATE tenant_config SET
         nombre_clinica=?, logo_url=?,
         color_primario=?, color_sidebar=?, color_acento=?,
         max_usuarios=?,
         modulo_estetica=?, modulo_facturacion=?, modulo_inventario=?,
         modulo_vacunas=?, modulo_consentimientos=?, modulo_carnet=?
       WHERE tenant_id=?`,
      [nombre_clinica, logo_url||null,
       color_primario, color_sidebar, color_acento,
       max_usuarios || 5,
       modulo_estetica?1:0, modulo_facturacion?1:0,
       modulo_inventario?1:0, modulo_vacunas?1:0,
       modulo_consentimientos?1:0, modulo_carnet?1:0,
       req.params.id]
    );

    // Sincronizar nombre en empresa_config del tenant
    // Esto actualiza el nombre que aparece en consentimientos, facturas y reportes
    try {
      const [t] = await masterQuery(
        'SELECT db_host, db_port, db_user, db_pass, db_name FROM tenants WHERE id=?',
        [req.params.id]
      );
      if (t) {
        const mysql     = require('mysql2/promise');
        const tenantConn = await mysql.createConnection({
          host    : t.db_host, port: t.db_port,
          user    : t.db_user, password: t.db_pass,
          database: t.db_name,
        });
        await tenantConn.execute(
          'UPDATE empresa_config SET nombre=? WHERE id=1',
          [nombre_clinica]
        );
        await tenantConn.end();
      }
    } catch(e) {
      // No crítico — el nombre del tenant_config es la fuente primaria
      console.warn('[admin] No se pudo sincronizar empresa_config:', e.message);
    }

    // Invalidar caché
    const [t2] = await masterQuery('SELECT subdominio FROM tenants WHERE id=?', [req.params.id]);
    if (t2) invalidateTenantCache(t2.subdominio);

    return res.json({ success: true, message: 'Clínica actualizada.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── PATCH /admin/api/tenants/:id/toggle — activar/suspender ───────
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

// ── GET /admin/api/stats — métricas globales ──────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [total]     = await masterQuery('SELECT COUNT(*) AS n FROM tenants');
    const [activos]   = await masterQuery('SELECT COUNT(*) AS n FROM tenants WHERE activo=1');
    const [porPlan]   = await masterQuery('SELECT plan, COUNT(*) AS n FROM tenants GROUP BY plan');
    const poolStats   = getPoolStats();

    // Contar registros de cada tenant
    const tenants = await masterQuery('SELECT id, slug, db_name, activo FROM tenants WHERE activo=1');
    const metrics = [];
    for (const t of tenants.slice(0, 10)) { // límite para no sobrecargar
      try {
        const db = createDBHelper(getPoolForTenant(t));
        const [citas]    = await db.query('SELECT COUNT(*) AS n FROM citas WHERE DATE(created_at)=CURDATE()');
        const [usuarios] = await db.query('SELECT COUNT(*) AS n FROM usuarios WHERE activo=1');
        metrics.push({ slug: t.slug, citas_hoy: citas.n, usuarios: usuarios.n });
      } catch { metrics.push({ slug: t.slug, citas_hoy: 0, usuarios: 0 }); }
    }

    return res.json({
      success: true,
      data: {
        total_tenants  : total.n,
        activos        : activos.n,
        por_plan       : porPlan,
        pools_activos  : poolStats.length,
        pools          : poolStats,
        metricas       : metrics,
      },
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;

// ── GET /admin/api/tenants/:id/stats ─────────────────────────────
router.get('/tenants/:id/stats', async (req, res) => {
  try {
    const [tenant] = await masterQuery(
      'SELECT * FROM tenants WHERE id=?', [req.params.id]
    );
    if (!tenant) return res.status(404).json({ success:false, message:'Tenant no encontrado.' });

    // Conectar a la BD del tenant
    const mysql   = require('mysql2/promise');
    const tenantConn = await mysql.createConnection({
      host    : tenant.db_host, port: tenant.db_port,
      user    : tenant.db_user, password: tenant.db_pass,
      database: tenant.db_name,
    });

    const [[{ propietarios }]] = await tenantConn.execute('SELECT COUNT(*) AS propietarios FROM propietarios');
    const [[{ mascotas }]]     = await tenantConn.execute('SELECT COUNT(*) AS mascotas FROM mascotas');
    const [[{ citas_hoy }]]    = await tenantConn.execute("SELECT COUNT(*) AS citas_hoy FROM citas WHERE DATE(fecha_hora)=CURDATE()");
    const [[{ facturas_mes }]] = await tenantConn.execute("SELECT COUNT(*) AS facturas_mes FROM facturas WHERE MONTH(fecha)=MONTH(CURDATE()) AND YEAR(fecha)=YEAR(CURDATE()) AND estado='pagado'");
    const [[{ ingresos_mes }]] = await tenantConn.execute("SELECT COALESCE(SUM(total),0) AS ingresos_mes FROM facturas WHERE MONTH(fecha)=MONTH(CURDATE()) AND YEAR(fecha)=YEAR(CURDATE()) AND estado='pagado'");
    const [[{ usuarios_total }]] = await tenantConn.execute('SELECT COUNT(*) AS usuarios_total FROM usuarios WHERE activo=1');

    await tenantConn.end();

    // Usuarios online (desde Socket.io en memoria)
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
  } catch(err) {
    res.status(500).json({ success:false, message:err.message });
  }
});