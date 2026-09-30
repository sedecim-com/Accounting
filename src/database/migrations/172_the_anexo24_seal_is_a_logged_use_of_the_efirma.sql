-- ============================================================
-- 172 · THE ANEXO 24 SEAL IS A LOGGED USE OF THE E.FIRMA (#442 · MNE-001-145)
--
-- Under efirma_sellado_contabilidad_electronica = sellar_con_custodia, the
-- catalog and the trial balance are sealed with the entity's e.firma
-- (src/services/sat/anexo24/seal.ts). Two facts follow:
--
--   · the access log gets a new purpose, 'seal_anexo24'. `purpose` has no
--     CHECK (014 left it free text), so only its comment changes;
--   · each row records when its bytes were LAST produced. `generate` is
--     idempotent by hash, so regenerating bytes already archived inserts
--     nothing and generado_en keeps the first time; without this column the
--     seal would pick the newest FIRST generation, which after
--     generate A, generate B, generate A again is B, not the file the
--     accountant just reviewed;
--   · the sealed copy is archived as its own row, pointing at the unsealed
--     artifact it seals. `sellado` stops being always false, and the CHECK
--     ties the two columns: a row is sealed exactly when it names its source.
--
-- Additive only: every existing row is unsealed with no source, which the
-- CHECK admits, and its last generation is its only known one, generado_en.
-- ============================================================

COMMENT ON COLUMN fiscal_credential_access_log.purpose IS
  'Why the e.firma was decrypted: sat_auth (SAT authentication) | seal_anexo24 (sealing the Anexo 24 catalog or trial balance) | validation | healthcheck | export.';

ALTER TABLE sat_anexo24_artefactos
  ADD COLUMN IF NOT EXISTS sealed_from UUID REFERENCES sat_anexo24_artefactos(id);

ALTER TABLE sat_anexo24_artefactos DROP CONSTRAINT IF EXISTS sat_anexo24_artefactos_sealed_has_source;
ALTER TABLE sat_anexo24_artefactos
  ADD CONSTRAINT sat_anexo24_artefactos_sealed_has_source
  CHECK (sellado = (sealed_from IS NOT NULL));

COMMENT ON COLUMN sat_anexo24_artefactos.sellado IS
  'true only for the copy sealed with the e.firma under sellar_con_custodia (seal.ts), which names its unsealed source in sealed_from. Nothing is filed with the SAT: the upload is done by a person in the SAT portal.';

COMMENT ON COLUMN sat_anexo24_artefactos.sealed_from IS
  'The unsealed artifact this row seals: the document the accountant generated and reviewed, never a rebuild.';

ALTER TABLE sat_anexo24_artefactos
  ADD COLUMN IF NOT EXISTS last_generated_at TIMESTAMPTZ;
UPDATE sat_anexo24_artefactos SET last_generated_at = generado_en WHERE last_generated_at IS NULL;
ALTER TABLE sat_anexo24_artefactos
  ALTER COLUMN last_generated_at SET DEFAULT NOW(),
  ALTER COLUMN last_generated_at SET NOT NULL;

COMMENT ON COLUMN sat_anexo24_artefactos.last_generated_at IS
  'When these exact bytes were last produced. generado_en is the first time; regenerating identical bytes inserts no row and moves only this. `catalog seal` and `balance seal` seal the unsealed row with the latest value: the file the accountant generated last.';

COMMENT ON TABLE sat_anexo24_artefactos IS
  'The Anexo 24 XML exactly as generated, with its hash, so what was generated can be compared and shown later. `catalog seal` / `balance seal` sign the archived bytes the accountant reviewed, never a rebuild; the sealed copy is archived as its own row (sellado, sealed_from).';
