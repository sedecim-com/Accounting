# Nivel de madurez — sedecim-com/Accounting

> Autoevaluación contra el modelo N0–N4 de la guía de implementación (§1). Su destino es la fila de este repo en `platform-docs/maturity.md`, que calculará un workflow cuando exista. Evaluada el 2026-09-25 por un agente contra el árbol y la configuración visible, y actualizada el 2026-09-30 con la firma del SCOPE (#337) y las ramas (#333, ADR-0008); lo que no se pudo ver desde el repo está marcado **sin verificar**.

## Resultado

**Nivel formal: N0.** Cumple casi todo N2 y buena parte de N3, pero la guía no permite saltarse niveles. Las ramas `develop` y `release` ya no son lo que falta para N1: existen desde el 2026-09-30 ([ADR-0008](../adr/0008-develop-release-branches.md)). Faltan el escaneo de secretos (#338), confirmar los rulesets y proteger las ramas nuevas.

**Por qué importa:** la guía dice que ningún agente escribe código en un repo por debajo de N3. Este repo ya trabaja con agentes que escriben código, bajo reglas propias más estrictas que las del framework en varios puntos: criterios con mutantes, siete invariantes y revisión independiente de Witness. La decisión que esto pedía —adelantar #333 o registrar una excepción para repos sin despliegue— la tomó el owner el 2026-09-30: se adelantó #333.

## Criterio por criterio

### N0 — Inventariado

| Criterio | Estado | Evidencia |
|---|---|---|
| `catalog-info.yaml` | ✅ | `catalog-info.yaml`; campos confirmados por el owner el 2026-09-30 (#337) |
| Owner asignado | ✅ | `.github/CODEOWNERS` |
| Tier y clasificación de datos | ✅ | tier-1, `pii`; confirmados el 2026-09-30 (#337) |

### N1 — Protegido

| Criterio | Estado | Evidencia |
|---|---|---|
| Rulesets activos | **sin verificar** | Se ve PR obligatorio en la práctica; la configuración no se ve desde el repo |
| Secret scanning | ❌ / sin verificar | No hay escaneo en CI; push protection es un ajuste de GitHub (#338) |
| Escaneo de dependencias | ✅ | Dependabot y CodeQL |
| CODEOWNERS | ✅ | `.github/CODEOWNERS`, con rutas reforzadas |
| Ramas `develop` y `release` | ✅ | Existen en `origin` desde el 2026-09-30, creadas desde `main` en `70acac8`; el flujo es ADR-0008 (#333). Su **protección está pendiente**: es un ajuste de GitHub del owner, y hasta que lo active no están protegidas |

### N2 — Documentado

| Criterio | Estado | Evidencia |
|---|---|---|
| README | ✅ | `README.md` |
| AGENTS.md | ✅ | `AGENTS.md`, con `CLAUDE.md` que apunta a él |
| `docs/SCOPE.md` firmado | ✅ | Firmado por el owner el 2026-09-30 (#337); sin secciones `[inferido]` |
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

- **→ N1:** confirmar rulesets, activar push protection o gitleaks en CI (#338), y proteger `develop` y `release` en GitHub.
- **→ N2:** publicar el contrato v0 cuando exista `platform-docs`.
- **→ N3:** devcontainer y un script de preparación idempotente (#335).
