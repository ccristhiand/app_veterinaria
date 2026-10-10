'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');


const router = Router();
router.use(authenticate);

// GET /api/v1/empresa
router.get('/', async (req, res, next) => {
  try {
    const [config] = await req.db.query('SELECT * FROM empresa_config LIMIT 1');
    return res.json({ success: true, data: config || {} });
  } catch (err) { next(err); }
});

// PUT /api/v1/empresa
router.put('/', authorize('admin'), auditMiddleware('configuracion:actualizado', 'configuracion'), async (req, res, next) => {
  try {
    const {
      nombre, razon_social, ruc, direccion, distrito, ciudad,
      telefono, email, web, logo_url,
      moneda, simbolo_moneda,
      igv_porcentaje, serie_boleta, serie_factura, pie_documento,
      // ── Proformas (opcionales) ──
      serie_proforma, proforma_validez_dias, proforma_condiciones,
    } = req.body;

    if (proforma_validez_dias !== undefined && proforma_validez_dias !== null && proforma_validez_dias !== '') {
      const v = parseInt(proforma_validez_dias);
      if (!v || v < 1 || v > 365)
        return res.status(422).json({ success: false, message: 'La validez de proformas debe estar entre 1 y 365 días.' });
    }
    if (serie_proforma !== undefined && !/^[A-Za-z0-9]{1,10}$/.test(String(serie_proforma).trim() || 'P001'))
      return res.status(422).json({ success: false, message: 'La serie de proformas solo admite letras y números (máx. 10).' });

    if (!nombre?.trim())
      return res.status(422).json({ success: false, message: 'El nombre es obligatorio.' });

    const [existing] = await req.db.query('SELECT id FROM empresa_config LIMIT 1');

    if (existing) {
      await req.db.query(
        `UPDATE empresa_config SET
           nombre=?, razon_social=?, ruc=?, direccion=?, distrito=?, ciudad=?,
           telefono=?, email=?, web=?, logo_url=?,
           moneda=?, simbolo_moneda=?,
           igv_porcentaje=?, serie_boleta=?, serie_factura=?, pie_documento=?
         WHERE id=?`,
        [
          nombre.trim(), razon_social?.trim()||null, ruc?.trim()||null,
          direccion?.trim()||null, distrito?.trim()||null, ciudad?.trim()||'Lima',
          telefono?.trim()||null, email?.trim()||null, web?.trim()||null,
          logo_url?.trim()||null,
          moneda?.trim()||'PEN', simbolo_moneda?.trim()||'S/.',
          parseFloat(igv_porcentaje)||18,
          serie_boleta?.trim()||'B001', serie_factura?.trim()||'F001',
          pie_documento?.trim()||null, existing.id,
        ]
      );
    } else {
      await req.db.query(
        `INSERT INTO empresa_config
           (nombre,razon_social,ruc,direccion,distrito,ciudad,telefono,email,web,
            logo_url,moneda,simbolo_moneda,igv_porcentaje,serie_boleta,serie_factura,pie_documento)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          nombre.trim(), razon_social?.trim()||null, ruc?.trim()||null,
          direccion?.trim()||null, distrito?.trim()||null, ciudad?.trim()||'Lima',
          telefono?.trim()||null, email?.trim()||null, web?.trim()||null,
          logo_url?.trim()||null,
          moneda?.trim()||'PEN', simbolo_moneda?.trim()||'S/.',
          parseFloat(igv_porcentaje)||18,
          serie_boleta?.trim()||'B001', serie_factura?.trim()||'F001',
          pie_documento?.trim()||null,
        ]
      );
    }

    // ── Configuración de proformas (solo si vino en el body) ──────
    // Va aparte para que la configuración general siga funcionando
    // aunque la clínica aún no tenga la migración de proformas.
    if (serie_proforma !== undefined || proforma_validez_dias !== undefined || proforma_condiciones !== undefined) {
      try {
        const [fila] = await req.db.query('SELECT id FROM empresa_config LIMIT 1');
        await req.db.query(
          `UPDATE empresa_config SET serie_proforma=?, proforma_validez_dias=?, proforma_condiciones=? WHERE id=?`,
          [
            (String(serie_proforma || '').trim() || 'P001').toUpperCase(),
            parseInt(proforma_validez_dias) || 30,
            String(proforma_condiciones || '').trim() || null,
            fila.id,
          ]
        );
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;   // columnas aún no creadas → se ignora
      }
    }

    const [updated] = await req.db.query('SELECT * FROM empresa_config LIMIT 1');
    return res.json({ success: true, data: updated, message: 'Configuración guardada.' });
  } catch (err) { next(err); }
});

module.exports = router;