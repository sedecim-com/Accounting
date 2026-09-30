-- ============================================================
-- 172 · THE ANEXO 24 SEAL IS A LOGGED USE OF THE E.FIRMA (#442 · MNE-001-145)
--
-- Under efirma_sellado_contabilidad_electronica = sellar_con_custodia, the
-- catalog and the trial balance are sealed with the entity's e.firma
-- (src/services/sat/anexo24/seal.ts). Two facts follow:
--
--   · the access log gets a new purpose, 'seal_anexo24'. `purpose` has no
--     CHECK (014 left it free text), so only its comment changes;
--   · the sealed copy is archived as its own row, pointing at the unsealed
--     artifact it seals. `sellado` stops being always false, and the CHECK
--     ties the two columns: a row is sealed exactly when it names its source.
--
-- Additive only: every existing row is unsealed with no source, which the
-- CHECK admits.
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
