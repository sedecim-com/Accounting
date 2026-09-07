-- ============================================================
-- 069 · EL PREDICADO QUE SE PAGA POR FILA (E1a)
--
-- `app_current_tenant()` la evalúa CADA POLÍTICA de aislamiento, y las
-- políticas se evalúan UNA VEZ POR FILA. Es, con diferencia, la función más
-- llamada de este esquema: cualquier consulta que toque el mayor la ejecuta
-- tantas veces como líneas mire.
--
-- Y no se puede insertar en línea. La cláusula `SET search_path` impide a
-- PostgreSQL hacerle inline, así que cada evaluación paga un marco de función
-- de PL/pgSQL entero. Medido sobre 800 000 filas con recorrido secuencial
-- forzado (E1·recon, informe en docs/auditorias/E1a.md):
--
--     literal '1111…'::uuid                          61 ms   0.08 µs/fila
--     app_current_tenant() (plpgsql + SET)        1 442 ms   1.73 µs/fila
--     LANGUAGE sql CON SET search_path            1 162 ms   1.40 µs/fila
--     LANGUAGE sql SIN SET (inlineable)             252 ms   0.31 µs/fila
--
-- **5.7× más barato**, y lo cobra TODO el sistema: es el coste que paga hoy
-- cada balanza, cada estado financiero y cada consulta del agente.
--
-- Re-medido al aplicar esta migración, sobre base virgen y la misma tabla:
-- 1 447 ms → 237 ms (mediana de 5), **6.1×**. Y la prueba del mecanismo no es
-- el cronómetro sino el plan, que deja de decir `Filter: … app_current_tenant()`
-- y pasa a decir `Filter: … (NULLIF(current_setting(…)))::uuid`: el cuerpo,
-- expandido, sin llamada que pagar.
--
-- ── LO QUE SE PIERDE, DICHO ANTES DE PERDERLO ───────────────────────────
--
-- La versión de PL/pgSQL trae `EXCEPTION WHEN others THEN RETURN NULL`, y
-- `LANGUAGE sql` no tiene excepciones. Con este cambio, un valor MAL FORMADO
-- en `app.current_tenant` deja de devolver NULL y pasa a LANZAR.
--
-- Se hace a propósito, y mejora el contrato en vez de degradarlo:
--
--   · Las dos formas son fail-closed. Ni la vieja ni la nueva devuelven
--     filas ante un contexto inválido; la vieja no devuelve NINGUNA, la
--     nueva no llega a devolver nada porque revienta.
--   · La diferencia es quién se entera. El GUC lo escribe NUESTRO código, y
--     SIEMPRE desde una columna `uuid` propia: `applyTenant` recibe el
--     `tenant_id` del payload, que `provisioning.ts` resuelve contra la tabla
--     `users` —ni siquiera en la ruta del IdP externo se usa la reclamación
--     cruda—, y las migraciones lo escriben con `t.id::text`. Un valor mal
--     formado ahí es, por construcción, un defecto nuestro. Hoy se traga en silencio y el llamador ve «no hay datos» —
--     indistinguible de «este inquilino no tiene datos», que es la clase de
--     silencio que este proyecto lleva un mes cazando en otras formas.
--   · Un contexto AUSENTE sigue devolviendo NULL sin ruido, que es el caso
--     legítimo y frecuente (`nullif(…, '')`). Sólo revienta lo que nunca
--     debería existir.
--
-- ── Y LA PROTECCIÓN DE `search_path` NO SE PIERDE ───────────────────────
--
-- Quitar la cláusula deja la función expuesta a que alguien anteponga un
-- esquema con objetos propios… salvo que esté cualificado TODO LO QUE SE
-- RESUELVE POR NOMBRE, que es lo que se hace aquí: la función
-- `pg_catalog.current_setting` y el tipo `pg_catalog.uuid` del cast.
--
-- `nullif` va sin cualificar porque NO SE PUEDE cualificar: no es una
-- función, es gramática. El analizador lo convierte en un `NullIfExpr`
-- —igual que `coalesce`, `greatest`, `least` o `case`— y no tiene entrada en
-- `pg_proc`. Por eso mismo tampoco hay nada que secuestrar: nunca se resuelve
-- por nombre. Escribirlo `pg_catalog.nullif` no era más seguro; era un error
-- de sintaxis, y lo cazó aplicar esta migración sobre una base virgen.
-- ============================================================

CREATE OR REPLACE FUNCTION public.app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE
AS $fn$
  SELECT nullif(
           pg_catalog.current_setting('app.current_tenant', true), ''
         )::pg_catalog.uuid
$fn$;

COMMENT ON FUNCTION public.app_current_tenant() IS
  'Inquilino del contexto de sesión (SET LOCAL app.current_tenant). Sin contexto devuelve NULL y las políticas no dan filas. INLINEABLE a propósito (069): la evalúa cada política una vez por fila, y la cláusula SET search_path que tenía la volvía unas 6 veces más cara (1 447 ms -> 237 ms sobre 800 000 filas). Todo lo que se resuelve por nombre va cualificado con pg_catalog para no perder esa protección; nullif no, porque es gramática y no función: no se resuelve por nombre y cualificarlo es un error de sintaxis. Un valor MAL FORMADO ahora lanza en vez de callar: lo escribe nuestro propio código, así que es un defecto nuestro y merece ruido.';
