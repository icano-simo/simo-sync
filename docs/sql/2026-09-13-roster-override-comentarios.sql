-- ============================================================================
-- Dos comentarios que describian un mundo que ya no existe
-- ============================================================================
--
-- NO CAMBIA DATOS NI ESTRUCTURA. Solo `comment on table`. Se puede correr en
-- caliente y es reversible volviendo a poner el texto anterior, que queda
-- copiado abajo.
--
-- POR QUE: el comentario de `org.roster_override` dice que toda recarga del
-- roster debe re-aplicar sus seis filas "o revertira los datos a valores que el
-- negocio ya rechazo". Ese miedo hizo abrir una investigacion entera el
-- 2026-09-13 para comprobar si el sync diario estaba deshaciendo seis
-- decisiones humanas cada mañana.
--
-- NO LO ESTA, y no puede estarlo. Lo que se midio:
--
--   - `org.roster_override` no la lee NADIE. Cero referencias en simo-sync, en
--     simoOS, en homesi-pl y en homesi-reporte-actividad.
--
--   - Y aunque alguien la leyera, no apunta a la tabla que el sync escribe. Su
--     clave es `employee_key`, de `org.dim_employee`. El sync escribe
--     `org.roster_current`, cuya clave es `person_code`. NO COMPARTEN CLAVE.
--
--   - `org.dim_employee.synced_from_bigquery_at` esta en NULL en las 127 filas:
--     ninguna corrida de BigQuery la ha tocado nunca.
--
--   - Las seis correcciones se verificaron una por una contra el estado de hoy
--     y LAS SEIS SE SOSTIENEN. Ninguna se ha revertido.
--
-- El miedo era real cuando se escribio: entonces el roster se subia A MANO
-- desde Monday, y una recarga manual si podia pisar lo corregido. Desde que
-- `roster_current` viene de BigQuery, el override se aplica AGUAS ARRIBA y
-- llega ya marcado con `has_override`. No hay nada que re-aplicar.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. org.roster_override
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Texto anterior, para poder volver:
--   'Correcciones confirmadas sobre el roster de Monday. Toda recarga del
--    roster debe re-aplicar estas filas o revertira los datos a valores que el
--    negocio ya rechazo.'

comment on table org.roster_override is
    'Correcciones confirmadas a mano sobre org.dim_employee, de la epoca en que el roster se subia desde Monday. Seis filas, confirmadas por Isabella Cano el 2026-08-13 y el 2026-08-14.

⚠ NO TIENE NADA QUE VER CON LA RECARGA DE org.roster_current, y su comentario anterior decia lo contrario: pedia re-aplicar estas filas en cada recarga del roster o "revertira los datos a valores que el negocio ya rechazo". Ese aviso costo una investigacion entera el 2026-09-13 y describe un peligro que ya no existe.

LA RAZON DE QUE NO APLIQUE: esta tabla se llavea por employee_key, que es de org.dim_employee. El sync diario escribe org.roster_current, que se llavea por person_code. No comparten clave, y el sync no toca dim_employee -- synced_from_bigquery_at esta en NULL en las 127 filas. Son dos mecanismos de correccion para dos tablas distintas.

MEDIDO el 2026-09-13: las seis correcciones se sostienen. Cuatro en dim_employee y employee_branch (Ana Peña, Julymar Castro, el branch 711 y el BM de Ana Manjarres, el no-BM de Nelson Calderon) y dos que ya subieron al origen, asi que BigQuery las trae corregidas (Luis Silva en 710, Ana Manjarres en 711).

LA QUE SIGUE ABIERTA, y es un problema distinto del que este comentario temia: las dos correcciones de NOMBRE no subieron al origen. roster_current trae "Ana Zegarra" y "July Castro", los dos valores que el negocio rechazo, y la pantalla de Admin los pinta porque lee display_name de ahi. No es una reversion: es una correccion que nunca llego a la tabla que la pantalla lee. Se arregla en hr_centralizado, no re-aplicando nada aqui.

⚠ NO BORRAR esta tabla aunque no la lea nadie. Es el registro de seis decisiones de negocio con su motivo, quien las confirmo y cuando.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. org.roster_current
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Se conserva entero lo que decia --sigue siendo cierto, incluido el aviso de
-- no confundirla con dim_employee-- y se le añade de donde vienen los
-- overrides, que es lo que faltaba para no tener que investigarlo.

comment on table org.roster_current is
    'Roster vigente desde BigQuery (hr_centralizado.roster_for_admin), para la pantalla de Admin. NO reemplaza a org.dim_employee: esa es la identidad que la app usa para navegar, con employee_key referenciado por 378 alias, rutas y una FK con cascada. Esta es de LECTURA y responde otra pregunta: quien esta hoy en el roster de RRHH, en que branch y desde cuando. La app no escribe aca.

LOS OVERRIDES VIENEN YA APLICADOS DESDE BIGQUERY. La vista roster_for_admin los resuelve aguas arriba y entrega la fila ya corregida; has_override es la señal de que esta fila lleva uno. No hay nada que re-aplicar despues del upsert, y escribir codigo que lo intente seria corregir dos veces. (La tabla de overrides en BigQuery es probablemente hr_centralizado.person_field_override, que es la que el comentario de producer_set_by_hand nombra para is_producer; no se verifico contra BigQuery al escribir esto.)

MEDIDO el 2026-09-13: 11 de 114 filas con has_override = true. Aimmee Buendia Hinojosa, Andres Robles, Claudia Velasco, Igleth Patricia Mercado Ceballos, Isa Vasquez, Isabel Wagner, Jose Lopez Boggio, Ludwig Aguillon, Mark Therianos, Rene Perez y Shon Lamberty. De esas 11, cuatro traen ademas active_set_by_hand: Isabel Wagner, Ludwig Aguillon, Mark Therianos y Rene Perez.

⚠ ESOS 11 NO SON LOS 6 DE org.roster_override. El solape es CERO, y son dos sistemas independientes que no se conocen: este vive en BigQuery y corrige roster_current; aquel vive aqui, se llavea por employee_key y corrige dim_employee. Confundirlos ya costo una investigacion.

PENDIENTE EN EL ORIGEN, no en esta app -- las tres se arreglan en hr_centralizado:
  1. dim_employee_co tiene 45 personas de Colombia y aqui llegan 43 (country = CO). Faltan dos y no se ha determinado que las filtra.
  2. Una persona tiene branch_code = "700 - 707" en dim_employee_co, dos codigos en un campo. No aparece asi en esta tabla: ningun branch_code de las 114 lleva guion ni espacio. O se normaliza en la vista, o esa persona es una de las dos que no llegan.
  3. Los nombres normalizados de Ana Peña y Julymar Castro, que aqui siguen llegando como "Ana Zegarra" y "July Castro" -- ver el comentario de org.roster_override.';

commit;

-- ============================================================================
-- COMPROBACION despues de aplicar
-- ============================================================================
--
-- Que los dos comentarios quedaron puestos:
--
--   select c.relname,
--          left(obj_description(c.oid), 80) as inicio
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'org'
--     and c.relname in ('roster_current', 'roster_override');
--
-- Y que lo que afirman sigue siendo verdad (11 y 6, sin solape):
--
--   select (select count(*) from org.roster_current where has_override) as bq_override,
--          (select count(*) from org.roster_override)                   as manual_override,
--          (select count(*)
--             from org.roster_override o
--             join org.dim_employee e using (employee_key)
--             join org.roster_current r on r.person_code = e.person_code
--            where r.has_override)                                      as solape;
--
-- Esperado: 11, 6, 0. Si el solape deja de ser 0, los dos mecanismos empezaron
-- a pisarse y hay que mirarlo antes de seguir.
