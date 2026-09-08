-- ============================================================
-- 072 · LA HUELLA QUE SE PODÍA FORJAR (WIT-01 crítico de #136)
--
-- El PR #136 (T1) reparó tres defectos EDITANDO EN SU SITIO la 051, que ya
-- estaba distribuida. `migrate.ts` omite todo archivo cuyo NOMBRE ya conste en
-- `public.migrations` y esa tabla no guarda checksum: donde la 051 vieja quedó
-- registrada, la reparada NO CORRERÁ JAMÁS. Medido: sobre esa base, el
-- corredor de hoy dice `Skipping 051_la_cuenta_y_el_extracto.sql (already
-- executed)` y sigue de largo.
--
-- ── QUIÉN NECESITA ESTO, Y QUIÉN NO ─────────────────────────────────────
--
-- Reproducido con el `migrate.ts` VIEJO de verdad, como `mnemosine_owner`
-- (que NO es superusuario, así que FORCE ROW LEVEL SECURITY lo sujeta) y con
-- las políticas aplicadas, que es lo que distingue una ACTUALIZACIÓN de una
-- instalación nueva:
--
--   · Con filas en `bank_transactions`, la 051 vieja ABORTA con 23502 (su
--     relleno no disparaba nada y el `SET NOT NULL` encontraba los NULL).
--     Aborta ⇒ no se registra ⇒ la reparada corre sola en la siguiente
--     actualización. ESA INSTALACIÓN SE CURA SOLA y este archivo no la toca.
--   · Con `bank_transactions` VACÍA, la 051 vieja REGISTRA: no había filas
--     que rellenar y el `SET NOT NULL` pasa. Son toda instalación nueva hecha
--     entre el alta de la 051 y T1, y todo despacho que actualizó antes de
--     importar su primer extracto. ESA es la población de este remedio.
--
-- Y la 060, que T1 editó en el mismo commit, NO necesita remedio: su versión
-- vieja aborta con 42501 en cuanto hay políticas —con filas o sin ellas,
-- porque el error lo lanza el planificador por la EXISTENCIA de la política—,
-- así que nunca queda registrada; y donde sí registró (primera corrida de una
-- instalación nueva) `ai_ingest_runs` estaba vacía y no había nada que
-- rellenar. Un remedio para la 060 no encontraría a quién reparar, y un
-- remedio que no repara nada es peor que ninguno.
--
-- ── LOS TRES RESIDUOS, Y CUÁL CUESTA DINERO ─────────────────────────────
--
-- 1. EL DISPARADOR NO VIGILA `content_hash`. Quedó como
--    `BEFORE INSERT OR UPDATE OF bank_account_id, transaction_date, amount,
--    description`, sin la columna. Medido: `UPDATE bank_transactions SET
--    content_hash = repeat('f',64)` SE QUEDA, no se recalcula. La huella se
--    puede forjar a mano — y la 058 SELLÓ esa garantía como cierta, así que
--    `doctor` la da por buena y `banking.md` se la promete al agente.
--
-- 2. EL ÍNDICE ES ÚNICO. Quedó `uq_bank_tx_contenido` UNIQUE en vez del
--    `idx_bank_tx_contenido` llano. El hash se calcula sobre
--    (cuenta|fecha|importe|descripción), donde no hay NADA que distinga dos
--    hechos distintos, así que hace irrepresentable un extracto bancario real.
--    Y no falla ruidosamente, que es lo peor: `insertarLineas` inserta con
--    `ON CONFLICT DO NOTHING` SIN blanco de conflicto, de modo que la segunda
--    comisión legítima de −50.00 del mismo día NO entra, los libros dicen
--    −50.00 donde el banco cobró −100.00, y el sistema reporta «1 duplicada»
--    ACUSANDO AL BANCO de haber repetido un renglón que era bueno.
--
-- 3. EL COMENTARIO DE COLUMNA sigue siendo el viejo, el que llama a la huella
--    «el dedupe REAL» — la afirmación que T1 desmintió.
--
-- ── LO QUE ESTE ARCHIVO NO PUEDE DEVOLVER ───────────────────────────────
--
-- Las líneas que el `ON CONFLICT DO NOTHING` ya se tragó NO ESTÁN en la base:
-- no hay de dónde sacarlas, y reimportar el archivo lo bloquea
-- `UNIQUE (bank_account_id, file_sha256)` sobre `bank_statements`. Este
-- remedio devuelve la CAPACIDAD de registrarlas; recuperarlas es trabajo del
-- despacho. Quién tiene el hueco y de qué tamaño lo dice `mnemosine doctor`,
-- que es el canal que el operador mira: un WARNING desde aquí no lo es —
-- medido, `npm run migrate` no registra escucha de avisos y los descarta.
--
-- ── POR QUÉ ARCHIVO NUEVO Y NO OTRA EDICIÓN EN SU SITIO ─────────────────
--
-- Porque repetir la edición sería repetir exactamente el defecto que se está
-- reparando. La 051 se queda como está: es el registro de lo que se hizo.
-- ============================================================

-- ── EL CENSO: ¿ESTA BASE ES DE LAS QUE HAY QUE REPARAR? ─────────────────
--
-- Se pregunta al CATÁLOGO y no al repositorio. El criterio del tablero lee el
-- texto de la 051 y da verde en una base que carga el índice único, porque
-- mira el archivo y no la instalación: la única verdad aquí es `pg_index`,
-- `pg_trigger` y `pg_attribute`.
DO $censo$
DECLARE
  unico boolean;
  ciego boolean;
  flojo boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'bank_transactions'::regclass
       AND i.indisunique
       AND c.relname = 'uq_bank_tx_contenido'
  ) INTO unico;

  -- `tgattr` vacío significa «vigila TODA la fila», que es MÁS estricto que lo
  -- que queremos, no menos: sin la guarda de cardinalidad se acusaría de ciego
  -- justo al disparador que no lo es.
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'bank_transactions'::regclass
       AND t.tgname = 'bank_transactions_content_hash'
       AND cardinality(t.tgattr::smallint[]) > 0
       AND NOT (SELECT a.attnum FROM pg_attribute a
                 WHERE a.attrelid = t.tgrelid AND a.attname = 'content_hash')
               = ANY (t.tgattr::smallint[])
  ) INTO ciego;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'bank_transactions'::regclass
       AND t.tgname = 'bank_transactions_content_hash'
       AND t.tgenabled <> 'A'
  ) INTO flojo;

  IF unico OR ciego OR flojo THEN
    RAISE WARNING '072: esta base traía la 051 sin reparar (indice unico=%, disparador ciego=%, sello degradado=%); se repara a continuacion',
      unico, ciego, flojo;
  ELSE
    RAISE NOTICE '072: esta base ya tenia la 051 reparada; el archivo se aplica igual y no cambia nada';
  END IF;
END
$censo$;

-- ── 1 · EL ÍNDICE ───────────────────────────────────────────────────────
--
-- En este orden y no en el contrario. Soltar un índice no borra datos; crear
-- el único donde hay dos movimientos legítimamente idénticos fallaría con
-- 23505 precisamente en las bases que este archivo viene a reparar.
DROP INDEX IF EXISTS uq_bank_tx_contenido;
CREATE INDEX IF NOT EXISTS idx_bank_tx_contenido
  ON bank_transactions(bank_account_id, content_hash);

-- ── 2 · EL DISPARADOR, Y EL SELLO DE LA 058 CON ÉL ──────────────────────
--
-- La trampa está medida y es de las que no se ven: `CREATE OR REPLACE TRIGGER`
-- DEGRADA `tgenabled` de 'A' (ENABLE ALWAYS) a 'O' EN SILENCIO y CONSERVA el
-- comentario — o sea, dejaría el sello «garantia-sellada: … imposible forjar
-- la deduplicación» colgado de un disparador que vuelve a poder apagarse con
-- `session_replication_role = replica`, que es literalmente lo que la 058 vino
-- a impedir. Y `DROP` + `CREATE` pierde las dos cosas. Así que se hacen las
-- tres: recrear, volver a sellar y volver a comentar. La 058 tampoco correrá
-- otra vez.
--
-- La función no se toca: T1 no la tocó, y la receta del hash tiene UNA sola
-- casa —la 051— que es la que el criterio E0.3 del tablero vigila. Duplicarla
-- aquí sería mudar la vigilancia a un archivo que ese criterio no lee.
DROP TRIGGER IF EXISTS bank_transactions_content_hash ON bank_transactions;

CREATE TRIGGER bank_transactions_content_hash
  BEFORE INSERT OR UPDATE OF bank_account_id, transaction_date, amount, description, content_hash
  ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION bank_tx_content_hash();

ALTER TABLE bank_transactions ENABLE ALWAYS TRIGGER bank_transactions_content_hash;

COMMENT ON TRIGGER bank_transactions_content_hash ON bank_transactions IS
  'garantia-sellada: el hash de contenido lo calcula la base ignorando lo que mande el llamador; es lo que hace imposible forjar la deduplicación.';

-- ── 3 · EL COMENTARIO DE LA COLUMNA ─────────────────────────────────────
--
-- Es documentación de la propia base, y la vieja afirma una garantía que la
-- base no daba. Se repone el texto de la 051 reparada, palabra por palabra:
-- si no, las dos poblaciones siguen siendo distinguibles y la próxima
-- auditoría vuelve a empezar de cero.
COMMENT ON COLUMN bank_transactions.content_hash IS
  'sha256 de (cuenta|fecha|importe|descripción), calculado e IMPUESTO por disparador — escribirlo a mano lo recalcula, no lo acepta. Es la HUELLA de la línea, no su llave: dos movimientos legítimamente idénticos el mismo día comparten huella y los dos son ciertos. Lo que impide reimportar es UNIQUE(bank_account_id, file_sha256) sobre el documento.';

-- ── 4 · LAS HUELLAS QUE PUDIERON FORJARSE ───────────────────────────────
--
-- Se COMPRUEBAN, no se recalculan a ciegas. Ningún camino de `src/` escribe
-- `content_hash` (sólo lo lee), y la función no cambió, así que lo que el
-- disparador calculó entonces es lo que calcularía hoy: los datos están sanos
-- y lo que estaba roto era la GARANTÍA. Reescribir la tabla entera crearía una
-- versión nueva de cada fila para no cambiar ni un valor.
--
-- Pero la garantía estuvo abierta, así que se mira. Y se mira POR INQUILINO
-- CON OPT-IN DECLARADO, que es el patrón que T1 dejó escrito: el corredor
-- corre con `row_security = off`, y bajo ese piso una sentencia sobre una
-- tabla acotada por RLS no filtra en silencio — LANZA 42501 —. Sin el bucle,
-- este bloque moriría en la primera base con políticas.
--
-- Cuando una huella no cuadra se corrige tocando una columna VIGILADA
-- (`transaction_date = transaction_date`), nunca escribiendo `content_hash`:
-- escribirla es exactamente lo que el disparador tiene por oficio ignorar.
SET LOCAL row_security = on;
DO $huellas$
DECLARE
  t          record;
  corregidas bigint := 0;
  parcial    bigint;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    UPDATE bank_transactions bt
       SET transaction_date = bt.transaction_date
     WHERE bt.content_hash IS DISTINCT FROM encode(
             sha256(
               (bt.bank_account_id::text || '|' ||
                to_char(bt.transaction_date, 'YYYY-MM-DD') || '|' ||
                trim(to_char(bt.amount, 'FM9999999999990.0000')) || '|' ||
                COALESCE(bt.description, ''))::bytea
             ), 'hex');

    GET DIAGNOSTICS parcial = ROW_COUNT;
    corregidas := corregidas + parcial;
  END LOOP;

  -- Se devuelve el contexto a vacío, como hacen las hermanas: dejar el último
  -- inquilino puesto para el resto de la transacción es un residuo que no
  -- muerde hoy —lo que sigue no es DML— y muerde el día que alguien añada una
  -- sentencia de datos debajo.
  PERFORM set_config('app.current_tenant', '', true);

  IF corregidas > 0 THEN
    RAISE WARNING '072: % huella(s) no correspondian a su fila y se recalcularon: alguien las escribio a mano mientras el disparador estaba ciego',
      corregidas;
  ELSE
    RAISE NOTICE '072: todas las huellas corresponden a su fila; no se reescribio ninguna';
  END IF;
END
$huellas$;
