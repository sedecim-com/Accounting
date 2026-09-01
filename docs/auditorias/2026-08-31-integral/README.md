# Auditoría integral · 2026-08-31 · HEAD 5d24463

Siete lentes en paralelo sobre el árbol completo, al cierre del tramo S0:

| Informe | Lente | Hallazgo mayor |
|---|---|---|
| [maestro-vs-codigo](maestro-vs-codigo.md) | Plan Maestro vs código, afirmación por afirmación | Los 13 commits y los 6 rojos verifican; las cifras de §1 caducaron contra su propio commit; GraphQL y blockchain (~2,250 líneas) sin gobierno |
| [cierre-cobertura](cierre-cobertura.md) | Herencia del plan de cierre (147 tareas) | **E3.2 es un falso verde vivo** (el criterio come prosa); E1.4-a cayó con la fuga del range proof viva; la herencia se hizo a nivel prosa, no tarea |
| [doce-cobertura](doce-cobertura.md) | Herencia de «Doce sprints o sesenta» | El modelo de costes (390 líneas/fila, 12.3%) se midió UNA vez y no tiene instrumento |
| [practicas-ledger](practicas-ledger.md) | Mejores prácticas del núcleo contable | El mayor es **físicamente reescribible** (sin trigger espejo de 033); `account_balances` sin verificación; sin revaluación FX en ningún plan |
| [practicas-fiscal-mx](practicas-fiscal-mx.md) | Cumplimiento fiscal mexicano | El **UUID global** imposibilita dos clientes que se facturan entre sí; la mitad de PRESENTACIÓN es cero código; el bloqueo E3.1/E3.2 es más ancho que la dependencia real |
| [agentic-ai-first](agentic-ai-first.md) | Mejores prácticas agentic-AI | **Cero evals** (la brecha madre); confianza sin calibrar; la sospecha de inyección no es compuerta; el presupuesto E5.1-e se cayó del plan |
| [seguridad-multitenant](seguridad-multitenant.md) | Seguridad multi-tenant y credenciales | La bitácora inmutable guarda **PII en claro** (`req.body` a `audit_log`); arranque no fail-closed con BYPASSRLS; webhooks salientes con SSRF/replay |

El Plan Maestro (artifact) absorbe estos hallazgos en su secuencia: S1 (cierres de una tarde),
tramo R (el mayor inviolable), tramo A (el agente medible) y los flujos F01–F12 ajustados.
Cada afirmación de los informes lleva evidencia archivo:línea verificada contra HEAD 5d24463.
