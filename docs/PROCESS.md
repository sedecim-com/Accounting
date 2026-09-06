# PROCESS — cómo trabajamos

Este documento describe el flujo real, no uno aspiracional. Si algo aquí no coincide con `CONTRIBUTING.md` o con lo que la CI exige hoy, gana la CI, y este archivo se corrige en el mismo PR.

## El ciclo

```
plan (issues + criterios ejecutables)
  → un ejecutor toma UNA issue
  → implementa contra src/plan/criterios.ts (si cierra o reabre un paquete)
  → PR contra main, CI en verde, 1 aprobación
  → review por otro vendor (ver docs/ROUTING.md)
  → merge
  → docs/HISTORY.md se actualiza si el PR cierra un sprint/hito
```

## 1. El plan escribe issues, no código

Una issue describe **qué** debe ser cierto al terminar, con criterios de aceptación verificables — no una lista de archivos a tocar (eso lo decide quien implementa). Usa `.github/ISSUE_TEMPLATE/ticket.md`.

Si la issue proviene de un tramo ya redactado en la secuencia del plan (Vía A o Vía B — ver `docs/HISTORY.md` y los artefactos archivados en `docs/archive/claude-artifacts/`), copia su "por qué aquí" y su dependencia declarada: no los reinventes.

## 2. Un ejecutor implementa UNA issue

Un PR = una issue = un tema. Un PR que arregla tres cosas no se puede revisar ni revertir (`CONTRIBUTING.md`). Rama con nombre propio, nunca `patch-1`.

Si el cambio cierra un paquete de `src/plan/criterios.ts`, el criterio (o el nuevo criterio que lo prueba) se añade a `--exigir` en `.github/workflows/ci.yml` **en el mismo commit**. Si lo reabre, se quita ahí mismo y se dice por qué en el cuerpo del PR — la reapertura viaja en el diff, a la vista, nunca en un comentario aparte.

## 3. PR + CI

Las puertas, en el orden en que fallan más barato:

```bash
npm run typecheck          # tsc --noEmit sobre src/
npm run typecheck:tests    # tsc -p tsconfig.test.json --noEmit
npm test                   # vitest run (unitarias, con cobertura por archivo sobre el motor contable)
npm run lint                # ESLint 9 con información de tipos; advertencias con trinquete (--max-warnings)
npm run plan:status         # el estado del plan no se escribe: se pregunta
npm run test:integration     # necesita Postgres real; corre en CI aparte (aislamiento por inquilino)
```

CI exige en verde: **Tipos**, **Pruebas unitarias**, **Integración contra Postgres**, **Aislamiento por inquilino**, **Estado del plan**. Un rojo se arregla, no se explica en un comentario (`CONTRIBUTING.md`).

## 4. Review por otro vendor

Ningún cambio se aprueba a sí mismo. La revisión la hace un modelo/CLI **distinto** del que implementó (ver `docs/ROUTING.md`) — el objetivo es una segunda mirada con sesgos distintos, no una firma ceremonial.

## 5. Si el plan está mal: comentar y PARAR

Si al implementar descubres que la issue pide algo que el código ya no necesita, que contradice un invariante de `AGENTS.md`, o que su "por qué" ya no es cierto (verifícalo contra el árbol real, no contra la memoria de un artefacto viejo — ver la lección de `docs/HISTORY.md` sobre las Sprint 1/2/3 que el propio Plan de cierre citaba con hashes de commit que ya no existen en `main`): **comenta la issue explicando qué encontraste y detente.** No la reinterpretes en silencio ni la cierres sin decirlo. Quien mantiene el plan decide si la issue se reescribe, se cierra sin implementar, o se confirma tal cual.

## 6. Historia

Cuando un PR cierra el último ítem de un sprint (milestone), añade su fila a `docs/HISTORY.md` y cierra el milestone. No se reescribe el pasado: un sprint cerrado con deuda conocida se documenta con esa deuda, no se retoca para parecer limpio.

## Mensajes de commit

En español, con el código del tramo cuando exista (ver `CONTRIBUTING.md` para ejemplos). El cuerpo explica el **porqué**, no el diff.
