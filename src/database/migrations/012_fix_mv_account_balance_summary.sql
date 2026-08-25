-- ============================================================
-- Migration 012: Fix mv_account_balance_summary draft/pending/void leak
-- ============================================================
-- Same defect fixed for mv_trial_balance in migration 010: the previous
-- definition chained two LEFT JOINs:
--   LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
--   LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
--       AND je.status = 'posted'
-- When the second LEFT JOIN found no match (entry not posted), the (a, jel)
-- row still survived, so amounts from draft/pending/void entries were summed
-- into the balances. The (jel JOIN je) pair must be pre-filtered inside a
-- parenthesized join.

DROP MATERIALIZED VIEW IF EXISTS mv_account_balance_summary;

CREATE MATERIALIZED VIEW mv_account_balance_summary AS
SELECT
    a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type,
    a.entity_id,
    COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) AS total_debits,
    COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) AS total_credits,
    COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) AS current_balance,
    COUNT(DISTINCT je.id) AS transaction_count,
    MAX(je.entry_date) AS last_transaction_date
FROM accounts a
LEFT JOIN (journal_entry_lines jel
           JOIN journal_entries je
             ON je.id = jel.journal_entry_id
            AND je.status = 'posted')
       ON jel.account_id = a.id
WHERE a.is_active = true
GROUP BY a.id, a.code, a.name, a.account_type, a.entity_id;

-- Unique index required by REFRESH MATERIALIZED VIEW CONCURRENTLY
-- (used by refresh_materialized_views(), which is unchanged and keeps
-- refreshing this view by name after each posting).
CREATE UNIQUE INDEX idx_mv_account_balance ON mv_account_balance_summary(account_id);
CREATE INDEX idx_mv_account_balance_entity ON mv_account_balance_summary(entity_id);
