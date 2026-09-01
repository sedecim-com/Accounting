-- ============================================================
-- 036: EL REP SE LIGA AL PAGO QUE DOCUMENTA
--
-- Un CFDI tipo P —el REP, complemento de pagos— dice que un dinero se movió
-- y contra qué facturas se aplicó. El sistema no tenía dónde anotar que ESE
-- REP corresponde a ESE pago, y esa ausencia es la que abre el agujero:
-- sin ella no se puede responder «¿este comprobante ya está registrado?»,
-- así que ingerirlo abona el banco por segunda vez cuando el pago también se
-- capturó a mano.
--
-- Se resuelve con una columna, no con una tabla puente, porque la relación
-- que importa es de uno a uno: un nodo `Pago` del complemento es un
-- movimiento de banco, y un movimiento de banco es una fila de pago. El
-- reparto contra documentos ya vive donde debe —payment_applications y
-- payment_allocations—, que es justo lo que lee `ivaReclassLines` para
-- liberar el IVA. Escribiendo el pago por la puerta que ya existe, la
-- liberación del impuesto sale gratis y en la misma póliza.
--
-- La unicidad es POR ENTIDAD y parcial. Por entidad porque dos entidades del
-- mismo despacho pueden aparecer en el mismo REP —una como emisora y otra
-- como receptora— y cada una lo contabiliza en sus propios libros. Parcial
-- porque casi todos los pagos son capturados a mano y no tienen REP: un
-- índice único sin el WHERE los haría chocar entre sí en NULL en algunos
-- motores y, sobre todo, no expresa la regla que se quiere.
--
-- Un REP con varios nodos `Pago` produce varias filas de pago, y cada una
-- lleva su índice dentro del comprobante: sin él, el segundo pago del mismo
-- REP chocaría contra el primero.
-- ============================================================

ALTER TABLE vendor_payments
  ADD COLUMN IF NOT EXISTS cfdi_uuid VARCHAR(50),
  ADD COLUMN IF NOT EXISTS cfdi_pago_indice SMALLINT;

ALTER TABLE customer_payments
  ADD COLUMN IF NOT EXISTS cfdi_uuid VARCHAR(50),
  ADD COLUMN IF NOT EXISTS cfdi_pago_indice SMALLINT;

COMMENT ON COLUMN vendor_payments.cfdi_uuid IS
  'UUID del CFDI tipo P (REP) que documenta este pago, cuando existe. NULL en los pagos capturados a mano y en los que aún no han recibido su REP del proveedor.';
COMMENT ON COLUMN vendor_payments.cfdi_pago_indice IS
  'Índice del nodo Pago dentro del complemento (0-based). Un REP puede documentar varios movimientos de banco.';
COMMENT ON COLUMN customer_payments.cfdi_uuid IS
  'UUID del CFDI tipo P (REP) emitido por esta entidad que documenta este cobro, cuando existe.';
COMMENT ON COLUMN customer_payments.cfdi_pago_indice IS
  'Índice del nodo Pago dentro del complemento (0-based).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_payments_rep
  ON vendor_payments (entity_id, cfdi_uuid, cfdi_pago_indice)
  WHERE cfdi_uuid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_payments_rep
  ON customer_payments (entity_id, cfdi_uuid, cfdi_pago_indice)
  WHERE cfdi_uuid IS NOT NULL;

-- Y la búsqueda inversa, que es la que corre en cada ingesta: «¿hay ya un
-- pago para este comprobante?». Va por el mismo índice único.
