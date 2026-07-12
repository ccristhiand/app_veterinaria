'use strict';

const { Router }   = require('express');
const bcrypt       = require('bcryptjs');
const { signTokens, authenticate } = require('../middlewares/auth.middleware');

const router = Router();

// POST /api/v1/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(422).json({ success: false, message: 'Email y password requeridos.' });
    }

    const [user] = await req.db.query(
      'SELECT * FROM usuarios WHERE email = ? AND activo = 1',
      [email]
    );
    if (!user) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
    }

    const { accessToken, refreshToken } = signTokens(user);

    return res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
      },
    });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(422).json({ success: false, message: 'refreshToken requerido.' });
    }

    const jwt     = require('jsonwebtoken');
    const SECRET  = process.env.JWT_REFRESH_SECRET || 'vetclinic-refresh-key';
    const decoded = jwt.verify(refreshToken, SECRET);

    const [user] = await req.db.query(
      'SELECT id, nombre, email, rol FROM usuarios WHERE id = ? AND activo = 1',
      [decoded.id]
    );
    if (!user) {
      return res.status(401).json({ success: false, message: 'Usuario no válido.' });
    }

    const tokens = signTokens(user);
    return res.json({ success: true, ...tokens });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token inválido o expirado.' });
    }
    next(err);
  }
});

// GET /api/v1/auth/me
router.get('/me', authenticate, async (req, res) => {
  return res.json({ success: true, data: req.user });
});

module.exports = router;