# Ciclo de un desarrollo nuevo: de la plataforma al backlog

Todo desarrollo nuevo en este repo —una funcionalidad, un módulo o un comando nuevo del CLI— recorre este ciclo **antes** de abrir issues (framework §12). Persigue dos cosas: no construir aquí lo que ya existe en otro repo de Sedecim, y fijar con precisión hasta dónde llega este.

Un arreglo, una deuda o una tarea de la ruta al MVP que ya tiene issue con DoR **no** pasa por aquí: va directo por `docs/PROCESS.md`.

| Paso | Salida | Dónde vive |
|---|---|---|
| 1. Informe de contexto de plataforma | ¿Existe ya en otro repo? | Comentario en la issue épica |
| 2. Entrevista con quienes lo piden | Respuestas sin «depende»; preguntas abiertas con dueño | La issue épica |
| 3. PRD | Requisitos `RF-nn` y `RNF-nn` con criterio de aceptación | `docs/prd/PRD-<nnn>-<slug>.md` |
| 4. System design | Límite del repo, contratos, datos, fallas | `docs/design/SD-<nnn>-<slug>.md` |
| 5. Backlog | Tareas atómicas `MNE-<nnn>-<mm>` | `docs/backlog/PRD-<nnn>.json` y su vista generada; una issue por tarea |

El prefijo `MNE` es el `id_prefix` de `catalog-info.yaml`. Si una tarea cae en otro repo, lleva el prefijo de ese repo y el mismo número de PRD, así la cadena queda trazable.

## 1. Informe de contexto de plataforma

Es obligatorio y va antes de escribir cualquier requisito. Se revisa `catalog-info.yaml` de los repos del dominio, [`docs/platform/inventory.md`](../platform/inventory.md) y, cuando existan, `PLATFORM.md` y los contratos de `platform-docs`.

```markdown
# Informe de contexto — <nombre del desarrollo>

## Capacidades necesarias contra existentes
| Capacidad | ¿Existe? | Repo / contrato | Decisión |
|---|---|---|---|

## Repos que este desarrollo afectaría
| Repo | Impacto (lee · escribe · cambia contrato) | Owner consultado |

## Riesgo de duplicación
<funciones parecidas encontradas y por qué no bastan>
```

| Situación | Decisión |
|---|---|
| Existe y su contrato la cubre | Reutilizar: se consume el contrato, no se reimplementa |
| Existe, pero le falta algo | Extender en el repo dueño, con issue allá |
| No existe y es del dominio contable según `docs/SCOPE.md` | Construir aquí |
| No existe y es de otro dominio | Proponerla a su owner; si se construye aquí, un ADR dice por qué |

**En este repo, antes que nada:** lo que escriba en Contalink respeta la frontera del [ADR-0004](../adr/0004-coexistence-with-accounting-manager.md): un solo escritor por compañía, identificada por RFC. Las comisiones de los agentes de Grupo Promessa las contabiliza `accounting-manager`, no este repo.

## 3. Plantilla de PRD

```markdown
# PRD-<nnn> — <título>
Estado: borrador | en revisión | aprobado · Versión: 1.0 · Owner: @...
Informe de contexto: <enlace> · Entrevista: <enlace>

## 1. Problema y objetivo
## 2. Métricas de éxito
## 3. Usuarios y roles
## 4. Requisitos funcionales
| ID | Requisito | Prioridad (MoSCoW) | Criterio de aceptación (Dado / Cuando / Entonces) |
## 5. Requisitos no funcionales
| ID | Requisito | Meta medible |
## 6. Dentro y fuera de alcance
## 7. Reutilización y dependencias de plataforma
## 8. Supuestos, riesgos y preguntas abiertas
## 9. Aprobaciones
```

El PRD dice *qué* y *por qué*, nunca *cómo*. No se aprueba con una pregunta abierta que bloquee un requisito Must. **Una bifurcación de criterio contable no se resuelve en el PRD:** se declara en el panel de políticas (invariante 6 de `AGENTS.md`).

## 4. Plantilla de system design

`docs/design/SD-<nnn>-<slug>.md`, con el mismo número que su PRD. Se aprueba antes del backlog.

1. **Límite del repo:** tabla de responsabilidad, dónde vive y por qué.
2. **Contratos:** nuevos, modificados (versión y plan expand → migrate → contract) y consumidos.
3. **Modelo de datos y migraciones:** siempre una migración nueva, nunca editar una aplicada.
4. **Flujos** de cada requisito Must.
5. **Fallas:** timeouts, reintentos, idempotencia y compensaciones.
6. **Seguridad y datos personales:** qué toca de `src/services/vault/` o `src/services/fiscal-credentials/`.
7. **Observabilidad.**
8. **Despliegue:** banderas, migraciones y rollback.
9. **Alternativas** y la decisión, o el ADR que la registra.
10. **Trazabilidad:** cada `RF` y `RNF` apunta a su componente. Un requisito sin componente, o un componente sin requisito, bloquea la aprobación.

## 5. Backlog

**El primero es el del MVP:** [PRD-001](PRD-001-mvp.md) → [`docs/backlog/PRD-001.md`](../backlog/PRD-001.md).

- **Qué se edita:** `docs/backlog/PRD-<nnn>.json`. El framework lo llama `.yaml`; aquí es JSON porque el repo no declara un parser de YAML.
- **Qué se regenera:** `npx tsx scripts/backlog.ts` valida el backlog, **calcula el sprint sugerido** —por dependencias, prioridad y capacidad— y escribe la vista.
- **Qué lo vigila:** `tests/scripts/backlog.spec.ts`, dentro de `npm test`, falla si la vista quedó vieja o si una tarea deja de ser atómica.

Una tarea es atómica si tiene un solo resultado verificable, toca un solo repo, cabe en un PR de menos de ~400 líneas y es D1–D3 (una D4 se divide antes de entrar; `docs/ROUTING.md`). Cada tarea se vuelve una issue con la plantilla de `.github/ISSUE_TEMPLATE/`. Si el desarrollo cierra o protege un paquete del plan, su criterio va a `src/plan/criterios.ts` con su mutante.
