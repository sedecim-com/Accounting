-- ============================================================
-- 077 · LA HIJA QUE PREGUNTA POR SU MADRE, UNA VEZ POR FILA (E1b)
--
-- La 069 (E1a) abarató la EVALUACIÓN del predicado de inquilino. Esta abarata
-- el predicado mismo, que en las tablas hija tiene otra forma y otro coste.
--
-- Diecinueve tablas no llevan `tenant_id`: alcanzan su inquilino por la FK al
-- padre, y su política lo dice literalmente —rls-policies.sql, bloque
-- CHILD-TABLE POLICIES—:
--
--     EXISTS (SELECT 1 FROM journal_entries p WHERE p.id = journal_entry_lines.journal_entry_id)
--
-- Eso es una subconsulta correlacionada POR FILA. Y dentro de ella se evalúa
-- además la política del padre, que en el mayor tampoco es directa:
--
--     entity_id IN (SELECT id FROM legal_entities WHERE tenant_id = app_current_tenant())
--
-- De modo que leer una línea del mayor cuesta DOS subconsultas anidadas por
-- fila. No es que sean lentas: es que impiden que el índice haga de índice. El
-- predicado no puede usarse como condición de acceso, así que se degrada a
-- filtro posterior y la tabla se recorre entera.
--
-- Con `tenant_id` en la propia hija el predicado pasa a ser una comparación de
-- columna —`tenant_id = app_current_tenant()`, ya insertable en línea desde la
-- 069—: una sola comparación por fila, sin visitar al padre.
--
-- MEDIDO, y la medición corrige la explicación fácil. Sobre 20 000 asientos y
-- 40 000 líneas (tests/integration/e1b-predicado-directo.int.spec.ts):
--
--     subconsulta por fila     22 ms
--     predicado directo         4 ms      5.1× — 6.8× entre corridas
--
-- Pero el plan del predicado directo SIGUE SIENDO un recorrido secuencial, y
-- es lo correcto: en esa prueba el inquilino posee las 40 000 filas, así que
-- recorrer es óptimo y ningún índice mejora eso. La ganancia NO viene del
-- índice: viene de no visitar al padre una vez por fila. El índice paga en el
-- caso que la prueba no monta y la producción sí tiene —un inquilino que es
-- una fracción de la tabla—, y por eso se crea igual.
--
-- ── POR QUÉ VA DESPUÉS DEL SELLO, Y POR QUÉ AHORA ───────────────────────
--
-- Esta migración choca de frente con el guardián de inmutabilidad de la 041.
-- VERIFICADO, no supuesto: sobre la base de desarrollo, con la cadena real de
-- dos saltos,
--
--     ALTER TABLE journal_entry_lines ADD COLUMN tenant_id UUID;
--     UPDATE journal_entry_lines l SET tenant_id = le.tenant_id
--       FROM journal_entries e JOIN legal_entities le ON le.id = e.entity_id
--      WHERE e.id = l.journal_entry_id;
--
-- muere en
--
--     ERROR: journal_entry_lines: una línea de asiento POSTEADO no se edita
--
-- porque el guardián compara `to_jsonb(NEW) - permitidas` contra
-- `to_jsonb(OLD) - permitidas`, y rellenar una columna nueva es, para esa
-- comparación, indistinguible de reescribir un importe. Desde la 058 el
-- disparador está en ENABLE ALWAYS: no hay `session_replication_role` que lo
-- calle, y apagarlo lo delataría `doctor`. Ésa es exactamente la propiedad que
-- S3·sello compró, y esta migración no la va a gastar.
--
-- Y es una migración que se hace CUANDO EL MAYOR ES LO MÁS PEQUEÑO QUE VA A
-- SER: el relleno toca todas las filas de las diecinueve tablas, y su coste
-- sólo crece.
-- ============================================================

-- ── 1. EL GUARDIÁN APRENDE LA DIFERENCIA ────────────────────────────────
--
-- Entre RELLENAR UN HUECO y CAMBIAR UN HECHO. Un asiento posteado no se edita;
-- pero una columna que acaba de nacer vacía no contiene ningún hecho que
-- proteger, y el sistema puede calcular su único valor correcto por sí mismo.
--
-- EL PERMISO NO DEBILITA LA GARANTÍA, y ésa es la razón de su forma: exige que
-- el valor viejo sea NULL —una sola vez por fila, irreversible— Y que el nuevo
-- sea EXACTAMENTE el que dicta el padre. Lo único escribible es lo único que
-- el sistema habría calculado solo, así que no hay grado de libertad que
-- alguien pueda usar: no se puede mover una línea posteada a otro inquilino,
-- que sería peor que editarle el importe —contaminación entre fronteras de
-- aislamiento en vez de un error de cifra—.
--
-- El resto de la fila sigue comparándose como siempre: quien intente colar un
-- cambio de importe EN EL MISMO UPDATE que el relleno se topa con la misma
-- excepción de siempre.
CREATE OR REPLACE FUNCTION ledger_linea_posteada_inmutable() RETURNS trigger AS $$
DECLARE
  permitidas text[] := ARRAY['is_reconciled', 'reconciled_at', 'reconciliation_id'];
  estado text;
BEGIN
  SELECT status INTO estado FROM journal_entries WHERE id = OLD.journal_entry_id;

  IF TG_OP = 'DELETE' THEN
    IF estado = 'posted' THEN
      RAISE EXCEPTION
        'journal_entry_lines: una línea de asiento POSTEADO no se borra. El hecho se corrige por reversa (NIF B-1).'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- EL RELLENO DE `tenant_id` (071). Puerta de una sola dirección: sólo de
  -- NULL a su valor correcto, y sólo si nada más cambia en la fila.
  IF estado = 'posted'
     AND OLD.tenant_id IS NULL
     AND NEW.tenant_id = (SELECT le.tenant_id
                            FROM journal_entries e
                            JOIN legal_entities le ON le.id = e.entity_id
                           WHERE e.id = NEW.journal_entry_id)
     AND (to_jsonb(NEW) - permitidas - 'tenant_id')
         IS NOT DISTINCT FROM (to_jsonb(OLD) - permitidas - 'tenant_id') THEN
    RETURN NEW;
  END IF;

  IF estado = 'posted'
     AND (to_jsonb(NEW) - permitidas) IS DISTINCT FROM (to_jsonb(OLD) - permitidas) THEN
    RAISE EXCEPTION
      'journal_entry_lines: una línea de asiento POSTEADO no se edita (sólo la marca de conciliación admite escritura). El hecho se corrige por reversa (NIF B-1).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 2. LA COLUMNA, Y QUIÉN LA MANTIENE ──────────────────────────────────
--
-- `tenant_id` en una hija NO es un dato que el llamador aporte: es un HECHO
-- DERIVADO del padre. Si dependiera de que cada INSERT se acuerde de
-- rellenarlo —y son decenas de sitios—, bastaría uno que no para que la fila
-- naciera sin inquilino y la política directa la escondiera para siempre de su
-- propio dueño. Peor: sería un dato que puede DIVERGIR del padre.
--
-- Por eso lo mantiene la base. Un disparador BEFORE INSERT lo deduce, ningún
-- escritor cambia una línea, y el valor no puede ser otro que el correcto.
-- Es la misma regla que el registro de PACs: lo que no debe confiarse a que
-- alguien lo recuerde, se calcula.

CREATE OR REPLACE FUNCTION hija_hereda_inquilino() RETURNS trigger AS $$
DECLARE
  fk_col   text := TG_ARGV[0];
  padre    text := TG_ARGV[1];
  via      text := TG_ARGV[2];   -- 'propio' | 'entidad', resuelto AL CREAR
  fk_valor uuid;
  derivado uuid;
BEGIN
  -- `to_jsonb(NEW) ->> col` en vez de EXECUTE dinámico: leer una columna cuyo
  -- nombre es un parámetro no justifica ejecutar SQL, y este disparador corre
  -- en CADA inserción del mayor.
  fk_valor := (to_jsonb(NEW) ->> fk_col)::uuid;
  IF fk_valor IS NULL THEN
    RETURN NEW;  -- FK opcional: la política de la tabla decide qué hacer con ella
  END IF;

  -- LA CADENA SE RESUELVE UNA VEZ, AL CREAR EL DISPARADOR, NO POR FILA.
  -- La primera versión de esta función preguntaba a information_schema en cada
  -- INSERT para saber si el padre lleva `tenant_id`. La fixture de volumen lo
  -- destapó: 150 000 inserciones no terminaban. Es el mismo pecado que este
  -- tramo viene a corregir —trabajo por fila que podía hacerse una sola vez—,
  -- cometido dentro de su propio arreglo.
  IF via = 'propio' THEN
    EXECUTE format('SELECT p.tenant_id FROM public.%I p WHERE p.id = $1', padre)
      INTO derivado USING fk_valor;
  ELSE
    EXECUTE format(
      'SELECT le.tenant_id FROM public.%I p JOIN public.legal_entities le ON le.id = p.entity_id WHERE p.id = $1',
      padre) INTO derivado USING fk_valor;
  END IF;

  NEW.tenant_id := derivado;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION hija_hereda_inquilino() IS
  'Deriva tenant_id del padre en las tablas hija (077/E1b). La columna es un hecho derivado, no un dato del llamador: así ningún INSERT puede olvidarla ni contradecir al padre.';

-- ── 3. LAS DIECINUEVE: COLUMNA, DISPARADOR, RELLENO, ÍNDICE Y POLÍTICA ───
--
-- EL ORDEN IMPORTA. `bank_transactions` es hija (de bank_accounts) Y madre (de
-- reconciliation_matches): tiene que recibir su inquilino antes de que su
-- propia hija lo derive de ella. La lista va en ese orden y el bucle lo
-- respeta; la derivación consulta el esquema en cada vuelta, así que la hija
-- que se procesa después ya ve la columna que la anterior acaba de crear.
--
-- EL RELLENO VA POR INQUILINO Y LO DECLARA (patrón de la 063): migrate.ts
-- corre con row_security=off para que un DML sin contexto no afecte cero filas
-- en silencio, sino que reviente con 42501. Este bucle sí maneja RLS a
-- propósito, así que enciende la fila y la declara; el SET LOCAL muere con la
-- transacción de esta migración.

SET LOCAL row_security = on;

DO $e1b$
DECLARE
  m record;
  llenadas bigint;
  total    bigint := 0;
  t        record;
  parcial  bigint;
  via      text;
BEGIN
  FOR m IN
    SELECT * FROM (VALUES
      ('journal_entry_lines',          'journal_entry_id',    'journal_entries'),
      ('invoice_lines',                'invoice_id',          'invoices'),
      ('bill_lines',                   'bill_id',             'bills'),
      ('payment_allocations',          'payment_id',          'customer_payments'),
      ('payment_applications',         'payment_id',          'vendor_payments'),
      ('credit_note_applications',     'credit_note_id',      'credit_notes'),
      ('inventory_layers',             'item_id',             'inventory_items'),
      ('inventory_layer_consumption',  'item_id',             'inventory_items'),
      ('depreciation_schedules',       'asset_id',            'fixed_assets'),
      ('bank_transactions',            'bank_account_id',     'bank_accounts'),
      ('reconciliation_matches',       'bank_transaction_id', 'bank_transactions'),
      ('paycheck_earnings',            'paycheck_id',         'paychecks'),
      ('paycheck_deductions',          'paycheck_id',         'paychecks'),
      ('paycheck_taxes',               'paycheck_id',         'paychecks'),
      ('garnishments',                 'employee_id',         'employees'),
      ('employee_benefit_elections',   'employee_id',         'employees'),
      ('employee_compensation_history','employee_id',         'employees'),
      ('ai_messages',                  'session_id',          'ai_sessions'),
      ('xml_document_lines',           'xml_document_id',     'xml_documents'),
      ('webhook_deliveries',           'webhook_id',          'webhook_subscriptions')
    ) AS t(child, fk, parent)
  LOOP
    CONTINUE WHEN to_regclass('public.' || m.child) IS NULL;

    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id UUID', m.child);

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', m.child || '_hereda_inquilino', m.child);
    SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_schema='public' AND table_name=m.parent AND column_name='tenant_id')
                THEN 'propio' ELSE 'entidad' END INTO via;
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION hija_hereda_inquilino(%L, %L, %L)',
      m.child || '_hereda_inquilino', m.child, m.fk, m.parent, via);

    -- El relleno, inquilino por inquilino y sólo donde falta.
    llenadas := 0;
    FOR t IN SELECT id FROM tenants LOOP
      PERFORM set_config('app.current_tenant', t.id::text, true);
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name=m.parent AND column_name='tenant_id') THEN
        EXECUTE format(
          'UPDATE public.%I c SET tenant_id = p.tenant_id FROM public.%I p WHERE p.id = c.%I AND c.tenant_id IS NULL',
          m.child, m.parent, m.fk);
      ELSE
        EXECUTE format(
          'UPDATE public.%I c SET tenant_id = le.tenant_id FROM public.%I p '
          || 'JOIN public.legal_entities le ON le.id = p.entity_id WHERE p.id = c.%I AND c.tenant_id IS NULL',
          m.child, m.parent, m.fk);
      END IF;
      GET DIAGNOSTICS parcial = ROW_COUNT;
      llenadas := llenadas + parcial;
    END LOOP;
    total := total + llenadas;

    -- El índice que la política directa va a usar como condición de acceso.
    -- Sin él, cambiar el predicado no compra nada: seguiría siendo un filtro.
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)', 'idx_' || m.child || '_tenant', m.child);

    RAISE NOTICE '%: % filas con inquilino', m.child, llenadas;
  END LOOP;

  RAISE NOTICE 'E1b · inquilino derivado en % filas de tablas hija', total;
END
$e1b$;

-- ============================================================
-- LO QUE ESTA MIGRACIÓN AÚN NO PRUEBA, DICHO AQUÍ Y NO EN UN COMENTARIO DE PR
--
-- Lo verificado contra base real: aplica sin error, rellena las diecinueve
-- tablas (110 filas en desarrollo, incluidas 36 líneas de asientos POSTEADOS
-- que antes hacían saltar al guardián), y la política directa se crea con
-- respaldo para bases a medio migrar.
--
-- Lo NO verificado: la mejora de tiempo. La tarjeta de E1 cita 840 ms → 193 ms
-- y esa cifra sigue sin reproducirse aquí. El intento de fixture destapó por
-- qué no es trivial: `trg_update_je_totals` reescribe los totales del asiento
-- padre en CADA inserción de línea, así que cargar N líneas sobre un mismo
-- asiento son N updates de la misma fila —versionada, indexada y pasada por su
-- guardián de inmutabilidad cada vez—. Una fixture honesta tiene que crear
-- MUCHOS ASIENTOS con pocas líneas, que es la forma de un mayor real, y eso es
-- trabajo aparte.
--
-- El mecanismo sí es sólido y no depende de la cifra: un predicado de columna
-- puede ser condición de índice; un EXISTS correlacionado sobre el padre no
-- puede empujarse a un índice de la hija. Pero MECANISMO NO ES MEDICIÓN, y
-- este repositorio no cierra tramos con argumentos.
-- ============================================================
