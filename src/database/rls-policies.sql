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
