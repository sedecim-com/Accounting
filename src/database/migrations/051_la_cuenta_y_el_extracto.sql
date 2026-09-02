-- ============================================================
-- 051 · LA CUENTA Y EL EXTRACTO (F05a)
--
-- El módulo bancario lleva desde la 003 con cuatro tablas que nadie ha
-- alterado nunca, y con un agujero en el centro: NO EXISTE EL ESTADO DE
-- CUENTA. Hay movimientos sueltos que cuelgan de un `import_batch_id` que es
-- un UUID sin tabla detrás, y una sesión de conciliación que inserta su
-- `beginning_balance` FIJO EN CERO porque no tiene de dónde sacarlo.
--
-- Esa ausencia es la que vuelve imposible todo lo demás. Las siete pruebas de
-- integridad que el catálogo promete —cadena de saldos, continuidad con el
-- estado previo, huecos y traslapes, identidad de cuenta, moneda, secuencia y
-- reversos— son todas preguntas sobre un DOCUMENTO con saldo inicial y saldo
-- final. Sin ese documento no hay ninguna que se pueda formular, y la
-- aritmética de dos lados de la conciliación se queda comparando contra un
-- cero que significa «nadie restó nada».
--
-- Esta migración crea ese documento y repara tres defectos verificados de la
-- 003 que estaban esperando a que alguien construyera encima.
-- ============================================================

-- ── 1. EL TIPO DE CUENTA ────────────────────────────────────────────────
--
-- El catálogo lo pide en `bank account create --type` y la tabla no lo tiene.
-- Importa más de lo que parece: una tarjeta de crédito es un PASIVO y no un
-- activo, así que su saldo se lee con el signo contrario, y la caja chica no
-- se concilia contra un extracto sino contra un arqueo. Sin esta columna, el
-- módulo trata a las cinco igual.
ALTER TABLE bank_accounts
    ADD COLUMN account_type VARCHAR(20) NOT NULL DEFAULT 'checking'
        CHECK (account_type IN ('checking', 'savings', 'petty-cash', 'credit-card', 'escrow'));

COMMENT ON COLUMN bank_accounts.account_type IS
  'Naturaleza de la cuenta. credit-card es PASIVO: su saldo se interpreta con el signo contrario al de las demás. petty-cash no se concilia contra extracto sino contra arqueo.';

-- ── 2. LA CLABE DEJA DE VIVIR EN CLARO ──────────────────────────────────
--
-- La 003 cifra el número de cuenta y el routing (`account_number_encrypted`,
-- `routing_number_encrypted`) y deja la CLABE en `VARCHAR(18)` a la vista. La
-- CLABE ES el número de cuenta en México: es exactamente el dato que las otras
-- dos columnas protegen, guardado sin protección al lado de ellas. El criterio
-- E0.3 de la bitácora ya la nombra entre «los campos que los servicios cifran
-- hoy» — daba por hecho un cifrado que no existía.
--
-- NADIE la escribe hoy: ni un servicio, ni una ruta, ni la siembra
-- (seed.ts:172 inserta sin ella). Pero que el código de HOY no la escriba no
-- prueba que las bases ya desplegadas estén vacías: la columna existe desde la
-- 003, y una instalación pudo poblarla por SQL, por una versión anterior o por
-- una carga. Soltarla a ciegas destruiría, sin vuelta y sin aviso, justo el
-- dato más sensible del maestro bancario — la CLABE ES el número de cuenta.
--
-- Y no se puede migrar aquí: `clabe_encrypted` se cifra con la llave de la
-- APLICACIÓN (la misma de account_number_encrypted), que vive en el proceso de
-- Node y no en Postgres. Una migración SQL no tiene con qué cifrar, y llamar
-- `_encrypted` a una columna que guardara texto en claro sería peor que el
-- problema que esta migración viene a resolver.
--
-- Así que se comprueba y se PLANTA. Sobre una base sin CLABEs —la de
-- desarrollo, la de CI y cualquier instalación que nunca la usó— no cambia
-- nada. Sobre una que sí las tenga, la migración se detiene y dice qué hacer,
-- en vez de dejar al operador enterarse por el hueco.
--
-- Se declara el opt-in de RLS y se itera por inquilino: es el patrón sancionado
-- (docs/migraciones.md). `migrate.ts` corre con row_security=off, que bajo el
-- piso hace que un SELECT sobre una tabla acotada lance 42501 en vez de mirar
-- filtrado; sin este bucle, el conteo vería CERO filas y la guarda daría el
-- visto bueno precisamente en la base que venía a proteger.
SET LOCAL row_security = on;
DO $clabe$
DECLARE
  t record;
  n bigint := 0;
  total bigint := 0;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    SELECT count(*) INTO n FROM bank_accounts WHERE clabe IS NOT NULL;
    total := total + n;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);

  IF total > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('051 se detiene: hay %s cuenta(s) con CLABE en claro y esta migración las borraría.', total),
      DETAIL  = 'La CLABE es el número de cuenta bancaria. Soltar la columna aquí la destruiría sin vuelta, y no se puede cifrar desde SQL: la llave vive en la aplicación.',
      HINT    = 'Cífralas desde la aplicación (misma llave que account_number_encrypted) hacia clabe_encrypted/clabe_last4, limpia bank_accounts.clabe, y vuelve a correr npm run migrate. Si de verdad no valen nada, bórralas a mano y deja constancia de por qué.';
  END IF;
END
$clabe$;

ALTER TABLE bank_accounts DROP COLUMN clabe;
ALTER TABLE bank_accounts
    ADD COLUMN clabe_encrypted TEXT,
    ADD COLUMN clabe_last4 VARCHAR(4),
    -- Clave de banco del catálogo del SAT (c_Banco, 3 dígitos). El Anexo 24
    -- la exige DENTRO de la póliza para cuenta origen y destino, así que es
    -- dato fiscal, no adorno del maestro.
    ADD COLUMN sat_bank_code VARCHAR(3);

COMMENT ON COLUMN bank_accounts.clabe_encrypted IS
  'CLABE cifrada con la misma llave que account_number_encrypted. Nunca se devuelve en claro: las superficies muestran clabe_last4.';

-- ── 3. EL MAPEO 1:1 CON EL MAYOR, RESPALDADO ────────────────────────────
--
-- `bank account create` y `bank account set` prometen «unicidad 1:1 del mapeo
-- contable», y lo único que había era `idx_bank_accounts_gl`, un índice NO
-- ÚNICO. Dos cuentas bancarias apuntando a la misma cuenta de mayor hacen que
-- la conciliación de una vea los movimientos contables de la otra, y que el
-- saldo de libros de ambas sea el mismo número: la aritmética de dos lados
-- deja de tener sentido sin que nada se queje.
DROP INDEX IF EXISTS idx_bank_accounts_gl;
CREATE UNIQUE INDEX uq_bank_accounts_gl ON bank_accounts(gl_account_id);

-- ── 4. EL ESTADO DE CUENTA ──────────────────────────────────────────────
--
-- El documento que faltaba. Lleva sus dos saldos porque son ellos —y no las
-- líneas— los que habilitan la conciliación, y lleva el hash del archivo
-- original porque el estado de cuenta es EVIDENCIA FISCAL: quien lo audite
-- tiene que poder demostrar que el PDF del banco y lo que entró al sistema son
-- el mismo documento.
CREATE TABLE bank_statements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),

    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    opening_balance DECIMAL(19,4) NOT NULL,
    closing_balance DECIMAL(19,4) NOT NULL,
    currency_code CHAR(3) NOT NULL,

    -- Número de secuencia electrónica que publica el banco. Es lo que permite
    -- detectar un estado FALTANTE: entre el 7 y el 9 falta el 8, aunque sus
    -- fechas no dejen hueco.
    statement_number VARCHAR(50),

    source_format VARCHAR(20) NOT NULL
        CHECK (source_format IN ('csv', 'ofx', 'qfx', 'mt940', 'mt942', 'camt053', 'camt054', 'bai2', 'xlsx', 'manual')),
    -- El perfil de columnas con el que se leyó un CSV. Dos bancos exportan
    -- «CSV» y no se parecen en nada; sin registrar cuál se usó, un import que
    -- salió torcido no se puede explicar después.
    profile VARCHAR(60),
    file_name TEXT,
    file_sha256 CHAR(64) NOT NULL,
    line_count INTEGER NOT NULL DEFAULT 0,

    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    imported_by UUID NOT NULL,

    CHECK (period_end >= period_start),
    -- EL MISMO ARCHIVO NO ENTRA DOS VECES. Es el dedupe de nivel documento,
    -- complementario al de nivel línea de abajo.
    UNIQUE (bank_account_id, file_sha256)
);

CREATE INDEX idx_bank_statements_entity ON bank_statements(entity_id);
CREATE INDEX idx_bank_statements_cuenta_periodo ON bank_statements(bank_account_id, period_start, period_end);

COMMENT ON TABLE bank_statements IS
  'El estado de cuenta como documento, con sus dos saldos y el hash de su archivo. Sin él, reconciliation_sessions.beginning_balance no tiene de dónde salir y se queda en el 0 de su DEFAULT.';

-- ── 5. LAS LÍNEAS CUELGAN DE SU DOCUMENTO, Y SE DEDUPLICAN DE VERDAD ─────
--
-- EL DEDUPE QUE NO DEDUPLICABA. La 003 declara
-- `UNIQUE(bank_account_id, bank_transaction_id)` sobre una columna NULLABLE, y
-- en Postgres dos NULL no colisionan: el índice no impide NADA en cuanto el
-- banco no publica un id nativo, que es el caso de todo CSV. Y el guardia de
-- aplicación tenía el mismo agujero por el otro lado —
-- `WHERE bank_transaction_id = $1` con $1 nulo no casa nunca, así que el
-- `SELECT` previo también daba vía libre—. Dos capas, el mismo fallo, y
-- ninguna deduplicaba: reimportar el mismo archivo duplicaba el extracto
-- entero.
--
-- `content_hash` es el dedupe determinista que el catálogo pide: se calcula de
-- los campos que identifican la línea, así que existe SIEMPRE, publique el
-- banco un id o no.
ALTER TABLE bank_transactions
    ADD COLUMN statement_id UUID REFERENCES bank_statements(id),
    ADD COLUMN content_hash CHAR(64);

-- LO CALCULA LA BASE, NO EL LLAMADOR.
--
-- Podría exigirse que cada superficie lo mandara, pero un hash que el llamador
-- provee es un hash que el llamador puede equivocar —o falsear— y entonces el
-- índice único de abajo deja de significar «esta línea ya está». Calculado por
-- disparador, la deduplicación es ESTRUCTURAL: no hay forma de insertar una
-- línea con un hash que no le corresponda, escriba quien escriba, y las
-- superficies que ya insertaban siguen funcionando sin saber que existe.
--
-- Se ignora a propósito lo que venga en NEW.content_hash: no es un campo de
-- entrada, es una función de la fila.
CREATE OR REPLACE FUNCTION bank_tx_content_hash() RETURNS trigger AS $$
BEGIN
  NEW.content_hash := encode(
    sha256(
      (NEW.bank_account_id::text || '|' ||
       to_char(NEW.transaction_date, 'YYYY-MM-DD') || '|' ||
       trim(to_char(NEW.amount, 'FM9999999999990.0000')) || '|' ||
       COALESCE(NEW.description, ''))::bytea
    ), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bank_transactions_content_hash
  BEFORE INSERT OR UPDATE OF bank_account_id, transaction_date, amount, description
  ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION bank_tx_content_hash();

-- Relleno de lo ya importado por la MISMA vía, para que no haya dos recetas.
UPDATE bank_transactions SET content_hash = NULL;

ALTER TABLE bank_transactions ALTER COLUMN content_hash SET NOT NULL;

CREATE UNIQUE INDEX uq_bank_tx_contenido ON bank_transactions(bank_account_id, content_hash);
CREATE INDEX idx_bank_tx_statement ON bank_transactions(statement_id);

COMMENT ON COLUMN bank_transactions.content_hash IS
  'sha256 de (cuenta|fecha|importe|descripción), calculado por disparador y NUNCA por el llamador. El dedupe REAL: bank_transaction_id es nullable y un UNIQUE sobre NULL no impide nada, que es por lo que reimportar un CSV duplicaba el extracto.';
