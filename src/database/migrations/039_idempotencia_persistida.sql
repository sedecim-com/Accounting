-- ============================================================
-- 039: LA LLAVE DE IDEMPOTENCIA POR FIN SE GUARDA
--
-- El núcleo del CLI inyecta --idempotency-key en todo comando irreversible o
-- externo desde que existe (risk.ts), y hasta hoy la bandera se aceptaba con
-- un aviso: «is accepted but not yet stored: nothing deduplicates on it».
-- Aceptar una llave que no protege nada es peor que no ofrecerla — el que la
-- teclea cree que su reintento es seguro. Esta tabla la vuelve verdadera.
--
-- QUÉ GARANTIZA Y QUÉ NO. La fila se escribe DESPUÉS de que el acto termina
-- bien: protege el reintento de un comando que YA terminó (el segundo intento
-- devuelve el resultado grabado en vez de repetir el acto), y detecta el
-- reuso de una llave con otra carga (payload_hash distinto → conflicto,
-- salida 6). NO protege un proceso muerto a la mitad: ahí no quedó llave, y
-- la defensa sigue siendo la de siempre — el estado del dominio (un asiento
-- ya posteado se rechaza por su propio estado). Se dice así de claro porque
-- la alternativa (reservar la llave ANTES de ejecutar) bloquearía el
-- reintento legítimo tras un crash, que es exactamente cuando más se
-- necesita.
--
-- La llave sólo actúa cuando el operador la PASA. No se autogenera de la
-- carga: dos corridas legítimamente idénticas (cerrar el mismo periodo tras
-- reabrirlo) no deben deduplicarse solas.
--
-- RLS: tenant_id NOT NULL, así que la política tenant_isolation generada en
-- src/database/rls-policies.sql (que migrate.ts aplica tras cada migración)
-- la cubre automáticamente. No es de sólo-agregar a propósito: purgar llaves
-- viejas es operación legítima, a diferencia de una bitácora.
-- ============================================================

CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  entity_id UUID REFERENCES legal_entities(id),
  scope VARCHAR(80) NOT NULL,
  clave VARCHAR(200) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  resultado JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_idempotency_keys UNIQUE (tenant_id, scope, clave)
);

COMMENT ON TABLE idempotency_keys IS
  'Llaves de --idempotency-key ya consumadas. Una fila = un acto irreversible '
  'terminado bajo esa llave; el reintento con la misma llave y la misma carga '
  'devuelve `resultado` sin repetir el acto, y con otra carga es conflicto (salida 6).';
COMMENT ON COLUMN idempotency_keys.scope IS
  'Comando que consumió la llave (p.ej. ''entry post'', ''close''). La unicidad es '
  'por (tenant, scope, clave): la misma llave en dos comandos distintos no choca.';
COMMENT ON COLUMN idempotency_keys.entity_id IS
  'Entidad del acto cuando la hubo; NULL para actos de despacho. Informativa: la '
  'unicidad es por tenant, no por entidad, porque la llave la elige el cliente.';
COMMENT ON COLUMN idempotency_keys.payload_hash IS
  'SHA-256 (hex) de la carga canónica del acto. Es lo que distingue «reintento '
  'idéntico» (se devuelve el resultado) de «llave reusada con otra carga» (conflicto).';
COMMENT ON COLUMN idempotency_keys.resultado IS
  'Resumen pequeño y serializable del acto (número de póliza, periodo cerrado…), '
  'lo justo para que el reintento pueda repetir la respuesta.';
