-- ============================================================
-- 337 · A FILED RETURN IS KEPT AS FILED (#308 · MNE-001-533)
--
-- The record of the returns a person already filed with the SAT, of the
-- earlier balances each one credited, and of the refund requests and
-- compensations of a balance. Until now nothing held them: `filing record`
-- was a planned row, and the only similar table, tax_form_filings (008), is a
-- payroll tracker with untyped JSONB that its writers update in place. This
-- migration is part 1 of the record; its service (MNE-001-576) and the CLI
-- leaf `filing record` (MNE-001-577) write into these tables later, and so do
-- `filing correct` and the refund and compensation leaf, with no further
-- migration.
--
--   · ONE ROW PER FILED RETURN, never one per period. A return can be amended
--     (CFF art. 32), so a period holds a CHAIN: an amended return names the
--     one it replaces, and the return in force is the one nobody replaces.
--     The schema holds the chain, not the code: a composite key keeps an
--     amendment inside its own entity, obligation and period; the replaced
--     return is UNIQUE, so the chain never branches; and a period has one
--     original. Together: exactly one return in force per period.
--   · A REFUND REQUEST (CFF art. 22) AND A COMPENSATION (CFF art. 23) ARE
--     ROWS OF THEIR OWN, made after the return is filed, so a return row never
--     changes for them. A compensation offsets an amount owed of the same tax
--     (CFF art. 23), so its row names the period it offsets, under the same
--     obligation.
--   · EACH CREDIT OF AN EARLIER BALANCE NAMES ITS RETURN OF ORIGIN, from an
--     earlier period (LIVA art. 6: the balance is credited in the following
--     months). What is still available, the cap at the tax payable and the
--     order among balances are rules of their reader (MNE-001-386), not of
--     this schema.
--   · APPEND-ONLY, ENFORCED, as 166 does: the triggers below refuse UPDATE,
--     DELETE and TRUNCATE for everyone, and rls-policies.sql and
--     provision-roles.sql keep the three tables in their append_only arrays.
--     The returns are part of the accounting (RCFF art. 33 A fr. III; CFF
--     art. 28 fr. I A) and are kept (CFF art. 30): nothing here is purged.
--     seq is an identity, not recorded_at: two rows in the same microsecond
--     still have one order.
--
-- Only entity_id, like 166: rls-policies.sql derives the tenant through
-- legal_entities for every table that has the column, and scope.ts bounds
-- every read and write by entity. Amounts are DECIMAL(19,2): a return states
-- cents at most, and is filed in whole pesos. Vocabulary values are English
-- (docs/language.md rule 4); the comments give the SAT's words.
-- ============================================================

CREATE TABLE filed_tax_returns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    obligation VARCHAR(20) NOT NULL CHECK (obligation IN ('iva_monthly', 'isr_provisional')),
    period DATE NOT NULL,
    return_type VARCHAR(10) NOT NULL CHECK (return_type IN ('original', 'amended')),
    replaces_return_id UUID,
    filed_on DATE NOT NULL,
    acknowledgement_number TEXT NOT NULL,
    capture_line TEXT,
    amount_payable DECIMAL(19,2) NOT NULL DEFAULT 0 CHECK (amount_payable >= 0),
    balance_in_favor DECIMAL(19,2) NOT NULL DEFAULT 0 CHECK (balance_in_favor >= 0),
    amount_paid DECIMAL(19,2) CHECK (amount_paid >= 0),
    paid_on DATE,
    recorded_by UUID REFERENCES users(id),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT filed_tax_return_period_is_a_month
        CHECK (extract(day FROM period) = 1),
    CONSTRAINT filed_tax_return_filed_after_its_period
        CHECK (filed_on >= (period + interval '1 month')::date),
    CONSTRAINT filed_tax_return_acknowledgement_not_blank
        CHECK (btrim(acknowledgement_number) <> ''),
    CONSTRAINT filed_tax_return_capture_line_not_blank
        CHECK (capture_line IS NULL OR btrim(capture_line) <> ''),
    CONSTRAINT filed_tax_return_payable_or_in_favor
        CHECK (amount_payable = 0 OR balance_in_favor = 0),
    CONSTRAINT filed_tax_return_payment_has_its_day
        CHECK ((amount_paid IS NULL) = (paid_on IS NULL) AND (paid_on IS NULL OR paid_on >= filed_on)),
    CONSTRAINT filed_tax_return_amendment_names_what_it_replaces
        CHECK ((return_type = 'amended') = (replaces_return_id IS NOT NULL)
               AND replaces_return_id IS DISTINCT FROM id),
    -- The key every reference to a return goes through: id alone would let a
    -- row point at a return of another entity, tax or period.
    CONSTRAINT filed_tax_return_chain_key UNIQUE (id, entity_id, obligation, period),
    CONSTRAINT filed_tax_return_replaces_its_own_period
        FOREIGN KEY (replaces_return_id, entity_id, obligation, period)
        REFERENCES filed_tax_returns (id, entity_id, obligation, period),
    CONSTRAINT filed_tax_return_replaced_once UNIQUE (replaces_return_id),
    CONSTRAINT filed_tax_return_acknowledgement_once UNIQUE (entity_id, acknowledgement_number)
);

CREATE UNIQUE INDEX filed_tax_return_one_original
    ON filed_tax_returns (entity_id, obligation, period) WHERE return_type = 'original';

CREATE INDEX idx_filed_tax_returns_period
    ON filed_tax_returns (entity_id, obligation, period, seq DESC);

CREATE TABLE filed_tax_return_credits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    obligation VARCHAR(20) NOT NULL,
    return_id UUID NOT NULL,
    return_period DATE NOT NULL,
    source_return_id UUID NOT NULL,
    source_period DATE NOT NULL,
    amount DECIMAL(19,2) NOT NULL CHECK (amount > 0),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT filed_tax_return_credit_is_its_returns
        FOREIGN KEY (return_id, entity_id, obligation, return_period)
        REFERENCES filed_tax_returns (id, entity_id, obligation, period),
    CONSTRAINT filed_tax_return_credit_source_is_its_own
        FOREIGN KEY (source_return_id, entity_id, obligation, source_period)
        REFERENCES filed_tax_returns (id, entity_id, obligation, period),
    CONSTRAINT filed_tax_return_credit_looks_back CHECK (source_period < return_period),
    CONSTRAINT filed_tax_return_credit_once_per_source UNIQUE (return_id, source_return_id)
);

CREATE INDEX idx_filed_tax_return_credits_source ON filed_tax_return_credits (source_return_id);

CREATE TABLE tax_balance_uses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    obligation VARCHAR(20) NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('refund_request', 'compensation')),
    source_return_id UUID NOT NULL,
    source_period DATE NOT NULL,
    used_on DATE NOT NULL,
    amount DECIMAL(19,2) NOT NULL CHECK (amount > 0),
    reference TEXT NOT NULL,
    offset_period DATE,
    recorded_by UUID REFERENCES users(id),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT tax_balance_use_source_is_its_own
        FOREIGN KEY (source_return_id, entity_id, obligation, source_period)
        REFERENCES filed_tax_returns (id, entity_id, obligation, period),
    CONSTRAINT tax_balance_use_reference_not_blank CHECK (btrim(reference) <> ''),
    CONSTRAINT tax_balance_use_compensation_names_its_period
        CHECK ((kind = 'compensation') = (offset_period IS NOT NULL)
               AND (offset_period IS NULL OR extract(day FROM offset_period) = 1))
);

CREATE INDEX idx_tax_balance_uses_source ON tax_balance_uses (source_return_id);

CREATE OR REPLACE FUNCTION public.filed_tax_records_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % refused. A correction is a new row: an amended return names the one it replaces, and the filed one has to keep explaining what was declared.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;

CREATE TRIGGER filed_tax_returns_append_only
  BEFORE UPDATE OR DELETE ON public.filed_tax_returns
  FOR EACH ROW EXECUTE FUNCTION public.filed_tax_records_append_only();
-- A TRUNCATE fires no row trigger, so each table gets a statement-level one, as 033, 083 and 166 do.
CREATE TRIGGER filed_tax_returns_no_truncate
  BEFORE TRUNCATE ON public.filed_tax_returns
  FOR EACH STATEMENT EXECUTE FUNCTION public.filed_tax_records_append_only();

CREATE TRIGGER filed_tax_return_credits_append_only
  BEFORE UPDATE OR DELETE ON public.filed_tax_return_credits
  FOR EACH ROW EXECUTE FUNCTION public.filed_tax_records_append_only();
CREATE TRIGGER filed_tax_return_credits_no_truncate
  BEFORE TRUNCATE ON public.filed_tax_return_credits
  FOR EACH STATEMENT EXECUTE FUNCTION public.filed_tax_records_append_only();

CREATE TRIGGER tax_balance_uses_append_only
  BEFORE UPDATE OR DELETE ON public.tax_balance_uses
  FOR EACH ROW EXECUTE FUNCTION public.filed_tax_records_append_only();
CREATE TRIGGER tax_balance_uses_no_truncate
  BEFORE TRUNCATE ON public.tax_balance_uses
  FOR EACH STATEMENT EXECUTE FUNCTION public.filed_tax_records_append_only();

COMMENT ON TABLE filed_tax_returns IS
  'Returns a person filed with the SAT, one row each. Append-only (trigger). A period holds a chain: an amended return («complementaria», CFF art. 32) names the one it replaces; the return in force is the one no row replaces.';
COMMENT ON COLUMN filed_tax_returns.obligation IS
  'iva_monthly: the monthly IVA (LIVA art. 5-D). isr_provisional: the provisional ISR payment (LISR art. 14), admitted for a later writer.';
COMMENT ON COLUMN filed_tax_returns.period IS 'The month the return covers, as its first day.';
COMMENT ON COLUMN filed_tax_returns.return_type IS
  'original: the «normal» return. amended: a «complementaria», which names in replaces_return_id the return it replaces.';
COMMENT ON COLUMN filed_tax_returns.acknowledgement_number IS
  'The operation number on the SAT''s acknowledgement («número de operación del acuse»). Once per entity.';
COMMENT ON COLUMN filed_tax_returns.capture_line IS
  'The payment reference («línea de captura»). NULL when the return has nothing to pay.';
COMMENT ON COLUMN filed_tax_returns.amount_payable IS
  'The amount to pay after the credits the return took («cantidad a cargo»). Never together with balance_in_favor.';
COMMENT ON COLUMN filed_tax_returns.balance_in_favor IS 'The balance in favour the return generated («saldo a favor»).';
COMMENT ON COLUMN filed_tax_returns.amount_paid IS
  'What was paid with THIS return''s capture line, on paid_on. On an amended return, the difference it paid; the period''s total is the sum along its chain.';
COMMENT ON TABLE filed_tax_return_credits IS
  'Each earlier balance in favour a return credited (LIVA art. 6), with its return of origin, of the same entity and tax and of an earlier period. Append-only (trigger).';
COMMENT ON TABLE tax_balance_uses IS
  'A refund request (CFF art. 22) or a compensation (CFF art. 23) of a balance in favour, with the return that generated it. Append-only (trigger).';
COMMENT ON COLUMN tax_balance_uses.reference IS 'The refund request''s folio, or the compensation notice, as the accountant identifies it.';
COMMENT ON COLUMN tax_balance_uses.offset_period IS
  'Compensation only: the period of the same obligation whose amount owed it offsets (CFF art. 23). NULL for a refund request.';
