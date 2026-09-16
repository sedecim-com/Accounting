# Historial de entrega

Este documento reconstruye, **verificado contra `git log` y contra `gh pr view` línea por línea** (no contra la prosa de artefactos anteriores), qué se entregó y en qué PR aterrizó. La lección que obligó a este método: el artefacto "Plan de cierre" citaba commits de un "Sprint 1" y un "Sprint 2" —IVA-1, IVA-2, IVA-3, AUD-1, ESQ-1, HON-1, TEN-1, E1.1-a, E1.1-b, E2.2, E1.4-b, AUD-3— y **ninguno de esos hashes existe hoy en `main`**: el trabajo real se hizo por otro camino (una segunda sesión de agente trabajando en paralelo) y quedó documentado bajo otros nombres. Confiar en la narrativa de un artefacto sin volver a verificarla contra el árbol real habría fabricado un historial falso.

**Cómo se construyó esta tabla:** `git log --first-parent origin/main` da la columna vertebral de merges; para cada commit de dos padres se calculó `git log <primer-padre>..<segundo-padre>` para obtener exactamente los commits que ese merge introdujo (no los que la rama de origen *dice* tener en la API de PRs, que puede incluir commits ya fusionados por otro camino). Resultado: 191 commits, cada uno asignado a **exactamente un** PR — verificado, cero duplicados. El método tiene una consecuencia que conviene decir: un PR mergeado hacia una rama que NO es `main` aparece con **cero commits propios**, aunque su contenido sí haya llegado — a través del squash de otro PR. Es exactamente el caso del #54 (A5): se mergeó hacia `sux/segundo-lote` a las 02:50Z del 2026-09-03 y catorce minutos después el #52, cuya rama de origen era esa misma, se squasheó hacia `main` como `d8882d5`. Los árboles de `main` y `sux/segundo-lote` son idénticos (`git diff --quiet` no devuelve nada): A5 está entregado, dentro del #52.

**Y el método tiene una segunda consecuencia, que apareció después.** Desde el #55 el repositorio fusiona **casi siempre** por squash: el PR entero llega a `main` como UN commit, y «los commits que ese merge introdujo» vale uno por construcción, diga lo que diga la rama. Por eso, de la sección «Después de los sprints» en adelante, la columna *Notas* da el hash del squash y **cuántos commits traía la rama** —que es otra medida, no la misma— y avisa cuando esa cifra está inflada porque la rama arrastraba commits de un PR anterior (el caso del #135).

«Casi siempre», y la palabra se ganó a pulso. Este documento afirmó durante semanas que **el #53 fue el último PR con commit de fusión propio**, y era falso: al reconstruir la semana del 9 al 16 de septiembre salieron **seis más** —#182, #191, #195, #198, #213 y #228, toda la serie del idioma—, cada uno con sus dos padres en `git rev-list --parents`. Nadie los había mirado porque la frase de arriba decía que no hacía falta. Para esos seis vuelve a valer el método de los dos padres, y su cuenta coincide con la que reporta la rama; sus filas dicen «fusión» y no «squash», que es la única manera de que la diferencia se vea sin volver a preguntárselo a `git`.

**Y una tercera, que es la razón de que exista un guardián.** Este documento se reconstruyó una vez contra el árbol, quedó bien, y volvió a caducar por la única vía que quedaba: nadie lo miró. Medido el 2026-09-08 afirmaba que el **#53 estaba abierto** —llevaba fusionado desde el día anterior— y no nombraba los dieciséis PRs siguientes. La reparación no es volver a reconstruirlo a mano, que es exactamente lo que ya se hizo y duró dos días: es [`scripts/historial-estado.ts`](../scripts/historial-estado.ts), que CI corre con `--check` y que **falla cuando un PR lleva más de siete días fusionado sin aparecer aquí**. La semana de gracia no es indulgencia: CI corre sobre la punta de `main`, así que exigir la fila el mismo día pondría en rojo todos los demás PRs abiertos —había dieciocho— hasta que alguien la escribiera, y una compuerta que rompe el trabajo ajeno acaba desactivada. Con gracia el documento puede ir detrás de la ráfaga del día; con techo, no puede pudrirse. No juzga las filas —a qué sprint pertenece cada PR, qué tramos incluye, qué nota merece, sigue siendo humano y sigue escrito a mano—; sólo impide que falte una, que es el modo exacto en que se estropeó.

<!-- HISTORIAL-GENERADO:INICIO -->

**Censo, medido sobre el árbol** (`npm run historial:estado`):

- **102** PRs registrados aquí.
- El más alto registrado es el **#252**.
- **13** commits directos a `main`, de antes del flujo por PR (la fila «—» del Sprint 1).

CI lo verifica con `--check`, que falla cuando un PR lleva más de **7 días** fusionado sin aparecer aquí. La gracia existe para que una fusión no ponga en rojo los demás PRs abiertos; el techo, para que el documento no pueda pudrirse.

<!-- HISTORIAL-GENERADO:FIN -->

Fuente de todas las filas: **inferido por fecha y por commit** (no hay un artefacto previo cuyas etiquetas de sprint sobrevivieran la verificación). Los "tramos" (códigos como `S0.1`, `F03`, `R4`, `A7`) sí son reales: son los nombres que el propio autor le dio a cada commit, y siguen la convención de `CONTRIBUTING.md` ("el asunto lleva el código del paquete").

## Sprint 1 — Fase 0-1: el motor contable completo
Fuente: inferido (fechas + verificación de commits contra `git log`)
Ventana: 2026-08-25 → 2026-08-31
Objetivo: Levantar el motor contable de partida doble, el mayor inviolable, el instrumento de plan ejecutable, y la primera pasada de auditoría sobre el árbol.
Milestone: `Sprint 1 · Fase 0-1: el motor contable completo` (cerrado)

| PR | Título | Merge | Tramos que incluye | Notas |
|---|---|---|---|---|
| — | *(commits directos a `main`, antes del flujo por PR)* | 2026-08-25 | E1.2-b, E1.2-a, E0.3, E2.1-a, E3.1-a, E0.2 | 13 commits: la línea base del sistema. |
| [#1](https://github.com/sedecim-com/Accounting/pull/1) | Fase 0–1: CLI contable, IVA sobre base de flujo, perímetro por entidad y un plan que se pregunta | 2026-09-01 | R2, R1, S1, S0.7, S0.6, S0.5, S0.3, S0.2, AUD-6, S0.4, S0.1, AUD-5, CAT-3, PLAN-1, DEP-1, CLI-D1, CLI-F1, IVA-5, CAT-2, ATE-1, E1.4-c, CI-3 | 35 commits |

## Sprint 2 — Cimientos que se vuelven medibles
Fuente: inferido (fechas + verificación de commits contra `git log`)
Ventana: 2026-09-01
Objetivo: El agente gana vara de medir (golden set, presupuesto), el catálogo/asiento manual y la ingesta fiscal ganan familia de comandos, y una segunda auditoría (docce lentes) pone al día los documentos rectores.
Milestone: `Sprint 2 · Cimientos que se vuelven medibles` (cerrado)

| PR | Título | Merge | Tramos que incluye | Notas |
|---|---|---|---|---|
| [#17](https://github.com/sedecim-com/Accounting/pull/17) | Cimientos: el sistema se vuelve medible — tablero, catálogo, mayor inviolable y agente con vara | 2026-09-01 | Tipos, A3-A4, F02, F01, A1-A2, R3 | 24 commits (19 sustantivos, 5 de fusión/mantenimiento) |
| [#10](https://github.com/sedecim-com/Accounting/pull/10) | E0.2: una migración de datos que olvide la RLS truena en vez de correr filtrada | 2026-09-01 | E0.2 | 7 commits (6 sustantivos, 1 de fusión/mantenimiento) |
| [#19](https://github.com/sedecim-com/Accounting/pull/19) | Auditoría integral II: doce lentes, y los tres documentos rectores puestos al día | 2026-09-01 | — | 3 commits (2 sustantivos, 1 de fusión/mantenimiento) |
| [#2](https://github.com/sedecim-com/Accounting/pull/2) | Tres entradas que se aceptaban y se tiraban en silencio | 2026-09-01 | — | 2 commits (1 sustantivos, 1 de fusión/mantenimiento) |
| [#3](https://github.com/sedecim-com/Accounting/pull/3) | Anular una factura exige un motivo, y el motivo llega al mayor | 2026-09-01 | — | 3 commits (1 sustantivos, 2 de fusión/mantenimiento) |
| [#6](https://github.com/sedecim-com/Accounting/pull/6) | API: cuatro parámetros que se validaban y se tiraban a la basura | 2026-09-01 | — | 3 commits (1 sustantivos, 2 de fusión/mantenimiento) |
| [#7](https://github.com/sedecim-com/Accounting/pull/7) | lint: añadir la capa de ESLint que faltaba, y reparar lo que encontró | 2026-09-01 | — | 5 commits (4 sustantivos, 1 de fusión/mantenimiento) |
| [#18](https://github.com/sedecim-com/Accounting/pull/18) | Add github-advanced-security[bot] as automatic reviewer for all PRs | 2026-09-01 | — | 1 commits |
| [#39](https://github.com/sedecim-com/Accounting/pull/39) | Update CODEOWNERS to include witness-vic[bot] | 2026-09-01 | — | 1 commits |
| [#11](https://github.com/sedecim-com/Accounting/pull/11) | Bump the acciones group across 1 directory with 2 updates | 2026-09-01 | — | 2 commits (0 sustantivos, 2 de fusión/mantenimiento) |
| [#12](https://github.com/sedecim-com/Accounting/pull/12) | Bump body-parser from 1.20.4 to 1.20.6 | 2026-09-01 | — | 2 commits (0 sustantivos, 2 de fusión/mantenimiento) |
| [#13](https://github.com/sedecim-com/Accounting/pull/13) | Bump postcss from 8.5.9 to 8.5.26 | 2026-09-01 | — | 3 commits (0 sustantivos, 3 de fusión/mantenimiento) |
| [#14](https://github.com/sedecim-com/Accounting/pull/14) | Bump axios from 1.15.0 to 1.20.0 | 2026-09-01 | — | 3 commits (0 sustantivos, 3 de fusión/mantenimiento) |
| [#16](https://github.com/sedecim-com/Accounting/pull/16) | Bump the menores-y-parches group across 1 directory with 11 updates | 2026-09-01 | — | 3 commits (0 sustantivos, 3 de fusión/mantenimiento) |
| [#20](https://github.com/sedecim-com/Accounting/pull/20) | Bump brace-expansion from 1.1.14 to 1.1.18 | 2026-09-01 | — | 2 commits (0 sustantivos, 2 de fusión/mantenimiento) |
| [#23](https://github.com/sedecim-com/Accounting/pull/23) | Bump qs and express | 2026-09-01 | — | 2 commits (0 sustantivos, 2 de fusión/mantenimiento) |
| [#24](https://github.com/sedecim-com/Accounting/pull/24) | Bump @protobufjs/utf8 from 1.1.0 to 1.1.2 | 2026-09-01 | — | 2 commits (0 sustantivos, 2 de fusión/mantenimiento) |
| [#26](https://github.com/sedecim-com/Accounting/pull/26) | Bump uuid, @apollo/server and bullmq | 2026-09-01 | — | 1 commits (0 sustantivos, 1 de fusión/mantenimiento) |
| [#28](https://github.com/sedecim-com/Accounting/pull/28) | Bump vite, @vitest/coverage-v8 and vitest | 2026-09-01 | — | 1 commits (0 sustantivos, 1 de fusión/mantenimiento) |
| [#30](https://github.com/sedecim-com/Accounting/pull/30) | Bump @xmldom/xmldom from 0.8.12 to 0.8.15 | 2026-09-01 | — | 2 commits (0 sustantivos, 2 de fusión/mantenimiento) |

## Sprint 3 — Cobrar, el instrumento se mide a sí mismo, y una sola puerta al auto-posteo
Fuente: inferido (fechas + verificación de commits contra `git log`)
Ventana: 2026-09-01
Objetivo: F03 (cobrar) y F04 (pagar) cierran; S2 hace que el propio instrumento de plan pase sus criterios; S3 prueba el respaldo restaurándolo; A7 unifica la precedencia del auto-posteo en una asimetría, no un orden.
Milestone: `Sprint 3 · Cobrar, el instrumento se mide a sí mismo, y una sola puerta al auto-posteo` (cerrado)

| PR | Título | Merge | Tramos que incluye | Notas |
|---|---|---|---|---|
| [#21](https://github.com/sedecim-com/Accounting/pull/21) | F03 · Cobrar: notas de crédito, el cobro como historia y el retiro del envío simulado | 2026-09-02 | F05b, F05a, F04, S3, A7, S2, F03 | 30 commits (25 sustantivos, 5 de fusión/mantenimiento) |
| [#9](https://github.com/sedecim-com/Accounting/pull/9) | ci: triage determinista Witness al abrir/actualizar PR | 2026-09-01 | — | 1 commits |
| [#38](https://github.com/sedecim-com/Accounting/pull/38) | Tope al lote de preregistros: cada elemento suyo postea al mayor | 2026-09-01 | — | 1 commits |
| [#40](https://github.com/sedecim-com/Accounting/pull/40) | Un --period que no casaba nada daba el visto bueno sobre un mayor roto | 2026-09-01 | — | 1 commits |
| [#31](https://github.com/sedecim-com/Accounting/pull/31) | El README deja de llevar cifras a mano, y la wiki existe | 2026-09-01 | — | 2 commits (1 sustantivos, 1 de fusión/mantenimiento) |

## Sprint 4 — El catálogo mexicano por omisión, GraphQL con freno, y el cierre del mes
Fuente: inferido (fechas + verificación de commits contra `git log`)
Ventana: 2026-09-01 → 2026-09-02
Objetivo: El catálogo de cuentas deja de ser mexicano "por opción" (053); GraphQL gana freno por inquilino; F05c-d y F06a-c cierran banca y cierre de mes; R4 lleva la moneda extranjera al origen.
Milestone: `Sprint 4 · El catálogo mexicano por omisión, GraphQL con freno, y el cierre del mes` (cerrado)

| PR | Título | Merge | Tramos que incluye | Notas |
|---|---|---|---|---|
| [#33](https://github.com/sedecim-com/Accounting/pull/33) | El catálogo deja de ser mexicano por omisión, y la nómina de cargarse a Devoluciones sobre Compras | 2026-09-02 | — | 12 commits (5 sustantivos, 7 de fusión/mantenimiento) |
| [#41](https://github.com/sedecim-com/Accounting/pull/41) | El triaje de Witness dejaba de leerse porque gritaba en español | 2026-09-02 | — | 1 commits |
| [#42](https://github.com/sedecim-com/Accounting/pull/42) | El freno por inquilino que a GraphQL le faltaba, y la barrera que el escáner sí lee | 2026-09-02 | — | 1 commits |
| [#45](https://github.com/sedecim-com/Accounting/pull/45) | GraphQL llegaba al mayor con la entidad y sin el permiso, y por el grafo sin nada | 2026-09-02 | — | 1 commits |
| [#37](https://github.com/sedecim-com/Accounting/pull/37) | El manual de usuario, la auditoría de usabilidad y la auditoría integral III | 2026-09-02 | — | 1 commits |
| [#43](https://github.com/sedecim-com/Accounting/pull/43) | F05c: la conciliación deja de firmar un cuadre que nunca calculó | 2026-09-02 | R4, F06b, F06c, F06a, F05d, F05c | 12 commits (11 sustantivos, 1 de fusión/mantenimiento) |

## Sprint 5 — La síntesis de la auditoría III, la armonización, y la investigación de conectores
Fuente: inferido (fechas + verificación de commits contra `git log`)
Ventana: 2026-09-02
Objetivo: Cerrar la auditoría integral III (once escépticos) con su síntesis y replanteamiento; armonizar la gramática de confirmación y la fecha local; investigar PACs, proveedores de IA, onboarding, tablero y canales para la siguiente fase.
Milestone: `Sprint 5 · La síntesis de la auditoría III, la armonización, y la investigación de conectores` (cerrado)

| PR | Título | Merge | Tramos que incluye | Notas |
|---|---|---|---|---|
| [#44](https://github.com/sedecim-com/Accounting/pull/44) | El ensayo de restauración: documentarlo en el wiki y ponerlo bajo criterio | 2026-09-02 | — | 1 commits |
| [#46](https://github.com/sedecim-com/Accounting/pull/46) | La síntesis de la auditoría III: once escépticos, el replanteamiento y la secuencia | 2026-09-02 | — | 1 commits |
| [#47](https://github.com/sedecim-com/Accounting/pull/47) | Armonización: una gramática de sí, la fecha local, el binario que existe y tres verdades | 2026-09-02 | — | 1 commits |
| [#48](https://github.com/sedecim-com/Accounting/pull/48) | Siete mutaciones más por la puerta, y dos que no entran porque no hay dónde delegar | 2026-09-02 | — | 1 commits |
| [#49](https://github.com/sedecim-com/Accounting/pull/49) | La investigación de conectores y dirección: PACs, IA, onboarding, tablero, canales y el experimento | 2026-09-02 | — | 1 commits |
| [#50](https://github.com/sedecim-com/Accounting/pull/50) | qs 6.16.0 por override: express 4 pina el rango que excluye el parche | 2026-09-02 | — | 1 commits |

## Sprint 6 — G1a, la superficie que se mide (S-UX), A7·remate, y A5
Fuente: inferido (fechas + verificación de commits contra `git log`)
Ventana: 2026-09-02 → 2026-09-03
Objetivo: Corregir un signo de balance que ya se publicaba mal (G1a); dar ejemplos y contrato de salida a la mayoría de la superficie CLI (S-UX); el agente lee el sistema en vez de su propia descripción (A7·remate); el lazo de aprendizaje del agente y el failover que se comía la superficie nombrada (A5, que llegó a `main` dentro del squash del #52 — ver la fila del #54).
Milestone: `Sprint 6 · G1a, S-UX, A7·remate, A5` (cerrado)

| PR | Título | Merge | Tramos que incluye | Notas |
|---|---|---|---|---|
| [#51](https://github.com/sedecim-com/Accounting/pull/51) | G1a: una utilidad de 3 000 se publicaba como pérdida de 2 000, y el balance decía que cuadraba | 2026-09-02 | G1a | 1 commits |
| [#52](https://github.com/sedecim-com/Accounting/pull/52) | S-UX lote 2 y A7·remate: la superficie que se mide, y el agente que lee el sistema en vez de su descripción | 2026-09-03 | — | 1 commit (squash `d8882d5` de `sux/segundo-lote`, que ya contenía el #54) |
| [#54](https://github.com/sedecim-com/Accounting/pull/54) | A5: el lazo que aprende, y la superficie que el failover se comía | 2026-09-03 → `sux/segundo-lote` | — | **0 commits propios en `main`**: se mergeó hacia `sux/segundo-lote` (02:50Z) y entró a `main` dentro del squash del #52 (03:04Z). Contenido verificado idéntico entre ambas ramas. |

## Sprint 7 — G0 y G3: los instrumentos que mienten según la máquina
Fuente: **verificado** (`git log d8882d5..8bdc8f2`: los 30 commits que introdujo el merge, uno a uno)
Ventana: 2026-09-02 → 2026-09-06 (fechas de los commits); merge 2026-09-07
Objetivo: El cierre de mes llevaba meses a 27 segundos de morir y nadie lo sabía porque no había reloj (G0); el control de cuatro ojos se vendía y se eludía con una bandera JSON (G3); y con ellos entró la cosecha de una rama larga — el flujo de efectivo (G1b), la balanza del Anexo 24 (F07b), el archivo del mes (F07c+d), el devengo del finiquito (D1a), el subsidio al empleo y el impuesto que no existía (F08a), y las tres políticas de RLS aflojadas con las que la suite entera pasaba en verde (S4a).
Milestone: `Sprint 7 · G0 y G3` (cerrado)

| PR | Título | Merge | Tramos que incluye | Notas |
|---|---|---|---|---|
| [#53](https://github.com/sedecim-com/Accounting/pull/53) | G0 y G3: poner un timeout destapó un cierre a 27 segundos de morir, y el control de cuatro ojos tenía cuatro puertas | 2026-09-07 | G0, G1a, G1b, G3, G4a, G4b, D1a, E1a, F07a, F07b, F07c+d, F08a, S3·sello, S4a, S4b | 30 commits. **El último PR que entró con commit de fusión propio** (`70a4aef`); de aquí en adelante todo es squash. Uno de los 30 —`fa93c1a`— repite trabajo que ya había llegado a `main` dentro del squash del #51: la fusión lo reconcilió y el árbol no lo duplica, pero el conteo de commits deja de medir trabajo nuevo. |

## Después de los sprints — el plan pasa a Issues, y la entrega se cuenta por tramos
Fuente: **verificado** (`git log --first-parent`, y `gh pr view` PR a PR)
Ventana: 2026-09-07 → 2026-09-08
Objetivo: Cerrar defectos concretos de la Vía A uno por uno, cada uno con su criterio en el plan ejecutable, y abrir dos dimensiones nuevas que van *antes* de cualquier motor por país: la jurisdicción (J0) y el idioma del código (I0, I1).
Milestone: **ninguno**. Los hitos de sprint se detienen en el 7, y no es un descuido: desde el #55 el plan vive como Issues con los hitos `Vía A · Lo que ya está mal` y `Vía B · Lo que falta construir`, y la unidad de entrega dejó de ser el sprint para ser el **tramo** (`T1`, `T3a`, `J0.1`, `I0`…). Esta sección agrupa por ventana, no por hito, porque hito no hay.

| PR | Título | Merge | Tramos que incluye | Notas |
|---|---|---|---|---|
| [#55](https://github.com/sedecim-com/Accounting/pull/55) | Migrar el plan a GitHub: SCOPE, PROCESS, ROUTING, HISTORY verificado, y el archivo de los artefactos de Claude | 2026-09-07 | — | squash `c01d79a`, 13 commits de rama. **Es el PR que creó este documento.** |
| [#135](https://github.com/sedecim-com/Accounting/pull/135) | Investigación normativa y de motores: la jurisdicción como dimensión | 2026-09-07 | J0 (diseño) | squash `b31e62a`. Su rama arrastraba los 13 commits del #55, así que los «26 commits» que reporta la API no son 26 de trabajo nuevo: el squash aportó 37 archivos. Fue **la última vez que se tocó este documento** antes de la reparación que lo puso al día. |
| [#136](https://github.com/sedecim-com/Accounting/pull/136) | T1: la actualización moría en tres sitios, y el tercero perdía dinero | 2026-09-07 | T1 | squash `0d4494f`, 1 commit. Su hallazgo **crítico** de Witness no se atendió aquí: se atendió en el #186. |
| [#139](https://github.com/sedecim-com/Accounting/pull/139) | T20·6: la cuota obrera de enfermedades y maternidad se copió de la casilla de al lado | 2026-09-07 | T20·6 | squash `a9dc282`, 2 commits. Su WIT-01 —la migración que corrige el parámetro no la había corrido nadie— se atendió en el #183. |
| [#170](https://github.com/sedecim-com/Accounting/pull/170) | T3a: la bandera de inquilino llegaba, se aplicaba, y la hoja la pisaba | 2026-09-07 | T3a | squash `317c316`, 4 commits. |
| [#171](https://github.com/sedecim-com/Accounting/pull/171) | T3b: una regla que verificaba su propio efecto secundario, y 21 hojas que tiraban la llave | 2026-09-07 | T3b | squash `1b0e09e`, 5 commits. |
| [#173](https://github.com/sedecim-com/Accounting/pull/173) | T3c: el archivo que no se creaba, el que se borraba a sí mismo, y los enteros sin productor | 2026-09-07 | T3c | squash `973ad40`, 3 commits. |
| [#175](https://github.com/sedecim-com/Accounting/pull/175) | T13a: la autocomprobación que firmaba lo que no medía, y la política que decía bloquear sin bloquear | 2026-09-07 | T13a | squash `edcb72f`, 4 commits. |
| [#176](https://github.com/sedecim-com/Accounting/pull/176) | T13b: archivar una cuenta reescribía un estado financiero ya firmado | 2026-09-07 | T13b | squash `25113c5`, 3 commits. |
| [#183](https://github.com/sedecim-com/Accounting/pull/183) | T20-6b: la migración que corrige un parámetro fiscal no la había corrido nadie (WIT-01 de #139) | 2026-09-07 | T20-6b | squash `aa6c62f`, 1 commit. |
| [#181](https://github.com/sedecim-com/Accounting/pull/181) | El informe del ataque salía por una línea que nadie imprimía | 2026-09-07 | — | squash `8743fae`, 2 commits. Remate de S4a: el ataque corría y su informe se perdía. |
| [#172](https://github.com/sedecim-com/Accounting/pull/172) | I0: la identidad de un instrumento deja de ser la frase con que se enuncia | 2026-09-08 | I0 | squash `6519ad4`, 8 commits. Cambia la llave del piso de criterios: de aquí en adelante un criterio se identifica por su `id` estable en inglés, no por su enunciado. |
| [#140](https://github.com/sedecim-com/Accounting/pull/140) | J0.1: la jurisdicción deja de ser un booleano, y las cuatro copias que no coincidían | 2026-09-08 | J0.1 | squash `6c20c52`, 9 commits. |
| [#187](https://github.com/sedecim-com/Accounting/pull/187) | El rol del auditor deja de verificarse en un clúster que no existe | 2026-09-08 | — | squash `c9082eb`, 1 commit. |
| [#186](https://github.com/sedecim-com/Accounting/pull/186) | T1b: la reparación no llegaba a quien la necesitaba, y la 071 no dejaba llegar nada (WIT-01 crítico de #136) | 2026-09-08 | T1b | squash `3f2695c`, 7 commits. Cierra el crítico que dejó abierto el #136, y de camino destapó una regresión que bloqueaba las migraciones. |
| [#174](https://github.com/sedecim-com/Accounting/pull/174) | I1: el léxico compartido y la regla escrita, que decía lo contrario | 2026-09-08 | I1 | squash `704351e`, 3 commits. |
| [#208](https://github.com/sedecim-com/Accounting/pull/208) | La ñ era un separador, así que las palabras más españolas se contaban en inglés | 2026-09-08 | I2·remate | squash `5fbb272`, 1 commit. El metro del idioma partía las palabras por la `ñ` y contaba como inglesas las mitades resultantes. |
| [#212](https://github.com/sedecim-com/Accounting/pull/212) | T14a: el balance que leía el agente no cuadraba, y era el único que se lo calculaba solo | 2026-09-09 | T14a | squash `bbcbeb4`, 1 commit. De las tres superficies del balance sólo la del agente se calculaba su propio total: publicaba 94 000.00 contra un activo de 100 000.00 y ningún campo con el que notarlo. De camino salieron tres defectos que la issue no nombraba, uno de ellos una cifra falsa en el estado de resultados. |
| [#214](https://github.com/sedecim-com/Accounting/pull/214) | T14b: la segunda puerta al mayor se retira, y el criterio que la vigilaba se cegaba solo | 2026-09-09 | T14b | squash `5816559`, 2 commits. **−4 265 líneas**: la superficie GraphQL entera, sus cuatro dependencias y 870 renglones del lock. El criterio que la vigilaba se ponía verde por AUSENCIA de una palabra en `src/index.ts`; el que lo sustituye cuenta antes de absolver. |

## Del 9 al 16 de septiembre — la frontera de entidad, el idioma que se mide solo, y la nómina auditada entera
Fuente: **verificado** (`gh pr view` y `git show` PR a PR; cada cifra de las notas sale del commit o del cuerpo de su PR, y un escéptico independiente intentó refutarla antes de que entrara aquí)
Ventana: 2026-09-09 → 2026-09-16
Objetivo: Cerrar la serie T9/TEN —la RLS acota por INQUILINO, así que la frontera de ENTIDAD sólo la defiende el SQL, y no la defendía—, llevar el epic del idioma de la regla escrita a la puerta que falla en CI, y auditar la nómina de punta a punta: la tarifa del ISR, el archivo del IMSS, el finiquito y el embargo.
Milestone: **ninguno**. Desde el #55 el plan vive como Issues.

Nota de método: seis de estos PRs —#182, #191, #195, #198, #213 y #228, toda la serie I— entraron con **commit de fusión de dos padres**, no por squash. La cabecera de este documento decía que el #53 había sido el último; ya no es cierto, y queda corregido arriba. Para esos seis, «N commits» es la cuenta que da el método de los dos padres (`git log <primer-padre>..<segundo-padre>`), y coincide con la que reporta la rama.

| PR | Título | Merge | Tramos que incluye | Notas |
|---|---|---|---|---|
| [#177](https://github.com/sedecim-com/Accounting/pull/177) | E1b: la columna de inquilino en las hijas, y el agujero de aislamiento que destapó | 2026-09-09 | E1b | squash `8b42198`, 15 commits. Dar `tenant_id` a diecinueve tablas hija abrió un agujero de aislamiento dentro del propio PR: quedaban con dos políticas permisivas, que se suman con OR, y un cotejo al movimiento bancario de otro inquilino se insertaba sin error. `pg_policy` daba dos políticas por tabla, y una tras el arreglo. |
| [#199](https://github.com/sedecim-com/Accounting/pull/199) | J0.2: la ley tiene fecha de entrada, y sin vigencia el cálculo se detiene | 2026-09-09 | J0.2 | squash `7871699`, 9 commits. La ley vivía quemada en el código o en `tax_parameters`, cuya llave `UNIQUE(jurisdiction, tax_year)` da un solo valor por ejercicio y no puede contestar por enero de 2026: la UMA diaria de 117.31 MXN entra en vigor el 1 de febrero, no el 1 de enero. Entra `legal_parameters` con `effective_from`. |
| [#202](https://github.com/sedecim-com/Accounting/pull/202) | Bump the acciones group with 3 updates | 2026-09-09 | — | squash `f77283b`, 2 commits. Dependencias. |
| [#203](https://github.com/sedecim-com/Accounting/pull/203) | Bump the menores-y-parches group across 1 directory with 6 updates | 2026-09-09 | — | squash `c9e95bc`, 2 commits. Dependencias. |
| [#204](https://github.com/sedecim-com/Accounting/pull/204) | Bump dotenv from 16.6.1 to 17.4.2 | 2026-09-09 | — | squash `9d24018`, 3 commits. Dependencias. |
| [#205](https://github.com/sedecim-com/Accounting/pull/205) | Bump bullmq from 5.81.4 to 6.3.4 | 2026-09-09 | — | squash `d6d1833`, 2 commits. Dependencias. |
| [#209](https://github.com/sedecim-com/Accounting/pull/209) | El historial de entrega decía que el #53 seguía abierto, y callaba los diecisiete siguientes | 2026-09-09 | — | squash `a38b5d3`, 8 commits. El documento daba al #53 por «Abierto, CI en verde» cuando llevaba fusionado desde el 2026-09-07, y registraba 41 PRs y 191 commits contra los 58 fusionados y 261 commits del árbol. |
| [#222](https://github.com/sedecim-com/Accounting/pull/222) | El triage no puede correr en un PR de Dependabot, así que deja de fingir que lo intenta | 2026-09-09 | — | squash `84ac8d3`, 1 commit. Los seis PR de Dependabot abiertos —#202 a #207— tenían «Triage determinista» en rojo por la misma causa y ninguno por su dependencia: GitHub no entrega los secretos a un `pull_request` de `dependabot[bot]`, y el job moría en su primer paso con un `app-id` vacío, antes de mirar una línea de diff. |
| [#163](https://github.com/sedecim-com/Accounting/pull/163) | El idioma del código y el de la interfaz: inglés en el código, el idioma del usuario en la interfaz, español primero | 2026-09-11 | — | squash `b06a4e8`, 17 commits. No toca `src/`: trae el rector del idioma y los ocho inventarios que lo miden —45 % de las 4 637 declaraciones de nivel superior de `src/` en español—. De aquí salen el epic #141 y los 27 tramos I0–I26. |
| [#190](https://github.com/sedecim-com/Accounting/pull/190) | Los catálogos globales se devuelven como se encontraron, y hay quien lo vigila | 2026-09-11 | — | squash `01077bd`, 2 commits. Seis catálogos globales sin `tenant_id` ni `entity_id` los comparten los 91 archivos de la integración en una sola base: `f07d` dejaba sembradas '012' y '002' en `sat_bancos`, y `f07cd` caía con «expected 2 to be +0» según el orden del sequencer; CI en verde porque `npm ci` arranca en frío. |
| [#193](https://github.com/sedecim-com/Accounting/pull/193) | T4a: la tarifa era la del año pasado, y a un sueldo semanal se le aplicaba la del mes (#91) | 2026-09-11 | T4a, T4b | squash `a425cb4`, 15 commits. La tarifa sembrada como 2026 era la de 2025 al centavo y todo periodo que no fuera quincenal caía al `else` mensual: el semanal de 3 000 retenía 0.00 donde debía 248.82, y el de 7 000, 190.96 contra 1 060.39. El ISR de separación sí salió con issue propia, la #194. |
| [#200](https://github.com/sedecim-com/Accounting/pull/200) | T20·2: el embargo guardado como manda la columna no retenía nada (#127) | 2026-09-11 | T20·1, T20·2, T20·3, T20·4 | squash `e509e8e`, 6 commits. Las dos columnas de vocabulario de `garnishments` no tenían CHECK y el motor ramificaba sobre nombres distintos de los que documenta el esquema: en una orden del 25 % con 2 000 de ingreso disponible, tres de los seis tipos documentados retenían cero, `percent_disposable` 0 donde `percentage` 500. |
| [#206](https://github.com/sedecim-com/Accounting/pull/206) | Bump bcryptjs and @types/bcryptjs | 2026-09-11 | — | squash `5a47b05`, 3 commits. Dependencias. |
| [#210](https://github.com/sedecim-com/Accounting/pull/210) | X0: lo sellado y lo publicado eran números distintos | 2026-09-11 | X0 | squash `4d8daad`, 4 commits. El sello cubría `total` mientras se publicaba `rounded`, y la primera versión de la prueba del sello no podía fallar: la fixture usaba 12 000 con redondeo a millares, así que sellar el total o lo publicado daba el mismo hash. Corregida, los tres mutantes mueren con 1, 1 y 3 pruebas en rojo. |
| [#216](https://github.com/sedecim-com/Accounting/pull/216) | T14b·remate: la amputación se llevó la única prueba de conducta de los permisos | 2026-09-11 | T14b·remate | squash `cd2ddd9`, 3 commits. Remate del #214, que había afirmado que retirar GraphQL costaba cero cobertura: `assertPermissions` convertida en un no-op que no compara nada dejaba pasar 253 archivos y 5 457 pruebas. |
| [#217](https://github.com/sedecim-com/Accounting/pull/217) | O1: el XML del SAT como puerta, y el signo invertido que la ida y la vuelta escondían | 2026-09-11 | O1 | squash `90c20ab`, 5 commits. Un byte NUL crudo sacaba del alcance de `grep` el fuente que escribe el asiento de apertura sin que tsc, eslint, vitest, la cobertura ni `git diff` se movieran: caía en el byte 22 381 y la heurística de binario de git sólo mira los primeros 8 000. De ahí el criterio sobre 845 fuentes, hoy en cero. |
| [#224](https://github.com/sedecim-com/Accounting/pull/224) | T9a: la nómina posteaba en el mayor de la sociedad hermana, y entregaba su plantilla | 2026-09-11 | T9a | squash `d649f7f`, 1 commit. Con acceso concedido sólo a la sociedad A, postear la corrida de B contestaba 200 y le dejaba a B una póliza posteada de 10 029.92 en su mayor: el filtro iba sólo por inquilino y la entidad del asiento la elegía el id que se mandaba, no el token. El finiquito lo remató #227. |
| [#225](https://github.com/sedecim-com/Accounting/pull/225) | T9b: el SSN de la plantilla ajena salía en claro, y se le podía cambiar el sueldo | 2026-09-11 | T9b | squash `bc9daaf`, 3 commits. Tres rutas de nómina que escriben aceptaban el id de una entidad hermana del mismo inquilino, donde la RLS no acota porque acota por inquilino: `POST /w2` contestaba 200 con el SSN descifrado `123-45-6789`. Ahora las tres contestan 404. Queda abierto: 16 de las 21 rutas sin guarda, de 36 en total. |
| [#180](https://github.com/sedecim-com/Accounting/pull/180) | D1: el devengo existe — aguinaldo, vacaciones y prima vacacional, mes a mes | 2026-09-12 | D1 | squash `596b8ea`, 20 commits. Un despacho que paga el aguinaldo en diciembre sin provisionarlo publica once meses de utilidad inflada: no había motor de devengo mensual. Entra uno cuyos doce meses suman el anual exacto, 1 500.0000, contra los 1 500.0004 de doce divisiones sueltas. |
| [#226](https://github.com/sedecim-com/Accounting/pull/226) | TEN-10: un token de una sociedad leía, renombraba y archivaba las cuentas de su hermana, y timbraba sus facturas | 2026-09-12 | TEN-10 | squash `ff99130`, 2 commits. Cuatro rutas resolvían por `WHERE id = $1` a secas y la RLS acota por inquilino, que las dos sociedades comparten: un token de la entidad A leía, renombraba, archivaba y daba de baja las cuentas de su hermana, y timbraba sus facturas ante un PAC, pisando el folio con el que se cancela. |
| [#227](https://github.com/sedecim-com/Accounting/pull/227) | T9c: la cadena que lleva la corrida hasta el mayor no acotaba por entidad, y el finiquito llevaba la guarda puesta (#96) | 2026-09-12 | T9c | squash `5896db7`, 1 commit. Siete peticiones cruzadas entre dos sociedades del mismo inquilino —la RLS no acota nada, acota por inquilino— más la del finiquito: `calculate` sobre la corrida de B contestaba 200 y dejaba `total_gross` en 0.00 y `employee_count` en 0; ahora las ocho contestan 404. Parte de #96 queda abierta. |
| [#230](https://github.com/sedecim-com/Accounting/pull/230) | T5·SUA: el archivo que se le entrega al IMSS declaraba las cuotas de toda la historia del empleado (#92) | 2026-09-12 | T5·SUA | squash `43ff04d`, 1 commit. El archivo que el patrón carga en el SUA recogía el historial entero: declaraba para marzo 3 500.00 de cuota patronal IMSS contra los 1 000.00 debidos, sobre un archivo con cero pruebas y cero criterios. Cotejarlo ahora contra los libros dejó abierto un hallazgo ajeno al tramo, que se abrió aparte. |
| [#182](https://github.com/sedecim-com/Accounting/pull/182) | I3: la puerta del idioma, en error, con la misma población que el metro | 2026-09-14 | I3 | fusión `1e16cd7`, 13 commits. La puerta del idioma nace en error, no en aviso: en aviso no habría cerrado nada, porque el tope compartido que de verdad corre, `--max-warnings 1106`, absorbe una advertencia más sin que nadie la note. Línea base por archivo y sin entrada = 0: un archivo nuevo no tiene derecho a español. |
| [#191](https://github.com/sedecim-com/Accounting/pull/191) | I4: el vocabulario persistido, con su nombre inglés ya decidido | 2026-09-14 | I4 | fusión `b78ebcc`, 13 commits. 710 entradas, una por término que el sistema persiste: 429 con su nombre inglés y 281 con la razón escrita de por qué no se renombran. Entre las 281, las 35 migraciones: renombrar una ya aplicada la vuelve a aplicar sobre una base viva, porque el migrador las salta comparando el nombre completo. |
| [#195](https://github.com/sedecim-com/Accounting/pull/195) | I2: el metro del idioma, sus dieciséis carriles y la puerta que los juzga | 2026-09-14 | I2 | fusión `3ad6f6b`, 22 commits. Hasta este PR `main` no tenía metro del idioma: `npm run language:status` publica dieciséis carriles —quince bajo trinquete y uno informativo—, con línea base por carril y por archivo, y `--check` en CI. |
| [#198](https://github.com/sedecim-com/Accounting/pull/198) | I5: el renombrado de J0 nace con su guarda, que es lo único que quedaba | 2026-09-14 | I5 | fusión `f2dade8`, 10 commits. El renombrado de J0 al inglés se fusionó en #140 sin su criterio ejecutable y la issue #147 ya estaba cerrada, así que la obligación no tenía dueño. Recién escrito, el criterio cazó nueve identificadores españoles que J0.2 (#199) había dejado: `spanish-identifiers-tests` baja de 5 786 a 5 777. |
| [#213](https://github.com/sedecim-com/Accounting/pull/213) | I6: el idioma del usuario se elige, y el catálogo por fin traduce | 2026-09-14 | I6 | fusión `3e14c2b`, 12 commits. El catálogo de traducción existía y no traducía: con el locale del proceso en `en-US` el resolutor decía `en-US` y `t()` imprimía en español, en la misma corrida, con cuarenta pruebas en verde. Deja abierto el defecto de `sinComentarios` con acentos graves. |
| [#228](https://github.com/sedecim-com/Accounting/pull/228) | I7: el CLI habla por clave, y el piloto deja de cargar español suelto | 2026-09-14 | I7 | fusión `1ebdc99`, 12 commits. El kernel del CLI y el piloto `bank` emitían español suelto en el código: 41 cadenas sin catálogo quedan en 0. Deja **abierto** un defecto del instrumento del plan: `sinComentarios` no quita los comentarios en archivos grandes, y todo criterio que use `codigoDe` hereda la ceguera. |
| [#234](https://github.com/sedecim-com/Accounting/pull/234) | T6: el panel aceptaba cualquier número, y de ahí salía dinero a una persona (#93) | 2026-09-14 | T6 | squash `dfb35a2`, 1 commit. El panel aceptaba `prima_vacacional_pct = '25'` —el catálogo guarda `'0.25'`— y el finiquito pagaba una prima de 275 000.00 donde tocaban 2 750.00, cien veces de más. Deja abierto en #93 la compuerta bancaria, entre otros puntos. |
| [#237](https://github.com/sedecim-com/Accounting/pull/237) | TEN-11: cuatro rutas escribían sobre la sociedad hermana, y el tablero no podía verlas (#235) | 2026-09-15 | TEN-11 | squash `71b62b2`, 11 commits. Tres rutas escribían sobre recursos de la sociedad hermana —mismo inquilino, donde la RLS no acota—: aprobar la factura ajena contestaba 200 y dejaba posteada en el mayor de B la póliza `JE-2026-00001`, consumiendo su primer folio. Las tres dan 404 ahora; `/calculate` queda abierto para TEN-12. |
| [#239](https://github.com/sedecim-com/Accounting/pull/239) | TEN-12: the sibling company's employee could be paid from the own pay run, and the request body chose the period | 2026-09-15 | TEN-12 | squash `a955847`, 4 commits. `calculatePaycheck` acotaba sus tres llaves sólo por `tenant_id`: el cuerpo podía nombrar al empleado de la sociedad hermana y elegir el periodo —un mismo empleado propio salía con IMSS 133.00 con un periodo de 28 días nombrado en la petición contra 71.25 con el de 15 días de su corrida. |
| [#240](https://github.com/sedecim-com/Accounting/pull/240) | #211: a journal entry dated March 1st was stored on February 28th west of Greenwich — and so were the entries of payments and receipts | 2026-09-15 | E1.2 | squash `d81e47b`, 5 commits. Pedida por REST con fecha 2026-03-01, la póliza se guardaba el 2026-02-28 —en el periodo de febrero—; las otras mitades de la familia quedaron fuera a propósito, en las issues #241, #242 y #243. |
| [#233](https://github.com/sedecim-com/Accounting/pull/233) | A6: el conductor del cierre, y el expediente que un tercero vuelve a correr | 2026-09-16 | A6 | squash `2185e18`, 10 commits. El cierre tenía portón y superficie de lectura, pero nadie que lo condujera: devengar, amortizar, depreciar, checklist y cierre suave dependían de que alguien los recordara en ese orden, cada mes y por entidad. Medición final: 305 mutantes aplicados, 305 muertos. |
| [#236](https://github.com/sedecim-com/Accounting/pull/236) | El metro prometía que un bloque viejo salía en rojo, y no miraba el bloque | 2026-09-16 | I2 | squash `3b7bc9a`, 5 commits. El bloque que `language:status` publica promete que CI lo verifica con `--check`, y `--check` nunca leía la página: al bloque publicado le faltaba un carril entero —`spanish-user-strings-cli`, 468— y traía seis cifras viejas, y aun así decía «17 lanes, ninguno por encima de su línea base». |
| [#238](https://github.com/sedecim-com/Accounting/pull/238) | I10 · 1: el texto del panel sale del catálogo, y teclear un valor ya no guarda otro | 2026-09-16 | I10 | squash `d244e4e`, 3 commits. Los dos prompts tomaban por posición cualquier `Number(x)` entero de la lista: teclear «1.00» en `prima_vacacional_pct` guardaba «0.25», el mínimo legal, que pasa dominio y piso sin error; medido sobre `POLICY_CATALOG`, cuatro claves colisionaban así. Primer commit del tramo: no cierra el #152. |
| [#244](https://github.com/sedecim-com/Accounting/pull/244) | Bump the menores-y-parches group with 6 updates | 2026-09-16 | — | squash `8c5c36f`, 1 commit. Dependencias. |
| [#245](https://github.com/sedecim-com/Accounting/pull/245) | Bump helmet from 7.2.0 to 8.3.0 | 2026-09-16 | — | squash `382327e`, 1 commit. Dependencias. |
| [#246](https://github.com/sedecim-com/Accounting/pull/246) | Bump @types/uuid from 9.0.8 to 11.0.0 | 2026-09-16 | — | squash `cb8ca21`, 1 commit. Dependencias. |
| [#247](https://github.com/sedecim-com/Accounting/pull/247) | Bump @types/node from 20.19.39 to 26.5.1 | 2026-09-16 | — | squash `7f1b70b`, 3 commits. Dependencias. |
| [#250](https://github.com/sedecim-com/Accounting/pull/250) | X0: el despacho firmaba dos cifras distintas sobre sí mismo, y la que publicaba no era la de su estado de resultados | 2026-09-16 | X0 | squash `c4e9f16`, 3 commits. El publicador de cifras públicas tenía su propia consulta al mayor: publicaba 12 000.00 de ingresos donde el estado de resultados decía 8 000.00, y −8 000.00 en el mes del cierre anual. Las dos cifras iban firmadas. Lo que la auditoría dejó fuera quedó en la #251. |
| [#252](https://github.com/sedecim-com/Accounting/pull/252) | SCOPE.md declaraba abiertos dos defectos de nómina que llevan semanas corregidos | 2026-09-16 | — | squash `fa03d97`, 2 commits. El documento de alcance daba por abiertos la subretención de ISR y el SUA, cerrados en el #193 y el #230, y citaba «~130 criterios» donde `plan:status` responde 179. La cifra se quitó en vez de actualizarse: una cuenta escrita en un documento envejece en silencio. |

## Sin sprint / no clasificado

Ninguno. Todo PR fusionado tiene su fila en alguna de las secciones de arriba, y los **13 commits directos** de antes del flujo por PR viven en la fila «—» del Sprint 1. La cuenta cuadra por los dos lados, medida el 2026-09-16: GitHub reporta **102 PRs fusionados** (`gh api search/issues -f q='repo:sedecim-com/Accounting is:pr is:merged'`) y este documento registra **102**, que es la cifra que publica el censo de arriba contando enlaces `/pull/N`. El #54 sigue siendo el caso con matiz —se mergeó hacia `sux/segundo-lote` y su contenido entró a `main` dentro del squash del #52—, documentado en el Sprint 6.

Esa cuadratura es de un día, no una propiedad. Quien la vuelva a citar que la vuelva a medir: es la misma lección que obligó a escribir el guardián, y la razón de que el censo de arriba se genere en vez de escribirse.

## En curso

**Esto no se escribe: se pregunta.**

```bash
gh pr list --state open
```

Aquí vivía una tabla con una sola fila, la del PR #53, que decía «Abierto, CI en verde». El #53 se fusionó el 2026-09-07 y la fila siguió diciendo lo mismo — en el documento cuya primera línea advierte que no hay que fiarse de la narrativa de un artefacto sin verificarla. Una tabla de lo que está en vuelo caduca por construcción, porque cambia cada día; la de lo ya entregado no, porque el pasado no se mueve.

Medido el **2026-09-08** había **18 PRs abiertos** — diez de trabajo (la serie I del idioma, D1, E1b, J0.2, T4a, T20·2 y dos remates) y seis de dependencias. Esa cifra es un dato de aquel día, no un estado: para el de hoy, la orden de arriba.

## Lo que sigue (Vía A y Vía B)

El plan pendiente —qué falta arreglar y qué falta construir, con evidencia verificada línea por línea— vive ahora como Issues de este repositorio (milestones `Vía A · Lo que ya está mal` y `Vía B · Lo que falta construir`), migradas desde los artefactos de Claude Code. El detalle completo, con cita `archivo:línea` de cada hallazgo, está archivado en `docs/archive/claude-artifacts/plan-maestro-v6.1.html`.

La investigación del 2026-09-06 ([`docs/investigacion/2026-09-06-normas-y-motores/`](investigacion/2026-09-06-normas-y-motores/)) añadió una tercera clase de trabajo, con etiqueta `jurisdiccion`: el tramo **J0** ([#123](https://github.com/sedecim-com/Accounting/issues/123), la jurisdicción como dimensión, diseñado en [`docs/jurisdicciones.md`](jurisdicciones.md)) que va antes de cualquier motor nuevo por país; los índices **J1** ([#124](https://github.com/sedecim-com/Accounting/issues/124), lo que Estados Unidos exige y no existe) y **J2** ([#125](https://github.com/sedecim-com/Accounting/issues/125), lo que México exige y no existe fuera de F07/F08/T8/T18); los corpus normativos **N1** ([#131](https://github.com/sedecim-com/Accounting/issues/131), US GAAP), **N2** ([#132](https://github.com/sedecim-com/Accounting/issues/132), fiscal MX/US) y **N3** ([#133](https://github.com/sedecim-com/Accounting/issues/133), el resto del delta NIIF/NIF) para el agente; y cinco defectos nuevos de la Vía A ([#126](https://github.com/sedecim-com/Accounting/issues/126)–[#130](https://github.com/sedecim-com/Accounting/issues/130), T19–T23) que los escépticos encontraron al verificar el inventario de motores.

El mismo día, el dueño fijó el idioma: **el código en inglés; la interfaz en el idioma del usuario, español primero**. El diseño está en [`docs/language.md`](language.md) (fuente inglesa; gemela [`language.es.md`](language.es.md)) y el inventario que lo sostiene en [`docs/investigacion/2026-09-06-idioma/`](investigacion/2026-09-06-idioma/); las issues llevan la etiqueta `idioma`: el epic [#141](https://github.com/sedecim-com/Accounting/issues/141) y los veintiún tramos **I0–I20** ([#142](https://github.com/sedecim-com/Accounting/issues/142)–[#162](https://github.com/sedecim-com/Accounting/issues/162)), desde la identidad estable de los instrumentos hasta el motor sellado, con J0 renombrado al inglés ([#147](https://github.com/sedecim-com/Accounting/issues/147)) antes de fusionarse, y dos tramos más —I21 ([#164](https://github.com/sedecim-com/Accounting/issues/164)), la documentación con fuente inglesa y gemela española; I22 ([#165](https://github.com/sedecim-com/Accounting/issues/165)), los commits en inglés— cuando el dueño precisó que «todo de origen» incluye comentarios, commits y documentación; y cuatro más —I23 a I26: vocabulario persistido, contratos publicados, migraciones y esquema, informes fechados— cuando lo precisó por segunda vez: «todo al inglés de origen. Todo».

De aquello ya aterrizó la primera capa: **J0.1** (#140) convirtió la jurisdicción en dimensión, y la serie **I** (#172, #174) fijó que el código nace en inglés y la interfaz habla el idioma del usuario, español primero — el rector es [`docs/language.md`](language.md).
