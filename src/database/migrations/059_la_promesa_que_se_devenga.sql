-- ============================================================
-- 059 · LA PROMESA QUE SE DEVENGA (D1a)
--
-- La cuenta '1160 Pagos Anticipados' se siembra desde
-- `account-roles-seed.ts:72-75` con esta descripción: «Seguros, rentas y
-- suscripciones que cubren periodos futuros; **se devengan mes a mes**». Y el
-- clasificador del CFDI ofrece la opción que la alimenta —«Prepaid expenses
-- (accrued month by month)», rol `gasto_anticipado` (cfdi-decisions.ts:121-142)—
-- citando la NIF A-2 como respaldo.
--
-- No existía tabla, ni migración, ni motor. Ni una sola fila de calendario en
-- todo el esquema. El camino de ESCRITURA estaba vivo y el de LECTURA no
-- existía: cualquiera que contestara «pagos anticipados» a esa pregunta
-- cargaba un importe a un activo del que nada iba a sacarlo nunca. Que hoy el
-- saldo sea cero es suerte —nadie ha contestado que sí—, no diseño.
--
-- El daño de dejarlo así no es que falte una función: es que el gasto se queda
-- en el balance para siempre. Un seguro anual de 120.000 pagado en enero
-- infla el activo 120.000 y deja el resultado del ejercicio 120.000 por
-- encima de lo que fue; el balance CUADRA todo el tiempo, que es lo que hace
-- que nadie lo vea. Es la misma forma exacta del defecto que F06a acaba de
-- cerrar en la depreciación, y por eso este esquema copia aquél — con las dos
-- correcciones que el propio 056 enseña.
--
-- ── POR QUÉ DOS TABLAS Y NO UNA ─────────────────────────────────────────
--
-- La alternativa era una sola tabla de renglones que repitiera en cada fila
-- la ventana de cobertura, el importe total y el documento de origen. Se
-- descarta por tres razones, en orden de peso:
--
--   1. EL HUECO SE CUENTA ANTES DE QUE EXISTA NINGÚN RENGLÓN. La 1160 ya
--      puede tener saldo posteado por el camino del CFDI sin calendario
--      detrás. Para poder decir «hay 340.000 en la 1160 y sólo 120.000
--      tienen quién los devengue» hace falta una fila que exista desde el
--      alta y ANTES de la primera corrida. Con renglones solos, un anticipo
--      recién dado de alta y un anticipo inexistente son indistinguibles.
--   2. LA CABECERA GUARDA HECHOS QUE NO SON DE NINGÚN PERIODO —la ventana de
--      cobertura, el par de cuentas, el asiento que cargó la 1160, la
--      convención con la que se cortó el calendario—. Repetidos por renglón,
--      pueden DISCREPAR entre renglones del mismo anticipo, y entonces no hay
--      manera de saber cuál es la verdad.
--   3. Es la forma que ya tiene el único motor periódico del repositorio
--      (`fixed_assets` + `depreciation_schedules`), y dos módulos hermanos
--      con dos formas distintas se leen mal y se mantienen peor.
--
-- ── LO QUE ESTE ESQUEMA CORRIGE DEL 056 ─────────────────────────────────
--
--   (a) `entity_id` PROPIO en la tabla de renglones. `depreciation_schedules`
--       no lo tiene, y por eso su motor acota el alcance por JOIN contra
--       `fixed_assets` en cada lectura y en cada escritura
--       (depreciation.ts:45-49 lo explica y :286-296 lo hace). Pero la
--       incomodidad no es lo caro. Lo caro es el AISLAMIENTO: el primer bucle
--       de `rls-policies.sql` genera la política sola para toda tabla que
--       tenga `tenant_id` o `entity_id`, y una tabla que no tenga ninguna de
--       las dos sólo queda protegida si alguien se acordó de apuntarla a mano
--       en la LISTA DE PADRES del segundo bucle (rls-policies.sql:148-183).
--       `depreciation_schedules` está en esa lista —línea 157— y por eso hoy
--       tiene política; pero la tiene por memoria de una persona, no por
--       construcción. Es la misma «lista paralela» contra la que argumenta la
--       058: se desincroniza el día que alguien añade la tabla número
--       veintiuno y no la apunta. Con `entity_id` propio estas dos tablas
--       nacen con política en la primera corrida del hardening, sin que este
--       tramo tenga que editar un archivo que no le pertenece, y el JOIN pasa
--       a ser refuerzo en vez de única defensa.
--       (Comprobado: aplicando esta migración y `rls-policies.sql` seguido,
--       `pg_policies` devuelve `tenant_isolation` para las dos tablas nuevas.)
--
--   (b) NACE CON EL CHECK «posteada exige asiento». En la 003 `is_posted` y
--       `journal_entry_id` convivieron tres años sin atarse y el motor no
--       escribía el segundo; la 056 tuvo que venir a cerrar esa boca
--       (056:63-65). Aquí el invariante es de nacimiento: una fila que afirma
--       estar en el mayor sin poder decir dónde es indistinguible de una
--       marcada a mano.
--
-- Y una tercera que el 056 no podía poner porque su tabla ya existía: **la
-- entidad viaja en las foráneas COMPUESTAS**. Un renglón no puede apuntar al
-- anticipo de otra entidad ni al periodo fiscal de otra entidad, y no porque
-- el código se acuerde de filtrar, sino porque Postgres lo rechaza.
-- ============================================================

-- ── 0. BLANCOS DE FORÁNEA COMPUESTA SOBRE LO QUE YA EXISTE ──────────────
--
-- Una foránea compuesta necesita un índice único sobre el par al que apunta.
-- `id` ya es único en las dos, así que estos índices no restringen nada
-- nuevo: existen para poder ESCRIBIR la restricción de entidad en el esquema
-- en vez de en la memoria de quien redacte la próxima consulta.
--
-- Es barato y es aditivo. La alternativa —un CHECK con subconsulta— no existe
-- en Postgres, y un disparador haría el mismo trabajo peor: se puede apagar
-- (058) y no participa en el plan de ejecución.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_periods_id_entity
    ON fiscal_periods (id, entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_id_entity
    ON accounts (id, entity_id);

-- ── 1. EL ANTICIPO: LA PROMESA, CON SU VENTANA Y SU CRITERIO ────────────
CREATE TABLE prepaid_expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    description TEXT NOT NULL,
    vendor_name VARCHAR(255),
    reference VARCHAR(100),

    -- DINERO CON CUATRO DECIMALES, como todo el de este sistema. Un anticipo
    -- de cero o negativo no se devenga: una devolución o una nota de crédito
    -- se registra por reversa contra el asiento que la causó (041), no
    -- metiendo un importe con signo aquí.
    total_amount DECIMAL(19,4) NOT NULL CHECK (total_amount > 0),

    -- LA VENTANA DE COBERTURA, que es el hecho del que sale todo el
    -- calendario. Ambos extremos INCLUSIVE: una póliza del 20 de marzo al 19
    -- de marzo del año siguiente cubre los dos días.
    coverage_start_date DATE NOT NULL,
    coverage_end_date DATE NOT NULL,
    CONSTRAINT anticipo_ventana_coherente
        CHECK (coverage_end_date >= coverage_start_date),

    -- EL PAR DE CUENTAS, resuelto por ROL en el alta y CONGELADO aquí. Se
    -- guarda en vez de resolverse en cada corrida porque el mapa de roles
    -- puede cambiar, y un anticipo que empezó devengándose contra 6100 y
    -- termina contra otra cuenta parte el gasto en dos sin que nada lo diga.
    prepaid_account_id UUID NOT NULL,
    expense_account_id UUID NOT NULL,
    CONSTRAINT anticipo_cuentas_distintas
        CHECK (prepaid_account_id <> expense_account_id),

    -- LA CONVENCIÓN CON LA QUE SE CORTÓ EL CALENDARIO, también congelada.
    -- Sale de la política `amortizacion_anticipados_convencion` en el alta.
    -- No se relee en cada corrida A PROPÓSITO: cambiar el criterio a mitad de
    -- vida recortaría de otra manera meses YA POSTEADOS, y el mayor es
    -- inmutable (041). Contestar la política cambia los anticipos que nazcan
    -- después; los vivos conservan el criterio con el que nacieron, y la
    -- corrida anota en cada renglón si el panel dice hoy otra cosa.
    amortization_convention VARCHAR(30) NOT NULL
        CHECK (amortization_convention IN ('proporcional_dias', 'meses_completos')),

    -- DE DÓNDE SALIÓ EL CARGO QUE ESTA FILA VA A DESHACER.
    --
    -- Este módulo NO postea el alta: el cargo a la 1160 lo hace el camino del
    -- CFDI o el asiento manual, y aquí siempre se ADOPTA un saldo que ya está
    -- en el mayor. Por eso 'cfdi' exige el asiento —si el calendario nace con
    -- la factura, el vínculo se conoce y no anotarlo es perderlo— y
    -- 'saldo_preexistente' no puede exigirlo: es justamente el caso en que el
    -- saldo lleva meses ahí y puede venir de varios asientos.
    origin VARCHAR(30) NOT NULL
        CHECK (origin IN ('cfdi', 'manual', 'saldo_preexistente')),
    source_journal_entry_id UUID REFERENCES journal_entries(id),
    CONSTRAINT anticipo_de_cfdi_con_asiento
        CHECK (origin <> 'cfdi' OR source_journal_entry_id IS NOT NULL),
    cfdi_uuid VARCHAR(36),

    -- LA TARJETA, QUE SE DERIVA DE LO POSTEADO Y NO DEL CALENDARIO.
    --
    -- `amortized_to_date` lo reescribe cada corrida con la SUMA de los
    -- renglones posteados, nunca con el renglón teórico del mes: es la
    -- reparación que F06a tuvo que hacer sobre la ficha del activo
    -- (depreciation.ts:344-360), donde correr marzo, enero y febrero en ese
    -- orden dejaba la ficha diciendo lo del último UPDATE en ganar.
    --
    -- `remaining_amount` es GENERADA: no hay dos números que puedan
    -- discrepar, porque el segundo no se escribe. Y el CHECK del rango es el
    -- invariante contable de verdad — no se puede abonar a la 1160 más de lo
    -- que se le cargó.
    amortized_to_date DECIMAL(19,4) NOT NULL DEFAULT 0,
    CONSTRAINT anticipo_devengado_en_rango
        CHECK (amortized_to_date >= 0 AND amortized_to_date <= total_amount),
    remaining_amount DECIMAL(19,4)
        GENERATED ALWAYS AS (total_amount - amortized_to_date) STORED,
    last_amortization_date DATE,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'fully_amortized', 'cancelled')),
    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,

    -- El blanco de la foránea compuesta de los renglones.
    CONSTRAINT uq_prepaid_expenses_id_entity UNIQUE (id, entity_id),

    -- LA CUENTA DEL ANTICIPO Y LA DEL GASTO SON DE ESTA ENTIDAD, y lo dice el
    -- esquema. La foránea simple a `accounts(id)` deja pasar la cuenta de
    -- otra entidad del mismo inquilino: van cuatro fugas cerradas en este
    -- proyecto por confiar en que el id venía de una consulta anterior.
    CONSTRAINT fk_prepaid_cuenta_anticipo_entidad
        FOREIGN KEY (prepaid_account_id, entity_id) REFERENCES accounts (id, entity_id),
    CONSTRAINT fk_prepaid_cuenta_gasto_entidad
        FOREIGN KEY (expense_account_id, entity_id) REFERENCES accounts (id, entity_id)
);

CREATE INDEX idx_prepaid_expenses_entity ON prepaid_expenses (entity_id, status);
CREATE INDEX idx_prepaid_expenses_cuenta ON prepaid_expenses (prepaid_account_id);
CREATE INDEX idx_prepaid_expenses_asiento ON prepaid_expenses (source_journal_entry_id)
    WHERE source_journal_entry_id IS NOT NULL;

COMMENT ON TABLE prepaid_expenses IS
  'Pagos anticipados (1160): la promesa que la NIF A-2 obliga a devengar mes a mes. Una fila por anticipo, con su ventana de cobertura y el criterio con el que se corta su calendario. El cargo a la 1160 NO lo hace este módulo: aquí siempre se adopta un saldo que ya está en el mayor.';

COMMENT ON COLUMN prepaid_expenses.amortization_convention IS
  'Congelada en el alta desde la política `amortizacion_anticipados_convencion`. No se relee por corrida: cambiar el criterio a mitad de vida recortaría de otra manera meses ya posteados, y el mayor es inmutable (041).';

COMMENT ON COLUMN prepaid_expenses.amortized_to_date IS
  'La SUMA de los renglones posteados, reescrita en cada corrida. Nunca el renglón teórico del calendario: nada obliga a correr los meses en orden, y la ficha del activo llegó a afirmar una acumulada que el mayor no respaldaba justo por copiar el renglón (depreciation.ts:344-360).';

COMMENT ON COLUMN prepaid_expenses.remaining_amount IS
  'GENERADA. Lo que queda por devengar no es un dato que se mantenga: es una resta. Dos columnas mantenidas a mano pueden discrepar; ésta no puede.';

-- ── 2. LOS RENGLONES: UN PERIODO, UN IMPORTE, UN ASIENTO ────────────────
CREATE TABLE prepaid_amortization_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- (a) LA CORRECCIÓN DEL 056: entity_id PROPIO. Ver la cabecera.
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    prepaid_expense_id UUID NOT NULL,
    fiscal_period_id UUID NOT NULL,

    -- La fecha con la que se posteó el asiento: el último día del periodo
    -- corrido, no la del calendario del anticipo. Es el defecto B de F06a
    -- (depreciation.ts:129-140): `createJournalEntry` deduce el periodo
    -- fiscal DE LA FECHA, así que una fecha de noviembre en la corrida de
    -- diciembre no era una etiqueta torcida, era el asiento colgado de otro
    -- periodo que el de su propio renglón.
    amortization_date DATE NOT NULL,

    -- Meses de CALENDARIO desde el mes en que arranca la cobertura. Se guarda
    -- porque es lo que ata este renglón a su posición en el calendario puro,
    -- y porque el defecto A de F06a fue exactamente un índice que derivaba.
    period_index INTEGER NOT NULL CHECK (period_index >= 0),

    -- Días de cobertura imputados a este periodo. Con la convención por días
    -- son los que fijan el importe; con la de meses completos son
    -- informativos —el importe es el mismo cada mes— y aun así se guardan,
    -- porque son la única manera de ver desde la tabla que la ventana se
    -- repartió entera.
    days_covered INTEGER NOT NULL CHECK (days_covered >= 0),

    amortization_amount DECIMAL(19,4) NOT NULL CHECK (amortization_amount > 0),
    accumulated_amortization DECIMAL(19,4) NOT NULL CHECK (accumulated_amortization > 0),
    remaining_balance DECIMAL(19,4) NOT NULL CHECK (remaining_balance >= 0),

    is_posted BOOLEAN NOT NULL DEFAULT false,
    journal_entry_id UUID REFERENCES journal_entries(id),
    calculation_metadata JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- EL FRENO DE DOBLE CORRIDA, EN EL ESQUEMA.
    --
    -- Aquí basta una UNIQUE de dos columnas donde la depreciación necesita un
    -- freno de dos mitades: su UNIQUE incluye `schedule_type`, así que el
    -- libro contable y el fiscal del mismo mes son dos filas legítimas y
    -- cambiar la política `base_depreciacion` entre dos corridas del mismo
    -- mes cargaba el gasto DOS VECES (depreciation.ts:253-273). Un anticipo
    -- no tiene dos libros: el devengo es uno, y un mes es un renglón.
    CONSTRAINT uq_amortizacion_anticipo_periodo UNIQUE (prepaid_expense_id, fiscal_period_id),

    -- (b) LA CORRECCIÓN DEL 056, DE NACIMIENTO.
    CONSTRAINT amortizacion_posteada_con_asiento
        CHECK (is_posted = false OR journal_entry_id IS NOT NULL),

    -- LA ENTIDAD, EN LAS FORÁNEAS. Ni el anticipo ni el periodo pueden ser de
    -- otra entidad, y no porque la consulta lo filtre.
    CONSTRAINT fk_amortizacion_anticipo_entidad
        FOREIGN KEY (prepaid_expense_id, entity_id)
        REFERENCES prepaid_expenses (id, entity_id),
    CONSTRAINT fk_amortizacion_periodo_entidad
        FOREIGN KEY (fiscal_period_id, entity_id)
        REFERENCES fiscal_periods (id, entity_id)
);

CREATE INDEX idx_amortizacion_anticipo ON prepaid_amortization_schedules (prepaid_expense_id);
CREATE INDEX idx_amortizacion_periodo ON prepaid_amortization_schedules (entity_id, fiscal_period_id);
CREATE INDEX idx_amortizacion_asiento ON prepaid_amortization_schedules (journal_entry_id)
    WHERE journal_entry_id IS NOT NULL;

COMMENT ON TABLE prepaid_amortization_schedules IS
  'Un renglón por anticipo y periodo fiscal: el importe devengado ese mes y el asiento que lo puso en el mayor. Nace posteado — el motor no escribe renglones teóricos, porque un calendario guardado que nadie postea es exactamente la promesa que este tramo vino a cerrar.';

COMMENT ON COLUMN prepaid_amortization_schedules.entity_id IS
  'Propio, no derivado por JOIN. Además del alcance en cada consulta, es lo que hace que rls-policies.sql genere la política de aislamiento SOLA: su primer bucle sólo mira tablas con tenant_id o entity_id, y una tabla sin ninguna de las dos depende de que alguien la apunte a mano en la lista de padres (donde depreciation_schedules sí está, pero por memoria y no por construcción).';

COMMENT ON COLUMN prepaid_amortization_schedules.journal_entry_id IS
  'El asiento que devengó este renglón (DR gasto / CR 1160). El CHECK amortizacion_posteada_con_asiento lo exige para is_posted: una fila que dice estar posteada sin poder decir dónde es indistinguible de una marcada a mano.';

COMMENT ON COLUMN prepaid_amortization_schedules.calculation_metadata IS
  'Con qué se calculó este renglón: convención, índice del calendario, días cubiertos, total de periodos y qué decía el panel el día de la corrida. El importe solo no permite reconstruir por qué es ése.';
