-- ============================================================
-- 061 · QUIÉN FIRMA, Y QUIÉN SÓLO MIRA (G3)
--
-- Dos huecos que el argumento de venta del producto no puede permitirse, y
-- que sólo el esquema puede cerrar:
--
--   1. La prueba pública de anclaje se sirve SIN decir que es simulada.
--   2. Dar acceso a un auditor externo es darle credenciales de ESCRITURA
--      sobre los libros, porque no existe un rol que sólo mire.
-- ============================================================

-- ── 1. UN ANCLAJE SIMULADO SE DECLARA SIMULADO ──────────────────────────
--
-- `bitcoin_anchors` guarda el resultado de anclar un lote de asientos en
-- cadena. Hoy el txid se fabrica localmente y se sirve con enlace a un
-- explorador público, que es la forma más cara de mentir: quien lo abra verá
-- que no existe, y para entonces ya lo enseñó a un tercero.
--
-- La columna nace `true` y NOT NULL a propósito. Todo lo anclado hasta hoy es
-- simulado, y el defecto para lo que venga tiene que ser el conservador: un
-- anclaje que se afirma real debe DECIRLO explícitamente al escribirse, no
-- heredarlo de un DEFAULT. La regla de la casa —un simulador jamás se
-- disfraza de real— pasa a estar en la tabla y no sólo en el código, que es
-- donde alguien puede olvidarla.
ALTER TABLE bitcoin_anchors
    ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN bitcoin_anchors.is_simulated IS
  'Si el anclaje se fabricó localmente en vez de emitirse a la cadena. Nace true y el defecto es true: lo real se declara, lo simulado se hereda. Ninguna superficie pública puede servir una prueba sin leer esta columna.';

-- ── 2. EL AUDITOR QUE SÓLO MIRA: POR QUÉ NO ESTÁ AQUÍ ───────────────────
--
-- La primera versión de esta migración creaba el rol `mnemosine_auditor` y le
-- daba SELECT. Falla, y la falla es correcta:
--
--   permission denied to create role
--
-- El migrador NO es superusuario ni tiene CREATEROLE, y eso es deliberado
-- desde S3: el mismo acotamiento que impide que una migración se salte la RLS
-- impide que se conceda permisos a sí misma. Un rol de Postgres es del
-- CLÚSTER, no de la base; crearlo desde aquí exigiría un migrador con más
-- poder del que ninguna migración necesita.
--
-- Tampoco se hace tolerante —«si puedo lo creo, si no sigo»—: una garantía que
-- unas veces está y otras no, sin que nadie lo sepa, es peor que no tenerla.
--
-- Así que el rol lo crea quien OPERA el clúster, con `scripts/rol-auditor.sql`,
-- y `mnemosine doctor` comprueba si está puesto y lo dice. Es el patrón que la
-- 058 estrenó con el sello de las garantías: el sistema no asume sus defensas,
-- las mira.
