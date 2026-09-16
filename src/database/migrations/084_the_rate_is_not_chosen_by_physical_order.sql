-- ============================================================
-- 084 · THE RATE IS NOT CHOSEN BY PHYSICAL ORDER (T1 · issue #88)
--
-- `get_exchange_rate()` was written in the 001 for a world where a pair could
-- have ONE rate per day: `UNIQUE (from_currency, to_currency, effective_date,
-- rate_type)`. The 057 changed that world — it dropped that constraint and put
-- `UNIQUE (from_currency, to_currency, effective_date, rate_type, source)` in
-- its place — so DOF and Banxico's FIX for the same day now live side by side,
-- on purpose. The function was never redefined for it.
--
-- What that leaves, measured against the 001 body: the direct lookup is
-- `ORDER BY effective_date DESC LIMIT 1` with no tiebreak, so with two sources
-- on the resolved date Postgres returns whichever row it reads first. That is
-- physical order, and physical order moves: a VACUUM, a rewrite, a restore from
-- backup can all change it. `fx rate show CHF/MXN 2026-08-15` answered 20.1111
-- or 20.2222 on the same data, and neither answer was wrong in any way the
-- system could tell.
--
-- WHY IT FAILS CLOSED INSTEAD OF PICKING A WINNER, and this is the whole
-- decision of this file. Choosing DOF over FIX is not a database question: it
-- is fiscal criterion, and this house already decided WHERE that gets decided.
-- `tipoParaConversion` (src/services/fx/rate-service.ts) reads the
-- `fuente_tipo_cambio` policy, filters by it, and when the rate of that source
-- is missing it refuses with a message that says it out loud: «No uso el de
-- otra fuente ni el de otra fecha: sería elegir criterio fiscal por ti».
--
-- So the SQL stops doing in silence exactly what the service refuses to do.
-- Ambiguity raises; it does not resolve. A caller that knows which source it
-- wants says so through `p_source`, and one that does not gets an error naming
-- the candidates instead of a number nobody can reproduce.
--
-- WHAT DOES NOT CHANGE: the resolution order (direct → inverse → cross through
-- USD), the carry-forward of `effective_date <= p_date`, the `effective_until`
-- window, and NULL when there is no path at all. This file narrows one thing
-- only — which row answers when several could.
--
-- THE SIGNATURE GROWS, SO THE OLD ONE IS DROPPED FIRST. Adding a defaulted
-- fifth parameter with CREATE OR REPLACE would leave the four-argument function
-- in place as a separate overload, and every existing four-argument call —
-- including the two the 001 makes to itself for the cross rate — would fail as
-- ambiguous. Nothing else depends on it: no view, no constraint, and the only
-- SQL references are those two self-calls.
-- ============================================================

DROP FUNCTION IF EXISTS get_exchange_rate(CHAR(3), CHAR(3), DATE, VARCHAR);

CREATE OR REPLACE FUNCTION get_exchange_rate(
    p_from CHAR(3),
    p_to CHAR(3),
    p_date DATE,
    p_rate_type VARCHAR(50) DEFAULT 'spot',
    p_source VARCHAR(100) DEFAULT NULL
)
RETURNS DECIMAL(19,10) AS $$
DECLARE
    v_rate DECIMAL(19,10);
    v_day DATE;
    v_sources TEXT[];
BEGIN
    -- ── DIRECT ──────────────────────────────────────────────
    -- The applicable day is resolved first and on its own, because the
    -- ambiguity to detect is «several sources on THAT day», not «several rows
    -- in the window»: two sources on different days are not ambiguous at all,
    -- the later one wins, which is what the carry-forward always meant.
    SELECT max(effective_date) INTO v_day
    FROM exchange_rates
    WHERE from_currency = p_from
      AND to_currency = p_to
      AND rate_type = p_rate_type
      AND effective_date <= p_date
      AND (effective_until IS NULL OR effective_until >= p_date)
      AND (p_source IS NULL OR source = p_source);

    IF v_day IS NOT NULL THEN
        SELECT array_agg(DISTINCT source ORDER BY source) INTO v_sources
        FROM exchange_rates
        WHERE from_currency = p_from
          AND to_currency = p_to
          AND rate_type = p_rate_type
          AND effective_date = v_day
          AND (p_source IS NULL OR source = p_source);

        IF array_length(v_sources, 1) > 1 THEN
            RAISE EXCEPTION
                'exchange rate %/% for % (%) has % published sources: %. Pass the one this firm '
                'follows, or set the fuente_tipo_cambio policy: picking one here would be choosing '
                'fiscal criterion for you',
                p_from, p_to, v_day, p_rate_type, array_length(v_sources, 1),
                array_to_string(v_sources, ', ')
                USING ERRCODE = 'FX001';
        END IF;

        SELECT rate INTO v_rate
        FROM exchange_rates
        WHERE from_currency = p_from
          AND to_currency = p_to
          AND rate_type = p_rate_type
          AND effective_date = v_day
          AND (p_source IS NULL OR source = p_source);

        RETURN v_rate;
    END IF;

    -- ── INVERSE ─────────────────────────────────────────────
    SELECT max(effective_date) INTO v_day
    FROM exchange_rates
    WHERE from_currency = p_to
      AND to_currency = p_from
      AND rate_type = p_rate_type
      AND effective_date <= p_date
      AND (effective_until IS NULL OR effective_until >= p_date)
      AND (p_source IS NULL OR source = p_source);

    IF v_day IS NOT NULL THEN
        SELECT array_agg(DISTINCT source ORDER BY source) INTO v_sources
        FROM exchange_rates
        WHERE from_currency = p_to
          AND to_currency = p_from
          AND rate_type = p_rate_type
          AND effective_date = v_day
          AND (p_source IS NULL OR source = p_source);

        IF array_length(v_sources, 1) > 1 THEN
            RAISE EXCEPTION
                'inverse exchange rate %/% for % (%) has % published sources: %. Pass the one this '
                'firm follows, or set the fuente_tipo_cambio policy: picking one here would be '
                'choosing fiscal criterion for you',
                p_to, p_from, v_day, p_rate_type, array_length(v_sources, 1),
                array_to_string(v_sources, ', ')
                USING ERRCODE = 'FX001';
        END IF;

        SELECT inverse_rate INTO v_rate
        FROM exchange_rates
        WHERE from_currency = p_to
          AND to_currency = p_from
          AND rate_type = p_rate_type
          AND effective_date = v_day
          AND (p_source IS NULL OR source = p_source);

        RETURN v_rate;
    END IF;

    -- ── CROSS THROUGH USD ───────────────────────────────────
    -- The source travels down both legs. A cross rate mixing DOF on one side
    -- and FIX on the other would be a figure no publisher ever published, and
    -- the caller could not tell by looking at it.
    IF p_from != 'USD' AND p_to != 'USD' THEN
        DECLARE
            v_from_usd DECIMAL(19,10);
            v_usd_to DECIMAL(19,10);
        BEGIN
            v_from_usd := get_exchange_rate(p_from, 'USD', p_date, p_rate_type, p_source);
            v_usd_to := get_exchange_rate('USD', p_to, p_date, p_rate_type, p_source);
            IF v_from_usd IS NOT NULL AND v_usd_to IS NOT NULL THEN
                RETURN v_from_usd * v_usd_to;
            END IF;
        END;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_exchange_rate(CHAR(3), CHAR(3), DATE, VARCHAR, VARCHAR) IS
    'Resolves the applicable rate: direct, then inverse, then crossed through USD. '
    'Raises SQLSTATE FX001 when the resolved day has more than one published source '
    'and none was requested: which source a firm follows is fiscal criterion, and it '
    'is decided by the fuente_tipo_cambio policy, not by physical row order (T1, #88).';
