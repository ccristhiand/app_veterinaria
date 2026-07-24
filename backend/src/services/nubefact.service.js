'use strict';

/**
 * VetClinic SaaS — Cliente Nubefact OSE
 * Documentación: https://www.nubefact.com/api-docs/
 */

const https = require('https');

// URLs de Nubefact
const NUBEFACT_URLS = {
  beta      : 'https://ose.nubefact.com/ose/api/v1',
  produccion: 'https://api.nubefact.com/api/v1',
};

/**
 * Emite un comprobante a Nubefact
 * @param {Object} config - { apiKey, modo, ruc }
 * @param {Object} documento - datos del comprobante
 */
async function emitirComprobante(config, documento) {
  const baseUrl = NUBEFACT_URLS[config.modo || 'beta'];
  const url     = `${baseUrl}/comprobante`;

  const payload = {
    operacion        : 'generar_comprobante',
    tipo_de_comprobante: documento.tipo_de_comprobante, // 1=factura, 2=boleta
    serie            : documento.serie,
    numero           : documento.numero,
    sunat_transaction: 1, // 1=venta
    client_id        : config.apiKey,
    ...documento,
  };

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path    : urlObj.pathname,
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization' : `Token token="${config.apiKey}"`,
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
              success : false,
              codigo  : parsed.errors?.[0]?.code || String(res.statusCode),
              mensaje : parsed.errors?.[0]?.message || parsed.message || 'Error desconocido',
              raw     : parsed,
            });
          }
        } catch {
          reject(new Error(`Respuesta inválida de Nubefact: ${data}`));
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
 * Emite una Nota de Crédito (anulación de factura)
 */
async function emitirNotaCredito(config, nota) {
  return emitirComprobante(config, {
    ...nota,
    tipo_de_comprobante: 7, // 7=nota de crédito
  });
}

/**
 * Envía Comunicación de Baja (anulación de boleta ya enviada)
 */
async function comunicacionBaja(config, datos) {
  const baseUrl = NUBEFACT_URLS[config.modo || 'beta'];
  const url     = `${baseUrl}/comunicacion_de_baja`;

  const payload = {
    operacion  : 'generar_comunicacion_de_baja',
    client_id  : config.apiKey,
    tipo_de_comprobante: datos.tipo_de_comprobante,
    serie      : datos.serie,
    numero     : datos.numero,
    motivo_baja: datos.motivo || 'ERROR EN EMISION',
    fecha_de_generacion: datos.fecha,
  };

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path    : urlObj.pathname,
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization' : `Token token="${config.apiKey}"`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(res.statusCode < 300
            ? { success: true, data: parsed }
            : { success: false, mensaje: parsed.message || 'Error', raw: parsed }
          );
        } catch { reject(new Error(`Respuesta inválida: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Consulta el estado de un comprobante en SUNAT
 */
async function consultarEstado(config, serie, numero, tipo) {
  const baseUrl = NUBEFACT_URLS[config.modo || 'beta'];
  const url     = `${baseUrl}/comprobante/${config.ruc}/${tipo}/${serie}/${numero}`;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path    : urlObj.pathname,
      method  : 'GET',
      headers : { 'Authorization': `Token token="${config.apiKey}"` },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ success: res.statusCode < 300, data: JSON.parse(data) }); }
        catch { reject(new Error(`Respuesta inválida: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

module.exports = { emitirComprobante, emitirNotaCredito, comunicacionBaja, consultarEstado };