'use strict';

const { BlobServiceClient } = require('@azure/storage-blob');
const { masterQuery }       = require('../config/masterDB');
const { execAsync }         = require('../utils/execAsync');
const fs                    = require('fs');
const path                  = require('path');
const os                    = require('os');

// ── Config desde .env ─────────────────────────────────────────
const AZURE_CONNECTION = process.env.AZURE_STORAGE_CONNECTION;
const AZURE_CONTAINER  = process.env.AZURE_CONTAINER || 'vet-backups';
const MASTER_HOST      = process.env.MASTER_DB_HOST  || 'localhost';
const MASTER_PORT      = process.env.MASTER_DB_PORT  || '3306';
const MASTER_USER      = process.env.MASTER_DB_USER  || 'cadc';
const MASTER_PASS      = process.env.MASTER_DB_PASS  || '';
const MASTER_DB        = process.env.MASTER_DB_NAME  || 'vet_master';

// Retención por tipo
const RETENER = { diario: 7, semanal: 4, mensual: 3, manual: 5 };

function getAzureClient() {
  if (!AZURE_CONNECTION) throw new Error('AZURE_STORAGE_CONNECTION no configurado en .env');
  return BlobServiceClient.fromConnectionString(AZURE_CONNECTION);
}

/**
 * Backup de un tenant → Azure Blob
 */
async function backupTenant(tenant, tipo = 'manual') {
  const fecha    = new Date().toISOString().split('T')[0];
  const archivo  = `${tenant.db_name}_${tipo}_${fecha}.sql.gz`;
  const tempFile = path.join(os.tmpdir(), archivo);
  const blobPath = `${tenant.db_name}/${archivo}`;
  let backupId   = null;

  console.log(`[backup] Iniciando ${tenant.db_name} (${tipo})…`);

  const result = await masterQuery(
    `INSERT INTO tenant_backups (tenant_id, tenant_nombre, tipo, archivo, estado)
     VALUES (?,?,?,?,'en_proceso')`,
    [tenant.id, tenant.nombre_clinica || tenant.slug, tipo, archivo]
  );
  backupId = result.insertId;

  try {
    // 1 — mysqldump + gzip
    const dumpCmd = `mysqldump -h${tenant.db_host} -P${tenant.db_port} -u${tenant.db_user} -p${tenant.db_pass} --single-transaction --routines --triggers --add-drop-table --complete-insert ${tenant.db_name} | gzip -9 > ${tempFile}`;
    await execAsync(dumpCmd);

    const stats    = fs.statSync(tempFile);
    const tamañoMB = (stats.size / 1048576).toFixed(2);
    console.log(`[backup] Dump listo: ${archivo} (${tamañoMB} MB)`);

    // 2 — Subir a Azure
    const blobClient = getAzureClient()
      .getContainerClient(AZURE_CONTAINER)
      .getBlockBlobClient(blobPath);

    await blobClient.uploadStream(fs.createReadStream(tempFile), 4 * 1024 * 1024, 20, {
      blobHTTPHeaders: { blobContentType: 'application/gzip' },
      metadata: { tenant: tenant.db_name, tipo, fecha, tamano_mb: String(tamañoMB) },
    });

    const azureUrl = blobClient.url.split('?')[0];
    console.log(`[backup] Subido a Azure: ${blobPath}`);

    // 3 — Marcar como exitoso
    await masterQuery(
      `UPDATE tenant_backups SET estado='exitoso', tamaño_mb=?, drive_url=?, drive_id=? WHERE id=?`,
      [tamañoMB, azureUrl, blobPath, backupId]
    );

    // 4 — Limpiar blobs viejos
    await limpiarAzure(tenant.db_name, tipo);

    console.log(`[backup] ✅ ${tenant.db_name} completado`);
    return { success: true, archivo, tamañoMB, azureUrl };

  } catch (err) {
    console.error(`[backup] ❌ ${tenant.db_name}:`, err.message);
    await masterQuery(
      `UPDATE tenant_backups SET estado='fallido', error=? WHERE id=?`,
      [err.message.substring(0, 500), backupId]
    ).catch(() => {});
    return { success: false, error: err.message };
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

/**
 * Elimina blobs que superan la retención
 */
async function limpiarAzure(dbName, tipo) {
  try {
    const maxRetener = RETENER[tipo] || 7;
    const container  = getAzureClient().getContainerClient(AZURE_CONTAINER);
    const prefix     = `${dbName}/${dbName}_${tipo}_`;
    const blobs      = [];

    for await (const blob of container.listBlobsFlat({ prefix })) {
      blobs.push({ name: blob.name, fecha: blob.properties.lastModified });
    }

    blobs.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    for (const blob of blobs.slice(maxRetener)) {
      await container.getBlockBlobClient(blob.name).delete();
      console.log(`[backup] Eliminado blob antiguo: ${blob.name}`);
    }
  } catch (err) {
    console.warn(`[backup] Error limpiando Azure: ${err.message}`);
  }
}

/**
 * Backup de todos los tenants activos
 */
async function backupTodos(tipo = 'diario') {
  console.log(`[backup] === Backup ${tipo.toUpperCase()} iniciado ===`);

  const tenants = await masterQuery(
    `SELECT t.*, tc.nombre_clinica
     FROM tenants t
     LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
     LEFT JOIN tenant_backup_config tbc ON tbc.tenant_id = t.id
     WHERE t.activo = 1 AND (tbc.activo IS NULL OR tbc.activo = 1)`
  );

  let exitosos = 0, fallidos = 0;
  for (const tenant of tenants) {
    const r = await backupTenant(tenant, tipo);
    r.success ? exitosos++ : fallidos++;
  }

  // Backup de vet_master
  await backupMaster(tipo).catch(e => console.error('[backup] Error vet_master:', e.message));

  console.log(`[backup] === Completado: ${exitosos} ✅ ${fallidos} ❌ ===`);
  return { exitosos, fallidos };
}

/**
 * Backup de vet_master
 */
async function backupMaster(tipo = 'diario') {
  const fecha    = new Date().toISOString().split('T')[0];
  const archivo  = `vet_master_${tipo}_${fecha}.sql.gz`;
  const tempFile = path.join(os.tmpdir(), archivo);

  try {
    const cmd = `mysqldump -h${MASTER_HOST} -P${MASTER_PORT} -u${MASTER_USER} -p${MASTER_PASS} --single-transaction ${MASTER_DB} | gzip -9 > ${tempFile}`;
    await execAsync(cmd);

    const blobClient = getAzureClient()
      .getContainerClient(AZURE_CONTAINER)
      .getBlockBlobClient(`vet_master/${archivo}`);

    await blobClient.uploadStream(fs.createReadStream(tempFile), 4 * 1024 * 1024, 20);
    console.log(`[backup] ✅ vet_master respaldado`);
  } catch (err) {
    console.error(`[backup] ❌ Error vet_master:`, err.message);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

module.exports = { backupTenant, backupTodos, backupMaster, limpiarAzure };