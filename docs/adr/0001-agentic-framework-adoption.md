# ADR-0001 · Adoptar el Framework de Desarrollo de Software Agéntico, adaptado a un solo repositorio

- **Fecha:** 2026-09-25
- **Estado:** aceptada para lo marcado «aplicado»; lo marcado «decisión» espera al dueño en su issue. **La fila §1 («un solo repo») la sustituye el [ADR-0002](0002-platform-coordination.md).**
- **Fuente:** [Framework de Desarrollo de Software Agéntico para la Plataforma](https://claude.ai/artifact/V5nLbNQmVkbCDpZfMkUx6A), revisión 31.
- **Índice de lo pendiente:** [#330](https://github.com/sedecim-com/Accounting/issues/330).

## Contexto

En este repositorio trabajan agentes todos los días: la mayoría de los PRs fusionados los escribió una sesión de agente. Ya tenía disciplinas más estrictas que muchas de las del framework:

- el plan como criterios ejecutables verificados por mutación;
- los siete invariantes de `AGENTS.md`;
- el revisor Witness;
- trinquetes que sólo bajan.

Le faltaba, en cambio, la **maquinaria de trabajo con agentes** que el framework describe:

- una Definition of Ready;
- dificultad y autonomía como ejes separados;
- un comando único de verificación;
- el mapa del repo antes de explorar;
- presupuestos de tokens y checkpoints;
- una máquina de estados del issue.

El framework está escrito para una **plataforma de muchos repos** con despliegue a producción. Este es **un repo**, sin producción declarada. Aplicarlo al pie de la letra crearía artefactos sin lector: un `catalog-info.yaml` sin catálogo, o una rama `release` sin despliegue. En esta casa eso es «catálogo decorativo» (invariante 6).

## Decisión

Se aplica lo que tiene lector hoy, se adapta lo que supone varios repos, y se difiere, con issue, lo que exige una decisión o infraestructura.

| § | Práctica del framework | Estado | Dónde / por qué |
|---|---|---|---|
| 0 | Contexto explícito, docs-as-code | ya existía | `AGENTS.md`, `docs/`, wiki; revisado por PR |
| 0 | Las pruebas son la especificación | ya existía, más estricto | Criterios de `src/plan/criterios.ts` verificados por mutación |
| 0 | Humano en el loop en los puntos de riesgo | ya existía | Invariante 1 (el agente del producto) y `CODEOWNERS` (el código) |
| 0 | Mínimo privilegio para agentes | **decisión** | Hoy los agentes empujan con la identidad del dueño → [#331](https://github.com/sedecim-com/Accounting/issues/331) |
| 1 | Platform Scope, catálogo, matriz de impacto | adaptado | Un solo repo: el «impacto» de cada issue se declara sobre los **contratos de este repo**: la API (`docs/openapi.json`), los entregables al SAT y al IMSS, el esquema y la superficie del CLI |
| 2 | SCOPE con la plantilla y por entrevista | **aplicado** + decisión | `docs/SCOPE.md` gana TL;DR y las secciones de la plantilla, marcadas `[inferido]`; la entrevista con el autor es [#337](https://github.com/sedecim-com/Accounting/issues/337) |
| 3 | Etiquetas de comentario (`TODO(#n)`, `NOTE:`, `SECURITY:`…) | **aplicado** como regla; CI diferido | Regla en `AGENTS.md`; el check con línea base es [#334](https://github.com/sedecim-com/Accounting/issues/334) |
| 3 | Idioma único por repo, declarado en `AGENTS.md` | ya existía | «El idioma: dónde va cada cosa» en `AGENTS.md` |
| 4.2 | Estructura estándar del repo | **aplicado** en parte | Nuevos: `docs/adr/`, `docs/REPO_MAP.md` y `scripts/verify.sh`. Diferidos: `CHANGELOG.md` → [#338](https://github.com/sedecim-com/Accounting/issues/338); `RUNBOOK.md` → [#333](https://github.com/sedecim-com/Accounting/issues/333), al primer despliegue |
| 4.3 | Tipado estricto, linter, mismos checks en local que en CI | ya existía + **aplicado** | `strict`, ESLint con tipos; `scripts/verify.sh` es el «pre-commit» manual, idéntico a CI |
| 4.5 | Secretos, SAST, dependencias y SBOM | parcial + diferido | CodeQL y Dependabot existen; push protection y SBOM → [#338](https://github.com/sedecim-com/Accounting/issues/338) |
| 4.6 | Umbrales (80 % código nuevo, complejidad ≤ 10) | **decisión** | Conviven con los trinquetes por archivo → [#339](https://github.com/sedecim-com/Accounting/issues/339) |
| 5 | Definition of Ready, dificultad D1–D4 con puntaje, autonomía A1–A3 | **aplicado** | Plantilla de issue; `docs/ROUTING.md` con la rúbrica y el ruteo de modelos; las issues de la ruta al MVP reclasificadas (etiquetas `difficulty:*`, `autonomy:*`, `status:*`) |
| 5 | A3 por defecto en repos con PII o funciones financieras reguladas | **aplicado** | Este repo tiene las dos cosas: A3 es el valor por omisión, y bajar de nivel se justifica |
| 6 | Plantilla de PR (cómo probar, humano y agente, riesgo y rollback, `agent-authored`) | **aplicado** | `.github/pull_request_template.md`, conservando los invariantes de la casa |
| 6 | Título en Conventional Commits | **decisión** | Choca con el asunto narrativo con código de tramo, y con I22 (#165) → [#338](https://github.com/sedecim-com/Accounting/issues/338) |
| 7 | Ramas `develop` y `release`, canal por RBAC | diferido | Sin producción no hay qué promover → [#333](https://github.com/sedecim-com/Accounting/issues/333) |
| 8 | `README.md` para humanos y `AGENTS.md` para agentes, con `CLAUDE.md` que remite | ya existía + **aplicado** | `AGENTS.md` gana Comandos, Límites y Definition of Done, y sigue por debajo de 200 líneas |
| 9 | Ciclo del agente y detenerse tras tres fallas | **aplicado** | `AGENTS.md` y `docs/PROCESS.md` |
| 10.1 | Presupuestos por nivel | **aplicado** como tabla; sin cumplimiento automático | `docs/ROUTING.md`. Hacerlos cumplir necesita un orquestador → [#332](https://github.com/sedecim-com/Accounting/issues/332) |
| 10.5 | Mapa antes que exploración; no leer completo un archivo grande | **aplicado** | `docs/REPO_MAP.md`, generado por `scripts/repo-map.ts --check`, lista los 43 archivos de 1 000 líneas o más |
| 10.6 | Salidas silenciosas | **aplicado** | `scripts/verify.sh`: una línea por compuerta y el log en `.agent-logs/` |
| 10.7 | Checkpoints con «No volver a intentar» | **aplicado** | Formato en `AGENTS.md` |
| 10.10 / 11.4 | Medición de tokens y evals de los agentes de desarrollo | diferido | [#336](https://github.com/sedecim-com/Accounting/issues/336). El agente del producto ya tiene su eval |
| 11.1 | Máquina de estados del issue | **aplicado** a mano; orquestador diferido | Etiquetas `status:*` y transiciones en `docs/PROCESS.md`; quien las hace cumplir → [#332](https://github.com/sedecim-com/Accounting/issues/332) |
| 11.3 | Entorno reproducible | diferido | [#335](https://github.com/sedecim-com/Accounting/issues/335) |
| 11.5 | Capacidad de revisión: 2 PRs de agente por revisor | **aplicado** como regla | `docs/PROCESS.md`. El 2026-09-25 había 10 PRs abiertos y un revisor humano |
| 11.6 | Categorías en los comentarios de revisión | **aplicado** como regla | `docs/PROCESS.md` |
| 11.7 | Kill switch | diferido | Con el orquestador → [#332](https://github.com/sedecim-com/Accounting/issues/332) |

**Lo que la casa conserva aunque el framework no lo pida, porque es más fuerte:**

- el criterio con mutante en lugar de sólo «tests en verde»;
- los bloques generados con `--check` en lugar de documentos a mano;
- la fila de `docs/HISTORY.md` por cada PR.

Cuando el framework y la casa difieren, gana la regla que falla antes y más barato.

## Consecuencias

- Una issue sólo pasa a `status:agent-ready` si cumple la Definition of Ready y es D1 o D2. Las D3 y D4 esperan un `/confirmar` humano.
  - Con A3 por omisión y el dinero en casi todo el motor, **la mayoría de la ruta al MVP es D3 con A3**: un agente propone el plan en la issue y un humano lo aprueba antes de implementar.
  - Es más lento por issue y más barato en re-trabajo, que es justo lo que el framework busca.
- Las etiquetas `size-*`, `nivel-L*`, `listo` y `decision-pendiente` del triage del 2026-09-25 se sustituyen por `difficulty:*`, `autonomy:*` y `status:*` en las issues de la ruta al MVP. Las viejas quedan en el repositorio sin uso nuevo.
- `scripts/verify.sh` es desde hoy el «cómo probar» de toda issue y todo PR. Si CI y ese script discrepan, es un bug del script: lee la lista `--exigir` de `ci.yml` precisamente para no divergir.
- Este ADR se revisa cuando se cierre cualquier issue de #330, o cuando aparezca un segundo repositorio. Con dos repos, las secciones 1 y 7 dejan de ser «adaptado» o «diferido».
