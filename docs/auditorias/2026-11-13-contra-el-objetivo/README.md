# Revisión del árbol contra el objetivo del producto · 2026-11-13

> Informe fechado. No se edita: lo que diga hoy el árbol se le pregunta al árbol (`npm run plan:status`, `npm run catalogo:estado`). Lo que aquí se propone se decide en [PRD-003](../../prd/PRD-003-producto-completo.md).

## El objetivo

El que dictó el owner el 2026-11-13:

> un sistema contable CLI completo y multijurisdicción nativo para IA que tenga un core contable y módulos de cálculo de nóminas y cumplimiento de las reglas contables NIF y NIIF

## Qué se revisó y cómo

- **Sobre qué:** `develop` en `6650ec4`. La salud del árbol se repitió sobre `b924930`.
- **Las áreas:** doce lectores, uno por área, cada uno con la misma pregunta: qué existe, qué tan sólido es y qué le falta a esa área para el objetivo. Toda afirmación lleva su evidencia: una ruta con línea o un comando con su resultado.
- **El escéptico:** por cada área, un segundo revisor intentó **refutar** cada brecha bloqueante o mayor buscando lo que el lector dio por ausente, y añadió lo que el lector no vio. De 112 brechas graves con escéptico, confirmó 69, matizó 43 y no refutó ninguna.
- **Los pull requests abiertos:** uno por uno, con fusión de prueba contra `develop`, sus pruebas y un contra-revisor que argumentó contra la recomendación del primero.
- **Lo demás:** las 96 issues abiertas contra el objetivo, los siete PRs de Dependabot y las compuertas del árbol.

Los datos completos, con la evidencia de cada brecha y el veredicto del escéptico, están en [`hallazgos.json`](hallazgos.json). Este documento es su resumen.

### Lo que esta revisión no hizo

- **Dos áreas no tuvieron escéptico** (modelo de datos; superficies fuera del CLI) y el crítico de completitud no llegó a correr. Sus brechas son de un solo lector.
- **Fue de lectura.** Se corrieron las unitarias, los tipos, el lint y los medidores; no la suite de integración completa ni escenarios contra una base con datos.
- **La ley no se cotejó en su fuente oficial.** Lo que se dice de cuotas del IMSS, del subsidio al empleo o del texto de una NIF sale de la investigación del propio repositorio. Antes de tocar un cálculo, se confirma en el DOF o en el CINIF.
- **No se leyeron otros repositorios** de la organización.

## Madurez por área

La escala: ausente, esqueleto, parcial, sólido, completo.

| Área | Dimensión del objetivo | Madurez | Bloqueantes | Mayores | Menores | Brechas graves ante el escéptico |
|---|---|---|---:|---:|---:|---|
| Núcleo: el mayor | Núcleo contable | parcial | 1 | 11 | 0 | 10 confirmadas, 2 matizadas, 0 refutadas |
| Auxiliares y operación | Núcleo contable | parcial | 2 | 10 | 0 | 9 confirmadas, 3 matizadas, 0 refutadas |
| Informes y estados financieros | Núcleo contable | parcial | 3 | 8 | 1 | 9 confirmadas, 2 matizadas, 0 refutadas |
| Modelo de datos y migraciones | Núcleo contable | parcial | 1 | 10 | 1 | no corrió |
| Multijurisdicción | Multijurisdicción | esqueleto | 4 | 7 | 1 | 6 confirmadas, 5 matizadas, 0 refutadas |
| Nómina | Nómina | parcial | 4 | 7 | 1 | 9 confirmadas, 2 matizadas, 0 refutadas |
| Cumplimiento NIF | NIF | parcial | 2 | 8 | 2 | 5 confirmadas, 5 matizadas, 0 refutadas |
| Cumplimiento NIIF | NIIF | esqueleto | 3 | 8 | 1 | 6 confirmadas, 5 matizadas, 0 refutadas |
| La superficie del CLI | CLI completo | parcial | 2 | 8 | 2 | 3 confirmadas, 7 matizadas, 0 refutadas |
| Nativo para IA | Nativo para IA | parcial | 1 | 11 | 0 | 6 confirmadas, 6 matizadas, 0 refutadas |
| Superficies fuera del CLI y peso muerto | Entrega y saneamiento | parcial | 2 | 8 | 2 | no corrió |
| Alcance, plan y proceso | Entrega y saneamiento | parcial | 4 | 8 | 0 | 6 confirmadas, 6 matizadas, 0 refutadas |

Ninguna dimensión del objetivo está por encima de «parcial», y las dos que el objetivo nombra como propiedad del producto —multijurisdicción y NIIF— son esqueleto.

## Lo que atraviesa todas las áreas

1. **La norma contable no gobierna nada.** La entidad guarda su norma y ningún motor, validación, informe ni clave del panel la lee: decide el país. Mientras eso siga así, NIF y NIIF no se separan y un motor nuevo nace atado a México.
2. **El paquete de jurisdicción es diseño.** El contrato está bien pensado en `docs/jurisdicciones.md`; en el código hay dos países cableados y reglas mexicanas dentro del cierre, la validación y el posteo comunes.
3. **REST va por delante del CLI.** Hay motores que sólo se alcanzan por la API —el calendario y los periodos de nómina, el finiquito, los formularios de Estados Unidos—, y el binario ni siquiera registra los calculadores de nómina.
4. **Los instrumentos miden el MVP, no el objetivo.** El plan tiene 13 de 15 paquetes en verde y ningún criterio sobre NIF, NIIF o un tercer país; el catálogo de comandos da un porcentaje global que no distingue dimensiones.
5. **El plan posterior al MVP mira a otro lado.** De las 210 tareas de la ola 4, 82 son de renombrado e idioma, una es de motor NIF y ninguna de motor NIIF.
6. **Hay defectos de integridad confirmados**, pequeños y arreglables hoy: están en `hallazgos.json` con severidad y evidencia, y PRD-003 los lista en «lo que no espera ninguna decisión».

## Por área

### Núcleo: el mayor · parcial

Motor de partida doble sobre PostgreSQL con una sola puerta al mayor (posting.ts): catálogo jerárquico con roles, pólizas borrador a posteada, reversa y anulación, lote importado, folio anual, calendario con periodo 13, cierre suave y duro con checklist, arrastre y reapertura, moneda extranjera en el origen con revaluación (sólo MXN), bitácora de sólo agregar e idempotencia por llave. No hay maestro de dimensiones, presupuestos ni consolidación.

Brechas, de mayor a menor gravedad:

- **bloqueante** · La jurisdicción sólo admite MX o US y ninguna puerta crea una entidad NIIF — confirmado
- **mayor** · Reglas mexicanas viven dentro del cierre, la validación y los roles del motor neutro — matizado
  - Corregido por el escéptico: Las seis casillas mexicanas se imprimen en toda entidad, pero sólo la del agrupador SAT falla de verdad en una no mexicana; dos ya consultan la jurisdicción por dentro y el censo es optativo. Las reglas NIF D-1 y C-11 son avisos, no errores, y corren bajo cualquier norma.
- **mayor** · Multi-entidad sin intercompañía, eliminaciones ni consolidación — confirmado
- **mayor** · Dimensiones analíticas sin maestro ni informes — confirmado
- **mayor** · Moneda extranjera: revaluación sólo con funcional MXN y sin conversión de estados — confirmado
- **mayor** · El calendario fiscal sólo conoce el año natural y nada puede sellar 'locked' — confirmado
- **mayor** · Saldos iniciales y catálogo sólo entran por XML del Anexo 24 con RFC — matizado
  - Corregido por el escéptico: Sólo existen en versión mexicana la carga masiva del catálogo y la apertura con cotejo y documentos abiertos de CxC y CxP. Una entidad sin RFC puede abrir cuenta por cuenta y con una póliza manual, sin cotejo ni auxiliares. Las cuentas de orden siguen fuera.
- **mayor** · No existen presupuestos — confirmado
- **mayor** · El cierre anual busca las cuentas 3900, 3200 y 3300 por código, no por rol — confirmado
- **mayor** · Sellar el ejercicio antes de crear el siguiente deja el año nuevo sin saldos iniciales — confirmado
- **mayor** · El candado de cuatro ojos del lote importado no muerde por el CLI — confirmado
- **mayor** · La protección de cuentas de control se elude declarando un tipo automático por REST — confirmado

El escéptico coincide con la madurez. De acuerdo. Para una sola entidad mexicana en pesos el motor es sólido: una puerta al mayor, mayor inmutable por disparador (041), bitácora de sólo agregar (033), candados de periodo e idempotencia. Como núcleo completo y multijurisdicción le faltan dimensiones, libros por norma, consolidación, presupuestos y moneda funcional distinta de MXN. Cobertura CLI medida: `entry` 13 de 35 filas, `period` 6 de 15, `year` 3 de 12.

Lo que el lector no vio y el escéptico sí:

- **mayor** · Un solo libro por entidad: no hay libros paralelos por norma (NIF, NIIF, fiscal)
- **mayor** · El barrido anual se sella con meses en cierre suave y nadie vuelve a barrer
- **mayor** · El CLI no aplica roles ni permisos: quien lo ejecuta puede postear, sellar y reabrir
- **menor** · Las pólizas manuales no tienen flujo de aprobación
- **menor** · No hay pólizas recurrentes, plantillas ni devengos con reversa programada

### Auxiliares y operación · parcial

CxC (clientes, facturas, notas de crédito, cobros con aplicar, desaplicar y reversar, controles), CxP (proveedores, facturas, pagos, conciliación del auxiliar), bancos (extractos CSV, MT940 y camt053, cotejo, conciliación firmada, comisiones, intereses, cheques), activo fijo (alta y depreciación mensual), pagos anticipados y provisiones de prestaciones, tipos de cambio con diferencia realizada y revaluación de cierre, entidades, despachos y cartera. De inventarios sólo hay tablas.

Brechas, de mayor a menor gravedad:

- **bloqueante** · Inventarios y costo de ventas: no existe motor — confirmado
- **bloqueante** · Activo fijo sin baja, venta, deterioro, revaluación ni componentes — confirmado
- **mayor** · Moneda extranjera a medias en documentos de CxC y CxP — confirmado
- **mayor** · Arrendamientos y préstamos: ausentes, también del catálogo de diseño — confirmado
- **mayor** · CxP sin anulación de factura ni nota de crédito de proveedor — matizado
  - Corregido por el escéptico: Falta el acto, no el aviso: el censo del SAT ya señala el CFDI cancelado que sigue en libros y pide reversarlo, pero no hay `bill void`. La nota de crédito de proveedor tiene plantilla de asiento (cfdi-taxonomy.ts:298-311) y 4 filas de catálogo en fase 2, sin puerta de aprobación. El egreso emitido tampoco entra a CxC por ingesta (issued-invoice-approval.ts:63).
- **mayor** · CxC sin castigo de incobrables ni estimación de deterioro — confirmado
- **mayor** · Entidad limitada a MX o USA y norma contable fija por país — matizado
  - Corregido por el escéptico: La moneda funcional ya se elige al crear. Falta: país abierto, norma elegible e inicio de ejercicio. El tipo de dos ejes existe pero sólo admite 'MX' y 'US', y su campo `books` no tiene consumidor: sólo se lee `.fiscal` (cash-deductibility.ts:89). Archivar sin bitácora ni inquilino en el SQL, confirmado; no hay `entity restore`.
- **mayor** · Bancos en divisa y revaluación sólo sirven con libros en MXN — matizado
  - Corregido por el escéptico: Una cuenta en USD de una entidad mexicana tampoco se concilia bien: extracto en USD contra libros en MXN, sin rechazo. `fx rate set` acepta fuentes ecb y fed (rate-service.ts:41-43), pero ninguna política las lee (57-61): se guardan y no se usan. Revaluación sólo con libros en MXN, y comisiones e intereses rehúsan divisa: confirmado.
- **mayor** · Devengos: sólo pagos anticipados y prestaciones mexicanas — confirmado
- **mayor** · Activo fijo sólo mexicano, con un solo libro y métodos sin puerta — confirmado
- **mayor** · La depreciación ignora la reversa de su póliza — confirmado
- **mayor** · Saldos y antigüedad no son a una fecha y suman monedas distintas — confirmado

El escéptico coincide con la madurez. De acuerdo con «parcial». Medido con `npx tsx scripts/catalogo-estado.ts --json`: bank 34 de 123 filas vivas, bill 10 de 41, asset 2 de 66, inventory 0 de 49; la fase 1 de bancos, CxP y cobros está completa. Es profundo y falla cerrado para México, pero lejos de «completo». No corrí pruebas: revisión de sólo lectura y sin base de datos.

Lo que el lector no vio y el escéptico sí:

- **mayor** · La norma contable no gobierna ningún auxiliar
- **mayor** · Activos migrados: sin depreciación acumulada de apertura ni amarre del padrón contra el mayor
- **mayor** · IA nativa a medias en los auxiliares
- **mayor** · El carril no mexicano de los auxiliares no tiene prueba de extremo a extremo
- **menor** · Formatos y perfiles de extracto: comando inexistente y seis formatos sin lector

### Informes y estados financieros · parcial

Una capa compartida (report-service.ts) sirve a CLI, REST y agente: balanza de cuatro columnas con roll-up, mayor, balance que cuadra por construcción, resultados de un escalón, antigüedad CxC/CxP, auxiliar de cuenta y flujo indirecto amarrado al efectivo real. Estatutario México: Anexo 24 completo con XSD y sello, DIOT y papel de trabajo IVA/ISR. Formatos: table, json, ndjson, csv, tsv, md. Sin marcos de presentación: un solo layout.

Brechas, de mayor a menor gravedad:

- **bloqueante** · La presentación no depende del marco contable de la entidad, y no puede existir una entidad NIIF — confirmado
- **bloqueante** · El estado de resultados es de un solo escalón: sin subtotales NIF B-3 ni resultado integral — confirmado
- **bloqueante** · No existe el estado de cambios en el capital contable (NIF B-4 / NIC 1) — confirmado
- **mayor** · E4.2 sigue en rojo y la deuda crece: siete copias del SQL de saldos fuera de report-service — confirmado
- **mayor** · El balance rotula «Capital contribuido» a utilidades acumuladas y reservas — confirmado
- **mayor** · Ningún estado trae comparativos — confirmado
- **mayor** · Flujo de efectivo: sólo método indirecto, sin intereses, impuestos ni efecto cambiario — confirmado
- **mayor** · Sólo hay informes por entidad: sin consolidación, combinados ni conversión de moneda — confirmado
- **mayor** · No hay notas ni revelaciones a los estados financieros — confirmado
- **mayor** · Formatos de entrega: sin PDF, XLSX ni XBRL; REST sólo JSON — matizado
  - Corregido por el escéptico: Sin PDF, XLSX ni XBRL: cierto. Pero el «paquete del periodo» ya existe en parte: `closing pack generate|verify` emite un expediente JSON sellado y verificable (closing-command.ts:906-1003) que sólo trae balanza y actividad (closing-pack.ts:118-131), no los estados. Conviene ampliarlo en vez de crear otro comando.
- **mayor** · Auxiliares: antigüedad con saldos de hoy, auxiliar con inicial no fiable y sin estados de cuenta — matizado
  - Corregido por el escéptico: Para clientes ya hay una tarjeta al corte que hace de estado de cuenta. Falta que la antigüedad use esa reconstrucción, el equivalente de proveedores (`vendor show` sólo da agregados de toda la vida, vendor-service.ts:304-326) y el saldo inicial y corrido en mayor y auxiliar.
- **menor** · El agente no tiene herramienta de flujo de efectivo y sus informes están escritos a mano

El escéptico coincide con la madurez. De acuerdo con «parcial»: informes operativos y Anexo 24 sólidos; del juego NIF sólo balance, resultados de un escalón y un flujo que se aparta de la B-2; NIIF no existe. Corrección: el agente no tiene flujo de efectivo. Menor: los informes ignoran `--date-basis` (report-command.ts:135). Revisé 6650ec4; origin/develop local va un commit adelante (b924930), sin tocar informes. No corrí pruebas ni git fetch. Rutas relativas a ..

Lo que el lector no vio y el escéptico sí:

- **mayor** · El asiento de apertura entra al flujo de efectivo como cobros y pagos del primer periodo
- **mayor** · Catálogo importado del SAT: balance sin circulante y flujo sin clasificar
- **mayor** · La antigüedad suma monedas distintas en un solo total
- **menor** · «Utilidad del ejercicio» mezcla ejercicios sin cerrar y nada amarra los estados entre sí
- **menor** · El agente no tiene flujo de efectivo, auxiliar ni entregables fiscales

### Modelo de datos y migraciones · parcial

118 migraciones SQL (001 a 324, 11 813 líneas) que aplica `migrate.ts` con transacción por archivo, candado asesor y `rls-policies.sql` reaplicado al final. Esquema resultante, leído de la base local migrada: 123 tablas, 479 índices, 230 FK, 258 CHECK, 38 disparadores y 117 políticas. RLS forzada por inquilino en 110 tablas; la entidad se acota en el SQL de la aplicación (`scope.ts`).

Brechas, de mayor a menor gravedad:

- **bloqueante** · No hay libro por marco contable ni alta de entidad NIIF
- **mayor** · La frontera entre clientes del despacho no está en la base
- **mayor** · La nómina está cableada a México y Estados Unidos en el esquema
- **mayor** · La jurisdicción no tiene modelo propio y la ley tiene forma mexicana
- **mayor** · Impuestos del documento: una tasa DECIMAL(5,2) por línea, sin catálogo ni moneda
- **mayor** · Los totales del asiento tienen costo cuadrático y el posteo va línea por línea
- **mayor** · Numeración de migraciones: la regla escrita no es la que se practica
- **mayor** · Las tablas globales de ley y tipos de cambio las escribe cualquier inquilino
- **mayor** · «La IA no escribe el mayor» no tiene rol de base de datos
- **mayor** · Las dimensiones analíticas no tienen maestro
- **mayor** · El esquema no tiene estructuras para las normas de medición NIF y NIIF
- **menor** · Las garantías de sólo-agregar posteriores a la 058 no están selladas

Esta área no tuvo escéptico: sus brechas son de un solo lector.

### Multijurisdicción · esqueleto

Un conmutador de jurisdicción con dos ejes (`src/services/jurisdiction/jurisdiction.ts`), la tabla `legal_parameters` con vigencia y lector que falla cerrado, la columna `policy_decisions.jurisdiction` con lector, catálogo en estratos (universal, MX, neutro) y un registro de calculadoras de nómina MX/US. Del diseño J0 (`docs/jurisdicciones.md`) están hechos J0.1, J0.2 y J0.7, y J0.4 a medias. El paquete por país no existe en `src/`.

Brechas, de mayor a menor gravedad:

- **bloqueante** · No existe el paquete de jurisdicción: la frontera de plug-in no está en el código — confirmado
- **bloqueante** · Añadir Colombia o España exige editar el motor común; hoy un país desconocido cae en México — matizado
  - Corregido por el escéptico: Un país nuevo no entra por ninguna puerta: se rechaza. Si la fila llegara por SQL, el sistema contesta dos cosas: `jurisdictionOf` dice México; el catálogo y el IVA la tratan como no mexicana. Nómina y panel sí caen en México. Que un tercer país obliga a editar el motor común: confirmado.
- **bloqueante** · El IVA mexicano vive dentro del motor común; no hay motor de impuestos por jurisdicción — matizado
  - Corregido por el escéptico: Una entidad no mexicana sí postea impuesto: una cuenta por pagar y una por acreditar, por devengo. Es un modelo tipo IVA: el impuesto de una compra va a un activo «acreditable» (1136), tratamiento incorrecto para el sales tax de EE. UU. Sin tasas, códigos ni retenciones por jurisdicción. La falta de motor por país: confirmada.
- **bloqueante** · La norma contable (NIF, NIIF, US GAAP) es un eje declarado que nadie lee — matizado
  - Corregido por el escéptico: La norma se lee, pero para otra cosa: `mx_nif` enciende el estrato FISCAL mexicano, y el agente la ve como texto. Ningún reconocimiento, validación o informe cambia por norma, y ninguna puerta crea una entidad NIIF. Aviso: abrir `--standard` destapa que los dos conmutadores discrepan (US con `mx_nif`: `fiscal` dice US, `keepsMexicanBooks` dice mexicana).
- **mayor** · El plan trata lo multijurisdicción como post-MVP y ningún criterio lo mide — confirmado
- **mayor** · Dependencias al revés: los servicios genéricos importan módulos mexicanos — confirmado
- **mayor** · El panel de políticas no tiene dimensión de jurisdicción (J0.3 sin hacer) — confirmado
- **mayor** · Estados Unidos es una esquina: catálogo neutro, sin activos y con valores mexicanos por omisión — confirmado
- **mayor** · La nómina tiene registro de calculadoras, pero su orquestación y su esquema son binarios MX/US — matizado
  - Corregido por el escéptico: Hoy no puede existir un empleado de un tercer país, así que nadie corre ISR e IMSS por error. El defecto es estructural: añadir un país obliga a tocar el orquestador, el CHECK, `chartFor` y la interfaz común. El registro sí distingue sub-jurisdicción: `US-FEDERAL`, 51 estados y localidades.
- **mayor** · Los entregables legales y los comandos por país no cuelgan de la jurisdicción — confirmado
- **mayor** · Parámetros legales: dos sistemas en paralelo, casi todo México, sin comando y sin sub-jurisdicción — matizado
  - Corregido por el escéptico: Son al menos tres almacenes de ley, no dos. La sub-jurisdicción falta en `legal_parameters`, pero existe en `tax_tables` y en el ISN por estado; la entidad no tiene estado validado (`src/services/jurisdiction/jurisdiction.ts:48-65`). Sin comando ni `doctor` para `legal_parameters`: cierto. El ISN ya enseña el patrón de puerta que falta generalizar.
- **menor** · Idioma legal y formato por jurisdicción sin cablear: dos locales y catálogo con nombres fijos en español

El escéptico coincide con la madurez. De acuerdo con «esqueleto». Hay piezas reales: tabla de ley con fallo cerrado, columna del panel con lector, estratos de catálogo y nómina MX y US. Pero la dimensión no gobierna el motor: `jurisdictionOf` tiene un solo llamador y el eje de norma, ninguno. Son dos países cableados a mano. Aviso: corrí una vez `npm run catalogo:estado`, que reescribe su bloque generado; `git status` quedó limpio.

Lo que el lector no vio y el escéptico sí:

- **mayor** · No hay libros paralelos, consolidación ni conversión de moneda: un grupo en dos países no se puede llevar
- **mayor** · El esquema común lleva columnas mexicanas: un país nuevo exige columnas nuevas en tablas compartidas
- **mayor** · Los pisos de seguridad del agente no tienen moneda: el mismo número vale para pesos y para dólares
- **mayor** · El agente razona siempre como contador mexicano: prompt, habilidades y evaluación no miran la jurisdicción
- **menor** · Una ley con lector sólo existe en la semilla de demostración: el tope de efectivo deducible no se aplica en una instalación real

### Nómina · parcial

Nómina MX y EE. UU. en `src/services/payroll` (40 archivos, 10 624 líneas): calculadoras por jurisdicción en un registro, corrida draft→calculated→approved→paid, desglose en `paycheck_taxes`, pasivo patronal, póliza por borrador revisable, ISR 2026 por periodo, subsidio, exenciones art. 93, IMSS, INFONAVIT, ISN, finiquito, provisiones NIF D-3, SUA, CFDI, FIT/FICA/FUTA/SUTA, W-2/941/940. CLI: 18 hojas; REST: 36 rutas.

Brechas, de mayor a menor gravedad:

- **bloqueante** · El motor no calcula percepciones: sólo impuestos sobre importes tecleados — confirmado
- **bloqueante** · Cuota patronal del IMSS incorrecta: cesantía y vejez plana, días sin incidencias, riesgo por clase — confirmado
- **bloqueante** · La nómina no se corre de punta a punta desde el CLI — confirmado
- **bloqueante** · Nómina de EE. UU.: tablas estimadas, tope de Seguro Social en dos valores, FIT sin paso 1g y 5 de 51 estados — confirmado
- **mayor** · Entregables a la autoridad no válidos: CFDI de nómina, SUA, IDSE y EFW2 — matizado
  - Corregido por el escéptico: Los cuatro entregables no son válidos, y el arreglo del CFDI es mayor de lo dicho: hay que incorporar `nomina12.xsd` con su catálogo y resolver el sellado. A favor: el SUA sí tiene puerta en el CLI y cotejo contra el pasivo.
- **mayor** · La jurisdicción no es un paquete enchufable: dos países cableados y la ley en cuatro almacenes — matizado
  - Corregido por el escéptico: Dos países cableados y cuatro almacenes de ley; sólo el ISN se captura por CLI y lo demás por migración, así que 2027 no se puede calcular sin tocar código. El recálculo, además, sobrescribe los totales (ver brechas omitidas).
- **mayor** · Terminaciones y obligaciones anuales de México incompletas — confirmado
- **mayor** · El subsidio que excede al ISR se entrega en efectivo; el decreto vigente no lo permite — confirmado
- **mayor** · La póliza de nómina omite el ISN y lleva el neto directo a banco en la fecha de pago — confirmado
- **mayor** · Tres faltas a los invariantes: SSN en claro, empleado sin alcance en IDSE y timbre sin candado — confirmado
- **mayor** · El tablero dice verde y no ejecuta la nómina — confirmado
- **menor** · El agente no tiene herramientas de nómina y su documento contradice el código

El escéptico coincide con la madurez. De acuerdo con «parcial», en su borde bajo. México retiene ISR y cuotas obreras sobre importes tecleados, con parámetros de 2026 corregidos, pero no calcula el sueldo, cotiza mal la cesantía y duplica el IMSS con dos corridas. Estados Unidos es una demostración. Ningún entregable a la autoridad es válido. No corrí la integración. Ejecuté por error `scripts/catalogo-estado.ts` sin `--check`; `git status` quedó limpio.

Lo que el lector no vio y el escéptico sí:

- **mayor** · Dos corridas en un mismo periodo duplican IMSS e INFONAVIT, y el aguinaldo aparte paga ISR aislado
- **mayor** · El cálculo de la corrida no es atómico ni repetible: se atasca y sobrescribe los totales
- **mayor** · El agente no tiene herramientas de nómina: sólo un documento
- **mayor** · NIF D-3 y NIC 19: beneficios por terminación y a largo plazo fuera de alcance, y nómina sin tratamiento NIIF
- **menor** · El régimen del trabajador y varias periodicidades no entran al cálculo

### Cumplimiento NIF · parcial

No hay módulo de cumplimiento NIF; hay NIF dentro de los motores, y 11 de las 85 claves del panel citan una. (a) Con regla ejecutada, parcial: A-1, B-1, B-2, B-6, B-15, C-6, D-1, D-3. (b) Sólo citadas en corpus, comentarios o cuentas sembradas: B-10, C-1, C-3, C-4, C-8, C-9, C-15, C-16, C-19/C-20, D-4, D-5. (c) Ausentes: B-4 y la estructura de B-3.

Brechas, de mayor a menor gravedad:

- **bloqueante** · NIF D-4: no se calcula el impuesto causado ni el diferido — matizado
  - Corregido por el escéptico: Sí se calcula el ISR provisional del mes (LISR 14), pero sólo como papel: no se registra gasto por impuesto, y no hay impuesto causado anual, conciliación contable-fiscal ni diferido. Ya existen insumos reutilizables: tasa con vigencia, pérdidas fiscales capturadas y serie del INPC.
- **bloqueante** · Estados NIF incompletos: B-3 sin estructura, B-4 ausente, sin comparativos — confirmado
- **mayor** · El cierre no revisa NIF, salvo depreciación y anticipados — matizado
  - Corregido por el escéptico: El cierre conducido sí devenga prestaciones y revalúa moneda extranjera. Falta la casilla que lo exija cuando se cierra directo con `close`, y faltan las atestaciones anuales (A-2, B-10, B-13, C-15). Es trabajo más chico de lo descrito: los motores ya están cableados.
- **mayor** · No hay lista de revelaciones ni notas a los estados — confirmado
- **mayor** · El cumplimiento NIF no tiene PRD, épica ni paquete de criterios en el plan — matizado
  - Corregido por el escéptico: No hay PRD, épica ni criterios, pero sí diseño previo: 54 filas de catálogo en fases 2 y 3, la investigación del 2026-09-06 y la tarjeta E5.1-i. El PRD debe partir de esas filas y decidir cuáles suben de fase, no empezar de cero.
- **mayor** · La norma contable de la entidad (books) no gobierna nada — matizado
  - Corregido por el escéptico: La norma no gobierna reconocimiento, medición ni presentación; hoy sólo enciende el estrato fiscal mexicano y una línea del prompt. Y no se puede declarar una entidad NIIF: el país fija la norma y `entity edit` no la cambia. Para el objetivo «NIF y NIIF» esto va primero.
- **mayor** · Faltan estimaciones y valuación posterior: C-3/C-16, C-15, C-9, C-8 y bajas de C-6 — confirmado
- **mayor** · Inventarios (NIF C-4): hay esquema, no hay motor, y el esquema admite UEPS — confirmado
- **mayor** · Arrendamientos (NIF D-5) sin motor — confirmado
- **mayor** · Saber normativo NIF: corpus delgado, sin registro ni sello, y citas literales — matizado
  - Corregido por el escéptico: Confirmado salvo «sin sello»: existe una prueba de citas, sólo para A-2. El registro NIF ya está especificado (docs/plan-cierre-brechas.md:8070, tarjeta E5.1-i) pero no está en PRD-001.json ni construido. La exención del manifiesto se apoya en un registro normativo NIF que no existe.
- **menor** · Las advertencias NIF se calculan y se descartan al postear
- **menor** · Motores que existen, con recortes frente a su NIF: B-15, B-2 y B-10

El escéptico coincide con la madurez. De acuerdo, en el extremo bajo de «parcial»: hay motores reales con cita NIF (D-3, C-5, C-6, B-15, B-2) cableados al cierre, pero no se puede emitir un juego de estados NIF: faltan B-4, notas, comparativos e impuesto a la utilidad. El panel tiene 84 claves, no 85. No verifiqué contra el texto oficial del CINIF ni corrí pruebas con base de datos.

Lo que el lector no vio y el escéptico sí:

- **mayor** · Inventarios perpetuos: el panel ofrece una opción cuya mitad no tiene motor
- **mayor** · La habilidad de cierre del agente es anterior a los motores y puede duplicarlos
- **mayor** · Ingresos (NIF D-1 y D-2): sin motor de reconocimiento ni ingreso diferido
- **mayor** · Consolidación (NIF B-8) y conversión de operaciones extranjeras (B-15) ausentes
- **menor** · Nada mide el criterio NIF del agente

### Cumplimiento NIIF · esqueleto

(a) Reglas NIIF ejecutadas por código: ninguna; 0 citas NIIF/NIC en `src/services` y `src/cli`, contra 113 de NIF. (b) Conocimiento para el agente: `src/ai/docs/ifrs-registry.json` (74 fichas), diez tarjetas `niif-*.md` servidas por `read_docs`, índice generado y prueba de frescura. (c) Marcadores sin efecto: valor `ifrs` en el CHECK de `accounting_standard` (001_core_schema.sql:87-88), `Jurisdiction.books` sin lector (jurisdiction.ts:45,179) y `accounts.ifrs_code`, texto libre.

Brechas, de mayor a menor gravedad:

- **bloqueante** · Ninguna puerta permite declarar una entidad NIIF — confirmado
- **bloqueante** · Declarar `ifrs` no cambia ningún comportamiento — matizado
  - Corregido por el escéptico: Declarar `ifrs` sólo cambia una frase del prompt del agente. Ningún motor, validación, informe ni clave del panel lee `books`: una entidad MX+ifrs recibe catálogo, estrato fiscal y citas NIF; una US+ifrs se trata como GAAP. Decide el país, no la norma.
- **bloqueante** · Juego de estados financieros NIIF incompleto y sin plantilla por norma — matizado
  - Corregido por el escéptico: Hay tres de los cuatro estados básicos, con cita NIF B-2/ASC 230 y sin leer la norma. Faltan cambios en el capital, resultado integral, comparativos, notas y subtotales. Ni el diseño contempla NIIF: `--norms nif|us-gaap` (docs/cli-command-catalog.md:2283,2292). La única tarea parecida es para ASC (MNE-001-343).
- **mayor** · Motores de medición NIIF ausentes — matizado
  - Corregido por el escéptico: Faltan los seis motores y además la provisión del impuesto causado (MNE-001-300, Could, abierta). Arrendamientos ni siquiera está diseñado: 0 filas `lease` en un catálogo de 1 640. Inventarios admite `lifo` en el esquema (003_banking_assets_inventory.sql:232), que NIC 2 prohíbe. Pérdidas esperadas sólo tiene tarea para ASC 326 (MNE-001-337).
- **mayor** · Sin multi-GAAP: un solo libro por entidad — confirmado
- **mayor** · Sin consolidación ni conversión de grupo — matizado
  - Corregido por el escéptico: Sin consolidación, eliminaciones ni conversión NIC 21. La contraparte intercompañía ya está marcada en clientes y proveedores, sin lector y sin mantenimiento en el alta; falta llevarla a la línea de póliza. La jerarquía de grupo existe en el esquema y nadie la usa.
- **mayor** · El plan no contiene un módulo NIIF y dos documentos lo prometen — matizado
  - Corregido por el escéptico: Tres documentos lo prometen: SCOPE.md:19, README_ACCOUNTANT.md:3 y system.md:4, este último leído por el agente como verdad. El backlog sí trae motores de norma, pero sólo para US GAAP y en «Could»: estados comparativos con resultado integral (MNE-001-343), pérdidas esperadas (-337) e impuesto corriente (-334). Escritos por `books`, servirían también a NIIF.
- **mayor** · Validaciones y mensajes citan sólo NIF, con literales en código — confirmado
- **mayor** · NIIF para PyMEs existe sólo como una sección de una tarjeta — confirmado
- **mayor** · NIIF es marco local en países que el producto no modela — confirmado
- **mayor** · El agente lee tarjetas más viejas que el registro y nada lo detecta — confirmado
- **menor** · Registro: vigencias sólo en prosa e incoherencias internas

El escéptico coincide con la madurez. De acuerdo con «esqueleto»: cero reglas NIIF ejecutadas, corpus sólido para el agente y marcadores sin lector. Matiz: balance clasificado con ORI, resultados, flujo de efectivo y cuatro motores del cierre existen y son reutilizables, pero citan NIF y ninguno lee la norma; por eso no sube a «parcial». Rutas relativas a ., en origin/develop 6650ec4.

Lo que el lector no vio y el escéptico sí:

- **mayor** · Ingresos NIIF 15: se reconocen al facturar, sin obligaciones de desempeño
- **mayor** · El cierre no tiene compuertas de medición ni distingue norma
- **mayor** · El diseño de paquetes es por país; la norma no tiene paquete ni decisión
- **menor** · Beneficios a empleados a largo plazo (NIC 19 / NIF D-3) fuera de alcance y sin tarea
- **menor** · El panel y el esquema admiten opciones que la NIIF prohíbe

### La superficie del CLI · parcial

CLI `mnemosine` (Commander/TypeScript, src/cli): 278 comandos ejecutables en 76 familias, 382 nodos. Núcleo compartido en src/cli/kernel (riesgo, banderas, salida, códigos de salida, ayuda por clave). Contra el catálogo de diseño de 1,640 filas, 263 son invocables (16.0 %; 18.8 % del objetivo comprometible de 1,397); de fase 1, 220 de 392. Medido en 6650ec4 con `npx tsx scripts/catalogo-estado.ts --check` y `scripts/ux-status.ts --check` (ambos verdes).

Brechas, de mayor a menor gravedad:

- **bloqueante** · NIIF no existe en la superficie del CLI ni en su catálogo de diseño — matizado
  - Corregido por el escéptico: NIIF existe como conocimiento del agente, consultable con `ask` y `chat`, y como dato sin lector (`accounts.ifrs_code`, el CHECK 'ifrs'). No existe como marco operable: ninguna hoja declara una entidad NIIF ni presenta o valida un estado bajo NIIF. La gravedad bloqueante se mantiene.
- **bloqueante** · Nómina: el flujo no puede empezar desde el CLI y cubre 18 de 169 filas — matizado
  - Corregido por el escéptico: El flujo no arranca desde el CLI: cierto y bloqueante. Pero falta menos motor del que parece: calendario, baja, finiquito y recibo CFDI ya existen y sólo piden hoja; aguinaldo y horas extra se calculan dentro de `pay-run calculate --file`. Sin motor quedan PTU e incidencias (faltas, incapacidades). El primer tramo es M, no L.
- **mayor** · La aprobación humana de borradores de IA sólo existe como menú interactivo — confirmado
- **mayor** · No hay puente agente–CLI ni autodescripción legible por máquina — matizado
  - Corregido por el escéptico: Falta el puente y falta el manifiesto estructurado con riesgo, permiso de IA y códigos de salida. La autodescripción ya existe, pero en Markdown y sin esos tres datos. Su generador recorre el árbol real y es la base natural del manifiesto JSON, lo que abarata el trabajo.
- **mayor** · El contrato de salida para máquinas cubre sólo parte del árbol — confirmado
- **mayor** · Multijurisdicción: dos países, y Estados Unidos sin un solo comando fiscal — matizado
  - Corregido por el escéptico: Estados Unidos no tiene hoja fiscal, pero sí siete generadores escritos que sólo piden comando; no verifiqué que sus cifras sean correctas. La ley con vigencia tampoco tiene puerta: `parametros list|import`, prometido en docs/jurisdicciones.md:251, no existe. Dar hoja a lo que hay es M; un tercer país sí es XL.
- **mayor** · Estados financieros NIF incompletos y cierre anual sin comando propio — matizado
  - Corregido por el escéptico: Existen balance, resultados y flujo de efectivo (NIF B-6, B-3 y B-2). Faltan el estado de cambios en el capital (B-4), los comparativos, las notas y la exportación. El cierre anual funciona dentro de `close --hard`, pero su ensayo no muestra las pólizas de cierre (src/cli/close-command.ts:248-253): falta la vista previa, no el motor.
- **mayor** · Familias contables vacías o de sólo escritura — matizado
  - Corregido por el escéptico: Son 162 familias vacías de verdad, no 172. `asset` y `payment` de sólo escritura: confirmado, y es peor de lo dicho, porque tampoco hay motor de lectura ni de baja de activos; no basta con añadir la hoja. Dimensiones (centros de costo) es fase 1 sin motor y merece ir en la primera tanda.
- **mayor** · Idempotencia a medias: 12 hojas graves rechazan la llave y casi ninguna escritura la acepta — confirmado
- **mayor** · El medidor del catálogo sobrecuenta y esconde nombres divergentes — matizado
  - Corregido por el escéptico: El medidor falla en los dos sentidos: infla por banderas y desinfla por nombres. Y el juicio de motor envejece sin aviso: la fila `year close` (docs/cli-command-catalog.md:532) dice que `fiscal_years.status` «nunca se mueve», y src/services/accounting/period-close.ts:335 ya lo mueve. La cifra 220 de 392 no es fiable hacia ningún lado.
- **menor** · Códigos de salida: el 11 y el 4 del contrato casi no se usan
- **menor** · Ayuda bilingüe a medias: con es-MX por omisión la pantalla sale mezclada

El escéptico coincide con la madurez. De acuerdo con «parcial». El núcleo es serio (riesgo declarado, códigos de salida, auditoría propia) y las familias del ciclo mensual mexicano existen. Pero NIIF y Estados Unidos no tienen superficie y la nómina no arranca. El 16 % del medidor no sirve como nota: cuenta de más y de menos. Límite de mi revisión: no ejecuté comandos contra una base de datos; leí código y corrí los medidores.

Lo que el lector no vio y el escéptico sí:

- **mayor** · La fase 1 del catálogo no contiene el objetivo del dueño
- **mayor** · REST va por delante del CLI en nómina y nadie mide la paridad
- **mayor** · La cartera del despacho no existe en el CLI
- **mayor** · El binario no migra su base ni carga la ley
- **menor** · El código de salida 11 «necesita humano» casi no se usa

### Nativo para IA · parcial

Agente embebido con 25 herramientas sobre Anthropic u OpenAI-compatible; dos colas de revisión con hash (`ai_drafts`, `ai_external_ops`), suelo en código, políticas graduadas, modo sombra, memoria de precedentes, skills, jobs, presupuesto y libro de uso. Debajo, un kernel de CLI con riesgo declarado en 278 hojas, salida JSON versionada y códigos de salida. Corpus de 27 manuales con sello y un arnés de eval.

Brechas, de mayor a menor gravedad:

- **bloqueante** · El invariante «la IA propone, la persona dispone» sólo protege al agente embebido — confirmado
- **mayor** · El auto-posteo se apoya en la confianza que el modelo se asigna y no mira el estado SAT — confirmado
- **mayor** · Las herramientas del agente están escritas a mano: 25, frente a 137 hojas declaradas para él — confirmado
- **mayor** · No hay servidor MCP ni esquema del CLI legible por máquina — matizado
  - Corregido por el escéptico: MCP no figura en ningún plan: cierto. El esquema legible por máquina sí está diseñado y sin construir: docs/cli-command-catalog.md:2999 pide `doc export --format json` con banderas, códigos de salida y etiqueta `agent`, y :2986 pide `schema show <noun>`, ambos en fase 1. docs/completion-plan.md:192 pide el puente desde `allDeclarations()`.
- **mayor** · `--continue` no rehidrata el contexto y lo desatendido no deja transcripción — matizado
  - Corregido por el escéptico: Falta la transcripción con llamadas a herramientas, no todo rastro. Quedan `ai_job_runs` (job-store.ts:301), `ai_ingest_runs` (ingest-runs.ts:97), `ai_agent_events`, `ai_usage` y, en cada borrador, `user_request`, `ai_reasoning` y `ai_model` (011_ai_drafts.sql:25-27). Además, `session_search` deja al modelo consultar sesiones pasadas bajo demanda.
- **mayor** · El eval nunca ha medido al clasificador que se embarca y sólo cubre CFDI — confirmado
- **mayor** · La evidencia de sombra se infla y el auto-posteo queda atribuido a una persona — confirmado
- **mayor** · El escáner de inyección de la ingesta es una lista corta y deja pasar Unicode invisible — confirmado
- **mayor** · La cola de aprobaciones no se consume por máquina ni ata el hash fuera del CLI interactivo — matizado
  - Corregido por el escéptico: Dos de las tres colas ya se consumen por guion: `outbox run <ids> --live --yes`, con hash calculado al listar (mnemosine.ts:2773-2839), y `question answer <id>` (:3345). El 11 tiene un tercer productor (diot-command.ts:805). El catálogo ya diseña `draft show|approve|reject` (cli-command-catalog.md:2879-2883). Orden: abrir `draft approve` antes de separar al agente agrava la primera brecha.
- **mayor** · Idempotencia y marcha seca incompletas para un agente que reintenta — matizado
  - Corregido por el escéptico: Esas hojas no aceptan la llave en silencio: pasarla falla con salida 2 antes de escribir, salvo en `--dry-run` (kernel/risk.ts:340). El hueco real es que un reintento vuelve a postear y no hay cómo protegerlo. REST sí honra `Idempotency-Key` en toda ruta irreversible o externa (rest/risk.ts:168). La marcha seca de REST se promete en openapi.ts:674 y no existe.
- **mayor** · El agente no alcanza la nómina y sólo sabe proponer pólizas — matizado
  - Corregido por el escéptico: La cola sí transporta nómina, pero la escribe el motor y no el modelo: `pay-run post` deja el asiento de la corrida como borrador con productor `mnemosine/payroll` y `review` lo postea tipado PAYROLL (gl-posting-service.ts:399; draft-service.ts:809-833). Falta lectura de nómina para el agente y propuestas tipadas. Timbrar no existe aún ni para personas (SCOPE.md:96).
- **mayor** · El corpus NIF es delgado y sin sello propio, y no hay corpus US GAAP — matizado
  - Corregido por el escéptico: B-2, B-6, C-2, C-19 y C-20 sí aparecen, pero sólo como nota comparativa dentro de los manuales NIIF (niif-marco-presentacion.md:41,111-113; niif-instrumentos-financieros.md:92-94), sin su regla de registro. El prompt ya recibe la norma de la entidad (system-prompt.ts:210) y desvía a NIIF las entidades IFRS (:71-73); no tiene rama ni corpus para `us_gaap`.

El escéptico coincide con la madurez. De acuerdo con «parcial». Como copiloto embebido de CFDI mexicano está cuidado: colas con hash, suelo en código, sombra y 278 hojas con riesgo declarado. Como CLI nativo para IA y multijurisdicción falta lo estructural: principal de agente con rol propio, puente derivado, errores y esquema legibles por máquina y un eval medido. El bucle tampoco mira `stop_reason` (agent.ts:267-296; `grep stop_reason src/ai` no lo halla ahí).

Lo que el lector no vio y el escéptico sí:

- **mayor** · Los errores del CLI no salen en formato de máquina
- **mayor** · El prompt de ingesta y el puntuador del eval citan códigos del catálogo sembrado
- **mayor** · La ingesta con IA sólo lee CFDI mexicano
- **mayor** · Nada gobierna a qué proveedor de modelo viajan los datos del cliente
- **menor** · Las citas normativas del agente no se validan

### Superficies fuera del CLI y peso muerto · parcial

Además del CLI hay una API REST `/v1` (35 archivos, 9244 líneas, 152 rutas), un tablero de lectura (`src/gateway`, 3831 líneas), atestación en blockchain simulada (2556 líneas con sus rutas), webhooks entrantes y salientes, integraciones (PAC, Contalink, pagos), respaldo, bóveda y limitador. GraphQL ya se retiró. `docs/` suma 233 archivos y 9,6 MB, con varias generaciones de plan superpuestas.

Brechas, de mayor a menor gravedad:

- **bloqueante** · El binario CLI no registra los calculadores de nómina
- **bloqueante** · Sin comando para crear calendario y periodos de pago
- **mayor** · Finiquito, CFDI de nómina, IDSE y formas US sólo por REST
- **mayor** · GET /v1/xml-documents/:id no acota por entidad
- **mayor** · Los respaldos salen sin cifrar
- **mayor** · Falta el instrumento que mida motores sin puerta de CLI
- **mayor** · Sin manifiesto de comandos para agentes externos
- **mayor** · Sin bóveda de producción fuera de AWS
- **mayor** · La cartera del despacho no existe en el CLI
- **mayor** · No hay decisión escrita sobre blockchain
- **menor** · REST publica marcha seca y compuerta en vivo que no cumple
- **menor** · El README y los planes viejos contradicen el árbol

Esta área no tuvo escéptico: sus brechas son de un solo lector.

### Alcance, plan y proceso · parcial

Alcance firmado (docs/SCOPE.md), MVP (docs/MVP.md), un solo PRD (PRD-001) y un backlog de 399 entradas (135 hechas, 264 abiertas, 210 post-MVP) con vista generada. Plan ejecutable: `npm run plan:status` da 13 de 15 paquetes en verde, 242 criterios. Nueve ADR, AGENTS.md con siete invariantes y CI de nueve trabajos. El alcance documentado es el mes de una PyME mexicana para un despacho: más estrecho que el objetivo.

Brechas, de mayor a menor gravedad:

- **bloqueante** · El alcance firmado es el mes de una PyME mexicana; el objetivo del owner no está escrito en ningún documento — matizado
  - Corregido por el escéptico: El objetivo sí está escrito, como visión, en SCOPE.md:19-21. Falta bajarlo: no hay definición de «completo» ni requisitos por dimensión. El TL;DR, el MVP, PRD-001 y el backlog sólo desarrollan el mes de una PyME mexicana, y la nómina aparece como fuente de datos, no como módulo.
- **bloqueante** · NIIF existe sólo como corpus del agente: no hay requisito, puerta ni tarea de motor — matizado
  - Corregido por el escéptico: NIIF es corpus del agente (10 manuales niif-*.md y 74 fichas en ifrs-registry.json) más andamiaje sin lector: el CHECK del esquema, el eje `books` de `Jurisdiction` y el mapeo `ifrs_code` por cuenta. No hay requisito, entidad `ifrs` creable, informe ni tarea de motor.
- **bloqueante** · El cumplimiento NIF no tiene requisito ni matriz norma-motor; el backlog trae una sola tarea de motor NIF — matizado
  - Corregido por el escéptico: La matriz norma-motor existe como inventario manual del 2026-09-06, no generado ni vigilado en CI, y ya está desfasado. El backlog trae tres tareas de motor ligadas a NIF, no una. Siguen sin requisito, criterio ni tarea C-4, C-8, C-15, C-16, D-5, B-4, B-10 y las notas.
- **bloqueante** · El modelo de ramas del ADR-0008 no existe: sin `release`, `main` 52 commits atrás, sin tags y con Dependabot contra `main` — confirmado
- **mayor** · Multijurisdicción: sólo MX y US, el «paquete de jurisdicción» es diseño sin código y el resto de J0 está en post-MVP — matizado
  - Corregido por el escéptico: Dos países y ningún contrato de paquete, cierto. Pero J0.1 (conmutador) y J0.2 (parámetros legales con vigencia) ya están en código, y la nómina tiene registro de plugins por país. Falta el contrato común, que los motores pregunten al conmutador (14 usos de `keepsMexicanBooks`) y un tercer país de prueba.
- **mayor** · Nómina: el alcance es la «nómina básica» de una quincena mexicana y los documentos se contradicen sobre EE. UU. — confirmado
- **mayor** · El backlog post-MVP no persigue el objetivo, su estado está caduco y la prueba del MVP sigue sin cerrar — confirmado
- **mayor** · CI: sólo dos comprobaciones bloquean y sólo en `main`; develop está en rojo y cada corrida tarda 38 minutos — confirmado
- **mayor** · «Nativo para IA» no está definido como requisito y el eval del agente no corre en CI — matizado
  - Corregido por el escéptico: «Nativo para IA» existe de hecho como agente embebido que propone y no dispone, con criterios en E5.1. Falta el requisito escrito, la superficie para agentes externos, el contrato `--json` completo y un eval que corra: el clasificador nunca se ha medido en CI y el trabajo saltado sale en verde.
- **mayor** · CLI «completo»: el catálogo propio mide 16 % de la superficie y el backlog no lo usa para planear — matizado
  - Corregido por el escéptico: El catálogo tiene plan propio, del 2026-09-01, y suelo en CI. Lo que falta es que PRD-001 y el backlog lo usen: 9 tareas lo citan y ninguna nombra la fase 1. A 390-520 líneas por fila, las 172 filas pendientes de fase 1 son 67 000 a 90 000 líneas: hay que podar antes de comprometer.
- **mayor** · La revisión humana que prometen los documentos no está impuesta: aprueba un bot y los agentes firman como el dueño — confirmado
- **mayor** · Documentos caducos o contradictorios: README, wiki, catalog-info, SCOPE y planes viejos sin archivar — confirmado

El escéptico coincide con la madurez. De acuerdo con «parcial». La maquinaria es sólida (242 criterios ejecutables, bloques generados, trinquetes, nueve trabajos de CI), pero apunta al MVP mexicano y no mide requisitos. Además el flujo se detuvo: tras 131 fusiones en la semana 40, hubo tres entre el 5 de octubre y el 12 de noviembre, develop pasó un mes en rojo y no existe ninguna versión etiquetada.

Lo que el lector no vio y el escéptico sí:

- **bloqueante** · El tablero no mide requisitos: la única métrica del MVP no está conectada y pasa en verde con 26 `it.todo`
- **mayor** · Nadie con criterio contable valida las reglas ni las cifras, y no hay piloto con datos reales
- **mayor** · El calendario del plan está vencido y no hay modelo de capacidad hacia el objetivo
- **mayor** · Un solo humano es dueño, autor, revisor y decisor: el proceso escrito no cabe en el equipo real
- **mayor** · CI no hermética y con plazos de calendario: la rama se pone en rojo sola, y un paso rojo oculta otros cuatro

## Lo que no está donde debe: fugas y candidatos a retirar

Dos clases de cosas en una misma lista. Las **fugas**: código mexicano que vive dentro del motor común y que pertenece al paquete de jurisdicción (casi todo lo del núcleo). Y los **candidatos a retirar, congelar o archivar**: código y documentos que el objetivo no pide. La recomendación es la del lector o, donde lo hubo, la corrección del escéptico. Nada se mueve ni se retira por este informe: las fugas esperan al paquete (RF-10 de PRD-003) y lo demás es la decisión D-04.

| Qué | Área | Recomendación |
|---|---|---|
| src/services/accounting/period-close.ts | Núcleo: el mayor | Las dos fugas son ciertas, pero no hay nada que retirar: es el motor de cierre. Sacar las casillas exige antes el registro de paquetes, y los códigos de casilla son contrato publicado (:38-42). Trabajo mediano, no barato. |
| src/services/accounting/account-service.ts | Núcleo: el mayor | Cierto. Mover el esquema no es barato: lo consumen close-explain.ts y account-command.ts, y ocho archivos leen `codigo_agrupador_sat`. Va junto con la tabla de mapeos estatutarios. Mediano. |
| src/services/accounting/validation.ts | Núcleo: el mayor | Cierto y barato: extraer la regla 7 a un conjunto por norma son unas 45 líneas de avisos. Las citas NIF de las reglas 1, 3, 4 y 6 van dentro de los mensajes y piden un catálogo de textos por norma. |
| src/services/accounting/opening-balance.ts | Núcleo: el mayor | Cierto. Partirlo en apertura neutra más adaptador SAT es mediano: el mismo archivo lee el XML, postea el asiento, coteja y carga los documentos abiertos. |
| src/services/accounting/sat-chart-import.ts | Núcleo: el mayor | Cierto. Moverlo al paquete MX es barato; el trabajo real es la importación neutra de catálogo, que no existe. |
| src/services/accounting/fx-revaluation.ts | Núcleo: el mayor | Cierto, pero no es un traslado: leer la moneda funcional de la entidad obliga a revisar cómo los pagos miden la diferencia realizada contra el tipo histórico (:30-37). Mediano. |
| src/services/accounting/moneda-origen.ts | Núcleo: el mayor | `manual` ya es una fuente neutra que una entidad no mexicana puede usar; lo mexicano es el valor por omisión. Darle defecto por jurisdicción es pequeño y depende de J0.3. |
| src/services/xml-ingestion/cfdi-taxonomy.ts | Núcleo: el mayor | Mover el tipo a un módulo neutro es barato si se reexporta. Renombrar los valores no lo es: `account_roles.role` los guarda en español y pide migración de datos con alias (regla de docs/language.md). |
| src/services/accounting/ar-ap-posting.ts | Núcleo: el mayor | La entidad no mexicana no recibe IVA sobre flujo (`entityUsesCashBasisIva`, iva-cash-basis.ts:318-335); lo que hereda es el nombre mexicano del rol. La interfaz de impuesto indirecto es trabajo mediano a grande. |
| src/services/accounting/iva-cash-basis.ts | Núcleo: el mayor | La fuga es cierta; moverlo no es barato. ar-ap-posting lo llama en cada factura, pago y nota de crédito: primero la interfaz de impuesto indirecto, luego el traslado y la actualización de trece importadores. |
| src/services/accounting/iva-ppd-reclass.ts | Núcleo: el mayor | Cierto y barato de mover en código. El coste está en las anclas literales de los criterios e0-0, e1-1 y e1-2 y en su censo de mutantes, que citan la ruta. |
| src/services/accounting/rep-expected.ts | Núcleo: el mayor | Barato de mover. El cierre lo seguirá importando hasta que las casillas se registren por paquete. |
| src/services/accounting/sat-agrupadores-catalogo.ts | Núcleo: el mayor | Barato de mover: es dato de referencia sin lógica. La vigencia que se pide es trabajo nuevo, no traslado. |
| src/services/accounting/sat-agrupadores.ts | Núcleo: el mayor | Barato de mover, pero account-service seguirá dependiendo de él mientras el esquema `sat-agrupador` viva en el servicio del catálogo. |
| src/services/accounting/sat-agrupador-account-type.ts | Núcleo: el mayor | Barato si viaja junto con el importador del catálogo y la apertura. |
| src/services/accounting/withholding-accounts.ts | Núcleo: el mayor | La fuga es cierta; moverlo no es trivial porque el panel de políticas, el alta y el cierre lo importan. Necesita antes el punto de extensión por paquete. |
| src/services/accounting/close-explain.ts | Núcleo: el mayor | Cierto. Se parte barato cuando las casillas se registren por paquete; hasta entonces sigue al checklist de period-close. |
| src/services/accounting/chart-seed.ts | Núcleo: el mayor | Cierto; es el tramo J0.5, mediano por la prueba de no regresión del catálogo mexicano. El cierre anual depende de los códigos 3900, 3200 y 3300 que este archivo siembra: los dos cambios van juntos. |
| src/services/accounting/entity-accounting.ts | Núcleo: el mayor | La rama del nulo es inalcanzable; quien decide es `keepsMexicanBooks`. Pasarle la jurisdicción ya resuelta es barato cuando exista el registro. |
| src/services/accounting/fiscal-calendar-service.ts | Núcleo: el mayor | Cierto. J0.6 es mediano: el periodo 13 comparte el 31 de diciembre con diciembre, y el posteo, el arrastre y la balanza del SAT dependen de ese orden. |
| src/services/jurisdiction/jurisdiction.ts | Núcleo: el mayor | Sólo `jurisdictionOf().fiscal` cae a México, y tiene un consumidor (ap/cash-deductibility.ts:89). Pasar de unión cerrada a registro es trabajo mediano. |
| src/database/migrations/037_etiquetado_que_encarece.sql | Núcleo: el mayor | Cierto. La tabla de mapeos pide migración nueva con relleno y tocar esos ocho lectores: mediano. Lo único barato de retirar es `mx_nif_code`, que nadie escribe. |
| src/database/migrations/120_the_entity_knows_its_tax_regime.sql | Núcleo: el mayor | Cierto, de bajo impacto. Separarlas en un perfil fiscal por jurisdicción es mediano y no desbloquea nada por sí solo; puede esperar al registro. |
| src/database/migrations/001_core_schema.sql | Núcleo: el mayor | Cierto. Relajar los CHECK es una migración nueva y pequeña, pero sola no cambia nada: la puerta de alta sigue cerrada a dos países. |
| src/services/accounting/posting.ts | Núcleo: el mayor | Es inerte por omisión: una consulta por posteo. Volverlo gancho es barato (una función). Retirar la familia no lo es: 1480 líneas, dos rutas REST, tablas ya migradas y filas del catálogo. |
| src/services/accounting/closing-conductor.ts | Núcleo: el mayor | Cierto y barato para el cierre. La inversión es más ancha: políticas, nómina, bancos y CxP también importan de src/ai (floor, draft-service, shadow-verdicts). |
| src/services/ap/form-1099-nec.ts | Auxiliares y operación | Nadie lo importa en producción. Borrarlo sería barato (264 líneas más su prueba de 245; la migración 250 se queda), pero no conviene: es la única pieza de CxP del paquete de EE. UU. Mejor dejarlo declarado como no productivo hasta que tenga comando. |
| src/services/fx/rate-service.ts (tipoParaConversion) | Auxiliares y operación | Unificar es barato: borrar una función y reapuntar tres llamadas de una sola prueba al resolutor transaccional. El propio archivo advierte que los dos gemelos pueden divergir (rate-service.ts:25-27). |
| src/database/migrations/004_partitioning_and_views.sql:112 (scheduled_payments) | Auxiliares y operación | Enterrarla es barato: una migración nueva con DROP (la 004 no se edita), quitar el renglón reclamado en e0-2.ts:66 y ajustar el comentario. Antes conviene decidir si las 11 filas de payment-run del catálogo (0 vivas) la van a usar. |
| src/services/banking/parsers/perfiles-csv.ts | Auxiliares y operación | El archivo no se puede retirar: también define `generico`, el único perfil verificado. Sacar los tres de la detección automática es barato. Peor de lo descrito: la marca 'conjetura' no llega al usuario al importar, y los mensajes remiten a `bank format create` y `bank format test`, que no existen (csv.ts:209; `bank --help`). |
| src/services/assets/depreciation-math.ts:308-344 (MACRS) | Auxiliares y operación | Quitar `macrs` de `asset create --method` es barato: filtrar la lista en asset-command.ts:171 y ajustar una aserción (tests/cli/asset-command.spec.ts:467). Las tablas y su prueba de cálculo pueden quedarse. Hoy elegir MACRS deprecia siempre como clase de 5 años. |
| src/services/reporting/materialized-view-service.ts | Informes y estados financieros | Sin lector y con texto caduco: cierto. Retirarlas no es barato: migración nueva (vistas y función de la 031), reescribir un criterio que CI exige, bajar el trinquete del catálogo y tocar pruebas y manuales. Lo barato hoy es corregir el comentario (:9-11) y el aviso (report-command.ts:785). |
| src/services/blockchain/ | Informes y estados financieros | Congelar es barato; retirar no: toca el camino de posteo, dos rutas REST, OpenAPI, las tablas de la migración 006, enums y un criterio E1.2 con su escenario (src/plan/criteria/shared.ts:389). `getPeriodMovementByAccountType` sí tiene ese único consumidor (orchestrator.ts:430). No comprobé que esté apagado por omisión en todos los caminos. |
| src/services/accounting/account-service.ts:741-748 | Informes y estados financieros | Decorativas para informes: confirmado. Quitarlas pide migración nueva (son de la 001) y tocar tipos, CLI y cuatro pruebas: barato, pero inútil si se construye el motor de layouts, que es su lector natural (docs/cli-command-catalog.md:2292). Mejor absorberlas que retirarlas. |
| src/services/blockchain/ y src/database/migrations/006_blockchain_integration.sql | Modelo de datos y migraciones | Congelar. Si el dueño lo descarta, retirarlo con una migración nueva que borre tablas, columnas y las políticas del rol verificador; nunca editando la 006. |
| mv_trial_balance y mv_account_balance_summary (migraciones 004, 031, 071; src/services/reporting/materialized-view-service.ts) | Modelo de datos y migraciones | Retirarlas con una migración nueva, junto con `report view` y el rol; o rehacerlas como saldos por libro cuando exista el modelo multi-GAAP. |
| files/ y files.zip | Multijurisdicción | Quitarlos es barato: nada los importa ni los ejecuta. Son 4 rutas; los dos informes que los nombran son históricos y no se reescriben, y el historial conserva la especificación (commit 4eeee63). El zip sobra en cualquier caso. Decide el dueño. No leí la especificación completa, sólo sus menciones de país y norma. |
| src/services/integrations/base/adapter.interface.ts | Multijurisdicción | No es candidato a borrar: es una interfaz viva. Unificar el vocabulario es barato (interfaz, registro y seis adaptadores), pero cambia un valor que la API ya entrega (`USA` pasaría a `US`), así que es cambio de contrato. `LATAM`, `EU` y `getByRegion` sí son código muerto. |
| src/database/migrations/001_core_schema.sql | Multijurisdicción | Retirarla cuesta poco (migración nueva, un tipo, una proyección y cuatro pruebas), pero no conviene todavía: es la casilla reservada para el código de presentación NIF que pide el hueco de la norma. Nota: `us_gaap_code` guarda hoy la línea fiscal `us-tax-line`, la misma mezcla norma/fisco que la 063 corrigió para México. |
| src/services/payroll/usa/nacha-generator.ts | Nómina | Es dispersión bancaria y no tiene prueba de formato, cierto. Pero retirarlo no es barato: dos criterios del plan con sus mutantes, dos pruebas, la ruta, el OpenAPI y el documento del agente. Y `payment-run` todavía no existe para recibirlo. |
| src/services/payroll/integrations/imss-idse-adapter.ts | Nómina | Retirarlo sí es barato: la ruta, dos pruebas, el OpenAPI y el documento. Pero no es sólo gestión de personal: alta, baja y modificación de salario ante el IMSS son la otra mitad del SBC. Decisión del dueño; yo lo rehacía con alcance. |
| src/services/payroll/usa/benefits/benefits-service.ts | Nómina | Retirar las dos funciones huérfanas es barato: borrarlas, sus pruebas y la línea de `e0-2.ts:462`. El archivo entero no: cuatro rutas, una prueba de integración y un criterio con mutante (`e2-1.ts:749,795-796`) dependen de él. |
| src/api/rest/routes/payroll.ts:533-568 | Nómina | Retirarlas es barato: dos manejadores, regenerar el OpenAPI y una línea del documento del agente. Contradice una decisión escrita en el plan, así que conviene que el dueño la confirme. |
| src/services/payroll/usa/local/local-tax-calculator.ts | Nómina | Retirarlo es barato: el archivo, tres líneas del registro y el bloque `paycheck-service.ts:465-477`. Hoy es peor que aparentar: una ciudad que empiece por «NYC» revienta a media corrida, y «New York» queda sin impuesto local en silencio. |
| src/services/payroll/tax-engine/register-all.ts:44-55 | Nómina | Es un archivo, pero tal como se propone es peligroso. Primero hay que exigir la calculadora del estado (`getRequired`) o rechazarlo en la revisión previa; hoy un empleado sin `work_state` ya queda sin impuesto estatal y sin aviso. |
| src/api/rest/routes/payroll.ts:499-530 | Nómina | Borrarlas después es barato: cuatro manejadores, su prueba, el OpenAPI y dos líneas del documento del agente. Mantener el 501 un ciclo coincide con el motivo escrito en el código (`routes/payroll.ts:485-497`). |
| README_ACCOUNTANT.md | Cumplimiento NIF | Archivar es barato: un `git mv` a docs/archive, sin importadores que arreglar. Los informes fechados que lo citan no se reescriben. |
| src/database/migrations/001_core_schema.sql | Cumplimiento NIF | Retirarla no es gratis: migración nueva (la 001 no se edita, AGENTS.md) más unos seis archivos. Conviene usarla: el catálogo ya diseña `statement layout install` sobre esas columnas (docs/cli-command-catalog.md:2292). Sus hermanas us_gaap_code e ifrs_code tienen escritor y ningún informe que las lea. |
| docs/wiki/Motores-contables.md | Cumplimiento NIF | No se borra: rompería seis enlaces de la wiki publicada. Marcarla como foto del 2026-09-06 es barato; regenerarla desde `catalogo:estado` es trabajo mediano. La línea 18 también envejeció: el balance ya clasifica por fs_category. |
| docs/wiki/Normas-contables.md | Cumplimiento NIF | Son tres correcciones, no dos, y es barato. La enlazan _Sidebar.md:31 y Home.md:48; ninguna prueba la lee (tests/docs/wiki-manual-commands.spec.ts sólo cubre Manual-*.md y Puesta-en-marcha.md). |
| README_ACCOUNTANT.md | Cumplimiento NIIF | Archivarlo es barato: un `git mv` a docs/archive, sin importadores que romper. Las menciones en auditorías fechadas se quedan como están (tabla de idioma de AGENTS.md). Conviene el visto bueno del dueño por ser documento de portada. |
| docs/backlog/PRD-001.json (MNE-001-355 a MNE-001-360) | Cumplimiento NIIF | Posponer 355-359 es barato: editar el JSON y regenerar la vista. La 360 no debe posponerse entera: hay que separar de ella la bifurcación del prompt por norma y la corrección de system.md. Quitar US GAAP contradice SCOPE.md:19 y la nómina estadounidense que ya existe; decide el dueño. |
| src/cli/web-command.ts · src/gateway/ | La superficie del CLI | Congelar es barato y el código está bien aislado. Una condición: la cartera del despacho (`listPortfolio`) hoy sólo se ve en ese tablero. Antes de congelarlo conviene darle hoja en el CLI, o el despacho se queda sin su única vista de todos sus clientes fuera del navegador. |
| docs/cli-command-catalog.md (familias quote, order, contract, purchase-order, requisition, goods-receipt, warehouse, price-list, factoring, meter, forecast, covenant) | La superficie del CLI | Moverlas es barato: editar el documento y regenerar el bloque con `scripts/catalogo-estado.ts`. Rinde menos de lo que sugiere: 23 filas del objetivo comprometible, no 57. Gana más recortar el catálogo por dimensión del objetivo que por familia suelta. |
| src/services/blockchain/ · filas anchor y attest de docs/cli-command-catalog.md | La superficie del CLI | Congelar y sacar las 14 filas del objetivo es barato. Borrar el código no lo es: toca `posting.ts`, que docs/SCOPE.md marca como zona de revisión humana. El costo por comando es menor del descrito: sin configuración activa es una consulta en segundo plano, no cinco segundos. No verifiqué si alguna instalación lo tiene activo. |
| src/api/rest/routes/ai-webhooks.ts | Nativo para IA | Desmontar no es barato: toca index.ts, montajes.ts, regenerar openapi.json, tres pruebas que montan o censan la ruta y la hoja `webhooks create`, que imprime ese endpoint (webhooks-command.ts:75). La ruta ya avisa en su 200 que nada se guardó (ai-webhooks.ts:76-80). Lo más corto es cablear el lector en index.ts y añadir la migración que guarde el cuerpo. |
| src/ai/external-service.ts | Nativo para IA | El archivo no se retira: es el núcleo de la bandeja de salida y lo importan mnemosine.ts:197 y tools/external-tools.ts:8. Lo barato es quitar `external_op` de la lista del CLI (una línea, su ayuda y regenerar cli-reference); el CHECK de la migración 020:31 se queda. Borrar la función exige además borrar su renglón en e0-2.ts:461 y sus casos de prueba. |
| files.zip | Nativo para IA | Borrar el zip y mover files/ a docs/archive, que ya existe, es barato y no rompe nada ejecutable. Único efecto: el ejemplo `ingest ./files.zip` de un informe fechado deja de reproducirse, y esos informes no se reescriben. Conviene dejar en la carpeta una nota de «histórico, abril de 2026». |
| src/services/blockchain/ + src/api/rest/routes/blockchain.ts + src/api/rest/routes/public-verification.ts | Superficies fuera del CLI y peso muerto | Retirar, con ADR previo. Costo L: 32 llamadas a `attestEntryAsync` fuera de `posting.ts`, 127 archivos de prueba con `drainAttestations`, 8 tablas y 6 columnas (migración nueva), 3 criterios del plan, 35 operaciones de OpenAPI, 15 filas del catálogo y la dependencia `merkletreejs`. |
| src/gateway/ | Superficies fuera del CLI y peso muerto | Congelar: ni pantallas ni rutas nuevas hasta que el MVP esté en verde. Está aislado y bien probado; no estorba si no crece. Retirarlo costaría M: `web-command.ts`, `build:web`, `tsconfig.web.json`, 5 criterios y sus pruebas. |
| src/api/rest/ | Superficies fuera del CLI y peso muerto | Congelar: ninguna ruta nueva y toda capacidad nace con puerta de CLI. Podar las 4 rutas 501 de nómina, las 2 de autoservicio de empleado (`routes/payroll.ts:533,553`) y los montajes dobles (`montajes.ts:58,60`). No retirar: costo XL (`src/plan/conducta.ts` usa `bootstrap()`, 101 referencias en criterios, el tablero). |
| src/api/graphql (ya retirado) y sus restos | Superficies fuera del CLI y peso muerto | Limpiar los comentarios en el primer PR que toque esos archivos. Costo nulo. Es el precedente a seguir para blockchain. |
| src/services/portfolio/ | Superficies fuera del CLI y peso muerto | Conservar y darle hoja de CLI (brecha de cartera). Es la única lectura transversal del despacho; retirarlo costaría S y dejaría al tablero sin pantalla inicial. |
| src/services/webhooks/ + src/api/rest/routes/webhooks.ts | Superficies fuera del CLI y peso muerto | Congelar y recortar `WEBHOOK_EVENTS` a lo que de verdad se emite. Retirarlo costaría M: 3 `dispatchEvent`, la familia `subscription`, 2 criterios de E2.1 y las tablas `webhook_*`. |
| src/ai/webhooks/ + src/api/rest/routes/ai-webhooks.ts + src/cli/webhooks-command.ts | Superficies fuera del CLI y peso muerto | Congelar, o retirar la ruta hasta que guarde el cuerpo antes del 200. Corregir ya la ayuda del comando. Retirar costaría S: una ruta sin JWT menos y una familia de CLI. |
| src/services/integrations/payments/ | Superficies fuera del CLI y peso muerto | Retirar. Costo S: dos `register` en `src/services/integrations/index.ts:17-18`, la interfaz `IPaymentAdapter`, una prueba de redacción de bitácora y una migración que borre las llaves ya guardadas, como hizo la 102. |
| src/services/integrations/ (PAC y Contalink) | Superficies fuera del CLI y peso muerto | Conservar Contalink. Congelar PAC hasta que haya contrato firmado y entonces dejar sólo adaptadores reales. Retirar los tres simulados costaría S: registro, preferencias y `tests/integrations/pac-simulacion.spec.ts`. |
| src/services/cache/redis.ts | Superficies fuera del CLI y peso muerto | Conservar como limitador, moverlo junto a la API y borrar los encabezados vacíos. Costo nulo. |
| src/services/backup/ | Superficies fuera del CLI y peso muerto | Conservar. Sirve al objetivo; le falta el cifrado (ver brecha). |
| src/services/vault/ | Superficies fuera del CLI y peso muerto | Conservar. Ver la brecha de bóveda sin AWS. |
| package.json y src/config/index.ts | Superficies fuera del CLI y peso muerto | Retirar. Costo S: regenerar `package-lock.json` y limpiar `.env.example` y `docs/wiki/Puesta-en-marcha.md`. |
| files.zip | Superficies fuera del CLI y peso muerto | Retirar. Costo nulo. |
| files/ | Superficies fuera del CLI y peso muerto | Archivar en `docs/archive/` con su fecha, o retirar: git la conserva. Costo nulo. |
| README_ACCOUNTANT.md | Superficies fuera del CLI y peso muerto | Retirar de la raíz, o archivar, y enlazar `docs/wiki/Manual-de-usuario.md`. Costo nulo: sólo lo citan auditorías fechadas. |
| docs/plan-cierre-brechas.md | Superficies fuera del CLI y peso muerto | Archivar en `docs/archive/`. Costo S: rehacer la línea base de idioma, dos citas en `src/language/vocabulary-registry.json` y los enlaces. |
| docs/completion-plan.md | Superficies fuera del CLI y peso muerto | Archivar. Costo S: su entrada en la línea base de idioma y el enlace de `docs/wiki/La-contabilidad-como-centro.md`. |
| docs/sprint-01.md | Superficies fuera del CLI y peso muerto | Archivar en `docs/archive/`. Costo nulo. |
| docs/propuesta-mnemosine-init.md | Superficies fuera del CLI y peso muerto | Retirar o archivar. Costo nulo. |
| docs/archive/ | Superficies fuera del CLI y peso muerto | Conservar: es el destino de lo demás. Si el peso molesta, sacar los HTML del repo y dejar el README con su enlace. |
| docs/auditorias/ | Superficies fuera del CLI y peso muerto | Congelar como historia: no se editan. No retirar, porque los criterios los citan. |
| docs/investigacion/ | Superficies fuera del CLI y peso muerto | Congelar como historia y cambiar el enlace de SCOPE por un instrumento que mida. Retirarla costaría M por las citas desde código. |
| docs/wiki/ | Superficies fuera del CLI y peso muerto | Conservar: sirve al objetivo. Actualizar `Hoja-de-ruta.md` y añadir el capítulo de nómina. |
| skills/ | Superficies fuera del CLI y peso muerto | Conservar y empaquetarlas con el binario. Costo S. |
| docker/ | Superficies fuera del CLI y peso muerto | Conservar el Dockerfile; rehacer o retirar el compose (`.devcontainer/compose.yml` ya cubre desarrollo). Costo S: dos mensajes del CLI dicen `docker compose up -d postgres` (`src/ai/doctor-service.ts:182`, `src/cli/init/s0-infra.ts:229`) y `tests/config/production-secrets.spec.ts:58` cita su línea 15. |
| docs/completion-plan.md | Alcance, plan y proceso | Archivar es barato pero no gratis: hay que corregir cuatro citas, una en la wiki publicada, o subir a mano docs/language-baseline.json. `--tighten` no sirve, porque sólo baja. Qué exclusiones siguen vigentes lo decide el owner antes de archivar. |
| docs/sprint-01.md y docs/propuesta-mnemosine-init.md | Alcance, plan y proceso | Sin corrección: archivarlos es gratis si se mueven junto con completion-plan.md, para conservar el enlace relativo. No hace falta `language:status --tighten`. |
| README_ACCOUNTANT.md | Alcance, plan y proceso | Sin corrección: retirarlo no rompe ninguna puerta de CI. Las auditorías fechadas que lo citan quedan como registro y no se reescriben. |
| files/ y files.zip | Alcance, plan y proceso | Sin corrección: se pueden quitar sin tocar código ni CI. |
| docs/backlog/PRD-001.json (MNE-001-157 a 169 y 180 a 216) | Alcance, plan y proceso | Congelarlas no rompe dependencias, pero el backlog no tiene estado «congelada»: hay que añadirlo a scripts/backlog.ts o moverlas a una ola nueva. Antes, marcar `done` las dos ya fusionadas. Los trinquetes de idioma de CI siguen vigentes aunque las tareas se congelen. |
| docs/platform/ y el carril P del backlog (16 tareas; PRD-002 previsto en #379) | Alcance, plan y proceso | Mover las 10 tareas de la ola 4 a un PRD-002 es gratis en datos. Sacar la plataforma del proceso no lo es: obliga a reescribir RNF-04, AGENTS.md y la razón del ADR-0008. Es una decisión del owner, no una limpieza. |
| MNE-001-314 a 318 (canales de mensajería) y src/gateway (tablero web) | Alcance, plan y proceso | Congelar cuesta cero y es lo correcto. Retirar el tablero sería un cambio mediano: toca el middleware de autenticación, criterios con mutantes y la compilación. MNE-001-314 no es un canal nuevo: corrige un webhook que ya existe, y conviene sacarlo del congelamiento. |
| src/services/blockchain y /public/v1 (MNE-001-268, 269, 380 y 381) | Alcance, plan y proceso | Congelar es gratis. Retirar toca posting.ts, ruta sensible y única puerta del mayor, el contrato docs/openapi.json, criterios con mutantes y tablas ya migradas: tamaño M, con revisión del owner. MNE-001-380 ya es una tarea de retiro parcial. |

## Los pull requests abiertos

| PR | Qué es | Primer revisor | Contra-revisor | Disposición |
|---|---|---|---|---|
| #531 | Anexo 24: el nodo de pago sin beneficiario o RFC se omite y se nombra su póliza | Actualizar y fusionar | De acuerdo | Se actualiza con `develop` y con cuatro correcciones pequeñas: el remedio según la causa, el tercero nombrado, un aviso falso y una sola expresión de RFC |
| #534 | Anexo 24: el nodo de pago sin clave de banco | Actualizar y fusionar, después de #531 | De acuerdo, con condiciones | Después de #531, con textos que no receten lo imposible |
| #561 | Migración 318: diez columnas de clave sin escritor ni lector | Cerrar | De acuerdo | Cerrado; las columnas llegan con su escritor (checkpoint en #158) |
| #562 | `statutoryLanguage` en el paquete de jurisdicción | Rehacer | Actualizar y fusionar | Se conserva la tabla y se retira el resolutor por entidad, que no tiene lector; espera el plan aprobado en #159 |
| #573 a #582 | Siete PRs de Dependabot contra `main` | Cerrar y aplicar a mano contra `develop` | — | Sustituidos por #585 |

El detalle de cada revisión, con sus defectos y su evidencia, está en `hallazgos.json`, bajo `prs`.

## Las issues abiertas

De 96: 30 se mantienen, 23 hay que reescribirlas porque su cuerpo describe trabajo ya entregado, 23 se pliegan en otra, 15 están entregadas y siguen abiertas, y 5 no sirven al objetivo. Ninguna etiqueta nombra una dimensión del objetivo, y no existe épica de cumplimiento NIF ni NIIF. La lista, issue por issue, está en `hallazgos.json`, bajo `issues`.

## La salud del árbol

- Tipos y lint en verde: 1 096 avisos, con el trinquete en 1 106.
- 9 190 pruebas unitarias en verde.
- Plan: 13 de 15 paquetes. En rojo, E4.2 (siete copias del SQL de saldos fuera de la capa de informes) y E5.1 (las herramientas del agente no se derivan del registro de riesgo; `--continue` no rehidrata).
- `npm audit --omit=dev`: 8 vulnerabilidades, una crítica. Las corrige #585.
- El historial quedó corto dos veces en seis semanas y puso en rojo a todos los PRs; lo corrigieron #571 y #583.
