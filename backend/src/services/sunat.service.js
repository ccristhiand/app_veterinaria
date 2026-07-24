'use strict';

/**
 * VetClinic SaaS — Generador de documentos SUNAT (Nubefact JSON)
 * Nubefact acepta JSON directamente — no necesitamos generar XML
 * Nubefact se encarga de generar y firmar el XML UBL 2.1
 */

const { decrypt } = require('./crypto.service');

// Tipo de comprobante Nubefact
const TIPOS = {
  boleta  : 2,
  factura : 1,
  nota_credito: 7,
  nota_debito : 8,
};

// Tipo de documento de identidad
const TIPO_DOC = {
  DNI    : 1,
  RUC    : 6,
  CE     : 4,
  pasaporte: 7,
};

/**
 * Genera el payload JSON para Nubefact
 * a partir de una factura de la BD
 */
function generarPayload(factura, items, config) {
  const esBoleta  = factura.tipo === 'boleta';
  const esFactura = factura.tipo === 'factura';

  // Parsear número: B001-00001 → serie=B001, numero=1
  const [serie, numeroStr] = factura.numero.split('-');
  const numero = parseInt(numeroStr, 10);

  // Datos del cliente
  let tipoDocCliente, numDocCliente, razonSocialCliente, direccionCliente;

  if (esFactura) {
    // Factura: requiere RUC del cliente
    tipoDocCliente    = 6; // RUC
    numDocCliente     = factura.cliente_ruc;
    razonSocialCliente= factura.cliente_razon_social;
    direccionCliente  = factura.cliente_direccion_fiscal || '';
  } else {
    // Boleta: DNI del cliente o consumidor final
    if (factura.dni && factura.dni.length === 8) {
      tipoDocCliente    = 1; // DNI
      numDocCliente     = factura.dni;
      razonSocialCliente= factura.propietario_nombre;
    } else {
      // Consumidor final (sin documento)
      tipoDocCliente    = 0;
      numDocCliente     = '00000000';
      razonSocialCliente= factura.propietario_nombre || 'CONSUMIDOR FINAL';
    }
    direccionCliente = factura.propietario_dir || '';
  }

  // Items del comprobante
  const lineas = items.map((item, idx) => {
    const cantidad   = parseFloat(item.cantidad)   || 1;
    const precioUnit = parseFloat(item.precio_unit) || 0;
    // Precio unitario sin IGV
    const precioSinIgv = parseFloat((precioUnit / 1.18).toFixed(10));
    const igvUnit      = parseFloat((precioUnit - precioSinIgv).toFixed(10));
    const subtotalSinIgv = parseFloat((precioSinIgv * cantidad).toFixed(2));
    const igvTotal       = parseFloat((igvUnit * cantidad).toFixed(2));

    return {
      unidad_de_medida      : 'NIU',  // Nubefact standard
      codigo                : String(item.inventario_id || (idx + 1)).padStart(4, '0'),
      descripcion           : item.descripcion,
      cantidad              : cantidad,
      valor_unitario        : precioSinIgv,
      precio_unitario       : precioUnit,
      descuento             : 0,
      subtotal              : subtotalSinIgv,
      tipo_de_igv           : 1,  // 1=gravado operación onerosa
      igv                   : igvTotal,
      total                 : parseFloat(item.subtotal || (precioUnit * cantidad)).toFixed(2),
      anticipo_regularizacion: false,
      anticipo_documento_serie: '',
      anticipo_documento_numero: 0,
    };
  });

  // Totales
  const totalSinIgv = parseFloat(factura.subtotal);
  const totalIgv    = parseFloat(factura.igv);
  const total       = parseFloat(factura.total);

  const payload = {
    operacion              : 'generar_comprobante',
    tipo_de_comprobante    : TIPOS[factura.tipo] || 2,
    serie,
    numero,
    sunat_transaction      : 1,
    client_id              : decrypt(config.ose_api_key),
    // Emisor
    ruc                    : config.ruc,
    razon_social           : config.razon_social,
    direccion              : config.direccion,
    ubigeo                 : config.ubigeo || '150101',
    email_emisor           : config.email || '',
    // Receptor
    tipo_de_documento_del_cliente: tipoDocCliente,
    numero_de_documento_del_cliente: numDocCliente,
    apellidos_y_nombres_o_razon_social: razonSocialCliente,
    direccion_del_cliente  : direccionCliente,
    email                  : factura.propietario_email || '',
    // Documento
    fecha_de_emision       : factura.fecha,
    moneda                 : 'PEN',
    porcentaje_de_igv      : 18.00,
    // Totales
    total_gravada          : totalSinIgv,
    total_igv              : totalIgv,
    total                  : total,
    // Forma de pago
    tipo_de_cambio         : '',
    medio_de_pago          : getMedioPago(factura.metodo_pago),
    // Items
    items                  : lineas,
    // Opcionales
    observaciones          : factura.notas || '',
    // Para modo beta
    ...(config.modo === 'beta' && {
      enviar_automaticamente_a_la_sunat: true,
      enviar_automaticamente_al_cliente : false,
    }),
  };

  return payload;
}

/**
 * Genera payload para Nota de Crédito
 */
function generarPayloadNotaCredito(facturaOriginal, motivo, config) {
  const [serieOrig, numOrig] = facturaOriginal.numero.split('-');
  const serieNota = config.fe_serie_nota_cred || 'BC01';

  return {
    operacion              : 'generar_comprobante',
    tipo_de_comprobante    : 7, // nota de crédito
    serie                  : serieNota,
    numero                 : 1, // el backend debe manejar el correlativo
    tipo_de_nota_de_credito: 1, // 1=anulación de la operación
    motivo_o_sustento_nc   : motivo || 'ANULACIÓN DE OPERACIÓN',
    // Referencia al comprobante original
    tipo_de_documento_de_referencia : TIPOS[facturaOriginal.tipo],
    serie_de_referencia    : serieOrig,
    numero_de_referencia   : parseInt(numOrig, 10),
    fecha_de_referencia    : facturaOriginal.fecha,
    // Mismos datos del comprobante original
    ruc                    : config.ruc,
    razon_social           : config.razon_social,
    direccion              : config.direccion,
    ubigeo                 : config.ubigeo || '150101',
    client_id              : decrypt(config.ose_api_key),
    tipo_de_documento_del_cliente: facturaOriginal.tipo === 'factura' ? 6 : 1,
    numero_de_documento_del_cliente: facturaOriginal.tipo === 'factura'
      ? facturaOriginal.cliente_ruc
      : (facturaOriginal.dni || '00000000'),
    apellidos_y_nombres_o_razon_social: facturaOriginal.tipo === 'factura'
      ? facturaOriginal.cliente_razon_social
      : facturaOriginal.propietario_nombre,
    fecha_de_emision       : new Date().toISOString().split('T')[0],
    moneda                 : 'PEN',
    porcentaje_de_igv      : 18.00,
    total_gravada          : parseFloat(facturaOriginal.subtotal),
    total_igv              : parseFloat(facturaOriginal.igv),
    total                  : parseFloat(facturaOriginal.total),
    items                  : [], // Nubefact no requiere items en NC de anulación total
  };
}

function getMedioPago(metodo) {
  const map = {
    efectivo      : 'Efectivo',
    tarjeta       : 'Tarjeta',
    transferencia : 'Transferencia',
    yape          : 'Yape',
    plin          : 'Plin',
  };
  return map[metodo] || 'Contado';
}

module.exports = { generarPayload, generarPayloadNotaCredito, TIPOS };