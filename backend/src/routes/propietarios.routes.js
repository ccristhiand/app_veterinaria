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

    for (const m of mascotas) {
      m.historia = await req.db.query(
        `SELECT h.*, u.nombre AS veterinario_nombre
         FROM historia_clinica h JOIN usuarios u ON u.id = h.veterinario_id
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
    const especie2emoji = (e) => ({ perro:'🐕', gato:'🐈', ave:'🦜', reptil:'🦎', roedor:'🐹' }[e] || '🐾');
    const especie2color = (e) => ({ perro:'#854d0e', gato:'#5b21b6', ave:'#0369a1', reptil:'#166534', roedor:'#9d174d' }[e] || '#374151');
    const especie2bg    = (e) => ({ perro:'#fef3c7', gato:'#ede9fe', ave:'#e0f2fe', reptil:'#dcfce7', roedor:'#fce7f3' }[e] || '#f3f4f6');

    const seccionLabel = (emoji, texto, color, bg) =>
      `<div style="display:flex;align-items:center;gap:8px;margin:20px 0 10px;padding:7px 12px;background:${bg};border-radius:8px;border-left:4px solid ${color}">
        <span style="font-size:14px">${emoji}</span>
        <span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:${color}">${texto}</span>
      </div>`;

    const mascotasHtml = mascotas.map((m, mi) => {
      const edadMs    = m.fecha_nacimiento ? Date.now() - new Date(m.fecha_nacimiento) : null;
      const edadAnios = edadMs ? Math.floor(edadMs / (1000*60*60*24*365)) : null;
      const edad      = edadAnios !== null ? (edadAnios < 1 ? 'Menos de 1 año' : edadAnios + ' año' + (edadAnios > 1 ? 's' : '')) : null;
      const eColor    = especie2color(m.especie);
      const eBg       = especie2bg(m.especie);

      // ── Consultas ──
      const consultasHtml = m.historia.length
        ? m.historia.map((h, hi) => {
            const segHtml = h.seguimientos.length ? h.seguimientos.map(s => `
              <div style="margin-top:8px;padding:8px 10px;background:#fff;border-radius:6px;border:1px solid #e5e7eb;border-left:3px solid #f59e0b">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                  <span style="font-size:9px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:.08em">🔄 Seguimiento — ${fDate(s.fecha)}</span>
                  <span style="font-size:9px;color:#9ca3af">Dr/a. ${esc(s.veterinario_nombre)}</span>
                </div>
                ${s.evolucion ? `<p style="font-size:10px;color:#374151;margin:2px 0"><b>Evolución:</b> ${esc(s.evolucion)}</p>` : ''}
                ${s.tratamiento ? `<p style="font-size:10px;color:#374151;margin:2px 0"><b>Tratamiento:</b> ${esc(s.tratamiento)}</p>` : ''}
                ${s.pruebas_complementarias ? `<p style="font-size:10px;color:#1d4ed8;margin:2px 0"><b>Pruebas:</b> ${esc(s.pruebas_complementarias)}</p>` : ''}
              </div>`).join('') : '';

            const recetasHtml = h.recetas.length
              ? `<div style="margin-top:6px;padding:5px 8px;background:#f5f3ff;border-radius:6px;border:1px solid #ddd6fe">
                  <span style="font-size:9px;font-weight:700;color:#6d28d9">💊 Recetas: </span>
                  <span style="font-size:9px;color:#4c1d95">${h.recetas.map(r => esc(r.medicamento) + (r.dosis ? ' — '+esc(r.dosis) : '')).join(' &nbsp;·&nbsp; ')}</span>
                </div>` : '';

            return `
              <div style="margin-bottom:10px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;page-break-inside:avoid">
                <!-- Cabecera consulta -->
                <div style="background:#f8fafc;padding:8px 12px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center">
                  <div style="display:flex;align-items:center;gap:8px">
                    <span style="background:#10b981;color:#fff;font-size:8px;font-weight:800;padding:2px 7px;border-radius:999px">#${m.historia.length - hi}</span>
                    <strong style="font-size:12px;color:#111827">${esc(h.motivo)}</strong>
                  </div>
                  <div style="text-align:right">
                    <span style="font-size:9px;color:#6b7280">${fDate(h.fecha)}</span><br/>
                    <span style="font-size:9px;color:#9ca3af">Dr/a. ${esc(h.veterinario_nombre)}</span>
                  </div>
                </div>
                <!-- Cuerpo consulta -->
                <div style="padding:10px 12px">
                  ${h.anamnesis ? `<p style="font-size:10px;margin:0 0 5px;color:#374151"><span style="font-weight:700;color:#6b7280">Anamnesis:</span> ${esc(h.anamnesis)}</p>` : ''}
                  ${h.exploracion ? `<p style="font-size:10px;margin:0 0 5px;color:#374151"><span style="font-weight:700;color:#6b7280">Exploración:</span> ${esc(h.exploracion)}</p>` : ''}
                  ${h.diagnostico ? `<p style="font-size:10px;margin:0 0 5px"><span style="font-weight:700;color:#059669">Diagnóstico:</span> <span style="color:#065f46">${esc(h.diagnostico)}</span></p>` : ''}
                  ${h.tratamiento ? `<p style="font-size:10px;margin:0 0 5px"><span style="font-weight:700;color:#374151">Tratamiento:</span> ${esc(h.tratamiento)}</p>` : ''}
                  ${h.pruebas_complementarias ? `<p style="font-size:10px;margin:0 0 5px"><span style="font-weight:700;color:#1d4ed8">Pruebas:</span> <span style="color:#1e40af">${esc(h.pruebas_complementarias)}</span></p>` : ''}
                  ${h.observaciones ? `<p style="font-size:10px;margin:0 0 5px;color:#6b7280"><span style="font-weight:700">Obs:</span> ${esc(h.observaciones)}</p>` : ''}
                  ${h.peso_kg||h.temperatura_c ? `
                    <div style="display:flex;gap:10px;margin-top:4px">
                      ${h.peso_kg ? `<span style="font-size:9px;background:#f0fdf4;color:#15803d;padding:2px 8px;border-radius:999px;border:1px solid #bbf7d0">⚖️ ${h.peso_kg} kg</span>` : ''}
                      ${h.temperatura_c ? `<span style="font-size:9px;background:#fff7ed;color:#c2410c;padding:2px 8px;border-radius:999px;border:1px solid #fed7aa">🌡️ ${h.temperatura_c}°C</span>` : ''}
                    </div>` : ''}
                  ${recetasHtml}
                  ${segHtml}
                </div>
              </div>`;
          }).join('')
        : `<p style="font-size:11px;color:#9ca3af;padding:8px 0;text-align:center">Sin consultas registradas.</p>`;

      // ── Vacunas ──
      const vacunasHtml = m.vacunas.length
        ? `<table style="width:100%;border-collapse:collapse;font-size:10px">
            <thead>
              <tr style="background:#e0f2fe">
                <th style="padding:6px 10px;text-align:left;font-weight:700;color:#0369a1;border-bottom:2px solid #bae6fd">Vacuna</th>
                <th style="padding:6px 10px;text-align:left;font-weight:700;color:#0369a1;border-bottom:2px solid #bae6fd">Fecha</th>
                <th style="padding:6px 10px;text-align:left;font-weight:700;color:#0369a1;border-bottom:2px solid #bae6fd">Próxima dosis</th>
                <th style="padding:6px 10px;text-align:left;font-weight:700;color:#0369a1;border-bottom:2px solid #bae6fd">Veterinario</th>
              </tr>
            </thead>
            <tbody>
              ${m.vacunas.map((v, i) => `
                <tr style="background:${i % 2 === 0 ? '#f0f9ff' : '#fff'}">
                  <td style="padding:6px 10px;border-bottom:1px solid #e0f2fe;color:#1e3a5f">${esc(v.nombre)}</td>
                  <td style="padding:6px 10px;border-bottom:1px solid #e0f2fe;color:#374151">${fDate(v.fecha_aplicacion)}</td>
                  <td style="padding:6px 10px;border-bottom:1px solid #e0f2fe">
                    ${v.proxima_dosis
                      ? `<span style="color:${new Date(v.proxima_dosis) < new Date() ? '#be123c' : '#0369a1'};font-weight:600">${fDate(v.proxima_dosis)}</span>`
                      : '<span style="color:#9ca3af">—</span>'}
                  </td>
                  <td style="padding:6px 10px;border-bottom:1px solid #e0f2fe;color:#6b7280">${esc(v.veterinario_nombre)}</td>
                </tr>`).join('')}
            </tbody>
          </table>`
        : `<p style="font-size:11px;color:#9ca3af;padding:8px 0;text-align:center">Sin vacunas registradas.</p>`;

      // ── Desparasitaciones ──
      const desparasHtml = m.desparasitaciones.length
        ? `<table style="width:100%;border-collapse:collapse;font-size:10px">
            <thead>
              <tr style="background:#ede9fe">
                <th style="padding:6px 10px;text-align:left;font-weight:700;color:#6d28d9;border-bottom:2px solid #ddd6fe">Producto</th>
                <th style="padding:6px 10px;text-align:left;font-weight:700;color:#6d28d9;border-bottom:2px solid #ddd6fe">Tipo</th>
                <th style="padding:6px 10px;text-align:left;font-weight:700;color:#6d28d9;border-bottom:2px solid #ddd6fe">Fecha</th>
                <th style="padding:6px 10px;text-align:left;font-weight:700;color:#6d28d9;border-bottom:2px solid #ddd6fe">Próxima</th>
                <th style="padding:6px 10px;text-align:left;font-weight:700;color:#6d28d9;border-bottom:2px solid #ddd6fe">Veterinario</th>
              </tr>
            </thead>
            <tbody>
              ${m.desparasitaciones.map((d, i) => `
                <tr style="background:${i % 2 === 0 ? '#f5f3ff' : '#fff'}">
                  <td style="padding:6px 10px;border-bottom:1px solid #ede9fe;font-weight:600;color:#3b0764">${esc(d.producto)}</td>
                  <td style="padding:6px 10px;border-bottom:1px solid #ede9fe">
                    <span style="font-size:9px;background:${d.tipo==='interna'?'#e0f2fe':'#fef3c7'};color:${d.tipo==='interna'?'#0369a1':'#92400e'};padding:2px 7px;border-radius:999px;font-weight:700">${esc(d.tipo)}</span>
                  </td>
                  <td style="padding:6px 10px;border-bottom:1px solid #ede9fe;color:#374151">${fDate(d.fecha_aplicacion)}</td>
                  <td style="padding:6px 10px;border-bottom:1px solid #ede9fe">
                    ${d.proxima_dosis
                      ? `<span style="color:${new Date(d.proxima_dosis) < new Date() ? '#be123c' : '#6d28d9'};font-weight:600">${fDate(d.proxima_dosis)}</span>`
                      : '<span style="color:#9ca3af">—</span>'}
                  </td>
                  <td style="padding:6px 10px;border-bottom:1px solid #ede9fe;color:#6b7280">${esc(d.veterinario_nombre)}</td>
                </tr>`).join('')}
            </tbody>
          </table>`
        : `<p style="font-size:11px;color:#9ca3af;padding:8px 0;text-align:center">Sin desparasitaciones registradas.</p>`;

      return `
        <!-- ══ MASCOTA ${mi + 1} ══ -->
        <div style="margin-bottom:32px">
          <!-- Header mascota -->
          <div style="background:${eColor};border-radius:12px 12px 0 0;padding:14px 18px;display:flex;align-items:center;gap:12px;page-break-after:avoid">
            <div style="width:44px;height:44px;background:rgba(255,255,255,.2);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">
              ${especie2emoji(m.especie)}
            </div>
            <div style="flex:1">
              <div style="color:#fff;font-size:16px;font-weight:800;letter-spacing:.01em">${esc(m.nombre)}</div>
              <div style="color:rgba(255,255,255,.8);font-size:10px;margin-top:2px">
                ${esc(m.especie.charAt(0).toUpperCase()+m.especie.slice(1))}${m.raza ? ' · '+esc(m.raza) : ''} · ${esc(m.sexo)}${edad ? ' · '+edad : ''}
              </div>
            </div>
            <div style="text-align:right">
              ${m.peso_kg ? `<div style="background:rgba(255,255,255,.2);border-radius:8px;padding:4px 10px;color:#fff;font-size:11px;font-weight:700">⚖️ ${m.peso_kg} kg</div>` : ''}
              ${m.microchip ? `<div style="font-size:9px;color:rgba(255,255,255,.7);margin-top:4px">🔖 ${esc(m.microchip)}</div>` : ''}
            </div>
          </div>

          <!-- Cuerpo mascota -->
          <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:16px 18px">
            ${m.alertas_medicas ? `
              <div style="background:#fff1f2;border:1px solid #fecdd3;border-radius:8px;padding:10px 14px;margin-bottom:16px;display:flex;gap:8px;align-items:flex-start">
                <span style="font-size:16px;flex-shrink:0">⚠️</span>
                <div>
                  <p style="font-size:10px;font-weight:800;color:#be123c;text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px">Alertas médicas</p>
                  <p style="font-size:11px;color:#9f1239">${esc(m.alertas_medicas)}</p>
                </div>
              </div>` : ''}

            ${seccionLabel('📋', `Historia clínica (${m.historia.length})`, '#059669', '#f0fdf4')}
            ${consultasHtml}

            ${seccionLabel('💉', `Vacunas (${m.vacunas.length})`, '#0369a1', '#e0f2fe')}
            ${vacunasHtml}

            ${seccionLabel('🛡️', `Desparasitaciones (${m.desparasitaciones.length})`, '#6d28d9', '#ede9fe')}
            ${desparasHtml}
          </div>
        </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family:'Inter',system-ui,-apple-system,sans-serif;
      font-size:13px; color:#1f2937;
      background:#fff; padding:36px 40px;
      max-width:860px; margin:0 auto;
    }
    /* ── Header ── */
    .doc-header {
      display:flex; justify-content:space-between; align-items:flex-start;
      padding-bottom:18px; margin-bottom:24px;
      border-bottom:2.5px solid #10b981;
    }
    .doc-title {
      font-size:20px; font-weight:800; color:#111827;
      letter-spacing:.02em; text-transform:uppercase;
    }
    .doc-date { font-size:11px; color:#6b7280; margin-top:4px; }
    .clinica-nombre { font-size:17px; font-weight:800; color:#15803d; margin-bottom:2px; }
    .clinica-info { font-size:10px; color:#6b7280; line-height:1.6; }
    /* ── Propietario ── */
    .prop-header {
      display:flex; align-items:center; gap:14px;
      background:#f0fdf4; border:1px solid #bbf7d0;
      border-radius:12px; padding:16px 20px; margin-bottom:28px;
    }
    .prop-avatar {
      width:52px; height:52px; border-radius:50%;
      background:linear-gradient(135deg,#10b981,#059669);
      color:#fff; font-size:18px; font-weight:800;
      display:flex; align-items:center; justify-content:center;
      flex-shrink:0;
    }
    .prop-nombre { font-size:17px; font-weight:800; color:#111827; }
    .prop-datos { display:flex; flex-wrap:wrap; gap:14px; margin-top:8px; }
    .prop-dato { }
    .dato-label { font-size:8px; font-weight:700; text-transform:uppercase;
                  letter-spacing:.12em; color:#9ca3af; margin-bottom:1px; }
    .dato-valor { font-size:11px; font-weight:600; color:#1f2937; }
    /* ── Footer ── */
    .doc-footer {
      margin-top:36px; padding-top:14px;
      border-top:1px solid #e5e7eb;
      display:flex; justify-content:space-between; align-items:center;
      font-size:9px; color:#9ca3af;
    }
    /* ── Print ── */
    @media print {
      body { padding:18px 22px; }
      @page { margin:.9cm 1cm; size:A4; }
      .no-break { page-break-inside:avoid; }
    }
  </style>
</head>
<body>

  <!-- Cabecera del documento -->
  <div class="doc-header">
    <div>
      ${empresa?.logo_url ? `<img src="${empresa.logo_url}" style="height:44px;margin-bottom:6px;display:block"/>` : ''}
      <div class="clinica-nombre">${esc(empresa?.nombre || 'VetClinic')}</div>
      <div class="clinica-info">
        ${empresa?.ruc ? `RUC: ${esc(empresa.ruc)}<br/>` : ''}
        ${empresa?.direccion ? `${esc(empresa.direccion)}<br/>` : ''}
        ${empresa?.telefono ? esc(empresa.telefono) : ''}
        ${empresa?.email ? ` · ${esc(empresa.email)}` : ''}
      </div>
    </div>
    <div style="text-align:right">
      <div class="doc-title">Expediente Clínico</div>
      <div class="doc-date">${fDate(new Date())}</div>
    </div>
  </div>

  <!-- Datos del propietario -->
  <div class="prop-header">
    <div class="prop-avatar">
      ${esc(p.nombre.charAt(0))}${esc(p.apellido.charAt(0))}
    </div>
    <div style="flex:1">
      <div class="prop-nombre">${esc(p.nombre)} ${esc(p.apellido)}</div>
      <div class="prop-datos">
        ${p.dni      ? `<div class="prop-dato"><div class="dato-label">DNI</div><div class="dato-valor">${esc(p.dni)}</div></div>` : ''}
        ${p.telefono ? `<div class="prop-dato"><div class="dato-label">Teléfono</div><div class="dato-valor">${esc(p.telefono)}</div></div>` : ''}
        ${p.email    ? `<div class="prop-dato"><div class="dato-label">Email</div><div class="dato-valor">${esc(p.email)}</div></div>` : ''}
        ${p.direccion? `<div class="prop-dato"><div class="dato-label">Dirección</div><div class="dato-valor">${esc(p.direccion)}</div></div>` : ''}
      </div>
    </div>
    <div style="text-align:right;flex-shrink:0">
      <div style="background:#10b981;color:#fff;font-size:10px;font-weight:700;padding:5px 12px;border-radius:999px">
        🐾 ${mascotas.length} mascota${mascotas.length !== 1 ? 's' : ''}
      </div>
    </div>
  </div>

  <!-- Mascotas -->
  ${mascotasHtml || '<p style="font-size:12px;color:#9ca3af;text-align:center;padding:2rem">Sin mascotas registradas.</p>'}

  <!-- Footer -->
  <div class="doc-footer">
    <span>${esc(empresa?.nombre || 'VetClinic')} · Documento confidencial</span>
    <span>Generado el ${fDate(new Date())}</span>
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