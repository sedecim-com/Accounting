# PROCESS — cómo trabajamos

Este documento describe el flujo real, no uno aspiracional. Si algo aquí no coincide con `CONTRIBUTING.md` o con lo que la CI exige hoy, gana la CI, y este archivo se corrige en el mismo PR.

## El ciclo

```
plan (issues + criterios ejecutables)
  → un ejecutor toma UNA issue
  → implementa contra src/plan/criteria/<paquete>.ts (si cierra o reabre un paquete)
  → PR contra main, CI en verde, 1 aprobación
  → review por otro vendor (ver docs/ROUTING.md)
  → merge
  → docs/HISTORY.md se actualiza si el PR cierra un sprint/hito
```

## 1. El plan escribe issues, no código

Una issue describe **qué** debe ser cierto al terminar, con criterios de aceptación verificables — no una lista de archivos a tocar (eso lo decide quien implementa). Usa `.github/ISSUE_TEMPLATE/ticket.md`.

Toda issue pasa por la **Definition of Ready** antes de que alguien la tome. Qué exige está en la plantilla `.github/ISSUE_TEMPLATE/ticket.md`: objetivo, criterios Dado/Cuando/Entonces, impacto en contratos, fuera de alcance, cómo probar y tamaño de menos de ~400 líneas. Lleva además tres etiquetas:

- `difficulty:D1`…`D4`, un puntaje de 5 dimensiones que decide modelo y presupuesto;
- `autonomy:A1`…`A3`, que decide la supervisión;
- un `status:*` (§7).

La rúbrica está en [`docs/ROUTING.md`](ROUTING.md) y el porqué en [ADR-0001](adr/0001-agentic-framework-adoption.md). Las de la ruta al MVP llevan también `ola-N` ([`docs/MVP.md`](MVP.md) §6).

Si la issue proviene de un tramo ya redactado en la secuencia del plan (Vía A o Vía B — ver `docs/HISTORY.md` y los artefactos archivados en `docs/archive/claude-artifacts/`), copia su "por qué aquí" y su dependencia declarada: no los reinventes.

## 2. Un ejecutor implementa UNA issue

Un PR = una issue = un tema. Un PR que arregla tres cosas no se puede revisar ni revertir (`CONTRIBUTING.md`). Rama con nombre propio, nunca `patch-1`.

Si el cambio cierra un paquete del tablero (`src/plan/criteria/<paquete>.ts`), el criterio (o el nuevo criterio que lo prueba) se añade a `--exigir` en `.github/workflows/ci.yml` **en el mismo commit**. Si lo reabre, se quita ahí mismo y se dice por qué en el cuerpo del PR — la reapertura viaja en el diff, a la vista, nunca en un comentario aparte.

## 3. PR + CI

Las puertas, en el orden en que fallan más barato. `scripts/verify.sh` las corre todas, igual que CI, con una línea por puerta y los logs en `.agent-logs/`; la lista `--exigir` la lee de `ci.yml`:

```bash
npm run typecheck          # tsc --noEmit sobre src/
npm run typecheck:tests    # tsc -p tsconfig.test.json --noEmit
npm test                   # vitest run (unitarias, con cobertura por archivo sobre el motor contable)
npm run lint                # ESLint 10 con información de tipos; advertencias con trinquete (--max-warnings)
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

## 7. Estados de una issue, y la capacidad de quien revisa

Una issue está en **un solo** estado, que es su etiqueta `status:*`. Mientras no haya orquestador (#332), los cambia quien hace la acción, y deja un comentario.

| Estado | Etiqueta | Quién la pone | Sale cuando |
|---|---|---|---|
| Triage | `status:triage` | Quien la abre (la plantilla la trae) | Cumple la DoR y está clasificada; en D3–D4, un humano comenta `/confirmar` |
| Aclaración | `status:needs-clarification` | Quien encuentra la pregunta, escrita en la issue con su destinatario | El dueño contesta en la issue |
| Lista | `status:agent-ready` | Triage (D1–D2) o el humano que confirma (D3–D4) | Alguien la toma |
| En trabajo | `status:agent-working` | Quien la toma. Es un candado: dos agentes no toman la misma | Abre el PR. Tras 24 h sin actividad, vuelve a Lista |
| Revisión de plan | `status:plan-review` | El agente, en A2 y A3, con su plan escrito en la issue | Un humano comenta `/aprobar-plan` |
| En revisión | `status:in-review` | Quien abre el PR con CI en verde | Se fusiona (`Closes #n` cierra la issue) o se piden cambios |
| Cambios pedidos | `status:changes-requested` | Quien revisa | El autor responde cada comentario con un commit o una justificación |
| Escalada | `status:escalated` | El agente, al agotar su tope o tras 3 fallas (`docs/ROUTING.md`) | Un humano decide en un día hábil |
| Bloqueada | `status:blocked` | Cualquiera, nombrando lo que bloquea | Se cierra lo que bloqueaba |

**Capacidad de revisión.** Los agentes producen PRs más rápido de lo que una persona los revisa. Sin límite, la cola crece y los PRs acaban aprobándose sin leerse. Por eso:

- como máximo **2 PRs de agente abiertos por revisor humano activo**; al llegar al límite no se toma trabajo nuevo;
- la primera revisión llega en 1 día hábil para D1–D2 y en 2 para D3;
- un PR de más de 400 líneas se puede rechazar sin revisarlo;
- un PR sin actividad humana en 5 días hábiles se cierra con un checkpoint y su issue vuelve a Lista.

**Categorías en la revisión.** Cada comentario humano en un PR de agente empieza con una:

- `[estilo]`, `[arquitectura]`, `[regla-de-negocio]`, `[pruebas]`, `[seguridad]` o `[contexto-faltante]`.

Lo que se repite 3 veces o más en un mes se convierte en algo, en este orden de preferencia: un check de CI, un ejemplo de referencia, una aclaración en `SCOPE.md` y, sólo al final, una regla en `AGENTS.md`. Una regla escrita consume contexto en cada sesión; un check, no.

## Mensajes de commit

Con el código del tramo cuando exista (ver `CONTRIBUTING.md` para ejemplos). El cuerpo explica el **porqué**, no el diff.

El idioma pasa al inglés con I22 del epic [#141](https://github.com/sedecim-com/Accounting/issues/141) — decidido, no pendiente. Hasta que ese tramo entre, los commits siguen en español y el que llegue después no se reescribe: un mensaje de commit es registro, y el registro no se retoca.
