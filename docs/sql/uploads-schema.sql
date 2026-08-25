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
    load_mode         text    not null,           -- 'replace'
    min_rows_expected int     not null,           -- salvaguarda: aborta si el archivo viene corto
    sheet_name        text,                       -- 'Data' para Encompass; null para csv
    is_active         boolean not null default true,
    header_row        int     not null default 1,  -- el roster de USA lo trae en la 2
    required_columns  text[]  not null default '{}',  -- nombres CRUDOS del archivo
    drop_columns      text[]  not null default '{}'   -- nombres YA NORMALIZADOS
);

comment on table uploads.source is
    'Configuración por fuente. Una fuente nueva se da de alta acá sin desplegar código; lib/uploads/sources.ts sólo tiene lo que no se puede expresar como configuración.';
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

-- Asignar la fuente a quien la vaya a cargar. Sin una fila acá, la persona entra
-- a la app y no ve ninguna fuente -- que es el comportamiento correcto.
--
-- insert into uploads.user_source (user_email, source_key)
-- values ('alguien@simosolutionsgroup.com', 'encompass')
-- on conflict do nothing;
