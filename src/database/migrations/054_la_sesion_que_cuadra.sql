-- ============================================================
-- 053 · LA SESIÓN QUE CUADRA (F05c)
--
-- Éste es el tramo del que habla el comentario más largo del módulo bancario,
-- el que acompaña al endpoint retirado:
--
--   «Toda la implementación era un UPDATE poniendo status = 'balanced'. Nunca
--    calculó ending_balance_per_books, nunca lo comparó con
--    ending_balance_per_bank, nunca miró si quedaba un solo movimiento sin
--    cotejar, y nunca contabilizó los asientos que una conciliación existe
--    para encontrar. Esas columnas conservaban su DEFAULT 0 y la sesión
--    reportaba variance 0 — un cero que significa "nadie restó nada",
--    mostrado como "la cuenta cuadra". Y period-close.ts lee
--    status IN ('balanced','approved','posted') como la evidencia de que la
--    cuenta está conciliada. Un UPDATE incondicional se convertía en una
--    afirmación firmada de que el saldo se había verificado contra el banco.»
--
-- LO QUE ESTA MIGRACIÓN TIENE QUE VOLVER IMPOSIBLE no es una variación
-- distinta de cero: es una sesión BALANCEADA SIN QUE NADIE HAYA HECHO LA
-- ARITMÉTICA. Un CHECK sobre `variance = 0` no habría cazado el defecto
-- histórico, porque la variación valía cero — valía cero por DEFAULT, que es
-- justo lo contrario de haberla calculado.
-- ============================================================

-- ── 1. LA ARITMÉTICA TIENE QUE HABER OCURRIDO ───────────────────────────
--
-- `arithmetic_computed_at` sólo lo escribe quien recalcula de verdad los dos
-- lados. Con eso, «balanceada» pasa a ser una afirmación que exige haber hecho
-- el trabajo, y el cero por omisión deja de poder disfrazarse de cuadre.
ALTER TABLE reconciliation_sessions
    ADD COLUMN arithmetic_computed_at TIMESTAMPTZ,
    ADD COLUMN closed_at TIMESTAMPTZ,
    ADD COLUMN closed_by UUID,
    -- El extracto del que salen los saldos. Sin él, `beginning_balance` se
    -- insertaba FIJO EN CERO porque no había de dónde sacarlo.
    ADD COLUMN statement_id UUID REFERENCES bank_statements(id);

ALTER TABLE reconciliation_sessions
    ADD CONSTRAINT sesion_balanceada_con_aritmetica
        CHECK (
            status NOT IN ('balanced', 'approved', 'posted')
            OR arithmetic_computed_at IS NOT NULL
        );

COMMENT ON COLUMN reconciliation_sessions.arithmetic_computed_at IS
  'Cuándo se recalcularon los dos lados de verdad. El CHECK sesion_balanceada_con_aritmetica lo exige para pasar a balanced: el defecto histórico no fue una variación mal calculada, fue una variación NUNCA calculada que valía cero por DEFAULT y se leía como cuadre.';

COMMENT ON COLUMN reconciliation_sessions.variance IS
  'La variación CONGELADA al cerrar, no la respuesta. Se recalcula viva en `bank reconciliation status`; esta columna es la aseveración que se hizo, para que un informe posterior pueda contrastar lo afirmado con lo que las filas dicen hoy.';

-- ── 2. LAS PARTIDAS CONCILIATORIAS, COMO FILAS ──────────────────────────
--
-- La 003 las guarda como CINCO ESCALARES en la sesión: `outstanding_checks`,
-- `deposits_in_transit`, `bank_charges`, `bank_interest`, `other_adjustments`.
-- Un total no se puede perseguir. El catálogo pide listarlas «con antigüedad,
-- responsable, fecha esperada de liquidación y estado de escalamiento», y nada
-- de eso cabe en un número: un cheque en circulación de hace noventa días y uno
-- de ayer suman igual y no significan lo mismo.
--
-- Los escalares se conservan y pasan a ser el RESUMEN CONGELADO al cerrar,
-- igual que `variance`. La verdad está en las filas.
CREATE TABLE reconciling_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    reconciliation_session_id UUID NOT NULL REFERENCES reconciliation_sessions(id),

    tipo VARCHAR(30) NOT NULL CHECK (tipo IN (
        -- En libros y no en el banco: se emitió el cheque y no lo han cobrado.
        'cheque-en-circulacion',
        -- En libros y no en el banco: se depositó y el banco no lo ha abonado.
        'deposito-en-transito',
        -- En el banco y no en libros: comisión, IVA de la comisión, interés.
        'cargo-del-banco',
        'abono-del-banco',
        -- Error de una parte o de la otra. Se distinguen porque quien lo
        -- corrige es distinto: al banco se le reclama, a los libros se les
        -- postea un ajuste.
        'error-del-banco',
        'error-de-libros'
    )),

    -- De dónde sale la partida. Exactamente uno de los dos, o ninguno cuando
    -- es una partida declarada a mano (un cheque emitido fuera del sistema).
    bank_transaction_id UUID REFERENCES bank_transactions(id),
    journal_entry_line_id UUID REFERENCES journal_entry_lines(id),

    -- FIRMADO, y el signo es su APORTACIÓN a la conciliación, no el del
    -- movimiento: un cheque en circulación resta del saldo de banco para
    -- llegar al de libros. Guardar el signo del movimiento obligaría a cada
    -- lector a recordar la regla, y el que la olvide descuadra en silencio.
    importe DECIMAL(19,4) NOT NULL,
    fecha DATE NOT NULL,

    -- Lo que convierte una partida en algo que se persigue y no sólo se cuenta.
    responsable VARCHAR(120),
    fecha_esperada DATE,
    escalamiento VARCHAR(12) NOT NULL DEFAULT 'ninguno'
        CHECK (escalamiento IN ('ninguno', 'avisado', 'vencido')),
    notas TEXT,

    resuelta_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,

    -- Una partida no puede venir de los dos lados a la vez: o la trajo el
    -- extracto o la trajeron los libros.
    CHECK (bank_transaction_id IS NULL OR journal_entry_line_id IS NULL)
);

CREATE INDEX idx_reconciling_items_sesion ON reconciling_items(reconciliation_session_id);
CREATE INDEX idx_reconciling_items_entity ON reconciling_items(entity_id);
CREATE INDEX idx_reconciling_items_tipo ON reconciling_items(tipo);
-- Las que siguen abiertas, que son las que se persiguen.
CREATE INDEX idx_reconciling_items_abiertas ON reconciling_items(reconciliation_session_id)
    WHERE resuelta_at IS NULL;

COMMENT ON TABLE reconciling_items IS
  'Las partidas conciliatorias como FILAS. La 003 las guardaba como cinco escalares en la sesión, y un total no se puede perseguir: un cheque de hace noventa días y uno de ayer suman igual y no significan lo mismo.';

COMMENT ON COLUMN reconciling_items.importe IS
  'FIRMADO por su aportación a la conciliación, no por el signo del movimiento. Un cheque en circulación resta del saldo de banco para llegar al de libros. Guardar el signo del movimiento obligaría a cada lector a recordar la regla, y quien la olvide descuadra en silencio.';

-- ── 3. EL AJUSTE NACE COMO BORRADOR, Y SE SABE DE QUÉ SESIÓN ────────────
--
-- El catálogo lo dice en negrita: `bank adjustment create` crea **como
-- borradores** y «nunca contabiliza por su cuenta». Contabilizar es de F05d,
-- detrás de una firma. Lo que falta es el vínculo: sin él, la sesión no puede
-- decir qué ajustes la explican ni `post` sabría cuáles contabilizar.
CREATE TABLE reconciliation_adjustments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    reconciliation_session_id UUID NOT NULL REFERENCES reconciliation_sessions(id),
    reconciling_item_id UUID REFERENCES reconciling_items(id),

    tipo VARCHAR(30) NOT NULL CHECK (tipo IN (
        'comision', 'iva-comision', 'interes', 'isr-retenido', 'error'
    )),
    importe DECIMAL(19,4) NOT NULL,
    -- El borrador que lo materializa. Es la pieza que hace verdadera la
    -- promesa de «nunca contabiliza por su cuenta»: lo que existe es un
    -- borrador esperando a `mnemosine review`, no un asiento.
    draft_id UUID,
    -- Se rellena en F05d, al contabilizar. NULL mientras sea sólo borrador.
    journal_entry_id UUID REFERENCES journal_entries(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL
);

CREATE INDEX idx_recon_adjustments_sesion ON reconciliation_adjustments(reconciliation_session_id);
CREATE INDEX idx_recon_adjustments_entity ON reconciliation_adjustments(entity_id);

COMMENT ON TABLE reconciliation_adjustments IS
  'Los ajustes que la conciliación descubre, como BORRADORES. journal_entry_id queda NULL hasta que F05d los contabilice detrás de una firma: es lo que hace verdadera la promesa de que `bank adjustment create` nunca contabiliza por su cuenta.';
