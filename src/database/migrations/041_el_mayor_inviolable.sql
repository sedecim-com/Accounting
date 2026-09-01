-- ============================================================
-- 041: EL MAYOR INVIOLABLE
--
-- La 033 le dio dos capas a la bitácora; el libro mayor —lo que la bitácora
-- existe para proteger— seguía siendo físicamente reescribible: ningún
-- disparador impedía un UPDATE que cambiara cuenta o monto de una línea
-- posteada manteniendo el par balanceado (ningún CHECK lo ve, y desalinea
-- account_balances sin rastro), ni un DELETE del asiento entero.
--
-- El patrón NO es el de sólo-agregar: un asiento posteado sí admite escritura
-- en una LISTA BLANCA de metadatos que el censo del código dictó (cada
-- columna con su escritor legítimo):
--   · reversed_by_entry_id  — la reversa liga el espejo (posting.ts)
--   · notes                 — la anulación anexa su constancia (posting.ts)
--   · entry_hash, blockchain_attestation_id, commitment — la atestación
--     escribe DESPUÉS de postear (blockchain/orchestrator.ts)
-- Todo lo demás —montos, cuentas, fechas, estado, referencia— es el hecho
-- contable, y un hecho posteado se corrige por reversa, jamás por edición
-- (NIF B-1). La comparación es por resta de JSONB: una columna nueva que
-- alguien añada mañana nace PROTEGIDA por omisión, no expuesta.
--
-- Las funciones hacen RETURN NEW en los caminos permitidos — a propósito y
-- con consecuencia para el instrumento: el criterio E0.3 distingue
-- «bitácora de sólo-agregar» (la función rechaza SIEMPRE, sin RETURN NEW)
-- de esta clase condicional, así que el mayor no entra a los arrays
-- append_only, que le revocarían el UPDATE que el posteo mismo necesita.
--
-- No hay REVOKE aquí: el GRANT general de rls-policies.sql y el
-- reprovisionado lo devolverían en silencio — la lección exacta que parió a
-- E0.3. El disparador es la capa que aguanta, incluso ante el dueño del
-- esquema. TRUNCATE se bloquea aparte (statement-level: no dispara triggers
-- de fila).
-- ============================================================

CREATE OR REPLACE FUNCTION ledger_posteado_inmutable() RETURNS trigger AS $$
DECLARE
  -- Los metadatos que un posteado SÍ admite; el resto es el hecho contable.
  permitidas text[] := ARRAY[
    'reversed_by_entry_id', 'notes', 'entry_hash',
    'blockchain_attestation_id', 'commitment'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION
        'journal_entries: un asiento POSTEADO no se borra (%). Se corrige por reversa (entry reverse) o se anula con espejo (entry void) — NIF B-1.',
        OLD.entry_number
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'posted'
     AND (to_jsonb(NEW) - permitidas) IS DISTINCT FROM (to_jsonb(OLD) - permitidas) THEN
    RAISE EXCEPTION
      'journal_entries: un asiento POSTEADO no se edita (%). Sólo metadatos de reversa/anotación/atestación admiten escritura; el hecho contable se corrige por reversa (NIF B-1).',
      OLD.entry_number
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_posteado_inmutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_posteado_inmutable();

CREATE OR REPLACE FUNCTION ledger_linea_posteada_inmutable() RETURNS trigger AS $$
DECLARE
  permitidas text[] := ARRAY['is_reconciled', 'reconciled_at', 'reconciliation_id'];
  estado text;
BEGIN
  -- El estado vive en el padre. En el CASCADE de un borrador borrado, el
  -- padre ya no existe cuando la línea cae: estado NULL = permitido (un
  -- padre posteado jamás llega aquí porque su propio DELETE se bloqueó).
  SELECT status INTO estado FROM journal_entries WHERE id = OLD.journal_entry_id;

  IF TG_OP = 'DELETE' THEN
    IF estado = 'posted' THEN
      RAISE EXCEPTION
        'journal_entry_lines: una línea de asiento POSTEADO no se borra. El hecho se corrige por reversa (NIF B-1).'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
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

CREATE TRIGGER journal_entry_lines_posteada_inmutable
  BEFORE UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_linea_posteada_inmutable();

-- TRUNCATE vacía el mayor entero sin disparar triggers de fila; se bloquea a
-- nivel sentencia, sin condición: no existe un TRUNCATE legítimo del libro.
CREATE OR REPLACE FUNCTION ledger_sin_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'El libro mayor no se trunca. Si esto es una base de pruebas, bórrala entera y vuelve a migrar.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_sin_truncate
  BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_sin_truncate();

CREATE TRIGGER journal_entry_lines_sin_truncate
  BEFORE TRUNCATE ON journal_entry_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_sin_truncate();
