'use strict';

const { Router }  = require('express');
const bcrypt      = require('bcryptjs');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { masterQuery } = require('../config/masterDB');

const router = Router();
router.use(authenticate);


// ── GET /api/v1/usuarios/me — perfil del usuario autenticado ──────
router.get('/me', async (req, res, next) => {
  try {
    const [user] = await req.db.query(
      'SELECT id, nombre, email, rol, activo, must_change_password, last_password_change, created_at FROM usuarios WHERE id=?',
      [req.user.id]
    );
    return res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

// ── GET /api/v1/usuarios — listar usuarios de la clínica ──────────
router.get('/', async (req, res, next) => {
  try {
    const { rol, activo } = req.query;
    let sql = 'SELECT id, nombre, email, rol, activo, created_at FROM usuarios WHERE 1=1';
    const params = [];
    if (rol !== undefined)    { sql += ' AND rol = ?';    params.push(rol); }
    if (activo !== undefined) { sql += ' AND activo = ?'; params.push(activo === 'false' ? 0 : 1); }
    sql += ' ORDER BY nombre';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/v1/usuarios/limite — info de límite de usuarios ──────
router.get('/limite', async (req, res, next) => {
  try {
    // Contar usuarios activos
    const [conteo] = await req.db.query(
      'SELECT COUNT(*) AS total FROM usuarios WHERE activo = 1'
    );

    // Obtener límite del tenant desde vet_master
    const [config] = await masterQuery(
      'SELECT max_usuarios FROM tenant_config WHERE tenant_id = ?',
      [req.tenant.id]
    );

    const total      = conteo?.total || 0;
    const max        = config?.max_usuarios || 5;
    const disponible = Math.max(0, max - total);

    return res.json({
      success: true,
      data: {
        total_activos: total,
        max_usuarios : max,
        disponible,
        puede_crear  : disponible > 0,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/usuarios/:id ──────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [user] = await req.db.query(
      'SELECT id, nombre, email, rol, activo, created_at FROM usuarios WHERE id = ?',
      [req.params.id]
    );
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    return res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

// ── POST /api/v1/usuarios — crear (solo admin) ────────────────────
router.post('/', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, email, password, rol = 'recepcionista' } = req.body;

    if (!nombre?.trim()) return res.status(422).json({ success:false, message:'Nombre obligatorio.' });
    if (!email?.trim())  return res.status(422).json({ success:false, message:'Email obligatorio.' });
    if (!password)       return res.status(422).json({ success:false, message:'Password obligatorio.' });
    if (password.length < 8) return res.status(422).json({ success:false, message:'El password debe tener al menos 8 caracteres.' });

    const rolesValidos = ['admin','veterinario','recepcionista'];
    if (!rolesValidos.includes(rol)) return res.status(422).json({ success:false, message:'Rol inválido.' });

    // ── Verificar límite de usuarios ──────────────────────────────
    const [conteo] = await req.db.query(
      'SELECT COUNT(*) AS total FROM usuarios WHERE activo = 1'
    );
    const [config] = await masterQuery(
      'SELECT max_usuarios FROM tenant_config WHERE tenant_id = ?',
      [req.tenant.id]
    );
    const totalActivos = conteo?.total || 0;
    const maxUsuarios  = config?.max_usuarios || 5;

    if (totalActivos >= maxUsuarios) {
      return res.status(403).json({
        success: false,
        message: `Has alcanzado el límite de ${maxUsuarios} usuarios de tu plan. Contacta al administrador del sistema para ampliar tu plan.`,
        code   : 'USER_LIMIT_REACHED',
        data   : { total_activos: totalActivos, max_usuarios: maxUsuarios },
      });
    }

    // Verificar email duplicado
    const [existe] = await req.db.query('SELECT id FROM usuarios WHERE email = ?', [email.trim()]);
    if (existe) return res.status(422).json({ success:false, message:'Ya existe un usuario con ese email.' });

    const hash   = await bcrypt.hash(password, 10);
    const result = await req.db.query(
      'INSERT INTO usuarios (nombre, email, password, rol, activo, must_change_password) VALUES (?,?,?,?,1,1)',
      [nombre.trim(), email.trim().toLowerCase(), hash, rol]
    );

    return res.status(201).json({
      success: true,
      message: 'Usuario creado correctamente.',
      data   : { id: result.insertId },
    });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/usuarios/:id — editar (solo admin) ────────────────
router.put('/:id', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, email, rol, password } = req.body;

    if (!nombre?.trim()) return res.status(422).json({ success:false, message:'Nombre obligatorio.' });
    if (!email?.trim())  return res.status(422).json({ success:false, message:'Email obligatorio.' });

    const rolesValidos = ['admin','veterinario','recepcionista'];
    if (rol && !rolesValidos.includes(rol)) return res.status(422).json({ success:false, message:'Rol inválido.' });

    // Verificar email duplicado (excluyendo el propio)
    const [existe] = await req.db.query(
      'SELECT id FROM usuarios WHERE email = ? AND id != ?', [email.trim(), req.params.id]
    );
    if (existe) return res.status(422).json({ success:false, message:'Ya existe otro usuario con ese email.' });

    if (password) {
      if (password.length < 8) return res.status(422).json({ success:false, message:'El password debe tener al menos 8 caracteres.' });
      const hash = await bcrypt.hash(password, 10);
      await req.db.query(
        'UPDATE usuarios SET nombre=?, email=?, rol=?, password=? WHERE id=?',
        [nombre.trim(), email.trim().toLowerCase(), rol, hash, req.params.id]
      );
    } else {
      await req.db.query(
        'UPDATE usuarios SET nombre=?, email=?, rol=? WHERE id=?',
        [nombre.trim(), email.trim().toLowerCase(), rol, req.params.id]
      );
    }

    return res.json({ success:true, message:'Usuario actualizado.' });
  } catch (err) { next(err); }
});

// ── PATCH /api/v1/usuarios/:id/toggle — activar/desactivar ────────
router.patch('/:id/toggle', authorize('admin'), async (req, res, next) => {
  try {
    // No permitir desactivarse a sí mismo
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(422).json({ success:false, message:'No puedes desactivar tu propio usuario.' });
    }

    const [user] = await req.db.query('SELECT id, activo, nombre FROM usuarios WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ success:false, message:'Usuario no encontrado.' });

    // Si van a activar, verificar límite
    if (!user.activo) {
      const [conteo] = await req.db.query('SELECT COUNT(*) AS total FROM usuarios WHERE activo = 1');
      const [config] = await masterQuery('SELECT max_usuarios FROM tenant_config WHERE tenant_id = ?', [req.tenant.id]);
      if ((conteo?.total || 0) >= (config?.max_usuarios || 5)) {
        return res.status(403).json({
          success: false,
          message: `No puedes activar más usuarios. Has alcanzado el límite de tu plan.`,
          code   : 'USER_LIMIT_REACHED',
        });
      }
    }

    const nuevoEstado = user.activo ? 0 : 1;
    await req.db.query('UPDATE usuarios SET activo=? WHERE id=?', [nuevoEstado, req.params.id]);

    return res.json({
      success: true,
      message: nuevoEstado ? `${user.nombre} activado.` : `${user.nombre} desactivado.`,
      data   : { activo: nuevoEstado },
    });
  } catch (err) { next(err); }
});

module.exports = router;