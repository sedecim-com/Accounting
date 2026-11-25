-- ============================================================
-- 346 · EARNED CAPITAL IS ITS OWN STATEMENT CATEGORY (#597 · MNE-001-651)
--
-- NIF B-6 presents contributed capital and earned capital apart, and NIF C-11
-- defines both: earned capital is the accumulated results, the reserves and
-- the other comprehensive income. `fs_category` had one value for the two,
-- `equity`, and the balance sheet labels that subsection «Capital
-- contribuido». So the legal reserve (3150), prior years' results (3200), the
-- result of the year (3300) and the income summary (3900) of the seeded chart
-- were printed as if the shareholders had contributed them.
--
-- WHAT CHANGES. The CHECK of 078 gains `earned_capital`. `ori` keeps its own
-- value (NIF B-3, migration 078): it is earned capital too, and 078 split it
-- so that a revaluation never reads as a contribution. The seed now writes
-- the four accounts under `earned_capital` (chart-seed.ts); this file moves
-- the ones that already exist.
--
-- WHICH ACCOUNTS MOVE. Only those still equal to the seed: account_type
-- `equity`, fs_category still `equity`, and code AND subtype equal to the
-- seed's — (3150, none), (3200, retained_earnings), (3300, retained_earnings),
-- (3900, none). A person who changed one of them may have meant something
-- else by it; their account is left as it is and COUNTED: still `equity`, and
-- a seed code with another subtype or type, a seed name under another code, a
-- `retained_earnings` subtype, or a child of an account this file moved. The
-- NOTICE says both numbers. No name or code goes to the log, only counts.
--
-- NOTHING ELSE CHANGES. No entry, no balance, no total: the balance sheet
-- groups its sections by account_type, so equity foots as before and only
-- the subsection an account is printed in moves. updated_at is left alone: a
-- migration is not an edit of the account.
--
-- CONTRACT: schema, compatible. One more value of accounts.fs_category, no
-- column added or dropped. The API's enum for fs_category gains it
-- (docs/openapi.json).
--
-- UNDER RLS. accounts and legal_entities are under FORCE ROW LEVEL SECURITY
-- and migrate.ts sets the row_security = off floor, so the sanctioned pattern
-- of docs/migraciones.md: the opt-in, and a loop that sets the tenant. The
-- explicit le.tenant_id = t.id keeps each pass on its own tenant where RLS
-- filters nothing (a superuser, which is how every CI job migrates), so no
-- account is counted twice. rls-policies.sql does not change.
--
-- IDEMPOTENT. The CHECK is dropped and re-added whole; a moved account no
-- longer matches `fs_category = 'equity'`, so a second run moves zero and
-- counts the same accounts left to a person.
-- ============================================================

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_fs_category_check;

ALTER TABLE accounts ADD CONSTRAINT accounts_fs_category_check
  CHECK (fs_category IN (
    'current_assets', 'non_current_assets',
    'current_liabilities', 'long_term_liabilities',
    'equity', 'earned_capital', 'ori',
    'revenue', 'cogs',
    'operating_expenses', 'other_income', 'other_expenses', 'tax'
  ));

COMMENT ON COLUMN accounts.fs_category IS
  'The financial-statement line the account is presented in. `equity` is contributed capital; `earned_capital` (NIF B-6, C-11, migration 346) is accumulated results and reserves; `ori` (NIF B-3, migration 078) is the capital that did NOT pass through the result of the period: revaluation, foreign-operation translation and employee-benefit remeasurements.';

SET LOCAL row_security = on;
DO $earned$
DECLARE
  t          record;
  n          bigint;
  moved      bigint := 0;
  left_alone bigint := 0;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    UPDATE accounts a
       SET fs_category = 'earned_capital'
      FROM legal_entities le,
           (VALUES ('3150', NULL::text),
                   ('3200', 'retained_earnings'),
                   ('3300', 'retained_earnings'),
                   ('3900', NULL::text)) AS seed(code, subtype)
     WHERE le.id = a.entity_id AND le.tenant_id = t.id
       AND a.account_type = 'equity'
       AND a.fs_category = 'equity'
       AND a.code = seed.code
       AND a.account_subtype IS NOT DISTINCT FROM seed.subtype;
    GET DIAGNOSTICS n = ROW_COUNT;
    moved := moved + n;

    SELECT count(*) INTO n
      FROM accounts a
      JOIN legal_entities le ON le.id = a.entity_id AND le.tenant_id = t.id
     WHERE a.fs_category = 'equity'
       AND (a.code IN ('3150', '3200', '3300', '3900')
         OR a.name IN ('Reserva Legal', 'Resultado de Ejercicios Anteriores',
                       'Resultado del Ejercicio', 'Resumen de Ingresos y Gastos')
         OR a.account_subtype = 'retained_earnings'
         OR EXISTS (SELECT 1 FROM accounts p
                     WHERE p.id = a.parent_id AND p.entity_id = a.entity_id
                       AND p.fs_category = 'earned_capital'));
    left_alone := left_alone + n;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);

  RAISE NOTICE 'migration 346: moved % account(s) to earned_capital; left % for a person to classify', moved, left_alone;
END
$earned$;
