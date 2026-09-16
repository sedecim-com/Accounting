-- ============================================================
-- 084 · THE ORDER NOBODY COULD FILE (F08 · #113)
--
-- Migration 075 closed the VOCABULARY of a garnishment order. It left open the
-- channel the CCPA caps actually travel through: `metadata`, a JSONB column
-- with DEFAULT '{}' and no constraint of any kind (008_payroll.sql:442). The
-- engine reads three keys out of it (garnishment-engine.ts:160-162) and
-- coerces every absence into a number, silently:
--
--   · a federal or state tax levy without `exempt_amount`
--       `const exempt = o.exempt_amount || 0`            (engine :224)
--       `amount = Math.max(0, disposable - exempt)`      (engine :225)
--     withholds ONE HUNDRED PERCENT of disposable earnings, and `cap_applied`
--     stays null (:226), so nothing on the payslip even flags it.
--
--   · a child-support order without `supports_second_family`
--       `supports_second_family: r.supports_second_family || false` (:183)
--       `ccpaChildSupportCap(false, …)` = 0.60 instead of 0.50     (:50-53)
--     over-withholds by ten points of disposable earnings.
--
-- Until this tranche nobody could file an order through the product, so the
-- only way in was hand SQL following the column comment — which is exactly the
-- path 075's header measured returning zero. F08 opens a supported door, and a
-- door that can file an order missing its exemption is a door onto that same
-- defect. The refusal is written twice on purpose: once in the service, where
-- the accountant gets a sentence naming the consequence, and once here, where
-- hand SQL cannot get around it.
--
-- ── WHY THE CHECK TESTS THE VALUE AND NOT THE KEY ───────────────────────
--
-- The obvious spelling is the jsonb existence operator. It does not close the
-- hole: existence is true for a key whose value is JSON null, and the engine
-- then reads SQL NULL out of it and coerces exactly as if the key were absent.
-- An order carrying a null-valued exemption would pass the constraint and
-- still take the whole cheque.
--
-- So the constraints assert the TYPE of the value. Two consequences worth
-- writing down:
--
--   · The exemption accepts a JSON number OR a JSON string. It is not
--     tolerance: the tree already persists it as a string
--     (tests/integration/t20-embargo-que-no-retenia.int.spec.ts:51) and the
--     engine reads it with `->>` plus parseFloat, so both encodings are the
--     contract today. Narrowing to `number` would reject data that works.
--   · The two cap flags must be JSON booleans, not merely present. The engine
--     casts them with `(metadata ->> '…')::boolean`, and a value like "yes"
--     raises 22P02 in the middle of a payroll run — a whole run aborting on
--     one bad order is worse than the order being refused at filing time.
--
-- And every comparison is wrapped so an ABSENT key yields FALSE rather than
-- NULL. This is the load-bearing detail: a CHECK constraint is SATISFIED when
-- its expression evaluates to NULL, so a type test that returns NULL for a
-- missing key admits precisely the row the constraint exists to refuse.
--
-- ── WHAT STOPS AND WHAT IS NORMALISED ───────────────────────────────────
--
-- `metadata` becomes NOT NULL. A NULL there and an empty object are the same
-- thing to every reader in the tree — `NULL ->> 'x'` and `'{}'::jsonb ->> 'x'`
-- both yield SQL NULL — so collapsing the two states changes no money and
-- leaves the column with one empty value instead of two. Rows carrying NULL on
-- a type whose metadata nobody reads are normalised to '{}' in the loop below.
--
-- Rows carrying NULL (or a missing/ill-typed key) on a LEVY or a SUPPORT order
-- are NOT normalised. They are named and the migration stops, which is 075's
-- doctrine (075:98-120) and the right outcome here: those rows are the orders
-- that are over-withholding today, so the failure is the finding. Guessing a
-- value for them would be inventing a court's exemption.
--
-- `is_active` is deliberately left nullable. Restricting it would mean
-- deciding what the rows that already carry NULL meant, and neither answer is
-- safe to guess: `true` starts a withholding that is not happening today, and
-- `false` freezes an order a court may have live. The writer this tranche
-- ships always writes the column explicitly; restricting it is a migration of
-- its own, after someone has looked at those rows.
--
-- ── THE UNIQUE INDEX, AND WHEN TO DROP IT ───────────────────────────────
--
-- The table has no uniqueness of any kind today: the only index is
-- `idx_garnishments_active` and it is not unique (008:445), so filing the same
-- court order twice creates two rows and doubles the withholding with no
-- error. The partial unique index below makes that a loud 23505.
--
-- It may be too tight, and the reason is written here rather than discovered:
-- one case number can legitimately produce more than one concurrent order
-- (current support and arrears as separate rows). The predicate on `is_active`
-- already lets a revoked-and-reissued order be refiled. If that multi-order
-- case turns out to be real, the fix is to drop the index and keep the refusal
-- in the service, where it can warn instead of block — not to ship neither.
--
-- ── THE OPT-IN, WITHOUT WHICH THIS DOES NOT RUN IN A REAL FIRM ──────────
--
-- Measured by 075 and not deduced: `garnishments` is in `rls-policies.sql`
-- (:63) and `migrate.ts` opens the session with `SET row_security = off`
-- (:90). That combination does NOT disable RLS — PostgreSQL raises 42501 the
-- moment a statement would be affected by a policy — and 075 died with «query
-- would be affected by row-level security policy for table "garnishments"»
-- before installing anything. So the opt-in goes first and the census walks
-- the tenants setting the context, exactly as 075:74-118 does: a census with
-- no tenant context sees nobody's rows and absolves blindly, which is the same
-- trap. tests/integration/migration-084-under-rls.int.spec.ts runs this file
-- on a non-superuser bank and proves it, the way the 075 spec does.
-- ============================================================

SET LOCAL row_security = on;

-- ── 1 · THE NULL THAT MEANS NOTHING, COLLAPSED ──────────────────────────
--
-- Only for the types whose metadata no reader consults. A levy or a support
-- order with NULL metadata is handled by the census below, which stops.
DO $normalise$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    UPDATE garnishments
       SET metadata = '{}'::jsonb
     WHERE metadata IS NULL
       AND garnishment_type NOT IN ('tax_levy_federal', 'tax_levy_state',
                                    'child_support', 'pension_alimenticia');
  END LOOP;
END
$normalise$;

-- ── 2 · THE CENSUS, WHICH NAMES INSTEAD OF RESTRICTING IN SILENCE ───────
DO $census$
DECLARE
  t       record;
  found   text;
  levies  text := '';
  support text := '';
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    SELECT string_agg(id::text, ', ') INTO found
      FROM garnishments
     WHERE garnishment_type IN ('tax_levy_federal', 'tax_levy_state')
       AND COALESCE(jsonb_typeof(metadata -> 'exempt_amount'), 'missing')
           NOT IN ('number', 'string');
    IF found IS NOT NULL THEN levies := levies || found || ' '; END IF;

    SELECT string_agg(id::text, ', ') INTO found
      FROM garnishments
     WHERE garnishment_type IN ('child_support', 'pension_alimenticia')
       AND (COALESCE(jsonb_typeof(metadata -> 'supports_second_family'), 'missing') <> 'boolean'
            OR COALESCE(jsonb_typeof(metadata -> 'arrears_over_12_weeks'), 'missing') <> 'boolean');
    IF found IS NOT NULL THEN support := support || found || ' '; END IF;
  END LOOP;

  IF levies <> '' THEN
    RAISE EXCEPTION '084: these levy orders have no usable metadata.exempt_amount (%): each of them withholds 100%% of disposable earnings today. Capture the Pub 1494 exemption the notice states before restricting the column', levies;
  END IF;
  IF support <> '' THEN
    RAISE EXCEPTION '084: these support orders have no usable metadata.supports_second_family / metadata.arrears_over_12_weeks (%): each of them is capped at 60%% where the CCPA may allow only 50%%. Capture both answers before restricting the column', support;
  END IF;
END
$census$;

-- ── 3 · THE CONSTRAINTS ─────────────────────────────────────────────────

ALTER TABLE garnishments ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE garnishments
  ADD CONSTRAINT ck_garnishments_levy_exemption
  CHECK (garnishment_type NOT IN ('tax_levy_federal', 'tax_levy_state')
         OR COALESCE(jsonb_typeof(metadata -> 'exempt_amount'), 'missing') IN ('number', 'string'));

ALTER TABLE garnishments
  ADD CONSTRAINT ck_garnishments_support_caps
  CHECK (garnishment_type NOT IN ('child_support', 'pension_alimenticia')
         OR (COALESCE(jsonb_typeof(metadata -> 'supports_second_family'), 'missing') = 'boolean'
             AND COALESCE(jsonb_typeof(metadata -> 'arrears_over_12_weeks'), 'missing') = 'boolean'));

CREATE UNIQUE INDEX ux_garnishments_case_active
  ON garnishments (employee_id, case_number)
  WHERE case_number IS NOT NULL AND is_active;

COMMENT ON COLUMN garnishments.metadata IS
  'The CCPA inputs the engine reads: exempt_amount (number or string) on a levy, supports_second_family and arrears_over_12_weeks (JSON booleans) on a support order. NOT NULL and constrained BY VALUE since 084: a key that is merely present, with a null value, coerces to zero in the engine and takes the whole cheque.';
