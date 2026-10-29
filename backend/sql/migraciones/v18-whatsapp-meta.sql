-- ============================================================
-- MIGRACIÓN v18 — WhatsApp Meta, para clínicas YA CREADAS
-- tenant_schema.sql solo sirve para clínicas nuevas (CREATE TABLE IF NOT EXISTS
-- no agrega columnas a tablas que ya existen). Este script sí lo hace.
--
-- · Se puede ejecutar varias veces: solo agrega lo que falta.
-- · Ejecutarlo una vez por clínica: cambia el USE.
-- · MySQL 8.
-- ============================================================

USE vet_mascotilandia;          -- ← clínica a migrar

-- ── 0. Diagnóstico: columnas que faltan (vacío = ya está todo) ──
SELECT x.tabla, x.columna
FROM (
  SELECT 'wa_campanas' AS tabla, 'imagen_blob_name' AS columna UNION ALL
  SELECT 'wa_campanas', 'pausada_at'        UNION ALL
  SELECT 'wa_campanas', 'proveedor'         UNION ALL
  SELECT 'wa_campanas', 'meta_plantilla_id' UNION ALL
  SELECT 'wa_campanas', 'meta_variables'    UNION ALL
  SELECT 'wa_mensajes_log', 'campana_id'    UNION ALL
  SELECT 'wa_mensajes_log', 'proveedor'     UNION ALL
  SELECT 'wa_mensajes_log', 'wamid'         UNION ALL
  SELECT 'wa_meta_plantillas', 'variables'  UNION ALL
  SELECT 'wa_meta_plantillas', 'es_estandar' UNION ALL
  SELECT 'wa_meta_plantillas', 'encabezado_tipo' UNION ALL
  SELECT 'wa_meta_plantillas', 'encabezado_texto' UNION ALL
  SELECT 'wa_meta_plantillas', 'pie'        UNION ALL
  SELECT 'wa_meta_plantillas', 'motivo_rechazo' UNION ALL
  SELECT 'wa_meta_plantillas', 'meta_template_id'
) x
LEFT JOIN information_schema.COLUMNS c
  ON c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = x.tabla AND c.COLUMN_NAME = x.columna
WHERE c.COLUMN_NAME IS NULL;

-- ── 1. Ayudantes: agregan columna / índice solo si no existe ──
DROP PROCEDURE IF EXISTS _v18_columna;
DROP PROCEDURE IF EXISTS _v18_indice;
DELIMITER //
CREATE PROCEDURE _v18_columna(IN p_tabla VARCHAR(64), IN p_columna VARCHAR(64), IN p_def TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_tabla AND COLUMN_NAME = p_columna) THEN
    SET @sql_v18 := CONCAT('ALTER TABLE `', p_tabla, '` ADD COLUMN `', p_columna, '` ', p_def);
    PREPARE st FROM @sql_v18; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
CREATE PROCEDURE _v18_indice(IN p_tabla VARCHAR(64), IN p_indice VARCHAR(64), IN p_cols TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_tabla AND INDEX_NAME = p_indice) THEN
    SET @sql_v18 := CONCAT('ALTER TABLE `', p_tabla, '` ADD INDEX `', p_indice, '` (', p_cols, ')');
    PREPARE st FROM @sql_v18; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
DELIMITER ;

-- ── 2. wa_campanas ───────────────────────────────────────────
CALL _v18_columna('wa_campanas', 'imagen_blob_name',
  "VARCHAR(200) NULL COMMENT 'Nombre del blob en Azure para gestión' AFTER imagen_url");
CALL _v18_columna('wa_campanas', 'pausada_at', 'TIMESTAMP NULL AFTER iniciada_at');
CALL _v18_columna('wa_campanas', 'proveedor',
  "ENUM('qr','meta') NOT NULL DEFAULT 'qr' COMMENT 'Canal de la campania (v18)'");
CALL _v18_columna('wa_campanas', 'meta_plantilla_id',
  "INT UNSIGNED NULL DEFAULT NULL COMMENT 'Plantilla aprobada por Meta que usa la campania (v18)'");
CALL _v18_columna('wa_campanas', 'meta_variables',
  "TEXT NULL COMMENT 'Lista JSON: que va en cada variable de la plantilla (v18)'");
ALTER TABLE wa_campanas
  MODIFY segmento ENUM('todos','por_especie','vacunas_vencidas','citas_semana','sin_citas_60d','personalizado')
                  NOT NULL DEFAULT 'todos',
  MODIFY segmento_valor TEXT NULL;

-- ── 3. wa_mensajes_log ───────────────────────────────────────
CALL _v18_columna('wa_mensajes_log', 'campana_id', 'BIGINT UNSIGNED NULL AFTER tipo');
CALL _v18_columna('wa_mensajes_log', 'proveedor',
  "ENUM('qr','meta') NOT NULL DEFAULT 'qr' COMMENT 'Canal por el que salio el mensaje (v18)'");
CALL _v18_columna('wa_mensajes_log', 'wamid',
  "VARCHAR(128) NULL DEFAULT NULL COMMENT 'Id del mensaje en Meta para actualizar entregado y leido (v18)'");
CALL _v18_indice('wa_mensajes_log', 'idx_log_wamid', 'wamid');
ALTER TABLE wa_mensajes_log
  MODIFY estado ENUM('enviado','fallido','pendiente','entregado','leido') NOT NULL DEFAULT 'pendiente';

-- ── 4. Tablas nuevas de Meta ─────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_meta_plantillas (
  id               INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre_meta      VARCHAR(100)  NOT NULL COMMENT 'Nombre en Meta, minusculas y guion bajo',
  idioma           VARCHAR(10)   NOT NULL DEFAULT 'es',
  categoria        ENUM('UTILITY','MARKETING','AUTHENTICATION') NOT NULL DEFAULT 'UTILITY',
  uso              ENUM('recordatorio_cita','recordatorio_cita_vacuna','recordatorio_cita_desparasitacion',
                        'recordatorio_cita_estetica','recordatorio_vacuna','recordatorio_desparasitacion',
                        'manual','campana','otro') NOT NULL DEFAULT 'manual',
  encabezado_tipo  ENUM('ninguno','texto','imagen') NOT NULL DEFAULT 'ninguno',
  encabezado_texto VARCHAR(60)   NULL,
  cuerpo           TEXT          NOT NULL COMMENT 'Texto con variables {{1}} {{2}}',
  variables        TEXT          NULL     COMMENT 'Lista JSON del dato de cada variable',
  pie              VARCHAR(60)   NULL,
  botones          TEXT          NULL     COMMENT 'Lista JSON de botones',
  meta_template_id VARCHAR(40)   NULL,
  estado           ENUM('borrador','pendiente','aprobada','rechazada','pausada','deshabilitada')
                   NOT NULL DEFAULT 'borrador',
  motivo_rechazo   TEXT          NULL,
  es_estandar      TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = creada automaticamente por el sistema',
  activo           TINYINT(1)    NOT NULL DEFAULT 1,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_meta_plantilla (nombre_meta, idioma),
  INDEX idx_mp_uso    (uso),
  INDEX idx_mp_estado (estado)
) ENGINE=InnoDB;

-- Si wa_meta_plantillas ya existía con una versión anterior
CALL _v18_columna('wa_meta_plantillas', 'encabezado_tipo',
  "ENUM('ninguno','texto','imagen') NOT NULL DEFAULT 'ninguno'");
CALL _v18_columna('wa_meta_plantillas', 'encabezado_texto', 'VARCHAR(60) NULL');
CALL _v18_columna('wa_meta_plantillas', 'variables', "TEXT NULL COMMENT 'Lista JSON del dato de cada variable'");
CALL _v18_columna('wa_meta_plantillas', 'pie', 'VARCHAR(60) NULL');
CALL _v18_columna('wa_meta_plantillas', 'botones', "TEXT NULL COMMENT 'Lista JSON de botones'");
CALL _v18_columna('wa_meta_plantillas', 'meta_template_id', 'VARCHAR(40) NULL');
CALL _v18_columna('wa_meta_plantillas', 'motivo_rechazo', 'TEXT NULL');
CALL _v18_columna('wa_meta_plantillas', 'es_estandar',
  "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = creada automaticamente por el sistema'");
ALTER TABLE wa_meta_plantillas
  MODIFY uso ENUM('recordatorio_cita','recordatorio_cita_vacuna','recordatorio_cita_desparasitacion',
                  'recordatorio_cita_estetica','recordatorio_vacuna','recordatorio_desparasitacion',
                  'manual','campana','otro') NOT NULL DEFAULT 'manual';

CREATE TABLE IF NOT EXISTS wa_meta_conversaciones (
  id                INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  telefono          VARCHAR(20)   NOT NULL COMMENT 'Numero en formato internacional sin +',
  propietario_id    INT UNSIGNED  NULL,
  nombre_contacto   VARCHAR(150)  NULL     COMMENT 'Nombre de perfil en WhatsApp',
  ultimo_mensaje_at DATETIME      NULL,
  ultimo_preview    VARCHAR(255)  NULL,
  ventana_expira    DATETIME      NULL,
  no_leidos         INT UNSIGNED  NOT NULL DEFAULT 0,
  estado            ENUM('abierta','archivada') NOT NULL DEFAULT 'abierta',
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_conv_telefono (telefono),
  INDEX idx_conv_propietario (propietario_id),
  INDEX idx_conv_ultimo      (ultimo_mensaje_at),
  FOREIGN KEY (propietario_id) REFERENCES propietarios(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wa_meta_mensajes (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  conversacion_id  INT UNSIGNED    NOT NULL,
  wamid            VARCHAR(128)    NULL COMMENT 'Id del mensaje en Meta',
  direccion        ENUM('entrante','saliente') NOT NULL,
  origen           ENUM('sistema','celular','cliente','historial') NOT NULL DEFAULT 'sistema',
  tipo             ENUM('texto','plantilla','imagen','documento','audio','video','sticker',
                        'ubicacion','contacto','reaccion','interactivo','otro') NOT NULL DEFAULT 'texto',
  contenido        TEXT            NULL,
  plantilla_id     INT UNSIGNED    NULL,
  media_id         VARCHAR(128)    NULL COMMENT 'Id del archivo en Meta',
  media_mime       VARCHAR(100)    NULL,
  media_blob       VARCHAR(500)    NULL COMMENT 'Copia del archivo en Azure',
  estado           ENUM('pendiente','enviado','entregado','leido','fallido','recibido')
                   NOT NULL DEFAULT 'pendiente',
  error_codigo     VARCHAR(20)     NULL,
  error_detalle    TEXT            NULL,
  categoria_cobro  VARCHAR(30)     NULL COMMENT 'Categoria que informa Meta para el cobro',
  contexto         ENUM('manual','recordatorio','campana','respuesta','otro') NOT NULL DEFAULT 'manual',
  campana_id       BIGINT UNSIGNED NULL,
  enviado_por_id   INT UNSIGNED    NULL COMMENT 'Usuario que lo envio desde el sistema',
  estado_at        DATETIME        NULL COMMENT 'Ultimo cambio de estado',
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_msg_wamid (wamid),
  INDEX idx_msg_conversacion (conversacion_id, created_at),
  INDEX idx_msg_estado       (estado),
  INDEX idx_msg_fecha        (created_at),
  INDEX idx_msg_campana      (campana_id),
  FOREIGN KEY (conversacion_id) REFERENCES wa_meta_conversaciones(id) ON DELETE CASCADE,
  FOREIGN KEY (plantilla_id)    REFERENCES wa_meta_plantillas(id)     ON DELETE SET NULL,
  FOREIGN KEY (enviado_por_id)  REFERENCES usuarios(id)               ON DELETE SET NULL
) ENGINE=InnoDB;

-- ── 5. Limpieza de ayudantes ─────────────────────────────────
DROP PROCEDURE IF EXISTS _v18_columna;
DROP PROCEDURE IF EXISTS _v18_indice;

-- ── 6. Verificación: debe salir vacío ────────────────────────
SELECT x.tabla, x.columna AS falta
FROM (
  SELECT 'wa_campanas' AS tabla, 'proveedor' AS columna UNION ALL
  SELECT 'wa_campanas', 'meta_plantilla_id' UNION ALL
  SELECT 'wa_campanas', 'meta_variables'    UNION ALL
  SELECT 'wa_campanas', 'imagen_blob_name'  UNION ALL
  SELECT 'wa_mensajes_log', 'proveedor'     UNION ALL
  SELECT 'wa_mensajes_log', 'wamid'
) x
LEFT JOIN information_schema.COLUMNS c
  ON c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = x.tabla AND c.COLUMN_NAME = x.columna
WHERE c.COLUMN_NAME IS NULL;
