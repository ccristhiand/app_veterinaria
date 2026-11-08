'use strict';

/**
 * Regla única de sedes de la API.
 *
 * authenticate deja en cada request:
 *   req.sede = { disponibles, permitidas, principal, activa, admin, headerInvalido }
 *
 *  · permitidas: ids de las sedes a las que entra el usuario (el admin, todas las activas).
 *  · activa:     la sede elegida en el selector (header X-Sede-Id). Con una sola sede
 *                permitida es esa. null = "Todas" (solo sirve para consultar).
 *
 * Consultar → filtroSede(req, 'alias.sede_id')
 * Registrar → sedeEscritura(req) · nunca deja un registro sin sede
 * Por ID    → exigirAcceso(req, fila.sede_id)
 */

const err = (status, code, message) => Object.assign(new Error(message), { status, code });

async function leerSedes(db, usuarioId) {
  try {
    return await db.query(
      `SELECT s.id, s.nombre, s.ciudad, s.es_principal, (us.usuario_id IS NOT NULL) AS asignada
       FROM sedes s
       LEFT JOIN usuario_sedes us ON us.sede_id = s.id AND us.usuario_id = ?
       WHERE s.activo = 1
       ORDER BY s.es_principal DESC, s.nombre ASC`,
      [usuarioId]
    );
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    // Clínica aún sin migración v22: solo cuenta usuarios.sede_id
    return db.query(
      `SELECT id, nombre, ciudad, es_principal, 0 AS asignada
       FROM sedes WHERE activo = 1 ORDER BY es_principal DESC, nombre ASC`
    );
  }
}

/** Calcula las sedes del usuario y la sede activa según el header X-Sede-Id. */
async function contextoSede(db, user, headerRaw) {
  const filas = await leerSedes(db, user.id);
  const admin = user.rol === 'admin';
  const disponibles = filas
    .filter(s => admin || s.asignada || s.id === user.sede_id)
    .map(s => ({ id: s.id, nombre: s.nombre, ciudad: s.ciudad || null, es_principal: !!s.es_principal }));
  const permitidas = disponibles.map(s => s.id);

  const principal = permitidas.includes(user.sede_id)
    ? user.sede_id
    : (disponibles.find(s => s.es_principal) || disponibles[0])?.id || null;

  const pedida = parseInt(headerRaw, 10) || null;
  const headerInvalido = !!pedida && !permitidas.includes(pedida);
  const activa = pedida && !headerInvalido
    ? pedida
    : (permitidas.length === 1 ? permitidas[0] : null);

  return { disponibles, permitidas, principal, activa, admin, headerInvalido };
}

/** Filtro SQL para consultas: { sql: 'AND col = ?', params: [...] } */
function filtroSede(req, col = 'sede_id') {
  const { activa, permitidas, admin } = req.sede;
  if (activa) return { sql: `AND ${col} = ?`, params: [activa] };
  if (admin)  return { sql: '', params: [] };
  if (!permitidas.length) return { sql: 'AND 1 = 0', params: [] };
  return { sql: `AND ${col} IN (${permitidas.map(() => '?').join(',')})`, params: [...permitidas] };
}

/** Filtro por una sede concreta (cuando ya se sabe cuál es). */
const filtroUnaSede = (sedeId, col = 'sede_id') => ({ sql: `AND ${col} = ?`, params: [sedeId] });

/** Sede donde se guarda un registro nuevo. Con "Todas" responde SEDE_REQUERIDA. */
function sedeEscritura(req) {
  if (req.sede.activa) return req.sede.activa;
  if (!req.sede.permitidas.length)
    throw err(403, 'SIN_SEDE', 'No tienes ninguna sede activa asignada. Contacta al administrador.');
  throw err(422, 'SEDE_REQUERIDA', 'Selecciona la sede en la que vas a registrar.');
}

/** Sede elegida en un formulario; si no viene ninguna, la sede activa. */
function sedeDestino(req, valor) {
  const pedida = parseInt(valor, 10) || null;
  if (!pedida) return sedeEscritura(req);
  if (!req.sede.permitidas.includes(pedida))
    throw err(403, 'SEDE_DENEGADA', 'No tienes acceso a esa sede.');
  return pedida;
}

const puedeAcceder = (req, sedeId) =>
  req.sede.admin || sedeId === null || sedeId === undefined || req.sede.permitidas.includes(sedeId);

/** Para rutas por ID: rechaza si el registro es de una sede ajena. */
function exigirAcceso(req, sedeId) {
  if (!puedeAcceder(req, sedeId)) throw err(403, 'SEDE_DENEGADA', 'Este registro pertenece a otra sede.');
}

module.exports = { contextoSede, filtroSede, filtroUnaSede, sedeEscritura, sedeDestino, puedeAcceder, exigirAcceso };
