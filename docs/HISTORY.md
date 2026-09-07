# Historial de entrega

Este documento reconstruye, **verificado contra `git log` y contra `gh pr view` línea por línea** (no contra la prosa de artefactos anteriores), qué se entregó y en qué PR aterrizó. La lección que obligó a este método: el artefacto "Plan de cierre" citaba commits de un "Sprint 1" y un "Sprint 2" —IVA-1, IVA-2, IVA-3, AUD-1, ESQ-1, HON-1, TEN-1, E1.1-a, E1.1-b, E2.2, E1.4-b, AUD-3— y **ninguno de esos hashes existe hoy en `main`**: el trabajo real se hizo por otro camino (una segunda sesión de agente trabajando en paralelo) y quedó documentado bajo otros nombres. Confiar en la narrativa de un artefacto sin volver a verificarla contra el árbol real habría fabricado un historial falso.

**Cómo se construyó esta tabla:** `git log --first-parent origin/main` da la columna vertebral de merges; para cada commit de dos padres se calculó `git log <primer-padre>..<segundo-padre>` para obtener exactamente los commits que ese merge introdujo (no los que la rama de origen *dice* tener en la API de PRs, que puede incluir commits ya fusionados por otro camino). Resultado: 191 commits, cada uno asignado a **exactamente un** PR — verificado, cero duplicados. El método tiene una consecuencia que conviene decir: un PR mergeado hacia una rama que NO es `main` aparece con **cero commits propios**, aunque su contenido sí haya llegado — a través del squash de otro PR. Es exactamente el caso del #54 (A5): se mergeó hacia `sux/segundo-lote` a las 02:50Z del 2026-09-03 y catorce minutos después el #52, cuya rama de origen era esa misma, se squasheó hacia `main` como `d8882d5`. Los árboles de `main` y `sux/segundo-lote` son idénticos (`git diff --quiet` no devuelve nada): A5 está entregado, dentro del #52.

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

## Sin sprint / no clasificado

Ninguno. Los 41 PRs mergeados y los 13 commits directos a `main` quedaron ubicados en alguno de los seis sprints de arriba, verificado por `git log`. El único caso con matiz es el #54, cuyo contenido llegó a `main` por el squash del #52 y no por un merge propio — está en el Sprint 6 con esa nota, no aquí. `PR #53` (G0 y G3) está **abierto** — ver más abajo.

## En curso

| PR | Título | Estado | Tramos |
|---|---|---|---|
| [#53](https://github.com/sedecim-com/Accounting/pull/53) | G0 y G3: poner un timeout destapó un cierre a 27 segundos de morir, y el control de cuatro ojos tenía cuatro puertas | Abierto, CI en verde | G0, G3 |

## Lo que sigue (Vía A y Vía B)

El plan pendiente —qué falta arreglar y qué falta construir, con evidencia verificada línea por línea— vive ahora como Issues de este repositorio (milestones `Vía A · Lo que ya está mal` y `Vía B · Lo que falta construir`), migradas desde los artefactos de Claude Code. El detalle completo, con cita `archivo:línea` de cada hallazgo, está archivado en `docs/archive/claude-artifacts/plan-maestro-v6.1.html`.

La investigación del 2026-09-06 ([`docs/investigacion/2026-09-06-normas-y-motores/`](investigacion/2026-09-06-normas-y-motores/)) añadió una tercera clase de trabajo, con etiqueta `jurisdiccion`: el tramo **J0** ([#123](https://github.com/sedecim-com/Accounting/issues/123), la jurisdicción como dimensión, diseñado en [`docs/jurisdicciones.md`](jurisdicciones.md)) que va antes de cualquier motor nuevo por país; los índices **J1** ([#124](https://github.com/sedecim-com/Accounting/issues/124), lo que Estados Unidos exige y no existe) y **J2** ([#125](https://github.com/sedecim-com/Accounting/issues/125), lo que México exige y no existe fuera de F07/F08/T8/T18); los corpus normativos **N1** ([#131](https://github.com/sedecim-com/Accounting/issues/131), US GAAP), **N2** ([#132](https://github.com/sedecim-com/Accounting/issues/132), fiscal MX/US) y **N3** ([#133](https://github.com/sedecim-com/Accounting/issues/133), el resto del delta NIIF/NIF) para el agente; y cinco defectos nuevos de la Vía A ([#126](https://github.com/sedecim-com/Accounting/issues/126)–[#130](https://github.com/sedecim-com/Accounting/issues/130), T19–T23) que los escépticos encontraron al verificar el inventario de motores.

El mismo día, el dueño fijó el idioma: **el código en inglés; la interfaz en el idioma del usuario, español primero**. El diseño está en [`docs/idioma.md`](idioma.md) y el inventario que lo sostiene en [`docs/investigacion/2026-09-06-idioma/`](investigacion/2026-09-06-idioma/); las issues llevan la etiqueta `idioma`: el tramo **I0** (reglas, metro, lint, identidad estable de los instrumentos) y los que cuelgan de él, I1–I9.
