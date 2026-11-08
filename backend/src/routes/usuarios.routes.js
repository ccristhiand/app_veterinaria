'use strict';

const { Router }  = require('express');
const bcrypt      = require('bcryptjs');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');

const { masterQuery } = require('../config/masterDB');

const router = Router();
router.use(authenticate);

// Valida las sedes de un usuario. sede_id = principal; sede_ids = todas las que puede usar.
// El admin entra a todas las sedes activas: las suyas son opcionales.
async function normalizarSedes(db, rol, sede_id, sede_ids) {
  const principal = parseInt(sede_id, 10) || null;
  const ids = [...new Set([...(Array.isArray(sede_ids) ? sede_ids : []), principal].map(n => parseInt(n, 10)).filter(Boolean))];

  if (!ids.length) {
    if (rol === 'admin') return { principal: null, ids: [] };
    throw Object.assign(new Error('Selecciona al menos una sede.'), { status: 422 });
  }
  const activas = await db.query(
    `SELECT id FROM sedes WHERE activo = 1 AND id IN (${ids.map(() => '?').join(',')})`, ids
  );
  if (activas.length !== ids.length)
    throw Object.assign(new Error('Alguna de las sedes seleccionadas no existe o está inactiva.'), { status: 422 });
  return { principal: principal || ids[0], ids };
}

async function guardarSedesUsuario(db, usuarioId, ids) {
  await db.withTransaction(async (conn) => {
    await conn.execute('DELETE FROM usuario_sedes WHERE usuario_id = ?', [usuarioId]);
    for (const id of ids) {
      await conn.execute('INSERT INTO usuario_sedes (usuario_id, sede_id) VALUES (?,?)', [usuarioId, id]);
    }
  });
}


// ── GET /api/v1/usuarios/me — perfil del usuario autenticado ──────
router.get('/me', async (req, res, next) => {
  try {
    // CAMBIO: incluir sede_id + nombre de sede en el perfil
    const [user] = await req.db.query(
      `SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.must_change_password,
              u.last_password_change, u.created_at, u.sede_id,
              s.nombre AS sede_nombre, s.ciudad AS sede_ciudad
       FROM usuarios u
       LEFT JOIN sedes s ON s.id = u.sede_id
       WHERE u.id = ?`,
      [req.user.id]
    );
    return res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

// ── GET /api/v1/usuarios — listar usuarios de la clínica ──────────
router.get('/', async (req, res, next) => {
  try {
    const { rol, activo } = req.query;
    const user    = req.user;

    // El admin gestiona todos los usuarios. Las listas por rol (veterinarios de una cita…)
    // se limitan a la sede activa; los demás roles solo ven usuarios de sus sedes.
    const sedesFiltro = user.rol === 'admin'
      ? (rol !== undefined && req.sede.activa ? [req.sede.activa] : null)
      : (req.sede.activa ? [req.sede.activa] : req.sede.permitidas);

    let sql = `SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.created_at,
                      u.sede_id, s.nombre AS sede_nombre,
                      (SELECT GROUP_CONCAT(s2.nombre ORDER BY s2.nombre SEPARATOR ', ')
                       FROM usuario_sedes us2 JOIN sedes s2 ON s2.id = us2.sede_id
                       WHERE us2.usuario_id = u.id) AS sedes_nombres
               FROM usuarios u
               LEFT JOIN sedes s ON s.id = u.sede_id
               WHERE 1=1`;
    const params = [];

    if (sedesFiltro) {
      if (!sedesFiltro.length) sql += ' AND 1 = 0';
      else {
        sql += ` AND EXISTS (SELECT 1 FROM usuario_sedes us WHERE us.usuario_id = u.id
                             AND us.sede_id IN (${sedesFiltro.map(() => '?').join(',')}))`;
        params.push(...sedesFiltro);
      }
    }
    if (rol !== undefined) {
      // Soporta ?rol=veterinario&rol2=veterinario_recepcionista&rol3=groomer (múltiples roles)
      const roles = [rol, req.query.rol2, req.query.rol3].filter(Boolean);
      sql += ` AND u.rol IN (${roles.map(() => '?').join(',')})`; params.push(...roles);
    }
    if (activo !== undefined) { sql += ' AND u.activo = ?';    params.push(activo === 'false' ? 0 : 1); }
    sql += ' ORDER BY u.nombre';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/v1/usuarios/limite — info de límite de usuarios ──────
router.get('/limite', async (req, res, next) => {
  try {
    const [conteo] = await req.db.query(
      'SELECT COUNT(*) AS total FROM usuarios WHERE activo = 1'
    );
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
    // CAMBIO: incluir sede en el detalle
    const [user] = await req.db.query(
      `SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.created_at,
              u.sede_id, s.nombre AS sede_nombre
       FROM usuarios u
       LEFT JOIN sedes s ON s.id = u.sede_id
       WHERE u.id = ?`,
      [req.params.id]
    );
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    const filas = await req.db.query('SELECT sede_id FROM usuario_sedes WHERE usuario_id = ?', [req.params.id]);
    user.sede_ids = filas.map(f => f.sede_id);
    return res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

// ── POST /api/v1/usuarios — crear (solo admin) ────────────────────
router.post('/', authorize('admin'), auditMiddleware('usuarios:creado', 'usuarios'), async (req, res, next) => {
  try {
    // CAMBIO: recibir sede_id
    const { nombre, email, password, rol = 'recepcionista', sede_id = null, sede_ids } = req.body;

    if (!nombre?.trim()) return res.status(422).json({ success:false, message:'Nombre obligatorio.' });
    if (!email?.trim())  return res.status(422).json({ success:false, message:'Email obligatorio.' });
    if (!password)       return res.status(422).json({ success:false, message:'Password obligatorio.' });
    if (password.length < 8) return res.status(422).json({ success:false, message:'El password debe tener al menos 8 caracteres.' });

    const rolesValidos = ['admin','veterinario','recepcionista','veterinario_recepcionista','groomer'];
    if (!rolesValidos.includes(rol)) return res.status(422).json({ success:false, message:'Rol inválido.' });

    const sedes = await normalizarSedes(req.db, rol, sede_id, sede_ids);

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
    // CAMBIO: insertar sede_id
    const result = await req.db.query(
      'INSERT INTO usuarios (nombre, email, password, rol, sede_id, activo, must_change_password) VALUES (?,?,?,?,?,1,1)',
      [nombre.trim(), email.trim().toLowerCase(), hash, rol, sedes.principal]
    );
    await guardarSedesUsuario(req.db, result.insertId, sedes.ids);

    const [nuevoUsuario] = await req.db.query(
      `SELECT id, nombre, email, rol, sede_id, activo, must_change_password, created_at
       FROM usuarios WHERE id = ?`, [result.insertId]
    );

    return res.status(201).json({
      success: true,
      message: 'Usuario creado correctamente.',
      data   : nuevoUsuario,
    });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/usuarios/:id — editar (solo admin) ────────────────
router.put('/:id', authorize('admin'), auditMiddleware('usuarios:actualizado', 'usuarios'), async (req, res, next) => {
  try {
    // CAMBIO: recibir sede_id
    const { nombre, email, rol, password, sede_id = null, sede_ids } = req.body;

    if (!nombre?.trim()) return res.status(422).json({ success:false, message:'Nombre obligatorio.' });
    if (!email?.trim())  return res.status(422).json({ success:false, message:'Email obligatorio.' });

    const rolesValidos = ['admin','veterinario','recepcionista','veterinario_recepcionista','groomer'];
    if (rol && !rolesValidos.includes(rol)) return res.status(422).json({ success:false, message:'Rol inválido.' });

    const sedes = await normalizarSedes(req.db, rol, sede_id, sede_ids);

    // Verificar email duplicado (excluyendo el propio)
    const [existe] = await req.db.query(
      'SELECT id FROM usuarios WHERE email = ? AND id != ?', [email.trim(), req.params.id]
    );
    if (existe) return res.status(422).json({ success:false, message:'Ya existe otro usuario con ese email.' });

    if (password) {
      if (password.length < 8) return res.status(422).json({ success:false, message:'El password debe tener al menos 8 caracteres.' });
      const hash = await bcrypt.hash(password, 10);
      // CAMBIO: actualizar sede_id
      await req.db.query(
        'UPDATE usuarios SET nombre=?, email=?, rol=?, sede_id=?, password=? WHERE id=?',
        [nombre.trim(), email.trim().toLowerCase(), rol, sedes.principal, hash, req.params.id]
      );
    } else {
      // CAMBIO: actualizar sede_id
      await req.db.query(
        'UPDATE usuarios SET nombre=?, email=?, rol=?, sede_id=? WHERE id=?',
        [nombre.trim(), email.trim().toLowerCase(), rol, sedes.principal, req.params.id]
      );
    }
    await guardarSedesUsuario(req.db, req.params.id, sedes.ids);

    return res.json({ success:true, message:'Usuario actualizado.' });
  } catch (err) { next(err); }
});

// ── PATCH /api/v1/usuarios/:id/toggle — activar/desactivar ────────
router.patch('/:id/toggle', authorize('admin'), auditMiddleware('usuarios:toggle', 'usuarios'), async (req, res, next) => {
  try {
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(422).json({ success:false, message:'No puedes desactivar tu propio usuario.' });
    }

    const [user] = await req.db.query('SELECT id, activo, nombre FROM usuarios WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ success:false, message:'Usuario no encontrado.' });

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