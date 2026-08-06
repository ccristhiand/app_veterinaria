'use strict';

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.PAGOS_JWT_SECRET || 'pagos-secret-2026';

function authCliente(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'Token requerido.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tipo !== 'cliente')
      return res.status(403).json({ success: false, message: 'Acceso no autorizado.' });
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token inválido o expirado.' });
  }
}

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'Token requerido.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tipo !== 'admin')
      return res.status(403).json({ success: false, message: 'Acceso de admin requerido.' });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token inválido o expirado.' });
  }
}

module.exports = { authCliente, authAdmin };