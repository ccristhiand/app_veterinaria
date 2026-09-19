'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');

const router = Router();
router.use(authenticate);

// ── GET /api/v1/propietarios ──────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { search = '', page = 1, limit = 20 } = req.query;
    const limitN  = Math.min(parseInt(limit) || 20, 100);
    const offsetN = (Math.max(parseInt(page) || 1, 1) - 1) * limitN;
    const q = `%${search}%`;

    const rows = await req.db.query(
      `SELECT p.*, COUNT(m.id) AS total_mascotas
       FROM propietarios p
       LEFT JOIN mascotas m ON m.propietario_id = p.id
       WHERE p.nombre LIKE ? OR p.apellido LIKE ?
          OR p.dni LIKE ? OR p.telefono LIKE ?
          OR p.ruc LIKE ? OR p.razon_social LIKE ?
       GROUP BY p.id
       ORDER BY p.nombre, p.apellido
       LIMIT ${limitN} OFFSET ${offsetN}`,
      [q, q, q, q, q, q]
    );

    const [{ total }] = await req.db.query(
      `SELECT COUNT(*) AS total FROM propietarios
       WHERE nombre LIKE ? OR apellido LIKE ?
          OR dni LIKE ? OR telefono LIKE ?
          OR ruc LIKE ? OR razon_social LIKE ?`,
      [q, q, q, q, q, q]
    );

    return res.json({ success: true, data: rows, total, page: parseInt(page), limit: limitN });
  } catch (err) { next(err); }
});

// ── GET /api/v1/propietarios/buscar-documento ─────────────────────
router.get('/buscar-documento', async (req, res, next) => {
  try {
    const { tipo, numero } = req.query;
    if (!tipo || !numero)
      return res.status(422).json({ success: false, message: 'tipo y numero requeridos.' });

    let prop = null;
    if (tipo === 'DNI') {
      [prop] = await req.db.query(
        'SELECT id, nombre, apellido, dni, telefono, email, direccion FROM propietarios WHERE dni = ?',
        [numero.trim()]
      );
    } else if (tipo === 'RUC') {
      [prop] = await req.db.query(
        'SELECT id, nombre, apellido, ruc, razon_social, direccion_fiscal FROM propietarios WHERE ruc = ?',
        [numero.trim()]
      );
    }

    if (prop) {
      return res.json({
        success : true,
        existe  : true,
        data    : prop,
        message : 'Propietario ya registrado en el sistema.',
      });
    }

    return res.json({ success: true, existe: false });
  } catch (err) { next(err); }
});

// ── GET /api/v1/propietarios/:id ──────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [prop] = await req.db.query('SELECT * FROM propietarios WHERE id = ?', [req.params.id]);
    if (!prop) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    const mascotas = await req.db.query(
      'SELECT id, nombre, especie, raza, sexo, peso_kg, alertas_medicas, fecha_nacimiento, microchip FROM mascotas WHERE propietario_id = ? ORDER BY nombre',
      [req.params.id]
    );
    return res.json({ success: true, data: { ...prop, mascotas } });
  } catch (err) { next(err); }
});

// ── POST /api/v1/propietarios ─────────────────────────────────────
router.post('/', auditMiddleware('propietarios:creado', 'propietarios'), async (req, res, next) => {
  try {
    const { nombre, apellido, tipo_documento = 'DNI', dni, telefono, email,
            direccion, ruc, razon_social, direccion_fiscal } = req.body;

    if (!nombre?.trim() || !apellido?.trim())
      return res.status(422).json({ success: false, message: 'Nombre y apellido son obligatorios.' });

    if (ruc && !/^\d{11}$/.test(ruc.trim()))
      return res.status(422).json({ success: false, message: 'El RUC debe tener 11 dígitos.' });

    if (dni && !/^\d{8}$/.test(dni.trim()))
      return res.status(422).json({ success: false, message: 'El DNI debe tener 8 dígitos.' });

    if (dni?.trim()) {
      const [dup] = await req.db.query('SELECT id FROM propietarios WHERE dni = ?', [dni.trim()]);
      if (dup) return res.status(409).json({
        success: false,
        message: 'Ya existe un propietario con ese DNI.',
        code   : 'DNI_DUPLICADO',
        data   : { id: dup.id },
      });
    }

    if (ruc?.trim()) {
      const [dup] = await req.db.query('SELECT id FROM propietarios WHERE ruc = ?', [ruc.trim()]);
      if (dup) return res.status(409).json({
        success: false,
        message: 'Ya existe un propietario con ese RUC.',
        code   : 'RUC_DUPLICADO',
        data   : { id: dup.id },
      });
    }

    const result = await req.db.query(
      `INSERT INTO propietarios
         (tipo_documento, nombre, apellido, dni, telefono, email,
          direccion, ruc, razon_social, direccion_fiscal)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [tipo_documento, nombre.trim(), apellido.trim(), dni?.trim()||null,
       telefono?.trim()||null, email?.trim()||null, direccion?.trim()||null,
       ruc?.trim()||null, razon_social?.trim()||null, direccion_fiscal?.trim()||null]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/propietarios/:id ──────────────────────────────────
router.put('/:id', auditMiddleware('propietarios:actualizado', 'propietarios'), async (req, res, next) => {
  try {
    const { nombre, apellido, tipo_documento = 'DNI', dni, telefono, email,
            direccion, ruc, razon_social, direccion_fiscal } = req.body;

    if (!nombre?.trim() || !apellido?.trim())
      return res.status(422).json({ success: false, message: 'Nombre y apellido son obligatorios.' });

    if (ruc && !/^\d{11}$/.test(ruc.trim()))
      return res.status(422).json({ success: false, message: 'El RUC debe tener 11 dígitos.' });

    await req.db.query(
      `UPDATE propietarios SET tipo_documento=?, nombre=?, apellido=?, dni=?,
       telefono=?, email=?, direccion=?, ruc=?, razon_social=?, direccion_fiscal=?
       WHERE id=?`,
      [tipo_documento, nombre.trim(), apellido.trim(), dni?.trim()||null,
       telefono?.trim()||null, email?.trim()||null, direccion?.trim()||null,
       ruc?.trim()||null, razon_social?.trim()||null, direccion_fiscal?.trim()||null,
       req.params.id]
    );
    return res.json({ success: true, message: 'Propietario actualizado.' });
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/propietarios/:id ──────────────────────────────
router.delete('/:id', auditMiddleware('propietarios:eliminado', 'propietarios'), async (req, res, next) => {
  try {
    const [prop] = await req.db.query('SELECT id, nombre, apellido FROM propietarios WHERE id = ?', [req.params.id]);
    if (!prop) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    // Validar que no tenga mascotas registradas
    const [{ total_mascotas }] = await req.db.query(
      'SELECT COUNT(*) AS total_mascotas FROM mascotas WHERE propietario_id = ?',
      [req.params.id]
    );

    if (total_mascotas > 0) {
      return res.status(409).json({
        success : false,
        code    : 'TIENE_MASCOTAS',
        message : `No se puede eliminar a ${prop.nombre} ${prop.apellido} porque tiene ${total_mascotas} mascota${total_mascotas > 1 ? 's' : ''} registrada${total_mascotas > 1 ? 's' : ''}. Elimina primero sus mascotas.`,
        total_mascotas,
      });
    }

    await req.db.query('DELETE FROM propietarios WHERE id = ?', [req.params.id]);
    return res.json({ success: true, message: 'Propietario eliminado correctamente.' });
  } catch (err) { next(err); }
});

// ── GET /api/v1/propietarios/:id/informe/pdf ──────────────────────
router.get('/:id/informe/pdf', async (req, res, next) => {
  try {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ','');
    const jwt   = require('jsonwebtoken');
    try { req.user = jwt.verify(token || '', process.env.JWT_SECRET); } catch {}

    const [p] = await req.db.query('SELECT * FROM propietarios WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    const mascotas = await req.db.query(
      'SELECT * FROM mascotas WHERE propietario_id = ? ORDER BY nombre', [req.params.id]
    );

    const [empresa] = await req.db.query('SELECT * FROM empresa_config LIMIT 1');

    // Cargar historia, vacunas y desparasitaciones por mascota
    for (const m of mascotas) {
      m.historia = await req.db.query(
        `SELECT h.*, u.nombre AS veterinario_nombre
         FROM historia_clinica h
         JOIN usuarios u ON u.id = h.veterinario_id
         WHERE h.mascota_id = ? ORDER BY h.fecha DESC`, [m.id]
      );
      for (const h of m.historia) {
        h.recetas      = await req.db.query('SELECT * FROM recetas WHERE historia_clinica_id = ?', [h.id]);
        h.seguimientos = await req.db.query(
          `SELECT s.*, u.nombre AS veterinario_nombre
           FROM historia_seguimientos s JOIN usuarios u ON u.id = s.veterinario_id
           WHERE s.historia_id = ? ORDER BY s.fecha ASC`, [h.id]
        );
      }
      m.vacunas = await req.db.query(
        `SELECT v.*, u.nombre AS veterinario_nombre FROM vacunas v
         JOIN usuarios u ON u.id = v.veterinario_id
         WHERE v.mascota_id = ? ORDER BY v.fecha_aplicacion DESC`, [m.id]
      );
      m.desparasitaciones = await req.db.query(
        `SELECT d.*, u.nombre AS veterinario_nombre FROM desparasitaciones d
         JOIN usuarios u ON u.id = d.veterinario_id
         WHERE d.mascota_id = ? ORDER BY d.fecha_aplicacion DESC`, [m.id]
      );
    }

    const fDate = (d) => d ? new Date(d).toLocaleDateString('es-PE', { day:'2-digit', month:'long', year:'numeric' }) : '—';
    const esc   = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const emojiEspecie = (e) => ({ perro:'🐕', gato:'🐈', ave:'🦜', reptil:'🦎', roedor:'🐹' }[e] || '🐾');

    const mascotasHtml = mascotas.map(m => {
      const edadMs   = m.fecha_nacimiento ? Date.now() - new Date(m.fecha_nacimiento) : null;
      const edadAnios = edadMs ? Math.floor(edadMs/(1000*60*60*24*365)) : null;
      const edad     = edadAnios !== null ? (edadAnios < 1 ? 'Menos de 1 año' : edadAnios + ' año' + (edadAnios>1?'s':'')) : '—';

      const consultasHtml = m.historia.length ? m.historia.map(h => `
        <div style="margin-bottom:.75rem;padding:.75rem;background:#f8faf8;border-radius:8px;border-left:3px solid #10b981">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.4rem">
            <strong style="font-size:12px;color:#1f2937">${esc(h.motivo)}</strong>
            <span style="font-size:10px;color:#6b7280">${fDate(h.fecha)} · Dr/a. ${esc(h.veterinario_nombre)}</span>
          </div>
          ${h.diagnostico ? `<p style="font-size:11px;margin:.2rem 0"><span style="font-weight:600;color:#059669">Diagnóstico:</span> ${esc(h.diagnostico)}</p>` : ''}
          ${h.tratamiento ? `<p style="font-size:11px;margin:.2rem 0"><span style="font-weight:600">Tratamiento:</span> ${esc(h.tratamiento)}</p>` : ''}
          ${h.pruebas_complementarias ? `<p style="font-size:11px;margin:.2rem 0;color:#1d4ed8"><span style="font-weight:600">Pruebas:</span> ${esc(h.pruebas_complementarias)}</p>` : ''}
          ${h.recetas.length ? `<p style="font-size:10px;margin:.3rem 0 0;color:#7c3aed">💊 ${h.recetas.map(r=>esc(r.medicamento)).join(', ')}</p>` : ''}
          ${h.seguimientos.length ? `<p style="font-size:10px;margin:.2rem 0;color:#b45309">🔄 ${h.seguimientos.length} seguimiento${h.seguimientos.length>1?'s':''}</p>` : ''}
        </div>`).join('') : '<p style="font-size:11px;color:#9ca3af;margin:.5rem 0">Sin consultas registradas.</p>';

      const vacunasHtml = m.vacunas.length ? `
        <table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:.4rem">
          <tr style="background:#e0f2fe">
            <th style="padding:4px 6px;text-align:left">Vacuna</th>
            <th style="padding:4px 6px;text-align:left">Fecha</th>
            <th style="padding:4px 6px;text-align:left">Próxima dosis</th>
            <th style="padding:4px 6px;text-align:left">Veterinario</th>
          </tr>
          ${m.vacunas.map((v,i)=>`
            <tr style="background:${i%2===0?'#f0f9ff':'#fff'}">
              <td style="padding:4px 6px">${esc(v.nombre)}</td>
              <td style="padding:4px 6px">${fDate(v.fecha_aplicacion)}</td>
              <td style="padding:4px 6px">${fDate(v.proxima_dosis)}</td>
              <td style="padding:4px 6px">${esc(v.veterinario_nombre)}</td>
            </tr>`).join('')}
        </table>` : '<p style="font-size:11px;color:#9ca3af">Sin vacunas registradas.</p>';

      const desparasHtml = m.desparasitaciones.length ? `
        <table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:.4rem">
          <tr style="background:#ede9fe">
            <th style="padding:4px 6px;text-align:left">Producto</th>
            <th style="padding:4px 6px;text-align:left">Tipo</th>
            <th style="padding:4px 6px;text-align:left">Fecha</th>
            <th style="padding:4px 6px;text-align:left">Próxima</th>
          </tr>
          ${m.desparasitaciones.map((d,i)=>`
            <tr style="background:${i%2===0?'#f5f3ff':'#fff'}">
              <td style="padding:4px 6px">${esc(d.producto)}</td>
              <td style="padding:4px 6px">${esc(d.tipo)}</td>
              <td style="padding:4px 6px">${fDate(d.fecha_aplicacion)}</td>
              <td style="padding:4px 6px">${fDate(d.proxima_dosis)}</td>
            </tr>`).join('')}
        </table>` : '<p style="font-size:11px;color:#9ca3af">Sin desparasitaciones registradas.</p>';

      return `
        <div style="margin-bottom:1.5rem;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;page-break-inside:avoid">
          <!-- Header mascota -->
          <div style="background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;padding:.75rem 1rem;display:flex;align-items:center;gap:.6rem">
            <span style="font-size:1.4rem">${emojiEspecie(m.especie)}</span>
            <div>
              <strong style="font-size:14px">${esc(m.nombre)}</strong>
              <span style="font-size:11px;opacity:.85;margin-left:.5rem">${esc(m.especie)} ${m.raza?'· '+esc(m.raza):''} · ${esc(m.sexo)} · ${edad}</span>
            </div>
            ${m.peso_kg ? `<span style="margin-left:auto;font-size:11px;background:rgba(255,255,255,.2);padding:.2rem .5rem;border-radius:999px">${m.peso_kg} kg</span>` : ''}
          </div>
          <div style="padding:1rem">
            ${m.alertas_medicas ? `<div style="background:#fff1f2;border:1px solid #fecdd3;border-radius:8px;padding:.5rem .75rem;margin-bottom:.75rem;font-size:11px;color:#be123c"><strong>⚠️ Alertas médicas:</strong> ${esc(m.alertas_medicas)}</div>` : ''}
            <!-- Consultas -->
            <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:.5rem">📋 Historia clínica (${m.historia.length})</p>
            ${consultasHtml}
            <!-- Vacunas -->
            <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0284c7;margin:.75rem 0 .4rem">💉 Vacunas (${m.vacunas.length})</p>
            ${vacunasHtml}
            <!-- Desparasitaciones -->
            <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#7c3aed;margin:.75rem 0 .4rem">🛡️ Desparasitaciones (${m.desparasitaciones.length})</p>
            ${desparasHtml}
          </div>
        </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Helvetica Neue',Arial,sans-serif; font-size:13px; color:#1f2937; padding:32px; max-width:820px; margin:0 auto; }
    .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; padding-bottom:16px; border-bottom:3px solid #10b981; }
    .clinica-nombre { font-size:18px; font-weight:800; color:#15803d; }
    .clinica-info { font-size:11px; color:#6b7280; margin-top:3px; }
    .prop-card { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:1rem; margin-bottom:1.5rem; display:grid; grid-template-columns:1fr 1fr; gap:.6rem; }
    .campo { }
    .campo-label { font-size:9px; color:#9ca3af; text-transform:uppercase; letter-spacing:.1em; font-weight:700; }
    .campo-valor { font-size:12px; font-weight:600; margin-top:2px; }
    .footer { margin-top:2rem; padding-top:12px; border-top:1px solid #e5e7eb; text-align:center; font-size:10px; color:#9ca3af; }
    @media print { body { padding:16px; } @page { margin:.8cm; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      ${empresa?.logo_url ? `<img src="${empresa.logo_url}" style="height:48px;margin-bottom:4px;display:block"/>` : ''}
      <div class="clinica-nombre">${esc(empresa?.nombre||'VetClinic')}</div>
      <div class="clinica-info">${[empresa?.ruc?'RUC: '+empresa.ruc:'', empresa?.direccion||'', empresa?.telefono||''].filter(Boolean).join(' · ')}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:16px;font-weight:800;color:#1f2937">EXPEDIENTE CLÍNICO</div>
      <div style="font-size:11px;color:#6b7280;margin-top:3px">${fDate(new Date())}</div>
    </div>
  </div>

  <!-- Datos del propietario -->
  <div class="prop-card">
    <div class="campo" style="grid-column:span 2">
      <div class="campo-label">Propietario</div>
      <div class="campo-valor" style="font-size:16px">${esc(p.nombre)} ${esc(p.apellido)}</div>
    </div>
    ${p.dni ? `<div class="campo"><div class="campo-label">DNI</div><div class="campo-valor">${esc(p.dni)}</div></div>` : ''}
    ${p.telefono ? `<div class="campo"><div class="campo-label">Teléfono</div><div class="campo-valor">${esc(p.telefono)}</div></div>` : ''}
    ${p.email ? `<div class="campo"><div class="campo-label">Email</div><div class="campo-valor">${esc(p.email)}</div></div>` : ''}
    ${p.direccion ? `<div class="campo" style="grid-column:span 2"><div class="campo-label">Dirección</div><div class="campo-valor">${esc(p.direccion)}</div></div>` : ''}
  </div>

  <!-- Mascotas -->
  <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#6b7280;margin-bottom:1rem">
    🐾 Mascotas (${mascotas.length})
  </p>
  ${mascotasHtml || '<p style="font-size:12px;color:#9ca3af">Sin mascotas registradas.</p>'}

  <div class="footer">
    ${esc(empresa?.nombre||'VetClinic')} · Expediente generado el ${fDate(new Date())} · Documento confidencial
  </div>
  <script>window.onload = function(){ window.print(); }</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) { next(err); }
});

// ── GET /api/v1/propietarios/:id/informe ─────────────────────────
// Devuelve JSON completo (para que el frontend genere el Excel)
router.get('/:id/informe', async (req, res, next) => {
  try {
    const [p] = await req.db.query('SELECT * FROM propietarios WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    const mascotas = await req.db.query(
      'SELECT * FROM mascotas WHERE propietario_id = ? ORDER BY nombre', [req.params.id]
    );
    for (const m of mascotas) {
      m.historia = await req.db.query(
        `SELECT h.*, u.nombre AS veterinario_nombre
         FROM historia_clinica h JOIN usuarios u ON u.id = h.veterinario_id
         WHERE h.mascota_id = ? ORDER BY h.fecha DESC`, [m.id]
      );
      for (const h of m.historia) {
        h.seguimientos = await req.db.query(
          'SELECT * FROM historia_seguimientos WHERE historia_id = ? ORDER BY fecha ASC', [h.id]
        );
      }
    }
    return res.json({ success: true, data: { ...p, mascotas } });
  } catch (err) { next(err); }
});

module.exports = router;