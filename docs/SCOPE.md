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
- **Superficies**: CLI (`src/cli/`, comando `mnemosine`) y REST (`src/api/rest/`, Express). Hubo una tercera, GraphQL con Apollo Server, apagada tras una bandera y sin un solo consumidor: se **retiró** en T14b ([#101](https://github.com/sedecim-com/Accounting/issues/101)). Una superficie que nadie ejerce no se blinda, se quita — y mientras existía, el criterio que la vigilaba se ponía verde con sólo mudar su montaje de archivo.
- **Pruebas**: Vitest (unitarias + integración contra Postgres real), con umbrales de cobertura **por archivo** sobre el motor contable (`vitest.config.ts`) que sólo pueden endurecerse, nunca aflojarse.
- **El plan mismo es código**: `src/plan/criterios.ts` declara los criterios ejecutables y `npm run plan:status` los evalúa contra el árbol real. **Este archivo no lleva la cuenta a propósito** — una cifra escrita aquí envejece en silencio, y ya lo hizo: decía «~130» cuando el comando respondía 179. Pregúntaselo al comando. Ver `docs/PROCESS.md`.

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
- **Cadencia de entrega comprimida.** Al 2026-09-15 son **99 PRs fusionados** (del #1 al #247) en una ventana de ~15 días (2026-09-01 → 2026-09-15), varios de ellos por sesiones de agente trabajando en paralelo sobre el mismo árbol. El riesgo no es el ritmo: es que dos sesiones toquen los mismos archivos —`src/plan/criterios.ts`, el piso ordenado, el panel de políticas y el manifiesto del corpus chocan casi siempre— y que una fusión resuelta eligiendo un lado tire trabajo medido. Ver `docs/HISTORY.md` para el detalle verificado contra `git log`, y comprobar la cifra de arriba con `gh pr list --state merged` antes de citarla.
- **Nómina (`src/services/payroll/`) fue el módulo menos auditado del árbol** hasta la auditoría de 2026-09-02 (ver Vía A, tramos T4 y T5). Los dos defectos que esa auditoría encontró **ya están corregidos, y con criterio en el tablero que los vigila**:
  - Subretención de ISR en frecuencias no quincenales — se aplicaba la tarifa MENSUAL a la base de una SEMANA, y encima la del año anterior. Corregido en **#193** (issue #91); con 3 000 semanales se retenía 0.00.
  - El SUA declaraba las cuotas de toda la historia del empleado en el archivo del mes. Corregido en **#230** (issue #92), que además coteja el archivo contra `employer_tax_liabilities` y se niega a emitirlo si discrepan.

  Lo que **sigue abierto** en nómina no son esos dos: es que las retenciones judiciales (`garnishments`) se leen y nadie las escribe, así que los formularios 941/940 reportan ceros. Lo dice en rojo el criterio `La nómina escribe los impuestos que sus formularios reportan` (E4.1) — no este párrafo.
- **El límite de PAC/timbrado real es un contrato con un proveedor externo** (ver decisiones bloqueantes en la secuencia, §5): no lo resuelve una sesión de agente sola.

## Referencia

- Issue de scope pineada: (label `scope`, creada por este mismo PR — ver el número real en `docs/MIGRATION.md`, porque el #1 de este repositorio ya lo tiene un Pull Request).
- Plan ejecutable vivo: `src/plan/criterios.ts` + `npm run plan:status`.
- Historia de entrega: [`docs/HISTORY.md`](HISTORY.md).
- La jurisdicción como dimensión (diseño rector del panel por jurisdicción): [`docs/jurisdicciones.md`](jurisdicciones.md).
- Investigación normativa y de motores (2026-09-06): [`docs/investigacion/2026-09-06-normas-y-motores/`](investigacion/2026-09-06-normas-y-motores/).
- Cómo trabajamos: [`docs/PROCESS.md`](PROCESS.md).
- Quién ejecuta cada nivel: [`docs/ROUTING.md`](ROUTING.md).
