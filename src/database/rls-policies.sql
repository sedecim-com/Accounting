-- ============================================================
-- TENANT ISOLATION POLICIES  (canonical, re-runnable)
--
-- migrate.ts runs this file AFTER every migration, for a reason
-- learned the hard way: a hardening migration is a one-shot. It
-- protects what exists when it runs, and every table created by a
-- later migration is born WITHOUT a policy, silently.
-- It actually happened with ai_external_ops, created nine minutes later.
--
-- It is idempotent: DROP POLICY IF EXISTS + CREATE on every pass.
-- ============================================================

DO $mig$
DECLARE
  r          record;
  pred       text;
  applied    int := 0;
  -- users and sessions are excluded on purpose: the authentication path
  -- has to read them BEFORE knowing which tenant the caller belongs to.
  -- tenants is the root of the hierarchy and migrations has no scope.
  excluded   text[] := ARRAY['users', 'sessions', 'tenants', 'migrations'];
BEGIN
  FOR r IN
    SELECT c.relname AS tbl,
           bool_or(a.attname = 'tenant_id')                      AS has_tenant,
           bool_or(a.attname = 'tenant_id' AND NOT a.attnotnull) AS tenant_nullable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')      -- ordinary or partitioned table
      AND NOT c.relispartition         -- partitions inherit from the parent
      AND a.attname IN ('tenant_id', 'entity_id')
      AND c.relname <> ALL (excluded)
    GROUP BY c.relname
    ORDER BY c.relname
  LOOP
    IF r.has_tenant THEN
      -- Direct comparison: the cheap path.
      IF r.tenant_nullable THEN
        -- tenant_id NULL = shared global row (bitcoin anchors,
        -- integration events). The app already queries it that way.
        pred := 'tenant_id = public.app_current_tenant() OR tenant_id IS NULL';
      ELSE
        pred := 'tenant_id = public.app_current_tenant()';
      END IF;
    ELSE
      -- entity_id only: the tenant is resolved via legal_entities, which
      -- is in turn protected by its own policy.
      pred := 'entity_id IN (SELECT id FROM public.legal_entities'
           || ' WHERE tenant_id = public.app_current_tenant())';
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.tbl);
    -- FOR ALL with USING and no WITH CHECK: Postgres reuses USING to
    -- validate new rows, so a row cannot be INSERTED or MOVED into
    -- another tenant either.
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I FOR ALL USING (%s)', r.tbl, pred);

    applied := applied + 1;
  END LOOP;

  RAISE NOTICE 'RLS applied to % tables', applied;
END
$mig$;

-- ============================================================
-- PRIVILEGIOS DE LA APLICACIÓN (auto-reparación)
--
-- Los privilegios por defecto solo alcanzan a lo que crea el dueño del
-- esquema. Una tabla creada por OTRO rol —lo que pasó con siete de ellas
-- mientras MIGRATION_DATABASE_URL no existía— nace invisible para la app,
-- y el síntoma aparece semanas después como "permission denied".
--
-- Esto vuelve a otorgar sobre todo lo que el rol actual posee, en cada
-- migración. No falla si el rol de la app no existe (desarrollo local).
-- ============================================================
DO $grants$
DECLARE r record; n int := 0;
DECLARE
  -- Las bitácoras de sólo agregar. La lista es corta a propósito y no se
  -- deriva por heurística de nombre: hay una docena de tablas que PARECEN
  -- bitácora —policy_decisions, webhook_deliveries, ai_external_ops,
  -- blockchain_attestations, integration_events— y reciben UPDATE del
  -- código o son máquinas de estado. Meterlas aquí las rompería.
  -- El criterio para entrar es tener el disparador que rechaza UPDATE y
  -- DELETE (migraciones 033 y 035); esta lista es su reflejo, y
  -- src/plan/criterios.ts falla si las dos dejan de coincidir.
  append_only text[] := ARRAY['audit_log', 'fiscal_credential_access_log'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_app') THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'S')
      AND NOT c.relispartition
      AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO mnemosine_app', r.relname);
    ELSIF r.relname = ANY (append_only) THEN
      -- Estas tablas son de sólo agregar, y este bloque corre DESPUÉS de
      -- todas las migraciones: sin la excepción, el GRANT general deshacía
      -- en la misma corrida el REVOKE de las migraciones 033 y 035 y
      -- dejaba la bitácora modificable otra vez. El disparador seguía
      -- deteniéndolo, pero la primera capa —la barata, la que Postgres
      -- aplica antes de ejecutar nada— quedaba muerta sin que nada lo
      -- dijera. fiscal_credential_access_log vivió así desde la 014, que
      -- sólo revocó FROM PUBLIC y por tanto nunca tocó a mnemosine_app.
      EXECUTE format('REVOKE ALL ON public.%I FROM mnemosine_app', r.relname);
      EXECUTE format('GRANT SELECT, INSERT ON public.%I TO mnemosine_app', r.relname);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO mnemosine_app', r.relname);
    END IF;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'privilegios reaplicados sobre % objetos', n;
END
$grants$;

-- ============================================================
-- CHILD-TABLE POLICIES (tables with no tenant_id/entity_id)
--
-- The loop above only covers tables that carry the column. Child
-- tables (lines, allocations, paychecks' details…) reach their
-- tenant through the parent FK, so each gets an EXISTS policy.
-- The parent's own FORCED policy filters the subquery for the
-- querying role — the child inherits tenant scoping without
-- duplicating the tenant predicate.
--
-- Deliberately EXCLUDED (global/shared or pre-tenant):
--   exchange_rates, tax_parameters, tax_tables (reference data),
--   identities (authentication path, runs before tenant context).
-- ============================================================

DO $child$
DECLARE
  m record;
  applied int := 0;
BEGIN
  FOR m IN
    SELECT * FROM (VALUES
      ('journal_entry_lines',          'journal_entry_id',           'journal_entries'),
      ('invoice_lines',                'invoice_id',                 'invoices'),
      ('bill_lines',                   'bill_id',                    'bills'),
      ('payment_allocations',          'payment_id',                 'customer_payments'),
      ('payment_applications',         'payment_id',                 'vendor_payments'),
      ('inventory_layers',             'item_id',                    'inventory_items'),
      ('inventory_layer_consumption',  'item_id',                    'inventory_items'),
      ('depreciation_schedules',       'asset_id',                   'fixed_assets'),
      ('bank_transactions',            'bank_account_id',            'bank_accounts'),
      ('reconciliation_matches',       'reconciliation_session_id',  'reconciliation_sessions'),
      ('paycheck_earnings',            'paycheck_id',                'paychecks'),
      ('paycheck_deductions',          'paycheck_id',                'paychecks'),
      ('paycheck_taxes',               'paycheck_id',                'paychecks'),
      ('garnishments',                 'employee_id',                'employees'),
      ('employee_benefit_elections',   'employee_id',                'employees'),
      ('employee_compensation_history','employee_id',                'employees'),
      ('ai_messages',                  'session_id',                 'ai_sessions'),
      ('xml_document_lines',           'xml_document_id',            'xml_documents'),
      ('webhook_deliveries',           'webhook_id',                 'webhook_subscriptions')
    ) AS t(child, fk, parent)
  LOOP
    IF to_regclass('public.' || m.child) IS NULL THEN
      CONTINUE;  -- table not created yet in this environment
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', m.child);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', m.child);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_child ON public.%I', m.child);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_child ON public.%I FOR ALL USING '
      || '(EXISTS (SELECT 1 FROM public.%I p WHERE p.id = %I.%I))',
      m.child, m.parent, m.child, m.fk
    );
    applied := applied + 1;
  END LOOP;
  RAISE NOTICE 'child RLS applied to % tables', applied;
END
$child$;

-- ============================================================
-- DUEÑO DE LAS VISTAS MATERIALIZADAS
--
-- Una vista corre con los permisos de SU DUEÑO, no de quien la consulta. Las
-- migraciones las crea el rol que las aplica —en CI, un superusuario— así que
-- una consulta de la aplicación contra mv_trial_balance leía a través de la
-- RLS de TODOS los inquilinos. verify-isolation.sh ya comprobaba esto y era
-- su única comprobación en rojo.
--
-- Reasignarlas a mnemosine_owner las devuelve al régimen normal: el dueño está
-- sujeto a las políticas como cualquier otro.
--
-- Silencioso cuando el rol no existe (entorno de desarrollo sin roles
-- aprovisionados) y cuando quien ejecuta no puede reasignar: es una mejora de
-- postura, no un requisito para que las migraciones corran.
-- ============================================================
DO $vistas$
DECLARE
  v RECORD;
  reasignadas INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_owner') THEN
    RAISE NOTICE 'mnemosine_owner no existe: no se reasignan vistas materializadas';
    RETURN;
  END IF;

  -- Para que la vista siga funcionando tras el cambio de dueño, ese dueño
  -- necesita poder leer las tablas base: una vista corre con SUS permisos, y
  -- reasignarla a un rol sin acceso la rompe entera con «permission denied for
  -- table accounts». Por eso el GRANT va ANTES del ALTER.
  --
  -- Esto no debilita nada: mnemosine_owner se crea NOBYPASSRLS, así que una
  -- vista suya queda SUJETA a las políticas — que es justo la propiedad que
  -- faltaba cuando la vista pertenecía a un superusuario.
  BEGIN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO mnemosine_owner';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'sin privilegio para otorgar lectura a mnemosine_owner; no se reasignan vistas';
    RETURN;
  END;

  FOR v IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('v', 'm')
      AND pg_get_userbyid(c.relowner) <> 'mnemosine_owner'
  LOOP
    BEGIN
      EXECUTE format('ALTER %s public.%I OWNER TO mnemosine_owner',
                     CASE WHEN (SELECT relkind FROM pg_class WHERE relname = v.relname
                                  AND relnamespace = 'public'::regnamespace) = 'm'
                          THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END,
                     v.relname);
      reasignadas := reasignadas + 1;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'sin privilegio para reasignar la vista %; queda con su dueño actual', v.relname;
    END;
  END LOOP;
  RAISE NOTICE 'vistas reasignadas a mnemosine_owner: %', reasignadas;
END
$vistas$;
