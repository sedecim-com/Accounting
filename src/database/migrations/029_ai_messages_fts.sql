-- ============================================================
-- 029: FULL-TEXT SEARCH OVER SESSION TRANSCRIPTS
-- On-demand recall (session_search tool): the agent looks up
-- facts discussed in PAST sessions instead of inflating the live
-- context with history it will rarely need.
--
-- Config is 'simple' ON PURPOSE, not 'spanish' or 'english':
-- transcripts mix both languages, and the things worth recalling
-- are literal tokens — RFCs, folios, account codes, amounts,
-- vendor names. A language-specific config would stem and
-- stop-word them ('facturas' -> 'factur', dropping 'de'/'the'),
-- so a search for the exact literal the user typed could miss.
-- 'simple' just lowercases and splits: language-neutral, literal
-- matches always work. Queries MUST use plainto_tsquery('simple',
-- ...) so both sides tokenize identically.
--
-- Expression index instead of a stored generated column: it needs
-- no table rewrite on a table that only ever grows, and the
-- planner uses it for any predicate written with the exact same
-- expression. ts_rank recomputes the tsvector, but only for the
-- rows that already matched — a cost we accept for the simpler
-- schema.
--
-- RLS: ai_messages carries no tenant_id by design (see 018) — it
-- is always reached through its ai_sessions row, whose tenant_id
-- policy from src/database/rls-policies.sql scopes the join. The
-- search query additionally pins entity_id in application code.
-- ============================================================

CREATE INDEX idx_ai_messages_content_fts
    ON ai_messages
    USING GIN (to_tsvector('simple', content));
