'use strict';

/**
 * VetNetcodip SaaS — Sistema de Pagos
 * Puerto: 3030
 * Subdominio: pagos.netcodip.com
 */

const express   = require('express');
const cors      = require('cors');
const morgan    = require('morgan');
const path      = require('path');
const rateLimit = require('express-rate-limit');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const authRoutes   = require('./routes/auth.routes');
const cobrosRoutes = require('./routes/cobros.routes');
const adminRoutes  = require('./routes/admin.routes');
const cronService  = require('./services/cron.service');

const app  = express();
const PORT = process.env.PAGOS_PORT || 3030;

// ── Middlewares ───────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(morgan('combined'));

// Rate limiting
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use('/api',      rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// Static files
app.use(express.static(path.join(__dirname, '../../public')));

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',   authRoutes);
app.use('/api/cobros', cobrosRoutes);
app.use('/api/admin',  adminRoutes);

// ── Frontend — SPA fallback ───────────────────────────────────
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/admin/index.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Pagos Error]', err.message);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Error interno' });
});

// ── Iniciar ───────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[Pagos] ✅ Puerto ${PORT}`);
  await cronService.iniciar();
});

process.on('uncaughtException',  e => console.error('[Pagos uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[Pagos unhandled]', e?.message));