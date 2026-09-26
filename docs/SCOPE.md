# SCOPE — qué es mnemosine, para quién, y qué no es

> Documento vivo. Si esta página y la [Issue de scope pineada](../../issues) (label `scope`) discrepan, gana este archivo, y la Issue se actualiza en el mismo PR que lo cambie.

## TL;DR

- **Qué es:** contabilidad de partida doble sobre PostgreSQL, operada desde la terminal (`mnemosine`), con un agente de IA que **propone y nunca dispone**.
- **Para quién:** un despacho contable mexicano con varios clientes. México completo; Estados Unidos, parcial.
- **Lo que no se negocia:** los siete invariantes de [`AGENTS.md`](../AGENTS.md). La IA no escribe el mayor, las consultas llevan alcance, los `UPDATE` van guardados y el criterio contable se declara en el panel.
- **Superficies:** el CLI, que es el producto, y REST (`/v1`). Comparten `src/services/`.
- **El MVP:** el mes de una PyME, de punta a punta. Ver [`docs/MVP.md`](MVP.md) y la issue [#329](https://github.com/sedecim-com/Accounting/issues/329).
- **El estado no se escribe:** se pregunta con `npm run plan:status` y `npm run catalogo:estado`.
- **Dónde está el código:** [`docs/REPO_MAP.md`](REPO_MAP.md).
- **Cómo se trabaja con agentes:** [ADR-0001](adr/0001-agentic-framework-adoption.md), [`docs/ROUTING.md`](ROUTING.md) y [`docs/PROCESS.md`](PROCESS.md).
- **Las secciones marcadas `[inferido]`** las pre-llenó un agente; su confirmación con el autor es [#337](https://github.com/sedecim-com/Accounting/issues/337).

## Visión

Un sistema contable **internacional, AI-first y operado desde la terminal**, con un agente de IA que **propone y nunca dispone**. Lleva partida doble sobre PostgreSQL — catálogo, pólizas, clientes y proveedores, bancos, periodos, reportes — y opera de forma automática al recibir la información de las fuentes definidas para cada jurisdicción (CFDI del SAT, estados de cuenta, nómina), cumpliendo las normas contables generales (NIF, US GAAP, IFRS/NIIF) y las particulares de cada país **dentro del motor, no encima de él**.

Empieza por **México y Estados Unidos**. México es la jurisdicción de origen y la más completa (CFDI 4.0, catálogos del SAT, IVA sobre base de flujo, nómina LFT/LSS); Estados Unidos tiene hoy la nómina federal y estatal —con tablas por corregir— y poco más. Cada jurisdicción es un **paquete configurable** sobre un motor común, con un panel que permite ajustar sus diferencias — el diseño está en [`docs/jurisdicciones.md`](jurisdicciones.md) y el inventario verificado de qué motor existe para cada país en [`docs/investigacion/2026-09-06-normas-y-motores/motores-inventario.md`](investigacion/2026-09-06-normas-y-motores/motores-inventario.md).

## El problema

Un despacho contable mexicano lleva varios clientes en la misma instalación. Cada CFDI que entra debe clasificarse, contabilizarse y, en varios casos, esperar a su REP antes de que el IVA se cause o se acredite. Un agente de IA puede acelerar la clasificación y la captura — pero un agente que puede escribir directamente al mayor es un riesgo de control interno, no una ayuda. mnemosine resuelve esto separando **quién decide** de **quién escribe**.

## Para quién es

- Un despacho contable mexicano con varios clientes (multi-inquilino).
- Un contador independiente que lleva los suyos.
- El despacho o la PyME que lleva entidades en México **y** en Estados Unidos desde la misma instalación — con la salvedad de que la jurisdicción estadounidense está en el estado que declara el inventario de motores, no en el que sugiere el esquema.
- En ambos casos, alguien que **ya sabe contabilidad**: el CLI propone una póliza y espera que un humano la juzgue; no explica qué es una póliza.

No es, hoy, un producto para quien no sabe contabilidad ni para quien nunca ha visto una terminal. Desde `W0–W1` existe un **tablero de sólo lectura** en el navegador —la cartera del despacho y la vista de una entidad—, que no sustituye al CLI: no escribe nada. Ver `docs/wiki/El-tablero-grafico.md` para lo que es y lo que falta, y la Vía B de la secuencia (§1) para el resto del plan.

## Qué lo distingue

**La IA nunca postea el mayor ni toca un sistema externo por su cuenta.** Propone en dos tiempos — `ai_drafts` para los asientos, `ai_external_ops` para todo lo que sale al mundo (timbrar, enviar, pagar) — y una persona aprueba. La aprobación es un registro con integridad (atado al hash de lo que el revisor vio), no una bandera.

Los límites que gobiernan esto viven en código — `src/ai/floor.ts` — y se combinan **sólo con `Math.min`**: ninguna configuración, política guardada, ni bandera futura de "aprobar siempre" puede subirlos. Ver los siete invariantes en [`CONTRIBUTING.md`](../CONTRIBUTING.md) y su versión-contrato en [`AGENTS.md`](../AGENTS.md).

## Stack (verificado, no memorizado — vuelve a correr esto si dudas)

```bash
node -e "const p=require('./package.json'); console.log(p.name, p.version, p.engines)"
```

- **Runtime**: Node ≥ 22.12 (`engines` en `package.json`; es lo que exige vitest 5), TypeScript, `tsx` para ejecución directa.
- **Base de datos**: PostgreSQL 15, con Row-Level Security como perímetro multi-inquilino (no un filtro en la capa de aplicación).
- **Superficies**: CLI (`src/cli/`, comando `mnemosine`) y REST (`src/api/rest/`, Express). Hubo una tercera, GraphQL con Apollo Server, apagada tras una bandera y sin un solo consumidor: se **retiró** en T14b ([#101](https://github.com/sedecim-com/Accounting/issues/101)). Una superficie que nadie ejerce no se blinda, se quita — y mientras existía, el criterio que la vigilaba se ponía verde con sólo mudar su montaje de archivo.
- **Pruebas**: Vitest (unitarias + integración contra Postgres real), con umbrales de cobertura **por archivo** sobre el motor contable (`vitest.config.ts`) que sólo pueden endurecerse, nunca aflojarse.
- **El plan mismo es código**: `src/plan/criterios.ts` reúne los criterios ejecutables, escritos en un archivo por paquete bajo `src/plan/criteria/`, y `npm run plan:status` los evalúa contra el árbol real. **Este archivo no lleva la cuenta a propósito** — una cifra escrita aquí envejece en silencio, y ya lo hizo: decía «~130» cuando el comando respondía 179. Pregúntaselo al comando. Ver `docs/PROCESS.md`.

## Qué SÍ hace hoy (verificar, no citar de memoria)

```bash
npm run catalogo:estado   # cuántos comandos responde el binario, de cuántos declarados
npm run plan:status       # qué paquetes de trabajo tienen todos sus criterios en verde
```

Un resumen de alto nivel, agrupado por área del oficio (catálogo y asiento, banco y tesorería, clientes y cobranza, proveedores y pagos, lo fiscal mexicano, el agente, informes, activos y diferidos, puesta en marcha) vive en el artefacto **Brechas de usabilidad de mnemosine**, archivado en `docs/archive/claude-artifacts/brechas-de-usabilidad.html`.

## El MVP

**Un despacho lleva, desde el CLI y con cifras correctas, el ciclo mensual completo de un cliente PyME mexicano:**

- el alta y la migración desde su sistema anterior;
- los CFDI hasta el mayor, con el agente proponiendo y una persona aprobando, o sin agente;
- CxC y CxP;
- banco y conciliación;
- la nómina básica;
- el cierre;
- los estados financieros;
- el Anexo 24, la DIOT y el papel de trabajo de IVA e ISR;
- con aislamiento y respaldo probados.

Su prueba de aceptación es un criterio ▶ que recorre ese mes entero ([#311](https://github.com/sedecim-com/Accounting/issues/311)).

La definición completa, lo que queda fuera, la línea de trabajo por olas y las decisiones pendientes están en [`docs/MVP.md`](MVP.md). La lista viva de issues está en la issue de seguimiento [#329](https://github.com/sedecim-com/Accounting/issues/329).

Queda fuera del MVP, con sus issues en la etiqueta `post-mvp`:

- el timbrado con PAC;
- Estados Unidos más allá de lo que ya existe;
- la interfaz gráfica;
- los canales de mensajería;
- el renombrado del código al inglés.

## No-goals (declarados, no accidentales)

- **No es un ERP genérico ni un motor «sin país».** No hay módulos fuera de la contabilidad y su cumplimiento, y la internacionalización se hace por **paquetes de jurisdicción** sobre un motor común (`docs/jurisdicciones.md`): catálogo fiscal, calendario, parámetros legales con vigencia, formatos y corpus del agente por país — nunca aflojando las reglas del motor a un común denominador sin normas. Hoy hay dos paquetes: México, completo; Estados Unidos, parcial (nómina). Sigue vigente la decisión «¿es el sistema contable del despacho, o el motor auditable que se conecta al que ya tienen?» del archivo de Brechas de usabilidad, §5.
- **La ley no se decide y el criterio no se legisla.** Lo que fija la ley (tasas, topes, tablas) va a una tabla con vigencia y fuente oficial; lo que decide el despacho va al panel de políticas con su lector; ninguno de los dos va al prompt ni al chat (`docs/jurisdicciones.md` §2).
- **No timbra ni cancela CFDI todavía.** Cuatro adaptadores de PAC están precargados (Finkok, SW Sapien, Edicom, Sovos/Reachcore) pero no hay hoja de CLI que los use — ver tramo `CFDI·SELLO` en la secuencia.
- **No tiene interfaz gráfica para operar.** El producto es el CLI. `W0–W1` entregó un tablero de **lectura** en el navegador, detrás de un gateway que sólo sostiene la sesión y reenvía lecturas (GET y HEAD) a `/v1`: la cartera del despacho y una vista de entidad. Desde el navegador no se postea, no se sella y no se cierra nada; el panel de pendientes y la revisión de borradores con el CFDI al lado siguen sin existir.
- **La IA no decide criterio contable.** Una bifurcación entre dos tratamientos legítimos va al panel de políticas (`src/services/policy/`), nunca al prompt ni al chat.

## Interacciones `[inferido]`

| Dirección | Contrato | Contraparte | Criticidad |
|---|---|---|---|
| Expone | CLI `mnemosine`, su superficie medida por `catalogo:estado` y `ux-status` | El contador | Alta: es el producto |
| Expone | API REST `/v1`, generada y verificada en `docs/openapi.json` | El tablero (PR #249) y las integraciones del despacho | Media |
| Expone | Cifras públicas `/public/v1` | Terceros verificadores | Baja: apagada por omisión |
| Produce | XML del Anexo 24 (catálogo, balanza y pólizas), DIOT, SUA y CFDI de nómina | SAT e IMSS, por medio del contribuyente, que presenta | Alta: un formato mal hecho se descubre al ser rechazado |
| Consume | CFDI 4.0 (XML) y estados de cuenta (CSV, MT940, camt053) | El SAT y los bancos, a través del cliente | Alta |
| Consume | Proveedores de modelo (Anthropic y compatibles con OpenAI) | Terceros | Media: hay camino manual sin modelo (#319) |
| Consume | PAC de timbrado (adaptadores precargados, sin hoja) | Terceros con contrato | Fuera del MVP |
| Lee y escribe | Contalink: lee para migrar y comparar balanza; escribe sólo por la cola revisada `ai_external_ops` | Sistema contable externo | Media: `accounting-manager` escribe las comisiones de Grupo Promessa en su compañía; este repo no escribe en una compañía que ya tiene escritor (ADR-0004, #357) |
| Ninguna | Ningún contrato con otro repo de Sedecim. `accounting-manager` convive: contabiliza las comisiones de Grupo Promessa, con un solo escritor por compañía de Contalink (ADR-0004) | Plataforma Sedecim (`docs/platform/inventory.md`) | — |

## Datos y clasificación `[inferido]`

- **Datos financieros de terceros:** el mayor, los auxiliares y los CFDI de cada cliente del despacho. La fuente de verdad es el mayor: los informes se derivan, no se guardan aparte.
- **Datos personales:**
  - RFC y domicilio fiscal de clientes y proveedores;
  - de los empleados, en nómina: CURP, NSS, SSN y sueldo;
  - las credenciales fiscales (e.firma, CSD), que van cifradas en `src/services/vault/` y `src/services/fiscal-credentials/` con consentimiento versionado.
- **Aislamiento:** por inquilino con RLS en Postgres, y por entidad en el SQL (invariante 4).
- **Regulación que probablemente aplica** (confirmar en #337):
  - LFPDPPP, por los datos personales;
  - CFF, por la conservación de la contabilidad y la contabilidad electrónica (Anexo 24);
  - LISR, LIVA, LSS e INFONAVIT, por los cálculos.

## Reglas de negocio invariantes `[inferido]`

Las cinco que un cambio no debe romper jamás. Cada una tiene criterios en `src/plan/criteria/`.

1. **Partida doble cuadrada, y el mayor inviolable:** un asiento posteado no se edita, se revierte (migración 041 y paquete E1.2).
2. **Nadie más que `posting.ts` escribe el mayor, y la IA no escribe:** propone en `ai_drafts` y una persona aprueba (invariante 1).
3. **Un periodo cerrado no cambia sin reabrirse,** y la reapertura se propaga a los saldos iniciales siguientes (#99).
4. **El IVA se causa y se acredita sobre flujo:** PPD con su REP, y el IVA pendiente hasta el pago.
5. **Cada cifra que sale** (informes, XML al SAT, SUA) **sale de una sola capa de consulta** y coincide con el mayor (E4.2, X0).

## Zonas sensibles, que requieren revisión humana `[inferido]`

- Las rutas con dueño reforzado de `.github/CODEOWNERS`:
  - migraciones;
  - `rls-policies.sql`;
  - `src/ai/floor.ts`;
  - `fiscal-credentials/` y `vault/`;
  - los workflows.
- `src/services/accounting/posting.ts` y el cierre (`period-close.ts`, `closing-conductor.ts`).
- Los generadores de entregables al SAT y al IMSS (`src/services/sat/`, `src/services/payroll/mx/`).
- El panel de políticas (`src/services/policy/`): cada clave nueva es una decisión contable del despacho.

## Operación `[inferido]`

- **Despliegue:** no hay un entorno de producción declarado en el repo. Hoy se instala en el equipo del despacho y se opera con el CLI ([`docs/wiki/Puesta-en-marcha.md`](wiki/Puesta-en-marcha.md)). Ramas y promoción, al primer despliegue: #333.
- **Salud:** `mnemosine doctor`, y en REST `/health` y `/ready`.
- **Respaldo:** `mnemosine backup create|verify --restore|restore`. CI ensaya la restauración en cada corrida.
- **Rollback de código:** revertir el PR. Para el esquema, una migración nueva; nunca se edita una aplicada.
- **SLO:** no declarados → pregunta abierta.

## Deuda conocida `[inferido]`

- Los paquetes en rojo de `npm run plan:status`.
- Las issues `via-a`, de lo que ya está mal: la lista y su orden están en #329.
- `MIRRORS_FLOOR` y `ANCHORS_HERE` en `src/plan/criteria/e0-0.ts`: cuentas exactas en las que siguen chocando los PRs que añaden espejos (#356). El resto del tablero ya no choca: va en un archivo por paquete (#294).
- Los archivos de 1 000 líneas o más que lista `docs/REPO_MAP.md`: se buscan y se leen por rangos.

## Preguntas abiertas (dueño · fecha)

| Pregunta | Dueño | Fecha |
|---|---|---|
| ¿Qué SLO de disponibilidad y latencia tiene una instalación de despacho? | @vic2099 | 2026-10-09 |
| ¿Qué retención y qué cifrado en reposo se exigen por dato (CFF, LFPDPPP)? | @vic2099 | 2026-10-09 |
| ¿Qué carpetas no debe tocar nunca un agente, además de las de `CODEOWNERS`? | @vic2099 | 2026-10-09 |
| Las decisiones pendientes de la ruta al MVP (`status:needs-clarification`) | @vic2099 | ver #329 |
| ¿Se adelantan `develop` y `release` (#333) para llegar a N1, o la plataforma registra una excepción para repos sin despliegue? (`docs/platform/maturity.md`) | @vic2099 | 2026-10-09 |

## Riesgos conocidos

- **Concentración de conocimiento.** El diseño (criterios ejecutables, el panel de políticas, los invariantes de `AGENTS.md`) vive mayormente en la cabeza de quien lo escribió y en los documentos que este PR crea; sin `docs/HISTORY.md` y sin este archivo, un colaborador nuevo no tiene por dónde entrar.
- **Cadencia de entrega comprimida.** Al 2026-09-15 son **99 PRs fusionados** (del #1 al #247) en una ventana de ~15 días (2026-09-01 → 2026-09-15), varios de ellos por sesiones de agente trabajando en paralelo sobre el mismo árbol. El riesgo no es el ritmo: es que dos sesiones toquen los mismos archivos —`src/plan/criterios.ts`, el piso ordenado, el panel de políticas y el manifiesto del corpus chocan casi siempre— y que una fusión resuelta eligiendo un lado tire trabajo medido. Ver `docs/HISTORY.md` para el detalle verificado contra `git log`, y comprobar la cifra de arriba con `gh pr list --state merged` antes de citarla.
- **Nómina (`src/services/payroll/`) fue el módulo menos auditado del árbol** hasta la auditoría de 2026-09-02 (ver Vía A, tramos T4 y T5). Los dos defectos que esa auditoría encontró **ya están corregidos, y con criterio en el tablero que los vigila**:
  - Subretención de ISR en frecuencias no quincenales — se aplicaba la tarifa MENSUAL a la base de una SEMANA, y encima la del año anterior. Corregido en **#193** (issue #91); con 3 000 semanales se retenía 0.00.
  - El SUA declaraba las cuotas de toda la historia del empleado en el archivo del mes. Corregido en **#230** (issue #92), que además coteja el archivo contra `employer_tax_liabilities` y se niega a emitirlo si discrepan.

  Lo que **sigue abierto** en nómina no son esos dos: es que las retenciones judiciales (`garnishments`) se leen y nadie las escribe, así que los formularios 941/940 reportan ceros. Lo dice en rojo el criterio `La nómina escribe los impuestos que sus formularios reportan` (E4.1) — no este párrafo.
- **El límite de PAC/timbrado real es un contrato con un proveedor externo** (ver decisiones bloqueantes en la secuencia, §5): no lo resuelve una sesión de agente sola.

## Referencia

- Issue de scope pineada: (label `scope`, creada por este mismo PR — ver el número real en `docs/MIGRATION.md`, porque el #1 de este repositorio ya lo tiene un Pull Request).
- Plan ejecutable vivo: `src/plan/criterios.ts` (índice) + `src/plan/criteria/` + `npm run plan:status`.
- Historia de entrega: [`docs/HISTORY.md`](HISTORY.md).
- La jurisdicción como dimensión (diseño rector del panel por jurisdicción): [`docs/jurisdicciones.md`](jurisdicciones.md).
- Investigación normativa y de motores (2026-09-06): [`docs/investigacion/2026-09-06-normas-y-motores/`](investigacion/2026-09-06-normas-y-motores/).
- Cómo trabajamos: [`docs/PROCESS.md`](PROCESS.md).
- Quién ejecuta cada nivel: [`docs/ROUTING.md`](ROUTING.md).

## Historial de revisión

| Fecha | Cambio | PR |
|---|---|---|
| 2026-09-26 | Corregida la relación con `accounting-manager`: conviven, con un solo escritor por compañía de Contalink (ADR-0004 sustituye al 0003, #342) | este |
| 2026-09-26 | Resuelta la fuente de verdad frente a `accounting-manager`: este repo (ADR-0003, #342) | #347 |
| 2026-09-25 | Interacciones con Contalink y la plataforma Sedecim; dos preguntas abiertas de plataforma (ADR-0002) | #343 |
| 2026-09-25 | TL;DR y las secciones de la plantilla del framework agéntico, marcadas `[inferido]` hasta la entrevista (#337) | #340 |
| 2026-09-25 | Sección «El MVP» | #291 |
| 2026-09-16 | Los defectos de nómina ya corregidos dejan de figurar como abiertos; se quita la cifra de criterios | #252 |
