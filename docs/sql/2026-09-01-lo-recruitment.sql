-- ============================================================================
-- activity_report.lo_recruitment -- pipeline de reclutamiento de loan officers
-- ============================================================================
--
-- Destino de la novena tabla del sync. Origen:
-- `lending_marts.fct_lo_recruitment` (233 candidatos, 26 columnas).
--
-- Referencia para crear la tabla; los grants y las politicas de RLS van aparte
-- y los define quien la cree.
--
-- ⚠ `synced_at` NO ES OPCIONAL. El job la escribe en cada fila y el sweep borra
-- por `synced_at < <la corrida actual>`. Sin esa columna el upsert falla; con
-- ella nullable, una fila sin valor sobrevive a todos los sweeps.
--
-- Los tipos siguen a los de la vista: FLOAT64 -> double precision, DATE -> date,
-- INT64 -> integer. `loan_volume_14m` es volumen en dolares y `transactions_14m`
-- un conteo, pero la vista los expone a los dos como FLOAT: se respetan asi para
-- que el sync no tenga que convertir nada.

create table if not exists activity_report.lo_recruitment (
    recruitment_id          text primary key,
    candidate_name          text,
    recruiter               text,
    stage                   text,
    current_status          text,
    branch_code             text,
    nmls_number             text,
    licensed_states         text,

    -- ⚠ Ver los comentarios de abajo antes de usar las fechas de etapa.
    created_date            date,
    qualification_date      date,
    proposal_date           date,
    negotiation_date        date,
    close_date              date,
    closed_won_date         date,
    date_of_hire            date,
    last_stage_change       date,
    last_modified           date,

    loan_volume_14m         double precision,
    transactions_14m        double precision,
    mmi_link                text,

    reason_for_loss         text,
    reason_for_loss_detail  text,

    is_hired                boolean,
    is_lost                 boolean,
    is_open                 boolean,
    dias_abierto            integer,

    synced_at               timestamptz not null
);

comment on table activity_report.lo_recruitment is
    'Pipeline de reclutamiento de loan officers, el tercero de Salesforce junto con prestamos y realtors. Espejo de lending_marts.fct_lo_recruitment: el sync hace upsert por recruitment_id y barre lo que desaparece arriba.';

comment on column activity_report.lo_recruitment.qualification_date is
    'NO SIRVE PARA MEDIR TIEMPOS DE CICLO. El conector no trae OpportunityHistory ni OpportunityFieldHistory, asi que no hay registro de cuando un candidato entro a una etapa: esto es un campo que alguien llena a mano, presente en 69 de 233. Una fecha ausente significa que nadie la lleno, no que la etapa no se alcanzo.';

comment on column activity_report.lo_recruitment.proposal_date is
    'Misma advertencia que qualification_date: 62 de 233, llenado a mano.';

comment on column activity_report.lo_recruitment.negotiation_date is
    'Misma advertencia que qualification_date: 59 de 233, llenado a mano.';

comment on column activity_report.lo_recruitment.date_of_hire is
    'Casi vacia -- 4 de 233. NO usar como fecha de contratacion: para eso esta close_date, que esta en las 233 y no falta en ninguno de los 39 contratados.';

comment on column activity_report.lo_recruitment.dias_abierto is
    'Dias desde created_date, calculado por la vista. NULL para los cerrados: los 106 no nulos son exactamente los 106 abiertos. Es la forma correcta de responder "cuanto lleva abierto".';

comment on column activity_report.lo_recruitment.licensed_states is
    'Casi vacia: 2 de 233.';

comment on column activity_report.lo_recruitment.loan_volume_14m is
    'Casi vacia: 18 de 233, y 16 de esos son de los contratados.';

-- ---------------------------------------------------------------------------
-- Lo que NO esta en esta tabla
-- ---------------------------------------------------------------------------
-- La empresa del candidato. No esta en Broker_Company_Encompass__c ni en
-- Referred_By_Company__c: las dos vienen vacias en las 233. Donde se registra,
-- si se registra, es una pregunta abierta -- no hay que inventarle una columna.
