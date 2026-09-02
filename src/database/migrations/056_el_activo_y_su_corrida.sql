-- ============================================================
-- 056 · EL ACTIVO Y SU CORRIDA (F06a)
--
-- El módulo de activos lleva desde la 003 con el esquema entero y **ningún
-- escritor**: no existe un solo `INSERT INTO fixed_assets` en todo `src/`, así
-- que `depreciation_schedules` está vacía y `runMonthlyDepreciation` —que sí
-- existe— no tiene ni activos que depreciar ni un llamador que la invoque.
--
-- El propio sistema ya lo confesaba en la pantalla donde el usuario decide
-- capitalizar un CFDI (cfdi-decisions.ts:96): «capitalizar contabiliza el
-- importe a la cuenta de activo y nada más… ni siquiera hay activo que
-- depreciar», y por eso la opción se etiqueta «depreciation NOT computed by
-- the system yet». Este tramo es el que vuelve verdadera esa etiqueta.
--
-- POR QUÉ ESTA MIGRACIÓN ES PEQUEÑA Y AUN ASÍ VA PRIMERO. Casi todo el
-- esquema estaba bien pensado desde abril. Lo que falta son dos cierres de
-- boca: que el par de métodos contable/fiscal no admita texto libre, y que
-- «posteada» no pueda significarse sin el asiento que lo prueba.
-- ============================================================

-- ── 1. EL MÉTODO CONTABLE Y EL FISCAL, CON VOCABULARIO ──────────────────
--
-- La 003 creó `book_depreciation_method` y `tax_depreciation_method` como
-- VARCHAR(50) SIN CHECK, al lado de `depreciation_method`, que sí lo tiene
-- (003:159-163). Nadie las lee y nadie las escribe, así que la divergencia no
-- se notaba; en cuanto F06a las use, un valor mal tecleado elegiría en
-- silencio un método de cálculo distinto del que el usuario cree.
--
-- Que existan DOS columnas no es redundancia: en México la depreciación
-- contable sigue la vida útil (NIF C-6) y la fiscal las tasas máximas de los
-- artículos 31-38 de la LISR, y son números distintos sobre el mismo activo.
-- El esquema ya lo sabía —`depreciation_schedules.schedule_type` admite
-- 'book', 'tax' y 'projected' desde la 003— y el motor clavaba 'book'.
ALTER TABLE fixed_assets
    ADD CONSTRAINT fixed_assets_book_method_check
        CHECK (book_depreciation_method IS NULL OR book_depreciation_method IN (
            'straight_line', 'declining_balance_150', 'declining_balance_200',
            'sum_of_years_digits', 'units_of_production', 'macrs'
        ));

ALTER TABLE fixed_assets
    ADD CONSTRAINT fixed_assets_tax_method_check
        CHECK (tax_depreciation_method IS NULL OR tax_depreciation_method IN (
            'straight_line', 'declining_balance_150', 'declining_balance_200',
            'sum_of_years_digits', 'units_of_production', 'macrs'
        ));

COMMENT ON COLUMN fixed_assets.book_depreciation_method IS
  'Método CONTABLE (NIF C-6, por vida útil). Distinto del fiscal a propósito: los artículos 31-38 de la LISR fijan tasas máximas que dan otro número sobre el mismo activo, y el despacho elige cuál rige el gasto posteado (política `base_depreciacion`).';

-- ── 2. «POSTEADA» NO SE PUEDE DECIR SIN EL ASIENTO QUE LO PRUEBA ────────
--
-- `is_posted` y `journal_entry_id` existen desde la 003 (211-212) y **nadie
-- escribe el segundo**: el motor inserta la fila del calendario y crea el
-- asiento, pero no los ata. Una fila con `is_posted = true` y
-- `journal_entry_id` nulo afirma que el gasto está en el mayor sin poder
-- decir dónde — y es indistinguible de una que se marcó a mano.
--
-- Es el mismo invariante que la 052 puso sobre el sello de conciliación y la
-- 055 sobre la firma de la sesión: el estado y su constancia no se separan.
-- Aquí importa más que allá, porque quien lea esta tabla para el cálculo de
-- la deducción fiscal necesita poder llegar de la fila al asiento.
ALTER TABLE depreciation_schedules
    ADD CONSTRAINT depreciacion_posteada_con_asiento
        CHECK (is_posted = false OR journal_entry_id IS NOT NULL);

COMMENT ON COLUMN depreciation_schedules.journal_entry_id IS
  'El asiento que puso este renglón en el mayor. El CHECK depreciacion_posteada_con_asiento lo exige para is_posted: una fila que dice estar posteada sin poder decir dónde es indistinguible de una marcada a mano.';

COMMENT ON COLUMN depreciation_schedules.calculation_metadata IS
  'Con qué se calculó este renglón: método, convención del primer mes, base (contable o fiscal) y el índice del calendario. Se guarda porque el importe solo no permite reconstruir por qué es ése, y la corrida del mes que viene tiene que poder comprobar que sigue el mismo criterio.';
