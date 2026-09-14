-- ============================================================================
-- org.person_name_key: el espejo de las grafias de cada persona
-- ============================================================================
--
-- ⚠ NO APLICADO. Se entrega para revisar y correr a mano.
-- ⚠ CORRER ESTO ANTES DE DESPLEGAR EL SPEC `person_name_key` DE simo-sync. El
--   sync hace upsert con la lista de columnas del SELECT; si la tabla no existe,
--   PostgREST rechaza el lote entero y esa tabla queda sin actualizar en cada
--   corrida.
--
-- Origen: `hr_centralizado.person_name_key`, una VISTA de BigQuery que une siete
-- fuentes de nombres contra `person_code`: display, legal_co, hr_usa, directory,
-- salesforce, loan_officer y el implicito del correo. 523 filas sobre 111
-- personas, medido el 2026-09-14.
--
--
-- ── PARA QUE, y por que no bastaba lo que ya habia ──────────────────────────
--
-- Lo necesita el modulo de P&L por Loan Officer, que tiene que cruzar la nomina
-- del P&L --texto libre en check_description, "LAINO CHEGWIN, GIAN L"-- con las
-- personas. Medido sobre los 46 loan officers de finance_division.loan_officials:
--
--     normalizacion de texto, sola          31 de 46
--     person_name_key, sola                 28 de 46
--     LAS DOS UNIDAS                        34 de 46, cero ambiguos
--
-- ⚠ QUE person_name_key SOLA DE MENOS QUE LA NORMALIZACION es el dato que
-- justifica traerla SIN retirar nada. `dim_person`, su base, tiene 111 personas;
-- org.roster_current 114 y org.dim_employee 127. Son poblaciones distintas, no
-- una contenida en la otra: 18 de los 46 loan officers no estan en dim_person
-- --David Kontny, Isabel Wagner, Ludwig Aguillon, Patty Anderson, Hortencia De
-- Anda, Karol Gonzalez, Saidu Quansah, Sergio Vermejo, Frank Rodriguez y nueve
-- mas--. Quien sustituya las otras fuentes por esta perdera a esos 18 y el
-- sintoma sera "sin nomina localizada", que se lee como un hallazgo y no como
-- una regresion.
--
-- Lo que esta tabla aporta y ningun algoritmo de texto puede: que
-- "steve badovinac" y "steven badovinac" son la misma persona. Eso se sabe o no
-- se sabe; no se deduce.
--
-- ⚠ Y NO SUSTITUYE A org.employee_alias NI A org.loan_officer_resolved. Cada una
-- responde otra pregunta y ya esta escrito en sus comentarios. Esta es de
-- LECTURA y no la escribe la app.

begin;

create table if not exists org.person_name_key (
    person_code text not null,
    name_key    text not null,
    src         text not null,
    synced_at   timestamptz,
    primary key (person_code, name_key, src)
);

comment on table org.person_name_key is
    'Espejo de hr_centralizado.person_name_key (BigQuery): todas las grafias por las que se puede nombrar a una persona, contra su person_code. 523 filas sobre 111 personas el 2026-09-14, de siete fuentes.

PARA QUE: cruzar texto libre --la nomina del P&L, que escribe "LAINO CHEGWIN, GIAN L"-- con una persona. Aporta lo que ninguna normalizacion de texto puede deducir: que "steve badovinac" y "steven badovinac" son la misma.

⚠ NO ES UN SUPERCONJUNTO de org.roster_current (114) ni de org.dim_employee (127). dim_person, su base, tiene 111 personas y 18 de los 46 loan officers de finance_division.loan_officials NO ESTAN en ella. Medido: esta tabla sola resuelve 28 de 46 y la normalizacion de texto sola 31; unidas, 34. Sustituir las otras fuentes por esta PIERDE 18 personas, y el sintoma seria "sin nomina localizada", que se lee como hallazgo y no como regresion.

⚠ NO CONFUNDIR con org.employee_alias (378 grafias llenadas a mano, otra pregunta) ni con org.loan_officer_resolved (la resolucion de nombres de loan officer para los cierres). Ninguna sustituye a otra.

De LECTURA: la escribe simo-sync, no la app. name_key ya viene normalizada en el origen -- NFD, sin diacriticos, minusculas, todo lo que no sea [a-z ] a espacio, colapsado. lib/lo-payroll-name.ts de homesi-pl replica esa normalizacion exacta: si cambia alli, cambia aqui, o las claves dejan de casar y nadie resuelve.';

comment on column org.person_name_key.src is
    'De cual de las siete fuentes sale esta grafia: display, legal_co, hr_usa, directory, salesforce, loan_officer o from_email. Se guarda porque una grafia que solo aparece en una fuente rara es la que conviene mirar cuando algo no cruza.';

comment on column org.person_name_key.synced_at is
    'Lo escribe syncTable en cada fila. No es un DEFAULT de la columna: un DEFAULT solo dispara en INSERT, y el upsert que actualiza una fila existente lo dejaria con la fecha de la primera carga.';

-- El sync entra como service_role. USAGE sobre el esquema ya se concedio el
-- 2026-08-30 (ver 2026-08-30-org-usage-service-role.sql); esto es la tabla.
grant select, insert, update, delete on org.person_name_key to service_role;

commit;

-- ── COMPROBACION despues de aplicar, antes de la primera corrida ────────────
--
--   select has_table_privilege('service_role','org.person_name_key','INSERT');
--   -- esperado: true
--
-- ── Y despues de la primera corrida ─────────────────────────────────────────
--
--   select count(*) as filas, count(distinct person_code) as personas,
--          count(distinct src) as fuentes, max(synced_at) as ultima
--     from org.person_name_key;
--   -- esperado el 2026-09-14: 523 filas, 111 personas, 7 fuentes
--
-- Si `personas` baja de 111 sin que RRHH haya dado de baja a nadie, el modulo de
-- P&L por Loan Officer empezara a decir "sin nomina localizada" de gente que si
-- la tiene. Ese es el fallo a vigilar, y no se ve solo.
