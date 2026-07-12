'use strict';

require('dotenv').config();

const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { Server } = require('socket.io');

const logger                = require('./config/logger');
const { testMasterConnection } = require('./config/masterDB');
const { initSocket }        = require('./sockets');
const { resolveTenant }     = require('./middlewares/tenant.middleware');

// ── Rutas ────────────────────────────────────────────────────────
const authRoutes        = require('./routes/auth.routes');
const tenantRoutes      = require('./routes/tenant.routes');
const propietarioRoutes = require('./routes/propietarios.routes');
const mascotaRoutes     = require('./routes/mascotas.routes');
const citaRoutes        = require('./routes/citas.routes');
const historiaRoutes    = require('./routes/historia.routes');
const inventarioRoutes  = require('./routes/inventario.routes');
const notifRoutes       = require('./routes/notificaciones.routes');
const usuarioRoutes     = require('./routes/usuarios.routes');
const vacunaRoutes      = require('./routes/vacunas.routes');
const esteticaRoutes    = require('./routes/estetica.routes');
const empresaRoutes     = require('./routes/empresa.routes');
const facturasRoutes    = require('./routes/facturas.routes');
const serviciosRoutes   = require('./routes/servicios.routes');
const reportesRoutes    = require('./routes/reportes.routes');
const cajaRoutes           = require('./routes/caja.routes');
// const recordatoriosRoutes  = require('./routes/recordatorios.routes'); // Desactivado temporalmente
const carnetRoutes         = require('./routes/carnet.routes');
const consentimientosRoutes= require('./routes/consentimientos.routes');
const brandingRoutes       = require('./routes/branding.routes');
const { router: permisosAdminRoutes } = require('./routes/permisos.routes');
// Panel admin SaaS
const adminRoutes       = require('./routes/admin.routes');

const app    = express();
const server = http.createServer(app);

// ── CORS dinámico por tenant ──────────────────────────────────────
const corsOptions = {
  origin(origin, callback) {
    // Sin origen (Postman, curl, mobile apps) → permitir
    if (!origin) return callback(null, true);

    // DESARROLLO LOCAL — localhost, .test, .local
    if (origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        origin.includes('.test') ||
        origin.includes('.local')) {
      return callback(null, true);
    }

    // PRODUCCIÓN — cualquier subdominio del dominio base
    const base = process.env.BASE_DOMAIN || 'vetclinic.com';
    if (origin.endsWith(`.${base}`) || origin === `https://${base}`) {
      return callback(null, true);
    }

    callback(new Error('CORS no permitido'));
  },
  credentials: true,
};

// ── Socket.io ────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 20000, pingInterval: 10000,
});
app.set('io', io);
initSocket(io);

// ── Middlewares globales ─────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev', { stream: { write: msg => logger.http(msg.trim()) } }));
}

// Rate limit global
app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max     : parseInt(process.env.RATE_LIMIT_MAX       || '200',    10),
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Demasiadas peticiones.' },
  // Rate limit por tenant + IP
  keyGenerator: (req) => `${req.hostname}:${req.ip}`,
}));

// ── Healthcheck (sin tenant) ──────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', uptime: process.uptime(), version: '2.0.0' })
);

// ── Favicon dinámico por tenant ───────────────────────────────────
app.get('/favicon.ico', async (req, res) => {
  try {
    const { masterQuery } = require('./config/masterDB');
    const host = req.headers['x-forwarded-host'] || req.hostname || '';
    const [config] = await masterQuery(
      `SELECT tc.logo_url, tc.favicon_url
       FROM tenants t
       JOIN tenant_config tc ON tc.tenant_id = t.id
       WHERE t.subdominio = ? LIMIT 1`, [host]
    );
    const iconUrl = config?.favicon_url || config?.logo_url;
    if (iconUrl) return res.redirect(302, iconUrl);
    res.status(204).end();
  } catch { res.status(204).end(); }
});

// ── Panel admin SaaS (sin tenant middleware) ──────────────────────
app.use('/admin/api', adminRoutes);

// ── Resolver tenant para todas las rutas de la API ────────────────
// IMPORTANTE: resolveTenant debe ir ANTES de las rutas de la API
app.use('/api', resolveTenant);

const API = '/api/v1';
app.use(`${API}/auth`,           authRoutes);
app.use(`${API}/tenant`,         tenantRoutes);
app.use(`${API}/propietarios`,   propietarioRoutes);
app.use(`${API}/mascotas`,       mascotaRoutes);
app.use(`${API}/citas`,          citaRoutes);
app.use(`${API}/historia`,       historiaRoutes);
app.use(`${API}/inventario`,     inventarioRoutes);
app.use(`${API}/notificaciones`, notifRoutes);
app.use(`${API}/usuarios`,       usuarioRoutes);
app.use(`${API}/vacunas`,        vacunaRoutes);
app.use(`${API}/estetica`,       esteticaRoutes);
app.use(`${API}/empresa`,        empresaRoutes);
app.use(`${API}/facturas`,       facturasRoutes);
app.use(`${API}/servicios`,      serviciosRoutes);
app.use(`${API}/reportes`,       reportesRoutes);
app.use(`${API}/caja`,              cajaRoutes);
// app.use(`${API}/recordatorios`,  recordatoriosRoutes); // Desactivado temporalmente
app.use(`${API}/carnet`,            carnetRoutes);
app.use(`${API}/consentimientos`,   consentimientosRoutes);
app.use(`${API}/branding`,          brandingRoutes);
app.use('/admin/api/permisos',      permisosAdminRoutes);

// ── 404 ───────────────────────────────────────────────────────────
app.use((_req, res) =>
  res.status(404).json({ success: false, message: 'Ruta no encontrada.' })
);

// ── Error handler ─────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error(err);
  const status  = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Error interno del servidor.' : err.message;
  res.status(status).json({ success: false, message });
});

// ── Boot ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '4000', 10);

(async () => {
  try {
    await testMasterConnection();
    server.listen(PORT, () => {
      logger.info(`🚀 VetClinic SaaS en http://localhost:${PORT}`);
      logger.info(`🌐 Modo multitenant activo`);
    });
  } catch (err) {
    logger.error('Error al iniciar:', err);
    process.exit(1);
  }
})();

module.exports = { app, server, io };