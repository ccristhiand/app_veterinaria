'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');

const router = Router();
router.use(authenticate);

// GET /api/v1/historia?mascota_id=X
router.get('/', async (req, res, next) => {
  try {
    const { mascota_id } = req.query;
    if (!mascota_id) return res.status(422).json({ success: false, message: 'mascota_id requerido.' });
    const rows = await req.db.query(
      `SELECT h.*, u.nombre AS veterinario_nombre
       FROM historia_clinica h
       JOIN usuarios u ON u.id = h.veterinario_id
       WHERE h.mascota_id = ?
       ORDER BY h.fecha DESC`, [mascota_id]
    );
    for (const h of rows) {
      h.recetas      = await req.db.query('SELECT * FROM recetas WHERE historia_clinica_id = ?', [h.id]);
      h.seguimientos = await req.db.query(
        `SELECT s.*, u.nombre AS veterinario_nombre
         FROM historia_seguimientos s
         JOIN usuarios u ON u.id = s.veterinario_id
         WHERE s.historia_id = ?
         ORDER BY s.fecha ASC`, [h.id]
      );
    }
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/historia/:id
router.get('/:id', async (req, res, next) => {
  try {
    const [h] = await req.db.query(
      `SELECT h.*, u.nombre AS veterinario_nombre,
              m.nombre AS mascota_nombre, m.especie
       FROM historia_clinica h
       JOIN usuarios u ON u.id = h.veterinario_id
       JOIN mascotas m ON m.id = h.mascota_id
       WHERE h.id = ?`, [req.params.id]
    );
    if (!h) return res.status(404).json({ success: false, message: 'Consulta no encontrada.' });
    h.recetas      = await req.db.query('SELECT * FROM recetas WHERE historia_clinica_id = ?', [h.id]);
    h.seguimientos = await req.db.query(
      `SELECT s.*, u.nombre AS veterinario_nombre
       FROM historia_seguimientos s
       JOIN usuarios u ON u.id = s.veterinario_id
       WHERE s.historia_id = ?
       ORDER BY s.fecha ASC`, [h.id]
    );
    return res.json({ success: true, data: h });
  } catch (err) { next(err); }
});

// POST /api/v1/historia
router.post('/', auditMiddleware('historia_clinica:creado', 'historia_clinica'), async (req, res, next) => {
  try {
    const { mascota_id, cita_id, fecha, motivo, anamnesis, exploracion,
            diagnostico, tratamiento, pruebas_complementarias,
            observaciones, peso_kg, temperatura_c, recetas } = req.body;

    if (!mascota_id || !motivo)
      return res.status(422).json({ success: false, message: 'mascota_id y motivo requeridos.' });

    const result = await req.db.withTransaction(async (conn) => {
      const [ins] = await conn.execute(
        `INSERT INTO historia_clinica
           (mascota_id, veterinario_id, cita_id, fecha, motivo, anamnesis,
            exploracion, diagnostico, tratamiento, pruebas_complementarias,
            observaciones, peso_kg, temperatura_c)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [mascota_id, req.user.id, cita_id||null, fecha||new Date(), motivo,
         anamnesis||null, exploracion||null, diagnostico||null, tratamiento||null,
         pruebas_complementarias||null, observaciones||null,
         peso_kg||null, temperatura_c||null]
      );
      const hId = ins.insertId;
      if (recetas?.length) {
        for (const r of recetas) {
          await conn.execute(
            'INSERT INTO recetas (historia_clinica_id, medicamento, dosis, frecuencia, duracion_dias, instrucciones) VALUES (?,?,?,?,?,?)',
            [hId, r.medicamento, r.dosis, r.frecuencia, r.duracion_dias||null, r.instrucciones||null]
          );
        }
      }
      if (cita_id) {
        await conn.execute("UPDATE citas SET estado='completada' WHERE id=?", [cita_id]);
      }
      return { id: hId };
    });
    return res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
});

// PUT /api/v1/historia/:id
router.put('/:id', auditMiddleware('historia_clinica:actualizado', 'historia_clinica'), async (req, res, next) => {
  try {
    const { motivo, anamnesis, exploracion, diagnostico, tratamiento,
            pruebas_complementarias, observaciones, peso_kg, temperatura_c, recetas } = req.body;

    await req.db.withTransaction(async (conn) => {
      await conn.execute(
        `UPDATE historia_clinica SET motivo=?, anamnesis=?, exploracion=?,
         diagnostico=?, tratamiento=?, pruebas_complementarias=?,
         observaciones=?, peso_kg=?, temperatura_c=?
         WHERE id=?`,
        [motivo, anamnesis||null, exploracion||null, diagnostico||null,
         tratamiento||null, pruebas_complementarias||null,
         observaciones||null, peso_kg||null, temperatura_c||null, req.params.id]
      );
      if (recetas) {
        await conn.execute('DELETE FROM recetas WHERE historia_clinica_id = ?', [req.params.id]);
        for (const r of recetas) {
          await conn.execute(
            'INSERT INTO recetas (historia_clinica_id, medicamento, dosis, frecuencia, duracion_dias, instrucciones) VALUES (?,?,?,?,?,?)',
            [req.params.id, r.medicamento, r.dosis, r.frecuencia, r.duracion_dias||null, r.instrucciones||null]
          );
        }
      }
    });
    return res.json({ success: true, message: 'Consulta actualizada.' });
  } catch (err) { next(err); }
});

// ── SEGUIMIENTOS ──────────────────────────────────────────────────

// GET /api/v1/historia/:id/seguimientos
router.get('/:id/seguimientos', async (req, res, next) => {
  try {
    const rows = await req.db.query(
      `SELECT s.*, u.nombre AS veterinario_nombre
       FROM historia_seguimientos s
       JOIN usuarios u ON u.id = s.veterinario_id
       WHERE s.historia_id = ?
       ORDER BY s.fecha ASC`, [req.params.id]
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/v1/historia/:id/seguimientos
router.post('/:id/seguimientos', auditMiddleware('historia_clinica:actualizado', 'historia_clinica'), async (req, res, next) => {
  try {
    const { evolucion, tratamiento, observaciones, peso_kg, temperatura_c, fecha } = req.body;
    if (!evolucion?.trim())
      return res.status(422).json({ success: false, message: 'La evolución es obligatoria.' });
    const [historia] = await req.db.query('SELECT id FROM historia_clinica WHERE id = ?', [req.params.id]);
    if (!historia) return res.status(404).json({ success: false, message: 'Consulta no encontrada.' });
    const result = await req.db.query(
      `INSERT INTO historia_seguimientos
         (historia_id, veterinario_id, fecha, evolucion, tratamiento, observaciones, peso_kg, temperatura_c)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.params.id, req.user.id, fecha || new Date(),
       evolucion.trim(), tratamiento?.trim()||null, observaciones?.trim()||null,
       peso_kg||null, temperatura_c||null]
    );
    return res.status(201).json({
      success: true,
      message: 'Seguimiento agregado correctamente.',
      data: { id: result.insertId },
    });
  } catch (err) { next(err); }
});

// PUT /api/v1/historia/:id/seguimientos/:segId
router.put('/:id/seguimientos/:segId', auditMiddleware('historia_clinica:actualizado', 'historia_clinica'), async (req, res, next) => {
  try {
    const { evolucion, tratamiento, observaciones, peso_kg, temperatura_c, fecha } = req.body;
    if (!evolucion?.trim())
      return res.status(422).json({ success: false, message: 'La evolución es obligatoria.' });
    const [seg] = await req.db.query(
      'SELECT id FROM historia_seguimientos WHERE id = ? AND historia_id = ?',
      [req.params.segId, req.params.id]
    );
    if (!seg) return res.status(404).json({ success: false, message: 'Seguimiento no encontrado.' });
    await req.db.query(
      `UPDATE historia_seguimientos SET
         fecha=?, evolucion=?, tratamiento=?, observaciones=?, peso_kg=?, temperatura_c=?
       WHERE id=?`,
      [fecha || new Date(), evolucion.trim(),
       tratamiento?.trim()||null, observaciones?.trim()||null,
       peso_kg||null, temperatura_c||null, req.params.segId]
    );
    return res.json({ success: true, message: 'Seguimiento actualizado.' });
  } catch (err) { next(err); }
});

// DELETE /api/v1/historia/:id/seguimientos/:segId
router.delete('/:id/seguimientos/:segId', authorize('admin', 'veterinario'), async (req, res, next) => {
  try {
    await req.db.query(
      'DELETE FROM historia_seguimientos WHERE id = ? AND historia_id = ?',
      [req.params.segId, req.params.id]
    );
    return res.json({ success: true, message: 'Seguimiento eliminado.' });
  } catch (err) { next(err); }
});

// DELETE /api/v1/historia/:id
router.delete('/:id', authorize('admin', 'veterinario'), auditMiddleware('historia_clinica:eliminado', 'historia_clinica'), async (req, res, next) => {
  try {
    const [h] = await req.db.query('SELECT id FROM historia_clinica WHERE id = ?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, message: 'Consulta no encontrada.' });
    await req.db.withTransaction(async (conn) => {
      await conn.execute('DELETE FROM historia_seguimientos WHERE historia_id = ?', [req.params.id]);
      await conn.execute('DELETE FROM recetas WHERE historia_clinica_id = ?', [req.params.id]);
      await conn.execute('DELETE FROM historia_clinica WHERE id = ?', [req.params.id]);
    });
    return res.json({ success: true, message: 'Consulta eliminada correctamente.' });
  } catch (err) { next(err); }
});

// ── POST /api/v1/historia/:id/receta-pdf ─────────────────────
router.post('/:id/receta-pdf', authorize('admin','veterinario','recepcionista'), async (req, res, next) => {
  try {
    // 1. Obtener historia con recetas
    const [historia] = await req.db.query(
      `SELECT h.*, u.nombre AS vet_nombre, u.email AS vet_email,
              m.nombre AS mascota_nombre, m.especie, m.raza, m.peso_kg,
              m.fecha_nacimiento,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
              p.telefono AS propietario_tel, p.dni
       FROM historia_clinica h
       JOIN usuarios u ON u.id = h.veterinario_id
       JOIN mascotas m ON m.id = h.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE h.id = ?`, [req.params.id]
    );
    if (!historia) return res.status(404).json({ success:false, message:'Consulta no encontrada.' });

    const recetas = await req.db.query(
      'SELECT * FROM recetas WHERE historia_clinica_id = ?', [req.params.id]
    );
    if (!recetas.length) return res.status(422).json({ success:false, message:'Sin recetas para imprimir.' });

    // 2. Datos de la clínica
    const [empresa] = await req.db.query(
      'SELECT nombre, ruc, direccion, telefono, email, logo_url, igv_porcentaje FROM empresa_config LIMIT 1'
    );

    // 3. Calcular edad mascota
    let edad = '';
    if (historia.fecha_nacimiento) {
      const diff = Math.floor((new Date() - new Date(historia.fecha_nacimiento)) / (1000*60*60*24*365));
      edad = diff < 1 ? 'Menos de 1 año' : diff === 1 ? '1 año' : diff + ' años';
    }

    // 4. Generar HTML de la receta
    const fecha = new Date(historia.fecha).toLocaleDateString('es-PE', {
      day:'numeric', month:'long', year:'numeric'
    });

    const recetasHtml = recetas.map((r, i) => `
      <div style="margin-bottom:1rem;padding-bottom:1rem;border-bottom:1px solid #e5e7eb">
        <p style="font-weight:700;font-size:14px;margin-bottom:.3rem">${i+1}. ${r.medicamento}</p>
        <p style="font-size:13px;color:#374151;margin:.2rem 0">
          <strong>Dosis:</strong> ${r.dosis}
        </p>
        <p style="font-size:13px;color:#374151;margin:.2rem 0">
          <strong>Frecuencia:</strong> ${r.frecuencia}
        </p>
        ${r.duracion_dias ? `<p style="font-size:13px;color:#374151;margin:.2rem 0"><strong>Duración:</strong> ${r.duracion_dias} días</p>` : ''}
        ${r.instrucciones ? `<p style="font-size:12px;color:#6b7280;margin-top:.3rem;font-style:italic">📝 ${r.instrucciones}</p>` : ''}
      </div>
    `).join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Helvetica Neue',Arial,sans-serif; font-size:13px; color:#1f2937; padding:40px; max-width:680px; margin:0 auto; }
    .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:24px; padding-bottom:16px; border-bottom:3px solid #15803d; }
    .logo-area { display:flex; align-items:center; gap:12px; }
    .logo { width:60px; height:60px; object-fit:contain; }
    .clinica-nombre { font-size:20px; font-weight:800; color:#15803d; }
    .clinica-info { font-size:11px; color:#6b7280; margin-top:4px; }
    .titulo { text-align:center; margin:20px 0; }
    .titulo h1 { font-size:16px; font-weight:700; text-transform:uppercase; letter-spacing:.15em; color:#1f2937; }
    .titulo p { font-size:12px; color:#6b7280; margin-top:4px; }
    .seccion { margin-bottom:20px; }
    .seccion-titulo { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:#6b7280; margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid #e5e7eb; }
    .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .campo { margin-bottom:6px; }
    .campo-label { font-size:10px; color:#9ca3af; text-transform:uppercase; }
    .campo-valor { font-size:13px; font-weight:600; color:#1f2937; }
    .recetas-box { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:16px; margin:20px 0; }
    .recetas-titulo { font-size:13px; font-weight:700; color:#15803d; margin-bottom:12px; }
    .firma-area { margin-top:40px; display:flex; justify-content:flex-end; }
    .firma-box { text-align:center; min-width:200px; }
    .firma-linea { border-top:1px solid #374151; margin-bottom:6px; }
    .firma-nombre { font-size:13px; font-weight:700; }
    .firma-cargo { font-size:11px; color:#6b7280; }
    .footer { margin-top:30px; padding-top:12px; border-top:1px solid #e5e7eb; text-align:center; font-size:10px; color:#9ca3af; }
    @media print {
      body { padding:20px; }
      @page { margin:1cm; }
    }
  </style>
</head>
<body>
  <!-- Header con branding -->
  <div class="header">
    <div class="logo-area">
      ${empresa?.logo_url ? `<img src="${empresa.logo_url}" class="logo" alt="Logo"/>` : ''}
      <div>
        <div class="clinica-nombre">${empresa?.nombre || 'VetClinic'}</div>
        <div class="clinica-info">
          ${empresa?.ruc ? `RUC: ${empresa.ruc}<br/>` : ''}
          ${empresa?.direccion ? `${empresa.direccion}<br/>` : ''}
          ${empresa?.telefono ? `Tel: ${empresa.telefono}` : ''}
          ${empresa?.email ? ` · ${empresa.email}` : ''}
        </div>
      </div>
    </div>
    <div style="text-align:right;font-size:11px;color:#6b7280">
      <div style="font-weight:700;font-size:13px;color:#1f2937">RECETA MÉDICA</div>
      <div>Lima, ${fecha}</div>
      <div>Nº HC-${String(historia.id).padStart(5,'0')}</div>
    </div>
  </div>

  <!-- Datos del paciente -->
  <div class="seccion">
    <div class="seccion-titulo">Datos del Paciente</div>
    <div class="grid-2">
      <div>
        <div class="campo">
          <div class="campo-label">Nombre</div>
          <div class="campo-valor">${historia.mascota_nombre}</div>
        </div>
        <div class="campo">
          <div class="campo-label">Especie / Raza</div>
          <div class="campo-valor">${historia.especie}${historia.raza ? ' · '+historia.raza : ''}</div>
        </div>
      </div>
      <div>
        <div class="campo">
          <div class="campo-label">Peso</div>
          <div class="campo-valor">${historia.peso_kg ? historia.peso_kg+' kg' : '—'}</div>
        </div>
        <div class="campo">
          <div class="campo-label">Edad</div>
          <div class="campo-valor">${edad || '—'}</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Datos del propietario -->
  <div class="seccion">
    <div class="seccion-titulo">Propietario</div>
    <div class="grid-2">
      <div class="campo">
        <div class="campo-label">Nombre</div>
        <div class="campo-valor">${historia.propietario_nombre}</div>
      </div>
      <div class="campo">
        <div class="campo-label">DNI / Teléfono</div>
        <div class="campo-valor">${historia.dni || '—'} · ${historia.propietario_tel || '—'}</div>
      </div>
    </div>
  </div>

  ${historia.diagnostico ? `
  <div class="seccion">
    <div class="seccion-titulo">Diagnóstico</div>
    <p style="font-size:13px;color:#1f2937;line-height:1.5">${historia.diagnostico}</p>
  </div>` : ''}

  <!-- Recetas -->
  <div class="recetas-box">
    <div class="recetas-titulo">💊 Prescripción Médica</div>
    ${recetasHtml}
  </div>

  <!-- Firma del veterinario -->
  <div class="firma-area">
    <div class="firma-box">
      <div style="height:50px"></div>
      <div class="firma-linea"></div>
      <div class="firma-nombre">Dr/a. ${historia.vet_nombre}</div>
      <div class="firma-cargo">Médico Veterinario</div>
    </div>
  </div>

  <div class="footer">
    ${empresa?.nombre || 'VetClinic'} · ${empresa?.direccion || ''} · ${empresa?.telefono || ''}
    <br/>Documento generado el ${new Date().toLocaleString('es-PE')}
  </div>

  <script>window.onload = function(){ window.print(); }</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="receta_${req.params.id}.html"`);
    return res.send(html);

  } catch (err) { next(err); }
});

module.exports = router;