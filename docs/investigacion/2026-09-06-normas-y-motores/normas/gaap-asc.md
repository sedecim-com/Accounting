# US GAAP para mnemosine: la Codificación ASC, la SEC y lo que un motor bi-jurisdiccional debe parametrizar

> Informe normativo escrito el 2026-09-06 sobre la rama `investigacion/normas-y-motores` de `/Users/victor/projects/Accounting`. **No se editó ningún archivo del repositorio.** Todo lo que se afirma del código lleva `archivo:línea`; todo lo que se afirma de la norma lleva la fuente de la tabla del §12, y esa tabla dice si la liga respondió (`verificada`) o no. Las páginas de fasb.org y asc.fasb.org devolvieron **403** a este agente; el contenido del FASB se verificó por los PDF de `storage.fasb.org` (que sí responden) y por reproducciones íntegras en PwC Viewpoint y Deloitte. Ninguna página abierta contenía instrucciones dirigidas al agente; el contenido se trató como dato.

Vocabulario de la casa, que este informe respeta: **MOTOR** (aritmética o regla implementada), **PUERTA** (superficie CLI/REST/agente que lo invoca), **PARÁMETRO** (tabla, tasa, umbral que debe vivir en el panel o en una tabla con vigencia, nunca quemado). Una bifurcación de criterio contable no se elige en el código: se declara en el panel de políticas con su lector.

---

## 0. Resumen ejecutivo

1. **US GAAP es la Codificación** (ASC): desde los periodos que terminan después del 15-sep-2009 es «la fuente de GAAP autoritativo reconocida por el FASB para entidades no gubernamentales»; las reglas de la SEC son también autoritativas **sólo para registrantes**; todo lo demás (Concepts Statements, AICPA, IFRS) es no autoritativo (ASC 105-10-05-1/-3, fuente §12 #4). Los ASU no son autoritativos por sí mismos: enmiendan la Codificación.
2. **La SEC no le aplica a una PyME.** Su papel es reconocer al FASB como emisor privado designado (Release 33-8221, SOX §108) y exigir GAAP a lo que se presenta ante ella (Reg. S-X 4-01(a)(1): estados no-GAAP «se presumen engañosos o inexactos»). Una sociedad cerrada de Delaware no le debe nada a la SEC; le debe a su banco, a sus socios y al IRS.
3. **Una PyME estadounidense no está obligada por ley a llevar GAAP.** Lleva GAAP si su prestamista o inversionista lo exige; si no, lleva *income-tax basis* o *cash basis* (marcos de propósito especial) o el **FRF for SMEs** del AICPA (2013, no-GAAP, opcional). Y dentro de GAAP tiene las **alternativas del PCC** (crédito mercantil amortizable a 10 años, ASU 2014-02). El esquema del repo sólo admite `accounting_standard IN ('us_gaap','mx_nif','ifrs')` (`src/database/migrations/001_core_schema.sql:87-88`): **falta la dimensión «base contable»** para el libro estadounidense.
4. **Las cinco diferencias que el motor debe parametrizar por libro, no por país**: UEPS/LIFO (permitido sólo bajo GAAP y con conformidad IRC §472(c)); revaluación de PP&E (IAS 16 sí; ASC 360 y NIF C-6 no); reversión de deterioro de activos de larga duración y de castigos de inventario (IFRS/NIF sí; GAAP no); capitalización de desarrollo (IAS 38/NIF C-8 obligatoria con criterios; ASC 730 gasto, salvo software); orden y clasificación del balance (GAAP: liquidez descendente, circulante primero, clasificado por práctica y por Reg. S-X 5-02; IFRS: sin orden prescrito). Se añaden el modelo dual de arrendatario (ASC 842 operativo/financiero vs modelo único NIIF 16/NIF D-5), el umbral de contingencias (ASC 450 «probable» ≈ >70 % y punto mínimo del rango vs IAS 37 >50 % y punto medio), la reserva de valuación de diferidos (ASC 740 bruto + *valuation allowance* vs NIC 12 neto) y los intereses en el flujo de efectivo (ASC 230: operación, sin elección; NIC 7: elección; NIF B-2: prescrito distinto).
5. **El libro y el impuesto se separan en EE. UU. por diseño**, y esa separación es un motor en sí: la 1120 pide el balance «per books» (Schedule L) y la conciliación libro-fiscal (M-1; M-3 desde 10 M USD de activos). Los parámetros fiscales que arrastra el libro cambian por año: prueba de ingresos brutos §448(c) **31 M USD en 2025, 32 M USD en 2026**; §179 **2 500 000 / 4 000 000 en 2025 y 2 560 000 / 4 090 000 en 2026**; depreciación adicional **100 % para bienes adquiridos después del 19-ene-2025**; reserva de incobrables **no deducible** (§166: sólo cargo específico), lo que convierte a toda estimación CECL en diferencia temporal.
6. **El repo no tiene corpus GAAP** (`ls src/ai/docs/` no contiene nada de ASC; `DOC_TOPICS` en `src/ai/tools/docs-tools.ts:17-47` no registra ningún tema GAAP; el *grounding* del agente en `src/ai/system-prompt.ts:57-63` sólo manda a `nif-*` y `niif-*`). Hay que escribir **siete documentos** espejo de `niif-*.md`, un `asc-registry.json` espejo de `ifrs-registry.json`, su generador y su prueba de sincronía (§11).
7. **Lo que sí tiene**: el conmutador booleano (`pais-contable.ts:35-44`), un estrato «neutro» de tres cuentas para lo no mexicano (`chart-seed.ts:123-127`), la columna `us_gaap_code` con escritor por `account map set --scheme us-tax-line` (`account-service.ts:454-458`), el estado de flujos que cita ASC 230 (`cash-flow-service.ts:14`), tablas MACRS con una sola convención (`depreciation-math.ts:263-281`), el enum de costeo que ya admite `lifo` (`src/types/index.ts:172-177`), y en `docs/cli-command-catalog.md` un diseño de puertas que ya nombra ASC 326, 606, 740, 842, 250 y 330 como filas ❌ por construir.

---

## 1. Qué es US GAAP: la Codificación

### 1.1 Jerarquía y autoridad

- **ASC 105-10-05-1** (fuente #4): la Codificación es «the source of authoritative generally accepted accounting principles (GAAP) recognized by the FASB to be applied by nongovernmental entities», y «Rules and interpretive releases of the SEC under authority of federal securities laws are also sources of authoritative GAAP for SEC registrants». **105-10-05-3**: lo que no está en la Codificación es no autoritativo (prácticas de industria, Concepts Statements, publicaciones del AICPA, **IFRS**).
- Vigencia: estados «issued for interim and annual periods ending after September 15, 2009» (fuente #4). Antes de esa fecha la jerarquía era FAS/APB/ARB/EITF; los números viejos (FAS 5, FAS 52, FAS 109, FAS 141R) siguen apareciendo en contratos de crédito y en la cabeza de los contadores: el corpus debe dar el mapa viejo→nuevo (FAS 5 → ASC 450; FAS 52 → ASC 830; FAS 109/FIN 48 → ASC 740; FAS 13 → ASC 840 → ASC 842; SAB 104/EITF 08-1 → ASC 606).
- **Cómo se cita**: `ASC Tópico-Subtópico-Sección-Párrafo`, p. ej. **ASC 330-10-35-1B** («inventory measured using any method other than LIFO or the retail inventory method» se mide al menor entre costo y VNR; ASU 2015-11, fuente #11). Las secciones se numeran igual en todo subtópico: 05 Overview, 10 Objectives, 15 Scope, 20 Glossary, 25 Recognition, 30 Initial Measurement, 35 Subsequent Measurement, 40 Derecognition, 45 Other Presentation, 50 Disclosure, 55 Implementation, 60 Relationships, 65 Transition, 70 Grandfathered, 75 XBRL, **S99 = contenido SEC** (fuente #6 lo confirma como «SEC-specific sections»). El registro ASC del repo debe guardar el número de párrafo, no sólo el tópico: la cita verificable es el párrafo.
- **Cómo cambia**: por *Accounting Standards Updates* (ASU AAAA-NN). El ASU no es GAAP: enmienda la Codificación y trae la fecha efectiva, casi siempre **distinta para public business entities (PBE) y «all other entities»** — para una PyME manda la segunda columna. Los ASU verificados en este informe: 2015-11, 2014-02, 2019-10, 2020-05, 2023-09, 2025-05, 2025-06 (fuentes #10-#16).
- **Acceso**: *Basic View* gratuito con registro y *Professional View* por suscripción (fuente #6). Este agente **no pudo abrir** asc.fasb.org ni fasb.org (403: fuentes #7-#9); el generador del índice GAAP no puede depender de esas páginas para su prueba de sincronía — debe apuntar a `storage.fasb.org/ASU%20AAAA-NN.pdf`, que sí responde.

### 1.2 Estructura por áreas y tópicos (fuente #5, PDF leído localmente)

| Área | Tópicos | Los que una PyME toca |
|---|---|---|
| General Principles | **105** | 105 |
| Presentation | 205, 210, 215, 220, 225, 230, 235, 250, 255, 260, 270, 272, 274, 275, 280 | 205 (incl. 205-20 discontinuadas, 205-40 negocio en marcha), 210, 215, 220, 225, 230, 235, 250, 272 (LLC), 275; **260 y 280 son de PBE** |
| Assets | 305, 310, 320, 321, 323, 325, **326**, **330**, **340**, **350**, **360** | todos salvo 320-325 (inversiones) |
| Liabilities | 405, 410, 420, 430, 440, **450**, 460, 470, 480 | 405, 410 (ARO), 440, 450, 460 (garantías), 470 (deuda), 480 |
| Equity | **505** | 505 |
| Revenue | 605, **606**, 610 | 606, 610 |
| Expenses | 705, 710, 712, 715, **718**, 720, 730, **740** | 705, 710 (vacaciones devengadas), 718 (si hay opciones), 720, 730, 740 |
| Broad Transactions | 805, 808, 810, 815, 820, 825, **830**, **832**, 835, 840, **842**, 845, 848, 850, 852, 853, 855, 860 | 810 (si consolida), 820, 830, 832 (subvenciones, ASU 2025-10), 835 (interés, incl. 835-20 capitalización), 842, 845 (permutas), 850 (partes relacionadas), 855 (hechos posteriores) |
| Industry | 905–995 | 985 (software) si vende software; 952 franquicias; 910 construcción; 970 inmobiliario |

El repo cita ya, en prosa de comandos, ASC 210, 220, 230, 235, 250, 280, 326, 330, 350, 360, 450, 606, 710, 740, 810, 830, 842 (grep de la sección 12 de este informe y `docs/cli-command-catalog.md`), pero ningún documento del agente los explica.

---

## 2. El papel de la SEC, y por qué a una PyME no le toca

- **Release 33-8221 (2003, fuente #1)**: la Comisión determinó que el FASB y la FAF cumplen los criterios de la §108 de Sarbanes-Oxley y, en consecuencia, reconoció sus normas como «generally accepted» para las leyes de valores; «registrants are required to continue to comply with those standards in preparing financial statements filed with the Commission».
- **Reg. S-X 4-01(a)(1) (fuente #2)**: «Financial statements filed with the Commission which are not prepared in accordance with generally accepted accounting principles will be presumed to be misleading or inaccurate»; (a)(2): los emisores privados extranjeros pueden usar «IFRS as issued by the IASB» sin conciliación.
- **Reg. S-X 5-02 (fuente #3)**: prescribe los renglones y el **orden** del balance para compañías comerciales e industriales registradas — efectivo, valores, cuentas por cobrar, estimación de incobrables, inventarios, pagados por anticipado, total circulante; luego no circulante; luego pasivo circulante, deuda a largo plazo, créditos diferidos, participación no controladora, capital. Es la fuente formal del «orden de liquidez con el circulante primero» que se toma como sinónimo de US GAAP.
- **Para una entidad no registrada la SEC no manda**; pero (a) el contenido S99 de la Codificación y las SAB (SAB 104 sobre ingresos antes del 606, SAB 99 sobre materialidad) se usan como práctica; (b) los prestamistas exigen «GAAP» en los *covenants* y suelen aceptar las alternativas del PCC; (c) la taxonomía XBRL `us-gaap` la mantiene el FASB para la SEC y la fila `xbrl taxonomy install` de `docs/cli-command-catalog.md:2461` sólo tiene sentido para registrantes o para quien reporte a un grupo que lo sea.

**Regla para el motor**: `jurisdiccion.libros = 'us_gaap'` **no** implica reglas SEC. El paquete US no debe cargar nada de S-X salvo que la entidad declare `sec_registrant = true` (y hoy nadie lo necesita: fuera del alcance declarado en `docs/completion-plan.md:369-381`, «XBRL y notas de revelación → el software del auditor»).

---

## 3. Quién lleva GAAP en una PyME estadounidense, y qué lleva si no

Esto es lo que más cambia el diseño respecto a México, donde la NIF es obligatoria por CFF/RLISR para todo contribuyente que lleva contabilidad.

| Base | Qué es | Quién la usa | Fuente |
|---|---|---|---|
| **US GAAP pleno** | La Codificación tal cual | Quien tiene auditoría o revisión por exigencia de banco, inversionista, franquiciante, licitación | #4 |
| **GAAP con alternativas del PCC** | Dentro de GAAP: crédito mercantil amortizado línea recta a **10 años o menos**, prueba de deterioro sólo ante **evento detonante**, a nivel entidad o unidad de reporte, un solo paso (ASU 2014-02; vigente para periodos anuales que inician después del 15-dic-2014). Otras: intangibles relacionados con clientes no separados (ASU 2014-18), *swaps* simplificados (2014-03), VIE bajo control común (2014-07/2018-17) | La mayoría de las privadas con crédito mercantil | #12, #12b |
| **Income-tax basis / cash basis** | Marcos de propósito especial («OCBOA»): los libros siguen la declaración; el CPA emite compilación/revisión/auditoría «on the income tax basis» | Muy común en PyMEs sin deuda bancaria exigente | #23 (la 1120 pide el balance «per books» sea cual sea la base) |
| **FRF for SMEs (AICPA, jun-2013)** | Marco **no-GAAP**, opcional, costo histórico, sin ORI, «reduces book-to-tax differences», «avoiding potentially expensive fair value measurements» | Empresas cerradas administradas por sus dueños | #28 |

**Consecuencia para el esquema**: `legal_entities.accounting_standard` (`001_core_schema.sql:87-88`, tipado en `src/types/index.ts:903`) colapsa cuatro cosas en `us_gaap`. El diseño de `docs/jurisdicciones.md:83-100` separa `libros` de `fiscal`; para EE. UU. `libros` necesita **una sub-dimensión**: `us_gaap` | `us_gaap_pcc` | `us_tax_basis` | `us_cash_basis` | `frf_smes`. No es un `if` en el motor: es un valor de la entidad que el paquete US traduce en (a) qué claves del panel aplican (`aplica: false` para CECL, 842, 740 diferido en `us_tax_basis`), (b) qué informes se pueden producir, (c) qué corpus abre el agente. **Nace cuando tenga lector**, como manda `docs/jurisdicciones.md:193`.

---

## 4. Tópico por tópico: regla, motor, parámetro, puerta, diferencia, y qué hay en el repo

Formato de cada ficha: qué exige la norma → **regla para el motor** → parámetro → puerta → vs IFRS/NIF → lo que hay hoy.

### 4.1 ASC 205 / 210 / 215 / 220 / 225 / 230 / 235 — Estados financieros

- **Juego completo** (ASC 205-10): balance, estado de resultados, resultado integral (220), cambios en el capital (215), flujos (230), notas (235). Comparativos no obligatorios en GAAP para privadas (sí en IFRS y en la práctica bancaria).
- **Balance (210)**: no exige balance clasificado salvo para registrantes comerciales e industriales (KPMG §5.1, fuente #32: «US GAAP does not require the presentation of a classified statement of financial position, except for commercial and industrial SEC registrants… However, prevalent practice under US GAAP is to present a classified statement of financial position»; cita 210-10-05-4 y Reg. S-X 5-02). Orden: liquidez descendente, circulante primero. IFRS: NIC 1.60 exige clasificado salvo que la liquidez sea más relevante, **sin orden prescrito** (muchos emisores IFRS presentan no circulante primero). **NIF B-6**: clasificado, circulante primero, igual que la práctica GAAP.
  - **Regla**: el orden y la clasificación son un **layout por norma**, no un `if`: `statement layout install --norms us-gaap` (`docs/cli-command-catalog.md:2283`, fila ❌). El layout GAAP añade renglones que el `fs_category` de hoy no puede alojar: **ORI acumulado**, capital contribuido vs ganado, acciones en tesorería, diferidos no circulantes.
  - **Lo que hay**: `getBalanceSheet` agrupa por `fs_category` (`report-service.ts:444-458, 545-568`); el CHECK de `fs_category` (`001_core_schema.sql:115-121`) no tiene `other_comprehensive_income` ni distingue contribuido/ganado (`docs/auditorias/2026-09-01-integral-iii/normas-de-informacion.md:241`; `motores-inventario.md:40`). Rótulos en inglés fijos.
- **Resultado y resultado integral (220/225)**: partidas extraordinarias eliminadas (ASU 2015-01; el tópico 225-20 queda como «Unusual or Infrequently Occurring Items»); el ORI (CTA de ASC 830, coberturas, pensiones) se presenta en un estado o en dos consecutivos; gastos por función **o** por naturaleza — sin exigencia para privadas; la desagregación DISE (ASU 2024-03, ASC 220-40) es de PBE (la fila `disclosure expense list --by nature` de `docs/cli-command-catalog.md:2456` lo anota; **no abrí el ASU 2024-03**: verificada=false).
  - **Regla**: subtotales por layout (utilidad bruta, utilidad de operación —GAAP no la define pero la práctica la usa—, utilidad antes de impuestos, impuesto, utilidad neta, ORI, resultado integral). Hoy `getIncomeStatement` filtra por `account_type` y no lee `fs_category` (`motores-inventario.md:41`).
- **Flujos (230)**: indirecto o directo (con conciliación si directo); **intereses pagados y cobrados y dividendos cobrados = operación; dividendos pagados = financiamiento; impuestos = operación**, sin elección (RSM p. 2413-2422, fuente #31). NIC 7 permite elegir con consistencia; **NIF B-2 prescribe otra cosa** (intereses y dividendos cobrados → inversión; pagados → financiamiento, `niif-marco-presentacion.md:110`). Efectivo restringido dentro del total (ASU 2016-18); efecto FX en renglón aparte.
  - **Regla**: la clasificación de intereses/dividendos es **por norma del libro**, no por panel: el panel ya tiene `flujo_efectivo_metodo`, `flujo_efectivo_cuentas_de_efectivo`, `flujo_efectivo_descuadre` (`pending-catalog.ts:516-594`); la clasificación de intereses debe salir del paquete (`casa` por norma), y hoy sale de `account_type` (`motores-inventario.md:45`).
  - **Lo que hay**: `cash-flow-service.ts` (encabezado `:14` «NIF B-2 / ASC 230») construye por deducción de la partida doble; `cashflow-command.ts:271,295` cita **ASC 230-10-45-7** (base bruta) y `:399` **230-10-50-3** (no monetarias fuera del cuerpo). Es el único motor del repo que ya cita párrafos ASC.
- **Notas (235)** y **negocio en marcha (205-40, ASU 2014-15)**: la administración evalúa «substantial doubt» por **un año desde la fecha de emisión** (KPMG, fuente #32: «the assessment of going concern is for a period of one year from the financial statements being issued»); IFRS: al menos 12 meses desde la fecha de reporte y afecta la base de preparación. **Regla**: la ventana es parámetro del paquete (`US: 12 meses desde emisión`; `MX/IFRS: 12 meses desde el cierre`) y el checklist de cierre debería tener la casilla; hoy no existe (`period-close.ts`, ver `motores-inventario.md:20`).

### 4.2 ASC 250 — Cambios contables y errores

- Cambio de principio: retrospectivo (reexpresar comparativos y ajustar utilidades acumuladas iniciales) salvo impracticable; cambio de estimación: prospectivo; cambio de entidad: retrospectivo; **corrección de error: reexpresión** («restatement») con revelación. Convergido con NIC 8 y NIF B-1 (`niif-marco-presentacion.md:119-132`), con una diferencia: NIC 1 exige el tercer balance al inicio del comparativo; NIF B-6 no; GAAP tampoco.
- **Regla para el motor**: la corrección de un periodo cerrado nunca edita: reversa + asiento correcto en el periodo abierto (regla ya implementada en `posting.ts`, ver `motores-inventario.md:18`), **más** la vista «como se reportó / ajuste / reexpresado» que `statement restatement generate` promete (`docs/cli-command-catalog.md:2282`, ❌, depende de `report snapshot`). Un cambio de método de costeo o de depreciación es cambio de principio (retrospectivo en libros) **y** cambio de método fiscal (Form 3115 + §481(a), §5.3): son dos eventos con dos fechas, y el `costing edit` del catálogo (`:1500`) ya los distingue.

### 4.3 ASC 326 — Pérdidas crediticias esperadas (CECL)

- Desde ASU 2016-13, estimación de **pérdida esperada durante la vida** del activo desde el día uno (no «incurrida»), para cuentas por cobrar comerciales y activos de contrato incluidos. Vigencia para «all other entities»: **ejercicios que inician después del 15-dic-2022** (ASU 2019-10, fuente #14). **ASU 2025-05** (fuente #10): recurso práctico de asumir que las condiciones al cierre no cambian, y **elección de política para no-PBE de considerar cobros posteriores al cierre**; vigente «annual periods beginning after December 15, 2025», adopción anticipada permitida.
- IFRS 9: modelo de tres etapas (12 meses / vida) con el simplificado de vida para cuentas por cobrar; **NIF C-16** convergida en principios pero sin la dualidad formal (`niif-instrumentos-financieros.md:92`). Fiscal US: **§166 sólo admite el cargo específico**; la reserva es no deducible desde 1986 (fuente #19) → diferencia temporal siempre.
- **Regla**: motor de matriz de antigüedad × tasas por cubeta × ajuste prospectivo; la elección «considerar cobros posteriores» es **panel** (sólo aplica a `libros = us_gaap` no-PBE); el asiento del movimiento (no del saldo) queda como borrador. **Puerta** ya diseñada: `allowance calculate|post|show|history` (`docs/cli-command-catalog.md:767-770`, ❌, y la fila cita «ASC 326 / NIF C-3 y el recurso práctico ASU 2025-05»). **Lo que hay**: nada — `motores-inventario.md:43` lo marca ausente; el rol de estimación no existe en el mapa de roles.

### 4.4 ASC 330 — Inventarios (y por qué LIFO es sólo US)

- Fórmulas: FIFO, **LIFO**, promedio, identificación específica (Deloitte 1.4, fuente #30c: bajo GAAP «FIFO, LIFO, weighted-average cost, and specific identification are acceptable»; bajo IFRS «Last-in, first-out (LIFO) is not permitted»). IAS 2 (fuente #26): sólo «first-in, first-out or weighted average cost». **NIF C-4** eliminó UEPS en 2011 (`niif-activos.md:20`; `docs/auditorias/2026-09-01-integral-iii/normas-de-informacion.md:249`).
- Medición: **costo o VNR, el menor**, para FIFO/promedio (ASU 2015-11, fuente #11: «The amendments in this Update do not apply to inventory that is measured using LIFO or the retail inventory method»); **LIFO y detallistas conservan «lower of cost or market»** con techo (VNR) y piso (VNR menos margen normal) (KPMG, fuente #32). Vigencia para «all other entities»: ejercicios que inician después del 15-dic-2016.
- **Reversión del castigo: prohibida bajo GAAP** (Deloitte 1.4: «An entity is prohibited from reversing impairment losses»; KPMG: «a write-down of inventory to net realisable value (or market) is not reversed for subsequent recoveries»); **obligatoria bajo IAS 2 y NIF C-4** (`niif-activos.md:14,20`).
- **Conformidad LIFO** (IRC §472(c), fuente #17): el contribuyente que elige LIFO para impuestos no puede usar otro método «for the purpose of a report or statement covering such taxable year (1) to shareholders, partners, or other proprietors, or to beneficiaries, or (2) for credit purposes»; §472(e) lo extiende a todos los años posteriores. **26 CFR 1.472-2(e)** (fuente #18) lista las excepciones: información suplementaria claramente identificada, valuación del inventario en el balance con otro método (sólo el balance: el resultado debe ser LIFO), informes internos de gestión, informes intermedios (< 1 año), «lower of LIFO cost or market» en estados financieros, y otras. Se elige con **Form 970** adjunta a la declaración del primer año (fuente #24b); cambiar de método después es Form 3115 con ajuste §481(a) (fuentes #24a, #20).
- Fiscal adicional: §471(a) exige que el inventario fiscal «conform… to the best accounting practice»; **§471(c)** exime a quien cumple §448(c) (puede tratar el inventario como materiales no incidentales o seguir sus libros); **§263A(i)** exime del UNICAP con la misma prueba (fuentes #19b-c). NIF/LISR: LISR 41 obliga a registrar la fecha desde la que se usa el método y a conservarlo cinco ejercicios (ya recogido en `docs/cli-command-catalog.md:1498-1500`).
- **Reglas para el motor**:
  1. `metodo_costeo_inventario` es **panel** (decisión del despacho) **con vigencia por libro**: para `libros = mx_nif | ifrs` las opciones son FIFO/promedio/específica; `lifo` sólo aparece si `libros = us_gaap*`. El enum `InventoryCostingMethod.LIFO` (`src/types/index.ts:174`) y el CHECK (`003_banking_assets_inventory.sql:232`) **no se retiran** (contradice la recomendación R-11 de la auditoría integral III, `normas-de-informacion.md:309`, escrita antes de que EE. UU. fuera jurisdicción): se **guardan por jurisdicción**, que es exactamente lo que `costing set` ya promete («Rechaza `--method lifo` en entidades mexicanas», `cli-command-catalog.md:1498`).
  2. Al fijar `lifo` en el libro fiscal, el motor exige que el libro contable de la misma entidad también sea `lifo` (conformidad §472(c)); la única divergencia permitida es la del balance (1.472-2(e)(1)(ii)) y hay que declararla.
  3. `write-down reverse` se rechaza si `libros = us_gaap*`; se permite (y el cierre lo pide) si `mx_nif | ifrs` (`cli-command-catalog.md:1550` ya lo formula: «la asimetría MX/US de reversibilidad es requisito de modelado, no nota al pie»).
  4. La prueba de VNR es partida por partida (GAAP admite por grupo en circunstancias; IAS 2 partida o grupo similar); el motor guarda la base (`--basis`) para el papel de trabajo.
- **Lo que hay**: cascarón de esquema sin escritor; `costing.ts` en cuarentena, D2 en `docs/plan-cierre-brechas.md:3603-3611` («construir mínimo… calculateFIFO/LIFO/WeightedAverage como funciones puras»); `motores-inventario.md:124` lo marca ausente en ambas jurisdicciones; el panel tiene `lleva_inventarios` (`pending-catalog.ts:250`) y nada más.

### 4.5 ASC 340 / 350 / 360 — Diferidos, intangibles, activo fijo

- **340-10 / 340-40**: pagos anticipados; **costos de obtener y cumplir contratos** (comisiones de venta capitalizables, espejo de NIF D-2). Lo que hay: devengo de anticipados completo con panel (`amortizacion_anticipados_convencion`, `umbral_anticipado_mxn`, `pending-catalog.ts:403-473`; `motores-inventario.md:25`); nada de 340-40.
- **350-20 crédito mercantil**: no se amortiza y se prueba anualmente (GAAP general, como IFRS y NIF B-7) **salvo la alternativa PCC** (§3). **350-30 intangibles**: vida definida se amortiza; indefinida se prueba. **350-40 software de uso interno**: capitalización por etapas hoy; **ASU 2025-06** (fuente #16) elimina las etapas y capitaliza «cuando la administración autorizó y comprometió fondos y es probable completar y usar» — vigente «annual periods beginning after December 15, 2027», adopción anticipada permitida. **350-60 criptoactivos** (ASU 2023-08): a valor razonable con cambios en resultados, vigente para todas las entidades ejercicios que inician después del 15-dic-2024 (BDO, fuente #34; IFRS: NIC 38 al costo o revaluación — decisión de agenda 2019, `niif-interpretaciones.md`).
- **Investigación y desarrollo (730)**: gasto cuando se incurre (RSM, fuente #31: «With limited exceptions, research and development costs are expensed as incurred. Costs to develop computer software for external use are capitalized once technological feasibility is established… ASC 985-20»); **IAS 38 obliga a capitalizar desarrollo** cuando se cumplen los seis criterios (`niif-activos.md:129`) y **NIF C-8 converge** (`:141`). NIF C-8 y ASC 350 **no** permiten revaluar intangibles; NIC 38 sí con mercado activo (`:142`).
- **360-10 PP&E**: costo histórico; **revaluación no permitida** (RSM: «Revaluation is not allowed. Properties are carried at their historical costs less any impairment»); IAS 16 la permite por clase con superávit en ORI; **NIF C-6 tampoco la permite** (`niif-activos.md:48`) pero **NIF B-10 reexpresa por INPC con inflación trienal ≥ 26 %** (`:49`), cosa que ni GAAP (ASC 830: economía «altamente inflacionaria» = remedir como si la moneda funcional fuera la de la matriz, KPMG fuente #32) ni IFRS fuera de NIC 29 admiten. Depreciación por componentes: permitida en GAAP, obligatoria en IAS 16/NIF C-6.
- **Deterioro (360-10-35)**: **dos pasos** — recuperabilidad con **flujos no descontados** del grupo de activos y, si falla, pérdida = valor en libros − valor razonable (KPMG; RSM); **reversión prohibida** para activos en uso (RSM: «Reversal of impairment losses are prohibited»); IAS 36: un paso con importe recuperable (mayor entre valor razonable menos costos de disposición y valor en uso) y **reversión obligatoria salvo crédito mercantil** (fuente #27: «An impairment loss for goodwill is never reversed»); NIF C-15 converge con IAS 36 (`niif-activos.md:103`). Mantenidos para la venta (360-10-45-9): menor entre libros y valor razonable menos costos de venta, sin depreciar — el `status` de `fixed_assets` no tiene `held_for_sale` (`cli-command-catalog.md:1447`).
- **Reglas para el motor**: `asset revaluation record` se rechaza si `libros ∈ {us_gaap*, mx_nif}` (ya formulado en `cli-command-catalog.md:1455`); `asset impairment reverse` se rechaza si `libros = us_gaap*` (`:1453`); `asset impairment check --framework` corre el test de dos pasos para GAAP y el de un paso para IFRS/NIF (`:1451`); la reexpresión B-10 es sólo MX y sólo con bandera de entorno inflacionario (`:1454`); la capitalización de desarrollo es `casa` por norma (GAAP gasto; IFRS/NIF activo si criterios) y el clasificador de gasto vs activo debe preguntarle al paquete. El **umbral de capitalización** es panel y ya existe (`umbral_capitalizacion_mxn`, `pending-catalog.ts:186`), con el default US anclado al *de minimis safe harbor* (§5.5).
- **Lo que hay**: alta y depreciación con seis métodos y panel (`base_depreciacion`, `convencion_primer_mes`, `depreciacion_faltante_al_cierre`, `pending-catalog.ts:104-185`); **un solo libro** (`motores-inventario.md:122`); MACRS con tablas de 3/5/7/10/15/20 años sólo *half-year* y `macrs_class` nunca escrito (`depreciation-math.ts:263-281`; `motores-inventario.md:79`); intangibles y deterioro «cascarones de esquema sin escritor» (`:125`); la cadena «impairment» sólo aparece en `ifrs-registry.json` (`cli-command-catalog.md:1451`).

### 4.6 ASC 450 — Contingencias (y ASC 410, 460)

- Pérdida contingente: se **acumula** cuando es «probable» que el pasivo se haya incurrido y el monto es razonablemente estimable; «probable» en GAAP significa «likely to occur (i.e., generally greater than 70 percent)» frente a IAS 37 «more likely than not (i.e., greater than 50 percent)»; en un rango donde todos los puntos son igual de probables, **GAAP toma el mínimo** y **IAS 37 el punto medio**; GAAP en general no descuenta, IAS 37 sí (Deloitte 2.2, fuente #30d). Se revela lo «reasonably possible»; lo remoto no. Ganancias contingentes no se reconocen. NIF C-9 converge con IAS 37 (`niif-pasivos-empleados-impuestos.md:24`).
- **Regla**: la provisión es un motor de tres estados (`probable | razonablemente posible | remota`) cuyo umbral numérico de «probable» y cuya regla de rango vienen del **paquete por norma** (`US: >70 %, mínimo` / `IFRS-NIF: >50 %, punto medio o valor esperado`), no del panel: ningún despacho «decide» el umbral. Lo que se decide (panel) es la severidad con que el cierre exige revisar las provisiones. **Lo que hay**: nada — «Pasivos devengados (NIF C-9 / ASC 450-710): ausente» (`motores-inventario.md:26`).

### 4.7 ASC 606 — Ingresos

- Cinco pasos, convergido con NIIF 15 y NIF D-1/D-2 (`niif-ingresos-arrendamientos.md:5-40`; `nif-registro.md:7`). Diferencias menores GAAP↔IFRS: el criterio de cobrabilidad «probable» (GAAP >70 %) vs «probable» IFRS (>50 %); elección de política para presentar impuestos sobre ventas netos; envío y manejo como actividad de cumplimiento (elección GAAP); licencias y renovaciones (matices). Vigencia privada: ejercicios que inician después del 15-dic-2018, con opción de diferir a 2019 (ASU 2020-05, fuente #13).
- **Regla**: la factura no es el evento de reconocimiento (igual que en NIF: `nif-registro.md:9-20`); activo del contrato / pasivo del contrato / cuenta por cobrar son tres saldos distintos; el calendario de diferimiento y el devengo de lo entregado no facturado son un motor (`revenue schedule…`, `revenue run|accrue|rollforward`, `cli-command-catalog.md:780-790`, ❌). `docs/completion-plan.md:378` corta «ASC 606 como motor» y deja «cédula de ingresos diferidos con liberación lineal o por hito»: esa cédula **es** el 90 % de lo que una PyME necesita. Fiscal: LISR 17 (lo primero que ocurra) vs IRC §451(b) (no antes que en el AFS para acumulación) — ambas son conciliación, no reconocimiento. **Lo que hay**: anticipo de cliente como pasivo (`ar-ap-posting.ts:544-565`), sin calendario (`motores-inventario.md:27`).

### 4.8 ASC 718 — Pagos basados en acciones

- Valor razonable a la fecha de otorgamiento, gasto durante el periodo de adquisición de derechos, **elección de política** de estimar cancelaciones o contabilizarlas al ocurrir (ASU 2016-09), atribución lineal permitida para *graded vesting* con condiciones de servicio (IFRS 2 exige acelerada). Privadas: recurso práctico de valuación (ASU 2021-07, no abierto) y **ASU 2024-01** sobre *profits interests* (vigente para no-PBE «annual periods beginning after December 15, 2025», Eide Bailly fuente #35).
- **Regla**: fuera del primer tramo; si entra, es un calendario de gasto contra capital contribuido con dos políticas de panel (cancelaciones; atribución). Sin nada en el repo (grep `stock_comp|share-based`: cero).

### 4.9 ASC 740 — Impuestos a la utilidad

- Método de activos y pasivos por diferencias temporales a la tasa promulgada; **activos diferidos se reconocen en bruto y se reducen con una reserva de valuación cuando es «more likely than not» que no se realicen** (RSM fuente #31; NIC 12 y NIF D-4 reconocen sólo lo probable, neto — `niif-pasivos-empleados-impuestos.md:98-117`); **todo diferido es no circulante** (ASU 2015-17); posiciones fiscales inciertas en dos pasos (reconocimiento si «more likely than not» de sostenerse; medición al mayor monto con >50 % acumulado) vs CINIIF 23 (`:111`); *pass-through* (S-corp, partnership, LLC gravada como tal) **no registran ISR federal de la entidad** — lo pagan los socios — y sí el estatal donde exista impuesto a entidades. **ASU 2023-09** (fuente #15): para no-PBE, conciliación de tasa **cualitativa** e impuestos pagados por jurisdicción federal/estatal/extranjera; vigente «annual periods beginning after December 15, 2025».
- **Regla**: `provision_isr_al_cierre` (propuesta en `docs/jurisdicciones.md:192`) es panel y aplica a ambas jurisdicciones con etiqueta distinta (MX: ISR anual PM y PTU; US: federal 21 % + estatal, o nada si *pass-through*); la **tasa** es ley con vigencia (parámetro); la reserva de valuación es juicio (panel-memorando, `deferred-tax allowance set`, `cli-command-catalog.md:2196`). El insumo de todo es el **libro fiscal separado** (`asset book diff`, `tax-basis show`, `book-tax list|check`, `:1380, 2183-2200`). `docs/completion-plan.md:379` deja «ASC 740 completo» fuera y conserva «balanza y diferencias libro-fiscal»: coincide con lo que el IRS pide en la M-1. **Lo que hay**: `entity_type` en `legal_entities` (`001:82-83`, `types/index.ts:898`) ya distingue `corporation | llc | partnership`; provisión ausente (`motores-inventario.md:21,77`).

### 4.10 ASC 830 — Moneda extranjera

- Moneda funcional por indicadores (sin jerarquía, a diferencia de NIC 21: RSM fuente #31); **remedición** de partidas monetarias en moneda distinta de la funcional al tipo de cierre con ganancia/pérdida **en resultados**; **conversión** de una operación extranjera a la moneda de informe con tipo de cierre (balance), promedio (resultados) e histórico (capital) y **CTA en ORI**; economías altamente inflacionarias: se remide como si la funcional fuera la de la matriz (KPMG fuente #32), sin reexpresión NIC 29 ni NIF B-10 (`niif-moneda-seguros-adopcion.md:24-25,52`). NIF B-15 maneja tres monedas (registro, funcional, informe).
- **Regla**: la **diferencia cambiaria no realizada al cierre** es un motor obligatorio en las tres normas y el repo no lo tiene (`motores-inventario.md:31`: «ausente»); la fuente del tipo de cambio es panel (`fuente_tipo_cambio`, `pending-catalog.ts:708`, sin opción `fed`/`ecb`: `docs/jurisdicciones.md:53`); los tres tipos de tasa existen en `exchange_rates` sin consumidor (`motores-inventario.md:29`). La conversión de una filial (CTA) queda fuera del alcance declarado (`docs/completion-plan.md:380`). **Lo que hay**: realizada sólo en pagos a proveedores; AR en moneda extranjera rechazado con `FX_AR_NOT_WIRED` (`motores-inventario.md:30`).

### 4.11 ASC 842 — Arrendamientos

- Arrendatario: **modelo dual** — todo arrendamiento > 12 meses va al balance (derecho de uso + pasivo), pero se clasifica **operativo** (gasto lineal único) o **financiero** (amortización + interés) por cinco criterios (RSM fuente #31: «Under a dual model, lessees classify leases as either operating or finance leases… Only one accounting model exists for lessees [under IFRS 16]»). Exención de corto plazo (≤ 12 meses) por clase; **sin exención de bajo valor** (IFRS 16 sí, ~5 000 USD). Privadas: recurso práctico de usar la tasa libre de riesgo por clase (ASU 2021-09, no abierto). Vigencia privada: **ejercicios que inician después del 15-dic-2021** (ASU 2020-05, fuente #13). NIF D-5 = modelo único como IFRS 16 (`niif-ingresos-arrendamientos.md:70`).
- **Regla**: el motor de cédula (valor presente, interés efectivo, amortización) es común; la **clasificación** y el patrón de gasto son por norma del libro (`us_gaap*`: dual; `ifrs | mx_nif`: único); la exención de bajo valor es `aplica: false` para GAAP. `docs/completion-plan.md:377` lo deja fuera («cédula calculada afuera, cargada con `entry recurring`»); `motores-inventario.md:126` lo marca «fuera del censo». Fiscal US: no existe ASC 842 en el IRC — el arrendamiento operativo se deduce por renta pagada/devengada; es diferencia temporal.

### 4.12 ASC 832 — Subvenciones gubernamentales (ASU 2025-10)

- Hasta 2025 GAAP no tenía norma para empresas y se aplicaba IAS 20 por analogía; el ASU 2025-10 crea el modelo (reconocer cuando es «probable» cumplir condiciones; presentación bruta o neta) con vigencia para no-PBE «annual reporting periods beginning after Dec. 15, 2029» — **cifra tomada de resultados de búsqueda, no de la página abierta** (verificada=false); el repo ya lo menciona en `src/ai/docs/ifrs-registry.json:495`.

### 4.13 Lo que en GAAP existe y en NIF no se llama igual (para el corpus)

ASC 405-20 baja de pasivos; 410 obligaciones de retiro (NIF C-18); 460 garantías; 470 deuda (incl. clasificación corriente por *covenants* y refinanciamiento, 470-10-45); 480 (acciones rescatables como pasivo); 505 (acciones en tesorería, dividendos, *split*); 710-10-25 vacaciones devengadas (NIF D-3); 720 gastos de arranque a resultados (NIF C-8 igual); 805/810 (fuera de alcance); 835-20 capitalización de intereses (obligatoria como NIC 23); 845 permutas; 850 partes relacionadas; 855 hechos posteriores (NIF B-13, `nif-registro.md:157`).

---

## 5. Libros e impuestos en EE. UU.: lo que el libro arrastra de la declaración

Todo lo de esta sección es **ley** (tabla con vigencia y fuente, `docs/jurisdicciones.md` §3.4), nunca panel.

### 5.1 Ejercicio fiscal (IRC §441, fuente #19d)

- «Taxable year» = periodo contable anual si es año natural o **fiscal year** (12 meses que terminan el último día de cualquier mes distinto de diciembre); **52-53 semanas** electivo si los libros se llevan así (§441(f)(1)); año natural obligatorio si no hay libros. PSC y S-corps: año natural salvo excepción (i1120, fuente #23).
- **Regla**: `legal_entities.fiscal_year_start_month` **tiene que tener lector** (hoy nadie lo lee: `docs/jurisdicciones.md:38`); MX lo fuerza a 1 (CFF 11); US lo permite libre y el paquete declara `permite52_53Semanas` como pendiente. La serie del folio parte por año natural (`sequence.ts:36-46`, `motores-inventario.md:15`): en un ejercicio jul→jun la póliza `JE-2026-…` de junio y la de julio son de ejercicios distintos con el mismo prefijo.

### 5.2 Método contable fiscal (IRC §448, fuente #19a)

- Las C-corps y las sociedades con socio C-corp no pueden usar el método de efectivo **salvo** que cumplan la prueba de ingresos brutos: promedio de tres años ≤ **25 M USD indexado** (§448(c)(1), (c)(4)); **31 M USD para 2025** (instrucciones 1120, fuente #23: «$31 million or less»), **32 M USD para 2026** (Rev. Proc. 2025-32 §4.30, fuente #25, PDF leído: «does not exceed $32,000,000»). Pub 538 en línea sigue en su edición de enero-2022 (26 M USD): **no sirve como fuente de la cifra vigente** (fuente #21).
- La misma prueba abre §471(c) (inventario simplificado), §263A(i) (sin UNICAP) y la exención de §163(j) (límite de intereses). **Regla**: `irc.448c_umbral` con vigencia anual; el paquete US calcula «PyME fiscal» = promedio trienal de ingresos brutos ≤ umbral y lo usa para (a) sugerir `base_contable_fiscal = cash`, (b) apagar UNICAP, (c) permitir inventario «como en libros».

### 5.3 Cambios de método (IRC §481, Forms 3115 y 970)

- Form 3115 «to request a change in either an overall method of accounting or the accounting treatment of any item» (fuente #24a); §481(a): ajustes «necessary solely by reason of the change in order to prevent amounts from being duplicated or omitted» (fuente #20); Form 970 para elegir LIFO, adjunta a la declaración del primer año (fuente #24b). **Regla**: `costing edit` y todo cambio de método de depreciación fiscal generan la tarea «Form 3115 / ajuste §481(a)» en el calendario de obligaciones (ausente: `motores-inventario.md:48`).

### 5.4 Depreciación fiscal (Pub 946 y §179)

- **MACRS**: GDS/ADS; clases 3, 5, 7, 10, 15, 20 años y 27.5/39 para inmuebles; convenciones **half-year, mid-quarter (regla del 40 %), mid-month** (Pub 946, fuente #22). Lo que hay: sólo *half-year* (`depreciation-math.ts:263-281`; `motores-inventario.md:79`).
- **§179**: 2025 «the maximum section 179 expense deduction is $2,500,000», reducido a partir de 4 000 000 (Pub 946; texto vigente de §179(b)(1)-(2) tras P.L. 119-21, fuente #19e); **2026: 2 560 000 / 4 090 000, SUV 32 000** (Rev. Proc. 2025-32 §4.24, fuente #25).
- **Depreciación adicional (§168(k))**: «For property acquired after January 19, 2025: The allowance is reinstated at 100%», con elección de 40 %; adquirido entre 28-sep-2017 y 19-ene-2025 y puesto en servicio en 2025: 40 % (Pub 946, fuente #22).
- **Regla**: libro `fiscal-us` separado del contable (la fila `asset book create` del catálogo, `:1377`, ❌); `depreciacion_convencion_fiscal_us` y la elección §179/bonus son **panel por activo** (propuesta en `docs/jurisdicciones.md:192`); los importes son **parámetros con vigencia por año de puesta en servicio**. La diferencia libro-MACRS es la fila más común de la M-1 (`book-tax check`, `:2186`).

### 5.5 Capitalización mínima: el *de minimis safe harbor* (26 CFR 1.263(a)-1(f))

- Con estados financieros aplicables (AFS: auditados o presentados ante SEC/agencia) y política escrita: hasta **5 000 USD por factura o partida** (f)(1)(i)(D). Sin AFS: **el texto del CFR dice 500 USD** (f)(1)(ii)(D) (fuente #20b); el umbral administrativo de **2 500 USD** lo fijó el Notice 2015-82, **que no abrí** (verificada=false) y que `docs/jurisdicciones.md:180` ya cita como default US de `umbral_capitalizacion_mxn`. Elección anual adjunta a la declaración.
- **Regla**: el default de `umbral_capitalizacion_mxn` para US es 2 500 (5 000 con AFS) y su etiqueta dice «USD»; el sufijo `_mxn` se conserva (`docs/jurisdicciones.md:190`).

### 5.6 Incobrables (IRC §166) y CECL

- «There shall be allowed as a deduction any debt which becomes worthless within the taxable year» (§166(a)(1)); la reserva (§166(c)) se derogó en 1986 (fuente #19f). **Regla**: la estimación CECL es siempre diferencia temporal; `write-off list --for-tax` (`cli-command-catalog.md:774`) produce la relación de cargos específicos.

### 5.7 La declaración como espejo del libro (Form 1120, fuente #23)

- **Schedule L**: balance «per books» al inicio y al cierre — con la base contable que lleve la entidad; **M-1**: «Reconciliation of Income (Loss) per Books With Income per Return»; **M-3** obligatoria con **activos totales ≥ 10 M USD**; M-2: utilidades retenidas no apropiadas. Tasa federal C-corp: 21 % (IRC §11; la página de instrucciones no la cita — verificada para la tasa: false).
- **Regla**: `account map set --scheme us-tax-line` (`account-service.ts:454-458`, columna `us_gaap_code`) es el puente balanza → Schedule L/M-1; hoy el nombre de la columna dice «GAAP» y guarda «línea de la forma»: el corpus debe explicarlo, y el esquema `fs-line` que hoy se rechaza (`:461`) es el que el layout GAAP necesitará.

---

## 6. Tabla de diferencias GAAP ↔ IFRS ↔ NIF que el motor parametriza por **libro**

| # | Tema | US GAAP | IFRS | NIF | Dónde vive la bifurcación | Fuente |
|---|---|---|---|---|---|---|
| 1 | Fórmula de costo LIFO/UEPS | Permitida (ASC 330) + conformidad §472(c) | Prohibida (IAS 2) | Prohibida (C-4, 2011) | Panel `metodo_costeo_inventario` con opciones filtradas por `libros`; motor exige conformidad | #11 #17 #18 #26 #30c; `niif-activos.md:12,20` |
| 2 | Medición del inventario | Costo o VNR (FIFO/promedio); LCM con techo/piso para LIFO/detallistas | Costo o VNR | Costo o VNR | Casa por norma | #11 #32 |
| 3 | Reversión de castigo de inventario | Prohibida | Obligatoria | Obligatoria | Puerta rechaza por `libros` | #30c #32; `niif-activos.md:14` |
| 4 | Revaluación de PP&E | No permitida | Permitida por clase, superávit en ORI | No permitida (C-6); reexpresión B-10 ≥ 26 % trienal | Puerta rechaza por `libros`; B-10 sólo MX con bandera | #31; `niif-activos.md:48-49` |
| 5 | Deterioro de larga duración | Dos pasos, flujos no descontados, **sin reversión** | Un paso, importe recuperable, **reversión** salvo crédito mercantil | Como IFRS (C-15) | Motor con `--framework`; puerta de reversión rechaza en GAAP | #27 #31 #32; `niif-activos.md:103` |
| 6 | Desarrollo | Gasto (730) salvo software (985-20 / 350-40) | Capitalización obligatoria con 6 criterios (IAS 38) | Como IFRS (C-8) | Casa por norma en el clasificador activo/gasto | #31; `niif-activos.md:129,141` |
| 7 | Crédito mercantil | Sin amortización; **PCC: 10 años** | Sin amortización | Sin amortización (B-7) | Sub-base `us_gaap_pcc` | #12 |
| 8 | Orden y clasificación del balance | Liquidez descendente, circulante primero; clasificado por práctica (obligatorio sólo S-X 5-02) | Clasificado salvo liquidez más relevante; sin orden | Clasificado, circulante primero (B-6) | Layout por norma | #3 #32; `niif-marco-presentacion.md:41` |
| 9 | Arrendatario | Dual: operativo / financiero; sin exención de bajo valor | Único; exenciones corto plazo y bajo valor | Único (D-5) | Motor común; clasificación y exenciones por norma | #13 #31; `niif-ingresos-arrendamientos.md:70` |
| 10 | Contingencias | «Probable» ≈ >70 %; mínimo del rango; sin descuento | >50 %; punto medio / valor esperado; descontado | Como IFRS (C-9) | Umbral y regla de rango por norma (casa) | #30d; `niif-pasivos-empleados-impuestos.md:16,24` |
| 11 | Diferidos | Bruto + reserva de valuación (>50 %); todo no circulante; UTP dos pasos | Neto, sólo lo probable; CINIIF 23 | Como IFRS (D-4), sin excepción de reconocimiento inicial | Motor común; presentación y reserva por norma | #15 #31; `niif-pasivos-empleados-impuestos.md:98-117` |
| 12 | Intereses/dividendos en flujos | Fijo: operación (dividendos pagados: financiamiento) | Elección consistente | Fijo: cobrados → inversión; pagados → financiamiento (B-2) | Casa por norma (no panel) | #31; `niif-marco-presentacion.md:110` |
| 13 | Negocio en marcha | 1 año desde la **emisión**; no cambia la base | ≥ 12 meses desde el **cierre**; puede cambiar la base | Como IFRS | Parámetro del paquete; casilla del cierre | #32 |
| 14 | Inflación | Sólo «altamente inflacionaria»: remedir a la moneda de la matriz | NIC 29 (~100 % trienal) | B-10 (≥ 26 % trienal) | Sólo MX; bandera de entorno inflacionario | #32; `niif-moneda-seguros-adopcion.md:52` |
| 15 | Pérdidas crediticias | CECL vida completa; ASU 2025-05 cobros posteriores (no-PBE) | 3 etapas / simplificado | C-16 | Motor común; elección ASU 2025-05 panel sólo GAAP | #10 #14; `niif-instrumentos-financieros.md:92` |
| 16 | Corrección de errores | Reexpresión; sin tercer balance | Reexpresión; tercer balance (NIC 1) | Reexpresión; sin tercer balance (B-1/B-6) | Layout comparativo por norma | `niif-marco-presentacion.md:41,132` |
| 17 | Partidas extraordinarias | Eliminadas (ASU 2015-01); «unusual/infrequent» revelado | Prohibidas | Prohibidas (B-3) | Nada que parametrizar; corpus | #5 (225-20) |
| 18 | Base contable | GAAP / GAAP-PCC / tax basis / cash / FRF for SMEs | IFRS / IFRS PyMEs | NIF (obligatoria) | Sub-dimensión de `libros` para US | #28 |

---

## 7. Parámetros por jurisdicción y por año (ley → tabla con vigencia)

| Clave propuesta | Valor y vigencia | Fuente | Verificada |
|---|---|---|---|
| `us.irc.448c_umbral` | 25 M USD base; **31 M USD ejercicios que inician en 2025**; **32 M USD en 2026** | #19a, #23, #25 | sí |
| `us.irc.179_limite` / `179_reduccion` | 2025: 2 500 000 / 4 000 000; 2026: 2 560 000 / 4 090 000; SUV 2025: 31 300; 2026: 32 000 | #19e, #22, #25 | sí |
| `us.irc.168k_bonus_pct` | 100 % adquirido después del 19-ene-2025; 40 % (60 % larga producción) adquirido antes y puesto en servicio en 2025 | #22 | sí |
| `us.irc.macrs_tablas` | GDS 3/5/7/10/15/20; 27.5/39; convenciones HY/MQ(40 %)/MM | #22 | sí (tablas no transcritas) |
| `us.irc.de_minimis` | 5 000 USD con AFS; 500 USD en el CFR / 2 500 por Notice 2015-82 | #20b | parcial (el 2 500 no se abrió) |
| `us.irc.m3_activos` | 10 M USD de activos totales → Schedule M-3 | #23 | sí |
| `us.irc.tasa_corporativa` | 21 % (IRC §11) | — | **no** (no abierta) |
| `us.gaap.asc326.vigencia_privadas` | ejercicios que inician después del 15-dic-2022; ASU 2025-05 después del 15-dic-2025 | #14, #10 | sí |
| `us.gaap.asc842.vigencia_privadas` | ejercicios que inician después del 15-dic-2021 | #13 | sí |
| `us.gaap.asc606.vigencia_privadas` | después del 15-dic-2018 (opción 2019) | #13 | sí |
| `us.gaap.asu2015-11.vigencia_privadas` | después del 15-dic-2016 | #11 | sí |
| `us.gaap.asu2023-09.vigencia_privadas` | anuales después del 15-dic-2025 | #15, #35 | sí |
| `us.gaap.asu2023-08.vigencia` | después del 15-dic-2024 | #34 | sí |
| `us.gaap.asu2024-01.vigencia_privadas` | anuales después del 15-dic-2025 | #35 | sí |
| `us.gaap.asu2025-06.vigencia` | anuales después del 15-dic-2027 | #16 | sí |
| `us.gaap.asu2025-10.vigencia_privadas` | anuales después del 15-dic-2029 | búsqueda | **no** |
| `us.gaap.asu2026-01 / 2026-02` | Equity (505) después del 15-dic-2026; créditos ambientales (818) después del 15-dic-2028 | #35 | sí |
| `us.gaap.pcc_goodwill_vida_max` | 10 años, línea recta | #12 | sí |
| `us.gaap.asc450.umbral_probable` | «likely», ~>70 %; rango → mínimo | #30d | sí (guía secundaria) |
| `us.gaap.asc205-40.ventana_meses` | 12 desde emisión | #32 | sí (guía secundaria) |
| `us.gaap.asc842.corto_plazo_meses` | 12; sin exención de bajo valor | #31 | sí (guía secundaria) |
| `us.gaap.asc230.intereses` | operación; dividendos pagados financiamiento | #31 | sí (guía secundaria) |

Ninguno de estos valores existe hoy en `tax_parameters` ni en código, salvo las tablas MACRS (`depreciation-math.ts:263`) y el diseño de `parametros_legales` (`docs/jurisdicciones.md:196-213`, que ya lista `irc.de_minimis`, `macrs.tablas`, `sec179.limite`, `bonus.pct` como «no existe»).

---

## 8. Reglas concretas para el motor (numeradas, con fuente)

1. **La norma del libro es una dimensión de la entidad, con sub-base para US** (`us_gaap | us_gaap_pcc | us_tax_basis | us_cash_basis | frf_smes`); el CHECK de `001:87-88` la admite hoy sólo como `us_gaap`. Fuentes #4, #12, #28.
2. **Ninguna regla de la SEC entra al paquete US** salvo `sec_registrant = true`. Fuentes #1-#3.
3. **LIFO** aparece como opción de `metodo_costeo_inventario` sólo con `libros = us_gaap*`; al elegirlo en el libro fiscal, el contable debe ser LIFO (§472(c)); la divergencia sólo en balance (1.472-2(e)(1)(ii)) se declara. Fuentes #17, #18, #24b.
4. **Reversión de castigos de inventario y de deterioro de larga duración: rechazada en `us_gaap*`, exigida en `ifrs | mx_nif`.** Fuentes #26, #27, #30c, #31, #32.
5. **Revaluación de PP&E: sólo `ifrs`.** Reexpresión B-10: sólo `mx_nif` con bandera de entorno inflacionario. Fuente #31; `niif-activos.md:48-49`.
6. **Deterioro**: test de dos pasos con flujos no descontados para `us_gaap*`; importe recuperable para `ifrs | mx_nif`. Fuentes #31, #32.
7. **Desarrollo**: gasto en `us_gaap*` salvo software (985-20 / 350-40, ASU 2025-06 desde 2028); activo con criterios en `ifrs | mx_nif`. Fuentes #16, #31.
8. **Crédito mercantil**: amortización a ≤ 10 años sólo con `us_gaap_pcc`. Fuente #12.
9. **Layouts de estados por norma** (orden, clasificación, ORI, subtotales, comparativos, tercer balance); `fs_category` necesita `other_comprehensive_income`, `contributed_capital`, `retained_earnings`, `treasury_stock`, `non_current_deferred_tax`. Fuentes #3, #32; `001:115-121`.
10. **Flujos de efectivo**: clasificación de intereses/dividendos por norma, no por `account_type` ni por panel; efectivo restringido dentro del total; FX aparte. Fuente #31; `cash-flow-service.ts`.
11. **Negocio en marcha**: casilla de cierre con ventana por norma (12 meses desde emisión en GAAP). Fuente #32.
12. **CECL**: matriz de antigüedad × tasas × ajuste prospectivo; política «cobros posteriores» sólo no-PBE GAAP; movimiento como borrador; estimación no deducible (§166). Fuentes #10, #14, #19f.
13. **Contingencias**: tres estados; umbral y regla de rango por norma (>70 %/mínimo vs >50 %/medio). Fuente #30d.
14. **Ingresos**: activo del contrato / pasivo del contrato / CxC como tres saldos; calendario de diferimiento y devengo de lo no facturado. Fuente #13; `nif-registro.md:7-20`.
15. **Diferidos**: libro fiscal por activo; diferencias temporales × tasa promulgada; reserva de valuación como memorando (panel); todo no circulante en GAAP; *pass-through* sin ISR federal de entidad. Fuentes #15, #31; `001:82-83`.
16. **Moneda extranjera**: remedición de monetarios al cierre a resultados (ausente hoy); CTA en ORI sólo en consolidación (fuera de alcance). Fuentes #31, #32.
17. **Arrendamientos**: cédula común; clasificación dual sólo GAAP; sin exención de bajo valor en GAAP. Fuentes #13, #31.
18. **Ejercicio fiscal**: `fiscal_year_start_month` con lector; 52-53 semanas declarado como pendiente; folio por ejercicio. Fuente #19d.
19. **PyME fiscal (§448(c))** derivada del promedio trienal contra `us.irc.448c_umbral` con vigencia; enciende §471(c), §263A(i), §163(j). Fuentes #19a-c, #25.
20. **Cambio de método** (costeo, depreciación fiscal): tarea Form 3115/§481(a) en el calendario de obligaciones. Fuentes #20, #24a.
21. **Depreciación fiscal US**: libro `fiscal-us`, tres convenciones, §179 y bonus por activo con importes por año de puesta en servicio. Fuentes #19e, #22, #25.
22. **Puente a la declaración**: `us_gaap_code` = línea de la 1120 (Schedule L / M-1); M-3 desde 10 M USD. Fuente #23; `account-service.ts:454-458`.
23. **Validación**: las siete reglas de `validation.ts` citan sólo NIF (`:59,82,149-150,184,263,331-337`); para `libros = us_gaap*` los mensajes deben citar el párrafo ASC equivalente (dualidad → ASC 105 / Concepts; reversa no edición → ASC 250-10-45-23; moneda → ASC 830-20-35-1; capital por actos formales → ASC 505). Es la contraparte de `nif-validaciones.md`.
24. **El agente** abre el corpus por `jurisdiccion.libros`, no por país (`system-prompt.ts:57-63` hoy manda a NIF siempre). Fuente: `docs/jurisdicciones.md:256,278`.

---

## 9. Lo que el repo ya tiene (verificado con `archivo:línea`)

- **Conmutador**: `esContabilidadMexicana` (`src/services/accounting/pais-contable.ts:35-44`): `mx_nif` o país MX/nulo → México; sólo un país distinto sale. Dos consumidores (`entity-accounting.ts:75,172` según `docs/jurisdicciones.md:24`). No devuelve norma del libro.
- **Entidad**: `accounting_standard IN ('us_gaap','mx_nif','ifrs')` (`001_core_schema.sql:87-88`; `src/types/index.ts:903`), `entity_type` (`:898`), `fiscal_year_start_month` sin lector (`:904`; `docs/jurisdicciones.md:38`). Alta US: `CATALOGS.USA = { standard: 'us_gaap', currency: 'USD', taxIdType: 'ein', entityType: 'corporation' }` (`src/cli/init/s1-identity.ts:18-19`).
- **Catálogo**: `CATALOGO_UNIVERSAL` (`chart-seed.ts:44-82`), `ESTRATO_FISCAL_MX` (`:92-99`), `ESTRATO_FISCAL_NEUTRO` de tres cuentas (`:123-127`), `catalogoBasePara(esMexicana)` (`:141-145`). El propio archivo dice «un catálogo US GAAP completo es justamente lo que [el plan de cierre] corta del alcance» (`:104-106`). La 3300 «reserva legal» (LGSM) va en el universal (`:64`).
- **Mapeo estatutario**: `MAPPING_SCHEMES = { 'sat-agrupador': 'mx_nif_code', 'us-tax-line': 'us_gaap_code', 'ifrs': 'ifrs_code' }` (`account-service.ts:454-458`); `fs-line`, `cash-flow`, `consolidation` rechazados con mensaje (`:461-472`). Columnas en `001:129-131`.
- **Panel**: 39 claves sin jurisdicción (`pending-catalog.ts:14-38` tipo; claves en `:50-1055`); las que tocan este tema: `catalogo_entidad_no_mexicana` (`:50`), `base_depreciacion` (`:104`), `convencion_primer_mes` (`:132`), `umbral_capitalizacion_mxn` (`:186`), `lleva_inventarios` (`:250`), `flujo_efectivo_*` (`:516-594`), `destino_del_resultado_del_ejercicio` (`:625`), `fuente_tipo_cambio` (`:708`).
- **Motores que ya citan ASC**: flujos de efectivo (`cash-flow-service.ts:14`; `cashflow-command.ts:271,295,399` con 230-10-45-7 y 230-10-50-3); MACRS (`depreciation-math.ts:263-281`, sólo half-year). El enum de costeo ya admite `lifo` (`types/index.ts:172-177`; `003:231-232`).
- **Nómina US**: registro completo (`register-all.ts:34-60`: FIT, FICA, Additional Medicare, FUTA, 51 SIT/SUTA/SDI, locales) — es lo que `docs/SCOPE.md:9` llama «la nómina federal y estatal y poco más».
- **Diseño ya escrito** (no código): `docs/jurisdicciones.md` (paquete por jurisdicción §3.2, panel con dimensión §3.3, `parametros_legales` §3.4, corpus por jurisdicción §3.8 y J0.8 en `:278`); `docs/cli-command-catalog.md` con familias enteras ❌ que ya nombran la norma: estimación ASC 326 (`:767-770`), ingresos diferidos y contratos ASC 606 (`:780-796`), libros de activos y `book diff` ASC 740 (`:1377-1380`), deterioro/revaluación con rechazo por norma (`:1451-1455`), `costing set` con rechazo de LIFO en MX (`:1498`), castigo de inventario con rechazo de reversión en GAAP (`:1549-1550`), provisión ASC 740 completa (`:2183-2200`), layouts `--norms us-gaap` y reexpresión ASC 250 (`:2282-2283`), DISE/ASC 280/XBRL (`:2456-2462`).
- **Alcance declarado**: `docs/completion-plan.md:360-362` corta «Consolidación, ASC 740, ASC 606 como motor, ASC 842»; `:377-379` dice qué hace el usuario en su lugar. `docs/SCOPE.md:53`: dos paquetes, «Estados Unidos, parcial (nómina)».
- **Corpus IFRS/NIF** que sirve de espejo: `src/ai/docs/niif-*.md` (10 documentos, 190–328 líneas cada uno), `ifrs-registry.json` (69 fichas, campos `code/title_es/title_en/status/effective/topic/confidence/sources`), `scripts/build-niif-indice.ts` (genera el bloque entre `REGISTRY:BEGIN/END`, `GROUP_ORDER` en `:35-46`), `tests/ai/niif-registry.spec.ts` (exige ≥ 70 fichas, estados válidos, `topic` registrado en `DOC_TOPICS`), `MANIFIESTO.md`/`manifiesto.json` (hash de fuentes por manual), `nif-validaciones.md` (qué valida el motor y qué NIF lo respalda).

## 10. Lo que falta

- **Corpus**: cero documentos GAAP en `src/ai/docs/`; `DOC_TOPICS` sin tema ASC (`docs-tools.ts:17-47`); el prompt manda a NIF/NIIF sin bifurcar por libro (`system-prompt.ts:26,57-63`); `system.md:4` promete «Standards: MX NIF / US GAAP / IFRS per entity» sin sustento.
- **Esquema**: sub-base contable para US; `fs_category` sin ORI ni capital contribuido/ganado (`001:115-121`; auditoría `normas-de-informacion.md:241`); libro fiscal separado; `held_for_sale`; columna `cash_flow_category`; tabla `parametros_legales`.
- **Motores ausentes en ambas jurisdicciones** (censo `motores-inventario.md`): provisiones (`:26`), ingreso diferido calendarizado (`:27`), FX no realizada (`:31`), balance clasificado/ORI (`:40`), subtotales del ER (`:41`), CECL (`:43`), capital/notas/comparativos (`:47`), calendario de obligaciones (`:48`), inventarios (`:124`), intangibles/deterioro (`:125`), arrendamientos (`:126`), provisión de ISR y diferidos (`:21,77`), MACRS completo/§179/bonus (`:79`).
- **Puertas de rechazo por norma** que el catálogo promete y no existen: revaluación, reversión de deterioro, reversión de castigo, LIFO fuera de US.
- **Parámetros**: ninguno de los de §7 vive en tabla.
- **Validación**: mensajes sólo NIF (`validation.ts`), sin contraparte ASC.

---

## 11. El corpus GAAP que hay que escribir (espejo exacto de `niif-*.md`)

Misma forma que `niif-activos.md` (`:1-60`): encabezado con alcance y cuándo aplica; por norma: **Vigencia** (para «all other entities»), descripción, viñetas operativas con asientos (cargo/abono en roles), **«vs IFRS»**, **«vs NIF»**, **«Trampas comunes»**, y un bloque nuevo **«Lo fiscal (1120/1065)»** que en NIIF no hace falta y en GAAP es la mitad del trabajo. Código dual en cada cita («ASC 842 / IFRS 16 / NIF D-5») y párrafo cuando la regla lo tenga («ASC 330-10-35-1B»).

| Archivo | Tópicos | Espejo de | Líneas estimadas |
|---|---|---|---|
| `gaap-indice.md` | Qué es la Codificación, jerarquía 105, SEC y a quién aplica, bases contables de PyME (§3), mapa FAS→ASC, vigencias 2025-2030 para privadas, bloque generado desde `asc-registry.json`, playbook de actualización (fuentes que responden: `storage.fasb.org`, PwC Viewpoint, Cornell; las que no: fasb.org) | `niif-indice.md` | 200 |
| `gaap-presentacion.md` | 205 (incl. 205-20, 205-40), 210, 215, 220, 225, 230, 235, 250, 272, 275; nota de que 260/270/280 son PBE | `niif-marco-presentacion.md` | 250 |
| `gaap-activos.md` | 305, 310, 326, 330 (LIFO y conformidad §472), 340, 350 (20/30/40/60), 360, 730, 985-20 | `niif-activos.md` | 300 |
| `gaap-pasivos-capital.md` | 405, 410, 420, 440, 450, 460, 470, 480, 505, 710, 712, 715, 718 | `niif-pasivos-empleados-impuestos.md` | 200 |
| `gaap-ingresos-impuestos.md` | 606, 610, 705, 720, 740 (incl. UTP, ASU 2023-09, *pass-through*), 832 | `niif-ingresos-arrendamientos.md` + `niif-pasivos-empleados-impuestos.md` (NIC 12) | 250 |
| `gaap-transacciones.md` | 820, 825, 830, 835, 842, 845, 850, 855; 805/810 sólo con remisión a «fuera de alcance» | `niif-moneda-seguros-adopcion.md` + `niif-grupos.md` | 200 |
| `gaap-pyme-libros-fiscal.md` | PCC (2014-02/-18/-03/-07, 2021-03), FRF for SMEs, tax basis/cash basis, §441/§448(c)/§471(c)/§263A(i)/§166/§179/§168(k)/de minimis, Form 1120 L/M-1/M-3, 3115/970/§481(a), diferencias libro-fiscal típicas | `niif-pymes-convergencia.md` | 250 |
| `gaap-validaciones.md` | Qué valida el motor para un libro GAAP, qué párrafo ASC respalda cada regla R1-R7, qué exige juicio | `nif-validaciones.md` | 80 |

Infraestructura que lo acompaña, en el mismo commit (J0.8 de `docs/jurisdicciones.md:278`):

- `src/ai/docs/asc-registry.json`: espejo de `ifrs-registry.json` con campos `code` («ASC 330»), `title_en`, `title_es`, `status`, `effective_private`, `effective_public`, `topic`, `confidence`, `sources` (sólo URLs que respondieron), `recent_asus` (lista), `ifrs_counterpart`, `nif_counterpart`, `differs_from_ifrs` (bool + nota).
- `scripts/build-gaap-indice.ts` con su `GROUP_ORDER` (presentación, activos, pasivos-capital, ingresos-impuestos, transacciones, pyme-libros-fiscal, validaciones).
- `tests/ai/gaap-registry.spec.ts` espejo de `niif-registry.spec.ts` (≥ 45 fichas; todo `topic` en `DOC_TOPICS`; todo `differs_from_ifrs = true` con nota).
- `DOC_TOPICS` (`docs-tools.ts:17`) gana los ocho temas; `manifiesto.json` los registra (con `sin_revisar` vacío para ellos porque nacen releídos).
- `system-prompt.ts:57-63`: el *grounding* bifurca por `jurisdiccion.libros` — `mx_nif` → `nif-*`; `us_gaap*` → `gaap-*`; `ifrs` → `niif-*`; supletoriedad NIF→NIIF sólo en MX.

---

## 12. Fuentes (todas abiertas por este agente; `verificada` = la URL respondió con contenido)

| # | Título | URL | Emisor | Qué cubre | Aplica a | Verificada |
|---|---|---|---|---|---|---|
| 1 | Release 33-8221, Policy Statement: Reaffirming the Status of the FASB as a Designated Private-Sector Standard Setter (2003) | https://www.sec.gov/rule-release/33-8221 | SEC | FASB designado bajo SOX §108; «generally accepted» | US | sí (redirigida desde `/rules/policy/33-8221.htm`) |
| 2 | 17 CFR 210.4-01 (Reg. S-X) | https://www.law.cornell.edu/cfr/text/17/210.4-01 | SEC vía Cornell LII | Estados no-GAAP presumidos engañosos; IFRS para FPI | US (registrantes) | sí |
| 3 | 17 CFR 210.5-02 (Reg. S-X) | https://www.law.cornell.edu/cfr/text/17/210.5-02 | SEC vía Cornell LII | Renglones y orden del balance | US (registrantes) | sí |
| 4 | ASU 2009-01 / ASC 105 (texto íntegro) | https://viewpoint.pwc.com/dt/us/en/fasb_financial_accou/asus_fulltext/2009/asu_200901generally_/asu_200901generally__US/asu_200901generally__US.html | FASB vía PwC Viewpoint | Jerarquía GAAP; vigencia 15-sep-2009 | US | sí |
| 5 | Titles of Topics and Subtopics in the FASB ASC (PDF) | https://iasplus.com/content/a4455650-7490-4af9-80ef-222377a1ed94 | Deloitte IAS Plus | Lista de tópicos 105–995 | US | sí (PDF leído con pdftotext) |
| 6 | FASB Codification research guide | https://guides.newman.baruch.cuny.edu/FASBCodificationFall2020 | Baruch College (secundaria) | Estructura, secciones, Basic/Professional View | US | sí |
| 7 | FASB Accounting Standards Codification | https://asc.fasb.org/ | FASB | Codificación | US | **no** (403) |
| 8 | FASB — Accounting Standards Codification page | https://www.fasb.org/page/PageContent?pageId=/standards/accounting-standards-codification.html | FASB | Estructura oficial | US | **no** (403) |
| 9 | FASB — About the Codification (PDF) | https://asc.fasb.org/layoutComponents/getPdf?isSitesBucket=true&fileName=FASB_About_the_Codification.pdf | FASB | Estructura oficial | US | **no** (403) |
| 10 | ASU 2025-05 Credit Losses — AR and Contract Assets | https://storage.fasb.org/ASU%202025-05.pdf | FASB | Recurso práctico; elección no-PBE; vigencia | US | sí |
| 11 | ASU 2015-11 Inventory — Simplifying the Measurement | https://storage.fasb.org/ASU%202015-11.pdf | FASB | Costo o VNR; exclusión LIFO/detallistas; vigencia | US | sí (pdftotext) |
| 12 | ASU 2014-02 Accounting for Goodwill (PCC) | https://storage.fasb.org/ASU%202014-02_2.pdf | FASB | Amortización 10 años; evento detonante; vigencia | US (privadas) | sí (pdftotext) |
| 12b | ASU 2014-02 (texto en PwC Viewpoint) | https://viewpoint.pwc.com/dt/us/en/fasb_financial_accou/asus_fulltext/2014/asu_201402intangible/asu_201402intangible_US/asu_201402intangible_US.html | FASB vía PwC | Igual que #12 | US | sí |
| 13 | ASU 2020-05 Effective Dates for Certain Entities (606/842) | https://storage.fasb.org/ASU%202020-05.pdf | FASB | Vigencias privadas 606 y 842 | US | sí (pdftotext) |
| 14 | ASU 2019-10 Effective Dates (326/815/842) | https://storage.fasb.org/ASU%202019-10.pdf | FASB | CECL privadas 15-dic-2022 | US | sí (pdftotext) |
| 15 | ASU 2023-09 Improvements to Income Tax Disclosures | https://storage.fasb.org/ASU%202023-09.pdf | FASB | Conciliación de tasa; vigencias | US | sí |
| 16 | ASU 2025-06 Internal-Use Software | https://storage.fasb.org/ASU%202025-06.pdf | FASB | Fin del modelo por etapas; vigencia 2028 | US | sí |
| 17 | 26 U.S.C. §472 LIFO | https://www.law.cornell.edu/uscode/text/26/472 | Congreso vía Cornell LII | Elección y conformidad (c), (e) | US | sí |
| 18 | 26 CFR 1.472-2 | https://www.law.cornell.edu/cfr/text/26/1.472-2 | Treasury vía Cornell LII | Conformidad y excepciones (e)(1)-(8) | US | sí |
| 18b | 26 CFR 1.472-2 en eCFR | https://www.ecfr.gov/current/title-26/chapter-I/subchapter-A/part-1/subject-group-ECFR3bd2f6d6a3d7b73/section-1.472-2 | eCFR | Igual | US | **no** (redirige a unblock.federalregister.gov) |
| 19a | 26 U.S.C. §448 | https://www.law.cornell.edu/uscode/text/26/448 | Cornell LII | Método de efectivo; prueba 25 M indexada | US | sí |
| 19b | 26 U.S.C. §471 | https://www.law.cornell.edu/uscode/text/26/471 | Cornell LII | Inventarios; exención (c) | US | sí |
| 19c | 26 U.S.C. §263A | https://www.law.cornell.edu/uscode/text/26/263A | Cornell LII | UNICAP; exención (i) | US | sí |
| 19d | 26 U.S.C. §441 | https://www.law.cornell.edu/uscode/text/26/441 | Cornell LII | Ejercicio; 52-53 semanas | US | sí |
| 19e | 26 U.S.C. §179 | https://www.law.cornell.edu/uscode/text/26/179 | Cornell LII | 2 500 000 / 4 000 000 tras P.L. 119-21 | US | sí |
| 19f | 26 U.S.C. §166 | https://www.law.cornell.edu/uscode/text/26/166 | Cornell LII | Cargo específico; reserva derogada | US | sí |
| 20 | 26 U.S.C. §481 | https://www.law.cornell.edu/uscode/text/26/481 | Cornell LII | Ajuste por cambio de método | US | sí |
| 20b | 26 CFR 1.263(a)-1 | https://www.law.cornell.edu/cfr/text/26/1.263(a)-1 | Cornell LII | De minimis (f): 5 000 con AFS; 500 en el texto | US | sí (el 2 500 de Notice 2015-82 **no** se abrió) |
| 21 | IRS Publication 538 | https://www.irs.gov/publications/p538 | IRS | Periodos y métodos; LIFO/Form 970 (edición ene-2022, 26 M) | US | sí |
| 22 | IRS Publication 946 (2025) | https://www.irs.gov/publications/p946 | IRS | MACRS; §179 2025; bonus 100 % | US | sí |
| 23 | Instructions for Form 1120 | https://www.irs.gov/instructions/i1120 | IRS | Schedule L, M-1, M-3 (10 M), 31 M 2025 | US | sí |
| 24a | About Form 3115 | https://www.irs.gov/forms-pubs/about-form-3115 | IRS | Cambio de método | US | sí |
| 24b | About Form 970 | https://www.irs.gov/forms-pubs/about-form-970 | IRS | Elección LIFO | US | sí |
| 25 | Rev. Proc. 2025-32 (2026 inflation adjustments) | https://www.irs.gov/pub/irs-drop/rp-25-32.pdf | IRS | 448(c) 32 M; §179 2 560 000 / 4 090 000; SUV 32 000 | US | sí (pdftotext) |
| 26 | IAS 2 Inventories | https://www.ifrs.org/issued-standards/list-of-standards/ias-2-inventories/ | IFRS Foundation | Costo o VNR; sólo FIFO/promedio | IFRS (ambas por supletoriedad) | sí |
| 27 | IAS 36 Impairment of Assets | https://www.ifrs.org/issued-standards/list-of-standards/ias-36-impairment-of-assets/ | IFRS Foundation | Importe recuperable; reversión salvo crédito mercantil | IFRS | sí |
| 28 | AICPA unveils framework designed for streamlined reporting (jun-2013) | https://journalofaccountancy.com/news/2013/jun/20138135.html | Journal of Accountancy (AICPA) | FRF for SMEs: no-GAAP, opcional | US (privadas) | sí |
| 28b | AICPA FRF for SMEs landing | https://www.aicpa-cima.com/resources/landing/financial-reporting-framework-for-small-and-medium-sized-entities | AICPA | — | US | respondió **sin contenido** (sólo pie de página) |
| 29 | CINIF | https://www.cinif.org.mx/ | CINIF | Portada; «Listado de Normas Promulgadas» y Libro NIF 2026 (sin listado en la página) | MX | sí (sin detalle) |
| 30a | Deloitte Roadmap IFRS vs U.S. GAAP — Preface | https://dart.deloitte.com/USDART/home/publications/deloitte/additional-deloitte-guidance/roadmap-ifrs-us-gaap-comparison/preface/preface | Deloitte DART | Edición 2025, vigente a 1-ene-2026 | ambas | sí |
| 30b | Deloitte Roadmap — índice | https://dart.deloitte.com/USDART/home/publications/deloitte/additional-deloitte-guidance/roadmap-ifrs-us-gaap-comparison | Deloitte DART | Capítulos | ambas | sí |
| 30c | Deloitte Roadmap §1.4 Inventories | https://dart.deloitte.com/USDART/home/publications/deloitte/additional-deloitte-guidance/roadmap-ifrs-us-gaap-comparison/chapter-1-assets/1-4-inventories | Deloitte DART | LIFO; reversión prohibida en GAAP | ambas | sí |
| 30d | Deloitte Roadmap §2.2 Contingencies | https://dart.deloitte.com/USDART/home/publications/deloitte/additional-deloitte-guidance/roadmap-ifrs-us-gaap-comparison/chapter-2-liabilities/2-2-contingencies | Deloitte DART | >70 % vs >50 %; mínimo vs punto medio; descuento | ambas | sí |
| 30e | Deloitte Roadmap §1.7 y §4.1 | …/chapter-1-assets/1-7-impairment-of-nonfinancial-assets ; …/chapter-4-presentation/4-1-presentation-of-financial-statements | Deloitte DART | — | ambas | **no** (404 «Tree node not found») |
| 31 | RSM — U.S. GAAP to IFRS Comparisons (abril 2026, PDF) | https://rsmus.com/content/dam/rsm/insights/financial-reporting/1pdf/us-gap-to-irfs-comparisons-11-25.pdf | RSM US | Deterioro sin reversión; sin revaluación; I+D; modelo dual 842; reserva de valuación; intereses en flujos | ambas | sí (pdftotext) |
| 32 | KPMG — IFRS compared to US GAAP (nov-2025, PDF) | https://assets.kpmg.com/content/dam/kpmgsites/xx/pdf/ifrg/2025/isg-handbook-2025-ifrs-compared-to-us-gaap.pdf.coredownload.pdf | KPMG | Balance clasificado/S-X 5-02; castigo de inventario sin reversión; LCM techo/piso; negocio en marcha 1 año; alta inflación | ambas | sí (pdftotext) |
| 32b | KPMG — landing IFRS compared to US GAAP | https://kpmg.com/xx/en/what-we-do/services/audit/corporate-reporting-institute/ifrs/toolkit/us-gaap-comparison.html | KPMG | Landing sin detalle | ambas | sí (sin detalle) |
| 33 | EY — US GAAP versus IFRS: The basics (ene-2026) | https://www.ey.com/en_us/technical/accountinglink/us-gaap-versus-ifrs--the-basics-january-2026 | EY | Landing; el PDF no se abrió | ambas | sí (sin detalle) |
| 33b | EY — Effective date matrix (31-mar-2026, PDF) | https://www.ey.com/content/dam/ey-unified-site/ey-com/en-us/technical/accountinglink/documents/ey-eff30493-261us-04-07-2026.pdf | EY | — | US | **no** (404) |
| 34 | BDO — New Accounting Standards and Upcoming Effective Dates | https://arch.bdo.com/new-accounting-standards-and-upcoming-effective-dates | BDO | ASU 2023-08 privadas 15-dic-2024 | US | sí |
| 35 | Eide Bailly — 2026 Accounting Standards Updates | https://www.eidebailly.com/insights/alerts/2026/2026-accounting-standards-updates | Eide Bailly | 2023-09, 2024-01, 2025-05 privadas 15-dic-2025; 2026-01, 2026-02 | US | sí |
| 36 | CohnReznick — ASU updates public/non-public | https://www.cohnreznick.com/insights/asu-updates-for-public-and-non-public-companies | CohnReznick | — | US | **no** (403) |
| 37 | PwC — IFRS and US GAAP: similarities and differences | https://www.pwc.com/us/en/ghosts/ifrs-and-us-gaap-similarities-and-differences-guide.html | PwC | — | ambas | **no** (403) |
| 38 | IAS Plus — ASC 330, ASC 360, IAS 2, IAS 36 (resúmenes) | https://www.iasplus.com/en-us/standards/fasb/assets/asc330 ; …/asc360 ; https://www.iasplus.com/en/standards/ias/ias2 ; …/ias36 | Deloitte IAS Plus | — | ambas | **no** (responden sólo el encabezado «IAS»; contenido por JS) |

No se citan como fuente los resultados de búsqueda que no se abrieron (NATP, Tax Notes, Crowe, Journal of Accountancy 2013-sep, etc.); donde una cifra proviene sólo de ellos (ASU 2025-10 vigencia 2029; ASU 2024-03 sólo PBE; Notice 2015-82 2 500 USD; tasa corporativa 21 %) el texto lo dice y la marca como no verificada.
