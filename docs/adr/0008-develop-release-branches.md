# ADR-0008 · Las ramas `develop` y `release`: `feature → develop → release → main`

- **Fecha:** 2026-09-30
- **Estado:** aceptada por el owner (@vic2099), en [#333](https://github.com/sedecim-com/Accounting/issues/333) y [#337](https://github.com/sedecim-com/Accounting/issues/337).
- **Sustituye:** la fila §7 del [ADR-0001](0001-agentic-framework-adoption.md), que difería las ramas `develop` y `release` hasta el primer despliegue. El resto del ADR-0001 sigue vigente.
- **Numeración:** el 0007 queda reservado para la identidad de la plataforma (#371).

## Contexto

El ADR-0001 difirió `develop` y `release` con un argumento: sin producción no hay qué promover, y una rama sin lector es catálogo decorativo. El costo de esa decisión apareció después, en [`docs/platform/maturity.md`](../platform/maturity.md):

- el nivel N1 del modelo de madurez de la plataforma exige las dos ramas, y la guía no deja saltarse niveles;
- la misma guía dice que ningún agente escribe código en un repo por debajo de N3, y en este repo los agentes escriben código todos los días;
- quedaban dos salidas, y ninguna era de un agente: adelantar #333 o registrar en la plataforma una excepción para repos sin despliegue ([ADR-0002](0002-platform-coordination.md), Consecuencias).

El owner eligió la primera. `develop` y `release` existen en `origin` desde el 2026-09-30, creadas desde `main` en `70acac8`.

## Decisión

**El flujo es `feature → develop → release → main`.**

- Una rama de trabajo nace de `develop` y su PR va contra `develop`.
- `release` se corta de `develop` cuando hay algo que entregar, y se fusiona a `main` con un tag.
- `main` sólo recibe fusiones de `release`, pasada la transición de abajo. Cómo se trata un arreglo urgente sobre `main` no se decidió aquí.

**La transición:**

1. Los PRs que ya están abiertos contra `main` terminan ahí; no se les cambia la base.
2. Después, `develop` se sincroniza desde `main` con una fusión (`git merge`, nunca `rebase` ni `push --force`: `AGENTS.md`, «Conflictos»).
3. Desde entonces, todo PR de trabajo nuevo va contra `develop`.

**La CI corre igual en las tres ramas.** `push` en `.github/workflows/ci.yml` pasa de `[main]` a `[main, develop, release]`; `pull_request` ya corría contra cualquier base.

**Lo que se descartó:** la excepción de plataforma para repos sin despliegue. Habría dejado a este repo con una regla distinta de la de sus vecinos, y la regla que el repo ya iba a necesitar al primer despliegue se habría escrito dos veces.

## Consecuencias

- **Protección de ramas, pendiente.** Las ramas existen, pero sus reglas de protección (PR obligatorio, comprobaciones requeridas, sin `push --force`) son un ajuste de GitHub del owner, fuera del árbol. Hasta que el owner las active, `develop` y `release` **no están protegidas**, y ningún documento debe decir lo contrario.
- **El historial cuenta sobre `main`.** `scripts/historial-estado.ts` cuenta los PRs que entraron a `main` con `git log --first-parent`. Con este flujo, un PR de trabajo entra a `develop` y llega a `main` dentro de la fusión de `release`, así que el conteo y la gracia de siete días de `docs/HISTORY.md` tienen que revisarse con el primer corte de `release`. No se cambian en este ADR.
- **El trinquete del asunto del commit** (`Commit subjects`) ya lee la base del PR (`github.event.pull_request.base.ref`), así que juzga igual un PR contra `develop` que uno contra `main`.
- **Rollback con tag.** Cada fusión de `release` a `main` deja un tag; el rollback de código pasa a ser volver al tag anterior (`docs/RUNBOOK.md`).
- **Madurez.** El criterio de ramas de N1 queda cumplido; el nivel formal sigue dependiendo de los demás criterios de N1 ([`docs/platform/maturity.md`](../platform/maturity.md)).
- Este ADR se revisa en el primer corte de `release`, o cuando el owner active la protección de ramas.
