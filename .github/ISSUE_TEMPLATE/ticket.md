---
name: Ticket de trabajo
about: Una unidad de trabajo lista para una persona o un agente — qué debe ser cierto al terminar, no qué archivos tocar
title: ''
labels: 'status:triage'
assignees: ''
---

<!--
Definition of Ready (docs/PROCESS.md §1 y docs/ROUTING.md). Una issue pasa a
`status:agent-ready` sólo si tiene TODO lo de abajo, es D1–D2 y no está bloqueada;
en D3–D4 además hace falta `/confirmar` de un humano. Si un desarrollador nuevo no
podría resolverla sin preguntar, un agente tampoco.
-->

## Objetivo

<!-- Una oración, con el resultado para el contador o el despacho. -->

## Tramo y contexto

- **Tramo:** <!-- código del plan (T4, F07e, O1c…) o «nuevo» -->
- **Por qué ahora:** <!-- copiado del "por qué aquí" de la secuencia si existe; si viene de una auditoría, archivo:línea y reproducción -->
- **Relacionado:** <!-- #issue, PR, docs/adr/NNNN, sección de docs/SCOPE.md -->

## Criterios de aceptación

<!-- Verificables, en Dado / Cuando / Entonces. Cada uno se convierte en una prueba. -->

- [ ] Dado …, cuando …, entonces ….

## Impacto

<!-- Contratos de este repo que cambian: API publicada (docs/openapi.json), entregables al SAT/IMSS, esquema (migración), superficie del CLI (catálogo). «Ninguno» también es respuesta. -->

| Contrato | Impacto (ninguno · compatible · rompe) | Acción |
|---|---|---|
| | | |

## Pistas de implementación

- **Archivos probables:** <!-- ver docs/REPO_MAP.md -->
- **Patrón a seguir:** <!-- enlace a código existente bien hecho -->

## Fuera de alcance

-

## Cómo probar

- `scripts/verify.sh`, y la prueba específica: <!-- ruta del spec -->
- **Datos:** fixtures sintéticos en `tests/fixtures/` (nunca datos reales).
- **Casos borde:**

## Clasificación

<!-- La llena el triage; ver la rúbrica en docs/ROUTING.md. -->

| Alcance | Ambigüedad | Novedad | Riesgo | Verificabilidad | Total → nivel |
|---|---|---|---|---|---|
| | | | | | D? |

- **Autonomía:** A1 | A2 | A3. Este repo es **A3 por omisión**: tiene PII y funciones financieras reguladas.
- **Tamaño estimado:** ~N líneas. Si pasa de ~400, dividir antes de `agent-ready`.

## Restricciones

<!-- Invariantes de AGENTS.md que aplican especialmente; rutas que no se tocan; decisiones que van al panel (invariante 6). -->

## Depende de

<!-- Otra issue, o «ninguna». Si depende de una abierta: `status:blocked`. -->
