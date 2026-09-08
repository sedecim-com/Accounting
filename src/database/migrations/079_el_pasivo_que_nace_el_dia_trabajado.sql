-- ============================================================
-- 079 · EL PASIVO QUE NACE EL DÍA TRABAJADO (D1 · NIF D-3)
--
-- La 078 dejó los cimientos —la categoría del ORI y, en el catálogo, las
-- cuentas 2196/2197/2198/2199 que ningún sembrador tenía— y dijo por escrito
-- que «el motor va aparte». Esto es la mitad de esquema que ese motor necesita:
-- la CÉDULA. Sin ella, la corrida podría postear el asiento y no habría manera
-- de decir de quién es cada peso del pasivo.
--
-- LO QUE UNA CÉDULA COMPRA, Y QUE EL MAYOR NO DA. El asiento mensual es una
-- sola línea de cargo y tres de abono para toda la plantilla: dice cuánto, no
-- de quién ni por qué. Cuando un trabajador se va, el finiquito liquida SU
-- aguinaldo devengado y alguien tiene que poder comprobar que lo provisionado
-- durante el año coincide; cuando el auditor pregunta por qué la provisión de
-- marzo subió, la respuesta es «tres altas y un aniversario», y eso son filas.
--
-- ── POR QUÉ UNA SOLA TABLA, Y NO DOS COMO EN LA 059 ─────────────────────
--
-- La 059 argumentó dos tablas —cabecera + renglones— porque el anticipo es un
-- hecho que existe ANTES de la primera corrida y hay que poder contar el hueco
-- («hay 340.000 en la 1160 y sólo 120.000 tienen quién los devengue»).
--
-- Aquí la cabecera YA EXISTE y se llama `employees`. La ficha del trabajador
-- tiene el alta, la baja, el estado y el sueldo: todo lo que no es de un mes
-- concreto. Añadir una segunda cabecera sería una copia de esos datos que
-- puede discrepar con el original, que es justo lo que la 059 quería evitar. Y
-- el hueco se cuenta igual de bien: trabajadores vivos en el periodo SIN fila
-- en esta tabla.
--
-- ── UN ASIENTO POR CORRIDA, N FILAS QUE LO SEÑALAN ──────────────────────
--
-- A diferencia de la amortización —un asiento por anticipo—, aquí todas las
-- filas de un mes apuntan al MISMO `journal_entry_id`. No es una simplificación:
-- una plantilla de doscientas personas produciría doscientos asientos idénticos
-- en concepto y fecha, y el mayor de diciembre sería ilegible. El desglose por
-- persona es exactamente lo que esta tabla es.
--
-- ── LO QUE SE COPIA DE LA 059, PORQUE YA SE PAGÓ APRENDERLO ─────────────
--
--   · `entity_id` PROPIO, no derivado por JOIN: es lo que hace que el primer
--     bucle de `rls-policies.sql` genere la política de aislamiento SOLA, sin
--     depender de que alguien se acuerde de apuntar la tabla en la lista de
--     padres del segundo bucle.
--   · LA ENTIDAD VIAJA EN LAS FORÁNEAS COMPUESTAS. Una fila no puede apuntar al
--     trabajador de otra entidad ni al periodo fiscal de otra entidad, y no
--     porque la consulta se acuerde de filtrar, sino porque Postgres lo rechaza.
--     Van cuatro fugas cerradas en este proyecto por confiar en que el id venía
--     de una consulta anterior.
--   · NACE CON EL CHECK «posteada exige asiento». Una fila que afirma estar en
--     el mayor sin poder decir dónde es indistinguible de una marcada a mano.
--   · EL IMPORTE TOTAL ES GENERADO. No hay dos números que puedan discrepar,
--     porque el segundo no se escribe (la 059 lo hizo con `remaining_amount`).
--
-- ── LO QUE ESTA TABLA NO GUARDA, Y ES DELIBERADO ────────────────────────
--
--   · LA PTU (2199). No se devenga por trabajador: es el 10 % de la renta
--     gravable DE LA ENTIDAD (LFT 120), y no existe hasta la declaración anual.
--     La política `provision_ptu_mensual` está apagada por omisión y el motor
--     declara su ausencia en el resultado de cada corrida, que no es lo mismo
--     que un cero silencioso. Cuando llegue, su cédula es de entidad y periodo,
--     no de persona: otra tabla.
--   · LA PRIMA DE ANTIGÜEDAD (LFT 162). Beneficio por terminación de largo
--     plazo que la NIF D-3 manda valuar ACTUARIALMENTE —rotación, mortalidad,
--     descuento—. Está declarada fuera de alcance en `ai/docs/nif-registro.md`
--     y no tiene ni cuenta ni columna: una columna sin motor es capacidad
--     declarada y no entregada, y `doctor` la marcaría como huérfana.
-- ============================================================

-- ── 0. EL BLANCO DE LA FORÁNEA COMPUESTA SOBRE `employees` ──────────────
--
-- `id` ya es la primaria, así que este índice no restringe nada nuevo: existe
-- para poder ESCRIBIR la restricción de entidad en el esquema en vez de en la
-- memoria de quien redacte la próxima consulta. Es el mismo movimiento que la
-- 059 hizo sobre `fiscal_periods` y `accounts` (cuyos índices ya existen, con
-- IF NOT EXISTS, y por eso no se repiten aquí).
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_id_entity
    ON employees (id, entity_id);

-- ── 1. LA CÉDULA: UN TRABAJADOR, UN PERIODO, TRES CONCEPTOS ─────────────
CREATE TABLE benefit_provision_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    employee_id UUID NOT NULL,
    fiscal_period_id UUID NOT NULL,

    -- La fecha con la que se posteó el asiento: el último día del periodo
    -- corrido. `createJournalEntry` deduce el periodo fiscal DE LA FECHA, así
    -- que una fecha de otro mes no sería una etiqueta torcida sino el asiento
    -- colgado de otro periodo que el de su propia fila (defecto B de F06a).
    provision_date DATE NOT NULL,

    -- Días de relación laboral imputados a este periodo, ya recortados por el
    -- alta y por la baja. Se guardan aunque el importe se pueda recalcular:
    -- son la mitad de la explicación de por qué el renglón vale lo que vale, y
    -- la única manera de ver desde la tabla que un alta a mitad de mes devengó
    -- veintidós días y no treinta y uno.
    days_accrued INTEGER NOT NULL CHECK (days_accrued >= 0),

    -- DINERO CON CUATRO DECIMALES, como todo el de este sistema. Los tres
    -- conceptos por separado porque cada pasivo se extingue con un hecho
    -- distinto y se concilia contra una cuenta distinta.
    --
    -- CERO ES LEGAL EN CADA UNO, Y NO EN LA SUMA. Bajo la convención
    -- `aniversario` las vacaciones y su prima valen cero once meses de cada
    -- doce; un mes entero en cero, en cambio, no es un renglón sino ruido: si
    -- no se devengó nada no hay nada que documentar, y el motor no escribe la
    -- fila. NEGATIVO NO EXISTE: un devengo negativo ABONA el resultado y
    -- publica una utilidad que nadie ganó.
    aguinaldo_amount DECIMAL(19,4) NOT NULL CHECK (aguinaldo_amount >= 0),
    vacaciones_amount DECIMAL(19,4) NOT NULL CHECK (vacaciones_amount >= 0),
    prima_vacacional_amount DECIMAL(19,4) NOT NULL CHECK (prima_vacacional_amount >= 0),
    CONSTRAINT provision_no_vacia
        CHECK (aguinaldo_amount + vacaciones_amount + prima_vacacional_amount > 0),

    -- GENERADO. El total no es un dato que se mantenga: es una suma. Dos
    -- columnas mantenidas a mano pueden discrepar; ésta no puede.
    total_amount DECIMAL(19,4)
        GENERATED ALWAYS AS
        (aguinaldo_amount + vacaciones_amount + prima_vacacional_amount) STORED,

    is_posted BOOLEAN NOT NULL DEFAULT false,
    journal_entry_id UUID REFERENCES journal_entries(id),

    -- CON QUÉ SE CALCULÓ ESTE RENGLÓN: la base salarial y la convención de
    -- vacaciones que el panel decía el día de la corrida, el salario diario, y
    -- los TRAMOS —el mes del aniversario se parte en dos, cada uno con su
    -- escalón del art. 76—. El importe solo no permite reconstruir por qué es
    -- ése, y un auditor que no puede reconstruirlo no lo puede firmar.
    calculation_metadata JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- EL FRENO DE DOBLE CORRIDA, EN EL ESQUEMA. Un trabajador y un mes son UNA
    -- fila. A diferencia de la depreciación —cuya UNIQUE incluye
    -- `schedule_type` porque el libro contable y el fiscal son dos filas
    -- legítimas—, aquí el devengo es uno solo: la NIF D-3 no tiene un segundo
    -- libro. Correr el mismo mes dos veces no puede duplicar el pasivo, y este
    -- índice lo impide aunque el código lo olvide.
    CONSTRAINT uq_provision_trabajador_periodo UNIQUE (employee_id, fiscal_period_id),

    CONSTRAINT provision_posteada_con_asiento
        CHECK (is_posted = false OR journal_entry_id IS NOT NULL),

    CONSTRAINT fk_provision_trabajador_entidad
        FOREIGN KEY (employee_id, entity_id)
        REFERENCES employees (id, entity_id),
    CONSTRAINT fk_provision_periodo_entidad
        FOREIGN KEY (fiscal_period_id, entity_id)
        REFERENCES fiscal_periods (id, entity_id)
);

CREATE INDEX idx_provision_trabajador ON benefit_provision_schedules (employee_id);
CREATE INDEX idx_provision_periodo
    ON benefit_provision_schedules (entity_id, fiscal_period_id);
CREATE INDEX idx_provision_asiento ON benefit_provision_schedules (journal_entry_id)
    WHERE journal_entry_id IS NOT NULL;

COMMENT ON TABLE benefit_provision_schedules IS
  'La cédula del devengo de prestaciones (NIF D-3): una fila por trabajador y periodo fiscal con el aguinaldo, las vacaciones y la prima vacacional que ese mes ganó, y el asiento que las puso en el mayor. Nace posteada: el motor no escribe renglones teóricos, porque un calendario que nadie postea es la promesa que este tramo vino a cerrar. Todas las filas de un mes comparten asiento — un asiento por corrida, no uno por persona.';

COMMENT ON COLUMN benefit_provision_schedules.entity_id IS
  'Propio, no derivado por JOIN. Además del alcance en cada consulta, es lo que hace que rls-policies.sql genere la política de aislamiento SOLA: su primer bucle sólo mira tablas con tenant_id o entity_id.';

COMMENT ON COLUMN benefit_provision_schedules.days_accrued IS
  'Días de relación laboral dentro del periodo, recortados por alta y baja. Es la mitad de la explicación del importe: sin ellos no se ve que un alta del 10 devengó veintidós días y no treinta y uno.';

COMMENT ON COLUMN benefit_provision_schedules.total_amount IS
  'GENERADA. La suma de los tres conceptos no se escribe, se deriva: dos columnas mantenidas a mano pueden discrepar.';

COMMENT ON COLUMN benefit_provision_schedules.journal_entry_id IS
  'El asiento que devengó este mes (DR 6116 / CR 2196, 2197, 2198). El CHECK provision_posteada_con_asiento lo exige para is_posted, y lo comparten todas las filas del mismo periodo.';

COMMENT ON COLUMN benefit_provision_schedules.calculation_metadata IS
  'Con qué se calculó: base salarial y convención de vacaciones vigentes en el panel ese día, salario diario, fuente del salario y los tramos del mes con su escalón del art. 76. Sin esto el importe es un número que nadie puede reconstruir.';
