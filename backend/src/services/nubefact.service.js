'use strict';

/**
 * VetClinic SaaS — Cliente Nubefact OSE
 * URL: https://api.nubefact.com/api/v1/{ruta}
 * Auth: Header Authorization: {token}
 */

const https = require('https');

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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout Nubefact')); });
    req.write(body);
    req.end();
  });
}

async function emitirComprobante(config, payload) {
  return nubefactPost(config.ruta, config.token, payload);
}

async function anularComprobante(config, payload) {
  return nubefactPost(config.ruta, config.token, payload);
}

module.exports = { emitirComprobante, anularComprobante };