# Auditoría de T1b «Que la actualización llegue» (WIT-01 crítico de #136)

**Objeto:** la reparación de T1 no alcanza a quien ya tenía la migración vieja
aplicada; y, encontrada de camino, una migración fusionada que impide
actualizar.
**Fecha:** 2026-09-07.
**Método:** reproducción en tres bancos independientes con el `migrate.ts`
VIEJO de verdad, panel de tres diseños para el defecto difícil con un
escéptico por diseño, y verificación propia de cada conclusión.

## El hallazgo del Testigo era correcto, y su alcance es la mitad

T1 (#136) reparó tres defectos **editando en su sitio** la 051 y la 060, que ya
estaban distribuidas. `migrate.ts` omite por NOMBRE de archivo y
`public.migrations` no guarda checksum: donde la vieja quedó registrada, la
reparada no corre jamás. Medido: sobre esa base, el corredor de hoy dice
`Skipping 051_la_cuenta_y_el_extracto.sql (already executed)` y sigue.

Pero eso sólo vale si la vieja **llegó a registrarse**, y ahí el mapa cambia:

| Escenario | Qué pasaba | ¿Necesita remedio? |
|---|---|---|
| 051 vieja con filas en `bank_transactions` | aborta con `23502` (su relleno no disparaba nada y el `SET NOT NULL` veía los NULL) | **No**: no se registra, y la reparada corre sola |
| 051 vieja con la tabla **vacía** | **registra** | **Sí** — es toda la población |
| 060 vieja, con políticas | aborta con `42501`, con filas **o sin ellas** | **No** |
| 060 vieja, primera corrida de instalación nueva | registra, pero `ai_ingest_runs` estaba vacía | **No** |

La razón por la que la mitad se cura sola cabe en una línea: `migrate.ts:63`
pone `SET row_security = off`, y eso convierte el filtrado silencioso en un
`42501` ruidoso. **Una migración que aborta no se registra, y lo que no se
registra se reintenta.** Ese `SET` es lo que separa «aborta y se cura» de
«registra y miente».

Un remedio para la 060 no encontraría a quién reparar, y un remedio que no
repara nada es peor que ninguno. No se escribe.

## Lo que le queda a la población afectada

Tres residuos, medidos sobre una base montada con la 051 PRE-T1 real
(`git show 0d4494f^`):

1. **El disparador no vigila `content_hash`.** `UPDATE bank_transactions SET
   content_hash = repeat('f',64)` **se queda**. La huella se forja — y la 058
   **selló** esa garantía, así que `doctor` la da por buena y `banking.md` se la
   promete al agente. Una garantía sellada y falsa es peor que ausente.
2. **El índice es ÚNICO.** Dos comisiones de manejo de −50.00 el mismo día son
   dos hechos; la huella se calcula sobre (cuenta|fecha|importe|descripción),
   donde no hay nada que los distinga. Por la vía real —`insertarLineas`, con
   `ON CONFLICT DO NOTHING` sin blanco— la segunda **no entra y no falla**: los
   libros dicen −50.00 donde el banco cobró −100.00, y el sistema reporta «1
   duplicada» **acusando al banco**.
3. **El comentario de columna** sigue afirmando la garantía que T1 desmintió.

## La regresión que apareció de camino, y que es más urgente

**La migración 071 —fusionada en #176— impide actualizar cualquier despacho
instalado.** Como `mnemosine_owner` (NOBYPASSRLS) con las políticas aplicadas y
`row_security = off`, su `CREATE MATERIALIZED VIEW mv_trial_balance AS SELECT …
FROM accounts` aborta con `42501 · query would be affected by row-level security
policy for table "accounts"`.

No se ve en instalación nueva —`rls-policies.sql` corre en el `finally`, después—
y por eso **CI tampoco la ve**: su base nace sin políticas. Mi primer banco dijo
que estaba bien porque lo monté como `victor`, que es superusuario e ignora la
RLS: el mismo error que la auditoría de T1 documenta, cometido otra vez.

Se repara **en su sitio**, y aquí eso es lo correcto y no una recaída: nadie que
necesite el arreglo la tiene registrada (aborta antes de anotarse), y quien la
tiene registrada —la instalación nueva— la aplicó bien. El archivo declara
ahora, con tres guardas medidas, cómo sobrevive al piso:

1. quien ya ignora la RLS (superusuario o BYPASSRLS) no cambia de traje;
2. si aún no hay políticas sobre las cuatro tablas base, tampoco hace falta;
3. y sólo entonces se viste de `mnemosine_refresher` —el rol que existe
   precisamente porque una materializada tiene por contrato que ver el clúster
   entero— o **se para** con un mensaje que dice qué correr.

Las salidas falsas quedaron descartadas midiendo: `SET LOCAL row_security = on`
**no falla, deja la vista VACÍA** (0 filas sin inquilino, 3 de 6 con uno), y
quitar `FORCE` a las cuatro tablas es desarmar el aislamiento para arreglar un
informe.

## Lo entregado

- **`072_la_huella_que_se_podia_forjar.sql`** — el remedio, por archivo nuevo.
  Censo contra el catálogo (no contra el repositorio), sustitución del índice,
  disparador recreado **reponiendo el `ENABLE ALWAYS` y el comentario de la
  058**, comentario de columna, y comprobación de huellas por inquilino con
  `SET LOCAL row_security = on`. Idempotente e inocua sobre una base sana.
- **La 071, reparada en su sitio.**
- **`checkExtractosCompletos`** en `doctor`: el canal que faltaba. La migración
  no puede devolver las líneas que el índice ya se tragó —reimportar lo bloquea
  `UNIQUE(bank_account_id, file_sha256)`—, así que las **nombra**, comparando
  `line_count` contra lo presente. Un WARNING de `npm run migrate` no vale: el
  corredor no registra escucha de avisos y los descarta.
- **Dos criterios en E0.2**, uno de ellos el que habría cazado la 071: toda
  migración que recree una vista materializada declara cómo sobrevive al piso.
- **`tests/integration/migracion-072-remedio-051.int.spec.ts`**, cinco casos.

## La trampa que el panel midió y un remedio ingenuo pisa

`CREATE OR REPLACE TRIGGER` **degrada `tgenabled` de 'A' a 'O' en silencio y
conserva el comentario**: dejaría el sello «garantia-sellada: … imposible forjar
la deduplicación» colgado de un disparador que vuelve a poder apagarse con
`session_replication_role = replica`, que es literalmente lo que la 058 vino a
impedir. Y `DROP` + `CREATE` pierde las dos cosas. El remedio hace las tres:
recrea, vuelve a sellar y vuelve a comentar. El criterio lo prohíbe por nombre.

## Que la prueba muerde: medido

| Neutralización de la 072 | Resultado |
|---|---|
| el índice único se queda | **2 de 5 en rojo** |
| no se repone el `ENABLE ALWAYS` | 1 en rojo |
| se pierde el comentario del sello | 1 en rojo |
| no se comprueban las huellas | 1 en rojo |
| sin tocar nada | 5 en verde |

## Dos veces el mismo error, en el mismo tramo

Los dos criterios nuevos nacieron **verdes por accidente**: la prosa que
explicaba el ancla la contenía. El que prohíbe `CREATE OR REPLACE TRIGGER` se
disparó contra su propio comentario, y el que exige el cambio de rol lo
encontró en una tabla de mediciones comentada dentro de la 071. Se cerró con
`sinProsa()`: un criterio que pregunta qué **hace** un `.sql` lee el SQL, no la
prosa que lo rodea. Es la misma familia que la lección `_f05d` del piso — un
ancla de presencia caduca en cuanto alguien escribe cerca.

## Lo que no se hizo, y por qué

- **Nada para la 060**, por lo dicho arriba.
- **No se recuperan las líneas tragadas.** No están en la base y reimportar el
  archivo está bloqueado. El remedio devuelve la capacidad; el dato lo tiene que
  reimportar el despacho, y `doctor` le dice cuáles.
- **La causa raíz sigue en pie**: `migrate.ts` omite por nombre y `migrations`
  no guarda checksum, así que la próxima edición en sitio volverá a pasar
  inadvertida. Un checksum por archivo es un tramo propio, y esta auditoría lo
  deja pedido.
