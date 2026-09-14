-- ============================================================================
-- Dos comentarios que describian un mundo que ya no existe
-- ============================================================================
--
-- Ejecutar como `postgres` en el SQL Editor de Supabase (proyecto simoOS-prod).
-- Idempotente: `comment on table` reemplaza, no acumula.
--
-- APLICADO el 2026-09-13. Verificado despues, contra la base:
--
--   -- los dos textos puestos, sin rastro del mundo de Monday
--   select c.relname,
--          obj_description(c.oid) ilike '%has_override%' as menciona_senal,
--          obj_description(c.oid) ilike '%Monday%'       as queda_monday,
--          obj_description(c.oid) ilike '%NO BORRAR%'    as tiene_no_borrar
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'org'
--      and c.relname in ('roster_current', 'roster_override');
--   -- -> las dos mencionan has_override, ninguna dice Monday, y el NO BORRAR
--   --    esta en roster_override, que es donde tiene que estar
--
--   -- y cero filas tocadas, que es lo unico que este archivo promete
--   select (select count(*) from org.roster_override) as overrides,   -> 6
--          (select count(*) from org.roster_current)  as roster;      -> 114
--
-- ⚠ EL TEXTO DE ABAJO ES EL QUE ESTA EN LA BASE, NO EL BORRADOR.
--
-- Lo que se aplico fue una version revisada y mas corta que la que este archivo
-- llevaba al escribirse: misma sustancia, tres razones numeradas en vez de
-- prosa, y sin una frase del borrador que nombraba
-- `hr_centralizado.person_field_override` como la tabla de overrides de
-- BigQuery -- que era una suposicion, no una medicion, y bien quitada.
--
-- Se transcribio de vuelta con `obj_description` para que el archivo diga lo
-- que la base dice. Un .sql marcado APLICADO cuyo contenido no es el aplicado
-- es la misma trampa que este commit vino a arreglar: un texto que describe
-- algo que no se puede observar.
--
-- Se conserva como registro de por que aquel comentario decia lo que decia y
-- que se midio para desmentirlo, NO como algo pendiente.
--
-- NO CAMBIA DATOS NI ESTRUCTURA. Solo `comment on table`. Se corrio en caliente
-- y es reversible volviendo a poner el texto anterior, copiado en cada bloque.
--
-- ── POR QUE ─────────────────────────────────────────────────────────────────
--
-- El comentario de `org.roster_override` decia que toda recarga del roster debe
-- re-aplicar sus seis filas "o revertira los datos a valores que el negocio ya
-- rechazo". Ese miedo hizo abrir una investigacion entera el 2026-09-13 para
-- comprobar si el sync diario estaba deshaciendo seis decisiones humanas cada
-- mañana.
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
    'Correcciones confirmadas sobre el roster. Corrigen org.dim_employee, NO org.roster_current: su clave es employee_key y la de roster_current es person_code. Las dos tablas ni comparten clave.

El texto anterior decia "toda recarga del roster debe re-aplicar estas filas o revertira los datos a valores que el negocio ya rechazo". Eso era cierto cuando el roster se subia a mano; hoy no puede ocurrir, por tres razones medidas el 2026-09-13:
  1. simo-sync NO escribe en dim_employee. El spec lo dice en mayusculas y el dato lo confirma: synced_from_bigquery_at esta en NULL en las 127 filas.
  2. org.roster_override tiene CERO consumidores de codigo en los cuatro repos. Nada la lee, asi que nada la puede pisar.
  3. Las seis correcciones se sostienen hoy, comprobadas una por una: los dos nombres en dim_employee.full_name, los dos branch en employee_branch (710 y 711) y ademas ya corregidos en el origen, y los dos is_branch_manager en dim_employee.

NO CONFUNDIR con roster_current.has_override, que es otro mecanismo, en BigQuery, sobre otra tabla y para otras 11 personas. Solape medido: cero.

NO BORRAR aunque ningun codigo la lea. Es el registro de seis decisiones de negocio con su motivo, quien las confirmo y cuando. Un barrido de tablas sin consumidor la marcaria para borrar y estaria equivocado.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. org.roster_current
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Texto anterior: el primer parrafo de abajo, palabra por palabra. Se conservo
-- entero --sigue siendo cierto, incluido el aviso de no confundirla con
-- dim_employee-- y se le añadieron los overrides y los pendientes del origen.

comment on table org.roster_current is
    'Roster vigente desde BigQuery (hr_centralizado.roster_for_admin), para la pantalla de Admin. NO reemplaza a org.dim_employee: esa es la identidad que la app usa para navegar, con employee_key referenciado por 378 alias, rutas y una FK con cascada. Esta es de LECTURA y responde otra pregunta: quien esta hoy en el roster de RRHH, en que branch y desde cuando. La app no escribe aca.

LOS OVERRIDES LLEGAN YA APLICADOS desde BigQuery. La columna has_override lo señala: 11 de las 114 filas la traen a true el 2026-09-13 — Andres Robles, Aimmee Buendia Hinojosa, Isabel Wagner, Shon Lamberty, Jose Lopez Boggio, Ludwig Aguillon, Igleth Patricia Mercado Ceballos, Rene Perez, Isa Vasquez, Mark Therianos y Claudia Velasco. No hay nada que reaplicar en esta base.

NO CONFUNDIR con org.roster_override, que son otras seis correcciones, sobre org.dim_employee, con otra clave. Solape medido: cero.

PENDIENTE EN EL ORIGEN, no en esta app:
  - hr_centralizado.dim_employee_co tiene 45 personas de Colombia y aqui llegan 43. Faltan dos y no se sabe que las filtra.
  - Una persona tiene branch_code "700 - 707" en el origen, dos sucursales en un campo. No llega asi aqui: los 114 branch_code estan limpios.
  - Dos nombres corregidos en org.roster_override (Ana Pena y Julymar Castro) NO subieron al origen, asi que esta tabla sigue mostrando "Ana Zegarra" y "July Castro", los valores que el negocio rechazo el 2026-08-13. La pantalla de Admin los pinta y su has_override sale en false.';

commit;

-- ============================================================================
-- LA COMPROBACION QUE HAY QUE REPETIR, no la de aplicar
-- ============================================================================
--
-- La de aplicar esta arriba y ya se corrio. Esta es otra cosa: los comentarios
-- que acaban de ponerse AFIRMAN UN NUMERO --11 overrides de BigQuery, 6
-- manuales, cero solape-- y un comentario que afirma un numero envejece. Si el
-- solape deja de ser 0, los dos mecanismos empezaron a pisarse y lo que estas
-- tablas dicen de si mismas dejo de ser verdad.
--
--   select (select count(*) from org.roster_current where has_override) as bq_override,
--          (select count(*) from org.roster_override)                   as manual_override,
--          (select count(*)
--             from org.roster_override o
--             join org.dim_employee e using (employee_key)
--             join org.roster_current r on r.person_code = e.person_code
--            where r.has_override)                                      as solape;
--
-- Esperado: 11, 6, 0 -- medido asi el 2026-09-13. Los dos primeros pueden
-- moverse sin que nada este mal: RRHH corrige a mas gente, o alguien añade un
-- override manual. El TERCERO no: un solape distinto de cero significa que una
-- misma persona la estan corrigiendo los dos sistemas a la vez, y entonces hay
-- que decidir cual manda antes de tocar nada.
