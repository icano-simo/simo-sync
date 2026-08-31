-- ============================================================================
-- org.roster_current: quien produce y quien es realtor NPPM
-- ============================================================================
--
-- ⚠ CORRER ESTO ANTES DE DESPLEGAR. El sync hace upsert con la lista de
-- columnas del SELECT; si una no existe en la tabla, PostgREST rechaza el lote
-- entero y la tabla del roster queda sin actualizar en cada corrida.
--
-- Las cuatro ya estan en la vista `hr_centralizado.roster_for_admin`.

alter table org.roster_current
    add column if not exists is_producer          boolean,
    add column if not exists producer_set_by_hand boolean,
    add column if not exists is_nppm_realtor      boolean,
    add column if not exists active_set_by_hand   boolean;

comment on column org.roster_current.is_producer is
    'Quien origina prestamos: es lo que Business Plan y Outlook necesitan para saber quien es Loan Officer. Sale del cargo por defecto y admite override por persona. NO se deriva de los cierres -- un Loan Officer nuevo sin cierres igual produce, y hay un NonProducing Branch Manager con cero cierres que cuenta. La produccion confirma la regla, no la define.';

comment on column org.roster_current.producer_set_by_hand is
    'true = is_producer viene de un override en person_field_override, no del cargo. El cargo se equivoca en las dos direcciones, asi que esta columna es la que distingue "el titulo lo dice" de "alguien lo decidio".';

comment on column org.roster_current.is_nppm_realtor is
    'Esta en el roster Y es realtor NPPM contratado -- 7 personas. Su volumen va a la estrategia NPPM del branch, asi que el portal debe listarlas en el desglose de estrategia y NO entre los Loan Officers.';

comment on column org.roster_current.active_set_by_hand is
    'true = is_active viene de un override, no del archivo de RRHH. Es lo que distingue "activa segun el archivo" de "activa porque alguien lo decidio": Isabel Wagner y Ludwig Aguillon aparecen porque el archivo los trae, pero estan de baja.';
