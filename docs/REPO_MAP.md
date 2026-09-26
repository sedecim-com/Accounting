# Mapa del repositorio

<!-- NO EDITAR A MANO. Se regenera con: npx tsx scripts/repo-map.ts
     Las descripciones viven en ese script; --check falla si un módulo no tiene la suya. -->

Léelo **antes** de abrir archivos. Ubica el módulo aquí, busca el símbolo con `rg`,
y lee rangos de líneas: los archivos de la lista final no se leen completos.
Qué es cada cosa y por qué: [`docs/SCOPE.md`](SCOPE.md), [`AGENTS.md`](../AGENTS.md),
[`docs/wiki/Arquitectura.md`](wiki/Arquitectura.md).

## Módulos

| Módulo | Qué hay |
|---|---|
| `src/ai/` | El agente: proveedores de modelo, herramientas, la cola de dos tiempos (`ai_drafts`, `ai_external_ops`), el suelo `floor.ts`, la ingesta con IA y la memoria. |
| `src/ai/docs/` | Corpus que el agente lee como verdad (Markdown); sellado contra sus fuentes por `scripts/corpus-manifiesto.ts`. |
| `src/ai/eval/` | Puntuación del golden set del clasificador (`npm run eval`). |
| `src/ai/jobs/` | Trabajos programados del agente: almacén, compuerta de despertar y ejecutor. |
| `src/ai/providers/` | Adaptadores de proveedores de modelo (Anthropic y compatibles con OpenAI). |
| `src/ai/skills/` | Habilidades importables del agente: contenido no confiable, con escáner de confianza y compuerta. |
| `src/ai/tools/` | Herramientas que el agente invoca; leen servicios y proponen, nunca postean. |
| `src/ai/webhooks/` | Entrada de webhooks para el agente y su lector. |
| `src/api/` | Superficie REST (Express) bajo `/v1`. |
| `src/api/rest/middleware/` | Autenticación, contexto de inquilino, auditoría por petición, idempotencia, límites y locale. |
| `src/api/rest/routes/` | Rutas `/v1` por dominio; cada una declara su riesgo y su esquema (de ahí sale `docs/openapi.json`). |
| `src/auth/` | Identidad, roles y permisos compartidos por la terminal y REST. |
| `src/cli/` | El producto: el binario `mnemosine` (Commander), una hoja por familia de comandos. |
| `src/cli/init/` | Asistente de puesta en marcha (`mnemosine init`). |
| `src/cli/kernel/` | Núcleo del CLI: riesgo declarado, marcha seca, `--live`, vocabulario cerrado, salida y códigos de salida. |
| `src/config/` | Configuración leída del entorno. |
| `src/database/` | Pool, migraciones (`migrations/`), políticas RLS, alcance por inquilino y entidad (`scope.ts`) y semillas. |
| `src/gateway/` | Gateway web del tablero, proceso aparte: sesión del navegador y reenvío de sólo lecturas a `/v1`; `app/` es la pantalla que sirve. |
| `src/i18n/` | Catálogos de mensajes por clave (`en.ts`, `es.ts`) y formato por locale. |
| `src/language/` | Registro del vocabulario persistido y su nombre inglés (rector del idioma). |
| `src/plan/` | El plan ejecutable: criterios (`criterios.ts`, que reúne un archivo por paquete en `criteria/`), conducta contra base efímera (`conducta.ts`) y `plan:status`. |
| `src/services/` | Motor de negocio compartido por la terminal, REST y el agente. |
| `src/services/accounting/` | Motor contable: `posting.ts` (única puerta al mayor), periodos, cierre y su conductor, catálogo, apertura, validaciones. |
| `src/services/accruals/` | Devengos mensuales y pagos anticipados. |
| `src/services/ap/` | Cuentas por pagar: proveedores y facturas de compra. |
| `src/services/ar/` | Cuentas por cobrar: clientes, facturas, notas de crédito y controles del auxiliar. |
| `src/services/assets/` | Activo fijo, categorías y depreciación. |
| `src/services/audit/` | Bitácora de auditoría. |
| `src/services/backup/` | Respaldo, verificación por restauración y exportación. |
| `src/services/banking/` | Estados de cuenta, parsers (CSV, MT940, camt053), cotejo y conciliación. |
| `src/services/blockchain/` | Publicación de cifras públicas y su sello (superficie apagada por omisión). |
| `src/services/cache/` | Limitador de tasa, con Redis opcional. |
| `src/services/entity/` | Entidades (sociedades) del inquilino. |
| `src/services/fiscal/` | Periodo fiscal, factores e INPC. |
| `src/services/fiscal-credentials/` | Custodia de e.firma y CSD y su consentimiento (ruta con dueño reforzado). |
| `src/services/fx/` | Tipos de cambio y conversión. |
| `src/services/idempotency/` | Almacén de llaves de idempotencia. |
| `src/services/integrations/` | Adaptadores externos: PAC de timbrado, Contalink, almacenamiento. |
| `src/services/jurisdiction/` | La jurisdicción como dimensión y los parámetros legales con vigencia. |
| `src/services/payments/` | Cobros y pagos: aplicación, anticipos y descuentos. |
| `src/services/payroll/` | Nómina México y Estados Unidos: cálculo, corridas, asiento, SUA y formularios. |
| `src/services/policy/` | Panel de decisiones del despacho: cada bifurcación de criterio contable, con su lector. |
| `src/services/portfolio/` | Cartera del despacho: una fila por entidad del token dentro de su inquilino (`GET /v1/portfolio`). |
| `src/services/reporting/` | Estados financieros, balanza y flujo de efectivo. |
| `src/services/sat/` | Obligaciones ante el SAT: Anexo 24, DIOT y estado de CFDI. |
| `src/services/vault/` | Cifrado y bóveda de secretos (ruta con dueño reforzado). |
| `src/services/webhooks/` | Suscripciones y entrega de webhooks salientes. |
| `src/services/xml-ingestion/` | Lectura de CFDI, pre-registro, taxonomía y decisiones de posteo. |
| `src/types/` | Tipos compartidos. |
| `src/utils/` | Utilidades: fechas de calendario, limpieza de comentarios, CSV, cifrado, secuencias, errores. |

Fuera de `src/`: `tests/` (unitarias por módulo, `tests/integration/` contra Postgres, `tests/fixtures/` sintéticos),
`scripts/` (instrumentos y `verify.sh`), `docs/` (rectores, wiki, auditorías) y `.github/workflows/ci.yml`.

## Archivos de 1000 líneas o más: buscar y leer por rangos

- `scripts/language/extract.ts`
- `scripts/language/lanes/plan.ts`
- `src/ai/doctor-service.ts`
- `src/ai/providers/config.ts`
- `src/cli/bank-command.ts`
- `src/cli/bill-command.ts`
- `src/cli/closing-command.ts`
- `src/cli/entry-command.ts`
- `src/cli/invoice-command.ts`
- `src/cli/mnemosine.ts`
- `src/cli/payroll-isn-command.ts`
- `src/cli/prepaid-command.ts`
- `src/plan/conducta.ts`
- `src/plan/criteria/e0-0.ts`
- `src/plan/criteria/e1-2.ts`
- `src/plan/criteria/e2-1.ts`
- `src/plan/criteria/e4-1.ts`
- `src/plan/criteria/e5-1.ts`
- `src/plan/criteria/shared.ts`
- `src/services/accounting/account-service.ts`
- `src/services/accounting/ar-ap-posting.ts`
- `src/services/accounting/closing-conductor.ts`
- `src/services/accounting/opening-balance.ts`
- `src/services/accounting/period-close.ts`
- `src/services/accounting/sat-agrupadores-catalogo.ts`
- `src/services/ar/invoice-service.ts`
- `src/services/banking/bank-account-service.ts`
- `src/services/banking/bank-statement-service.ts`
- `src/services/banking/match-service.ts`
- `src/services/banking/reconciliation-service.ts`
- `src/services/banking/treasury-posting.ts`
- `src/services/payments/payment-service.ts`
- `src/services/payroll/common/garnishment-service.ts`
- `src/services/policy/pending-catalog.ts`
- `src/services/reporting/cash-flow-service.ts`
- `src/services/reporting/report-service.ts`
- `src/services/sat/anexo24/polizas-service.ts`
- `src/services/xml-ingestion/pre-registration-service.ts`
- `tests/ai/eval/arnes-cableado.spec.ts`
- `tests/ai/memoria-en-conflicto.spec.ts`
- `tests/cli/bank-command.spec.ts`
- `tests/cli/report-command.spec.ts`
- `tests/integration/a6-conductor-y-expediente.int.spec.ts`
- `tests/integration/d1a-ataque.int.spec.ts`
- `tests/integration/f05d-ataque.int.spec.ts`
- `tests/integration/f07a-ataque.int.spec.ts`
- `tests/integration/f07cd-ataque.int.spec.ts`
- `tests/integration/g1b-ataque.int.spec.ts`
- `tests/services/reporting/report-service.spec.ts`
