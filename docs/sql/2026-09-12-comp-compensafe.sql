-- ============================================================================
-- comp.loan_commission y comp.hours_logged -- Compensafe
-- ============================================================================
--
-- Destinos trece y catorce del sync. Origen: `comp_marts.fct_loan_commission`
-- (361 prestamos, enero a agosto 2026) y `comp_marts.hours_logged` (448 filas,
-- agosto 2025 a agosto 2026).
--
-- Referencia para crear las tablas; los grants y las politicas de RLS van
-- aparte y los define quien las cree. NO EJECUTADO.
--
-- POR QUE UN SCHEMA NUEVO Y NO `hr_us_payroll`, QUE YA EXISTE
--
-- `hr_us_payroll` tiene seis tablas -- employee_draws, recoverable_draw_balances
-- y companeras -- CARGADAS A MANO por otra app. El sweep de este job borra lo
-- que no volvio a aparecer arriba, asi que un schema que mezcla espejos barridos
-- con tablas escritas por personas es un schema donde un spec mal apuntado borra
-- trabajo humano. `b2b_metrics`, `activity_report` y `org` ya siguen esa
-- separacion; `comp` la continua.
--
-- El nombre refleja `comp_marts`, que es el contrato: esto es un espejo, no un
-- modelo propio.
--
-- ⚠ HAY QUE ANADIR `comp` A `pgrst.db_schemas` O POSTGREST NO LO VE.
--
-- Es un ajuste del ROL `authenticator`, en la base, y se cambia con SQL:
--
--   alter role authenticator set pgrst.db_schemas =
--     'public, b2b_metrics, ..., comp';
--   notify pgrst, 'reload config';
--
-- Hay que reescribir la lista ENTERA, porque `set` reemplaza y no anade: leerla
-- primero no es opcional. Se lee asi, que es tambien como se comprueba despues:
--
--   select setconfig from pg_db_role_setting s
--   join pg_roles r on r.oid = s.setrole
--   where r.rolname = 'authenticator';
--
-- Una tabla que existe y no esta expuesta falla con "Could not find the table
-- ... in the schema cache", que se lee como "la tabla no existe" y manda a
-- buscar al lugar equivocado.
--
-- ⚠ Y ESA LISTA SE HA RESETEADO SOLA EN ESTE PROYECTO. Si un dia el sync
-- empieza a fallar con ese mensaje sin que nadie haya tocado nada, es lo
-- primero que hay que mirar -- no el DDL.
--
-- ⚠ Y NO ES UNA BASE SOLO NUESTRA. Verificado el 2026-09-12: expone TRECE
-- schemas -- public, b2b_metrics, activity_report, pipeline_forecast,
-- finance_pl, hr_us_payroll, finance_division, org, business_plan, uploads,
-- outlook, review y comp. Varias apps distintas comparten este proyecto, asi
-- que reescribir esa lista de memoria le quita la suya a alguien mas.
--
-- ⚠ `synced_at` NO ES OPCIONAL, en las dos. El job la escribe en cada fila y el
-- sweep borra por `synced_at < <la corrida actual>`. Sin la columna el upsert
-- falla; con ella nullable, una fila sin valor sobrevive a todos los sweeps.
--
-- Los tipos siguen a los de la vista: NUMERIC -> numeric, DATE -> date,
-- BOOL -> boolean, INT64 -> integer, STRING -> text.

create schema if not exists comp;

-- ============================================================================
-- comp.loan_commission
-- ============================================================================
--
-- GRANO: un prestamo. Verificado el 2026-09-12: 361 filas, 361 `loan_number`
-- distintos, ninguno nulo. Por eso sirve de clave de conflicto sin colapsar
-- nada, a diferencia de `hours_logged` aqui abajo.
--
-- CRUZA CON EL P&L POR `loan_number` Y SIN TRANSFORMAR NADA. Medido sobre una
-- muestra de 170: 160 existen en `loan_officials` y 160 tienen revenue en
-- `pl_transactions` -- 94% por los dos lados. Los que no cruzan son de
-- sucursales fuera de la division o anteriores al rango del P&L.
--
-- ⚠ NO HAY `person_code` EN ESTA VISTA, y no hace falta. Trae `lo_emp_no`, que
-- es un id estable, y el cruce con el P&L es por `loan_number`, que es exacto.
-- Agrupar por `lo_name` seria volver a emparejar nombres a mano, que es
-- justamente lo que esta fuente vino a evitar: de los 34 loan officers de esta
-- vista, solo 15 alcanzan un `person_code` a traves de `hours_logged`.
--
-- `upload_batch_id` y `uploaded_at` NO se sincronizan, igual que en
-- `org.hiring_tracking`: describen la carga del archivo al stage, no el
-- prestamo. Para "de cuando es este dato" esta `synced_at`.

create table if not exists comp.loan_commission (
    loan_number             text primary key,
    borrower                text,
    completed_date          date,

    -- Quien cobro. `lo_emp_no` es la unica identidad estable de los tres
    -- nombres: `processor_name` y `branch_manager_name` llegan como texto y no
    -- traen id, asi que sirven para mostrar y no para agrupar.
    lo_name                 text,
    lo_emp_no               text,
    processor_name          text,
    branch_manager_name     text,

    loan_amount             numeric,

    -- Los cuatro componentes y su total. `total_pay` viene calculado de arriba y
    -- se guarda tal cual en vez de sumarse aqui: recalcularlo seria una segunda
    -- verdad capaz de discrepar con la vista.
    lo_pay                  numeric,
    processor_pay           numeric,
    bm_pay                  numeric,
    other_pay               numeric,
    total_pay               numeric,

    -- Bps sobre el importe del propio prestamo, ya calculados arriba.
    lo_effective_bps        numeric,
    total_effective_bps     numeric,

    synced_at               timestamptz not null
);

-- ============================================================================
-- comp.hours_logged
-- ============================================================================
--
-- GRANO: una persona, un periodo de horas y UNA FECHA DE PAGO.
--
-- ⚠ LA CLAVE LLEVA `pay_date`, Y ESO NO ES UN DETALLE. Medido el 2026-09-12:
--
--     448 filas
--     334 distintas por (person_code, periodo)   -> 114 colisiones
--     359 distintas por (emp_no, periodo)        ->  89 colisiones
--     448 distintas por (emp_no, periodo, pay_date)  <- sin nulos
--
-- Los 78 grupos repetidos se separan LOS 78 por `pay_date`, ninguno por
-- sucursal y ninguno queda identico. Un periodo de horas puede pagarse en dos
-- fechas, y eso es el dato, no un duplicado. Sin `pay_date` en la clave, dos
-- filas del mismo lote colisionan y Postgres rechaza el batch ENTERO -- el
-- problema que ya tuvo `realtor_owner_map`.
--
-- ⚠ Y LA CLAVE USA `emp_no`, NO `person_code`. 34 filas -- 9 de las 39 personas
-- -- no tienen `person_code`: `hr_centralizado.person_name_key` no las resuelve.
-- Una clave primaria con nulos no existe, asi que `person_code` viaja como
-- columna y no como identidad. Que falte para 9 personas es un hueco de la
-- fuente y se muestra como tal; no se rellena aqui.

create table if not exists comp.hours_logged (
    -- Identidad de la fila. Los cuatro son not null: verificado que ninguno lo
    -- es en el origen, y si alguno empezara a serlo la carga debe fallar aqui y
    -- no producir una fila que el sweep no sabe distinguir.
    emp_no                  text not null,
    hours_period_from       date not null,
    hours_period_to         date not null,
    pay_date                date not null,

    -- Resuelto arriba contra hr_centralizado. NULL para 9 de 39 personas.
    person_code             text,
    person_name             text,
    -- El nombre tal como venia en el archivo, antes de resolver.
    employee_in_file        text,

    branch_code             text,

    paid_amount             numeric,
    recaptured_amount       numeric,
    net_amount              numeric,
    had_recapture           boolean,
    -- Cuantas lineas del archivo se agregaron en esta fila.
    lines                   integer,

    synced_at               timestamptz not null,

    constraint hours_logged_pkey
        primary key (emp_no, hours_period_from, hours_period_to, pay_date)
);

-- Para consultar por persona resuelta, que es como lo leera la app cuando el
-- modulo por loan officer se retome. No es unico: una persona tiene muchas.
create index if not exists hours_logged_person_code_idx
    on comp.hours_logged (person_code);

-- Para cruzar con el P&L por periodo.
create index if not exists loan_commission_completed_date_idx
    on comp.loan_commission (completed_date);
