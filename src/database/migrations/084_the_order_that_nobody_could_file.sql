-- ============================================================
-- 084 · THE ORDER NOBODY COULD FILE (F08 · #113)
--
-- Migration 075 closed the VOCABULARY of a garnishment order. It left open the
-- channel the CCPA caps actually travel through: `metadata`, a JSONB column
-- with DEFAULT '{}' and no constraint of any kind (008_payroll.sql:442). The
-- engine reads three keys out of it (garnishment-engine.ts:166-168) and
-- coerces every absence into a number, silently:
--
--   · a federal or state tax levy without `exempt_amount`
--       `const exempt = o.exempt_amount || 0`            (engine :230)
--       `amount = Math.max(0, disposable - exempt)`      (engine :231)
--     withholds ONE HUNDRED PERCENT of disposable earnings, and `cap_applied`
--     stays null (:232), so nothing on the payslip even flags it.
--
--   · a child-support order without `supports_second_family`
--       `supports_second_family: r.supports_second_family || false` (:189)
--       `ccpaChildSupportCap(false, …)` = 0.60 instead of 0.50     (:50-53)
--     over-withholds by ten points of disposable earnings.
--
-- Until this tranche nobody could file an order through the product, so the
-- only way in was hand SQL following the column comment — which is exactly the
-- path 075's header measured returning zero. F08 opens a supported door, and a
-- door that can file an order missing its exemption is a door onto that same
-- defect. The refusal is written twice on purpose: once in the service, where
-- the accountant gets a sentence naming the consequence, and once here, over
-- the rows hand SQL writes.
--
-- ── WHY THE CHECK TESTS THE VALUE AND NOT THE KEY ───────────────────────
--
-- The obvious spelling is the jsonb existence operator. It does not close the
-- hole: existence is true for a key whose value is JSON null, and the engine
-- then reads SQL NULL out of it and coerces exactly as if the key were absent.
-- An order carrying a null-valued exemption would pass the constraint and
-- still take the whole cheque.
--
-- AND TESTING THE TYPE IS NOT ENOUGH EITHER, which is the correction this file
-- carries from its own review. `jsonb_typeof('"0.0000"')` is `'string'`, so a
-- type test admits an exemption of ZERO — and zero is not a smaller exemption,
-- it is the SAME OUTCOME as no exemption at all: `disposable - 0`, the whole
-- cheque, `cap_applied` null. The empty string sails through a type test too
-- and reaches the engine as `undefined || 0`. Four spellings — absent, null,
-- zero, unparseable — produced one outcome, and a constraint that stopped two
-- of them while the sentence next to it claimed all four is worse than no
-- constraint: it is a fence with a gate in it.
--
-- So the levy CHECK asserts that the value PARSES AS A POSITIVE NUMBER, in a
-- CASE (whose evaluation order Postgres guarantees, unlike the two sides of an
-- AND) so the cast can never see a string that is not a number:
--
--   · Number or string are both accepted, and that is not tolerance: the tree
--     already persists it as a string
--     (tests/integration/t20-embargo-que-no-retenia.int.spec.ts:51) and the
--     engine reads it with `->>` plus parseFloat, so both encodings are the
--     contract today. `->>` flattens the two into one text, which is why the
--     same predicate covers both.
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
-- ── THE MEXICAN ORDER IS NOT A CCPA ORDER, AND THE CHECK SAYS SO ────────
--
-- `ck_garnishments_support_caps` covers `child_support` and NOT
-- `pension_alimenticia`, and the split is the whole argument of this tranche
-- applied to its own constraint.
--
-- Those two booleans are CCPA inputs. The CCPA does not govern a Mexican
-- maintenance order, and the engine never even reads them for one: the cascade
-- runs only inside `if (emp.country_code === 'US')` (paycheck-service.ts:493,
-- call at :500). Demanding them of a `pension_alimenticia` row would stop
-- `npm run migrate` on precisely the firms that have a Mexican order on file —
-- and the only way forward would be to write two CCPA answers onto a court
-- order the CCPA never touched. That is inventing data, in the same file that
-- refuses to invent a Mexican ceiling and in the same tranche whose service
-- header says this table exists to HOLD a Mexican court order while nothing
-- computes it. Such rows are not hypothetical: 075 admitted the type on
-- purpose (075:132-133), and t20's fixture files one.
--
-- What the constraint DOES say about that type is the part that is true of it:
-- if a cap answer is PRESENT it must be a real boolean, because
-- `(metadata ->> '…')::boolean` over "yes" aborts a payroll run whatever the
-- employee's country. Absent is allowed; wrong is not.
--
-- A CHECK cannot join `employees`, so the country half cannot live in the
-- constraint. It lives in the census below, which CAN join — and which stops
-- for a `pension_alimenticia` row whose employee IS American, because for that
-- one the engine does run and does read the two answers.
--
-- ── WHAT STOPS AND WHAT IS NORMALISED ───────────────────────────────────
--
-- `metadata` becomes NOT NULL. A NULL there and an empty object are the same
-- thing to every reader in the tree — `NULL ->> 'x'` and `'{}'::jsonb ->> 'x'`
-- both yield SQL NULL — so collapsing the two states changes no money and
-- leaves the column with one empty value instead of two.
--
-- EVERY NULL is collapsed, including a levy's, and that is not a softening:
-- the census below reads through COALESCE, which turns a NULL metadata and an
-- empty object into the same 'missing', so a row that was going to be named
-- is named either way. What is never guessed is a VALUE. (The first draft
-- excluded the four cap-bearing types from the normalisation and thereby left
-- a hole of its own: a `pension_alimenticia` row with NULL metadata against a
-- Mexican employee is no longer named by the census — correctly — and would
-- then have met `SET NOT NULL` as a raw failure.)
--
-- Rows with a missing or ill-typed key on a LEVY or a SUPPORT order the engine
-- reads are NOT normalised. They are named and the migration stops, which is
-- 075's doctrine (075:98-120) and the right outcome here: those rows are the
-- orders that are over-withholding today, so the failure is the finding.
--
-- `is_active` is deliberately left nullable. Restricting it would mean
-- deciding what the rows that already carry NULL meant, and neither answer is
-- safe to guess: `true` starts a withholding that is not happening today, and
-- `false` freezes an order a court may have live. The writer this tranche
-- ships always writes the column explicitly; restricting it is a migration of
-- its own, after someone has looked at those rows.
--
-- ── THE UNIQUE INDEX, WHAT IT CATCHES AND WHAT IT DOES NOT ──────────────
--
-- The table has no uniqueness of any kind today: the only index is
-- `idx_garnishments_active` and it is not unique (008:445), so filing the same
-- court order twice creates two rows and doubles the withholding with no
-- error. The partial unique index below makes that a loud 23505 — WHEN THE
-- ORDER CARRIES A CASE NUMBER. The predicate is `case_number IS NOT NULL AND
-- is_active`, `--case` is optional on `garnishment record`, and a missing one
-- is stored as NULL: two rows with no case number do not collide, because in
-- Postgres no NULL equals another. Saying flatly that «a double filing is a
-- 23505» would therefore be false of the writer's own default path, and this
-- file said it before its review. What covers the rest is in the service: a
-- second LIVE levy is refused there by name, because the engine's levy branch
-- has no counter between orders and two of them withhold more than the whole
-- cheque.
--
-- The index may still be too tight, and the reason is written here rather than
-- discovered: one case number can legitimately produce more than one
-- concurrent order (current support and arrears as separate rows). The
-- predicate on `is_active` already lets a revoked-and-reissued order be
-- refiled. If that multi-order case turns out to be real, the fix is to drop
-- the index and keep the refusal in the service, where it can warn instead of
-- block — not to ship neither.
--
-- And it gets a census of its own, like the constraints do. A unique index
-- built with no census dies on a raw Postgres message that names ONE duplicate
-- pair per attempt, after the two blocks above have already run — the exact
-- opposite of the doctrine this file follows everywhere else. The rows that
-- are doubling a person's withholding are the finding; they get enumerated.
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
-- on a non-superuser bank and proves it, the way the 075 spec does — and adds
-- the probe that tells apart «the DDL scan is not policy-affected» from «the
-- DDL scan silently saw one tenant's rows», which reading cannot settle.
-- ============================================================

SET LOCAL row_security = on;

-- ── 1 · THE NULL THAT MEANS NOTHING, COLLAPSED ──────────────────────────
DO $normalise$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    UPDATE garnishments SET metadata = '{}'::jsonb WHERE metadata IS NULL;
  END LOOP;
END
$normalise$;

-- ── 2 · THE CENSUS, WHICH NAMES INSTEAD OF RESTRICTING IN SILENCE ───────
DO $census$
DECLARE
  t        record;
  found    text;
  levies   text := '';
  support  text := '';
  mistyped text := '';
  twice    text := '';
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    SELECT string_agg(id::text, ', ') INTO found
      FROM garnishments
     WHERE garnishment_type IN ('tax_levy_federal', 'tax_levy_state')
       AND NOT (CASE
                  WHEN COALESCE(metadata ->> 'exempt_amount', '') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (metadata ->> 'exempt_amount')::numeric > 0
                  ELSE false
                END);
    IF found IS NOT NULL THEN levies := levies || found || ' '; END IF;

    SELECT string_agg(g.id::text, ', ') INTO found
      FROM garnishments g
      JOIN employees e ON e.id = g.employee_id
     WHERE (g.garnishment_type = 'child_support'
            OR (g.garnishment_type = 'pension_alimenticia' AND e.country_code = 'US'))
       AND (COALESCE(jsonb_typeof(g.metadata -> 'supports_second_family'), 'missing') <> 'boolean'
            OR COALESCE(jsonb_typeof(g.metadata -> 'arrears_over_12_weeks'), 'missing') <> 'boolean');
    IF found IS NOT NULL THEN support := support || found || ' '; END IF;

    SELECT string_agg(g.id::text, ', ') INTO found
      FROM garnishments g
      JOIN employees e ON e.id = g.employee_id
     WHERE g.garnishment_type = 'pension_alimenticia'
       AND e.country_code <> 'US'
       AND (jsonb_typeof(g.metadata -> 'supports_second_family') NOT IN ('boolean')
            OR jsonb_typeof(g.metadata -> 'arrears_over_12_weeks') NOT IN ('boolean'));
    IF found IS NOT NULL THEN mistyped := mistyped || found || ' '; END IF;

    SELECT string_agg(par, ', ') INTO found
      FROM (SELECT employee_id::text || '/' || case_number AS par
              FROM garnishments
             WHERE case_number IS NOT NULL AND is_active
             GROUP BY employee_id, case_number
            HAVING count(*) > 1) d;
    IF found IS NOT NULL THEN twice := twice || found || ' '; END IF;
  END LOOP;

  IF levies <> '' THEN
    RAISE EXCEPTION '084: these levy orders have no usable metadata.exempt_amount (%): the key is missing, null, non-numeric or zero, and all four read back as zero — each of them withholds 100%% of disposable earnings today. Capture the Pub 1494 exemption the notice states before restricting the column', levies;
  END IF;
  IF support <> '' THEN
    RAISE EXCEPTION '084: these support orders have no usable metadata.supports_second_family / metadata.arrears_over_12_weeks (%): the engine runs for these employees, so each of them is capped at 60%% where the CCPA may allow only 50%%. Capture both answers before restricting the column', support;
  END IF;
  IF mistyped <> '' THEN
    RAISE EXCEPTION '084: these pension_alimenticia orders carry a cap answer that is not a JSON boolean (%): nothing withholds against them today (the cascade runs only for US employees), but (metadata ->> key)::boolean raises 22P02 the day it does, in the middle of a payroll run. Fix the value or remove the key — it is not required for a Mexican order', mistyped;
  END IF;
  IF twice <> '' THEN
    RAISE EXCEPTION '084: these (employee, case number) pairs have more than one LIVE order (%): each pair is being withheld twice per period, which is what the unique index below exists to stop. Archive the duplicate before creating the index', twice;
  END IF;
END
$census$;

-- ── 3 · THE CONSTRAINTS ─────────────────────────────────────────────────

ALTER TABLE garnishments ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE garnishments
  ADD CONSTRAINT ck_garnishments_levy_exemption
  CHECK (garnishment_type NOT IN ('tax_levy_federal', 'tax_levy_state')
         OR (CASE
               WHEN COALESCE(metadata ->> 'exempt_amount', '') ~ '^[0-9]+([.][0-9]+)?$'
               THEN (metadata ->> 'exempt_amount')::numeric > 0
               ELSE false
             END));

ALTER TABLE garnishments
  ADD CONSTRAINT ck_garnishments_support_caps
  CHECK (garnishment_type <> 'child_support'
         OR (COALESCE(jsonb_typeof(metadata -> 'supports_second_family'), 'missing') = 'boolean'
             AND COALESCE(jsonb_typeof(metadata -> 'arrears_over_12_weeks'), 'missing') = 'boolean'));

ALTER TABLE garnishments
  ADD CONSTRAINT ck_garnishments_maintenance_caps
  CHECK (garnishment_type <> 'pension_alimenticia'
         OR (COALESCE(jsonb_typeof(metadata -> 'supports_second_family'), 'boolean') = 'boolean'
             AND COALESCE(jsonb_typeof(metadata -> 'arrears_over_12_weeks'), 'boolean') = 'boolean'));

CREATE UNIQUE INDEX ux_garnishments_case_active
  ON garnishments (employee_id, case_number)
  WHERE case_number IS NOT NULL AND is_active;

COMMENT ON COLUMN garnishments.metadata IS
  'The CCPA inputs the engine reads: exempt_amount on a levy (number or string, and it must parse as a POSITIVE number — zero withholds the whole cheque, exactly like an absent key), supports_second_family and arrears_over_12_weeks as JSON booleans on a child_support order. NOT NULL and constrained BY VALUE since 084: a key that is merely present, with a null value, coerces to zero in the engine. A pension_alimenticia order is NOT required to carry the two cap answers — they are CCPA inputs and the cascade never runs for a Mexican employee — but if it carries them they must be booleans, or the cast aborts a payroll run.';
