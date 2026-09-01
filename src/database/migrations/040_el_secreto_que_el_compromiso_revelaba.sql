-- ============================================================
-- 040: EL SECRETO QUE EL COMPROMISO REVELABA
--
-- El range proof de las atestaciones es un placeholder (no hay circuito ZK
-- real todavía), y el placeholder incluía dos claves de depuración —
-- `_test_value` y `_test_bf` — bajo el comentario «DO NOT store the value in
-- a real proof». Se almacenaban de todos modos: el orquestador persistía el
-- blob entero en `blockchain_attestations.range_proof`, y el cliente
-- simulado de zkVerify lo ecoaba a `zkverify_proof`. Un compromiso cuya
-- garantía vendida es «prueba el rango SIN revelar el importe» llevaba
-- dentro el importe Y el blinding factor con el que abrirlo.
--
-- La tarea E1.4-a del plan de cierre lo ordenaba y se cayó de la herencia;
-- la auditoría integral del 2026-08-31 la rescató (S1). El código ya no
-- escribe las claves (crypto-service.ts, mismo commit); esta migración purga
-- las filas ya escritas. Se anulan los DOS blobs completos —no sólo las
-- claves— porque un placeholder sin circuito no prueba nada que valga la
-- pena conservar, y editar JSON dentro de BYTEA a mano es exactamente el
-- tipo de cirugía que deja residuos.
--
-- Mitigante histórico: /public/v1 está apagado por omisión, así que los
-- blobs nunca se sirvieron fuera. El punto no es la exposición pasada sino
-- la promesa: desde esta migración, lo persistido no contradice lo vendido.
-- ============================================================

UPDATE blockchain_attestations
   SET range_proof = NULL
 WHERE range_proof IS NOT NULL
   AND position('\x5f746573745f76616c7565'::bytea in range_proof) > 0; -- '_test_value'

UPDATE blockchain_attestations
   SET zkverify_proof = NULL
 WHERE zkverify_proof IS NOT NULL
   AND position('\x5f746573745f76616c7565'::bytea in zkverify_proof) > 0;

COMMENT ON COLUMN blockchain_attestations.range_proof IS
  'Blob del range proof. Desde la 040 no puede contener el valor ni el blinding '
  'factor (el placeholder los incluía y la migración purgó las filas escritas); '
  'un criterio del plan vigila el generador.';
