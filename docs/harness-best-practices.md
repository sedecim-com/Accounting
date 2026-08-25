# Harness best practices: adoption plan from Hermes Agent & OpenClaw

> Method: 6 parallel researchers read the live docs/repos of
> [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) and
> [OpenClaw](https://docs.openclaw.ai/) across 6 facets (sessions/memory,
> extensibility, safety/HITL, config UX, channels/ops, observability/cost),
> extracting 46 concrete practices with mechanisms and sources.
> Full findings: [research-harness-practices.json](research-harness-practices.json).
> Every practice below is rated for mnemosine specifically — an accounting
> agent where auditability and human review are non-negotiable.

## What mnemosine already does that matches their best practices
- Staged writes with human review (drafts/outbox) ≈ Hermes `write_approval` / OpenClaw `propose` mode — we are ahead here.
- Layered prompt with cache breakpoints (stable→volatile) ≈ Hermes tiered prompt.
- Progressive-disclosure docs (`read_docs`) ≈ skills-list pattern.
- Multi-provider profiles + credential helper (`api_key_cmd`) ≈ their provider config.
- `doctor` (static checks), `onboard` (import), `init` proposal (wizard sections).

## Wave 1 — Foundations (all effort S/M, priority alta)

1. **Durable sessions + transcripts in Postgres** (`sessions`, `messages` tables,
   tenant_id + RLS, role/content/tool_calls JSONB/token_count).
   Hermes: SQLite + FTS5; OpenClaw: SQLite + JSONL archive. For us every
   conversation becomes audit evidence: WHY the agent proposed each draft.
   Full transcript is never deleted; only the model's view changes.
2. **Session resume**: `mnemosine --continue` (most recent, terminal-aware
   breadcrumb like Hermes) and `--resume <id>`. Cheap once (1) exists.
3. **Curated tenant memory as a frozen snapshot** with hard token budgets
   (Hermes: MEMORY.md ≤ ~800 tokens frozen at session start — never mutates
   mid-session, which is exactly what maximizes prompt-cache hits). Ours lives
   in Postgres (precedents digest), injected in the stable block; OpenClaw's
   active/superseded metadata maps to precedents obsoleted by tax reform.
4. **Tool-result size caps + LLM-free proactive pruning** (Hermes:
   `tool_output.max_bytes`, prune tool results >8K chars when history >48K
   tokens). Deterministic, invents nothing, protects audit — do this BEFORE
   any LLM compaction.
5. **`mnemosine prompt-size`** (offline): fixed-budget breakdown per component
   (20 tool schemas, docs index, memory, profile) and which layer is cached.
   Detects regressions (a tool schema that got fat).
6. **SecretRef + secret auto-routing in config** (OpenClaw `{source:'env'|'exec',
   id}`; Hermes auto-routes keys to .env). Config becomes shareable without
   leaks; `exec` integrates vaults with no schema change.
7. **Onboard/init verifies real inference before persisting** (OpenClaw: runs
   an actual completion, persists only the verified model+credential path;
   re-running repairs instead of resetting). Add: SELECT under RLS as the DB probe.
8. **Approval bound to exact content + drift detection** (OpenClaw): store a
   canonical hash of draft/outbox content at approval; recompute at execution;
   if it changed, invalidate and return to review. Closes the TOCTOU window
   between human review and execution — cheap and essential.
9. **Unbreakable floor** (Hermes hardline blocklist, no override exists):
   encode in the TOOL layer (code, not prompt/config): never post to closed
   periods, never delete entries (reverse only), never stamp/cancel CFDI
   without an approved outbox item, amounts above threshold always human.
   No future "always-approve" rule may bypass it.
10. **Untrusted-content wrapping for CFDI ingest** (OpenClaw markers +
    Hermes ingest scanning): every third-party-controlled field (concept
    descriptions, emisor names, addenda) enters the context wrapped as
    untrusted data with a cached system-prompt rule that it is never an
    instruction; scan for injection/invisible Unicode before indexing into
    precedent memory.

## Wave 2 — Operations (M effort)

11. **Safe compaction** only after (4): threshold + overflow-recovery +
    manual `/compact`; cut points never split tool_use/tool_result pairs;
    `keepRecentTokens` intact tail; **identifierPolicy: strict** (CFDI UUIDs,
    RFCs, folios must survive summaries verbatim); full transcript stays in
    Postgres — compaction only changes the model's view.
12. **Memory flush before compaction** (OpenClaw): a silent turn inviting the
    agent to persist un-saved precedents — through the STAGED write tool, so
    human review is preserved. Compaction becomes a knowledge-capture point.
13. **Graduated approval policies** (Hermes once/session/always + OpenClaw
    allowlists): outbox/review approvals can be granted per-pattern (e.g.
    recurring payroll entries of this tenant under $X), persisted per tenant
    (RLS) with id + lastUsedAt. Rule to copy verbatim: effective policy is
    ALWAYS the strictest of config vs stored approvals; the floor (9) wins.
14. **Usage ledger + `mnemosine usage`**: one row per turn (tenant, session,
    provider, model, tokens by type, cost from a local price table);
    normalizes Anthropic vs OpenAI-compat usage fields; optional per-turn
    footer. Also: attribute the MODEL on every draft (silent failover to a
    weaker model mid-review must be on the record).
15. **Error-typed failover chains** (OpenClaw): failover only for auth/429/
    5xx/timeout/billing — never for overflow/refusals (those go to
    compaction); staggered cooldowns 30s→5m; auto re-probe of the primary.
16. **Doctor layered live probes** (OpenClaw Test connection + Hermes status):
    per-provider live probe with CATEGORIZED errors (auth vs billing vs
    timeout changes what the operator does), `status --all` redacted and
    shareable for support tickets, plus RLS-active check.
17. **Cron as first-class persisted agent tasks** (both have it): nightly
    close verification, CFDI-vs-ledger reconciliation, AR reminders — each
    run in an isolated session that deposits results as REVIEWABLE DRAFTS,
    never direct writes. Persisted jobs + execution log in Postgres (RLS =
    free audit trail), backoff, auto-disable after N failures.
18. **wakeAgent pre-gate** (Hermes no_agent jobs): a deterministic script
    polls (new XMLs? imbalances?) and only wakes the LLM with parsed context
    when there is work. Token cost ~0 on empty cycles; detection stays
    deterministic/auditable.

## Wave 3 — Extensibility & channels (M/L)

19. **Firm skills** as SKILL.md with YAML frontmatter + progressive disclosure
    (skills_list → skill_view → reference files) for despacho workflows
    (month-end close, DIOT checklist, SAT reconciliation). Compact index in
    the cached stable block (OpenClaw), 2 new tools (Hermes).
20. **Declarative skill gating** (requires.bins/env/config, per-agent
    allowlist as the FINAL set): tenants only see skills that apply (has
    e.firma, CFDI ingest enabled, régimen X). The model never sees what it
    must not use.
21. **Staged skill writes + trust scanning**: skill changes go to a
    skill_drafts table with diff approval (our drafts pattern applied to
    skills); third-party skills = untrusted code — repo-only in v1, scanner
    for exfiltration/injection patterns, explicit per-tenant trust.
22. **Inbound webhooks with dedicated token + restricted reader agent**
    (OpenClaw hooks.mappings): bank notifications / SAT mailbox → an agent
    profile limited to read tools + create-draft, content wrapped as
    untrusted, session key derived from document id (idempotency).
23. **Session FTS recall tool** (Hermes session_search over FTS5 → our
    tsvector over messages): unlimited historical recall on demand instead of
    inflating the live context.

## Deliberately NOT adopting (or hard-adapted)

- **`auto` mode for writes** (OpenClaw exec auto / Hermes yolo): never in
  accounting. Our graduated approvals (13) stop at pattern-scoped "always"
  UNDER the unbreakable floor (9).
- **Autonomous memory consolidation** (background /learn auto): precedent
  changes always go through staged review — priority baja as researched.
- **Exposing mnemosine as an OpenAI-compatible API** and **messaging-channel
  intake (WhatsApp/Telegram)**: valuable later; deferred until webhooks (22)
  + pairing/allowlist patterns land. Marked baja by research for now.
- **Sentinel-value secret ciphertext** (OpenClaw oc-sent-v2): overkill for a
  CLI; pattern+exact-value redaction (always-on, not configurable) adopted
  instead in logs/transcripts, plus a doctor secrets-audit.
