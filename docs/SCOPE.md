# SCOPE — qué es mnemosine, para quién, y qué no es

> Documento vivo. Si esta página y la [Issue de scope pineada](../../issues) (label `scope`) discrepan, gana este archivo, y la Issue se actualiza en el mismo PR que lo cambie.

## TL;DR

- **Qué es:** contabilidad de partida doble sobre PostgreSQL, operada desde la terminal (`mnemosine`), con un agente de IA que **propone y nunca dispone**.
- **Para quién:** un despacho contable mexicano con varios clientes. México completo; Estados Unidos, parcial.
- **Lo que no se negocia:** los siete invariantes de [`AGENTS.md`](../AGENTS.md). La IA no escribe el mayor, las consultas llevan alcance, los `UPDATE` van guardados y el criterio contable se declara en el panel.
- **Superficies:** el CLI, que es el producto, y REST (`/v1`). Comparten `src/services/`.
- **El MVP:** el mes de una PyME, de punta a punta. Ver [`docs/MVP.md`](MVP.md) y la issue [#329](https://github.com/sedecim-com/Accounting/issues/329).
- **El objetivo:** un sistema contable CLI completo y multijurisdicción, nativo para IA, con núcleo contable, módulos de nómina y cumplimiento NIF y NIIF. Lo dictó el owner el 2026-11-13; qué significa «completo» y con qué se mide está en [PRD-003](prd/PRD-003-producto-completo.md), en revisión.
- **El estado no se escribe:** se pregunta con `npm run plan:status` y `npm run catalogo:estado`.
- **Dónde está el código:** [`docs/REPO_MAP.md`](REPO_MAP.md).
- **Cómo se trabaja con agentes:** [ADR-0001](adr/0001-agentic-framework-adoption.md), [`docs/ROUTING.md`](ROUTING.md) y [`docs/PROCESS.md`](PROCESS.md).
- **Firmado por el owner el 2026-09-30** ([#337](https://github.com/sedecim-com/Accounting/issues/337)): las secciones que un agente pre-llenó como `[inferido]` están confirmadas, y las preguntas abiertas de la entrevista, contestadas abajo.

## Visión

Un sistema contable **internacional, AI-first y operado desde la terminal**, con un agente de IA que **propone y nunca dispone**. Lleva partida doble sobre PostgreSQL — catálogo, pólizas, clientes y proveedores, bancos, periodos, reportes — y opera de forma automática al recibir la información de las fuentes definidas para cada jurisdicción (CFDI del SAT, estados de cuenta, nómina), cumpliendo las normas contables generales (NIF, US GAAP, IFRS/NIIF) y las particulares de cada país **dentro del motor, no encima de él**.

Empieza por **México y Estados Unidos**. México es la jurisdicción de origen y la más completa (CFDI 4.0, catálogos del SAT, IVA sobre base de flujo, nómina LFT/LSS); Estados Unidos tiene hoy la nómina federal y estatal —con tablas por corregir— y poco más. El diseño hace de cada jurisdicción un **paquete configurable** sobre un motor común, con un panel que permite ajustar sus diferencias ([`docs/jurisdicciones.md`](jurisdicciones.md)); en el código esa frontera todavía no existe (ver «El objetivo»). El inventario verificado de qué motor existe para cada país está en [`docs/investigacion/2026-09-06-normas-y-motores/motores-inventario.md`](investigacion/2026-09-06-normas-y-motores/motores-inventario.md).

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

- **Runtime**: Node ≥ 22.12 (`engines` en `package.json`; es lo que exige vitest 5), TypeScript 6 (el 7 espera a typescript-eslint: [ADR-0005](adr/0005-typescript-6-until-typescript-eslint-supports-7.md)), `tsx` para ejecución directa.
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
- los CFDI hasta el mayor, con el agente proponiendo y una persona aprobando, o sin agente; con la e.firma del cliente, el sistema los descarga del SAT y sabe cuáles faltan y cuáles se cancelaron;
- CxC y CxP;
- banco y conciliación;
- la nómina básica;
- el cierre;
- los estados financieros;
- el Anexo 24, sellado con la e.firma si el despacho lo declara, la DIOT y el papel de trabajo de IVA e ISR;
- con aislamiento y respaldo probados.

Su prueba de aceptación es un criterio ▶ que recorre ese mes entero ([#311](https://github.com/sedecim-com/Accounting/issues/311)).

La definición completa, lo que queda fuera, la línea de trabajo por olas y las decisiones pendientes están en [`docs/MVP.md`](MVP.md). La lista viva de issues está en la issue de seguimiento [#329](https://github.com/sedecim-com/Accounting/issues/329).

Queda fuera del MVP, con sus issues en la etiqueta `post-mvp`:

- el timbrado con PAC;
- Estados Unidos más allá de lo que ya existe;
- la interfaz gráfica;
- los canales de mensajería;
- el renombrado del código al inglés;
- presentar ante el SAT: la contabilidad electrónica, la DIOT y las declaraciones se suben en el portal, igual que el buzón tributario, la opinión de cumplimiento y la constancia se consultan ahí. El SAT no ofrece un servicio web público para eso, y este sistema no raspa el portal.

La e.firma **sí** se usa dentro del MVP para descargar del SAT y para sellar el Anexo 24, por decisión del dueño del 2026-09-28 (#312, MNE-001-140), que reemplazó la del 2026-09-26.

## El objetivo

El MVP es el primer hito, no el producto. El objetivo lo dictó el owner el 2026-11-13:

> un sistema contable CLI completo y multijurisdicción nativo para IA que tenga un core contable y módulos de cálculo de nóminas y cumplimiento de las reglas contables NIF y NIIF

Son siete dimensiones: núcleo contable, multijurisdicción, nómina, NIF, NIIF, CLI completo y nativo para IA. Cada una se mide con un instrumento, no con este párrafo. Qué quiere decir «completo» en cada una, sus requisitos y las decisiones que esperan al owner están en [PRD-003](prd/PRD-003-producto-completo.md), todavía **en revisión**. La foto del árbol contra el objetivo, con su evidencia, es [`docs/auditorias/2026-11-13-contra-el-objetivo/`](auditorias/2026-11-13-contra-el-objetivo/README.md).

Lo que esa revisión deja dicho, para no confundir la visión con el estado:

- **Multijurisdicción todavía no es una propiedad del motor.** El código conoce dos países (`JurisdictionCode = 'MX' | 'US'`), y el paquete por país de [`docs/jurisdicciones.md`](jurisdicciones.md) no existe como frontera.
- **NIIF es hoy conocimiento del agente, no comportamiento.** Ninguna puerta crea una entidad `ifrs`, y ningún motor de medición ni de presentación lee la norma de la entidad: hoy la norma sólo decide, junto con el país, si la entidad recibe el estrato fiscal mexicano.
- **NIF vive dentro de los motores, sin módulo.** Faltan el estado de cambios en el capital, la estructura del estado de resultado integral, los impuestos a la utilidad y las revelaciones.
- **La nómina calcula impuestos sobre importes tecleados** y no corre de punta a punta desde el binario.

## No-goals (declarados, no accidentales)

- **No es un ERP genérico ni un motor «sin país».** No hay módulos fuera de la contabilidad y su cumplimiento, y la internacionalización se hace por **paquetes de jurisdicción** sobre un motor común (`docs/jurisdicciones.md`): catálogo fiscal, calendario, parámetros legales con vigencia, formatos y corpus del agente por país — nunca aflojando las reglas del motor a un común denominador sin normas. Hoy esa frontera es diseño, no código: hay dos países cableados —México, profundo; Estados Unidos, la nómina y poco más—, y construir el paquete es el requisito RF-10 de [PRD-003](prd/PRD-003-producto-completo.md). Sigue vigente la decisión «¿es el sistema contable del despacho, o el motor auditable que se conecta al que ya tienen?» del archivo de Brechas de usabilidad, §5.
- **La ley no se decide y el criterio no se legisla.** Lo que fija la ley (tasas, topes, tablas) va a una tabla con vigencia y fuente oficial; lo que decide el despacho va al panel de políticas con su lector; ninguno de los dos va al prompt ni al chat (`docs/jurisdicciones.md` §2).
- **No timbra ni cancela CFDI todavía.** Cuatro adaptadores de PAC están precargados (Finkok, SW Sapien, Edicom, Sovos/Reachcore) pero no hay hoja de CLI que los use — ver tramo `CFDI·SELLO` en la secuencia.
- **No tiene interfaz gráfica para operar.** El producto es el CLI. `W0–W1` entregó un tablero de **lectura** en el navegador, detrás de un gateway que sólo sostiene la sesión y reenvía lecturas (GET y HEAD) a `/v1`: la cartera del despacho y una vista de entidad. Desde el navegador no se postea, no se sella y no se cierra nada; el panel de pendientes y la revisión de borradores con el CFDI al lado siguen sin existir.
- **La IA no decide criterio contable.** Una bifurcación entre dos tratamientos legítimos va al panel de políticas (`src/services/policy/`), nunca al prompt ni al chat.

## Interacciones

| Dirección | Contrato | Contraparte | Criticidad |
|---|---|---|---|
| Expone | CLI `mnemosine`, su superficie medida por `catalogo:estado` y `ux-status` | El contador | Alta: es el producto |
| Expone | API REST `/v1`, generada y verificada en `docs/openapi.json` | El tablero (PR #249) y las integraciones del despacho | Media |
| Expone | Cifras públicas `/public/v1` | Terceros verificadores | Baja: apagada por omisión |
| Produce | XML del Anexo 24 (catálogo, balanza y pólizas; sellado con la e.firma bajo `sellar_con_custodia`, #442), DIOT, SUA y CFDI de nómina | SAT e IMSS, por medio del contribuyente, que presenta | Alta: un formato mal hecho se descubre al ser rechazado |
| Consume | CFDI 4.0 (XML) y estados de cuenta (CSV, MT940, camt053) | El SAT y los bancos, a través del cliente | Alta |
| Consume | Servicio web de descarga masiva del SAT, autenticado con la e.firma de la bóveda (#439, #440, #441) | El SAT | Alta: sin él no hay completitud automática; el censo por ZIP del portal es el respaldo |
| Consume | Proveedores de modelo (Anthropic y compatibles con OpenAI) | Terceros | Media: hay camino manual sin modelo (#319) |
| Consume | PAC de timbrado (adaptadores precargados, sin hoja) | Terceros con contrato | Fuera del MVP |
| Lee y escribe | Contalink: lee para migrar y comparar balanza; escribe sólo por la cola revisada `ai_external_ops` | Sistema contable externo | Media: `accounting-manager` escribe las comisiones de Grupo Promessa en su compañía; este repo no escribe en una compañía que ya tiene escritor (ADR-0004, #357) |
| Ninguna | Ningún contrato con otro repo de Sedecim. `accounting-manager` convive: contabiliza las comisiones de Grupo Promessa, con un solo escritor por compañía de Contalink (ADR-0004) | Plataforma Sedecim (`docs/platform/inventory.md`) | — |

## Datos y clasificación

- **Datos financieros de terceros:** el mayor, los auxiliares y los CFDI de cada cliente del despacho. La fuente de verdad es el mayor: los informes se derivan, no se guardan aparte.
- **Datos personales:**
  - RFC y domicilio fiscal de clientes y proveedores;
  - de los empleados, en nómina: CURP, NSS, SSN y sueldo;
  - las credenciales fiscales (e.firma, CSD), que van cifradas en `src/services/vault/` y `src/services/fiscal-credentials/` con consentimiento versionado.
- **Aislamiento:** por inquilino con RLS en Postgres, y por entidad en el SQL (invariante 4).
- **Regulación que aplica** (confirmada el 2026-09-30, #337):
  - LFPDPPP, por los datos personales;
  - CFF, por la conservación de la contabilidad y la contabilidad electrónica (Anexo 24);
  - LISR, LIVA, LSS e INFONAVIT, por los cálculos;
  - LFT, por la nómina y las horas extra;
  - las NIF del CINIF, como norma contable.
- **Retención y cifrado** (decisión del owner, 2026-09-30):
  - la contabilidad y los CFDI se conservan 5 años desde la última declaración relacionada (CFF, art. 30), y no se borran antes;
  - las credenciales fiscales y la PII de nómina van cifradas en reposo;
  - la PII se suprime al terminar la relación y su plazo legal (LFPDPPP);
  - los respaldos van cifrados.

## Reglas de negocio invariantes

Las cinco que un cambio no debe romper jamás. Cada una tiene criterios en `src/plan/criteria/`.

1. **Partida doble cuadrada, y el mayor inviolable:** un asiento posteado no se edita, se revierte (migración 041 y paquete E1.2).
2. **Nadie más que `posting.ts` escribe el mayor, y la IA no escribe:** propone en `ai_drafts` y una persona aprueba (invariante 1).
3. **Un periodo cerrado no cambia sin reabrirse,** y la reapertura se propaga a los saldos iniciales siguientes (#99).
4. **El IVA se causa y se acredita sobre flujo:** PPD con su REP, y el IVA pendiente hasta el pago.
5. **Cada cifra que sale** (informes, XML al SAT, SUA) **sale de una sola capa de consulta** y coincide con el mayor (E4.2, X0).

## Zonas sensibles, que requieren revisión humana

- Las rutas con dueño reforzado de `.github/CODEOWNERS`:
  - migraciones;
  - `rls-policies.sql`;
  - `src/ai/floor.ts`;
  - `fiscal-credentials/` y `vault/`;
  - los workflows.
- `src/services/accounting/posting.ts` y el cierre (`period-close.ts`, `closing-conductor.ts`).
- Los generadores de entregables al SAT y al IMSS (`src/services/sat/`, `src/services/payroll/mx/`).
- El panel de políticas (`src/services/policy/`): cada clave nueva es una decisión contable del despacho.

## Operación

- **Despliegue:** no hay un entorno de producción declarado en el repo. Hoy se instala en el equipo del despacho y se opera con el CLI ([`docs/wiki/Puesta-en-marcha.md`](wiki/Puesta-en-marcha.md)).
- **Ramas:** `feature → develop → release → main`, con un tag en cada fusión a `main` ([ADR-0008](adr/0008-develop-release-branches.md), #333). Al 2026-11-13 ese flujo no existe entero: `release` no está en `origin`, `main` no recibe nada desde el 2026-09-29 y no hay tags (`git ls-remote origin`). Ejecutarlo no es una decisión abierta, es una acción del owner: hacer de `develop` la rama por omisión, protegerla y crear `release` en el primer corte ([PRD-003](prd/PRD-003-producto-completo.md) §8). Lo que sí sigue abierto es cómo se concilian esas ramas con el despliegue de la plataforma (#372).
- **Salud:** `mnemosine doctor`, y en REST `/health` y `/ready`.
- **Respaldo:** `mnemosine backup create|verify --restore|restore`. CI ensaya la restauración en cada corrida.
- **Rollback de código:** revertir el PR. Para el esquema, una migración nueva; nunca se edita una aplicada.
- **SLO** (decisión del owner, 2026-09-30):
  - 99.5 % de disponibilidad en horario laboral (lunes a sábado, de 8 a 20 h, hora de la Ciudad de México);
  - el CLI de lectura responde en menos de 2 s al p95;
  - la API `/v1` responde en menos de 500 ms al p95;
  - el cierre de mes no tiene límite de tiempo.

## Deuda conocida

- Los paquetes en rojo de `npm run plan:status`.
- Las issues `via-a`, de lo que ya está mal: la lista y su orden están en #329.
- `docs/criterios-minimos.json`, `SIN_ESPEJO_MAXIMO` de `tests/plan/mutacion.spec.ts` y el `--exigir` de `ci.yml`: cifras a mano en las que todavía pueden chocar dos PRs (#356). Los espejos y las anclas ya no: van en un censo generado, `src/plan/mutation-census.txt` (`npm run mutation:census`), y el tablero va en un archivo por paquete (#294).
- Los archivos de 1 000 líneas o más que lista `docs/REPO_MAP.md`: se buscan y se leen por rangos.

## Preguntas abiertas (dueño · fecha)

| Pregunta | Dueño | Fecha |
|---|---|---|
| Las decisiones pendientes de la ruta al MVP (`status:needs-clarification`) | @vic2099 | ver #329 |
| Las diez decisiones del producto completo: libros por norma, tercera jurisdicción, Estados Unidos, superficies ajenas al objetivo, renombrado interno, bóveda de producción, agentes externos, plataforma, alcance de la nómina y capacidad de revisión | @vic2099 | ver [PRD-003](prd/PRD-003-producto-completo.md) §8 y #603 |

## Preguntas contestadas

| Pregunta | Respuesta | Dueño | Fecha |
|---|---|---|---|
| ¿Qué SLO de disponibilidad y latencia tiene una instalación de despacho? | 99.5 % en horario laboral (L–S, 8–20 h, CDMX); CLI de lectura p95 < 2 s; API `/v1` p95 < 500 ms; cierre de mes sin límite. Ver «Operación» | @vic2099 | 2026-09-30 |
| ¿Qué retención y qué cifrado en reposo se exigen por dato (CFF, LFPDPPP)? | Contabilidad y CFDI, 5 años desde la última declaración relacionada (CFF art. 30), sin borrado antes; credenciales fiscales y PII de nómina cifradas en reposo; la PII se suprime al terminar la relación y su plazo legal (LFPDPPP); respaldos cifrados. Ver «Datos y clasificación» | @vic2099 | 2026-09-30 |
| ¿Qué carpetas no debe tocar nunca un agente, además de las de `CODEOWNERS`? | Ninguna. Las de `CODEOWNERS` tampoco están prohibidas: piden la revisión del owner | @vic2099 | 2026-09-30 |
| ¿Se adelantan `develop` y `release` (#333) para llegar a N1, o la plataforma registra una excepción para repos sin despliegue? | Se crean: existen en `origin` desde el 2026-09-30, creadas desde `main` en `70acac8`. El flujo es [ADR-0008](adr/0008-develop-release-branches.md). **Al 2026-11-13 la respuesta ya no describe el repositorio:** `develop` recibe el trabajo, pero `release` no está en `origin` (ver «Operación», Ramas) | @vic2099 | 2026-09-30 |

## Riesgos conocidos

- **Concentración de conocimiento.** El diseño (criterios ejecutables, el panel de políticas, los invariantes de `AGENTS.md`) vive mayormente en la cabeza de quien lo escribió y en los documentos que este PR crea; sin `docs/HISTORY.md` y sin este archivo, un colaborador nuevo no tiene por dónde entrar.
- **Cadencia de entrega comprimida.** Al 2026-09-15 son **99 PRs fusionados** (del #1 al #247) en una ventana de ~15 días (2026-09-01 → 2026-09-15), varios de ellos por sesiones de agente trabajando en paralelo sobre el mismo árbol. El riesgo no es el ritmo: es que dos sesiones toquen los mismos archivos —`src/plan/criterios.ts`, el piso ordenado, el panel de políticas y el manifiesto del corpus chocan casi siempre— y que una fusión resuelta eligiendo un lado tire trabajo medido. Ver `docs/HISTORY.md` para el detalle verificado contra `git log`, y comprobar la cifra de arriba con `gh pr list --state merged` antes de citarla.
- **Nómina (`src/services/payroll/`) fue el módulo menos auditado del árbol** hasta la auditoría de 2026-09-02 (ver Vía A, tramos T4 y T5). Los dos defectos que esa auditoría encontró **ya están corregidos, y con criterio en el tablero que los vigila**:
  - Subretención de ISR en frecuencias no quincenales — se aplicaba la tarifa MENSUAL a la base de una SEMANA, y encima la del año anterior. Corregido en **#193** (issue #91); con 3 000 semanales se retenía 0.00.
  - El SUA declaraba las cuotas de toda la historia del empleado en el archivo del mes. Corregido en **#230** (issue #92), que además coteja el archivo contra `employer_tax_liabilities` y se niega a emitirlo si discrepan.

  Lo que **sigue abierto** en nómina ya no lo dice E4.1, que está en verde con criterios que leen el fuente y no ejecutan una quincena. Lo dice la revisión del 2026-11-13, y es de otro tamaño: el motor no calcula las percepciones (suma importes tecleados) y el binario no registra los calculadores, que sólo carga el servidor REST. Son los requisitos RF-16 a RF-21 de [PRD-003](prd/PRD-003-producto-completo.md).
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
| 2026-11-14 | El objetivo del producto, dictado por el owner el 2026-11-13, con su PRD en revisión (PRD-003) y la revisión del árbol contra él. Se corrigen las afirmaciones que el árbol ya no sostiene: los paquetes de jurisdicción, también en la Visión; las ramas, con la respuesta del 2026-09-30 anotada; y lo que sigue abierto en nómina | este |
| 2026-09-30 | Firmado por el owner (#337): sin marcas `[inferido]`, la regulación con LFT y NIF, las preguntas de SLO, retención, carpetas y ramas contestadas, y el flujo `develop → release → main` (ADR-0008, #333) | este |
| 2026-09-26 | Corregida la relación con `accounting-manager`: conviven, con un solo escritor por compañía de Contalink (ADR-0004 sustituye al 0003, #342) | este |
| 2026-09-26 | Resuelta la fuente de verdad frente a `accounting-manager`: este repo (ADR-0003, #342) | #347 |
| 2026-09-25 | Interacciones con Contalink y la plataforma Sedecim; dos preguntas abiertas de plataforma (ADR-0002) | #343 |
| 2026-09-25 | TL;DR y las secciones de la plantilla del framework agéntico, marcadas `[inferido]` hasta la entrevista (#337) | #340 |
| 2026-09-25 | Sección «El MVP» | #291 |
| 2026-09-16 | Los defectos de nómina ya corregidos dejan de figurar como abiertos; se quita la cifra de criterios | #252 |
