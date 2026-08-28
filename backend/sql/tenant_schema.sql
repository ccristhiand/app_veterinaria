-- ============================================================
-- VETNETCODIP SaaS — TENANT SCHEMA v10
-- v6: + sedes (multi-sedes) + sede_id en tablas operativas
-- v7: + tipo_documento en propietarios + historia_seguimientos + estetica_fotos
-- v8: + pruebas_complementarias en historia_clinica
--     + eutanasia + internamiento en servicios_catalogo
--     + consentimientos_plantillas + consentimientos_generados
-- v9: + descuento_pct / descuento_monto en factura_items
--     + subtotal_bruto / descuento_items / descuento_global /
--       descuento_global_pct / comision_tarjeta / comision_tarjeta_pct en facturas
-- v10: + turnos y asistencias (módulo de asistencia del personal)
-- Ejecutar al crear nueva clinica
-- Compatible MySQL 5.7+ / MySQL 8+
-- ============================================================

-- ── Tabla de sedes ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sedes (
  id           INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre       VARCHAR(150)  NOT NULL,
  direccion    VARCHAR(255)  NULL,
  telefono     VARCHAR(30)   NULL,
  email        VARCHAR(100)  NULL,
  ciudad       VARCHAR(100)  NULL,
  activo       TINYINT(1)    NOT NULL DEFAULT 1,
  es_principal TINYINT(1)    NOT NULL DEFAULT 0,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO sedes (nombre, es_principal, activo) VALUES ('Sede Principal', 1, 1);

-- ── Usuarios ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre               VARCHAR(100) NOT NULL,
  email                VARCHAR(150) NOT NULL UNIQUE,
  password             VARCHAR(255) NOT NULL,
  rol                  ENUM('admin','veterinario','recepcionista') NOT NULL DEFAULT 'recepcionista',
  sede_id              INT UNSIGNED NULL DEFAULT NULL,
  activo               TINYINT(1)   NOT NULL DEFAULT 1,
  must_change_password TINYINT(1)   NOT NULL DEFAULT 1,
  last_password_change TIMESTAMP    NULL DEFAULT NULL,
  created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sede (sede_id)
) ENGINE=InnoDB;

-- ── Propietarios ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS propietarios (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tipo_documento   ENUM('DNI','RUC','CE','PASAPORTE','OTRO') NOT NULL DEFAULT 'DNI',
  nombre           VARCHAR(100) NOT NULL,
  apellido         VARCHAR(100) NOT NULL,
  dni              VARCHAR(20)  NULL,
  telefono         VARCHAR(30)  NULL,
  email            VARCHAR(150) NULL,
  direccion        VARCHAR(255) NULL,
  ruc              VARCHAR(20)  NULL,
  razon_social     VARCHAR(200) NULL,
  direccion_fiscal VARCHAR(255) NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Mascotas ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mascotas (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  propietario_id   INT UNSIGNED NOT NULL,
  nombre           VARCHAR(100) NOT NULL,
  especie          VARCHAR(50)  NOT NULL,
  raza             VARCHAR(100) NULL,
  sexo             ENUM('macho','hembra','desconocido') NOT NULL DEFAULT 'desconocido',
  fecha_nacimiento DATE         NULL,
  peso_kg          DECIMAL(6,2) NULL,
  color            VARCHAR(100) NULL,
  microchip        VARCHAR(100) NULL,
  alergias         TEXT         NULL,
  alertas_medicas  TEXT         NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (propietario_id) REFERENCES propietarios(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ── Citas ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS citas (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mascota_id     INT UNSIGNED NOT NULL,
  veterinario_id INT UNSIGNED NOT NULL,
  creada_por_id  INT UNSIGNED NOT NULL,
  sede_id        INT UNSIGNED NULL DEFAULT NULL,
  fecha_hora     DATETIME     NOT NULL,
  duracion_min   SMALLINT     NOT NULL DEFAULT 30,
  motivo         VARCHAR(255) NOT NULL,
  tipo_cita      ENUM('medica','vacuna','desparasitacion','estetica') NOT NULL DEFAULT 'medica' COMMENT 'Tipo de atencion para redireccion automatica',
  notas          TEXT         NULL,
  estado         ENUM('pendiente','confirmada','en_curso','completada','cancelada') NOT NULL DEFAULT 'pendiente',
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id) ON DELETE RESTRICT,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (creada_por_id)  REFERENCES usuarios(id) ON DELETE RESTRICT,
  INDEX idx_fecha  (fecha_hora),
  INDEX idx_estado (estado),
  INDEX idx_sede   (sede_id)
) ENGINE=InnoDB;

-- ── Historia clínica ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS historia_clinica (
  id                      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mascota_id              INT UNSIGNED NOT NULL,
  veterinario_id          INT UNSIGNED NOT NULL,
  cita_id                 INT UNSIGNED NULL,
  fecha                   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  motivo                  VARCHAR(255) NOT NULL,
  anamnesis               TEXT         NULL,
  exploracion             TEXT         NULL,
  diagnostico             TEXT         NULL,
  tratamiento             TEXT         NULL,
  pruebas_complementarias MEDIUMTEXT   NULL,
  observaciones           TEXT         NULL,
  peso_kg                 DECIMAL(6,2) NULL,
  temperatura_c           DECIMAL(4,1) NULL,
  created_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id) ON DELETE RESTRICT,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (cita_id)        REFERENCES citas(id)    ON DELETE SET NULL,
  INDEX idx_mascota (mascota_id)
) ENGINE=InnoDB;

-- ── Seguimientos de consulta ─────────────────────────────────
CREATE TABLE IF NOT EXISTS historia_seguimientos (
  id             INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  historia_id    INT UNSIGNED  NOT NULL,
  veterinario_id INT UNSIGNED  NOT NULL,
  fecha          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  evolucion      TEXT          NOT NULL,
  tratamiento    TEXT          NULL,
  observaciones  TEXT          NULL,
  peso_kg        DECIMAL(6,2)  NULL,
  temperatura_c  DECIMAL(4,1)  NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (historia_id)    REFERENCES historia_clinica(id) ON DELETE CASCADE,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id)         ON DELETE RESTRICT,
  INDEX idx_historia (historia_id)
) ENGINE=InnoDB;

-- ── Recetas ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recetas (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  historia_clinica_id INT UNSIGNED NOT NULL,
  medicamento         VARCHAR(200) NOT NULL,
  dosis               VARCHAR(100) NOT NULL,
  frecuencia          VARCHAR(100) NOT NULL,
  duracion_dias       TINYINT      NULL,
  instrucciones       TEXT         NULL,
  FOREIGN KEY (historia_clinica_id) REFERENCES historia_clinica(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Vacunas ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vacunas (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mascota_id       INT UNSIGNED NOT NULL,
  veterinario_id   INT UNSIGNED NOT NULL,
  nombre           VARCHAR(150) NOT NULL,
  fabricante       VARCHAR(100) NULL,
  lote             VARCHAR(100) NULL,
  fecha_aplicacion DATE         NOT NULL,
  proxima_dosis    DATE         NULL,
  notas            TEXT         NULL,
  notificado       TINYINT(1)   NOT NULL DEFAULT 0,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id) ON DELETE RESTRICT,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  INDEX idx_mascota (mascota_id),
  INDEX idx_proxima (proxima_dosis)
) ENGINE=InnoDB;

-- ── Desparasitaciones ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS desparasitaciones (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mascota_id       INT UNSIGNED NOT NULL,
  veterinario_id   INT UNSIGNED NOT NULL,
  tipo             ENUM('interna','externa','interna_externa') NOT NULL DEFAULT 'interna',
  producto         VARCHAR(150) NOT NULL,
  dosis            VARCHAR(100) NULL,
  fecha_aplicacion DATE         NOT NULL,
  proxima_dosis    DATE         NULL,
  notas            TEXT         NULL,
  notificado       TINYINT(1)   NOT NULL DEFAULT 0,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id) ON DELETE RESTRICT,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  INDEX idx_mascota (mascota_id),
  INDEX idx_proxima (proxima_dosis),
  INDEX idx_notif   (notificado)
) ENGINE=InnoDB;

-- ── Inventario ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventario (
  id                INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre            VARCHAR(200)  NOT NULL,
  categoria         ENUM('medicamento','vacuna','insumo','otro') NOT NULL DEFAULT 'medicamento',
  descripcion       TEXT          NULL,
  cantidad          DECIMAL(10,2) NOT NULL DEFAULT 0,
  unidad            VARCHAR(30)   NOT NULL DEFAULT 'unidad',
  precio_unitario   DECIMAL(10,2) NULL,
  proveedor         VARCHAR(150)  NULL,
  stock_minimo      DECIMAL(10,2) NOT NULL DEFAULT 5,
  fecha_vencimiento DATE          NULL,
  sede_id           INT UNSIGNED  NULL DEFAULT NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sede (sede_id)
) ENGINE=InnoDB;

-- ── Estética ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS servicios_estetica (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mascota_id      INT UNSIGNED NOT NULL,
  atendido_por_id INT UNSIGNED NOT NULL,
  cita_id         INT UNSIGNED NULL,
  fecha           DATE         NOT NULL,
  tipo_bano       ENUM('basico','completo','medicado','deslanado') NOT NULL DEFAULT 'basico',
  incluye_corte   TINYINT(1)   NOT NULL DEFAULT 0,
  incluye_unas    TINYINT(1)   NOT NULL DEFAULT 0,
  incluye_dental  TINYINT(1)   NOT NULL DEFAULT 0,
  productos       VARCHAR(255) NULL,
  precio          DECIMAL(8,2) NULL,
  observaciones   TEXT         NULL,
  sede_id         INT UNSIGNED NULL DEFAULT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mascota_id)      REFERENCES mascotas(id) ON DELETE RESTRICT,
  FOREIGN KEY (atendido_por_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (cita_id)         REFERENCES citas(id)    ON DELETE SET NULL,
  INDEX idx_sede (sede_id)
) ENGINE=InnoDB;

-- ── Fotos de estética ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estetica_fotos (
  id             INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  estetica_id    INT UNSIGNED  NOT NULL,
  momento        ENUM('antes','despues') NOT NULL,
  url            VARCHAR(500)  NOT NULL,
  nombre_archivo VARCHAR(200)  NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (estetica_id) REFERENCES servicios_estetica(id) ON DELETE CASCADE,
  INDEX idx_estetica (estetica_id)
) ENGINE=InnoDB;

-- ── Notificaciones ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notificaciones (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT UNSIGNED NULL,
  tipo       VARCHAR(50)  NOT NULL,
  titulo     VARCHAR(200) NOT NULL,
  mensaje    TEXT         NULL,
  leida      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_usuario (usuario_id),
  INDEX idx_leida   (leida)
) ENGINE=InnoDB;

-- ── Catálogo de servicios ────────────────────────────────────
CREATE TABLE IF NOT EXISTS servicios_catalogo (
  id          INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(150)  NOT NULL,
  categoria   ENUM('consulta','vacunacion','estetica','cirugia','laboratorio','medicamento','otro','eutanasia','internamiento') NOT NULL DEFAULT 'consulta',
  precio      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  descripcion VARCHAR(255)  NULL,
  activo      TINYINT(1)    NOT NULL DEFAULT 1,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Empresa config ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS empresa_config (
  id                 INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre             VARCHAR(150)  NOT NULL DEFAULT 'VetClinic',
  razon_social       VARCHAR(200)  NULL,
  ruc                VARCHAR(20)   NULL,
  direccion          VARCHAR(255)  NULL,
  distrito           VARCHAR(100)  NULL,
  ciudad             VARCHAR(100)  NULL DEFAULT 'Lima',
  telefono           VARCHAR(30)   NULL,
  email              VARCHAR(100)  NULL,
  web                VARCHAR(100)  NULL,
  logo_url           VARCHAR(500)  NULL,
  moneda             VARCHAR(10)   NOT NULL DEFAULT 'PEN',
  simbolo_moneda     VARCHAR(10)   NOT NULL DEFAULT 'S/.',
  igv_porcentaje     DECIMAL(5,2)  NOT NULL DEFAULT 18.00,
  serie_boleta       VARCHAR(10)   NOT NULL DEFAULT 'B001',
  serie_factura      VARCHAR(10)   NOT NULL DEFAULT 'F001',
  correlativo_b      INT UNSIGNED  NOT NULL DEFAULT 1,
  correlativo_f      INT UNSIGNED  NOT NULL DEFAULT 1,
  pie_documento      TEXT          NULL,
  ubigeo             VARCHAR(6)    NULL,
  sunat_activo       TINYINT(1)    NOT NULL DEFAULT 0,
  sunat_modo         ENUM('beta','produccion') NOT NULL DEFAULT 'beta',
  ose_proveedor      VARCHAR(20)   NULL DEFAULT 'nubefact',
  ose_api_key        TEXT          NULL,
  sunat_usuario_sol  VARCHAR(100)  NULL,
  sunat_clave_sol    TEXT          NULL,
  fe_serie_boleta    VARCHAR(4)    NOT NULL DEFAULT 'B001',
  fe_serie_factura   VARCHAR(4)    NOT NULL DEFAULT 'F001',
  fe_serie_nota_cred VARCHAR(4)    NOT NULL DEFAULT 'BC01',
  nubefact_ruta      VARCHAR(100)  NULL,
  nubefact_token     TEXT          NULL,
  updated_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Facturas ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS facturas (
  id                       INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  numero                   VARCHAR(20)   NOT NULL UNIQUE,
  tipo                     ENUM('boleta','factura') NOT NULL DEFAULT 'boleta',
  propietario_id           INT UNSIGNED  NOT NULL,
  mascota_id               INT UNSIGNED  NULL,
  cita_id                  INT UNSIGNED  NULL,
  emitido_por_id           INT UNSIGNED  NOT NULL,
  sede_id                  INT UNSIGNED  NULL DEFAULT NULL,
  fecha                    DATE          NOT NULL,
  -- Desglose de montos
  subtotal_bruto           DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Suma bruta de items antes de descuentos',
  descuento_items          DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Suma de descuentos aplicados por item',
  descuento_global         DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Descuento global sobre subtotal',
  descuento_global_pct     DECIMAL(5,2)  NOT NULL DEFAULT 0.00 COMMENT 'Porcentaje de descuento global',
  comision_tarjeta         DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Comision bancaria informativa (no suma al total)',
  comision_tarjeta_pct     DECIMAL(5,2)  NOT NULL DEFAULT 0.00 COMMENT 'Porcentaje de comision bancaria',
  subtotal                 DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Base imponible sin IGV',
  igv                      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total                    DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Total final = subtotal + IGV (sin comision)',
  -- Estado y pago
  estado                   ENUM('pendiente','pagado','anulado') NOT NULL DEFAULT 'pendiente',
  metodo_pago              ENUM('efectivo','tarjeta','transferencia','yape','plin') NULL,
  notas                    TEXT          NULL,
  observaciones            TEXT          NULL,
  anulado_por              VARCHAR(100)  NULL,
  -- Datos factura
  cliente_ruc              VARCHAR(20)   NULL,
  cliente_razon_social     VARCHAR(200)  NULL,
  cliente_direccion_fiscal VARCHAR(255)  NULL,
  -- SUNAT / FE
  sunat_estado             VARCHAR(20)   NULL DEFAULT NULL,
  sunat_hash               VARCHAR(100)  NULL,
  sunat_cdr                TEXT          NULL,
  xml_firmado              LONGTEXT      NULL,
  sunat_enviado_at         TIMESTAMP     NULL,
  sunat_mensaje            TEXT          NULL,
  enlace_pdf               VARCHAR(500)  NULL,
  enlace_xml               VARCHAR(500)  NULL,
  created_at               TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP     NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (propietario_id)  REFERENCES propietarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (mascota_id)      REFERENCES mascotas(id)     ON DELETE SET NULL,
  FOREIGN KEY (cita_id)         REFERENCES citas(id)        ON DELETE SET NULL,
  FOREIGN KEY (emitido_por_id)  REFERENCES usuarios(id)     ON DELETE RESTRICT,
  INDEX idx_fecha        (fecha),
  INDEX idx_estado       (estado),
  INDEX idx_sunat_estado (sunat_estado),
  INDEX idx_sede         (sede_id)
) ENGINE=InnoDB;

-- ── Items de factura ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS factura_items (
  id              INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  factura_id      INT UNSIGNED  NOT NULL,
  descripcion     VARCHAR(255)  NOT NULL,
  cantidad        DECIMAL(8,2)  NOT NULL DEFAULT 1.00,
  precio_unit     DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  descuento_pct   DECIMAL(5,2)  NOT NULL DEFAULT 0.00 COMMENT 'Descuento por item en porcentaje',
  descuento_monto DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Monto descontado en este item',
  subtotal        DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Precio final despues del descuento',
  inventario_id   INT UNSIGNED  NULL DEFAULT NULL,
  FOREIGN KEY (factura_id)    REFERENCES facturas(id)   ON DELETE CASCADE,
  FOREIGN KEY (inventario_id) REFERENCES inventario(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ── Pagos de factura ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS factura_pagos (
  id          INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  factura_id  INT UNSIGNED  NOT NULL,
  metodo_pago ENUM('efectivo','tarjeta','transferencia','yape','plin') NOT NULL,
  monto       DECIMAL(10,2) NOT NULL,
  referencia  VARCHAR(100)  NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (factura_id) REFERENCES facturas(id) ON DELETE CASCADE,
  INDEX idx_factura (factura_id)
) ENGINE=InnoDB;

-- ── Caja ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS caja_cierres (
  id                    INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  fecha                 DATE          NOT NULL,
  turno                 ENUM('mañana','tarde','dia_completo') NOT NULL DEFAULT 'dia_completo',
  realizado_por_id      INT UNSIGNED  NOT NULL,
  sede_id               INT UNSIGNED  NULL DEFAULT NULL,
  monto_inicial         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  sistema_efectivo      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  sistema_tarjeta       DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  sistema_transferencia DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  sistema_yape          DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  sistema_plin          DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  sistema_total         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total_gastos          DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  conteo_fisico         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  diferencia            DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  estado                ENUM('borrador','cerrado') NOT NULL DEFAULT 'borrador',
  observaciones         TEXT          NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (realizado_por_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  INDEX idx_fecha  (fecha),
  INDEX idx_estado (estado),
  INDEX idx_sede   (sede_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS caja_gastos (
  id          INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  cierre_id   INT UNSIGNED  NOT NULL,
  descripcion VARCHAR(200)  NOT NULL,
  monto       DECIMAL(10,2) NOT NULL,
  categoria   ENUM('compra','servicio','pago_proveedor','otro') NOT NULL DEFAULT 'otro',
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (cierre_id) REFERENCES caja_cierres(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Carnets digitales ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS carnets_digitales (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mascota_id INT UNSIGNED NOT NULL UNIQUE,
  token      VARCHAR(64)  NOT NULL UNIQUE,
  activo     TINYINT(1)   NOT NULL DEFAULT 1,
  vistas     INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_token   (token),
  INDEX idx_mascota (mascota_id),
  FOREIGN KEY (mascota_id) REFERENCES mascotas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Consentimientos ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consentimientos_plantillas (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre     VARCHAR(150) NOT NULL,
  tipo       ENUM('cirugia','anestesia','procedimiento','estetica','vacunacion','otro') NOT NULL DEFAULT 'procedimiento',
  contenido  LONGTEXT     NOT NULL,
  activo     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS consentimientos_generados (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  plantilla_id    INT UNSIGNED NOT NULL,
  mascota_id      INT UNSIGNED NOT NULL,
  propietario_id  INT UNSIGNED NOT NULL,
  veterinario_id  INT UNSIGNED NOT NULL,
  contenido_final LONGTEXT     NOT NULL,
  firmado         TINYINT(1)   NOT NULL DEFAULT 0,
  firmado_at      TIMESTAMP    NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plantilla_id)   REFERENCES consentimientos_plantillas(id) ON DELETE RESTRICT,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id)                   ON DELETE RESTRICT,
  FOREIGN KEY (propietario_id) REFERENCES propietarios(id)               ON DELETE RESTRICT,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id)                   ON DELETE RESTRICT,
  INDEX idx_mascota (mascota_id)
) ENGINE=InnoDB;

-- ── WhatsApp ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_config (
  id                                    INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  activo                                TINYINT(1)    NOT NULL DEFAULT 0,
  codigo_pais                           VARCHAR(5)    NOT NULL DEFAULT '+51',
  recordatorio_citas_activo             TINYINT(1)    NOT NULL DEFAULT 1,
  recordatorio_citas_horas              INT UNSIGNED  NOT NULL DEFAULT 24,
  recordatorio_citas_horas2             INT UNSIGNED  NULL DEFAULT 2,
  recordatorio_vacunas_activo           TINYINT(1)    NOT NULL DEFAULT 1,
  recordatorio_vacunas_dias             INT UNSIGNED  NOT NULL DEFAULT 7,
  recordatorio_vacunas_dias2            INT UNSIGNED  NULL DEFAULT 1,
  recordatorio_desparasitaciones_activo TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at                            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wa_plantillas (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre     VARCHAR(100) NOT NULL,
  tipo       ENUM('recordatorio_cita','recordatorio_vacuna','manual','campana','otro') NOT NULL DEFAULT 'manual',
  contenido  TEXT         NOT NULL,
  activo     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wa_mensajes_log (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tipo           ENUM('recordatorio_cita','recordatorio_vacuna','manual','campana') NOT NULL,
  campana_id     BIGINT UNSIGNED NULL,
  propietario_id INT UNSIGNED    NULL,
  telefono       VARCHAR(20)     NOT NULL,
  mensaje        TEXT            NOT NULL,
  estado         ENUM('enviado','fallido','pendiente') NOT NULL DEFAULT 'pendiente',
  error          TEXT            NULL,
  enviado_at     TIMESTAMP       NULL,
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tipo    (tipo),
  INDEX idx_campana (campana_id),
  INDEX idx_estado  (estado),
  INDEX idx_fecha   (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wa_campanas (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(150)   NOT NULL,
  mensaje        TEXT           NOT NULL,
  segmento       ENUM('todos','por_especie','vacunas_vencidas','citas_semana','sin_citas_60d') NOT NULL DEFAULT 'todos',
  segmento_valor VARCHAR(50)    NULL,
  estado         ENUM('borrador','programada','enviando','pausada','completada','cancelada') NOT NULL DEFAULT 'borrador',
  total          INT UNSIGNED   NOT NULL DEFAULT 0,
  enviados       INT UNSIGNED   NOT NULL DEFAULT 0,
  fallidos       INT UNSIGNED   NOT NULL DEFAULT 0,
  ultimo_id      INT UNSIGNED   NOT NULL DEFAULT 0,
  programada_at  TIMESTAMP      NULL,
  iniciada_at    TIMESTAMP      NULL,
  pausada_at     TIMESTAMP      NULL,
  completada_at  TIMESTAMP      NULL,
  created_at     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_estado (estado),
  INDEX idx_fecha  (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wa_campana_contactos (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campana_id     BIGINT UNSIGNED NOT NULL,
  propietario_id INT UNSIGNED    NOT NULL,
  telefono       VARCHAR(20)     NOT NULL,
  nombre         VARCHAR(150)    NULL,
  estado         ENUM('pendiente','enviado','fallido') NOT NULL DEFAULT 'pendiente',
  error          TEXT            NULL,
  enviado_at     TIMESTAMP       NULL,
  INDEX idx_campana (campana_id),
  INDEX idx_estado  (estado),
  FOREIGN KEY (campana_id) REFERENCES wa_campanas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Turnos del personal ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS turnos (
  id           INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  usuario_id   INT UNSIGNED  NOT NULL,
  sede_id      INT UNSIGNED  NULL DEFAULT NULL,
  fecha        DATE          NOT NULL,
  hora_inicio  TIME          NOT NULL,
  hora_fin     TIME          NOT NULL,
  notas        VARCHAR(255)  NULL,
  created_by   INT UNSIGNED  NOT NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES usuarios(id) ON DELETE RESTRICT,
  UNIQUE KEY uk_usuario_fecha (usuario_id, fecha),
  INDEX idx_fecha (fecha),
  INDEX idx_sede  (sede_id)
) ENGINE=InnoDB;

-- ── Asistencias del personal ─────────────────────────────────
CREATE TABLE IF NOT EXISTS asistencias (
  id              INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  turno_id        INT UNSIGNED  NOT NULL,
  usuario_id      INT UNSIGNED  NOT NULL,
  fecha           DATE          NOT NULL,
  hora_marcada    TIME          NOT NULL,
  estado          ENUM('puntual','tarde','adelantado') NOT NULL DEFAULT 'puntual',
  minutos_diff    SMALLINT      NOT NULL DEFAULT 0,
  ip              VARCHAR(45)   NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (turno_id)   REFERENCES turnos(id)   ON DELETE CASCADE,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  UNIQUE KEY uk_asistencia_usuario_fecha (usuario_id, fecha),
  INDEX idx_fecha (fecha)
) ENGINE=InnoDB;

-- ── Datos iniciales ──────────────────────────────────────────
INSERT INTO empresa_config (nombre) VALUES ('VetClinic');

INSERT INTO servicios_catalogo (nombre, categoria, precio) VALUES
  ('Consulta general',        'consulta',    60.00),
  ('Consulta de urgencia',    'consulta',   100.00),
  ('Vacuna séxtuple canina',  'vacunacion',  45.00),
  ('Vacuna antirrábica',      'vacunacion',  35.00),
  ('Vacuna triple felina',    'vacunacion',  40.00),
  ('Baño básico',             'estetica',    35.00),
  ('Baño completo + corte',   'estetica',    60.00),
  ('Desparasitación interna', 'otro',        30.00),
  ('Examen de sangre',        'laboratorio', 80.00);

INSERT INTO wa_config (activo) VALUES (0);

INSERT INTO wa_plantillas (nombre, tipo, contenido) VALUES
  ('Recordatorio de cita', 'recordatorio_cita',
   '🐾 Hola [nombre], te recordamos que tienes una cita para *[mascota]* el *[fecha]* a las *[hora]* en *[clinica]*. ¡Te esperamos! Para más info llámanos al [telefono].'),
  ('Recordatorio de vacuna', 'recordatorio_vacuna',
   '💉 Hola [nombre], *[mascota]* tiene pendiente su vacuna *[vacuna]* próximamente. Te recomendamos agendar su cita cuanto antes. Contáctanos en *[clinica]*.'),
  ('Bienvenida', 'manual',
   '🐾 Hola [nombre], bienvenido/a a *[clinica]*. Estamos felices de cuidar a *[mascota]*. Ante cualquier consulta estamos a tu disposición.'),
  ('Campaña general', 'campana',
   '🐾 Hola [nombre], desde *[clinica]* queremos recordarte que estamos disponibles para cuidar a *[mascota]*. ¡Agenda tu cita hoy!');

SELECT 'tenant_schema v10 ✅' AS resultado;