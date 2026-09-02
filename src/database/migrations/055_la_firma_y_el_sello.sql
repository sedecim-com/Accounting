-- ============================================================
-- 055 · LA FIRMA Y EL SELLO (F05d)
--
-- El último tramo de F05, y el ÚNICO que toca el mayor. Los tres anteriores
-- construyeron el documento (051), el cotejo (052) y la aritmética (054) sin
-- postear un solo asiento; aquí se firma la sesión y se contabiliza lo que
-- descubrió. Va solo a propósito: concentra todo el riesgo contable del flujo
-- en una sola revisión.
--
-- LO QUE ESTA MIGRACIÓN TIENE QUE VOLVER IMPOSIBLE es una firma sin
-- constancia. La 054 ya impide declarar cuadrada una sesión que nadie calculó;
-- lo que falta es que APROBAR y CONTABILIZAR dejen el mismo rastro, porque una
-- aprobación sin fecha, sin firmante y sin instantánea es indistinguible de un
-- UPDATE — que es exactamente la forma del defecto histórico de este módulo.
-- ============================================================

-- ── 1. LA FIRMA, CON SU INSTANTÁNEA CONGELADA ───────────────────────────
--
-- `approved_by` existe desde la 003 y nadie lo escribe. Le faltan las tres
-- cosas que vuelven una firma auditable: CUÁNDO se firmó, POR QUÉ, y QUÉ SE
-- FIRMÓ EXACTAMENTE.
--
-- La instantánea es lo que hace que la firma signifique algo. Sin ella, un
-- auditor que mira la sesión seis meses después ve el estado de HOY —con las
-- partidas que se reclasificaron después, los cotejos que se deshicieron— y no
-- tiene forma de saber qué había sobre la mesa cuando alguien firmó. El hash
-- es el que permite contestar «¿esto es lo que se aprobó?» con un sí o un no,
-- en vez de con una impresión.
-- LA TOLERANCIA CON LA QUE SE CERRÓ, PERSISTIDA.
--
-- `close` acepta `--tolerance` cuando la política del despacho lo permite, y
-- ese número no vivía en ninguna parte: sólo en la bandera de aquel momento.
-- La consecuencia la destapó el verificador y es peor de lo que parece — no es
-- que se pierda un dato, es que `approve` reevalúa el cuadre SIN la tolerancia
-- con la que se cerró, así que la instantánea sellada de una sesión cerrada
-- legítimamente con 150 de tolerancia y 120 de variación decía `cuadra: false`.
--
-- El documento que existe para contestar «¿esto es lo que se aprobó?» afirmaba
-- que la cuenta NO cuadraba. Ningún importe era falso y nada entró mal al
-- mayor; lo que estaba roto era la única pieza cuyo trabajo es no estarlo.
ALTER TABLE reconciliation_sessions
    ADD COLUMN closing_tolerance DECIMAL(19,4) NOT NULL DEFAULT 0,
    ADD COLUMN approved_at TIMESTAMPTZ,
    ADD COLUMN approval_reason TEXT,
    -- Los miembros y los saldos que se firmaron, tal como estaban.
    ADD COLUMN approval_snapshot JSONB,
    ADD COLUMN approval_hash CHAR(64),
    ADD COLUMN posted_at TIMESTAMPTZ,
    ADD COLUMN posted_by UUID;

-- TODO O NADA, como el sello de la partida en la 052. Media firma —un
-- `approved_by` sin fecha, o una fecha sin instantánea— es peor que ninguna:
-- parece una firma y no se puede auditar.
ALTER TABLE reconciliation_sessions
    ADD CONSTRAINT sesion_firma_coherente
        CHECK (
            (approved_by IS NULL AND approved_at IS NULL AND approval_hash IS NULL)
            OR
            (approved_by IS NOT NULL AND approved_at IS NOT NULL
             AND approval_hash IS NOT NULL AND approval_snapshot IS NOT NULL)
        );

-- Y NO SE LLEGA A `approved` NI A `posted` SIN ELLA. El estado y la constancia
-- no pueden separarse: si pudieran, `approved` volvería a ser una palabra que
-- alguien escribe, que es de lo que este módulo viene.
ALTER TABLE reconciliation_sessions
    ADD CONSTRAINT sesion_aprobada_con_firma
        CHECK (status NOT IN ('approved', 'posted') OR approval_hash IS NOT NULL);

ALTER TABLE reconciliation_sessions
    ADD CONSTRAINT sesion_contabilizada_con_rastro
        CHECK (status <> 'posted' OR (posted_at IS NOT NULL AND posted_by IS NOT NULL));

COMMENT ON COLUMN reconciliation_sessions.closing_tolerance IS
  'La tolerancia con la que se cerró, que NO es la de hoy. `approve` tiene que reevaluar el cuadre con ella o su instantánea contradice al cierre que firma. Cero cuando se cerró exacto, que es el defecto.';

COMMENT ON COLUMN reconciliation_sessions.approval_snapshot IS
  'Los miembros y los saldos TAL COMO ESTABAN al firmar. Sin ella, quien audite la sesión seis meses después ve el estado de hoy —partidas reclasificadas, cotejos deshechos— y no puede saber qué había sobre la mesa cuando alguien firmó.';

COMMENT ON COLUMN reconciliation_sessions.approval_hash IS
  'sha256 de la instantánea. Es lo que permite contestar «¿esto es lo que se aprobó?» con un sí o un no en vez de con una impresión.';

-- ── 2. EL CHEQUE COBRADO, QUE EN MÉXICO ES UN HECHO FISCAL ──────────────
--
-- El catálogo llama a `bank check reconcile` «el comando más transversal», y
-- no exagera: bajo la LIVA el pago con cheque se entiende efectuado cuando el
-- cheque SE COBRA, no cuando se entrega. Así que el IVA acreditable de ese
-- pago no se acredita en el mes en que se firmó el cheque sino en el mes en
-- que el banco lo pagó — y sin registrar ese hecho, el módulo fiscal calcula
-- mal el IVA mensual de toda empresa que pague con cheques.
--
-- No hace falta un registro de cheques: un cheque YA ES un `vendor_payment`
-- con `payment_method = 'check'` y su `check_number` (002:122-124). Lo que
-- falta es la fecha del cobro y el movimiento del banco que lo prueba. El
-- registro como sustantivo propio —`bank check list|issue|void`— es de fase 2
-- y no se adelanta aquí.
ALTER TABLE vendor_payments
    ADD COLUMN check_cleared_date DATE,
    ADD COLUMN check_cleared_tx_id UUID REFERENCES bank_transactions(id);

-- La fecha sin el movimiento sería una afirmación sin prueba, y el movimiento
-- sin la fecha, una prueba que no dice de cuándo. Van juntos o no van.
ALTER TABLE vendor_payments
    ADD CONSTRAINT pago_cheque_cobro_coherente
        CHECK (
            (check_cleared_date IS NULL AND check_cleared_tx_id IS NULL)
            OR
            (check_cleared_date IS NOT NULL AND check_cleared_tx_id IS NOT NULL)
        );

CREATE INDEX idx_vendor_payments_cheque_cobrado ON vendor_payments(check_cleared_tx_id)
    WHERE check_cleared_tx_id IS NOT NULL;

COMMENT ON COLUMN vendor_payments.check_cleared_date IS
  'Cuándo lo pagó el banco, que bajo la LIVA es cuando el pago se entiende efectuado. El IVA acreditable de un pago con cheque se acredita en ESTE mes y no en el de la firma del cheque.';
