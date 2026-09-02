-- ============================================================
-- 052 · EL COTEJO (F05b)
--
-- El motor de cotejo existe desde abril y `journal_entry_lines.is_reconciled`
-- existe desde el día uno. La 041 —la del mayor inviolable— le abre el ÚNICO
-- hueco de escritura que tiene una línea posteada:
--
--   permitidas text[] := ARRAY['is_reconciled', 'reconciled_at', 'reconciliation_id'];
--
-- Es decir: el esquema lleva un año reservando el sello de conciliación como la
-- única mutación admisible sobre un asiento contabilizado. El matcher LEE esa
-- columna (matching.ts:324) para no proponer lo ya conciliado. **Nadie la ha
-- escrito nunca.** Un lado del cotejo —el de libros— no se marca jamás, así que
-- la misma partida se vuelve a proponer para siempre.
--
-- Esta migración da al cotejo lo que le falta para ser un hecho y no una
-- sugerencia: un grupo que pueda expresar N:M, una clausura que no borre, y el
-- vínculo con la sesión que sus escritores dejaban en NULL.
-- ============================================================

-- ── 1. EL GRUPO DE COTEJO ───────────────────────────────────────────────
--
-- `reconciliation_matches` es UNA FILA POR MOVIMIENTO con un solo
-- `matched_entity_id` (003:102): expresa 1:1 y nada más. El catálogo pide
-- explícitamente el caso real —N líneas de banco contra M partidas de libros,
-- que es una parcialidad, un depósito que agrupa cobros, o un pago corto por
-- comisión— y exige que el grupo cuadre: Σbanco = Σlibros + Σajustes.
--
-- El grupo es quien sostiene esa igualdad. Un cotejo suelto no puede: no sabe
-- de qué conjunto forma parte.
CREATE TABLE reconciliation_match_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
    reconciliation_session_id UUID REFERENCES reconciliation_sessions(id),

    -- Las tres sumas que tienen que cuadrar, congeladas al crear el grupo.
    -- Se guardan y no se recalculan al leer: son la ASEVERACIÓN que se hizo, y
    -- un informe posterior tiene que poder contrastar lo que se afirmó contra
    -- lo que las filas dicen hoy.
    total_banco DECIMAL(19,4) NOT NULL,
    total_libros DECIMAL(19,4) NOT NULL,
    total_ajustes DECIMAL(19,4) NOT NULL DEFAULT 0,

    -- Qué se hizo con lo que sobró. `keep` deja el residual vivo como partida
    -- conciliatoria; `write-off` lo cancela contra una cuenta.
    residual DECIMAL(19,4) NOT NULL DEFAULT 0,
    residual_mode VARCHAR(10) NOT NULL DEFAULT 'keep'
        CHECK (residual_mode IN ('keep', 'write-off')),
    write_off_account_id UUID REFERENCES accounts(id),

    origen VARCHAR(20) NOT NULL DEFAULT 'manual'
        CHECK (origen IN ('manual', 'motor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,

    -- Un residual que se cancela necesita cuenta; uno que se conserva, no.
    -- Sin este CHECK, `write-off` sin cuenta dejaría dinero sin destino y el
    -- descuadre aparecería mucho más tarde, en la sesión.
    CHECK (residual_mode <> 'write-off' OR write_off_account_id IS NOT NULL)
);

CREATE INDEX idx_match_groups_entity ON reconciliation_match_groups(entity_id);
CREATE INDEX idx_match_groups_cuenta ON reconciliation_match_groups(bank_account_id);
CREATE INDEX idx_match_groups_sesion ON reconciliation_match_groups(reconciliation_session_id);

COMMENT ON TABLE reconciliation_match_groups IS
  'El conjunto que sostiene Σbanco = Σlibros + Σajustes. reconciliation_matches es una fila por movimiento con un solo matched_entity_id y no puede expresar 1:N, N:1 ni N:M por sí sola.';

-- ── 2. EL COTEJO GANA GRUPO Y CLAUSURA ──────────────────────────────────
--
-- Desaplicar CLAUSURA, no borra — la misma decisión que la 049 tomó para la
-- aplicación de un cobro. Un cotejo deshecho es historia del expediente: el
-- auditor pregunta por qué se deshizo, y una fila borrada no contesta.
ALTER TABLE reconciliation_matches
    ADD COLUMN group_id UUID REFERENCES reconciliation_match_groups(id),
    ADD COLUMN unapplied_at TIMESTAMPTZ,
    ADD COLUMN unapplied_by UUID,
    ADD COLUMN unapply_reason VARCHAR(40);

CREATE INDEX idx_recon_matches_group ON reconciliation_matches(group_id);
-- Los cotejos VIVOS de un movimiento. Un índice parcial porque las consultas
-- que importan —¿está cotejado?, ¿qué queda por cotejar?— sólo miran los vivos.
CREATE INDEX idx_recon_matches_vivos ON reconciliation_matches(bank_transaction_id)
    WHERE unapplied_at IS NULL;

COMMENT ON COLUMN reconciliation_matches.unapply_reason IS
  'Motivo TIPIFICADO de la desaplicación (código, no prosa libre): el catálogo pide --reason <code> para que las causas se puedan contar, no sólo leer.';

-- ── 3. EL SELLO DE LA PARTIDA DE LIBROS, CON DUEÑO ──────────────────────
--
-- `journal_entry_lines.reconciliation_id` existe desde 001 SIN FK y sin que
-- nadie la escriba. Aquí gana dueño: apunta al GRUPO que selló la línea, que es
-- lo que permite responder «¿por qué está conciliada esta partida?» con algo
-- más que un booleano.
--
-- No se declara REFERENCES a propósito. La columna es genérica —el registro
-- normativo la reserva también para la certificación de cuentas de F05e, que
-- no es bancaria— y atarla ahora a una tabla de banco cerraría esa puerta. Lo
-- que sí se puede exigir es coherencia: sellada implica con dueño y con fecha.
ALTER TABLE journal_entry_lines
    ADD CONSTRAINT jel_sello_coherente
        CHECK (
            (is_reconciled = false AND reconciled_at IS NULL AND reconciliation_id IS NULL)
            OR
            (is_reconciled = true AND reconciled_at IS NOT NULL AND reconciliation_id IS NOT NULL)
        );

COMMENT ON COLUMN journal_entry_lines.reconciliation_id IS
  'Quién selló esta partida. Hoy lo escribe el grupo de cotejo bancario (052); la columna es genérica a propósito porque la certificación de cuentas la usará también. Sin FK por eso mismo.';
