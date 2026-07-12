'use strict';

const jwt    = require('jsonwebtoken');
const logger = require('../config/logger');

const ACCESS_SECRET  = process.env.JWT_SECRET         || 'vetclinic-secret-key';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'vetclinic-refresh-key';

/**
 * Middleware de autenticación JWT.
 * Usa req.db (inyectado por tenant middleware) para verificar el usuario.
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Token requerido.' });
    }

    const token   = authHeader.slice(7);
    const decoded = jwt.verify(token, ACCESS_SECRET);

    // Verificar que el usuario existe en la DB del tenant
    const [user] = await req.db.query(
      'SELECT id, nombre, email, rol FROM usuarios WHERE id = ? AND activo = 1',
      [decoded.id]
    );

    if (!user) {
      return res.status(401).json({ success: false, message: 'Usuario no válido.' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expirado.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, message: 'Token inválido.' });
  }
}

/**
 * Middleware de autorización por rol.
 * Uso: authorize('admin', 'veterinario')
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'No autenticado.' });
    }
    if (!roles.includes(req.user.rol)) {
      return res.status(403).json({
        success: false,
        message: `Acceso denegado. Se requiere rol: ${roles.join(' o ')}.`,
      });
    }
    next();
  };
}

/**
 * Verificar token para Socket.io
 */
async function verifySocketToken(token) {
  if (!token) throw new Error('Token requerido');
  const decoded = jwt.verify(token, ACCESS_SECRET);
  return decoded;
}

function signTokens(user) {
  const payload = { id: user.id, rol: user.rol, nombre: user.nombre };
  return {
    accessToken : jwt.sign(payload, ACCESS_SECRET,  { expiresIn: '8h' }),
    refreshToken: jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' }),
  };
}

module.exports = { authenticate, authorize, verifySocketToken, signTokens };