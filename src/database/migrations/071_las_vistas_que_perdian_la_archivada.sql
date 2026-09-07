-- ============================================================
-- 071 · LAS VISTAS QUE PERDÍAN LA CUENTA ARCHIVADA (T13 · #100)
--
-- Las dos vistas materializadas del área de informes filtran
-- `a.is_active = true`, así que una cuenta ARCHIVADA con movimiento posteado
-- desaparece de ellas. Eso las pone en contra de la regla que T13 instaura en
-- el servicio de informes: un informe enseña la cuenta que lleva algo EN EL
-- PERIODO DEL INFORME, y el estado de la cuenta HOY no borra el dinero de ayer.
--
-- ── POR QUÉ NO BASTABA ARREGLAR SÓLO EL SERVICIO ────────────────────────
--
-- `getReportingViewStatus` (materialized-view-service.ts) coteja el MAYOR
-- contra estas vistas para decir si están frescas. Ensanchar el mayor y dejar
-- las vistas filtrando deja los dos lados con criterios distintos: la deriva
-- sale permanente y `mnemosine report view show` pide para siempre un
-- «rebuild» que no arregla nada, porque no hay nada roto que arreglar.
-- Medido antes de esta migración, con una cuenta archivada con movimiento:
-- `drift = -10000.0000`, `stale = true`, y refrescar no lo mueve.
--
-- Las tres salidas posibles eran: filtrar también el mayor (que dejaría al
-- cotejo ciego JUSTO para la cuenta que este tramo viene a rescatar), dejar
-- los dos lados desalineados (el defecto), o alinear las vistas con la regla.
-- Es la tercera.
--
-- ── QUÉ NO CAMBIA ───────────────────────────────────────────────────────
--
-- Ni las columnas, ni los nombres, ni los índices, ni el régimen de refresco:
-- se conservan los cuatro índices —incluidos los ÚNICOS, que son lo que
-- permite `REFRESH ... CONCURRENTLY`— con sus mismos nombres. Lo único que se
-- retira es el predicado de catálogo.
--
-- Las vistas ganan filas: las de las cuentas archivadas. Para una cuenta
-- archivada que nunca recibió una línea, sus columnas son ceros —igual que
-- las de cualquier cuenta activa sin movimiento, que ya estaban ahí—.
-- ============================================================

-- ── LOS PERMISOS SE GUARDAN ANTES DE TIRARLAS ───────────────────────────
--
-- `DROP` se lleva la ACL, y NADA la repone: el bucle de privilegios de
-- rls-policies.sql sólo recorre `relkind IN ('r','p','S')` —tablas, particiones
-- y secuencias—, así que las vistas materializadas (relkind 'm') quedan fuera.
-- En la base de desarrollo esas vistas llevan hoy `mnemosine_app=arwd` y
-- `mnemosine_owner=r`; sin este bloque, recrearlas dejaría a la aplicación sin
-- lectura y el fallo aparecería mucho después, lejos de esta migración.
--
-- Se guardan los GRANTs vigentes y se replican tal cual sobre las vistas
-- nuevas. En una instalación que no tuviera ninguno, no se inventa ninguno.
CREATE TEMP TABLE _acl_vistas_071 ON COMMIT DROP AS
SELECT c.relname::text AS vista,
       pg_get_userbyid(x.grantee)::text AS beneficiario,
       x.privilege_type::text AS privilegio
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
  CROSS JOIN LATERAL aclexplode(c.relacl) AS x
 WHERE c.relname IN ('mv_trial_balance', 'mv_account_balance_summary')
   AND c.relacl IS NOT NULL
   AND pg_get_userbyid(x.grantee) <> pg_get_userbyid(c.relowner);

DROP MATERIALIZED VIEW IF EXISTS mv_trial_balance CASCADE;

CREATE MATERIALIZED VIEW mv_trial_balance AS
SELECT a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type,
    a.normal_balance,
    a.entity_id,
    fp.id AS fiscal_period_id,
    fp.period_name,
    fp.start_date AS period_start,
    fp.end_date AS period_end,
    COALESCE(sum(jel.debit_amount), 0::numeric) AS total_debits,
    COALESCE(sum(jel.credit_amount), 0::numeric) AS total_credits,
    (COALESCE(sum(COALESCE(jel.debit_amount, 0::numeric)), 0::numeric)
      - COALESCE(sum(COALESCE(jel.credit_amount, 0::numeric)), 0::numeric)) AS net_balance
   FROM ((accounts a
     CROSS JOIN fiscal_periods fp)
     LEFT JOIN (journal_entry_lines jel
     JOIN journal_entries je ON ((je.id = jel.journal_entry_id) AND (je.status::text = 'posted'::text)))
       ON ((jel.account_id = a.id) AND (je.fiscal_period_id = fp.id)))
  WHERE (a.entity_id = fp.entity_id)
  GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance, a.entity_id,
           fp.id, fp.period_name, fp.start_date, fp.end_date;

CREATE UNIQUE INDEX idx_mv_trial_balance ON public.mv_trial_balance USING btree (account_id, fiscal_period_id);
CREATE INDEX idx_mv_trial_balance_entity ON public.mv_trial_balance USING btree (entity_id);

DROP MATERIALIZED VIEW IF EXISTS mv_account_balance_summary CASCADE;

CREATE MATERIALIZED VIEW mv_account_balance_summary AS
SELECT a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type,
    a.entity_id,
    COALESCE(sum(COALESCE(jel.debit_amount, 0::numeric)), 0::numeric) AS total_debits,
    COALESCE(sum(COALESCE(jel.credit_amount, 0::numeric)), 0::numeric) AS total_credits,
    COALESCE(sum((COALESCE(jel.debit_amount, 0::numeric) - COALESCE(jel.credit_amount, 0::numeric))), 0::numeric) AS current_balance,
    count(DISTINCT je.id) AS transaction_count,
    max(je.entry_date) AS last_transaction_date
   FROM (accounts a
     LEFT JOIN (journal_entry_lines jel
     JOIN journal_entries je ON ((je.id = jel.journal_entry_id) AND (je.status::text = 'posted'::text)))
       ON (jel.account_id = a.id))
  GROUP BY a.id, a.code, a.name, a.account_type, a.entity_id;

CREATE UNIQUE INDEX idx_mv_account_balance ON public.mv_account_balance_summary USING btree (account_id);
CREATE INDEX idx_mv_account_balance_entity ON public.mv_account_balance_summary USING btree (entity_id);

-- Y se devuelven, uno a uno, exactamente los que había.
DO $permisos$
DECLARE g record; devueltos integer := 0;
BEGIN
  FOR g IN SELECT * FROM _acl_vistas_071 LOOP
    EXECUTE format('GRANT %s ON public.%I TO %I', g.privilegio, g.vista, g.beneficiario);
    devueltos := devueltos + 1;
  END LOOP;
  RAISE NOTICE 'Permisos devueltos a las dos vistas: %', devueltos;
END
$permisos$;

COMMENT ON MATERIALIZED VIEW mv_trial_balance IS
  'Balanza materializada por cuenta y periodo. SIN filtro de is_active desde la 071 (T13): una cuenta archivada con movimiento posteado sigue llevando su dinero, y el cotejo de frescura compara el mayor contra esto con el MISMO criterio.';
COMMENT ON MATERIALIZED VIEW mv_account_balance_summary IS
  'Saldo acumulado por cuenta. SIN filtro de is_active desde la 071 (T13), por la misma razón que mv_trial_balance.';
