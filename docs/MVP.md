# MVP: el mes de una PyME mexicana, de punta a punta, en la terminal

> Este documento dice **qué es el MVP y cómo llegar**. La lista viva de issues está en la issue de seguimiento [#329](https://github.com/sedecim-com/Accounting/issues/329), que GitHub marca sola conforme se cierran las tareas. El estado del sistema no se escribe aquí: se pregunta con `npm run plan:status` y `npm run catalogo:estado`, como manda [`AGENTS.md`](../AGENTS.md).
>
> Las cifras de la sección 2 son una **foto fechada** (2026-09-25, `main` en `d1420ab`), no un estado. Sirven para saber de dónde se partió, no para citarlas.

## 1. Qué es el MVP

**Un despacho lleva, desde el CLI y con cifras correctas, el ciclo mensual completo de un cliente PyME mexicano** (persona moral, régimen general), sin salir de la terminal ni rehacer nada en una hoja aparte:

| # | Paso del mes | Qué tiene que poder hacer el contador |
|---|---|---|
| 1 | Alta y migración | Crear la entidad con su RFC y su régimen. Cargar el catálogo con código agrupador, la balanza de apertura y los documentos abiertos desde el sistema anterior (XML del Anexo 24). |
| 2 | CFDI → mayor | Ingerir los emitidos y los recibidos del mes, incluidos PUE, PPD y REP. El agente propone y una persona aprueba; y existe el camino manual, sin modelo. |
| 3 | CxC y CxP | Cobros, pagos, notas de crédito, anticipos, retenciones y saldos a una fecha que cuadran con su cuenta de control. |
| 4 | Banco | Importar el estado de cuenta y conciliar, con línea base en la primera sesión y la posibilidad de reabrir. |
| 5 | Nómina básica | Correr una quincena desde la terminal: ISR con subsidio, IMSS, INFONAVIT, ISN, asiento y SUA. |
| 6 | Cierre | Devengos, depreciación y checklist bloqueante, con `closing run`, expediente y periodo 13 al cierre del ejercicio. |
| 7 | Estados financieros | Balanza, estado de resultados, balance y flujo de efectivo. |
| 8 | Obligaciones del mes | Catálogo y balanza XML del Anexo 24, la DIOT en archivo que el SAT reciba, y el papel de trabajo de IVA definitivo e ISR provisional. |
| 9 | Operación segura | Aislamiento por inquilino y por entidad, y un respaldo probado por restauración. |

**La prueba de aceptación es una, y ejecutable:** [#311](https://github.com/sedecim-com/Accounting/issues/311). El mes de una PyME sintética recorre esos nueve pasos por el CLI, contra una base efímera y con cifras escritas a mano, como criterio ▶ del tablero. Mientras esa prueba no esté en verde en CI, el MVP no está entregado, diga lo que diga cualquier documento, este incluido. Se puede empezar ya, con un `it.todo` por cada issue abierta, y así la ruta se vacía sola.

**Fuera del MVP, declarado:**

- **Timbrado y cancelación con PAC** ([#105](https://github.com/sedecim-com/Accounting/issues/105), [#115](https://github.com/sedecim-com/Accounting/issues/115)). Depende de un contrato externo. En un despacho, los CFDI los emite el cliente en su sistema, y aquí se ingieren.
- **Estados Unidos más allá de lo que ya existe** ([#124](https://github.com/sedecim-com/Accounting/issues/124), [#131](https://github.com/sedecim-com/Accounting/issues/131)).
- **La interfaz gráfica** ([#117](https://github.com/sedecim-com/Accounting/issues/117), PR #249) y **los canales de mensajería** ([#116](https://github.com/sedecim-com/Accounting/issues/116)).
- **El renombrado del código al inglés** (epic [#141](https://github.com/sedecim-com/Accounting/issues/141)). Hay dos excepciones: el panel de políticas ([#152](https://github.com/sedecim-com/Accounting/issues/152)) y la ayuda del CLI ([#314](https://github.com/sedecim-com/Accounting/issues/314)), porque son lo único de ese epic que cambia lo que lee un contador en `es-MX`. Las hojas I8.x no lo cambian: el extractor copia a `es.ts` el español que ya se imprime.
- **La descarga masiva del SAT** ([#312](https://github.com/sedecim-com/Accounting/issues/312)) está en la última ola y pendiente de decisión. Sin ella, el MVP funciona con los XML que entrega el cliente, pero no puede afirmar que tiene todos los CFDI, que es lo que el despacho vende.

## 2. De dónde se parte (foto del 2026-09-25)

**Lo que se midió:**

- `plan:status` con base de datos:
  - 11 de 15 paquetes en verde;
  - 198 criterios, de los cuales 6 ejecutan el camino real contra una base efímera;
  - en rojo: E3.2 (no hay descarga masiva), E4.1 (nadie escribe los embargos; lo cierra el PR #272), E4.2 (cinco copias del SQL de saldos) y dos de E5.1.
  - Sin base de datos el mismo comando responde **10 de 15**, porque E0.1 no se puede evaluar. Mide siempre con base: ver la sección 7.
- `catalogo:estado`: el binario ejecuta 233 comandos en 65 familias; 218 de las 1 634 filas del catálogo ya se pueden invocar, 197 de ellas de fase 1.
- `npm test`: 295 archivos y 6 700 pruebas en verde. Lint sin errores, con 1 093 advertencias bajo el tope de 1 106.

**Lo que dio el recorrido real del CLI** (una PyME sintética, Postgres 16, sin llave de IA):

| Paso | Hoy | Lo que falta |
|---|---|---|
| Alta, asiento manual, CxC y CxP capturadas, cierre suave, estados financieros, respaldo, aislamiento | ✅ funcionan | Detalles en [#327](https://github.com/sedecim-com/Accounting/issues/327) |
| Migrar desde el Anexo 24 | ❌ el motor existe, pero no hay comando | [#220](https://github.com/sedecim-com/Accounting/issues/220), [#310](https://github.com/sedecim-com/Accounting/issues/310) |
| CFDI → mayor | ❌ tres defectos bloqueantes | Aprobar no crea la factura ([#318](https://github.com/sedecim-com/Accounting/issues/318)); lo emitido entra como gasto ([#320](https://github.com/sedecim-com/Accounting/issues/320)); sin modelo, los CFDI quedan varados ([#319](https://github.com/sedecim-com/Accounting/issues/319)) |
| Banco | 🟡 la primera sesión arrastra toda la historia del mayor | [#324](https://github.com/sedecim-com/Accounting/issues/324) |
| Depreciación | ❌ no hay categorías de activo, y el checklist sale verde | [#322](https://github.com/sedecim-com/Accounting/issues/322) |
| Balanza XML | 🟡 las cuentas de mayor salen en cero | [#323](https://github.com/sedecim-com/Accounting/issues/323) |
| DIOT, IVA/ISR del mes, nómina, pólizas XML | ❌ o sólo papel de trabajo | [#307](https://github.com/sedecim-com/Accounting/issues/307), [#308](https://github.com/sedecim-com/Accounting/issues/308), [#306](https://github.com/sedecim-com/Accounting/issues/306), [#328](https://github.com/sedecim-com/Accounting/issues/328) |

**En resumen:** el motor contable ya recorre el mes. Lo que falta es, sobre todo, el **circuito CFDI → mayor**, que es la razón de ser del producto, y **las salidas fiscales del mes**.

## 3. La línea de trabajo: cuatro olas

Una ola no empieza cuando termina la anterior: empieza cuando lo suyo está en `status:agent-ready`. La ola dice qué conviene hacer **antes**, no qué está prohibido hacer después.

### Ola 0 · Desbloquear (horas, casi sin código de producto)

Vaciar la cola de PRs en el orden de la sección 5. Después:

- vitest 5 con Node 22 en un solo PR ([#292](https://github.com/sedecim-com/Accounting/issues/292));
- los criterios se evalúan una vez por corrida y los timeouts dejan de subir ([#293](https://github.com/sedecim-com/Accounting/issues/293));
- decidir cuándo se parte el tablero en un archivo por paquete ([#294](https://github.com/sedecim-com/Accounting/issues/294)). Es el habilitador de velocidad más grande: casi todos los conflictos entre PRs ocurren en `src/plan/criterios.ts`.
- Y las **decisiones del dueño** de la sección 4, porque varias issues de la Ola 1 esperan una.

### Ola 1 · Que el mes cuadre

Defectos en el camino del MVP, repartidos en **carriles** que tocan archivos distintos y pueden correr en paralelo, un issue por carril a la vez:

| Carril | Issues, en orden | Dónde viven |
|---|---|---|
| A · Alta y migración | #220 → #219 → #321 → #322 | `src/services/accounting/` (importación y apertura), `src/services/assets/` |
| B · CFDI → mayor | #318 → #320 → #319 → #299 y #218 → #102 → #284 | `src/services/xml-ingestion/`, `src/ai/draft-service.ts` |
| C · CxC y CxP | #94 → #98 | `src/services/ar/`, `src/services/ap/`, `period-close.ts` (checklist) |
| D · Banco | #324 → #95 → #138 → #128 → #302 | `src/services/banking/` |
| E · Cierre y salidas | #99 → #304 → #323 (junto con #100) | `src/services/accounting/period-close.ts`, `src/services/sat/anexo24/` |
| F · Nómina MX | #296 → #297 → #298 → #242 | `src/services/payroll/` |
| G · Panel y agente | #300 → #301 → #93 → #303 | `src/services/policy/`, `src/ai/` |

Los carriles C y E comparten `period-close.ts`: el checklist lo toca #98, y el arrastre, #99. Conviene que no corran a la vez.

### Ola 2 · Lo que falta construir

- nómina MX en la terminal ([#306](https://github.com/sedecim-com/Accounting/issues/306));
- la DIOT en archivo que el SAT reciba ([#307](https://github.com/sedecim-com/Accounting/issues/307), después de #284);
- el papel de trabajo de IVA e ISR ([#308](https://github.com/sedecim-com/Accounting/issues/308));
- las retenciones ([#309](https://github.com/sedecim-com/Accounting/issues/309));
- los documentos abiertos en la migración ([#310](https://github.com/sedecim-com/Accounting/issues/310), después de #220);
- la factura en moneda extranjera y la revaluación ([#305](https://github.com/sedecim-com/Accounting/issues/305)).

### Ola 3 · El MVP se demuestra y se pule

- [#311](https://github.com/sedecim-com/Accounting/issues/311), el mes de punta a punta; conviene **empezarla en la Ola 1**, con `it.todo`.
- La descarga masiva ([#312](https://github.com/sedecim-com/Accounting/issues/312)).
- El español del panel y de la ayuda ([#152](https://github.com/sedecim-com/Accounting/issues/152), [#314](https://github.com/sedecim-com/Accounting/issues/314)).
- Los manuales ([#325](https://github.com/sedecim-com/Accounting/issues/325)).
- El alta de despacho y de usuarios sin TTY ([#326](https://github.com/sedecim-com/Accounting/issues/326)).
- La gramática de la terminal ([#327](https://github.com/sedecim-com/Accounting/issues/327)).
- Y lo deseable: #328, #313, #315, #317, #100, #101, #215, #231, #133.

## 4. Decisiones que sólo el dueño puede tomar

Invariante 6 de `AGENTS.md`: un agente no las elige y tampoco las pregunta en el chat. Cada una bloquea una issue concreta; ahí se contesta.

| Issue | Pregunta | Recomendación del triage |
|---|---|---|
| #220 | La carga de la balanza de apertura, ¿postea o deja borrador? ¿Con qué nombres de comando? | Que postee con `--live` y marcha seca, que es lo que ya hace el motor, con los nombres del catálogo (`opening-balance import`) |
| #219 | Las cuentas de orden (8xx), ¿migran? | Que no migren: se escribe la doctrina y se excluyen del cuadre |
| #242 | El «hoy», ¿de quién es? | De la entidad, con la jurisdicción como valor por omisión |
| #298, #308 | Redondeos del subsidio y del papel de trabajo | Van al panel, con su lector |
| #322 | Tasa contable (NIF C-6) frente a tasa fiscal (art. 34) | Dos columnas; la elección se declara |
| #305 | Si la revaluación se revierte, y con qué tipo de cambio se cierra | Va al panel (`fuente_tipo_cambio` ya existe) |
| #312 | La descarga masiva, ¿entra al MVP? | Última ola; no debe bloquear lo demás |
| #294 | ¿Cuándo se parte el tablero por paquete? | Justo después de vaciar la cola de PRs |
| #152, #314 | Formato de claves del panel y de la ayuda | Decidir junto con I23 (#166) |
| PR #249, PR #283 | La lectura de §5.3 del tablero y la revisión de seguridad; si se juzga el título del PR | — |

## 5. La cola de PRs (foto del 2026-09-25)

Orden de fusión recomendado. Cada paso se re-verifica en la cabeza del PR antes de fusionarlo:

1. **#291**: el historial al día. Desde el 2026-09-24, `historial-estado --check` pone en rojo el trabajo `plan` de **toda** corrida nueva, así que va primero.
2. **#287**: dependencias menores; verde y sin conflictos.
3. **#288**: ESLint 10; verde, con el mismo número de advertencias. Después hay que actualizar las menciones a «ESLint 9» en `PROCESS.md`, `CONTRIBUTING.md` y el README.
4. **#272**: F08, el escritor de embargos. Verificado contra `main`, deja E4.1 en 23/23.
   - Falta actualizarlo con `main` y añadir `E4.1` a `--exigir` en `ci.yml` en el mismo commit (PROCESS §2).
   - Hay que avisar a los despachos de que la 085 **aborta a propósito** si tienen embargos heredados sin exención.
5. **#286** y **#283**: nunca han corrido en CI porque están en conflicto.
   - #286: al fusionar `main` hay que **re-medir** `MIRRORS_FLOOR` y `ANCHORS_HERE`; no se elige un lado.
   - #283: hay que elegir el timeout de `doctor-service.spec` y contestar las dos preguntas del dueño.
6. **#249**: el tablero gráfico. Está verde, pero antes pide la decisión sobre §5.3 y una revisión de seguridad. Es post-MVP.
7. **Cerrar sin fusionar:**
   - **#260**: rehace J0.1, que ya entró como #140, en una rama reempujada a un commit viejo;
   - **#207** y **#289**: los reemplaza #292, porque cada uno por separado rompe `npm ci`;
   - **#290**: Express 5 deja **vacío en silencio** el censo de riesgo por ruta. Ver #295.

## 6. Cómo tomar una issue y cerrarla rápido

Cada issue de la ruta lleva dos comentarios:

- el de **triage**: estado verificado, lo que queda, punto de entrada;
- el de **clasificación y Definition of Ready**: puntaje de dificultad por dimensión, autonomía, criterios Dado/Cuando/Entonces, fuera de alcance, cómo probar y, si pasa de ~400 líneas, la división propuesta.

El esquema viene del [Framework de Desarrollo Agéntico](https://claude.ai/artifact/V5nLbNQmVkbCDpZfMkUx6A); su adaptación a este repo está en el [ADR-0001](adr/0001-agentic-framework-adoption.md).

| Etiqueta | Qué dice |
|---|---|
| `mvp` · `ola-0` … `ola-3` · `post-mvp` | Si la issue está en la ruta y cuándo conviene hacerla |
| `difficulty:D1` … `D4` | Puntaje de 5 dimensiones. Decide el modelo, el esfuerzo y el presupuesto de tokens ([`ROUTING.md`](ROUTING.md)) |
| `autonomy:A1` … `A3` | Cuánta supervisión humana hay. **A3 por omisión**: el repo maneja PII y funciones financieras reguladas |
| `status:agent-ready` | Cumple la DoR, es D1–D2 y no está bloqueada: se puede tomar hoy |
| `status:triage` | Le falta algo de la DoR (casi siempre, dividirse), o es D3–D4 y espera el `/confirmar` de un humano |
| `status:needs-clarification` | Espera una decisión del dueño (sección 4). No se empieza |
| `status:blocked` | Espera a otra issue, que se nombra en el comentario |

Estas etiquetas sustituyen a `size-*`, `nivel-L*`, `listo` y `decision-pendiente` del primer triage; la equivalencia está en `ROUTING.md`. Los estados y quién los cambia están en `PROCESS.md` §7.

La receta para una issue `status:agent-ready` (o una D3 ya confirmada):

1. `git fetch` y una rama desde `main` fresco. Lee la issue **y su comentario de triage**. Si el plan está mal, comenta y detente (`PROCESS.md` §5).
2. **Reproduce primero.** Escribe una prueba de integración contra Postgres (`tests/integration/`, base efímera de `tests/integration/global-setup.ts`) que falle con el defecto.
3. Arregla. Un PR resuelve una issue: si la issue sugiere dos PRs, son dos.
4. **Criterio con mutante** en `src/plan/criterios.ts`. Rómpelo en memoria (guardar y restaurar, nunca `git checkout --`) y exige que caiga: `npm run mutantes`. Si el paquete cierra, añádelo a `--exigir` en `.github/workflows/ci.yml` en el mismo commit.
5. **Regenera los bloques generados** en lugar de editarlos a mano: los de la sección 7.
6. Pasa las puertas locales:

   ```bash
   npm run typecheck && npm run typecheck:tests && npm test && npm run lint
   npm run test:integration          # con Postgres, ver la sección 7
   npm run plan:status -- --piso --exigir=E0.0,E0.1,E0.2,E0.3,E1.1,E1.2,E1.3,E2.1,E2.2,E3.1,E4.1
   npx tsx scripts/catalogo-estado.ts --check
   npx tsx scripts/corpus-manifiesto.ts --check
   npx tsx scripts/historial-estado.ts --check
   npx tsx scripts/openapi.ts --check
   npx tsx scripts/ux-status.ts --check
   npx tsx scripts/language-status.ts --check
   ```

   La lista de `--exigir` es la de `ci.yml` el día que se escribió esto: cópiala de ahí.
7. **Quien fusiona un PR añade su fila a `docs/HISTORY.md` antes de siete días.** Si no, el guardián pone en rojo el trabajo `plan` de todos los demás PRs. Es exactamente lo que pasó con los 18 PRs del 16 de septiembre.

## 7. Lo que hace chocar a dos PRs, y el entorno local

**Los archivos calientes.** Si tu PR toca alguno, fusiona `main` justo antes de pedir revisión y **regenera; nunca elijas un lado**. Aprender esto costó PRs rotos en #283, #286 y #281.

| Archivo | Por qué choca | Cómo se resuelve |
|---|---|---|
| `src/plan/criterios.ts` | Un solo arreglo de unas 13 500 líneas; `MIRRORS_FLOOR` y `ANCHORS_HERE` son cuentas exactas | Re-medir sobre el árbol fusionado. #294 lo parte por paquete |
| `docs/language.md` y `docs/language.es.md` (bloque) | Lo genera el metro del idioma | `npm run language:status -- --write` |
| `docs/language-baseline.json` | La línea base sólo baja | `npm run language:status -- --tighten` |
| `src/i18n/en.ts` y `src/i18n/es.ts` | El extractor inserta antes del último `};` | Conservar el orden de los bloques en los dos archivos |
| `src/ai/docs/manifiesto.json` | Sello del corpus contra sus fuentes | Releer el manual y `npx tsx scripts/corpus-manifiesto.ts --actualizar <manual>.md` |
| `docs/cli-command-catalog.md` (bloque) y `docs/catalogo-minimos.json` | Recuento del binario y suelo | `npm run catalogo:estado`. Ojo: **sin `--check` reescribe el archivo** |
| `docs/HISTORY.md` | Censo generado y filas a mano | `npm run historial:estado` |
| `docs/openapi.json` | Se genera de las rutas | `npm run openapi` |

**El entorno local.** Postgres 15 o superior. Así se midió todo lo de la sección 2, con un clúster local; `docker/docker-compose.yml` también sirve:

```bash
# base para medir y migrar (el rol debe poder hacer CREATE DATABASE para las bases efímeras)
createdb -h localhost -U postgres mnemosine_plan
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemosine_plan
export MIGRATION_DATABASE_URL=$DATABASE_URL
export TEST_ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
npm run migrate && npm run plan:status
```

Tres trampas que ya costaron tiempo:

- Sin `TEST_ADMIN_DATABASE_URL`, los 6 criterios ▶ no corren y `plan:status` **no lo presenta como un fallo**: sale 10/15 en lugar de 11/15.
- Conectado como superusuario, la RLS no filtra nada y en silencio. Para probar aislamiento, usa el rol de `scripts/provision-roles.sql`, como el trabajo «Aislamiento por inquilino» de CI.
- `historial-estado --check` necesita el historial completo: en un clon superficial, `git fetch --unshallow` primero.
