# Artefactos de Claude Code — archivados, no borrados

Estos cuatro documentos vivieron como artefactos publicados de Claude Code (páginas HTML) mientras el plan se elaboraba fuera de este repositorio. Esta migración los trae a control de versiones sin retocarlos, para que la historia completa quede visible y comprobable. **Desde ahora, la fuente de verdad es este repositorio**: `docs/SCOPE.md`, `docs/HISTORY.md`, y las Issues/Milestones de GitHub.

| Archivo | Qué era | Estado |
|---|---|---|
| `plan-maestro-v6.1.html` | La secuencia de trabajo pendiente, en dos vías: la que sale de una auditoría de 79 hallazgos confirmados (Vía A) y la que sale de la investigación de producto (Vía B) | Migrado a Issues, milestones `Vía A · Lo que ya está mal` y `Vía B · Lo que falta construir` |
| `doce-sprints-catalogo-comandos.html` | El catálogo completo de 1 627 filas de comandos posibles, con el plan de doce sprints por flujo de negocio | Referencia; el catálogo vivo se pregunta con `npm run catalogo:estado` |
| `brechas-de-usabilidad.html` | Auditoría de usabilidad de la CLI: qué hace el sistema hoy, qué le falta, con evidencia de terminal | Referencia; el estado vivo se pregunta con `npm run ux:status` |
| `plan-de-cierre.html` | Los quince paquetes originales de trabajo (E0.0 a E5.1), con sus 147 tareas | Absorbido en `plan-maestro-v6.1.html`, §7 «Los quince paquetes, absorbidos» — ahí se dice qué se cerró, en qué tramo vive lo que quedaba, y qué sigue sin reverificar; lo entregado se verifica contra `docs/HISTORY.md` |

No se retocan estos archivos. Si algo que dicen ya no es cierto, la corrección vive en `docs/HISTORY.md` o en una Issue nueva — nunca editando el archivo histórico.
