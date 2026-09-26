# ARCHITECTURE — Accounting (mnemosine)

La puerta de entrada que pide el framework (§8): componentes, flujo de datos y cómo encaja en la plataforma, en C4 niveles 1 a 3. El detalle —el núcleo del CLI, el camino completo de un CFDI, la jurisdicción— está en [`docs/wiki/Arquitectura.md`](wiki/Arquitectura.md); este archivo no lo duplica, lo ordena. Las cifras (migraciones, tablas, comandos) no se escriben aquí: se preguntan al árbol, como dice `AGENTS.md`.

## Nivel 1 — Contexto

```text
                   contador del despacho            dueño / auditor
                            |                              |
                            v                              v
  CFDI 4.0 (XML) ---> [ mnemosine: CLI + API REST /v1 ] <--- tablero (PR #249)
  estados de cuenta         |          |          |
                            |          |          +--> proveedores de modelo (propone, nunca postea)
                            |          +-------------> Contalink, PAC, SAT (sólo por la cola revisada)
                            v
             XML Anexo 24, DIOT, SUA, CFDI de nómina ---> el contribuyente los presenta al SAT y al IMSS
```

Ningún otro repo de Sedecim llama a este ni es llamado por él (ver [`platform/inventory.md`](platform/inventory.md)). `accounting-manager`, que hacía una parte de esto, se apaga y se archiva: este repo es la fuente de verdad (ADR-0003).

## Nivel 2 — Contenedores

| Contenedor | Tecnología | Responsabilidad |
|---|---|---|
| CLI `mnemosine` | Node 20, Commander | El producto: lo que el contador opera |
| API REST `/v1` | Express 4 | La misma lógica para el tablero y las integraciones; contrato en `docs/openapi.json` |
| Base contable | PostgreSQL con RLS forzada | Dueño único del mayor; aislamiento por inquilino y por entidad |
| Limitador | Redis | Sólo el rate limit de la API |
| Bóveda | AWS Secrets Manager (`local-dev` en desarrollo) | e.firma y CSD cifrados, con consentimiento versionado |

## Nivel 3 — Componentes

Cada capa sólo llega a la siguiente, y ninguna se salta el motor de posteo.

| Capa | Dónde vive | Qué impone |
|---|---|---|
| CLI | `src/cli/` sobre `src/cli/kernel/` | Riesgo declarado por comando, vocabulario cerrado, contrato de salida y códigos de salida |
| API | `src/api/rest/` | Mismos servicios que el CLI; alcance por inquilino y entidad en cada ruta |
| Agente | `src/ai/` | Ninguna herramienta escribe el mayor ni sale al mundo; lo de terceros entra como no confiable (`src/ai/untrusted.ts`) |
| Escrituras en dos tiempos | `src/ai/draft-service.ts`, `src/ai/external-service.ts`, `src/ai/floor.ts` | Lo que el agente propone queda en `ai_drafts` o `ai_external_ops`; el suelo se combina con `Math.min` |
| Servicios | `src/services/` | Reglas contables y fiscales; el panel de decisiones en `src/services/policy/` |
| Base | `src/database/` | RLS (`src/database/rls-policies.sql`), alcance en el SQL (`src/database/scope.ts`), migraciones inmutables |
| Plan como código | `src/plan/` | Los criterios ejecutables que miden qué está hecho |

El mapa módulo por módulo está en [`REPO_MAP.md`](REPO_MAP.md).

## El flujo que no se puede romper

Un CFDI llega al mayor por una sola puerta, `createJournalEntry` en `src/services/accounting/posting.ts`:

1. **Pre-registro** (`src/services/xml-ingestion/`): parseo, validación SAT y deduplicación por UUID.
2. **Clasificación:** si una regla determinista casa, crea el plan de asiento. Si no, el agente propone un borrador en `ai_drafts`, leyendo el XML como dato no confiable.
3. **Umbrales por suelo** (`src/ai/floor.ts`): por encima del tope, nada se auto-postea, diga lo que diga la configuración.
4. **La persona dispone:** la aprobación relee el borrador bajo candado de fila, recalcula su hash canónico y revalida contra el catálogo vigente.
5. **Posteo:** periodo abierto, folio atómico, cuadre y rastro de auditoría en la misma transacción.

El recorrido con cada módulo está en [`wiki/Arquitectura.md`](wiki/Arquitectura.md), «El camino de un CFDI hasta el mayor».

## Decisiones

Las decisiones con su porqué están en [`adr/`](adr/README.md). El punto de partida, cómo está construido hoy y por qué, es [`adr/0000-legacy-baseline.md`](adr/0000-legacy-baseline.md).
