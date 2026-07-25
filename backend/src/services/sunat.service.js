'use strict';

/**
 * VetClinic SaaS — Generador de payload para Nubefact
 * Campos según documentación Nubefact v2.9
 */

const { decrypt } = require('./crypto.service');

const TIPOS = { boleta: 2, factura: 1, nota_credito: 3, nota_debito: 4 };

function formatFecha(fecha) {
  if (!fecha) return '';
  const d  = new Date(fecha);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function getNubefactConfig(cfg) {
  if (!cfg.nubefact_ruta || !cfg.nubefact_token) {
    throw Object.assign(
      new Error('Credenciales Nubefact no configuradas. Configura la Ruta y el Token desde el panel admin.'),
      { status: 422 }
    );
  }
  return {
    ruta : decrypt(cfg.nubefact_ruta),
    token: decrypt(cfg.nubefact_token),
  };
}

function generarPayload(factura, items, cfg) {
  const [serie, numeroStr] = factura.numero.split('-');
  const numero = parseInt(numeroStr, 10);

  // Datos del cliente
  let clienteTipoDoc, clienteNumDoc, clienteDenom, clienteDir;
  if (factura.tipo === 'factura') {
    clienteTipoDoc = 6;
    clienteNumDoc  = factura.cliente_ruc;
    clienteDenom   = factura.cliente_razon_social;
    clienteDir     = factura.cliente_direccion_fiscal || '';
  } else {
    if (factura.dni && factura.dni.length === 8) {
      clienteTipoDoc = 1;
      clienteNumDoc  = factura.dni;
      clienteDenom   = factura.propietario_nombre || 'CONSUMIDOR FINAL';
    } else {
      clienteTipoDoc = '-';
      clienteNumDoc  = '-';
      clienteDenom   = factura.propietario_nombre || 'CONSUMIDOR FINAL';
    }
    clienteDir = '';
  }

  // Items
  const itemsPayload = items.map((item, idx) => {
    const cantidad   = parseFloat(item.cantidad)    || 1;
    const precioUnit = parseFloat(item.precio_unit) || 0;
    const valorUnit  = parseFloat((precioUnit / 1.18).toFixed(10));
    const igvUnit    = parseFloat((precioUnit - valorUnit).toFixed(10));
    const subtotal   = parseFloat((valorUnit * cantidad).toFixed(2));
    const igvTotal   = parseFloat((igvUnit * cantidad).toFixed(2));
    const total      = parseFloat((precioUnit * cantidad).toFixed(2));
    return {
      unidad_de_medida      : 'ZZ',
      codigo                : String(item.inventario_id || (idx + 1)).padStart(4, '0'),
      descripcion           : item.descripcion,
      cantidad,
      valor_unitario        : valorUnit,
      precio_unitario       : precioUnit,
      descuento             : '',
      subtotal,
      tipo_de_igv           : 1,
      igv                   : igvTotal,
      total,
      anticipo_regularizacion   : false,
      anticipo_documento_serie  : '',
      anticipo_documento_numero : '',
    };
  });

  return {
    config : getNubefactConfig(cfg),
    payload: {
      operacion                    : 'generar_comprobante',
      tipo_de_comprobante          : TIPOS[factura.tipo] || 2,
      serie,
      numero,
      sunat_transaction            : 1,
      cliente_tipo_de_documento    : clienteTipoDoc,
      cliente_numero_de_documento  : clienteNumDoc,
      cliente_denominacion         : clienteDenom,
      cliente_direccion            : clienteDir,
      cliente_email                : factura.propietario_email || '',
      fecha_de_emision             : formatFecha(factura.fecha),
      fecha_de_vencimiento         : '',
      moneda                       : 1,
      tipo_de_cambio               : '',
      porcentaje_de_igv            : 18.00,
      descuento_global             : '',
      total_descuento              : '',
      total_anticipo               : '',
      total_gravada                : parseFloat(factura.subtotal),
      total_inafecta               : '',
      total_exonerada              : '',
      total_igv                    : parseFloat(factura.igv),
      total_gratuita               : '',
      total_otros_cargos           : '',
      total                        : parseFloat(factura.total),
      detraccion                   : false,
      observaciones                : factura.notas || '',
      enviar_automaticamente_a_la_sunat: true,
      enviar_automaticamente_al_cliente: false,
      medio_de_pago                : getMedioPago(factura.metodo_pago),
      cancelado                    : factura.estado === 'pagado',
      formato_de_pdf               : 'A4',
      items                        : itemsPayload,
    },
  };
}

function generarPayloadNotaCredito(facturaOriginal, motivo, cfg, serieNota, numeroNota) {
  const [serieOrig, numOrig] = facturaOriginal.numero.split('-');
  return {
    config : getNubefactConfig(cfg),
    payload: {
      operacion                        : 'generar_comprobante',
      tipo_de_comprobante              : 3,
      serie                            : serieNota,
      numero                           : numeroNota,
      sunat_transaction                : 1,
      documento_que_se_modifica_tipo   : TIPOS[facturaOriginal.tipo] || 2,
      documento_que_se_modifica_serie  : serieOrig,
      documento_que_se_modifica_numero : parseInt(numOrig, 10),
      tipo_de_nota_de_credito          : 1,
      cliente_tipo_de_documento        : facturaOriginal.tipo === 'factura' ? 6 : '-',
      cliente_numero_de_documento      : facturaOriginal.tipo === 'factura' ? facturaOriginal.cliente_ruc : '-',
      cliente_denominacion             : facturaOriginal.tipo === 'factura' ? facturaOriginal.cliente_razon_social : (facturaOriginal.propietario_nombre || 'CONSUMIDOR FINAL'),
      cliente_direccion                : '',
      fecha_de_emision                 : formatFecha(new Date()),
      moneda                           : 1,
      porcentaje_de_igv                : 18.00,
      total_gravada                    : parseFloat(facturaOriginal.subtotal),
      total_igv                        : parseFloat(facturaOriginal.igv),
      total                            : parseFloat(facturaOriginal.total),
      observaciones                    : motivo || 'ANULACION DE OPERACION',
      enviar_automaticamente_a_la_sunat: true,
      enviar_automaticamente_al_cliente: false,
      items: [{
        unidad_de_medida      : 'ZZ',
        codigo                : '0001',
        descripcion           : motivo || 'ANULACION DE OPERACION',
        cantidad              : 1,
        valor_unitario        : parseFloat(facturaOriginal.subtotal),
        precio_unitario       : parseFloat(facturaOriginal.total),
        descuento             : '',
        subtotal              : parseFloat(facturaOriginal.subtotal),
        tipo_de_igv           : 1,
        igv                   : parseFloat(facturaOriginal.igv),
        total                 : parseFloat(facturaOriginal.total),
        anticipo_regularizacion   : false,
        anticipo_documento_serie  : '',
        anticipo_documento_numero : '',
      }],
    },
  };
}

function generarPayloadBaja(facturaOriginal, motivo, cfg) {
  const [serie, numero] = facturaOriginal.numero.split('-');
  return {
    config : getNubefactConfig(cfg),
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
  const map = { efectivo:'EFECTIVO', tarjeta:'TARJETA', transferencia:'TRANSFERENCIA', yape:'YAPE', plin:'PLIN' };
  return map[metodo] || 'CONTADO';
}

module.exports = { generarPayload, generarPayloadNotaCredito, generarPayloadBaja, TIPOS };