-- ============================================================================
-- Esquema `uploads` — app de cargas de archivos de simo-sync
-- ============================================================================
--
-- NO SE EJECUTÓ NADA DE ESTO. Revisalo y corrélo vos en simoOS-prod.
--
-- Para que PostgREST vea el esquema hay que agregarlo a "Exposed schemas"
-- (Settings -> API). Sin eso, todas las llamadas fallan con un error de
-- "schema no encontrado" que no tiene nada que ver con RLS.
--
-- El email de la sesión se lee de `auth.jwt() ->> 'email'`. Es el mismo criterio
-- en las tres tablas, y es lo que hace que "el usuario sólo ve sus propias
-- filas" sea una garantía de la base y no una decisión de la UI.

create schema if not exists uploads;

-- ---------------------------------------------------------------------------
-- Catálogo de fuentes
-- ---------------------------------------------------------------------------
create table if not exists uploads.source (
    source_key        text primary key,
    display_name      text    not null,
    target_dataset    text    not null,           -- 'lending_marts'
    target_table      text    not null,           -- 'encompass_loans_stage'
    load_mode         text    not null,           -- 'replace' | 'append'
    min_rows_expected int     not null,           -- salvaguarda: aborta si el archivo viene corto
    sheet_name        text,                       -- 'Data' para Encompass; null para csv
    is_active         boolean not null default true,
    header_row        int     not null default 1,  -- el roster de USA lo trae en la 2
    required_columns  text[]  not null default '{}',  -- nombres CRUDOS del archivo
    drop_columns      text[]  not null default '{}'   -- nombres YA NORMALIZADOS
);

comment on table uploads.source is
    'Configuración por fuente. Una fuente nueva se da de alta acá sin desplegar código; lib/uploads/sources.ts sólo tiene lo que no se puede expresar como configuración.';
comment on column uploads.source.load_mode is
    'replace: WRITE_TRUNCATE, la tabla entera es la carga. append: WRITE_APPEND, cada carga es un periodo y se acumulan. En append el cargador agrega upload_batch_id, uploaded_at y row_index; en replace no, porque el lote seria la tabla y el orden no sobrevive igual.';
comment on column uploads.source.header_row is
    'Fila del encabezado, 1-based. El roster de USA trae "Search:" en la 1 y los encabezados en la 2.';
comment on column uploads.source.required_columns is
    'Columnas que deben estar en el archivo, con el nombre CRUDO tal como viene. Vacío = la ruta se niega a cargar: sin validación, un archivo equivocado borraría los datos buenos con WRITE_TRUNCATE.';
comment on column uploads.source.drop_columns is
    'Columnas que NO deben llegar a BigQuery, con el nombre YA NORMALIZADO (numero_de_cedula, no "Número de Cédula"). Se descartan después de validar y antes de escribir. Un nombre que no exista en el archivo aborta la carga: o hay un typo y el dato sensible se cargaría igual, o el archivo cambió de forma.';
comment on column uploads.source.min_rows_expected is
    'Si el archivo trae menos filas que esto, la carga se aborta sin tocar BigQuery.';

-- ---------------------------------------------------------------------------
-- Quién puede cargar qué
-- ---------------------------------------------------------------------------
create table if not exists uploads.user_source (
    user_email text not null,
    source_key text not null references uploads.source(source_key) on delete cascade,
    primary key (user_email, source_key)
);

-- La UI lista por usuario y la ruta de subida verifica (email, source): los dos
-- caminos entran por el email, así que el índice de la PK ya los cubre.

-- ---------------------------------------------------------------------------
-- Bitácora de cargas
-- ---------------------------------------------------------------------------
create table if not exists uploads.load_log (
    id            bigserial primary key,
    source_key    text        not null references uploads.source(source_key),
    user_email    text        not null,
    uploaded_at   timestamptz not null default now(),
    file_name     text,
    rows_loaded   int,
    status        text        not null,
    error_message text,
    constraint load_log_status_check
        check (status in ('ok', 'validation_failed', 'error'))
);

-- La UI pide las últimas 5 por fuente, siempre ordenadas por fecha descendente.
-- ---------------------------------------------------------------------------
-- El resultado del sync que dispara la carga
-- ---------------------------------------------------------------------------
-- Se agregan despues, sobre la tabla que ya existe en produccion.
--
-- POR QUE HACEN FALTA: la carga dispara /api/sync y espera 5 segundos para
-- poder contar que paso, pero el sync tarda ~31. O sea que la tarjeta casi
-- siempre dice "actualizando" y el resultado real -- incluido el fallo -- queda
-- solo en el log de Vercel. El 31 de agosto eso dejo un error tres horas sin
-- que nadie se enterara, mientras alguien subia el archivo creyendo que el
-- dato se habia refrescado.
--
-- OJO -- ESTO INTRODUCE UN UPDATE EN UNA TABLA QUE ERA APPEND-ONLY. Es el unico
-- que hay, toca solo estas tres columnas, y lo hace el servidor con
-- service_role: no hay politica de UPDATE para `authenticated`, asi que la
-- usuaria sigue sin poder reescribir su propia bitacora. Lo que se escribe acá
-- no reemplaza nada: completa un dato que al momento del INSERT todavia no se
-- conocia.
--
-- alter table uploads.load_log
--     add column if not exists sync_status      text,
--     add column if not exists sync_error       text,
--     add column if not exists sync_finished_at timestamptz;
--
-- comment on column uploads.load_log.sync_status is
--     'ok | error. NULL = no se disparo ningun sync para esta carga (la fuente no alimenta una tabla sincronizada, o la carga no fue exitosa).';
-- comment on column uploads.load_log.sync_error is
--     'El mensaje del sync cuando fallo. NULL cuando salio bien o no se disparo.';
-- comment on column uploads.load_log.sync_finished_at is
--     'Cuando termino el sync. Puede ser bastante despues de uploaded_at: la respuesta de la carga no lo espera.';

create index if not exists load_log_source_uploaded_idx
    on uploads.load_log (source_key, uploaded_at desc);

comment on column uploads.load_log.rows_loaded is
    'Conteo leído DE VUELTA de BigQuery después de cargar, no el conteo parseado.';

-- ============================================================================
-- RLS
-- ============================================================================
--
-- El chequeo de `data_uploads` en allowed_apps se repite acá y no sólo en la
-- app: el gate de Next protege las páginas, pero PostgREST es alcanzable con un
-- JWT válido sin pasar por la app. Sin esta condición, cualquier usuario de
-- simoOS-prod con sesión podría leer el catálogo de fuentes por la API.

alter table uploads.source     enable row level security;
alter table uploads.user_source enable row level security;
alter table uploads.load_log   enable row level security;

-- Nada de acceso anónimo: estas tablas describen infraestructura interna.
revoke all on all tables in schema uploads from anon;

grant usage on schema uploads to authenticated;
grant select on uploads.source      to authenticated;
grant select on uploads.user_source to authenticated;
grant select, insert on uploads.load_log to authenticated;
grant usage on sequence uploads.load_log_id_seq to authenticated;

-- --- uploads.source --------------------------------------------------------
-- Sólo las fuentes que el usuario tiene asignadas. No se expone el catálogo
-- completo: qué otras fuentes existen no le concierne a quien no las carga.
drop policy if exists source_select_assigned on uploads.source;
create policy source_select_assigned
    on uploads.source
    for select
    to authenticated
    using (
        (auth.jwt() -> 'app_metadata' -> 'allowed_apps') ? 'data_uploads'
        and exists (
            select 1
            from uploads.user_source us
            where us.source_key = uploads.source.source_key
              and us.user_email = auth.jwt() ->> 'email'
        )
    );

-- --- uploads.user_source ---------------------------------------------------
-- Sólo sus propias asignaciones.
drop policy if exists user_source_select_own on uploads.user_source;
create policy user_source_select_own
    on uploads.user_source
    for select
    to authenticated
    using (
        (auth.jwt() -> 'app_metadata' -> 'allowed_apps') ? 'data_uploads'
        and user_email = auth.jwt() ->> 'email'
    );

-- --- uploads.load_log ------------------------------------------------------
-- Sólo sus propias cargas.
drop policy if exists load_log_select_own on uploads.load_log;
create policy load_log_select_own
    on uploads.load_log
    for select
    to authenticated
    using (
        (auth.jwt() -> 'app_metadata' -> 'allowed_apps') ? 'data_uploads'
        and user_email = auth.jwt() ->> 'email'
    );

-- Puede registrar cargas, pero sólo a su propio nombre y sólo de una fuente que
-- tenga asignada. Sin la segunda condición, alguien podría ensuciar la bitácora
-- de una fuente ajena aunque no pudiera cargarla.
drop policy if exists load_log_insert_own on uploads.load_log;
create policy load_log_insert_own
    on uploads.load_log
    for insert
    to authenticated
    with check (
        (auth.jwt() -> 'app_metadata' -> 'allowed_apps') ? 'data_uploads'
        and user_email = auth.jwt() ->> 'email'
        and exists (
            select 1
            from uploads.user_source us
            where us.source_key = uploads.load_log.source_key
              and us.user_email = auth.jwt() ->> 'email'
        )
    );

-- Sin políticas de UPDATE ni DELETE: la bitácora es append-only. Nadie borra su
-- propio historial de cargas, ni siquiera el que lo generó.

-- ============================================================================
-- Datos iniciales
-- ============================================================================
insert into uploads.source (
    source_key, display_name, target_dataset, target_table,
    load_mode, min_rows_expected, sheet_name, is_active,
    header_row, required_columns, drop_columns
)
values (
    'encompass', 'Encompass', 'lending_marts', 'encompass_loans_stage',
    'replace', 4000, 'Data', true,
    1,
    -- Las cinco que identifican al export y a la hoja correcta. No es la lista
    -- de las 58: es el conjunto mínimo que un archivo equivocado -- u otra hoja
    -- del mismo archivo -- no puede tener por casualidad.
    array[
        'Loan Number',
        'Loan Officer',
        'LOAN INFO CHANNEL',
        'LAST FINISHED MILESTONE',
        'HELOC LIEN POSITION'
    ],
    '{}'
)
on conflict (source_key) do nothing;

-- OJO -- `on conflict do nothing` NO actualiza la fila que ya existe. Si la
-- fuente 'encompass' ya está cargada (lo está, en producción), estas tres
-- columnas hay que ponérselas a mano; sin `required_columns` la ruta se niega
-- a cargar:
--
-- update uploads.source set
--     header_row       = 1,
--     required_columns = array[
--         'Loan Number', 'Loan Officer', 'LOAN INFO CHANNEL',
--         'LAST FINISHED MILESTONE', 'HELOC LIEN POSITION'
--     ],
--     drop_columns     = '{}'
-- where source_key = 'encompass';

-- ---------------------------------------------------------------------------
-- Fuente que ACUMULA (load_mode = 'append')
-- ---------------------------------------------------------------------------
-- Cada carga es un periodo. Una vez cerrado, esas filas no cambian, asi que
-- reemplazar reescribiria historia definitiva -- y de esas transacciones cuelgan
-- repartos de centro de costo y notas de otras apps.
--
-- El cargador agrega tres columnas que NO vienen del archivo:
--     upload_batch_id  STRING     un uuid por carga
--     uploaded_at      TIMESTAMP  cuando se cargo (el mismo en todas las filas)
--     row_index        INT64      posicion dentro de ESA carga, desde 1
--
-- row_index no identifica una fila: se recalcula en cada carga y solo significa
-- algo junto con upload_batch_id. Hace falta cuando el orden ES el dato -- un
-- valor que aparece una vez al abrir un bloque y hay que arrastrar hacia abajo.
-- Una tabla de BigQuery no tiene orden propio, asi que sin esta columna las
-- filas siguientes se atribuyen a lo que el motor devuelva primero: no falla,
-- da otro resultado.
--
-- Subir dos veces el mismo periodo NO borra nada. La vista se queda con la
-- carga mas reciente y la anterior queda como rastro; con estas columnas eso es
-- un QUALIFY ROW_NUMBER() OVER (PARTITION BY <periodo>
-- ORDER BY uploaded_at DESC, upload_batch_id) = 1. Conviene desempatar tambien
-- por upload_batch_id: todas las filas de un lote comparten uploaded_at, asi
-- que si dos cargas cayeran en el mismo instante el orden quedaria indefinido.
--
-- Queda INACTIVA (is_active = false) hasta que se decida activarla: mientras
-- este en false, la ruta responde 404 y la fuente no aparece en la app.
insert into uploads.source (
    source_key, display_name, target_dataset, target_table,
    load_mode, min_rows_expected, sheet_name, is_active,
    header_row, required_columns, drop_columns
)
values (
    'blast', 'Blast (GL Detail Report)', 'lending_marts', 'blast_gl_stage',
    'append', 500, 'GL Detail Report', false,
    1,
    -- Nombres CRUDOS, como vienen en el archivo. Las cinco que identifican al
    -- reporte: sin ellas no es un GL Detail Report.
    array[
        'GLNumber',
        'CheckDescription',
        'JournalPostDate',
        'Debit',
        'Credit'
    ],
    '{}'
)
on conflict (source_key) do nothing;

-- Las 11 columnas del archivo y el nombre que produce el normalizador. Vale
-- notar que camelCase NO se parte -- el normalizador solo corta donde hay algo
-- que no es letra ni digito -- asi que 'GLNumber' da 'glnumber' y no
-- 'gl_number'. Coinciden con los 11 campos STRING de blast_gl_stage:
--
--   GLNumber         -> glnumber          Vendor       -> vendor
--   GLName           -> glname            InvoiceNumb  -> invoicenumb
--   CheckDescription -> checkdescription  RefNumb      -> refnumb
--   JournalPostDate  -> journalpostdate   DocType      -> doctype
--   BegBalance       -> begbalance        Debit        -> debit
--                                         Credit       -> credit
--
-- Mas upload_batch_id, uploaded_at y row_index: 14 campos en total.

-- Asignar la fuente a quien la vaya a cargar. Sin una fila acá, la persona entra
-- a la app y no ve ninguna fuente -- que es el comportamiento correcto.
--
-- insert into uploads.user_source (user_email, source_key)
-- values ('alguien@simosolutionsgroup.com', 'encompass')
-- on conflict do nothing;
