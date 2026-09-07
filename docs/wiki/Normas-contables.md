# Normas contables

Qué norma rige a cada entidad, dónde viven sus fuentes en este repositorio, qué sabe de ellas el agente y cómo se mantiene ese saber al día. La investigación que sostiene esta página es la del 2026-09-06: [`docs/investigacion/2026-09-06-normas-y-motores/normas/`](https://github.com/sedecim-com/Accounting/tree/main/docs/investigacion/2026-09-06-normas-y-motores/normas), con toda liga abierta y las muertas dichas.

## Quién lleva qué

| Entidad | Libros | Fiscal | Fuente en el repo |
|---|---|---|---|
| Sociedad mexicana | **NIF** del CINIF, obligatorias para los estados financieros; donde callan, **supletoriedad** a las NIIF (NIF A-1 cap. 90) | LISR, LIVA, LIEPS, CFF, RMF y sus anexos (20 CFDI, 24 contabilidad electrónica), LFT, LSS, LINFONAVIT | [`normas/fiscal-mx.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/investigacion/2026-09-06-normas-y-motores/normas/fiscal-mx.md); corpus del agente `nif-*.md`, `niif-*.md` |
| PyME estadounidense | **No está obligada a GAAP.** Puede llevar GAAP completo, GAAP con las alternativas del *Private Company Council*, base fiscal (*tax basis*), base de efectivo o el FRF for SMEs del AICPA; GAAP es obligatorio para emisoras (SEC) y lo exigen bancos e inversionistas | IRC y su reglamento; IRS (Pub 15, 15-T, 946…), SSA, DOL; cada estado para SIT, SUTA, SDI/PFML, *sales & use tax* y franquicia | [`normas/gaap-asc.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/investigacion/2026-09-06-normas-y-motores/normas/gaap-asc.md), [`normas/fiscal-us.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/investigacion/2026-09-06-normas-y-motores/normas/fiscal-us.md); corpus del agente: **ninguno todavía** |
| Emisora BMV/BIVA o subsidiaria de un grupo IFRS | **NIIF** de aplicación directa | La del país de constitución | [`normas/ifrs-nif-delta.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/investigacion/2026-09-06-normas-y-motores/normas/ifrs-nif-delta.md); `ifrs-registry.json` (72 fichas) y `niif-*.md` |

El esquema ya distingue los tres libros (`accounting_standard IN ('us_gaap','mx_nif','ifrs')`), pero ninguna puerta puede crear una entidad `ifrs` y el motor colapsa todo a «mexicana o no». El diseño que separa **libros** de **fiscal** —una filial constituida fuera que lleva NIF necesita catálogo fiscal de su país y reconocimiento mexicano— está en [[Jurisdicciones]].

## Lo que se parametriza por libro, no por país

Hay diferencias entre GAAP, IFRS y NIF que el motor no puede resolver con un `if (esMexicana)`: dependen del **libro** de la entidad, y una misma sociedad estadounidense puede llevar GAAP o base fiscal. Las que más pesan para una PyME, con su fuente en el informe de US GAAP (§6):

- **LIFO** en inventarios: sólo US GAAP lo permite (con conformidad fiscal, IRC §472); IFRS y NIF lo prohíben. Es la razón de que el método de costeo sea una clave del panel con `aplica: false` fuera de US.
- **Revaluación de activos** y **reversión de deterioro**: IFRS y NIF las admiten; GAAP no. El catálogo de comandos ya declara las puertas de rechazo por norma; ninguna existe todavía.
- **Costos de desarrollo**: capitalizables bajo IFRS/NIF (con criterios); en GAAP se gastan salvo software.
- **Presentación**: subtotales del estado de resultados (NIF B-3 e IFRS 18 desde 2027 frente a ASC 220), orden y clasificación del balance (ASC 210), resultado integral.
- **Arrendamientos**: modelo único para el arrendatario en IFRS 16 y NIF D-5; ASC 842 conserva la clasificación operativo/financiero.
- **Impuestos diferidos** (ASC 740, NIC 12, NIF D-4): distintos en umbrales de reconocimiento y en la posición fiscal incierta.

Y una consecuencia que el delta NIIF/NIF hizo visible: **las citas normativas son un parámetro por jurisdicción y por vigencia.** La NIF B-1 cambia de título en 2028, la NIC 8 se renombra en 2027, y la NIF A-2 ya cambió de contenido en 2026 —hoy es *Incertidumbres sobre negocio en marcha*, y el motor la cita en doce sitios como si fuera el postulado de devengación—. Un literal `'NIF A-2'` en el código es una fecha de caducidad escondida.

## Lo que el agente sabe hoy

- **NIIF y NIF**: el corpus existe —`ifrs-registry.json` con 72 fichas y 154 ligas, diez `niif-*.md` y tres `nif-*.md`— y se re-verificó el 2026-09-06: las vigencias de fondo se sostienen (NIIF 18/19 en 2027, NIIF 20 en 2029, PyMEs 3.ª edición 2027, NIF B-1/B-3 nuevas en 2028). Se corrigieron en el mismo PR la ficha de NIC 28 (negaba una enmienda de junio de 2026 que su propio documento de detalle conocía) y la de NIIF 16 (la revisión post-implementación concluyó el 21 de julio), y dos ligas muertas. Lo que exige redactar —la NIF A-2 de 2026, ONIF 7, las Mejoras 2026 y 2027 (en auscultación hasta el 30 de septiembre), 27 fichas sin página oficial— es la issue **N3**.
- **US GAAP**: nada. `ls src/ai/docs/` no tiene un solo documento de ASC y el *grounding* del agente manda siempre a `nif-*`/`niif-*`, aunque la entidad sea de Delaware. El corpus que hay que escribir —ocho documentos espejo de `niif-*.md` con un bloque nuevo, «Lo fiscal (1120/1065)», más su registro, su generador y su prueba de sincronía— está especificado en el informe (§11) y es la issue **N1**.
- **Fiscal**: `mexico-cfdi.md` cubre el CFDI y el IVA de flujo; de LISR, LIVA, CFF, LFT, LSS, IRC, Pub 15/15-T, FUTA, *sales tax* o 1120/1065 no hay documento. Es la issue **N2**, y depende de la tabla de parámetros legales de [[Jurisdicciones]]: el agente debe leer la cifra vigente por herramienta, no memorizarla en prosa.

## Cómo se mantiene

La fuente de verdad del corpus NIIF es `ifrs-registry.json` (`verified_at` dice el corte). El playbook vive en `niif-indice.md`: revisar ifrs.org, iasplus y el CINIF; corregir el registro y el `niif-*.md` afectado; regenerar la tabla con `npx tsx scripts/build-niif-indice.ts`; correr `tests/ai/niif-registry.spec.ts`, que falla si índice, registro y documentos divergen. Dos lecciones del delta: la cadencia semestral dejó pasar una NIF vigente en 2026, y dos páginas del CINIF (`normatividad_listadonormas.php`, `normatividad_plandetrabajo.php`) redirigen a login —la fuente abierta es la de auscultación y los PDF, que ahora están en `sources_of_truth`—. N3 propone una prueba de frescura para que el corte no pueda envejecer en silencio.

## Para seguir

- [[Jurisdicciones]] — libros y fiscal como dos campos de una misma respuesta, y la tabla de parámetros legales.
- [[Motores-contables]] — qué motor implementa hoy cada norma, y cuál no.
- [[El-agente-y-sus-limites]] — cómo lee el agente el corpus, y por qué no decide criterio.
- [`normas/`](https://github.com/sedecim-com/Accounting/tree/main/docs/investigacion/2026-09-06-normas-y-motores/normas) — los cuatro informes con sus tablas de fuentes.
