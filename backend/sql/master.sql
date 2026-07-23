-- ============================================================
-- VETCLINIC SaaS — SCHEMA VET_MASTER v3
-- Base de datos maestra que orquesta todos los tenants
-- ============================================================

CREATE DATABASE IF NOT EXISTS vet_master
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE vet_master;

-- ── Tenants (clínicas) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id               INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  slug             VARCHAR(50)     NOT NULL UNIQUE,
  subdominio       VARCHAR(100)    NOT NULL UNIQUE,
  db_name          VARCHAR(64)     NOT NULL UNIQUE,
  db_host          VARCHAR(100)    NOT NULL DEFAULT 'localhost',
  db_port          INT             NOT NULL DEFAULT 3306,
  db_user          VARCHAR(64)     NOT NULL,
  db_pass          VARCHAR(255)    NOT NULL,
  plan             ENUM('basic','pro','enterprise') NOT NULL DEFAULT 'pro',
  activo           TINYINT(1)      NOT NULL DEFAULT 1,
  trial_hasta      DATE            NULL,
  motivo_suspension TEXT           NULL,
  suspended_at     TIMESTAMP       NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Configuración de cada tenant ─────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_config (
  id               INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  tenant_id        INT UNSIGNED    NOT NULL UNIQUE,
  nombre_clinica   VARCHAR(150)    NOT NULL DEFAULT 'VetClinic',
  razon_social     VARCHAR(200)    NULL,
  ruc              VARCHAR(20)     NULL,
  direccion        VARCHAR(255)    NULL,
  telefono         VARCHAR(30)     NULL,
  email            VARCHAR(100)    NULL,
  web              VARCHAR(100)    NULL,
  logo_url         VARCHAR(500)    NULL,
  favicon_url      VARCHAR(500)    NULL,
  color_primario   VARCHAR(7)      NOT NULL DEFAULT '#10b981',
  color_sidebar    VARCHAR(7)      NOT NULL DEFAULT '#0d3b2e',
  color_acento     VARCHAR(7)      NOT NULL DEFAULT '#059669',
  moneda           VARCHAR(10)     NOT NULL DEFAULT 'PEN',
  simbolo_moneda   VARCHAR(5)      NOT NULL DEFAULT 'S/.',
  pais             VARCHAR(50)     NOT NULL DEFAULT 'Peru',
  zona_horaria     VARCHAR(50)     NOT NULL DEFAULT 'America/Lima',
  igv_porcentaje   DECIMAL(5,2)    NOT NULL DEFAULT 18.00,
  max_usuarios     INT             NOT NULL DEFAULT 5,
  modulo_estetica       TINYINT(1) NOT NULL DEFAULT 1,
  modulo_facturacion    TINYINT(1) NOT NULL DEFAULT 1,
  modulo_inventario     TINYINT(1) NOT NULL DEFAULT 1,
  modulo_vacunas        TINYINT(1) NOT NULL DEFAULT 1,
  modulo_consentimientos TINYINT(1) NOT NULL DEFAULT 1,
  modulo_carnet         TINYINT(1) NOT NULL DEFAULT 1,
  serie_boleta     VARCHAR(10)     NOT NULL DEFAULT 'B001',
  serie_factura    VARCHAR(10)     NOT NULL DEFAULT 'F001',
  pie_documento    TEXT            NULL,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Administradores del panel SaaS ───────────────────────────
CREATE TABLE IF NOT EXISTS admin_usuarios (
  id         INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  nombre     VARCHAR(100)    NOT NULL,
  email      VARCHAR(150)    NOT NULL UNIQUE,
  password   VARCHAR(255)    NOT NULL,
  rol        VARCHAR(50)     NOT NULL DEFAULT 'admin',
  activo     TINYINT(1)      NOT NULL DEFAULT 1,
  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Permisos por rol y módulo ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_permisos (
  id         INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  tenant_id  INT UNSIGNED    NOT NULL,
  rol        ENUM('admin','veterinario','recepcionista') NOT NULL,
  modulo     VARCHAR(50)     NOT NULL,
  permiso    VARCHAR(50)     NOT NULL,
  activo     TINYINT(1)      NOT NULL DEFAULT 1,
  updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_permiso (tenant_id, rol, modulo, permiso),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Logs de auditoría ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_logs (
  id              BIGINT UNSIGNED   AUTO_INCREMENT PRIMARY KEY,
  tenant_id       INT UNSIGNED      NULL,
  tenant_nombre   VARCHAR(100)      NULL,
  usuario_id      INT UNSIGNED      NULL,
  usuario_nombre  VARCHAR(100)      NULL,
  usuario_rol     VARCHAR(50)       NULL,
  accion          VARCHAR(100)      NOT NULL,
  modulo          VARCHAR(50)       NOT NULL,
  metodo_http     VARCHAR(10)       NULL,
  endpoint        VARCHAR(255)      NULL,
  ip              VARCHAR(45)       NULL,
  user_agent      VARCHAR(500)      NULL,
  data_anterior   JSON              NULL,
  data_nueva      JSON              NULL,
  resultado       ENUM('exito','error') NOT NULL DEFAULT 'exito',
  error_mensaje   TEXT              NULL,
  duracion_ms     INT UNSIGNED      NULL,
  created_at      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_tenant   (tenant_id),
  INDEX idx_fecha    (created_at),
  INDEX idx_accion   (accion),
  INDEX idx_modulo   (modulo),
  INDEX idx_usuario  (usuario_id),
  INDEX idx_resultado(resultado)
) ENGINE=InnoDB;

-- Limpieza automática de logs cada 90 días
DROP EVENT IF EXISTS limpiar_logs_antiguos;
CREATE EVENT limpiar_logs_antiguos
  ON SCHEDULE EVERY 1 DAY STARTS CURRENT_TIMESTAMP
  DO DELETE FROM tenant_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);

-- ── Backups ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_backups (
  id            INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  tenant_id     INT UNSIGNED    NULL,
  tenant_nombre VARCHAR(100)    NULL,
  tipo          ENUM('diario','semanal','mensual','manual') NOT NULL DEFAULT 'diario',
  archivo       VARCHAR(255)    NOT NULL,
  tamaño_mb     DECIMAL(8,2)   NULL,
  drive_url     VARCHAR(500)   NULL,
  drive_id      VARCHAR(200)   NULL,
  estado        ENUM('en_proceso','exitoso','fallido') NOT NULL DEFAULT 'en_proceso',
  error         TEXT           NULL,
  duracion_seg  INT UNSIGNED   NULL,
  created_at    TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_tenant (tenant_id),
  INDEX idx_tipo   (tipo),
  INDEX idx_estado (estado),
  INDEX idx_fecha  (created_at)
) ENGINE=InnoDB;

-- ── Configuración de backups por tenant ───────────────────────
CREATE TABLE IF NOT EXISTS tenant_backup_config (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id         INT UNSIGNED NOT NULL UNIQUE,
  activo            TINYINT(1)  NOT NULL DEFAULT 1,
  hora_backup       TIME        NOT NULL DEFAULT '02:00:00',
  retener_diarios   INT UNSIGNED NOT NULL DEFAULT 7,
  retener_semanales INT UNSIGNED NOT NULL DEFAULT 4,
  retener_mensuales INT UNSIGNED NOT NULL DEFAULT 3,
  updated_at        TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

SET GLOBAL event_scheduler = ON;

SELECT 'Schema vet_master v3 creado ✅' AS resultado;