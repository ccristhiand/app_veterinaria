-- ============================================================
-- VETCLINIC SaaS — BASE DE DATOS MAESTRA v2
-- mysql -u root -p < master_schema_v2.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS vet_master CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE vet_master;

-- Tabla de clientes (tenants)
CREATE TABLE IF NOT EXISTS tenants (
  id           INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  slug         VARCHAR(50)   NOT NULL UNIQUE,
  subdominio   VARCHAR(150)  NOT NULL UNIQUE,
  db_name      VARCHAR(100)  NOT NULL UNIQUE,
  db_host      VARCHAR(100)  NOT NULL DEFAULT 'localhost',
  db_port      SMALLINT      NOT NULL DEFAULT 3306,
  db_user      VARCHAR(100)  NOT NULL DEFAULT 'root',
  db_pass      VARCHAR(255)  NOT NULL DEFAULT '',
  plan         ENUM('basic','pro','enterprise') NOT NULL DEFAULT 'basic',
  activo       TINYINT(1)    NOT NULL DEFAULT 1,
  trial_hasta  DATE          NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_subdominio (subdominio),
  INDEX idx_slug       (slug),
  INDEX idx_activo     (activo)
) ENGINE=InnoDB;

-- Configuración visual y funcional por tenant
CREATE TABLE IF NOT EXISTS tenant_config (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id            INT UNSIGNED NOT NULL UNIQUE,
  -- Identidad
  nombre_clinica       VARCHAR(150) NOT NULL DEFAULT 'VetClinic',
  razon_social         VARCHAR(200) NULL,
  ruc                  VARCHAR(20)  NULL,
  direccion            VARCHAR(255) NULL,
  telefono             VARCHAR(30)  NULL,
  email                VARCHAR(100) NULL,
  web                  VARCHAR(100) NULL,
  -- Branding
  logo_url             VARCHAR(500) NULL,
  favicon_url          VARCHAR(500) NULL,
  color_primario       VARCHAR(7)   NOT NULL DEFAULT '#10b981',
  color_sidebar        VARCHAR(7)   NOT NULL DEFAULT '#0d3b2e',
  color_acento         VARCHAR(7)   NOT NULL DEFAULT '#059669',
  -- Regional
  moneda               VARCHAR(10)  NOT NULL DEFAULT 'PEN',
  simbolo_moneda       VARCHAR(5)   NOT NULL DEFAULT 'S/.',
  pais                 VARCHAR(50)  NOT NULL DEFAULT 'Peru',
  zona_horaria         VARCHAR(50)  NOT NULL DEFAULT 'America/Lima',
  igv_porcentaje       DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  -- Límite de usuarios
  max_usuarios         INT          NOT NULL DEFAULT 5,
  -- Módulos habilitados
  modulo_estetica      TINYINT(1)   NOT NULL DEFAULT 1,
  modulo_facturacion   TINYINT(1)   NOT NULL DEFAULT 1,
  modulo_inventario    TINYINT(1)   NOT NULL DEFAULT 1,
  modulo_vacunas       TINYINT(1)   NOT NULL DEFAULT 1,
  -- Facturación
  serie_boleta         VARCHAR(10)  NOT NULL DEFAULT 'B001',
  serie_factura        VARCHAR(10)  NOT NULL DEFAULT 'F001',
  pie_documento        TEXT         NULL,
  -- Timestamps
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Log de accesos por tenant
CREATE TABLE IF NOT EXISTS tenant_logs (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  INT UNSIGNED NOT NULL,
  evento     VARCHAR(100) NOT NULL,
  detalle    TEXT         NULL,
  ip         VARCHAR(45)  NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant  (tenant_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- Admin usuarios del panel SaaS
CREATE TABLE IF NOT EXISTS admin_usuarios (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre     VARCHAR(100) NOT NULL,
  email      VARCHAR(150) NOT NULL UNIQUE,
  password   VARCHAR(255) NOT NULL,
  rol        ENUM('superadmin','soporte') NOT NULL DEFAULT 'soporte',
  activo     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Admin por defecto (password: Admin1234! — cambiar después de instalar)
INSERT INTO admin_usuarios (nombre, email, password, rol)
VALUES ('Super Admin', 'admin@vetclinic.com',
  '$2b$10$rQnH8X5xY3kL9mN2pO6qRuT7vW1yZ4aB8cD0eF2gH4iJ6kL8mN0o', 'superadmin')
ON DUPLICATE KEY UPDATE id=id;

SELECT 'vet_master creada correctamente ✅' AS resultado;