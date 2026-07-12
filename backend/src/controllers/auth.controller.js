'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const { query }  = require('../config/database');
const logger     = require('../config/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────
function signAccess(userId) {
  return jwt.sign(
    { sub: userId, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: 'HS256' },
  );
}

function signRefresh(userId) {
  return jwt.sign(
    { sub: userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d', algorithm: 'HS256' },
  );
}

function formatUser(u) {
  return { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, avatar_url: u.avatar_url };
}

// ── Controladores ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/login
 * Body: { email, password }
 */
async function login(req, res, next) {
  try {
    // Validaciones express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    // 1 ─ Buscar usuario
    const [user] = await query(
      'SELECT id, nombre, email, password_hash, rol, activo, avatar_url FROM usuarios WHERE email = ?',
      [email.toLowerCase().trim()],
    );

    // Respuesta genérica (evita user enumeration)
    const invalidMsg = 'Credenciales inválidas.';

    if (!user || !user.activo) {
      return res.status(401).json({ success: false, message: invalidMsg });
    }

    // 2 ─ Verificar contraseña
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      logger.warn(`Login fallido para email: ${email}`);
      return res.status(401).json({ success: false, message: invalidMsg });
    }

    // 3 ─ Generar tokens
    const accessToken  = signAccess(user.id);
    const refreshToken = signRefresh(user.id);

    logger.info(`✅  Login exitoso | user=${user.email} | rol=${user.rol}`);

    return res.status(200).json({
      success      : true,
      accessToken,
      refreshToken,
      expiresIn    : process.env.JWT_EXPIRES_IN || '8h',
      user         : formatUser(user),
    });

  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/auth/refresh
 * Body: { refreshToken }
 */
async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'refreshToken requerido.' });
    }

    let payload;
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Refresh token inválido o expirado.' });
    }

    if (payload.type !== 'refresh') {
      return res.status(401).json({ success: false, message: 'Token incorrecto.' });
    }

    const [user] = await query(
      'SELECT id, activo FROM usuarios WHERE id = ?',
      [payload.sub],
    );

    if (!user || !user.activo) {
      return res.status(401).json({ success: false, message: 'Usuario no autorizado.' });
    }

    const newAccess  = signAccess(user.id);
    const newRefresh = signRefresh(user.id);

    return res.json({ success: true, accessToken: newAccess, refreshToken: newRefresh });

  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/auth/me  (ruta protegida)
 */
async function me(req, res, next) {
  try {
    const [user] = await query(
      'SELECT id, nombre, email, rol, avatar_url, created_at FROM usuarios WHERE id = ?',
      [req.user.id],
    );
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    return res.json({ success: true, data: formatUser(user) });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, refresh, me };
