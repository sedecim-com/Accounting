-- ============================================================
-- 058 · EL SELLO DE LAS GARANTÍAS (S3·sello)
--
-- Las garantías físicas de este esquema son disparadores: la 033 hace la
-- bitácora de sólo-agregar, la 035 hace lo mismo con el registro de acceso a
-- credenciales, la 041 vuelve inmutable el mayor posteado, y la 051 calcula
-- en la BASE el hash de contenido de cada movimiento bancario para que nadie
-- pueda forjarlo. Los cuatro comentarios dicen, con razón, que un disparador
-- aguanta donde un GRANT no.
--
-- Lo que ninguno dice es que **un disparador ordinario tiene un interruptor**,
-- y dos maneras de accionarlo:
--
--   1. `ALTER TABLE ... DISABLE TRIGGER x` — visible, deliberado, del dueño.
--   2. `SET session_replication_role = 'replica'` — UNA LÍNEA de sesión que
--      apaga TODOS los disparadores ordinarios a la vez, sin tocar el
--      esquema, sin dejar rastro en la definición y sin que nada lo anuncie.
--
-- El segundo es el que importa: el dueño puede apagarlos, corregir a mano tres
-- montos con sus `account_balances`, reencender, y `ledger check` da cero,
-- `doctor` da ok y la bitácora no tiene una fila del acto. Un break-glass es
-- legítimo — a veces hay que reparar. Que NADA LO DETECTE, no.
--
-- `ENABLE ALWAYS` cierra la vía 2: el disparador se ejecuta también bajo
-- `session_replication_role = 'replica'`. NO cierra la vía 1, y no pretende
-- hacerlo: contra el dueño del esquema no hay candado dentro del esquema. Lo
-- que hace es dejar UNA sola puerta, la ruidosa, y esa se vigila desde fuera
-- — el chequeo de `doctor` que lee `pg_trigger.tgenabled` y falla si alguno
-- no está en 'A'.
--
-- LA MARCA VIVE JUNTO AL DISPARADOR, NO EN UNA LISTA PARALELA. El chequeo no
-- lleva un inventario escrito a mano de qué debe estar sellado: pregunta a la
-- base por los disparadores COMENTADOS como garantía. Una lista paralela se
-- desincroniza el día que alguien añade la garantía número diez y no la
-- apunta — que es exactamente el defecto que este proyecto ha pagado ya
-- varias veces.
-- ============================================================

-- ── 1. LA BITÁCORA (033) ────────────────────────────────────────────────
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_append_only;
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate;

COMMENT ON TRIGGER audit_log_append_only ON audit_log IS
  'garantia-sellada: la bitácora sólo agrega. ENABLE ALWAYS para que session_replication_role no la apague.';
COMMENT ON TRIGGER audit_log_no_truncate ON audit_log IS
  'garantia-sellada: TRUNCATE no vacía la bitácora. Se bloquea aparte porque es statement-level y no dispara triggers de fila.';

-- ── 2. EL ACCESO A CREDENCIALES FISCALES (035) ──────────────────────────
ALTER TABLE fiscal_credential_access_log
  ENABLE ALWAYS TRIGGER fiscal_credential_access_log_append_only;
ALTER TABLE fiscal_credential_access_log
  ENABLE ALWAYS TRIGGER fiscal_credential_access_log_no_truncate;

COMMENT ON TRIGGER fiscal_credential_access_log_append_only ON fiscal_credential_access_log IS
  'garantia-sellada: cada descifrado de la e.firma deja rastro y el rastro no se edita.';
COMMENT ON TRIGGER fiscal_credential_access_log_no_truncate ON fiscal_credential_access_log IS
  'garantia-sellada: TRUNCATE no vacía el registro de accesos a credenciales.';

-- ── 3. EL MAYOR INVIOLABLE (041) ────────────────────────────────────────
ALTER TABLE journal_entries ENABLE ALWAYS TRIGGER journal_entries_posteado_inmutable;
ALTER TABLE journal_entries ENABLE ALWAYS TRIGGER journal_entries_sin_truncate;
ALTER TABLE journal_entry_lines ENABLE ALWAYS TRIGGER journal_entry_lines_posteada_inmutable;
ALTER TABLE journal_entry_lines ENABLE ALWAYS TRIGGER journal_entry_lines_sin_truncate;

COMMENT ON TRIGGER journal_entries_posteado_inmutable ON journal_entries IS
  'garantia-sellada: un asiento posteado no se edita; se corrige por reversa (NIF B-1).';
COMMENT ON TRIGGER journal_entries_sin_truncate ON journal_entries IS
  'garantia-sellada: TRUNCATE no vacía el mayor.';
COMMENT ON TRIGGER journal_entry_lines_posteada_inmutable ON journal_entry_lines IS
  'garantia-sellada: una línea posteada sólo admite el sello de conciliación (is_reconciled, reconciled_at, reconciliation_id).';
COMMENT ON TRIGGER journal_entry_lines_sin_truncate ON journal_entry_lines IS
  'garantia-sellada: TRUNCATE no vacía las líneas del mayor.';

-- ── 4. EL HASH QUE NO SE FALSIFICA (051) ────────────────────────────────
--
-- Va aquí y no en la lista de «funcionales» a propósito: banking.md le promete
-- al agente que cada línea del extracto se deduplica «por un hash que calcula
-- la BASE; no puedes forjar ninguno de los dos». Esa promesa la sostiene este
-- disparador y nada más. Apagarlo permite inyectar un content_hash falso y
-- colar dos veces el mismo movimiento.
ALTER TABLE bank_transactions ENABLE ALWAYS TRIGGER bank_transactions_content_hash;

COMMENT ON TRIGGER bank_transactions_content_hash ON bank_transactions IS
  'garantia-sellada: el hash de contenido lo calcula la base ignorando lo que mande el llamador; es lo que hace imposible forjar la deduplicación.';
