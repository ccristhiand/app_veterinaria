'use strict';

/**
 * VetNetcodip — PDF Service (pagos-saas)
 * Genera comprobante de pago en PDF y lo sube a Azure Blob
 * Por ahora retorna null — implementar con pdfkit cuando se necesite
 */

async function generarComprobante(datos) {
  // TODO: implementar con pdfkit
  // Por ahora solo loga y retorna null (no bloquea la aprobación del pago)
  console.log('[PDF] Comprobante pendiente de generación:', datos.numero_comprobante);
  return null;
}

module.exports = { generarComprobante };