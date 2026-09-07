# SCOPE — qué es mnemosine, para quién, y qué no es

> Documento vivo. Si esta página y la [Issue de scope pineada](../../issues) (label `scope`) discrepan, gana este archivo, y la Issue se actualiza en el mismo PR que lo cambie.

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

No es, hoy, un producto para quien no sabe contabilidad ni para quien nunca ha visto una terminal — ver `docs/wiki/El-tablero-grafico.md` y la Vía B de la secuencia (§1) para el plan de una interfaz gráfica.

## Qué lo distingue

**La IA nunca postea el mayor ni toca un sistema externo por su cuenta.** Propone en dos tiempos — `ai_drafts` para los asientos, `ai_external_ops` para todo lo que sale al mundo (timbrar, enviar, pagar) — y una persona aprueba. La aprobación es un registro con integridad (atado al hash de lo que el revisor vio), no una bandera.

Los límites que gobiernan esto viven en código — `src/ai/floor.ts` — y se combinan **sólo con `Math.min`**: ninguna configuración, política guardada, ni bandera futura de "aprobar siempre" puede subirlos. Ver los siete invariantes en [`CONTRIBUTING.md`](../CONTRIBUTING.md) y su versión-contrato en [`AGENTS.md`](../AGENTS.md).

## Stack (verificado, no memorizado — vuelve a correr esto si dudas)

```bash
node -e "const p=require('./package.json'); console.log(p.name, p.version, p.engines)"
```

- **Runtime**: Node ≥ 20 (`engines` en `package.json`), TypeScript, `tsx` para ejecución directa.
- **Base de datos**: PostgreSQL 15, con Row-Level Security como perímetro multi-inquilino (no un filtro en la capa de aplicación).
- **Superficies**: CLI (`src/cli/`, comando `mnemosine`), REST (`src/api/rest/`, Express), GraphQL (`src/api/graphql/`, Apollo Server — apagado por bandera por omisión).
- **Pruebas**: Vitest (unitarias + integración contra Postgres real), con umbrales de cobertura **por archivo** sobre el motor contable (`vitest.config.ts`) que sólo pueden endurecerse, nunca aflojarse.
- **El plan mismo es código**: `src/plan/criterios.ts` declara ~130 criterios ejecutables; `npm run plan:status` los evalúa contra el árbol real. Ver `docs/PROCESS.md`.

## Qué SÍ hace hoy (verificar, no citar de memoria)

```bash
npm run catalogo:estado   # cuántos comandos responde el binario, de cuántos declarados
npm run plan:status       # qué paquetes de trabajo tienen todos sus criterios en verde
```

Un resumen de alto nivel, agrupado por área del oficio (catálogo y asiento, banco y tesorería, clientes y cobranza, proveedores y pagos, lo fiscal mexicano, el agente, informes, activos y diferidos, puesta en marcha) vive en el artefacto **Brechas de usabilidad de mnemosine**, archivado en `docs/archive/claude-artifacts/brechas-de-usabilidad.html`.

## No-goals (declarados, no accidentales)

- **No es un ERP genérico ni un motor «sin país».** No hay módulos fuera de la contabilidad y su cumplimiento, y la internacionalización se hace por **paquetes de jurisdicción** sobre un motor común (`docs/jurisdicciones.md`): catálogo fiscal, calendario, parámetros legales con vigencia, formatos y corpus del agente por país — nunca aflojando las reglas del motor a un común denominador sin normas. Hoy hay dos paquetes: México, completo; Estados Unidos, parcial (nómina). Sigue vigente la decisión «¿es el sistema contable del despacho, o el motor auditable que se conecta al que ya tienen?» del archivo de Brechas de usabilidad, §5.
- **La ley no se decide y el criterio no se legisla.** Lo que fija la ley (tasas, topes, tablas) va a una tabla con vigencia y fuente oficial; lo que decide el despacho va al panel de políticas con su lector; ninguno de los dos va al prompt ni al chat (`docs/jurisdicciones.md` §2).
- **No timbra ni cancela CFDI todavía.** Cuatro adaptadores de PAC están precargados (Finkok, SW Sapien, Edicom, Sovos/Reachcore) pero no hay hoja de CLI que los use — ver tramo `CFDI·SELLO` en la secuencia.
- **No tiene interfaz gráfica.** El producto es el CLI; el tablero gráfico (`W0–W1`) es un tramo de la Vía B, no una promesa entregada.
- **La IA no decide criterio contable.** Una bifurcación entre dos tratamientos legítimos va al panel de políticas (`src/services/policy/`), nunca al prompt ni al chat.

## Riesgos conocidos

- **Concentración de conocimiento.** El diseño (criterios ejecutables, el panel de políticas, los invariantes de `AGENTS.md`) vive mayormente en la cabeza de quien lo escribió y en los documentos que este PR crea; sin `docs/HISTORY.md` y sin este archivo, un colaborador nuevo no tiene por dónde entrar.
- **Cadencia de entrega comprimida.** Los 41 PRs mergeados a la fecha de este documento se entregaron en una ventana de ~9 días (2026-08-25 → 2026-09-03), varios de ellos por dos sesiones de agente trabajando en paralelo sobre la misma rama. Ver `docs/HISTORY.md` para el detalle verificado contra `git log`.
- **Nómina (`src/services/payroll/`) es el módulo menos auditado del árbol** hasta la auditoría de 2026-09-02 (ver Vía A, tramos T4 y T5): subretención de ISR en frecuencias no quincenales, y el SUA que suma cuotas de toda la vida del empleado. Ninguno de los dos se ha corregido a la fecha de este documento — son items abiertos, no historia.
- **El límite de PAC/timbrado real es un contrato con un proveedor externo** (ver decisiones bloqueantes en la secuencia, §5): no lo resuelve una sesión de agente sola.

## Referencia

- Issue de scope pineada: (label `scope`, creada por este mismo PR — ver el número real en `docs/MIGRATION.md`, porque el #1 de este repositorio ya lo tiene un Pull Request).
- Plan ejecutable vivo: `src/plan/criterios.ts` + `npm run plan:status`.
- Historia de entrega: [`docs/HISTORY.md`](HISTORY.md).
- La jurisdicción como dimensión (diseño rector del panel por jurisdicción): [`docs/jurisdicciones.md`](jurisdicciones.md).
- Investigación normativa y de motores (2026-09-06): [`docs/investigacion/2026-09-06-normas-y-motores/`](investigacion/2026-09-06-normas-y-motores/).
- Cómo trabajamos: [`docs/PROCESS.md`](PROCESS.md).
- Quién ejecuta cada nivel: [`docs/ROUTING.md`](ROUTING.md).
