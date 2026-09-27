-- ============================================================
-- 087 · A REVERSED OPENING CAN BE LOADED AGAIN (MNE-001-018 · #220)
--
-- 081 excluded `status = 'void'` so that an annulled opening could be redone,
-- and `APE-YA-CARGADA` tells the operator exactly that: void it and run again.
-- But a POSTED entry is never flipped to 'void': `voidJournalEntryInTx`
-- (posting.ts) leaves it 'posted' and links a mirror through
-- `reversed_by_entry_id` (NIF B-1: corrections by reversal, never by edit).
-- So the advice was impossible to follow: the reversed opening still held the
-- index slot, and every reload collided with it.
--
-- A reversed opening no longer counts. The index keeps its NAME on purpose:
-- `esAperturaDuplicada` (opening-balance.ts) recognises the race by it.
-- The reversal mirror is not a problem: `createJournalEntry` gives it no
-- `source_type`, so it never enters this predicate.
--
-- CONTRACT: schema — the partial unique index is replaced, no column changes.
-- ============================================================

DROP INDEX IF EXISTS uq_je_apertura_por_entidad_y_fecha;

CREATE UNIQUE INDEX uq_je_apertura_por_entidad_y_fecha
    ON journal_entries (entity_id, entry_date)
    WHERE source_type = 'opening_balance'
      AND status <> 'void'
      AND reversed_by_entry_id IS NULL;
