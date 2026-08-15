-- ============================================================
-- VETNETCODIP SaaS — SCHEMA VET_MASTER v7
-- v5: + zona_horaria en tenant_config
-- v6: + integraciones RENIEC/SUNAT + tabla tenant_api_consumo
-- v7: + sistema de pagos SaaS completo
-- ============================================================

CREATE DATABASE IF NOT EXISTS vet_master
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE vet_master;

-- ── Tenants (clínicas) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id                INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  slug              VARCHAR(50)   NOT NULL UNIQUE,
  subdominio        VARCHAR(100)  NOT NULL UNIQUE,
  db_name           VARCHAR(64)   NOT NULL UNIQUE,
  db_host           VARCHAR(100)  NOT NULL DEFAULT 'localhost',
  db_port           INT           NOT NULL DEFAULT 3306,
  db_user           VARCHAR(64)   NOT NULL,
  db_pass           VARCHAR(255)  NOT NULL,
  plan              ENUM('basic','pro','enterprise') NOT NULL DEFAULT 'pro',
  activo            TINYINT(1)    NOT NULL DEFAULT 1,
  trial_hasta       DATE          NULL,
  motivo_suspension TEXT          NULL,
  suspended_at      TIMESTAMP     NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Configuración de cada tenant ─────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_config (
  id                     INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  tenant_id              INT UNSIGNED  NOT NULL UNIQUE,
  nombre_clinica         VARCHAR(150)  NOT NULL DEFAULT 'VetClinic',
  razon_social           VARCHAR(200)  NULL,
  ruc                    VARCHAR(20)   NULL,
  direccion              VARCHAR(255)  NULL,
  telefono               VARCHAR(30)   NULL,
  email                  VARCHAR(100)  NULL,
  web                    VARCHAR(100)  NULL,
  logo_url               VARCHAR(500)  NULL,
  favicon_url            VARCHAR(500)  NULL,
  color_primario         VARCHAR(7)    NOT NULL DEFAULT '#10b981',
  color_sidebar          VARCHAR(7)    NOT NULL DEFAULT '#0d3b2e',
  color_acento           VARCHAR(7)    NOT NULL DEFAULT '#059669',
  moneda                 VARCHAR(10)   NOT NULL DEFAULT 'PEN',
  simbolo_moneda         VARCHAR(5)    NOT NULL DEFAULT 'S/.',
  pais                   VARCHAR(50)   NOT NULL DEFAULT 'Peru',
  zona_horaria           VARCHAR(50)   NOT NULL DEFAULT 'America/Lima',
  integracion_reniec_activo  TINYINT(1)   NOT NULL DEFAULT 0,
  integracion_sunat_activo   TINYINT(1)   NOT NULL DEFAULT 0,
  apidoc_token               TEXT         NULL DEFAULT NULL,
  apidoc_token_exp           DATETIME     NULL DEFAULT NULL,
  igv_porcentaje         DECIMAL(5,2)  NOT NULL DEFAULT 18.00,
  max_usuarios           INT           NOT NULL DEFAULT 5,
  modulo_estetica        TINYINT(1)    NOT NULL DEFAULT 1,
  modulo_facturacion     TINYINT(1)    NOT NULL DEFAULT 1,
  modulo_inventario      TINYINT(1)    NOT NULL DEFAULT 1,
  modulo_vacunas         TINYINT(1)    NOT NULL DEFAULT 1,
  modulo_consentimientos TINYINT(1)    NOT NULL DEFAULT 1,
  modulo_carnet          TINYINT(1)    NOT NULL DEFAULT 1,
  serie_boleta           VARCHAR(10)   NOT NULL DEFAULT 'B001',
  serie_factura          VARCHAR(10)   NOT NULL DEFAULT 'F001',
  pie_documento          TEXT          NULL,
  motivo_suspension      TEXT          NULL,
  updated_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Administradores del panel SaaS ───────────────────────────
CREATE TABLE IF NOT EXISTS admin_usuarios (
  id         INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre     VARCHAR(100)  NOT NULL,
  email      VARCHAR(150)  NOT NULL UNIQUE,
  password   VARCHAR(255)  NOT NULL,
  rol        VARCHAR(50)   NOT NULL DEFAULT 'admin',
  activo     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Permisos por rol y módulo ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_permisos (
  id         INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  tenant_id  INT UNSIGNED  NOT NULL,
  rol        ENUM('admin','veterinario','recepcionista') NOT NULL,
  modulo     VARCHAR(50)   NOT NULL,
  permiso    VARCHAR(50)   NOT NULL,
  activo     TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_permiso (tenant_id, rol, modulo, permiso),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Logs de auditoría ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_logs (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT UNSIGNED    NULL,
  tenant_nombre  VARCHAR(100)    NULL,
  usuario_id     INT UNSIGNED    NULL,
  usuario_nombre VARCHAR(100)    NULL,
  usuario_rol    VARCHAR(50)     NULL,
  accion         VARCHAR(100)    NOT NULL,
  modulo         VARCHAR(50)     NOT NULL,
  metodo_http    VARCHAR(10)     NULL,
  endpoint       VARCHAR(255)    NULL,
  ip             VARCHAR(45)     NULL,
  user_agent     VARCHAR(500)    NULL,
  data_anterior  JSON            NULL,
  data_nueva     JSON            NULL,
  resultado      ENUM('exito','error') NOT NULL DEFAULT 'exito',
  error_mensaje  TEXT            NULL,
  duracion_ms    INT UNSIGNED    NULL,
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  id            INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  tenant_id     INT UNSIGNED  NULL,
  tenant_nombre VARCHAR(100)  NULL,
  tipo          ENUM('diario','semanal','mensual','manual') NOT NULL DEFAULT 'diario',
  archivo       VARCHAR(255)  NOT NULL,
  tamaño_mb     DECIMAL(8,2)  NULL,
  drive_url     VARCHAR(500)  NULL,
  drive_id      VARCHAR(200)  NULL,
  estado        ENUM('en_proceso','exitoso','fallido') NOT NULL DEFAULT 'en_proceso',
  error         TEXT          NULL,
  duracion_seg  INT UNSIGNED  NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id),
  INDEX idx_tipo   (tipo),
  INDEX idx_estado (estado),
  INDEX idx_fecha  (created_at)
) ENGINE=InnoDB;

-- ── Configuración de backups por tenant ───────────────────────
CREATE TABLE IF NOT EXISTS tenant_backup_config (
  id                INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  tenant_id         INT UNSIGNED  NOT NULL UNIQUE,
  activo            TINYINT(1)    NOT NULL DEFAULT 1,
  hora_backup       TIME          NOT NULL DEFAULT '02:00:00',
  retener_diarios   INT UNSIGNED  NOT NULL DEFAULT 7,
  retener_semanales INT UNSIGNED  NOT NULL DEFAULT 4,
  retener_mensuales INT UNSIGNED  NOT NULL DEFAULT 3,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Facturación Electrónica — documentos emitidos ─────────────
CREATE TABLE IF NOT EXISTS tenant_documentos_emitidos (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     INT UNSIGNED    NOT NULL,
  tenant_nombre VARCHAR(100)    NULL,
  tipo          ENUM('boleta','factura','nota_credito','baja') NOT NULL,
  numero        VARCHAR(25)     NOT NULL,
  fecha         DATE            NOT NULL,
  monto         DECIMAL(10,2)   NOT NULL DEFAULT 0,
  sunat_estado  VARCHAR(20)     NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant_fecha (tenant_id, fecha),
  INDEX idx_fecha        (fecha)
) ENGINE=InnoDB;

-- ── Facturación Electrónica — plan por tenant ─────────────────
CREATE TABLE IF NOT EXISTS tenant_plan_fe (
  tenant_id      INT UNSIGNED  NOT NULL PRIMARY KEY,
  docs_incluidos INT UNSIGNED  NOT NULL DEFAULT 50,
  docs_usados    INT UNSIGNED  NOT NULL DEFAULT 0,
  precio_extra   DECIMAL(6,4)  NOT NULL DEFAULT 0.05,
  mes_actual     CHAR(7)       NOT NULL DEFAULT (DATE_FORMAT(NOW(),'%Y-%m')),
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── WhatsApp — sesiones por tenant ───────────────────────────
CREATE TABLE IF NOT EXISTS wa_sesiones (
  id               INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  tenant_id        INT UNSIGNED  NOT NULL UNIQUE,
  tenant_nombre    VARCHAR(100)  NULL,
  estado           ENUM('desconectado','conectando','conectado','error') NOT NULL DEFAULT 'desconectado',
  numero_wa        VARCHAR(20)   NULL,
  ultima_conexion  TIMESTAMP     NULL,
  ultima_actividad TIMESTAMP     NULL,
  error_msg        TEXT          NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── WhatsApp — config y cuota global por tenant ───────────────
CREATE TABLE IF NOT EXISTS wa_config_global (
  tenant_id      INT UNSIGNED  NOT NULL PRIMARY KEY,
  activo         TINYINT(1)    NOT NULL DEFAULT 0,
  ilimitado      TINYINT(1)    NOT NULL DEFAULT 0,
  msgs_incluidos INT UNSIGNED  NOT NULL DEFAULT 100,
  msgs_usados    INT UNSIGNED  NOT NULL DEFAULT 0,
  mes_actual     CHAR(7)       NOT NULL DEFAULT (DATE_FORMAT(NOW(),'%Y-%m')),
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── WhatsApp — campañas (referencia global) ───────────────────
CREATE TABLE IF NOT EXISTS wa_campanas_global (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     INT UNSIGNED    NOT NULL,
  tenant_nombre VARCHAR(100)    NULL,
  nombre        VARCHAR(150)    NOT NULL,
  total         INT UNSIGNED    NOT NULL DEFAULT 0,
  enviados      INT UNSIGNED    NOT NULL DEFAULT 0,
  fallidos      INT UNSIGNED    NOT NULL DEFAULT 0,
  estado        ENUM('borrador','programada','enviando','pausada','completada','cancelada') NOT NULL DEFAULT 'borrador',
  programada_at TIMESTAMP       NULL,
  iniciada_at   TIMESTAMP       NULL,
  completada_at TIMESTAMP       NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id),
  INDEX idx_estado (estado)
) ENGINE=InnoDB;

-- ── Integración API Documentos (RENIEC/SUNAT) ─────────────────
CREATE TABLE IF NOT EXISTS tenant_api_consumo (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  INT UNSIGNED   NOT NULL,
  tipo       ENUM('dni','ruc') NOT NULL,
  fuente     ENUM('cache','api') NOT NULL DEFAULT 'api',
  numero     VARCHAR(20)    NOT NULL,
  created_at TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id),
  INDEX idx_fecha  (created_at)
) ENGINE=InnoDB;

-- ════════════════════════════════════════════════════════════
-- SISTEMA DE PAGOS SAAS (v7)
-- ════════════════════════════════════════════════════════════

-- ── Planes disponibles ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_planes (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  codigo           VARCHAR(30)   NOT NULL UNIQUE,
  nombre           VARCHAR(100)  NOT NULL,
  descripcion      TEXT          NULL,
  precio_mensual   DECIMAL(10,2) NOT NULL,
  moneda           VARCHAR(3)    NOT NULL DEFAULT 'PEN',
  max_usuarios     INT UNSIGNED  NOT NULL DEFAULT 5,
  max_mascotas     INT UNSIGNED  NOT NULL DEFAULT 500,
  modulos          JSON          NULL,
  wa_mensajes      INT UNSIGNED  NOT NULL DEFAULT 100,
  activo           TINYINT(1)    NOT NULL DEFAULT 1,
  orden            INT UNSIGNED  NOT NULL DEFAULT 0,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT IGNORE INTO saas_planes (codigo, nombre, descripcion, precio_mensual, max_usuarios, max_mascotas, wa_mensajes, orden) VALUES
('basico',      'Básico',      'Ideal para clínicas pequeñas',        80.00,  3,  300,  100, 1),
('profesional', 'Profesional', 'Para clínicas en crecimiento',        150.00, 8,  1000, 300, 2),
('clinica_pro', 'Clínica PRO', 'Solución completa multi-sede',        280.00, 20, 9999, 1000, 3);

-- ── Suscripciones por tenant ──────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_suscripciones (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id         INT UNSIGNED  NOT NULL UNIQUE,
  plan_id           INT UNSIGNED  NOT NULL,
  precio_acordado   DECIMAL(10,2) NOT NULL,
  moneda            VARCHAR(3)    NOT NULL DEFAULT 'PEN',
  ciclo             ENUM('mensual','trimestral','semestral','anual') NOT NULL DEFAULT 'mensual',
  fecha_inicio      DATE          NOT NULL,
  fecha_vencimiento DATE          NOT NULL,
  estado            ENUM('activa','vencida','cancelada','trial') NOT NULL DEFAULT 'activa',
  trial_dias        INT UNSIGNED  NOT NULL DEFAULT 0,
  notas_internas    TEXT          NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_id) REFERENCES saas_planes(id),
  INDEX idx_tenant      (tenant_id),
  INDEX idx_estado      (estado),
  INDEX idx_vencimiento (fecha_vencimiento)
) ENGINE=InnoDB;

-- ── Cobros generados ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_cobros (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id         INT UNSIGNED  NOT NULL,
  suscripcion_id    INT UNSIGNED  NOT NULL,
  periodo           VARCHAR(7)    NOT NULL,
  meses             TINYINT       NOT NULL DEFAULT 1,
  monto_base        DECIMAL(10,2) NOT NULL,
  descuento_pct     DECIMAL(5,2)  NOT NULL DEFAULT 0,
  monto_final       DECIMAL(10,2) NOT NULL,
  estado            ENUM('pendiente','pagado','vencido','anulado') NOT NULL DEFAULT 'pendiente',
  fecha_emision     DATE          NOT NULL,
  fecha_vencimiento DATE          NOT NULL,
  fecha_pago        DATE          NULL,
  numero_cobro      VARCHAR(20)   NOT NULL,
  notas             TEXT          NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_cobro (tenant_id, periodo),
  FOREIGN KEY (suscripcion_id) REFERENCES saas_suscripciones(id),
  INDEX idx_tenant  (tenant_id),
  INDEX idx_estado  (estado),
  INDEX idx_periodo (periodo)
) ENGINE=InnoDB;

-- ── Pagos realizados por el cliente ──────────────────────────
CREATE TABLE IF NOT EXISTS saas_pagos (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          INT UNSIGNED  NOT NULL,
  cobro_id           INT UNSIGNED  NOT NULL,
  monto              DECIMAL(10,2) NOT NULL,
  moneda             VARCHAR(3)    NOT NULL DEFAULT 'PEN',
  metodo             ENUM('yape','plin','transferencia','deposito','efectivo','otro') NOT NULL,
  numero_operacion   VARCHAR(100)  NULL,
  banco_origen       VARCHAR(100)  NULL,
  fecha_operacion    DATE          NOT NULL,
  estado             ENUM('pendiente_validacion','aprobado','rechazado') NOT NULL DEFAULT 'pendiente_validacion',
  motivo_rechazo     TEXT          NULL,
  aprobado_por       INT UNSIGNED  NULL,
  fecha_aprobacion   DATETIME      NULL,
  numero_comprobante VARCHAR(20)   NULL,
  notas_cliente      TEXT          NULL,
  notas_admin        TEXT          NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (cobro_id) REFERENCES saas_cobros(id),
  INDEX idx_tenant (tenant_id),
  INDEX idx_cobro  (cobro_id),
  INDEX idx_estado (estado)
) ENGINE=InnoDB;

-- ── Comprobantes subidos (archivos) ──────────────────────────
CREATE TABLE IF NOT EXISTS saas_comprobantes (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  pago_id        INT UNSIGNED  NOT NULL,
  tenant_id      INT UNSIGNED  NOT NULL,
  tipo           ENUM('comprobante_cliente','comprobante_sistema') NOT NULL,
  nombre_archivo VARCHAR(255)  NOT NULL,
  url_blob       VARCHAR(500)  NOT NULL,
  mime_type      VARCHAR(100)  NULL,
  tamanio_bytes  INT UNSIGNED  NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pago_id) REFERENCES saas_pagos(id) ON DELETE CASCADE,
  INDEX idx_pago   (pago_id),
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB;

-- ── Log de emails enviados ────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_emails_log (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    INT UNSIGNED  NULL,
  tipo         VARCHAR(50)   NOT NULL,
  destinatario VARCHAR(150)  NOT NULL,
  asunto       VARCHAR(255)  NOT NULL,
  estado       ENUM('enviado','fallido') NOT NULL DEFAULT 'enviado',
  error        TEXT          NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id),
  INDEX idx_tipo   (tipo)
) ENGINE=InnoDB;

-- ── Usuarios del portal de pagos ─────────────────────────────
CREATE TABLE IF NOT EXISTS saas_portal_usuarios (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT UNSIGNED  NOT NULL UNIQUE,
  nombre         VARCHAR(150)  NOT NULL,
  email          VARCHAR(150)  NOT NULL UNIQUE,
  password       VARCHAR(255)  NOT NULL,
  activo         TINYINT(1)    NOT NULL DEFAULT 1,
  ultimo_acceso  DATETIME      NULL,
  reset_token    VARCHAR(100)  NULL,
  reset_expires  DATETIME      NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email  (email),
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB;

-- ── Configuración de pagos del SaaS ──────────────────────────
CREATE TABLE IF NOT EXISTS saas_config (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  clave       VARCHAR(100)  NOT NULL UNIQUE,
  valor       TEXT          NOT NULL,
  descripcion VARCHAR(255)  NULL,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT IGNORE INTO saas_config (clave, valor, descripcion) VALUES
('yape_numero',       '999999999',          'Número Yape para pagos'),
('yape_nombre',       'VetNetcodip SAC',     'Nombre en Yape'),
('banco_nombre',      'BCP',                 'Banco para transferencias'),
('banco_cuenta',      '123-456789-0-12',     'Número de cuenta'),
('banco_cci',         '00212312345678901234','CCI interbancario'),
('banco_titular',     'VetNetcodip SAC',     'Titular de la cuenta'),
('dias_gracia',       '5',                   'Días de gracia tras vencimiento'),
('smtp_host',         'smtp.gmail.com',      'Servidor SMTP'),
('smtp_port',         '587',                 'Puerto SMTP'),
('smtp_user',         '',                    'Usuario SMTP'),
('smtp_pass',         '',                    'Password SMTP'),
('smtp_from',         'pagos@netcodip.com',  'Email remitente'),
('empresa_nombre',    'VetNetcodip SAC',     'Nombre de la empresa'),
('empresa_ruc',       '20000000000',         'RUC de la empresa'),
('empresa_direccion', 'Lima, Perú',          'Dirección fiscal');

-- ── Auditoría de acciones admin ───────────────────────────────
CREATE TABLE IF NOT EXISTS saas_auditoria (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id    INT UNSIGNED  NULL,
  accion      VARCHAR(100)  NOT NULL,
  entidad     VARCHAR(50)   NULL,
  entidad_id  INT UNSIGNED  NULL,
  detalle     JSON          NULL,
  ip          VARCHAR(45)   NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin  (admin_id),
  INDEX idx_accion (accion)
) ENGINE=InnoDB;

-- ════════════════════════════════════════════════════════════
-- TRIGGER — inicialización automática al crear tenant
-- ════════════════════════════════════════════════════════════
DROP TRIGGER IF EXISTS after_tenant_insert;
DELIMITER $$
CREATE TRIGGER after_tenant_insert
  AFTER INSERT ON tenants
  FOR EACH ROW
BEGIN
  INSERT IGNORE INTO tenant_backup_config (tenant_id) VALUES (NEW.id);
  INSERT IGNORE INTO tenant_plan_fe (tenant_id) VALUES (NEW.id);
  INSERT IGNORE INTO wa_sesiones (tenant_id) VALUES (NEW.id);
  INSERT IGNORE INTO wa_config_global (tenant_id) VALUES (NEW.id);
END$$
DELIMITER ;

SET GLOBAL event_scheduler = ON;

SELECT '✅ Schema vet_master v7 creado correctamente' AS resultado;