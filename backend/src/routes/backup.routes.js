'use strict';

const { Router }     = require('express');
const { masterQuery } = require('../config/masterDB');
const { exec }        = require('child_process');
const path            = require('path');
const router          = Router();

const BACKUP_SCRIPT = '/var/www/app_veterinaria/scripts/vetclinic_backup.sh';

// GET /admin/api/backups — historial de backups
router.get('/', async (req, res) => {
  try {
    const { tenant_id, estado, tipo, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let where = 'WHERE 1=1';

    if (tenant_id) { where += ' AND tenant_id=?';  params.push(tenant_id); }
    if (estado)    { where += ' AND estado=?';      params.push(estado); }
    if (tipo)      { where += ' AND tipo=?';        params.push(tipo); }

    const [{ total }] = await masterQuery(
      `SELECT COUNT(*) AS total FROM tenant_backups ${where}`, params
    );

    const backups = await masterQuery(
      `SELECT b.*, t.subdominio
       FROM tenant_backups b
       LEFT JOIN tenants t ON t.id = b.tenant_id
       ${where} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    return res.json({
      success: true,
      data   : backups,
      meta   : { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total/limit) }
    });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /admin/api/backups/config — configuración de backups
router.get('/config', async (req, res) => {
  try {
    const config = await masterQuery(
      `SELECT tbc.*, tc.nombre_clinica, t.subdominio
       FROM tenant_backup_config tbc
       JOIN tenants t ON t.id = tbc.tenant_id
       LEFT JOIN tenant_config tc ON tc.tenant_id = tbc.tenant_id
       ORDER BY tc.nombre_clinica`
    );
    return res.json({ success:true, data:config });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// PUT /admin/api/backups/config/:tenant_id — actualizar config
router.put('/config/:tenant_id', async (req, res) => {
  try {
    const { activo, hora_backup, retener_diarios, retener_semanales, retener_mensuales } = req.body;
    await masterQuery(
      `INSERT INTO tenant_backup_config
         (tenant_id, activo, hora_backup, retener_diarios, retener_semanales, retener_mensuales)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         activo=VALUES(activo), hora_backup=VALUES(hora_backup),
         retener_diarios=VALUES(retener_diarios),
         retener_semanales=VALUES(retener_semanales),
         retener_mensuales=VALUES(retener_mensuales)`,
      [req.params.tenant_id, activo?1:0, hora_backup||'02:00:00',
       retener_diarios||7, retener_semanales||4, retener_mensuales||3]
    );

    // Actualizar el crontab automáticamente
    await actualizarCrontab();

    return res.json({ success:true, message:'Configuración guardada.' });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /admin/api/backups/manual/:tenant_id — backup manual
router.post('/manual/:tenant_id', async (req, res) => {
  try {
    const tenantId = req.params.tenant_id;
    const [tenant] = await masterQuery(
      'SELECT id FROM tenants WHERE id=? AND activo=1', [tenantId]
    );
    if (!tenant) return res.status(404).json({ success:false, message:'Tenant no encontrado.' });

    // Ejecutar script en background
    const cmd = `bash ${BACKUP_SCRIPT} manual ${tenantId}`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) console.error('[backup manual]', err.message);
    });

    return res.json({ success:true, message:'Backup iniciado. Puedes ver el progreso en el historial.' });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /admin/api/backups/manual-all — backup de todas las clínicas
router.post('/manual-all', async (req, res) => {
  try {
    const cmd = `bash ${BACKUP_SCRIPT} manual`;
    exec(cmd, (err) => {
      if (err) console.error('[backup manual-all]', err.message);
    });
    return res.json({ success:true, message:'Backup general iniciado.' });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /admin/api/backups/stats — resumen
router.get('/stats', async (req, res) => {
  try {
    const stats = await masterQuery(`
      SELECT
        tenant_nombre,
        COUNT(*) AS total,
        SUM(CASE WHEN estado='exitoso' THEN 1 ELSE 0 END) AS exitosos,
        SUM(CASE WHEN estado='fallido' THEN 1 ELSE 0 END) AS fallidos,
        MAX(CASE WHEN estado='exitoso' THEN created_at END) AS ultimo_exitoso,
        SUM(tamaño_mb) AS total_mb
      FROM tenant_backups
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY tenant_id, tenant_nombre
      ORDER BY ultimo_exitoso DESC
    `);

    const totalDrive = await masterQuery(`
      SELECT ROUND(SUM(tamaño_mb) / 1024, 2) AS total_gb
      FROM tenant_backups WHERE estado='exitoso'
    `);

    return res.json({ success:true, data:{ stats, total_gb: totalDrive[0]?.total_gb || 0 } });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// ── Actualizar crontab automáticamente ────────────────────────
async function actualizarCrontab() {
  try {
    const configs = await masterQuery(
      `SELECT tbc.tenant_id, tbc.hora_backup, tbc.activo
       FROM tenant_backup_config tbc WHERE tbc.activo=1`
    );

    // Agrupar por hora
    const porHora = {};
    configs.forEach(c => {
      const hora = c.hora_backup?.substring(0,5) || '02:00';
      const [h, m] = hora.split(':');
      const key = `${m} ${h}`;
      if (!porHora[key]) porHora[key] = [];
      porHora[key].push(c.tenant_id);
    });

    // Generar líneas cron
    const lineas = Object.entries(porHora).map(([time, ids]) =>
      `${time} * * * root bash ${BACKUP_SCRIPT} diario # VetClinic`
    );

    // También semanal (domingos 3am) y mensual (día 1 4am)
    lineas.push(`0 3 * * 0 root bash ${BACKUP_SCRIPT} semanal # VetClinic`);
    lineas.push(`0 4 1 * * root bash ${BACKUP_SCRIPT} mensual # VetClinic`);

    const contenido = `# VetClinic SaaS — Backups automáticos\n# Generado automáticamente\n${lineas.join('\n')}\n`;

    const { writeFileSync } = require('fs');
    writeFileSync('/etc/cron.d/vetclinic-backups', contenido);
  } catch(e) {
    console.error('[backup] Error actualizando crontab:', e.message);
  }
}

module.exports = router;