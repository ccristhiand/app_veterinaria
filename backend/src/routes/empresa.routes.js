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
    const [_ant] = await req.db.query('SELECT * FROM empresa_config LIMIT 1').catch(()=>[null]);
    if (_ant) auditLog(req, res, null, null, { anterior: _ant });
    const {
      nombre, razon_social, ruc, direccion, distrito, ciudad,
      telefono, email, web, logo_url,
      moneda, simbolo_moneda,
      igv_porcentaje, serie_boleta, serie_factura, pie_documento,
    } = req.body;

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

    const [updated] = await req.db.query('SELECT * FROM empresa_config LIMIT 1');
    return res.json({ success: true, data: updated, message: 'Configuración guardada.' });
  } catch (err) { next(err); }
});

module.exports = router;