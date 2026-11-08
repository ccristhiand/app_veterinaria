'use strict';

/**
 * Emisión de eventos en tiempo real, siempre dentro de la clínica de la petición.
 * El servidor atiende a varias clínicas: un io.emit() llegaría a todas.
 */

const claveTenant = req => req.tenant?.subdominio || null;
const salaDe = (clave, sala) => `${clave}::${sala}`;

/** A todos los conectados de la clínica */
function emitirTenant(req, evento, data) {
  const io = req.app.get('io'), clave = claveTenant(req);
  if (io && clave) io.to(clave).emit(evento, data);
}

/** A una sala de rol dentro de la clínica (sala:admin, sala:veterinarios…) */
function emitirSala(req, sala, evento, data) {
  const io = req.app.get('io'), clave = claveTenant(req);
  if (io && clave) io.to(salaDe(clave, sala)).emit(evento, data);
}

module.exports = { emitirTenant, emitirSala, salaDe, claveTenant };
