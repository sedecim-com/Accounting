# Nivel de madurez — sedecim-com/Accounting

> Autoevaluación contra el modelo N0–N4 de la guía de implementación (§1). Su destino es la fila de este repo en `platform-docs/maturity.md`, que calculará un workflow cuando exista. Evaluada el 2026-09-25 por un agente contra el árbol y la configuración visible; lo que no se pudo ver desde el repo está marcado **sin verificar**.

## Resultado

**Nivel formal: N0.** Cumple casi todo N2 y buena parte de N3, pero la guía no permite saltarse niveles, y N1 exige las ramas `develop` y `release`, que el ADR-0001 difirió a propósito (#333).

**Por qué importa:** la guía dice que ningún agente escribe código en un repo por debajo de N3. Este repo ya trabaja con agentes que escriben código, bajo reglas propias más estrictas que las del framework en varios puntos: criterios con mutantes, siete invariantes y revisión independiente de Witness. Hay que decidir una de dos cosas, y es decisión del owner y del arquitecto de plataforma, no de un agente:

1. Adelantar #333 y crear `develop` y `release` sin tener despliegue; o
2. Registrar en la plataforma una excepción para repos sin despliegue: N1 exige ramas protegidas, no dos ramas.

## Criterio por criterio

### N0 — Inventariado

| Criterio | Estado | Evidencia |
|---|---|---|
| `catalog-info.yaml` | ✅ inferido | `catalog-info.yaml`; falta que el owner confirme los campos |
| Owner asignado | ✅ | `.github/CODEOWNERS` |
| Tier y clasificación de datos | ✅ inferido | tier-1, `pii` |

### N1 — Protegido

| Criterio | Estado | Evidencia |
|---|---|---|
| Rulesets activos | **sin verificar** | Se ve PR obligatorio en la práctica; la configuración no se ve desde el repo |
| Secret scanning | ❌ / sin verificar | No hay escaneo en CI; push protection es un ajuste de GitHub (#338) |
| Escaneo de dependencias | ✅ | Dependabot y CodeQL |
| CODEOWNERS | ✅ | `.github/CODEOWNERS`, con rutas reforzadas |
| Ramas `develop` y `release` | ❌ | Sólo `main`; diferido en ADR-0001 (#333) |

### N2 — Documentado

| Criterio | Estado | Evidencia |
|---|---|---|
| README | ✅ | `README.md` |
| AGENTS.md | ✅ | `AGENTS.md`, con `CLAUDE.md` que apunta a él |
| `docs/SCOPE.md` firmado | ⚠️ | Existe, con secciones `[inferido]`; la firma en entrevista es #337 |
| Contratos v0 publicados | ⚠️ | `docs/openapi.json` existe y CI vigila que no se desvíe del código; falta publicarlo en `platform-docs/contracts/` |

### N3 — Verificable

| Criterio | Estado | Evidencia |
|---|---|---|
| CI con lint, tipos y pruebas | ✅ | `.github/workflows/ci.yml` |
| Pruebas de caracterización de reglas críticas | ✅ | Criterios ejecutables verificados por mutación (`src/plan/criterios.ts`, `npm run mutantes`) |
| Contract tests en sus fronteras | ➖ | No tiene consumidores ni consume contratos de otros repos; aplica cuando los tenga |
| `scripts/verify.sh --agent` | ✅ adaptado | `scripts/verify.sh` es silencioso por omisión: una línea por compuerta y logs en `.agent-logs/` |
| devcontainer | ❌ | #335 |

### N4 — Listo para agentes

| Criterio | Estado | Evidencia |
|---|---|---|
| Issues con DoR | ⚠️ | Plantilla con DoR y clasificación D×A (ADR-0001); la ruta al MVP está reclasificada |
| Set de evals del repo | ❌ | Hay eval del clasificador del producto, no de los agentes que desarrollan (#336) |
| Métricas de agentes en el tablero | ❌ | #332, #336 |
| 30 días sin incidentes atribuibles a agentes | **sin medir** | No hay registro de incidentes por agente |

## Qué cambia el nivel

- **→ N1:** confirmar rulesets, activar push protection o gitleaks en CI (#338), y resolver la decisión de ramas de arriba.
- **→ N2:** firmar el SCOPE (#337) y publicar el contrato v0 cuando exista `platform-docs`.
- **→ N3:** devcontainer y un script de preparación idempotente (#335).
