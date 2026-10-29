-- ============================================================
-- PRUEBA DE RECORDATORIOS POR WHATSAPP META — todo en un solo script
-- Usa un propietario EXISTENTE (por DNI) y su primera mascota y crea:
--   1. Cita            (a 2 h 10 min → ventana "2 h" de recordatorio_citas_horas2)
--   2. Vacuna          (próxima dosis en 7 días)
--   3. Desparasitación (próxima dosis en 7 días)
-- wa-meta-recordatorios los envía en su siguiente ciclo (máx. 30 min,
-- o al instante con: pm2 restart wa-meta-recordatorios).
--
-- Ejecuta el script completo. Las consultas del final (resultado) vuelve
-- a ejecutarlas después del ciclo.
-- ============================================================

USE vet_patitas;

SET @dni   := '74969768';
SET @marca := '[PRUEBA RECORDATORIO]';

-- ── 0. ¿La clínica envía por Meta? (si no, el proceso Meta no la atiende) ──
-- Las 3 condiciones deben ser 1 / 'conectado'
SELECT t.slug, wmc.estado AS meta_estado, wcg.activo AS wa_activo, wcg.ver_meta
FROM vet_master.tenants t
LEFT JOIN vet_master.wa_config_global wcg ON wcg.tenant_id = t.id
LEFT JOIN vet_master.wa_meta_cuentas  wmc ON wmc.tenant_id = t.id
WHERE t.db_name = 'vet_patitas';

-- Recordatorios activos en la clínica
SELECT activo, recordatorio_citas_activo, recordatorio_citas_horas, recordatorio_citas_horas2,
       recordatorio_vacunas_activo, recordatorio_vacunas_dias, recordatorio_desparasitaciones_activo
FROM wa_config LIMIT 1;

-- Plantillas de recordatorio: deben estar 'aprobada'
SELECT uso, nombre_meta, estado FROM wa_meta_plantillas WHERE es_estandar = 1 AND activo = 1 ORDER BY uso;

-- ── 1. Propietario, mascota y veterinario ────────────────────
-- COLLATE: la variable usa la collation de la conexión y la tabla utf8mb4_unicode_ci
SET @prop_id := (SELECT id FROM propietarios WHERE dni = @dni COLLATE utf8mb4_unicode_ci ORDER BY id LIMIT 1);
SET @masc_id := (SELECT id FROM mascotas WHERE propietario_id = @prop_id ORDER BY id LIMIT 1);
SET @vet_id  := (SELECT id FROM usuarios WHERE activo = 1
                 ORDER BY (rol = 'veterinario') DESC, id LIMIT 1);

SELECT @prop_id AS propietario_id, @masc_id AS mascota_id, @vet_id AS veterinario_id,
       (SELECT telefono FROM propietarios WHERE id = @prop_id) AS telefono,
       (SELECT nombre FROM mascotas WHERE id = @masc_id) AS mascota;

-- ── 2. Cita, vacuna y desparasitación ────────────────────────
-- (si no se encontró el propietario o la mascota, no se inserta nada)
INSERT INTO citas (mascota_id, veterinario_id, creada_por_id, fecha_hora, motivo, tipo_cita, notas, estado)
SELECT @masc_id, @vet_id, @vet_id, NOW() + INTERVAL 130 MINUTE,
       'Control de prueba', 'medica', @marca, 'pendiente'
FROM DUAL WHERE @masc_id IS NOT NULL AND @vet_id IS NOT NULL;

INSERT INTO vacunas (mascota_id, veterinario_id, nombre, fecha_aplicacion, proxima_dosis, notas, notificado)
SELECT @masc_id, @vet_id, 'Antirrábica', CURDATE() - INTERVAL 1 YEAR, CURDATE() + INTERVAL 7 DAY, @marca, 0
FROM DUAL WHERE @masc_id IS NOT NULL AND @vet_id IS NOT NULL;

INSERT INTO desparasitaciones (mascota_id, veterinario_id, tipo, producto, fecha_aplicacion, proxima_dosis, notas, notificado)
SELECT @masc_id, @vet_id, 'interna', 'Drontal Plus', CURDATE() - INTERVAL 3 MONTH, CURDATE() + INTERVAL 7 DAY, @marca, 0
FROM DUAL WHERE @masc_id IS NOT NULL AND @vet_id IS NOT NULL;

-- ── 3. Resultado (vuelve a ejecutar esto después del ciclo) ──
SELECT NOW() AS ahora_mysql;

-- Registros de prueba: la cita debe estar a 90–150 min cuando corra el ciclo;
-- vacuna y desparasitación pasan a notificado = 1 cuando el proceso las toma
SELECT 'cita' AS tipo, c.id, c.fecha_hora AS fecha, c.estado AS estado_o_notificado,
       TIMESTAMPDIFF(MINUTE, NOW(), c.fecha_hora) AS minutos_para_la_cita
FROM citas c WHERE c.notas = '[PRUEBA RECORDATORIO]'
UNION ALL
SELECT 'vacuna', v.id, v.proxima_dosis, v.notificado, NULL
FROM vacunas v WHERE v.notas = '[PRUEBA RECORDATORIO]'
UNION ALL
SELECT 'desparasitacion', d.id, d.proxima_dosis, d.notificado, NULL
FROM desparasitaciones d WHERE d.notas = '[PRUEBA RECORDATORIO]';

-- Envíos por Meta de hoy (esperado: 1 recordatorio_cita + 2 recordatorio_vacuna)
SELECT id, created_at, tipo, estado, telefono, LEFT(mensaje, 80) AS mensaje, error
FROM wa_mensajes_log
WHERE proveedor = 'meta' AND created_at >= CURDATE()
ORDER BY id DESC;

-- ── 4. Limpieza (borra solo los registros de prueba) ─────────
/*
DELETE FROM citas             WHERE notas = '[PRUEBA RECORDATORIO]';
DELETE FROM vacunas           WHERE notas = '[PRUEBA RECORDATORIO]';
DELETE FROM desparasitaciones WHERE notas = '[PRUEBA RECORDATORIO]';
*/
