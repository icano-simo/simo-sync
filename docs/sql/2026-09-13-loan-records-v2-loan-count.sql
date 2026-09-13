-- ============================================================================
-- activity_report.loan_records_v2 -- trece columnas para Loan Count
-- ============================================================================
--
-- Referencia para ampliar la tabla; los grants y las politicas de RLS no
-- cambian, la tabla ya existe. NO EJECUTADO.
--
-- POR QUE
--
-- Loan Count (homesi-pl) deja de contar sobre un archivo que alguien sube y
-- pasa a contar sobre esta tabla, que ya es el espejo diario de
-- lending_marts.fct_commercial_activity. El archivo se habia quedado atras:
-- agosto de 2026 tiene 47 cierres aqui y CERO en el archivo.
--
-- El conteo usa `is_closed AND counts_for_division`, y eso ya esta. Lo que
-- faltaba es el detalle del prestamo.
--
-- ⚠ SOLO SE AÑADEN COLUMNAS. `loan_records_v2` la lee tambien el portal de
-- actividad comercial, asi que esto es aditivo por obligacion: ninguna de las
-- 41 que ya estaban cambia de nombre, de tipo ni de significado.
--
-- ⚠ EL ORDEN IMPORTA: primero estas columnas, despues desplegar simo-sync. Al
-- reves, el upsert intenta escribir columnas que la tabla no tiene y falla la
-- corrida entera del grupo `core` -- once tablas que no tienen nada que ver.
--
-- Tipos segun la vista: STRING -> text, NUMERIC -> numeric. Todas nullable: un
-- prestamo puede no tener procesador, o no haber dejado margen.
--
-- ─── CUAN POBLADAS ESTAN, Y SOBRE QUE POBLACION ────────────────────────────
--
-- ⚠ MIRAR SIEMPRE SOBRE LOS CIERRES, NO SOBRE LAS 4.987 FILAS. La tabla
-- incluye miles de prestamos que nunca avanzaron, y ahi casi todo esta vacio
-- porque nunca llego a pasar. Medido el 2026-09-13, la diferencia no es sutil:
--
--                        sobre los 490 cierres      sobre las 4.987 filas
--   loan_purpose              490   100%                 4.986   100%
--   lead_source               490   100%                 2.986    60%
--   loan_processor_name       488    99%                 1.292    26%
--   loan_closer_name          434    89%                   558    11%
--   underwriter_name          432    88%                   720    14%
--   lo_assistant_1_name       359    73%                 1.756    35%
--   lo_assistant_2_name       284    58%                   930    19%
--   margen distinto de cero   437    89%
--
-- `lead_source` al 100% sobre los cierres es lo que permitio retirar el
-- `lead_source_lo` del archivo sin perder nada.
--
-- `lo_assistant_2_name` al 58% NO es un campo a medio llenar: es que no todo
-- prestamo tiene dos asistentes. Contar "prestamos sin segundo asistente" como
-- un hueco de datos seria leer una ausencia real como un fallo.

alter table activity_report.loan_records_v2
  -- De que tipo es el prestamo.
  add column if not exists loan_purpose            text,

  -- El origen del lead, de Encompass. Sustituye a `lead_source_lo` del archivo
  -- que se subia: verificado que son el mismo campo con los mismos valores,
  -- incluida la grafia rara 'ILG - In - House'. El archivo traia ademas cuatro
  -- valores que la fuente no usa -- Encompass Integration (47), B2B Strategy
  -- (4), Referral (3), External Referral (3) -- y 46 vacios, que eran residuos
  -- de captura y no otra clasificacion.
  add column if not exists lead_source             text,

  -- Los cinco roles que faltaban. El loan officer ya viaja en `loan_officer`;
  -- sin estos no se podia saber quien mas trabajo un prestamo.
  add column if not exists loan_processor_name     text,
  add column if not exists underwriter_name        text,
  add column if not exists loan_closer_name        text,
  add column if not exists lo_assistant_1_name     text,
  add column if not exists lo_assistant_2_name     text,

  -- ⚠ EL MARGEN SEGUN ENCOMPASS, EN PUNTOS. NO es el margen del P&L.
  --
  -- homesi-pl tiene sus propias cuentas de margen -- Back-end Margin,
  -- Front-end Margin, Discount Income -- que salen de la contabilidad y viven
  -- en finance_division.pl_transactions. Estas cinco salen del sistema de
  -- originacion. Son dos medidas de cosas parecidas por caminos distintos y no
  -- tienen por que coincidir: usar una donde se espera la otra da un numero
  -- plausible y equivocado, que es la peor clase.
  add column if not exists back_end_margin_pts     numeric,
  add column if not exists origination_points      numeric,
  add column if not exists concessions_pts         numeric,
  add column if not exists total_branch_margin_pts numeric,
  add column if not exists lender_credit_usd       numeric;

comment on column activity_report.loan_records_v2.lead_source is
  'Origen del lead segun Encompass. Sustituye al lead_source_lo del archivo que se subia a homesi-pl: mismo campo, mismos valores, sin los cuatro residuos de captura ni los 46 vacios que traia aquel.';

comment on column activity_report.loan_records_v2.total_branch_margin_pts is
  'Margen en PUNTOS segun Encompass. No es el margen contable del P&L de homesi-pl (Back-end, Front-end, Discount Income en finance_division.pl_transactions). Dos caminos distintos hacia una medida parecida; no tienen por que cuadrar.';

-- COMPROBAR DESPUES DE EJECUTAR, y antes de desplegar simo-sync:
--   select count(*) from information_schema.columns
--    where table_schema='activity_report' and table_name='loan_records_v2';   -- 54
--
-- Y despues de la primera corrida del sync:
--   select count(*) filter (where lead_source is not null),
--          count(*) filter (where loan_purpose is not null),
--          count(*) filter (where total_branch_margin_pts is not null)
--     from activity_report.loan_records_v2;
