'use strict';

/**
 * VetClinic SaaS — Cliente Nubefact OSE
 * URL formato: https://api.nubefact.com/api/v1/{token}
 * El token va en la URL, no como header
 */

const https = require('https');

// Base URLs sin token — el token se agrega como parte del path
const NUBEFACT_BASE = {
  beta      : 'https://api.nubefact.com/api/v1',
  produccion: 'https://api.nubefact.com/api/v1',
};

/**
 * Hace una petición a Nubefact
 * URL final: https://api.nubefact.com/api/v1/{apiKey}
 */
function nubefactRequest(apiKey, modo, payload) {
  const base = NUBEFACT_BASE[modo] || NUBEFACT_BASE.beta;
  const url  = `${base}/${apiKey}`;
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path    : urlObj.pathname,
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, data: parsed });
          } else {
            resolve({
              success: false,
              codigo : parsed.errors?.[0]?.code || String(res.statusCode),
              mensaje: parsed.errors?.[0]?.message || parsed.message || 'Error desconocido',
              raw    : parsed,
            });
          }
        } catch {
          reject(new Error(`Respuesta inválida de Nubefact: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Timeout al conectar con Nubefact'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Emite un comprobante (boleta o factura)
 */
async function emitirComprobante(config, documento) {
  const payload = {
    operacion          : 'generar_comprobante',
    tipo_de_comprobante: documento.tipo_de_comprobante,
    serie              : documento.serie,
    numero             : documento.numero,
    sunat_transaction  : 1,
    ...documento,
  };
  // Quitar client_id del payload — ya va en la URL
  delete payload.client_id;

  return nubefactRequest(config.apiKey, config.modo, payload);
}

/**
 * Emite una Nota de Crédito
 */
async function emitirNotaCredito(config, nota) {
  return emitirComprobante(config, {
    ...nota,
    tipo_de_comprobante: 7,
  });
}

/**
 * Comunicación de Baja (anulación de boleta)
 */
async function comunicacionBaja(config, datos) {
  const payload = {
    operacion          : 'generar_comunicacion_de_baja',
    tipo_de_comprobante: datos.tipo_de_comprobante,
    serie              : datos.serie,
    numero             : datos.numero,
    motivo_baja        : datos.motivo || 'ERROR EN EMISION',
    fecha_de_generacion: datos.fecha,
  };
  return nubefactRequest(config.apiKey, config.modo, payload);
}

module.exports = { emitirComprobante, emitirNotaCredito, comunicacionBaja };