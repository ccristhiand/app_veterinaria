'use strict';

/**
 * VetClinic SaaS — Generador de payload para Nubefact
 * Campos según documentación Nubefact v2.9
 */

const { decrypt } = require('./crypto.service');

// Tipos de comprobante
const TIPOS = { boleta: 2, factura: 1, nota_credito: 3, nota_debito: 4 };

// Tipo de documento de identidad
const TIPO_DOC = { DNI: 1, RUC: 6, CE: 4, pasaporte: 7 };

// Formatear fecha DD-MM-YYYY (formato Nubefact)
function formatFecha(fecha) {
  if (!fecha) return '';
  const d = new Date(fecha);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Genera el payload JSON para Nubefact — Boletas y Facturas
 */
function generarPayload(factura, items, cfg) {
  const esBoleta  = factura.tipo === 'boleta';
  const esFactura = factura.tipo === 'factura';

  // Parsear número: B001-00001 → serie=B001, numero=1
  const [serie, numeroStr] = factura.numero.split('-');
  const numero = parseInt(numeroStr, 10);

  // Datos del cliente
  let clienteTipoDoc, clienteNumDoc, clienteDenom, clienteDir;

  if (esFactura) {
    clienteTipoDoc = 6; // RUC
    clienteNumDoc  = factura.cliente_ruc;
    clienteDenom   = factura.cliente_razon_social;
    clienteDir     = factura.cliente_direccion_fiscal || '';
  } else {
    // Boleta
    if (factura.dni && factura.dni.length === 8) {
      clienteTipoDoc = 1; // DNI
      clienteNumDoc  = factura.dni;
      clienteDenom   = factura.propietario_nombre || 'CONSUMIDOR FINAL';
    } else {
      clienteTipoDoc = '-'; // Varios / consumidor final
      clienteNumDoc  = '-';
      clienteDenom   = factura.propietario_nombre || 'CONSUMIDOR FINAL';
    }
    clienteDir = factura.propietario_dir || '';
  }

  // Items
  const itemsPayload = items.map((item, idx) => {
    const cantidad    = parseFloat(item.cantidad)   || 1;
    const precioUnit  = parseFloat(item.precio_unit) || 0;
    const valorUnit   = parseFloat((precioUnit / 1.18).toFixed(10));
    const igvUnit     = parseFloat((precioUnit - valorUnit).toFixed(10));
    const subtotal    = parseFloat((valorUnit * cantidad).toFixed(2));
    const igvTotal    = parseFloat((igvUnit * cantidad).toFixed(2));
    const total       = parseFloat((precioUnit * cantidad).toFixed(2));

    return {
      unidad_de_medida     : 'ZZ',  // ZZ = servicio
      codigo               : String(item.inventario_id || (idx + 1)).padStart(4, '0'),
      descripcion          : item.descripcion,
      cantidad,
      valor_unitario       : valorUnit,
      precio_unitario      : precioUnit,
      descuento            : '',
      subtotal,
      tipo_de_igv          : 1,
      igv                  : igvTotal,
      total,
      anticipo_regularizacion: false,
      anticipo_documento_serie : '',
      anticipo_documento_numero: '',
    };
  });

  const totalSinIgv = parseFloat(factura.subtotal);
  const totalIgv    = parseFloat(factura.igv);
  const total       = parseFloat(factura.total);

  // Desencriptar credenciales
  const rutaDecrypted  = decrypt(cfg.ose_api_key);      // UUID de la ruta
  const tokenDecrypted = decrypt(cfg.sunat_usuario_sol); // Token de autenticación

  return {
    config: {
      ruta : rutaDecrypted,
      token: tokenDecrypted,
    },
    payload: {
      operacion              : 'generar_comprobante',
      tipo_de_comprobante    : TIPOS[factura.tipo] || 2,
      serie,
      numero,
      sunat_transaction      : 1,
      cliente_tipo_de_documento   : clienteTipoDoc,
      cliente_numero_de_documento : clienteNumDoc,
      cliente_denominacion        : clienteDenom,
      cliente_direccion           : clienteDir,
      cliente_email               : factura.propietario_email || '',
      fecha_de_emision            : formatFecha(factura.fecha),
      fecha_de_vencimiento        : '',
      moneda                      : 1, // 1 = Soles
      tipo_de_cambio              : '',
      porcentaje_de_igv           : 18.00,
      descuento_global            : '',
      total_descuento             : '',
      total_anticipo              : '',
      total_gravada               : totalSinIgv,
      total_inafecta              : '',
      total_exonerada             : '',
      total_igv                   : totalIgv,
      total_gratuita              : '',
      total_otros_cargos          : '',
      total,
      detraccion                  : false,
      observaciones               : factura.notas || '',
      enviar_automaticamente_a_la_sunat: true,
      enviar_automaticamente_al_cliente: false,
      medio_de_pago               : getMedioPago(factura.metodo_pago),
      cancelado                   : factura.estado === 'pagado',
      formato_de_pdf              : 'A4',
      items                       : itemsPayload,
    },
  };
}

/**
 * Genera payload para Nota de Crédito (anulación de factura)
 */
function generarPayloadNotaCredito(facturaOriginal, motivo, cfg, serieNota, numeroNota) {
  const [serieOrig, numOrig] = facturaOriginal.numero.split('-');
  const rutaDecrypted  = decrypt(cfg.ose_api_key);
  const tokenDecrypted = decrypt(cfg.sunat_usuario_sol);

  return {
    config: { ruta: rutaDecrypted, token: tokenDecrypted },
    payload: {
      operacion                      : 'generar_comprobante',
      tipo_de_comprobante            : 3, // Nota de crédito
      serie                          : serieNota,
      numero                         : numeroNota,
      sunat_transaction              : 1,
      documento_que_se_modifica_tipo : TIPOS[facturaOriginal.tipo] || 2,
      documento_que_se_modifica_serie: serieOrig,
      documento_que_se_modifica_numero: parseInt(numOrig, 10),
      tipo_de_nota_de_credito        : 1, // Anulación de la operación
      cliente_tipo_de_documento      : facturaOriginal.tipo === 'factura' ? 6 : '-',
      cliente_numero_de_documento    : facturaOriginal.tipo === 'factura' ? facturaOriginal.cliente_ruc : '-',
      cliente_denominacion           : facturaOriginal.tipo === 'factura' ? facturaOriginal.cliente_razon_social : (facturaOriginal.propietario_nombre || 'CONSUMIDOR FINAL'),
      cliente_direccion              : '',
      fecha_de_emision               : formatFecha(new Date()),
      moneda                         : 1,
      porcentaje_de_igv              : 18.00,
      total_gravada                  : parseFloat(facturaOriginal.subtotal),
      total_igv                      : parseFloat(facturaOriginal.igv),
      total                          : parseFloat(facturaOriginal.total),
      observaciones                  : motivo || 'ANULACION DE OPERACION',
      enviar_automaticamente_a_la_sunat: true,
      enviar_automaticamente_al_cliente: false,
      items: [{
        unidad_de_medida     : 'ZZ',
        codigo               : '0001',
        descripcion          : motivo || 'ANULACION DE OPERACION',
        cantidad             : 1,
        valor_unitario       : parseFloat(facturaOriginal.subtotal),
        precio_unitario      : parseFloat(facturaOriginal.total),
        descuento            : '',
        subtotal             : parseFloat(facturaOriginal.subtotal),
        tipo_de_igv          : 1,
        igv                  : parseFloat(facturaOriginal.igv),
        total                : parseFloat(facturaOriginal.total),
        anticipo_regularizacion: false,
        anticipo_documento_serie : '',
        anticipo_documento_numero: '',
      }],
    },
  };
}

/**
 * Genera payload para Comunicación de Baja (anulación de boleta)
 */
function generarPayloadBaja(facturaOriginal, motivo, cfg) {
  const [serie, numero] = facturaOriginal.numero.split('-');
  const rutaDecrypted  = decrypt(cfg.ose_api_key);
  const tokenDecrypted = decrypt(cfg.sunat_usuario_sol);

  return {
    config: { ruta: rutaDecrypted, token: tokenDecrypted },
    payload: {
      operacion          : 'generar_anulacion',
      tipo_de_comprobante: 2,
      serie,
      numero             : parseInt(numero, 10),
      motivo             : (motivo || 'ERROR EN EMISION').toUpperCase(),
    },
  };
}

function getMedioPago(metodo) {
  const map = {
    efectivo      : 'EFECTIVO',
    tarjeta       : 'TARJETA',
    transferencia : 'TRANSFERENCIA',
    yape          : 'YAPE',
    plin          : 'PLIN',
  };
  return map[metodo] || 'CONTADO';
}

module.exports = { generarPayload, generarPayloadNotaCredito, generarPayloadBaja, TIPOS };