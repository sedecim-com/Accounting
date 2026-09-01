-- ============================================================
-- 050 · PAGAR (F04)
--
-- Una sola columna, y la razón por la que va sola.
--
-- EL IVA QUE LIBERA UNA APLICACIÓN, GUARDADO AL APLICAR. Un gasto PPD aparca
-- su IVA acreditable en 1135 y sólo lo pasa a 1130 cuando se paga. Cuando el
-- pago se aplica DESPUÉS (el evento `payment apply`), la liberación se calcula
-- con el contexto de ese momento: la tasa del gasto, lo ya aplicado, el tope
-- de lo aparcado. Ese número hay que ESCRIBIRLO, no volver a derivarlo: el día
-- que la aplicación se deshaga, re-derivarlo bajo otro contexto —otra tasa
-- vigente, otras aplicaciones intermedias— devolvería una cifra distinta de la
-- que se liberó, y el 1135 quedaría con un residuo que nadie sabría explicar.
-- Es la misma lección que la 049 aprendió del lado del cobro, y la columna se
-- llama igual a propósito.
--
-- POR QUÉ NO VIENEN AQUÍ unapplied_at, unapplied_by NI unapply_reason. El
-- espejo completo de payment_allocations las tendría. Pero `payment unapply`
-- y `payment void` son de la fase 2 del catálogo, y una columna que ningún
-- código escribe es capacidad declarada sin entregar — exactamente lo que el
-- `doctor` marca como huérfana. La clausura de una aplicación de pago llegará
-- en la migración que traiga el comando que la clausura, no antes.
--
-- Consecuencia deliberada mientras tanto: las sumas de payment_applications
-- NO filtran por `unapplied_at IS NULL`, porque no hay nada que filtrar. Son
-- TRES sitios, no dos —la primera versión de este encabezado contaba dos y se
-- dejaba el de applyVendorPayment, que es el que alimenta el objetivo
-- acumulado del IVA y por tanto el que peor derivaría—:
--
--   · ar-ap-posting.ts, postVendorPaymentEntry      (SUM por payment_id)
--   · payment-service.ts, remanenteDeVendorPago     (SUM por payment_id)
--   · payment-service.ts, applyVendorPayment        (SUM por bill_id)
--
-- La fase 2 tiene que añadir el filtro en los tres el mismo día que añada la
-- columna. Están anotados en docs/migraciones.md, «Migraciones deliberadamente
-- incompletas», que es donde una auditoría los va a buscar.
-- ============================================================

ALTER TABLE payment_applications
    ADD COLUMN iva_reclass_amount DECIMAL(19,4);

COMMENT ON COLUMN payment_applications.iva_reclass_amount IS
  'IVA acreditable que ESTA aplicación movió de 1135 (pendiente de acreditar) a 1130 (acreditable), guardado en el momento de aplicar para poder deshacerlo exacto. NULL en aplicaciones nacidas con el pago (su IVA va en el asiento del pago) y en gastos PUE, que nunca aparcan.';
