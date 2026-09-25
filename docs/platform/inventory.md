# Inventario — sedecim-com/Accounting

> Entrada de este repo en el inventario de la plataforma (guía de implementación, Fase 1). Su destino es `platform-docs/inventory/accounting.md`; vive aquí mientras `platform-docs` no exista (ver [README](README.md)). Levantada el 2026-09-25 por un agente, leyendo el código, el historial y los repos vecinos. Todo lo marcado `[inferido]` lo confirma el owner.

## Ficha

| Dato | Valor | Fuente |
|---|---|---|
| Lenguaje y runtime | TypeScript estricto, Node 20 | `package.json`, `tsconfig.json`, `.github/workflows/ci.yml` |
| Framework | Express 4 (API REST), Commander (CLI), PostgreSQL con RLS | `package.json`, `docs/wiki/Arquitectura.md` |
| Actividad | Activo: 455 commits en 12 meses, el último el 2026-09-25 | `git log --since='12 months ago' origin/main` |
| Autores principales | @vic2099; Dependabot; dos commits de otra persona de Sedecim | `git shortlog -sne` |
| Qué expone | CLI `mnemosine`; API REST `/v1` (contrato v0: `docs/openapi.json`); `/public/v1` apagada por omisión; archivos para el SAT y el IMSS | `docs/SCOPE.md`, «Interacciones» |
| Qué consume de otros repos | Nada | búsqueda de URLs y clientes HTTP en `src/` |
| Qué consume de terceros | Contalink, SAT (estado de CFDI), PAC, proveedores de modelo, AWS Secrets Manager, zkVerify | `catalog-info.yaml`, campo `external` |
| Datos | Postgres propio (dueño único), Redis sólo para el limitador de la API | `src/config/index.ts`, `src/api/rest/middleware/rate-limiter.ts` |
| Datos personales | Sí: RFC, domicilio fiscal, CURP, NSS, sueldos, e.firma y CSD cifrados | `docs/SCOPE.md`, «Datos y clasificación» |
| Configuración | Todas las variables en `.env.example`, documentadas en `docs/wiki/Puesta-en-marcha.md` | — |
| Salud | CI con tipos, lint, unitarias e integración con cobertura, aislamiento, restauración, plan, eval y CodeQL; `scripts/verify.sh`; README, AGENTS.md y SCOPE | `.github/workflows/`, ADR-0001 |
| Secretos en el historial | **Sin escanear.** No hay gitleaks ni trufflehog en el entorno; CI no corre escaneo de secretos (#338) | — |

Clasificación de la Fase 1: **Activo**.

## Relación con otros repos de Sedecim

Se revisaron los repos activos del dominio financiero y los que comparten vocabulario: `accounting-manager`, `Cobranza`, `acceso-contracts` y `acceso-backend`. Ninguno llama a este repo ni es llamado por él. Uno se le parece mucho:

### `accounting-manager` — variante `[inferido]`

| | `Accounting` (este repo) | `accounting-manager` |
|---|---|---|
| Qué hace | Contabilidad de partida doble completa: catálogo, pólizas, bancos, cierre, reportes, fiscal MX; agente que propone y una persona aprueba | Recibe XML de CFDI, genera pólizas y las envía a Contalink |
| Stack | TypeScript, Express, PostgreSQL | JavaScript, Express, Sequelize, MySQL |
| Contalink | Sistema externo: lee para migrar y comparar balanza; escribe sólo por la cola revisada `ai_external_ops` | Destino: crea pólizas por su API |
| Pruebas | Suite unitaria, de integración y criterios con mutantes | `npm test` sin pruebas |

**Riesgo:** si los dos escriben pólizas en Contalink para la misma entidad, la misma factura se contabiliza dos veces, y ninguno de los dos lo ve.

**Decisión pendiente** (guía, Fase 1: «se decide cuál es la fuente de verdad; los demás se fusionan o archivan»): cuál de los dos es la fuente de verdad de la póliza que llega a Contalink. Está en #342 y como pregunta abierta en `docs/SCOPE.md`.

### Los demás

- **`Cobranza`** — cobranza por descuento de nómina (SEP). Es el candidato natural a productor de un evento de pago aplicado que este repo podría contabilizar; hoy no hay integración ni contrato.
- **`acceso-*`** (contratos, backend, organizaciones, RBAC) — la plataforma de crédito. Sin relación directa hoy. Si la plataforma centraliza la identidad, `acceso-rbac` y `authentication-server-api` son las contrapartes naturales del OIDC que este repo ya admite (`AUTH_OIDC_*`).

## Dependencias huérfanas y configuración muerta

Variables que la configuración lee y que ningún código usa: `PLAID_*` y `ELASTICSEARCH_URL`. Son deuda, no dependencias: se quitan o se cablean.

## Qué falta para cerrar la Fase 1 en este repo

- [ ] El owner confirma los campos `# inferido` de `catalog-info.yaml`.
- [ ] Escaneo del historial completo con gitleaks o trufflehog; lo que aparezca se rota antes de limpiarlo (#338).
- [ ] Decidir la fuente de verdad frente a `accounting-manager` (#342).
