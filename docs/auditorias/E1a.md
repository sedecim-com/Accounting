# Auditoría adversarial de E1a «El predicado que se paga por fila»

**Objeto:** la migración 069, que reescribe `app_current_tenant()` para que
PostgreSQL pueda insertarla en línea.
**Fecha:** 2026-09-06.
**Método:** reconocimiento medido en clúster propio → re-medición
independiente al aplicarla → verificación adversarial de lo que el cambio
PIERDE, hecha trazando llamadores en vez de argumentando.

## De dónde salió: el tramo era otro

E1 estaba en el plan como «denormalizar `tenant_id` en 20 tablas hijas para que
las políticas de RLS no crucen a la tabla padre», con una ganancia estimada de
840 ms → 193 ms. El reconocimiento fue a medir eso, y midió otra cosa
(ver «Lo que E1b NO justifica», al final).

De paso encontró esto, que no estaba en la lista de nadie —
`014_rls_tenant_isolation.sql:26-41`:

```sql
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $$ ... EXCEPTION WHEN others THEN RETURN NULL; END; $$;
```

`app_current_tenant()` la evalúa **cada política de aislamiento**, y una
política se evalúa **una vez por fila**. Es, con diferencia, la función más
llamada de este esquema. Y la cláusula `SET search_path` **impide el inline**:
cada fila paga un marco de PL/pgSQL entero.

## La medición

Tabla de 800 000 filas, recorrido secuencial, el qual con la forma que tiene
una política real (`t = app_current_tenant()`, con `Var`, porque un qual **sin**
`Var` el planificador lo marca pseudoconstante y lo evalúa **una sola vez** —
medirlo así habría medido otra cosa):

| versión | plan | mediana de 5 | por fila |
|---|---|---|---|
| `plpgsql` + `SET search_path` | `Filter: … app_current_tenant()` | 1 447 ms | 1.81 µs |
| `LANGUAGE sql`, sin `SET` | `Filter: … (NULLIF(current_setting(…)))::uuid` | **237 ms** | 0.30 µs |

**6.1×**, en una línea, y lo cobra todo el sistema: cada balanza, cada estado
financiero, cada consulta del agente.

La prueba del mecanismo no es el cronómetro sino **el plan**. Deja de nombrar
la función y pasa a mostrar su cuerpo expandido: eso es el inline, visible.

## El error que sólo una base virgen podía encontrar

La primera versión cualificaba todo con `pg_catalog` —para no perder lo que
`SET search_path` daba— e incluía `pg_catalog.nullif(...)`. Sobre la base de
desarrollo no llegó a ejecutarse. Sobre una base virgen:

```
ERROR: function pg_catalog.nullif(text, unknown) does not exist
```

`NULLIF` **no es una función**: es gramática. El analizador lo convierte en un
`NullIfExpr` —igual que `COALESCE`, `GREATEST`, `LEAST` o `CASE`— y no tiene
entrada en `pg_proc`, así que no admite calificación. Por eso mismo **tampoco
es secuestrable**: nunca se resuelve por nombre. Lo que sí se resuelve por
nombre, y por tanto sí va cualificado, es la función `current_setting` y el
**tipo** `uuid` del cast.

Lección de método, no de SQL: la base de desarrollo tenía historia; la virgen
no. El defecto vivía exactamente en la diferencia.

## Lo que el cambio pierde, y por qué se acepta

`LANGUAGE sql` no tiene excepciones, así que se pierde el
`EXCEPTION WHEN others THEN RETURN NULL`. Un valor **mal formado** en
`app.current_tenant` deja de devolver `NULL` y pasa a **lanzar**.

Las dos formas son fail-closed —ninguna devuelve filas ante un contexto
inválido—. La diferencia es **quién se entera**. Y la pregunta adversarial es
si algo externo puede provocar ese lanzamiento. Trazado, no argumentado:

| escritor de `app.current_tenant` | origen del valor |
|---|---|
| `connection.ts:209` (`applyTenant`) | `payload.tenant_id` del JWT **verificado** |
| ↳ y ese payload, en la ruta del IdP externo | `provisioning.ts:87`, resuelto contra la columna `uuid` de `users` — **no** la reclamación cruda del IdP |
| `ai-webhooks.ts:135` | `token.tenant_id`, columna `uuid` |
| migraciones 025, 026, 051 | `t.id::text` |

**Todos** toman el valor de una columna `uuid` propia. Un valor mal formado es,
por construcción, un defecto nuestro — y hoy se traga en silencio, dejando al
llamador un «no hay datos» indistinguible de «este inquilino no tiene datos»,
que es la clase de silencio que este proyecto lleva un mes cazando en otras
formas. Un contexto **ausente** sigue devolviendo `NULL` sin ruido, que es el
caso legítimo y frecuente.

## La tercera opción, descartada por la medida

Antes de aceptar el cambio de conducta se midió una variante que lo evitaba:
`LANGUAGE sql` (inlineable) **conservando** el NULL, con una guarda de forma
en vez de una excepción:

```sql
SELECT CASE WHEN current_setting(…) ~ '^[0-9a-fA-F]{8}-…$'
            THEN current_setting(…)::uuid END
```

Sobre la misma tabla de 800 000 filas: **2 257 ms**. Es decir, **peor que la
versión vieja** (1 447 ms). Dos `current_setting` y una expresión regular por
fila cuestan más que el marco de PL/pgSQL que se quería evitar. PostgreSQL 15
no tiene `pg_input_is_valid` (llegó en la 16), así que no hay variante barata.

La opción queda descartada por la medición, no por el argumento.

## Lo que la suite de integración dijo, y por qué se cambió una prueba

`tenant-isolation.int.spec.ts` tenía una prueba —«un contexto con basura
tampoco abre la puerta»— que se puso **roja**: afirmaba `rowCount === 0`, y
ahora la consulta es rechazada.

Reescribir una prueba para que acepte un cambio es exactamente como se blanquea
una regresión, así que la reescritura tenía que ser **estrictamente igual de
fuerte** en lo que importa. La prueba pasó a defender la PROPIEDAD —basura
nunca devuelve filas— en vez del MECANISMO —el silencio—, y admite las dos
vías de fail-closed. Lo que sigue sin admitir, que es para lo que existe, es
que la basura devuelva una sola fila. Si el cambio hubiera debilitado el
aislamiento, seguiría en rojo.

Y se añadió una prueba que antes no existía: **el contexto VACÍO es ausencia
de contexto, no un uuid inválido**. Las migraciones 025, 026 y 051 cierran su
bucle por inquilinos con `set_config('app.current_tenant', '', true)`, y
`''::uuid` lanza. Lo único que hay entre esas tres migraciones y un error es el
`nullif` — el mismo que no se puede cualificar. Nadie lo estaba nombrando.

Resultado: 87 archivos, 1 188 pruebas de integración en verde; 246 archivos,
5 235 unitarias; 120 mutantes, todos muertos.

## El criterio, y contra qué muerde

`E2.1 · El predicado que cobra cada política se inserta en línea, y sigue
cualificado sin la cláusula que lo impedía`.

No vigila la 069 por su nombre: vigila **quién define la función al final**,
recorriendo las migraciones en orden. La regresión que teme no es un borrado
sino un **reflejo de endurecimiento** — alguien que en la 07x le «devuelva» el
`SET search_path` por higiene. Eso no rompe ninguna prueba (la respuesta es
idéntica) y sólo se nota en la factura.

Cuatro espejos, los cuatro mueren:

1. `LANGUAGE sql` → `LANGUAGE plpgsql`.
2. Reponer `SET search_path` (el reflejo que el criterio existe para frenar).
3. Quitar la calificación de `current_setting` (la mitad **peligrosa** del
   cambio: sin la cláusula, un nombre sin cualificar sí es secuestrable).
4. Borrar la migración entera — y aquí el criterio debía dar **rojo**, no
   reventar: el overlay del arnés gobierna la existencia (`existe`) pero no
   `readdirSync`, así que la enumeración se filtra por `existe()`. «No pude
   mirar» no es «está mal», y el arnés distingue las dos suertes.

Y una trampa propia del archivo: `crudoDe` **no** quita comentarios, y la
cabecera de la 069 cita literalmente `LANGUAGE sql CON SET search_path` en su
tabla de mediciones. Un `/SET search_path/` sobre el archivo entero se habría
acusado a sí mismo; el criterio recorta el cuerpo de la función y juzga sólo
eso.

## Lo que E1b NO justifica, dicho con las cifras

El reconocimiento midió la propuesta original —denormalizar `tenant_id` en 20
tablas hijas— y **no la sostiene**:

- La ganancia real es **228 ms → 94 ms**, no 840 ms → 193 ms.
- La **balanza mensual regresa**: 3.99 ms → 7.40 ms (×1.9). Las columnas extra
  engordan la fila y el recorrido paga más páginas.
- Sólo **2 de las 20** tablas hijas (`journal_entry_lines`, `bank_transactions`)
  tienen siquiera disparadores bloqueantes.

Veinte migraciones, veinte backfills y veinte índices nuevos para eso, contra
una línea para 6.1×. E1b queda **sin justificar por la medida de hoy**; si
vuelve, que vuelva con una medición que lo sostenga.

## Estado de la base de desarrollo local (no es un defecto del repo)

`npm run migrate` contra `accounting_core` falla en la 060. **No es del repo**:
sobre base virgen las 69 migraciones se aplican limpias. Es que las
migraciones 060-066 se **renumeraron** después de aplicarse en esa base, y el
migrador lleva la cuenta por nombre de archivo:

| registrado en `migrations` | en disco hoy |
|---|---|
| `060_el_agrupador_con_una_sola_verdad.sql` | `063_el_agrupador_…` |
| `063_el_tercero_que_la_diot_declara.sql` | `066_el_tercero_…` |

Renombrar las filas sería mentir: el renumerado **también cambió contenido**
(`R086`). La salida limpia es recrear esa base, que es de pruebas. No se hace
aquí porque hay una sesión paralela trabajando contra ella.
