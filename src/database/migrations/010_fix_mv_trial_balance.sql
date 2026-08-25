-- ============================================================
-- Migration 010: Fix mv_trial_balance draft/pending/void leak
-- ============================================================
-- The previous definition chained two LEFT JOINs:
--   LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
--   LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
--       AND je.fiscal_period_id = fp.id AND je.status = 'posted'
-- When the second LEFT JOIN found no match (entry not posted, or in a
-- different period), the (a, fp, jel) row still survived, so amounts from
-- draft/pending/void entries were summed — and each line leaked into every
-- fiscal period of the entity. The (jel JOIN je) pair must be pre-filtered
-- inside a parenthesized join, matching the fix already applied in
-- src/api/rest/routes/reports.ts and src/ai/tools/report-tools.ts.

DROP MATERIALIZED VIEW IF EXISTS mv_trial_balance;

CREATE MATERIALIZED VIEW mv_trial_balance AS
SELECT
    a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type,
    a.normal_balance,
    a.entity_id,
    fp.id AS fiscal_period_id,
    fp.period_name,
    fp.start_date AS period_start,
    fp.end_date AS period_end,
    COALESCE(SUM(jel.debit_amount), 0) AS total_debits,
    COALESCE(SUM(jel.credit_amount), 0) AS total_credits,
    COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) -
    COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) AS net_balance
FROM accounts a
CROSS JOIN fiscal_periods fp
LEFT JOIN (journal_entry_lines jel
           JOIN journal_entries je
             ON je.id = jel.journal_entry_id
            AND je.status = 'posted')
       ON jel.account_id = a.id
      AND je.fiscal_period_id = fp.id
WHERE a.entity_id = fp.entity_id
  AND a.is_active = true
GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance,
         a.entity_id, fp.id, fp.period_name, fp.start_date, fp.end_date;

-- Unique index required by REFRESH MATERIALIZED VIEW CONCURRENTLY
-- (used by refresh_materialized_views(), which is unchanged and keeps
-- refreshing this view by name after each posting).
CREATE UNIQUE INDEX idx_mv_trial_balance ON mv_trial_balance(account_id, fiscal_period_id);
CREATE INDEX idx_mv_trial_balance_entity ON mv_trial_balance(entity_id);
