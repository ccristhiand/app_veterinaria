#!/usr/bin/env node
'use strict';

/**
 * VetClinic SaaS — Script de creación de tenant (consola)
 * Hace lo mismo que el panel admin (POST /admin/api/tenants), salvo la parte de cobros:
 * la suscripción y el usuario del portal de pagos se gestionan desde el panel admin.
 *
 * Uso (desde cualquier carpeta):
 *   node backend/src/config/scripts/crear-tenant.js
 *
 * O con argumentos:
 *   node backend/src/config/scripts/crear-tenant.js \
 *     --subdominio=aurora            (o aurora.netcodip.com) \
 *     --nombre="Clínica Aurora" \
 *     --admin-email=admin@aurora.com \
 *     --admin-pass='Admin1234!' \
 *     --admin-nombre="Ana Pérez" \
 *     --plan=pro
 *
 * El admin inicial queda con must_change_password = 1: cambia la contraseña al entrar.
 * Si algo falla a mitad de camino, se borra la base creada y los registros de vet_master.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const fs       = require('fs');
const mysql    = require('mysql2/promise');
const bcrypt   = require('bcryptjs');
const readline = require('readline');

const SCHEMA_PATH = path.join(__dirname, '../../../sql/tenant_schema.sql');

// Parsear argumentos CLI (--clave=valor; el valor puede contener '=')
const args = {};
process.argv.slice(2).forEach(arg => {
  const m = arg.match(/^--([^=]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
});

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// Misma conexión que usa el panel admin para crear la BD de la clínica
const dbCfg = {
  host    : process.env.DB_HOST || 'localhost',
  port    : parseInt(process.env.DB_PORT || '3306', 10),
  user    : process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
};

async function main() {
  console.log('\n🐾 VetClinic SaaS — Crear nueva clínica\n');

  const subdominio  = args['subdominio']   || await prompt('Subdominio (ej: aurora o aurora.netcodip.com): ');
  const nombre      = args['nombre']       || await prompt('Nombre de la clínica: ');
  const adminEmail  = args['admin-email']  || await prompt('Email del administrador: ');
  const adminPass   = args['admin-pass']   || await prompt('Password del administrador (mín. 8): ');
  const adminNombre = args['admin-nombre'] || await prompt('Nombre del administrador [Administrador]: ') || 'Administrador';
  const plan        = args['plan'] || 'pro';

  if (!subdominio || !nombre) throw new Error('Subdominio y nombre de la clínica son obligatorios.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) throw new Error('Email del administrador inválido.');
  if (String(adminPass).length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
  if (!['basic', 'pro', 'enterprise'].includes(plan)) throw new Error('Plan inválido: usa basic, pro o enterprise.');

  // Igual que el panel admin: slug y BD salen de la primera parte del subdominio
  const slug           = subdominio.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '_');
  const dbName         = `vet_${slug}`;
  const dominioBase    = process.env.SAAS_DOMAIN || 'netcodip.com';
  const subdominioFull = subdominio.includes('.') ? subdominio.toLowerCase() : `${subdominio.toLowerCase()}.${dominioBase}`;

  console.log(`\n📋 Resumen:\n  Clínica:    ${nombre}\n  Slug:       ${slug}\n  BD:         ${dbName}\n  Subdominio: ${subdominioFull}\n  Admin:      ${adminEmail}\n  Plan:       ${plan}\n`);

  if (!args['subdominio']) {
    const ok = await prompt('¿Crear la clínica? (s/N): ');
    if (!/^s/i.test(ok)) { console.log('Cancelado.'); return; }
  }

  const master = await mysql.createConnection({
    host    : process.env.MASTER_DB_HOST || dbCfg.host,
    port    : parseInt(process.env.MASTER_DB_PORT || String(dbCfg.port), 10),
    user    : process.env.MASTER_DB_USER || dbCfg.user,
    password: process.env.MASTER_DB_PASS || dbCfg.password,
    database: process.env.MASTER_DB_NAME || 'vet_master',
  });

  let bdCreada = false;
  let tenantId = null;

  try {
    // 1. No debe existir ni en vet_master ni como base de datos
    console.log('1️⃣  Verificando que no exista…');
    const [[existente]] = await master.execute(
      'SELECT id FROM tenants WHERE slug = ? OR subdominio = ? OR db_name = ?', [slug, subdominioFull, dbName]
    );
    if (existente) throw new Error('Ese subdominio ya está registrado en vet_master.');

    const root = await mysql.createConnection(dbCfg);
    try {
      const [bds] = await root.query('SHOW DATABASES LIKE ?', [dbName]);
      if (bds.length) throw new Error(`La base de datos ${dbName} ya existe. Revísala o bórrala antes de continuar.`);

      // 2. Crear BD
      console.log(`2️⃣  Creando base de datos ${dbName}…`);
      await root.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      bdCreada = true;
    } finally {
      await root.end();
    }

    // 3. Schema (incluye sede principal, empresa_config, servicios, wa_config,
    //    plantillas de WhatsApp y el cliente "Público General")
    console.log('3️⃣  Aplicando schema base…');
    if (!fs.existsSync(SCHEMA_PATH)) throw new Error(`No se encontró el schema en: ${SCHEMA_PATH}`);
    const tenant = await mysql.createConnection({ ...dbCfg, database: dbName, multipleStatements: true });
    try {
      await tenant.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));

      // 4. Admin inicial y datos de la empresa
      console.log('4️⃣  Creando usuario administrador…');
      await tenant.execute(
        "INSERT INTO usuarios (nombre, email, password, rol, must_change_password) VALUES (?,?,?,'admin',1)",
        [adminNombre, adminEmail.toLowerCase(), await bcrypt.hash(adminPass, 10)]
      );
      await tenant.execute('UPDATE empresa_config SET nombre = ? WHERE id = 1', [nombre]);
    } finally {
      await tenant.end();
    }

    // 5. Registrar en vet_master (igual que el panel admin)
    console.log('5️⃣  Registrando en vet_master…');
    const [r] = await master.execute(
      `INSERT INTO tenants (slug, subdominio, db_name, db_host, db_port, db_user, db_pass, plan)
       VALUES (?,?,?,?,?,?,?,?)`,
      [slug, subdominioFull, dbName, dbCfg.host, dbCfg.port, dbCfg.user, dbCfg.password, plan]
    );
    tenantId = r.insertId;

    await master.execute(
      `INSERT INTO tenant_config (tenant_id, nombre_clinica) VALUES (?,?)`, [tenantId, nombre]
    );
    await master.execute(
      'INSERT IGNORE INTO tenant_backup_config (tenant_id) VALUES (?)', [tenantId]
    ).catch(() => {});

    console.log(`\n✅ Clínica "${nombre}" creada (id ${tenantId}).\n`);
    console.log(`   🌐 URL:   https://${subdominioFull}`);
    console.log(`   🗄️  BD:    ${dbName}`);
    console.log(`   👤 Admin: ${adminEmail} (debe cambiar la contraseña al entrar)\n`);
    console.log('   Pendiente en el panel admin: suscripción / cobros y, si aplica, WhatsApp.\n');

  } catch (err) {
    // Deshacer lo creado para poder reintentar con el mismo subdominio
    if (tenantId) {
      await master.execute('DELETE FROM tenant_backup_config WHERE tenant_id = ?', [tenantId]).catch(() => {});
      await master.execute('DELETE FROM tenant_config WHERE tenant_id = ?', [tenantId]).catch(() => {});
      await master.execute('DELETE FROM tenants WHERE id = ?', [tenantId]).catch(() => {});
    }
    if (bdCreada) {
      const root = await mysql.createConnection(dbCfg).catch(() => null);
      if (root) {
        await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``).catch(() => {});
        await root.end();
      }
    }
    throw err;
  } finally {
    await master.end();
  }
}

main().catch(err => {
  console.error(`\n❌ Error: ${err.message}\n`);
  process.exit(1);
});
