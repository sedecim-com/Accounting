-- ============================================================
-- 067 · Lo que el patrón paga, y lo que el trabajador no recibió
--
-- F08a. Tres tablas de la salida de nómina —paycheck_taxes,
-- employer_tax_liabilities, garnishments— se LEEN y ningún camino las
-- escribe: el criterio E4.1 lleva un tramo en rojo honesto diciéndolo. El
-- desglose existe y se tira: paycheck-service calcula `breakdown.isr`,
-- `imss_employee`, `imss_employer`, `infonavit_employer` y
-- `subsidio_empleo` y no persiste ninguno. Los formularios que los reportan
-- leen ceros con aspecto de números.
--
-- Y falta un impuesto entero. El ISN —impuesto sobre nóminas, estatal, entre
-- 1% y 4% según el estado— no aparece en una sola línea de código. Es carga
-- del PATRÓN y se declara al estado donde se PRESTA el trabajo, no donde
-- está el domicilio fiscal. Un sistema que calcula IMSS e INFONAVIT y no
-- calcula ISN subestima el costo laboral de cada trabajador.
--
-- Esta migración pone los cimientos: la tabla de tasas, y los candados que
-- hacen imposible apuntar dos veces lo mismo.
-- ============================================================

-- ------------------------------------------------------------
-- 1. LAS TASAS DE ISN, POR ESTADO Y POR VIGENCIA
--
-- Catálogo, como inpc_serie y sat_bancos: la ley es la misma para todos los
-- inquilinos, así que no lleva tenant_id.
--
-- LA VIGENCIA ESTÁ EN LA LLAVE, por la misma razón que `base` está en la de
-- inpc_serie: los congresos estatales mueven estas tasas, y calcular la
-- nómina de marzo con la tasa de diciembre da un número plausible y falso.
-- Una tasa sin vigencia no es una tasa, es un recuerdo.
--
-- NO SE SIEMBRA NINGUNA TASA. Treinta y dos estados con tasas que cambian
-- por decreto: sembrarlas de memoria es exactamente la clase de número
-- plausible que este proyecto lleva un tramo persiguiendo. El cálculo se
-- niega a adivinar y lo dice con el estado y el periodo que le faltan.
-- ------------------------------------------------------------
CREATE TABLE mx_isn_tasas_estatales (
    -- Clave de dos letras de la entidad federativa (c_Estado del SAT).
    estado VARCHAR(3) NOT NULL,
    vigencia_desde DATE NOT NULL,
    -- Nula = sigue vigente. Un cierre se escribe cuando el estado publica la
    -- siguiente, no antes.
    vigencia_hasta DATE,
    tasa DECIMAL(8,6) NOT NULL CHECK (tasa >= 0 AND tasa <= 0.15),

    -- Varios estados eximen bajo cierto monto o cobran por escalones. Mientras
    -- el motor sólo entienda tasa plana, un régimen que no lo sea se marca
    -- para que el cálculo se niegue en vez de aplicar la tasa como si nada.
    regimen VARCHAR(20) NOT NULL DEFAULT 'tasa_plana'
        CHECK (regimen IN ('tasa_plana', 'escalonado', 'con_exencion')),
    exencion_mensual DECIMAL(14,4),

    fundamento TEXT NOT NULL,
    capturado_el TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    capturado_por UUID,

    PRIMARY KEY (estado, vigencia_desde),
    -- Un tramo que termina antes de empezar no es un tramo.
    CONSTRAINT isn_vigencia_coherente
        CHECK (vigencia_hasta IS NULL OR vigencia_hasta > vigencia_desde),
    -- Un régimen con exención tiene que decir cuánto exime; uno plano, no.
    CONSTRAINT isn_exencion_solo_si_aplica
        CHECK (
            (regimen = 'con_exencion' AND exencion_mensual IS NOT NULL)
            OR (regimen <> 'con_exencion' AND exencion_mensual IS NULL)
        )
);

COMMENT ON TABLE mx_isn_tasas_estatales IS
    'Tasas del impuesto sobre nóminas por entidad federativa. Vacía a propósito: '
    'el cálculo se niega a adivinar una tasa que no esté capturada con su fundamento.';

-- Dos vigencias del mismo estado no pueden solaparse. El candado va en la
-- base y no en el servicio porque un solape produce dos tasas válidas para
-- una fecha, y entonces el ISN del mes depende de cuál lea primero el motor
-- — que es la definición de un instrumento que miente según la máquina.
CREATE OR REPLACE FUNCTION isn_sin_solape() RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM mx_isn_tasas_estatales t
        WHERE t.estado = NEW.estado
          AND (t.estado, t.vigencia_desde) IS DISTINCT FROM (NEW.estado, NEW.vigencia_desde)
          AND NEW.vigencia_desde < COALESCE(t.vigencia_hasta, DATE '9999-12-31')
          AND COALESCE(NEW.vigencia_hasta, DATE '9999-12-31') > t.vigencia_desde
    ) THEN
        RAISE EXCEPTION
            'La tasa de ISN de % desde % se solapa con otra vigencia ya capturada',
            NEW.estado, NEW.vigencia_desde
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_isn_sin_solape
    BEFORE INSERT OR UPDATE ON mx_isn_tasas_estatales
    FOR EACH ROW EXECUTE FUNCTION isn_sin_solape();

-- El sello de S3: el disparador sobrevive a session_replication_role='replica'.
ALTER TABLE mx_isn_tasas_estatales ENABLE ALWAYS TRIGGER trg_isn_sin_solape;
COMMENT ON TRIGGER trg_isn_sin_solape ON mx_isn_tasas_estatales IS
    'garantia-sellada: dos vigencias solapadas del mismo estado harían que el ISN del mes '
    'dependiera del orden de lectura';

-- ------------------------------------------------------------
-- 2. QUE NO SE PUEDA APUNTAR DOS VECES
--
-- Las dos tablas nacen a escribirse en este tramo, y el primer error de una
-- tabla que empieza a escribirse es escribirse dos veces: un reintento, un
-- recálculo de la misma nómina, un job que corre dos veces. Duplicar un
-- renglón de impuesto no rompe nada visible — sólo duplica el número que el
-- formulario reporta.
--
-- El candado va en la base, no en el servicio, porque el servicio ya demostró
-- en este proyecto que se le puede llamar por dos caminos.
-- ------------------------------------------------------------
ALTER TABLE paycheck_taxes
    ADD CONSTRAINT paycheck_taxes_un_renglon_por_impuesto
    UNIQUE (paycheck_id, tax_type, jurisdiction, employee_employer);

-- El pasivo patronal se acumula por corrida y por impuesto. `pay_run_id` es
-- nulable en el diseño original (hay pasivos que no vienen de una corrida,
-- como un ajuste anual), así que el candado sólo cubre los que sí la tienen:
-- un índice único parcial y no una restricción, porque en SQL dos NULL no son
-- iguales y una UNIQUE dejaría pasar los ajustes repetidos sin avisar.
CREATE UNIQUE INDEX employer_tax_liab_una_por_corrida
    ON employer_tax_liabilities (tenant_id, entity_id, pay_run_id, tax_type, jurisdiction, period_start)
    WHERE pay_run_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3. EL SUBSIDIO QUE SE ENTREGA EN EFECTIVO
--
-- Cuando el subsidio al empleo supera al ISR del periodo, el patrón ENTREGA
-- la diferencia en efectivo al trabajador y la acredita contra el ISR
-- retenido a otros. Hoy el cálculo hace `Math.max(0, isr - subsidio)`: el
-- comentario de la línea de arriba dice «if negative, employee receives as
-- cash» y el Math.max es justo lo que impide que lo reciba.
--
-- Ese importe no es un impuesto ni una deducción: es dinero que sale del
-- patrón hacia el trabajador y vuelve por vía de acreditamiento. Necesita
-- columna propia en el recibo para que el CFDI de nómina pueda declararlo
-- (concepto 002 de «otros pagos») y para que la conciliación del ISR del mes
-- cuadre.
-- ------------------------------------------------------------
ALTER TABLE paychecks
    ADD COLUMN IF NOT EXISTS subsidio_entregado_efectivo DECIMAL(14,4) NOT NULL DEFAULT 0
        CHECK (subsidio_entregado_efectivo >= 0);

COMMENT ON COLUMN paychecks.subsidio_entregado_efectivo IS
    'Subsidio al empleo que excedió al ISR y que el patrón entrega en efectivo al '
    'trabajador; acreditable contra el ISR retenido a otros trabajadores.';
