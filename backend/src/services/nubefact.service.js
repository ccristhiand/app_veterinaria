'use strict';

/**
 * VetClinic SaaS — Cliente Nubefact OSE
 * Documentación v2.9 — https://www.nubefact.com
 * 
 * Autenticación:
 *   URL  (RUTA): https://api.nubefact.com/api/v1/{uuid-ruta}
 *   TOKEN: Header Authorization: {token}
 */

const https = require('https');

/**
 * Petición POST a Nubefact
 * @param {string} ruta  - UUID de la ruta (ej: 98fb674b-dc41-47b0-a29f-0f681b02c769)
 * @param {string} token - Token de autenticación
 * @param {object} payload - JSON a enviar
 */
function nubefactPost(ruta, token, payload) {
  const url  = `https://api.nubefact.com/api/v1/${ruta}`;
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
        'Authorization' : token,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve({ success: true, data: parsed });
          } else {
            resolve({
              success: false,
              codigo : parsed.codigo || String(res.statusCode),
              mensaje: parsed.errors || parsed.message || 'Error desconocido',
              raw    : parsed,
            });
          }
        } catch {
          reject(new Error(`Respuesta inválida de Nubefact: ${data.substring(0, 300)}`));
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
async function emitirComprobante(config, payload) {
  return nubefactPost(config.ruta, config.token, payload);
}

/**
 * Anula un comprobante (nota de crédito o comunicación de baja)
 */
async function anularComprobante(config, payload) {
  return nubefactPost(config.ruta, config.token, payload);
}

/**
 * Consulta el estado de un comprobante
 */
async function consultarComprobante(config, tipo, serie, numero) {
  return nubefactPost(config.ruta, config.token, {
    operacion          : 'consultar_comprobante',
    tipo_de_comprobante: tipo,
    serie,
    numero,
  });
}

module.exports = { emitirComprobante, anularComprobante, consultarComprobante };