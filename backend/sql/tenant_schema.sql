-- ============================================================
-- VETNETCODIP SaaS — TENANT SCHEMA v17
-- v6:  + sedes (multi-sedes) + sede_id en tablas operativas
-- v7:  + tipo_documento en propietarios + historia_seguimientos + estetica_fotos
-- v8:  + pruebas_complementarias + eutanasia/internamiento en catalogo
--       + consentimientos_plantillas + consentimientos_generados
-- v9:  + descuento_pct / descuento_monto en factura_items
--       + subtotal_bruto / descuento_items / descuento_global /
--         descuento_global_pct / comision_tarjeta / comision_tarjeta_pct en facturas
-- v11: + tipo_cita en citas (redirección automática)
--       + precio_compra en inventario (rentabilidad)
--       + precio_compra_snapshot en factura_items (historial rentabilidad)
-- v12: + campana_limite_dia / campana_delay_ms / campana_hora_inicio / campana_hora_fin en wa_config
--       + imagen_url / imagen_blob_name / enviados_hoy / fecha_ultimo_envio en wa_campanas
-- v13: + tabla wa_historias (WhatsApp Stories — imagen/texto, programable)
-- v14: + categoría 'imagenologia' en servicios_catalogo (maestra de exámenes = laboratorio + imagenologia)
--       + historia_examenes / historia_examen_archivos (exámenes en atenciones y seguimientos)
-- v15: + mascotas.foto_blob / foto_updated_at (foto de perfil, contenedor privado vet-mascotas)
-- v16: + proformas / proforma_items (cotizaciones) + facturas.proforma_id
--       + serie_proforma / correlativo_p / proforma_validez_dias / proforma_condiciones en empresa_config
-- v17: + Punto de Venta: propietarios.es_generico (+ cliente Publico General), facturas.origen,
--       inventario.codigo_barras / favorito, categorias alimento y accesorio
-- Ejecutar al crear nueva clínica
-- Compatible MySQL 5.7+ / MySQL 8+
-- ============================================================

-- ── Sedes ────────────────────────────────────────────────────
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
  rol                  ENUM('admin','veterinario','recepcionista','veterinario_recepcionista') NOT NULL DEFAULT 'recepcionista',
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
  es_generico      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = cliente Publico General del Punto de Venta',
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
  foto_blob        VARCHAR(500) NULL DEFAULT NULL,
  foto_updated_at  DATETIME     NULL DEFAULT NULL,
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
  tipo_cita      ENUM('medica','vacuna','desparasitacion','estetica') NOT NULL DEFAULT 'medica'
                 COMMENT 'Tipo de atencion — define redireccion automatica al atender',
  notas          TEXT         NULL,
  estado         ENUM('pendiente','confirmada','en_curso','completada','cancelada') NOT NULL DEFAULT 'pendiente',
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id) ON DELETE RESTRICT,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (creada_por_id)  REFERENCES usuarios(id) ON DELETE RESTRICT,
  INDEX idx_fecha     (fecha_hora),
  INDEX idx_estado    (estado),
  INDEX idx_tipo_cita (tipo_cita),
  INDEX idx_sede      (sede_id)
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
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  historia_id    INT UNSIGNED NOT NULL,
  veterinario_id INT UNSIGNED NOT NULL,
  fecha          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  evolucion      TEXT         NOT NULL,
  tratamiento    TEXT         NULL,
  pruebas_complementarias TEXT         NULL,
  observaciones  TEXT         NULL,
  peso_kg        DECIMAL(6,2) NULL,
  temperatura_c  DECIMAL(4,1) NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  categoria         ENUM('medicamento','vacuna','insumo','alimento','accesorio','otro') NOT NULL DEFAULT 'medicamento',
  codigo_barras     VARCHAR(50)   NULL DEFAULT NULL COMMENT 'Codigo de barras (lector)',
  favorito          TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = boton rapido en el Punto de Venta',
  descripcion       TEXT          NULL,
  cantidad          DECIMAL(10,2) NOT NULL DEFAULT 0,
  unidad            VARCHAR(30)   NOT NULL DEFAULT 'unidad',
  precio_compra     DECIMAL(10,2) NOT NULL DEFAULT 0.00
                    COMMENT 'Precio de compra al proveedor (costo)',
  precio_unitario   DECIMAL(10,2) NULL
                    COMMENT 'Precio de venta al cliente',
  proveedor         VARCHAR(150)  NULL,
  stock_minimo      DECIMAL(10,2) NOT NULL DEFAULT 5,
  fecha_vencimiento DATE          NULL,
  sede_id           INT UNSIGNED  NULL DEFAULT NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sede        (sede_id),
  INDEX idx_vencimiento (fecha_vencimiento),
  INDEX idx_inv_codigo_barras (codigo_barras)
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
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  estetica_id    INT UNSIGNED NOT NULL,
  momento        ENUM('antes','despues') NOT NULL,
  url            VARCHAR(500) NOT NULL,
  nombre_archivo VARCHAR(200) NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  categoria   ENUM('consulta','vacunacion','estetica','cirugia','laboratorio',
                   'medicamento','otro','eutanasia','internamiento','imagenologia') NOT NULL DEFAULT 'consulta',
  precio      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  descripcion VARCHAR(255)  NULL,
  activo      TINYINT(1)    NOT NULL DEFAULT 1,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Exámenes en atenciones y seguimientos (v14) ─────────────
-- servicio_id apunta a servicios_catalogo (categoria laboratorio / imagenologia)
-- nombre_examen guarda copia del nombre para no depender del catálogo
CREATE TABLE IF NOT EXISTS historia_examenes (
  id                INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  historia_id       INT UNSIGNED  NOT NULL,
  seguimiento_id    INT UNSIGNED  NULL DEFAULT NULL,
  mascota_id        INT UNSIGNED  NOT NULL,
  servicio_id       INT UNSIGNED  NULL DEFAULT NULL,
  nombre_examen     VARCHAR(150)  NOT NULL,
  categoria         VARCHAR(30)   NULL DEFAULT NULL,
  fecha             DATETIME      NOT NULL,
  observaciones     TEXT          NULL,
  registrado_por_id INT UNSIGNED  NOT NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (historia_id)       REFERENCES historia_clinica(id)      ON DELETE CASCADE,
  FOREIGN KEY (seguimiento_id)    REFERENCES historia_seguimientos(id) ON DELETE CASCADE,
  FOREIGN KEY (mascota_id)        REFERENCES mascotas(id)              ON DELETE RESTRICT,
  FOREIGN KEY (servicio_id)       REFERENCES servicios_catalogo(id)    ON DELETE SET NULL,
  FOREIGN KEY (registrado_por_id) REFERENCES usuarios(id)              ON DELETE RESTRICT,
  INDEX idx_historia    (historia_id),
  INDEX idx_seguimiento (seguimiento_id),
  INDEX idx_mascota     (mascota_id, fecha)
) ENGINE=InnoDB;

-- Archivos adjuntos (contenedor privado de Azure: vet-examenes)
CREATE TABLE IF NOT EXISTS historia_examen_archivos (
  id              INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  examen_id       INT UNSIGNED  NOT NULL,
  blob_name       VARCHAR(500)  NOT NULL,
  nombre_original VARCHAR(255)  NOT NULL,
  mime_type       VARCHAR(100)  NOT NULL,
  tamano_bytes    INT UNSIGNED  NOT NULL DEFAULT 0,
  subido_por_id   INT UNSIGNED  NOT NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (examen_id)     REFERENCES historia_examenes(id) ON DELETE CASCADE,
  FOREIGN KEY (subido_por_id) REFERENCES usuarios(id)          ON DELETE RESTRICT,
  INDEX idx_examen (examen_id)
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
  serie_proforma        VARCHAR(10)       NOT NULL DEFAULT 'P001' COMMENT 'Serie interna de proformas (no SUNAT)',
  correlativo_p         INT UNSIGNED      NOT NULL DEFAULT 1      COMMENT 'Siguiente numero de proforma',
  proforma_validez_dias SMALLINT UNSIGNED NOT NULL DEFAULT 30     COMMENT 'Validez por defecto (dias)',
  proforma_condiciones  TEXT              NULL                    COMMENT 'Condiciones al pie (NULL = texto por defecto)',
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
  subtotal_bruto           DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Suma bruta antes de descuentos',
  descuento_items          DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Suma de descuentos por item',
  descuento_global         DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Descuento global sobre subtotal',
  descuento_global_pct     DECIMAL(5,2)  NOT NULL DEFAULT 0.00 COMMENT 'Porcentaje de descuento global',
  comision_tarjeta         DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Comision bancaria (informativa, no suma al total)',
  comision_tarjeta_pct     DECIMAL(5,2)  NOT NULL DEFAULT 0.00 COMMENT 'Porcentaje de comision bancaria',
  subtotal                 DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Base imponible sin IGV',
  igv                      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total                    DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Total = subtotal + IGV',
  -- Estado y pago
  estado                   ENUM('pendiente','pagado','anulado') NOT NULL DEFAULT 'pendiente',
  metodo_pago              ENUM('efectivo','tarjeta','transferencia','yape','plin') NULL,
  notas                    TEXT          NULL,
  observaciones            TEXT          NULL,
  anulado_por              VARCHAR(100)  NULL,
  -- Datos para factura con RUC
  cliente_ruc              VARCHAR(20)   NULL,
  cliente_razon_social     VARCHAR(200)  NULL,
  cliente_direccion_fiscal VARCHAR(255)  NULL,
  -- SUNAT / Facturación electrónica
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
  FOREIGN KEY (propietario_id) REFERENCES propietarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id)     ON DELETE SET NULL,
  FOREIGN KEY (cita_id)        REFERENCES citas(id)        ON DELETE SET NULL,
  FOREIGN KEY (emitido_por_id) REFERENCES usuarios(id)     ON DELETE RESTRICT,
  INDEX idx_fecha        (fecha),
  INDEX idx_estado       (estado),
  INDEX idx_sunat_estado (sunat_estado),
  INDEX idx_sede         (sede_id),
  proforma_id              INT UNSIGNED  NULL DEFAULT NULL COMMENT 'Proforma de la que se genero este comprobante',
  INDEX idx_fact_proforma (proforma_id),
  origen                   ENUM('atencion','punto_venta') NOT NULL DEFAULT 'atencion' COMMENT 'Donde se genero el comprobante',
  INDEX idx_fact_origen (origen)
) ENGINE=InnoDB;

-- ── Items de factura ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS factura_items (
  id                      INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  factura_id              INT UNSIGNED  NOT NULL,
  descripcion             VARCHAR(255)  NOT NULL,
  cantidad                DECIMAL(8,2)  NOT NULL DEFAULT 1.00,
  precio_unit             DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  descuento_pct           DECIMAL(5,2)  NOT NULL DEFAULT 0.00
                          COMMENT 'Descuento por item en porcentaje',
  descuento_monto         DECIMAL(10,2) NOT NULL DEFAULT 0.00
                          COMMENT 'Monto descontado en este item',
  subtotal                DECIMAL(10,2) NOT NULL DEFAULT 0.00
                          COMMENT 'Precio final despues del descuento por item',
  inventario_id           INT UNSIGNED  NULL DEFAULT NULL,
  precio_compra_snapshot  DECIMAL(10,2) NOT NULL DEFAULT 0.00
                          COMMENT 'Precio de compra al momento de la venta (para reportes de rentabilidad)',
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

-- ── Proformas (cotizaciones — no son comprobante SUNAT) ──────
CREATE TABLE IF NOT EXISTS proformas (
  id                    INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  numero                VARCHAR(20)   NOT NULL UNIQUE                 COMMENT 'Ej: P001-00001',
  propietario_id        INT UNSIGNED  NOT NULL,
  mascota_id            INT UNSIGNED  NULL,
  historia_clinica_id   INT UNSIGNED  NULL                            COMMENT 'Atencion desde la que se genero (opcional)',
  creado_por_id         INT UNSIGNED  NOT NULL,
  sede_id               INT UNSIGNED  NULL DEFAULT NULL,
  fecha                 DATE          NOT NULL,
  validez_dias          SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  validez_hasta         DATE          NOT NULL,
  estado                ENUM('borrador','enviada','aceptada','rechazada','vencida','facturada')
                        NOT NULL DEFAULT 'borrador',
  igv_incluido          TINYINT(1)    NOT NULL DEFAULT 1,
  subtotal_bruto        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  descuento_items       DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  descuento_global      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  descuento_global_pct  DECIMAL(5,2)  NOT NULL DEFAULT 0.00,
  subtotal              DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  igv                   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total                 DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  notas                 TEXT          NULL,
  condiciones           TEXT          NULL,
  motivo_rechazo        VARCHAR(255)  NULL,
  factura_id            INT UNSIGNED  NULL,
  enviada_at            DATETIME      NULL,
  aceptada_at           DATETIME      NULL,
  rechazada_at          DATETIME      NULL,
  facturada_at          DATETIME      NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (propietario_id)      REFERENCES propietarios(id)     ON DELETE RESTRICT,
  FOREIGN KEY (mascota_id)          REFERENCES mascotas(id)         ON DELETE SET NULL,
  FOREIGN KEY (historia_clinica_id) REFERENCES historia_clinica(id) ON DELETE SET NULL,
  FOREIGN KEY (creado_por_id)       REFERENCES usuarios(id)         ON DELETE RESTRICT,
  FOREIGN KEY (factura_id)          REFERENCES facturas(id)         ON DELETE SET NULL,
  INDEX idx_prof_fecha       (fecha),
  INDEX idx_prof_estado      (estado),
  INDEX idx_prof_validez     (validez_hasta),
  INDEX idx_prof_propietario (propietario_id),
  INDEX idx_prof_sede        (sede_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS proforma_items (
  id               INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  proforma_id      INT UNSIGNED  NOT NULL,
  orden            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  tipo             ENUM('servicio','producto','libre') NOT NULL DEFAULT 'libre',
  servicio_id      INT UNSIGNED  NULL,
  inventario_id    INT UNSIGNED  NULL,
  descripcion      VARCHAR(255)  NOT NULL,
  cantidad         DECIMAL(8,2)  NOT NULL DEFAULT 1.00,
  precio_unit      DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Precio congelado al cotizar',
  descuento_pct    DECIMAL(5,2)  NOT NULL DEFAULT 0.00,
  descuento_monto  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  subtotal         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  FOREIGN KEY (proforma_id)   REFERENCES proformas(id)          ON DELETE CASCADE,
  FOREIGN KEY (servicio_id)   REFERENCES servicios_catalogo(id) ON DELETE SET NULL,
  FOREIGN KEY (inventario_id) REFERENCES inventario(id)         ON DELETE SET NULL,
  INDEX idx_pitem_proforma (proforma_id)
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
  tipo       ENUM('cirugia','anestesia','procedimiento','estetica','vacunacion','otro')
             NOT NULL DEFAULT 'procedimiento',
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
  id                                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  activo                                TINYINT(1)   NOT NULL DEFAULT 0,
  codigo_pais                           VARCHAR(5)   NOT NULL DEFAULT '+51',
  recordatorio_citas_activo             TINYINT(1)   NOT NULL DEFAULT 1,
  recordatorio_citas_horas              INT UNSIGNED NOT NULL DEFAULT 24,
  recordatorio_citas_horas2             INT UNSIGNED NULL DEFAULT 2,
  recordatorio_vacunas_activo           TINYINT(1)   NOT NULL DEFAULT 1,
  recordatorio_vacunas_dias             INT UNSIGNED NOT NULL DEFAULT 7,
  recordatorio_vacunas_dias2            INT UNSIGNED NULL DEFAULT 1,
  recordatorio_desparasitaciones_activo TINYINT(1)   NOT NULL DEFAULT 1,
  campana_limite_dia                    INT UNSIGNED NOT NULL DEFAULT 30
                                        COMMENT 'Mensajes máximos por día para campañas',
  campana_delay_ms                      INT UNSIGNED NOT NULL DEFAULT 4000
                                        COMMENT 'Delay en ms entre mensajes de campaña',
  campana_hora_inicio                   TIME         NOT NULL DEFAULT '08:00:00'
                                        COMMENT 'Hora de inicio de envío de campañas',
  campana_hora_fin                      TIME         NOT NULL DEFAULT '20:00:00'
                                        COMMENT 'Hora de fin de envío de campañas',
  updated_at                            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wa_plantillas (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre     VARCHAR(100) NOT NULL,
  tipo       ENUM('recordatorio_cita','recordatorio_cita_vacuna','recordatorio_cita_desparasitacion',
                  'recordatorio_cita_estetica','recordatorio_vacuna','manual','campana','otro')
             NOT NULL DEFAULT 'manual',
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
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre            VARCHAR(150)   NOT NULL,
  mensaje           TEXT           NOT NULL,
  imagen_url        VARCHAR(500)   NULL
                    COMMENT 'URL de imagen en Azure Blob Storage',
  imagen_blob_name  VARCHAR(200)   NULL
                    COMMENT 'Nombre del blob en Azure para gestión',
  segmento          ENUM('todos','por_especie','vacunas_vencidas','citas_semana','sin_citas_60d','personalizado')
                    NOT NULL DEFAULT 'todos',
  segmento_valor    TEXT   NULL,
  estado            ENUM('borrador','programada','enviando','pausada','completada','cancelada')
                    NOT NULL DEFAULT 'borrador',
  total             INT UNSIGNED   NOT NULL DEFAULT 0,
  enviados          INT UNSIGNED   NOT NULL DEFAULT 0,
  fallidos          INT UNSIGNED   NOT NULL DEFAULT 0,
  enviados_hoy      INT UNSIGNED   NOT NULL DEFAULT 0
                    COMMENT 'Enviados en el día actual (se resetea cada día)',
  fecha_ultimo_envio DATE          NULL
                    COMMENT 'Fecha del último envío — para control diario',
  ultimo_id         INT UNSIGNED   NOT NULL DEFAULT 0,
  programada_at     TIMESTAMP      NULL,
  iniciada_at       TIMESTAMP      NULL,
  pausada_at        TIMESTAMP      NULL,
  completada_at     TIMESTAMP      NULL,
  created_at        TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

-- ── WhatsApp Historias (Stories) ─────────────────────────────
-- v13: permite publicar y programar estados de WhatsApp con imagen o texto
CREATE TABLE IF NOT EXISTS wa_historias (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  titulo        VARCHAR(150)   NOT NULL
                COMMENT 'Título interno para identificar la historia',
  texto         TEXT           NULL
                COMMENT 'Texto / caption de la historia',
  imagen_url    VARCHAR(500)   NULL
                COMMENT 'URL de la imagen en Azure Blob Storage',
  imagen_blob   VARCHAR(200)   NULL
                COMMENT 'Nombre del blob en Azure para gestión y eliminación',
  tipo          ENUM('imagen','texto') NOT NULL DEFAULT 'imagen'
                COMMENT 'Tipo de historia: con imagen o solo texto con fondo',
  estado        ENUM('borrador','programada','publicada','fallida','cancelada')
                NOT NULL DEFAULT 'borrador',
  programada_at TIMESTAMP      NULL
                COMMENT 'Fecha/hora programada de publicación (NULL = publicar ahora)',
  publicada_at  TIMESTAMP      NULL
                COMMENT 'Fecha/hora real en que se publicó en WhatsApp',
  error_msg     TEXT           NULL
                COMMENT 'Mensaje de error si la publicación falló',
  creada_por_id INT UNSIGNED   NOT NULL,
  created_at    TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (creada_por_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  INDEX idx_estado     (estado),
  INDEX idx_programada (programada_at),
  INDEX idx_creada_por (creada_por_id)
) ENGINE=InnoDB;

-- ── Turnos del personal ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS turnos (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  usuario_id  INT UNSIGNED NOT NULL,
  sede_id     INT UNSIGNED NULL DEFAULT NULL,
  fecha       DATE         NOT NULL,
  hora_inicio TIME         NOT NULL,
  hora_fin    TIME         NOT NULL,
  notas       VARCHAR(255) NULL,
  created_by  INT UNSIGNED NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES usuarios(id) ON DELETE RESTRICT,
  UNIQUE KEY uk_usuario_fecha (usuario_id, fecha),
  INDEX idx_fecha (fecha),
  INDEX idx_sede  (sede_id)
) ENGINE=InnoDB;

-- ── Asistencias del personal ─────────────────────────────────
CREATE TABLE IF NOT EXISTS asistencias (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  turno_id     INT UNSIGNED NOT NULL,
  usuario_id   INT UNSIGNED NOT NULL,
  fecha        DATE         NOT NULL,
  hora_marcada TIME         NOT NULL,
  estado       ENUM('puntual','tarde','adelantado') NOT NULL DEFAULT 'puntual',
  minutos_diff SMALLINT     NOT NULL DEFAULT 0,
  ip           VARCHAR(45)  NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  ('Examen de sangre',        'laboratorio', 80.00),
  ('Hemograma completo',      'laboratorio',  0.00),
  ('Perfil bioquímico',       'laboratorio',  0.00),
  ('Perfil renal',            'laboratorio',  0.00),
  ('Perfil hepático',         'laboratorio',  0.00),
  ('Urianálisis',             'laboratorio',  0.00),
  ('Coproparasitológico',     'laboratorio',  0.00),
  ('Raspado de piel',         'laboratorio',  0.00),
  ('Citología',               'laboratorio',  0.00),
  ('Test rápido Distemper',   'laboratorio',  0.00),
  ('Test rápido Parvovirus',  'laboratorio',  0.00),
  ('Test rápido Ehrlichia',   'laboratorio',  0.00),
  ('Test rápido VIF/ViLeF',   'laboratorio',  0.00),
  ('Radiografía',             'imagenologia', 0.00),
  ('Ecografía abdominal',     'imagenologia', 0.00),
  ('Electrocardiograma',      'imagenologia', 0.00);

INSERT INTO wa_config (activo) VALUES (0);

INSERT INTO wa_plantillas (nombre, tipo, contenido) VALUES
  ('Recordatorio de cita médica', 'recordatorio_cita',
   '🐾 Hola [nombre], te recordamos que tienes una cita médica para *[mascota]* el *[fecha]* a las *[hora]* en *[clinica]*. ¡Te esperamos! Para más info llámanos al [telefono].'),
  ('Recordatorio de cita — Vacunación', 'recordatorio_cita_vacuna',
   '💉 Hola [nombre], te recordamos que *[mascota]* tiene su cita de *vacunación* el *[fecha]* a las *[hora]* en *[clinica]*. ¡Es importante no faltar! Llámanos al [telefono].'),
  ('Recordatorio de cita — Desparasitación', 'recordatorio_cita_desparasitacion',
   '🐛 Hola [nombre], te recordamos que *[mascota]* tiene su cita de *desparasitación* el *[fecha]* a las *[hora]* en *[clinica]*. ¡Te esperamos! Llámanos al [telefono].'),
  ('Recordatorio de cita — Estética', 'recordatorio_cita_estetica',
   '✂️ Hola [nombre], te recordamos que *[mascota]* tiene su cita de *estética* el *[fecha]* a las *[hora]* en *[clinica]*. ¡Te esperamos guapos! Llámanos al [telefono].'),
  ('Recordatorio de vacuna', 'recordatorio_vacuna',
   '💉 Hola [nombre], *[mascota]* tiene pendiente su vacuna *[vacuna]* próximamente. Te recomendamos agendar su cita cuanto antes. Contáctanos en *[clinica]*.'),
  ('Bienvenida', 'manual',
   '🐾 Hola [nombre], bienvenido/a a *[clinica]*. Estamos felices de cuidar a *[mascota]*. Ante cualquier consulta estamos a tu disposición.'),
  ('Campaña general', 'campana',
   '🐾 Hola [nombre], desde *[clinica]* queremos recordarte que estamos disponibles para cuidar a *[mascota]*. ¡Agenda tu cita hoy!');

-- Migración para tenants existentes: ampliar ENUM y agregar plantillas nuevas si no existen
-- Ejecutar manualmente en cada base de datos tenant existente:
-- ALTER TABLE wa_plantillas MODIFY tipo ENUM('recordatorio_cita','recordatorio_cita_vacuna','recordatorio_cita_desparasitacion','recordatorio_cita_estetica','recordatorio_vacuna','manual','campana','otro') NOT NULL DEFAULT 'manual';
-- INSERT IGNORE INTO wa_plantillas (nombre, tipo, contenido) VALUES
--   ('Recordatorio de cita — Vacunación','recordatorio_cita_vacuna','💉 Hola [nombre], te recordamos que *[mascota]* tiene su cita de *vacunación* el *[fecha]* a las *[hora]* en *[clinica]*. ¡Es importante no faltar! Llámanos al [telefono].'),
--   ('Recordatorio de cita — Desparasitación','recordatorio_cita_desparasitacion','🐛 Hola [nombre], te recordamos que *[mascota]* tiene su cita de *desparasitación* el *[fecha]* a las *[hora]* en *[clinica]*. ¡Te esperamos! Llámanos al [telefono].'),
--   ('Recordatorio de cita — Estética','recordatorio_cita_estetica','✂️ Hola [nombre], te recordamos que *[mascota]* tiene su cita de *estética* el *[fecha]* a las *[hora]* en *[clinica]*. ¡Te esperamos guapos! Llámanos al [telefono].');

-- ── Cliente generico para el Punto de Venta ─────────────────
INSERT INTO propietarios (tipo_documento, nombre, apellido, es_generico)
SELECT 'OTRO', 'Público', 'General', 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM propietarios WHERE es_generico = 1);

SELECT 'tenant_schema v17 ✅' AS resultado;