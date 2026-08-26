# Plan para terminar mnemosine

> Cómo llevar el sistema de 52 comandos a un producto que un despacho mexicano pueda usar
> con clientes reales. Derivado de siete análisis del código, dos revisiones adversariales
> y mediciones sobre la base de datos real.

## El hecho que reordena todo

Antes de decidir qué construir, hay que mirar lo que el sistema imprime hoy. Este es el balance
general de Demo Corp MX, generado con el comando que ya funciona:

| Renglón | Importe |
|---|---|
| Total Assets | **−261.12** |
| Total Liabilities and Equity | **16,008.00** |
| Total Equity | **0.00** |

El balance está descuadrado por **16 269.12 pesos**. No existe renglón de resultado del ejercicio
(`report-service.ts:469-496` no lo calcula), y el reporte imprime los dos totales **sin compararlos
nunca**. Un estado financiero que no cuadra y no lo nota no es un estado financiero.

No está solo:

- El **cierre anual devuelve `[]` en silencio** con cualquier catálogo que no sea el sembrado por
  el sistema: `period-close.ts:302-311` resuelve las cuentas 3900 y 3200 exigiendo
  `is_system_account = true`, y la estrategia `auto` de onboarding deja intacto el catálogo
  importado del cliente a propósito. Es decir: falla exactamente en el caso para el que se diseñó.
- El **IVA se reconoce sobre lo devengado** (`ar-ap-posting.ts:87-92`) cuando en México se acredita
  sobre lo cobrado. El motor correcto ya está escrito y probado en `cfdi-taxonomy.ts` — y **no lo
  llama nadie**. El propio código lo admite en `bill-service.ts:478-482`: *"la declaración mensual
  construida con estos asientos no va a cuadrar"*.
- **`payroll_account_mapping` y `sat_code_mappings` tienen lectores que lanzan excepción y ningún
  INSERT en todo el repositorio.** La familia de Nómina (167 comandos del catálogo) está montada
  sobre una tabla que nada puebla.
- La **creación de entidades es un método privado del asistente `init`** (`s1-identity.ts:115`). No
  hay comando ni endpoint. Y elige el tenant con `ORDER BY created_at ASC LIMIT 1` — en una
  instalación con dos despachos, toda entidad nueva cae silenciosamente en el tenant del primero.

**Consecuencia para el plan: agregarle 300 comandos a esto produce 300 respuestas equivocadas más
rápido.** El orden no es discutible: primero que los números sean ciertos, después la superficie.

---

## Qué significa "terminado"

El catálogo tiene 1 622 comandos porque eso es la unión de las superficies de SAP, NetSuite y
CONTPAQi. **Ese número no es la meta; es un mapa.** Este producto sirve a una forma concreta de
cliente: un despacho mexicano que lleva la contabilidad de PyMEs, con alguna subsidiaria
estadounidense colgando de un grupo mexicano.

Contra ese cliente, la definición defendible de "terminado" no se mide en comandos sino en
**seis flujos que corren completos sobre datos reales**:

| Compuerta | Qué debe poder hacerse | Cómo se prueba |
|---|---|---|
| **G1 · Alta** | Cargar el histórico de un cliente real | Su balanza cuadra al peso contra el sistema anterior |
| **G2 · Mes** | CFDI dentro, banco conciliado, papel de trabajo de IVA/ISR, periodo cerrado | El balance **cuadra** a la fecha de cierre |
| **G3 · Declaración** | DIOT y papeles de trabajo | La plataforma del SAT acepta el archivo; el papel amarra con el mayor |
| **G4 · Ejercicio** | Cierre anual sobre el catálogo **del cliente** | El resultado se barre y las utilidades acumuladas quedan correctas |
| **G5 · Defensa** | Paquete de requerimiento de un mes | Pólizas con su UUID de soporte, auxiliares, evidencia |
| **G6 · Aislamiento** | Dos clientes, dos usuarios del despacho | Lectura y escritura cruzadas **provadamente** denegadas, corriendo como `mnemosine_app` con RLS forzado |

Cada comando que no esté en el camino de una compuerta es candidato a no construirse nunca.

### La decisión de alcance que domina el calendario

**La emisión de CFDI queda fuera del alcance de la versión 1.** El cliente sigue timbrando en el
portal de su PAC o en CONTPAQi; mnemosine ingiere el XML y es el **libro de registro**, no un
sistema de facturación.

Esto no es una concesión, es *la* palanca: convierte una puerta de 6 a 9 meses (sello → cadena
original → PAC → REP → cancelación con ventana de aceptación) en una de 2 a 3 meses. Debe ser el
posicionamiento declarado del producto, no una nota al pie del backlog.

La contrapartida honesta: sin descarga masiva del SAT, el despacho no puede **afirmar
completitud** — y eso es justamente lo que vende. Por eso G2 exige un cotejo de censo: *el SAT dice
214 CFDI este mes, tú tienes 209*. Es barato (una diferencia de conjuntos sobre `xml_documents`,
que ya tiene índice único por UUID) y sostiene la promesa mientras la descarga masiva espera.

### Los cuatro niveles

| Nivel | Qué compra | Comandos | Motores |
|---|---|---|---|
| **0 · Reparación** | Que lo que ya existe diga la verdad | ~10 | 0 |
| **1 · Lleva libros** | Un cliente mexicano, un mes, un ejercicio | ~360 | ~30 |
| **2 · Sirve a un despacho** | Emisión CFDI, descarga masiva, Anexo 24, nómina MX, activos, pagos | ~360 | ~45 |
| **3 · Condicional** | Solo contra un cliente que lo pague | ~250 | ~35 |
| **Nunca** | — | ~620 | ~48 |

Los niveles 0 y 1 son el producto. Los otros dos son opciones.

---

## La ruta crítica

Ésta es la cadena que **agregar agentes no acorta**, porque cada eslabón cambia la forma de lo que
depende del siguiente:

```
CI verde + migración de identidad de entidad
  → alta de entidad como servicio, con un principal autenticado
    → una sola frontera de tenant/entidad, verificada como NO superusuario
      → un solo almacén de saldos + un solo modo de posteo
        → calendario fiscal + tipo de cambio + esquema de N impuestos por renglón
          → IVA sobre flujo, usando la taxonomía CFDI que ya existe
            → custodia de CSD → cadena original → sello → PAC → REP → cancelación → Anexo 24
```

Todo lo demás corre **alrededor** de esta cadena. Nada corre **a través** de ella.

De aquí salen dos reglas que gobiernan el calendario:

**1. La mitad de esquema de cada motor XL se construye temprano, aunque el motor llegue tarde.**
El modelo de N impuestos por renglón (hoy `invoice_lines` solo admite uno, y en `DECIMAL(5,2)`, que
no puede guardar el 10.6667% de retención de IVA — cada CFDI timbrado diferirá en centavos del
documento local), el etiquetado de `journal_entry_lines` (dimensiones, UUID del CFDI, RFC de la
contraparte, forma de pago), la dimensión de almacén y la cardinalidad de `reconciliation_matches`
son migraciones sobre tablas que van a cargar datos de clientes. **Diferirlas es cómo un proyecto de
3 meses se vuelve de 9.**

**2. El IVA sobre flujo se parte en dos y la primera mitad va temprano.** Enrutar el posteo de
AR/AP por la taxonomía CFDI ya escrita —para que un PPD pegue en `1135` / `2125`, cuentas que ya
están sembradas y a las que **nunca se ha posteado**— no es "el motor de impuestos" y no es XL: es
cablear código que ya existe y ya está probado. Y tiene que aterrizar **antes del primer mes de un
cliente**, porque hacerlo después significa reexpresar sus libros.

---

## Las fases

### Fase 0 — Una línea base verdadera
**Meta:** que nada en el repositorio pueda producir un registro fiscal falso ni una señal de
cumplimiento falsa, y que el CI corra sobre SQL real y RLS real.

Lo primero es **trabajo negativo**, que por eso nadie agenda: borrar o hacer fallar ruidosamente
todo lo que reporta éxito de un acto externo que no realiza.

- `POST /v1/invoices/:id/cfdi/stamp` y `/cfdi/cancel` escriben `cfdi_status='stamped'` con un UUID
  inventado. Un despacho que timbre una vez tendrá una factura que su mayor llama timbrada y de la
  que el SAT nunca supo.
- `irs-efile-adapter.ts` y `ssa-bso-adapter.ts` se llaman `submitFormToIrs`, no transmiten nada y
  devuelven estado `pending`. Quien los llame cree que presentó.
- `src/services/mexico/cfdi.ts` (cero llamadores, `Serie="A"` hardcodeado, layout de DIOT derogado),
  `bills/:id/schedule-payment`, y el `complete` de conciliación bancaria que no postea nada y aun
  así satisface la compuerta de cierre.

Cada uno se reemplaza por un `NOT_IMPLEMENTED` ruidoso. Nunca por un TODO.

Además: la migración de identidad de entidad (una sola, sirviendo a los tres consumidores —régimen
fiscal y código postal de MX, domicilio del patrón en EUA, registro patronal del IMSS—); extender el
escáner SQL de nombres de tabla a columnas de SELECT/WHERE/SET; y un job de CI que corra la
aplicación como `mnemosine_app` en vez de superusuario.

> **Pregunta de cierre:** en un clon limpio, ¿pasan `npm ci && npm run migrate && npm test &&
> npm run test:integration` con la aplicación conectada como rol no privilegiado, y un `grep` no
> encuentra ninguna función que reporte éxito de un acto externo que no ejecuta?

*Nota: la otra sesión ya escribió el test de contrato de esquema y la migración 032. Esta fase está
parcialmente en marcha; hay que coordinar antes de duplicar.*

### Fase 1 — Un tenant, una identidad, un camino al mayor
**Meta:** que el sustrato sobre el que se apoyarán los 1 622 comandos tenga **exactamente una**
implementación, y que una prueba falle cuando alguien agregue la segunda.

- Middleware de contexto de tenant para REST (hoy solo lo entran el CLI y dos rutas de IA).
- `requireEntityAccess` debe verificar la entidad que usa *el handler*, no el default del header
  (hoy `req.entityId` siempre es verdadero, así que 46 endpoints llevan una guarda que no hace nada
  y 105 no llevan ninguna).
- **Borrar GraphQL** — 891 líneas, cinco mutaciones al mayor sin verificación de permisos, montadas
  fuera del prefijo auditado, 14 mutaciones anunciadas sin resolver, y **ningún consumidor en este
  repositorio**. Borrarlo elimina un P0 al costo de un commit.
- Extraer `createEntity` del asistente, arreglar la selección del tenant y dejar de pasar el id de
  la entidad como `created_by`.
- **Declarar `journal_entry_lines` el libro de registro** y `account_balances` una caché derivada,
  con una aserción de amarre. Hoy son dos fuentes de verdad: el cierre anual calcula qué barrer
  desde el almacén del que ningún reporte lee.
- Reemplazar los once `autoPost: true` por un modo de posteo explícito, y hacer cumplir el
  solo-borradores **en código**, de dos maneras: una prueba de alcanzabilidad sobre el grafo de
  importaciones desde cada comando `agent: true`, y una guarda en tiempo de ejecución dentro de
  `createJournalEntry` que rechace postear dentro de una sesión de agente.
- Construir el puente del agente desde `allDeclarations()` (`kernel/risk.ts:142`, hoy **sin ningún
  consumidor**) para que sus herramientas se deriven del registro de riesgo en vez de ser 24
  escritas a mano.

> **Pregunta de cierre:** ¿puede una prueba corriendo como `mnemosine_app` demostrar que el mayor de
> la entidad B es inalcanzable desde un principal que solo tiene la A — y falla una prueba cuando
> algún comando `agent: true` puede alcanzar transitivamente una escritura al mayor?

### Fase 2 — Números que están bien
**Meta:** que cada número que el sistema imprime sea el número que dicen los libros, para una
entidad mexicana y una estadounidense.

El resultado del ejercicio en el balance. Dejar de filtrar reportes por `a.is_active`. El cierre
anual: fallar ruidosamente en vez de `return []`, resolver por **rol** y no por código, derivar el
signo del saldo y no de `abs()`. Calendario fiscal: años arbitrarios, avance automático, periodo 13,
formas no calendario. Folios con serie y ejercicio. Conversión a moneda funcional al momento del
posteo. Cargador de saldos iniciales.

**Y aquí aterriza la mitad de esquema del motor de impuestos, sin motor encima.**

> **Pregunta de cierre:** con una entidad MX y una US sembradas con un año de movimiento, ¿cuadra el
> balance, amarra la balanza contra el almacén de saldos, y un cierre anual sobre un catálogo
> importado o cierra bien o **se niega a cerrar**?

### Fase 3 — La maquinaria
**Meta:** que las ocho cosas que más de cien motores reinventarían existan una sola vez.

`process_runs` (procesos de periodo parametrizados, re-ejecutables y reversibles: depreciación,
revaluación cambiaria, prorrateo, reconocimiento de ingresos, devengo de nómina, cierre de costos y
consolidación los necesitan todos — y debe ser **la única vía sancionada** por la que un proceso de
periodo escribe al mayor). El contrato de identificadores estables de renglón, decidido en
`kernel/output.ts` **antes** de que exista el primer renderizador y no retrofiteado 38 veces. El
almacén de documentos (hoy el adaptador de S3 no sube nada). El marco de importación. La
recurrencia. La bandeja de salida como **único** camino de un acto externo irreversible.

Y la procedencia de los parámetros fiscales: documento fuente, fecha de publicación en el DOF o el
IRS, y `effective_from` intra-anual. La UMA cambia el 1 de febrero, no el 1 de enero; el subsidio al
empleo ya no es una tabla de rangos sino un monto fijo, y `MexicoSubsidioEmpleoCalculator` seguirá
devolviendo un número equivocado de apariencia respetable hasta que cambie la forma.

> **Pregunta de cierre:** ¿se puede construir un proceso de periodo nuevo sin agregar una sola tabla,
> renderizador, ruta de subida, planificador ni camino de llamada externa — y tiene un acto externo
> irreversible exactamente una ruta de código hacia afuera?

### Fase 4 — Un cliente real
**Meta:** que un despacho mexicano pueda poner un cliente que paga sobre este sistema.

Dos carriles en paralelo, deliberadamente asimétricos:

**Carril MX (profundo — es el diferenciador y la obligación legal).** Identidad fiscal en
`legal_entities`, `customers` y `vendors`. Enrutar el posteo de AR/AP por las ~3 000 líneas de
taxonomía CFDI ya escritas, ya probadas y completamente huérfanas. Conciliación bancaria de verdad
—que es *el* trabajo del mes en un despacho— con modelo de cotejo N:M y prueba de efectivo. Censo de
CFDI contra libros. Escrutinio 69-B como unión temporal, nunca como sobreescritura. Papeles de
trabajo de ISR e IVA. DIOT.

**Carril USA (deliberadamente somero — preparar, nunca transmitir).** Los desajustes de esquema que
el escáner extendido ya encuentra mecánicamente. 941/940/W-2 como *preparar y entregar*.
Depreciación de doble libro. 1099/W-9.

> **Pregunta de cierre:** ¿un contador real cerró un mes real de un cliente real de punta a punta en
> mnemosine, y presentó a partir de sus salidas, sin abrir otra herramienta para nada de lo que el
> sistema dice hacer?

### Fase 5 — Profundidad y amplitud
El carril de profundidad (emisión CFDI: custodia del CSD en la bóveda, cadena original, sello, PAC
real, REP, cancelación, Anexo 24) se queda **serializado en un solo carril**: es una cadena
criptográfica donde "casi bien" significa "rechazado".

Los carriles de amplitud (4 a 8 agentes construyendo familias de comandos sobre motores que ya
existen) corren en paralelo.

> **Pregunta de cierre:** ¿sube el número de comandos con backend ✅ más rápido que el número de
> defectos abiertos — y puede un agente de familia terminar su fragmento sin tocar un archivo que
> otro agente posee?

---

## Cómo ejecutarlo con agentes en paralelo

Esto ya se probó: la primera ola corrió 4 familias en paralelo con un verificador adversarial detrás
de cada una, y **los verificadores encontraron dos defectos bloqueantes que los implementadores no
vieron**. Las lecciones son operativas, no teóricas.

### Fragmentar por propiedad de superficie de escritura, no por funcionalidad

Un agente posee exactamente un directorio `src/services/<motor>/`, un `src/cli/<sustantivo>-command.ts`,
un directorio de pruebas y un rango de renglones del catálogo. Puede **leer** lo que sea; solo puede
**escribir** lo suyo. Una necesidad que cruce fragmentos es una solicitud de interfaz por escrito,
nunca una edición.

**Archivos de dueño único, siempre serializados, jamás asignados a un agente de familia:**
`src/database/migrations/*`, `src/cli/kernel/*`, `src/cli/mnemosine.ts`, `posting.ts`,
`ar-ap-posting.ts`, `rls-policies.sql`, `config/index.ts`, `package.json`, `ci.yml`.

### Correr un carril de esquema

Un solo dueño escribe **todas** las migraciones de una fase; los agentes de funcionalidad envían una
*especificación* de migración y reciben un número. Los archivos de migración numerados son la
superficie de colisión más probable entre agentes en paralelo, y el repositorio ya carga la cicatriz:
`migrate.ts:21` tolera cuatro números duplicados históricos con una lista de excepciones.

Es además la única forma de que los cuatro retrofits transversales sigan siendo cuatro y no cuarenta
migraciones de "agrego una columna nullable por ahora".

### La concurrencia la fija la contención, no la ambición

| Fase | Agentes | Por qué |
|---|---|---|
| 0–1 | 1–2, serializados | Casi todo es trabajo sobre archivos compartidos |
| 2 | 3, módulos disjuntos | |
| 3 y 5 | 4–8 cómodamente | Los directorios son genuinamente disjuntos |

### El orden dentro de cada fragmento es fijo

migración (del carril de esquema) → servicio con pruebas que **ejecutan SQL real** → comando con su
declaración `declareRisk` → re-verificar el renglón del catálogo contra el archivo, **no contra la
cita que el propio catálogo trae** (los veredictos ya derivaron: hay renglones que se justifican con
"directorio vacío" para directorios que hoy tienen 30 KB de servicio).

Nunca al revés. El CLI primero es cómo se construye una herramienta sobre un motor roto.

### Dónde un verificador se paga y dónde no

**Se paga:** cualquier cambio al camino de posteo o que escriba al mayor; cualquier refactor que
promete preservar comportamiento (de ahí salió el bug de `?status=`); cualquier cosa que toque
tenancy, RLS o permisos; migraciones sobre tablas con datos; actos irreversibles o externos; y
cualquier número que se presente ante una autoridad —donde el trabajo del verificador es **recalcular
un caso desde la fuente primaria**, no leer el código.

**No se paga:** CRUD sobre una tabla nueva, lecturas `list`/`show`/`export` sobre un modelo
existente, conformidad de nombres y banderas (para eso está la prueba R12), y documentación.

**Dos reglas que hacen que la verificación se acumule en vez de repetirse.** Primera: un verificador
tiene que correr contra una base de datos real — con 54 de 105 archivos de prueba mockeando la
conexión, un verificador que lee una suite verde es ciego a toda una clase de defectos. Segunda:
**todo hallazgo que pueda volverse una compuerta de CI tiene que volverse una antes de cerrar el
fragmento.** El escáner de contrato de esquema, la prueba de alcanzabilidad solo-borradores, la
aserción de orden del tenant, la correspondencia catálogo↔código y el amarre de saldos retiran cada
uno una categoría entera de trabajo de verificación, para siempre. Así es como la verificación
adversarial sigue siendo pagable con ocho carriles y no solo con dos.

### Darle a cada verificador un mandato falsable

"Revisa con cuidado" encuentra estilo. **"Produce una entrada donde el viejo y el nuevo difieran"**
es el mandato que habría cazado el bug de truthiness de `?status=`. La diferencia entre los dos
hallazgos bloqueantes que la primera ola sí encontró y los que se le escaparon es exactamente ésa.

---

## Lo que parece urgente y debe esperar

**Los 462 renglones 🟡 de "solo hay que extraer el servicio".** Se leen como la victoria más barata
disponible y son la trampa más grande. Seis de los doce archivos de rutas ya están extraídos; los
que quedan son justamente los peores. Y más de fondo: **para la mayoría de los 🟡 el trabajo no es
"extraer el servicio" sino "hacer que el servicio esté bien"**. Un `report-service.ts` extraído
limpiamente sigue sin cuadrar.

**El checklist de cierre** (20 comandos, el desbloqueo más grande listo del inventario). Es ceremonia
envuelta alrededor de un cierre que no hace nada en silencio, apoyada en una conciliación bancaria
que no postea. Después de la Fase 2.

**Inventarios y activos fijos** (155 renglones). Motores completos sin puerta — el "solo agrégale una
ruta" más tentador del repositorio. Pero falta la tabla de movimientos, la dimensión de almacén es un
retrofit sobre tablas que van a cargar datos, y `costing.ts:19-40` lee las capas fuera de la
transacción que las consume, sin `FOR UPDATE`: dos ventas concurrentes consumen la misma capa. Darle
puerta antes que candado es cómo se embarca inventario negativo.

**Consolidación, ASC 740, ASC 606 como motor, ASC 842, FBAR, determinación de tasas de impuestos
locales.** Los renglones más corporativos del catálogo y los que menos usarán los primeros diez
clientes. Se cortan del plan, no se posponen.

---

## Lo que no se va a construir nunca

Esto debe vivir como artefacto del producto —`docs/out-of-scope.md`— y no como nota de un plan, con
un código de salida `E_OUT_OF_SCOPE` que al teclear un sustantivo fuera de alcance imprima qué usar
en su lugar. Una frontera no declarada se re-litiga en cada sesión y en cada llamada de venta.

| Fuera de alcance | Qué hace el usuario en su lugar |
|---|---|
| **Ejecución de nómina de EUA** | Gusto/ADP/Rippling; mnemosine importa la póliza y concilia el depósito |
| Transmisión IRS MeF / IRIS / SSA BSO | El humano sube en el portal; mnemosine produce el archivo validado y la lista de verificación |
| Determinación de tasas de impuesto local | Avalara/TaxJar; mnemosine solo detecta nexo |
| Arrendamientos ASC 842 | Cédula calculada afuera, cargada con `entry recurring` |
| ASC 606 como motor | Cédula de ingresos diferidos con liberación lineal o por hito |
| ASC 740 completo | Papel de trabajo del CPA; mnemosine aporta balanza y diferencias libro-fiscal |
| Órdenes de compra y cotejo a tres bandas, pedidos de venta, gastos de empleados | Las herramientas del cliente; las facturas llegan como CFDI |
| Consolidación con participación no controladora, método de participación, CTA | Exportación de hoja combinatoria |
| XBRL y notas de revelación | El software del auditor |
| Agregación de feeds bancarios | Importación de estados de cuenta |
| Pronóstico a 13 semanas, marco COSO, muestreo de auditoría, almacenes y BOM | Fuera |

Sobre la nómina de EUA vale la pena ser explícito, porque es el desacuerdo más grande entre los
analistas: correr nómina estadounidense conforme significa poseer las tasas de 51 jurisdicciones
para siempre, las reducciones de crédito FUTA que se publican cada noviembre, y la responsabilidad
cuando salga mal. Eso es el negocio de una compañía de nómina. La evidencia de que aquí nunca fue
una capacidad real está en el código: seis consultas contra una tabla que no existe, seis columnas de
embargo que nunca se escribieron, `calculateGarnishments` llamado incondicionalmente —así que
`calculatePaycheck` lanza excepción para **todo** empleado estadounidense— y dos adaptadores que
"envían" sin enviar nada. México es distinto y se queda dentro: ahí el CFDI de nómina **es** un
documento contable y lo hace el despacho.

---

## Dónde el agente sustituye una funcionalidad, y dónde es una excusa

**Sustituye de verdad** —vale unos 60 comandos del catálogo y varios motores grandes— donde la
entrada es difusa, la salida es revisable antes de tener efecto, y equivocarse cuesta un rechazo:

- **Cotejo bancario**: construir el modelo de cotejo N:M y `bank match approve|explain`, y dejar que
  el agente proponga — en vez de construir un motor de reglas versionado con modo sombra.
- **Comentario de variaciones**: construir el cálculo, que el agente escriba el memo.
- **Autoría de reportes**: el agente escribe la definición, un humano la revisa.
- **Mapeo del catálogo del cliente** a código agrupador y a roles: el agente propone, el humano aprueba.

La disciplina que lo hace seguro ya existe y es lo mejor construido del repositorio:
`draft-service.ts:360-430` hace bloqueo de renglón, detección de deriva por hash de contenido y
revalidación bajo el candado.

**Es una excusa** donde la respuesta debe ser demostrablemente completa o aritméticamente exacta:
IVA sobre flujo, depreciación, nómina, completitud de conciliación, calendarios de vencimientos, y
todo acto externo irreversible.

Y hay que decirlo con precisión: **la columna IA del catálogo es hoy una intención de diseño, no una
propiedad de seguridad.** `declareRisk` valida la declaración, nunca el comportamiento. 555 de los
1 011 comandos sin construir están marcados como invocables por la IA, y lo único que lo hace seguro
hoy es el accidente de que ninguna herramienta del agente puede postear. Ese accidente **caduca en el
momento en que se empiece a construir.**

---

## Calibración: lo que costó lo que ya está hecho

Medido sobre la primera ola, no estimado:

| Medida | Valor |
|---|---|
| Comandos entregados y verificados | 52 |
| Servicios extraídos | 8 |
| Código de producción nuevo | 10 381 líneas (kernel 1 086, comandos 4 678, servicios 4 617) |
| Pruebas | 10 325 líneas, 44 archivos — ratio prueba:código **1.1 : 1** |
| Líneas por comando | ~90 |
| Líneas por servicio extraído | ~577 |
| **Tokens de subagente por comando** | **~52 000** |
| Hallazgos de los verificadores | 31, de los cuales 2 bloqueantes reales |

Ese costo por comando vale **solo** para comandos cuyo motor ya existe. Los 1 008 ❌ exigen construir
el motor primero, y ahí el multiplicador es de otra magnitud.

Contra eso, la aritmética del alcance: dimensionar el catálogo completo da del orden de 780
semanas-sesión. Dimensionar **Nivel 0 + Nivel 1** —un libro que cierra— da entre 90 y 110. Las 670
semanas de diferencia compran funcionalidad que este cliente no va a usar.

---

## Riesgos, y la señal temprana de cada uno

| Riesgo | Señal temprana de que está pasando |
|---|---|
| **Amplitud antes que profundidad** | Un sprint cuya salida son muchos comandos `list`/`show` y **cero migraciones**. El 45% de los comandos sin construir son de lectura, lo que se lee como "esto es fácil": casi todos leen una tabla que no existe |
| **Cimientos para siempre** | Las Fases 0–3 llevan presupuesto duro; al agotarse **se corta alcance, no se extiende el plazo**. Tipo de cambio, dimensiones y el cargador de saldos iniciales son separables de la Fase 2; tenancy, el almacén de saldos y el modo de posteo no lo son |
| **El catálogo se vuelve el objetivo** | Alguien reporta avance como "X de 1 622". La métrica correcta es cuántas de las seis compuertas pasan |
| **Colisión entre agentes** | Dos agentes tocan `mnemosine.ts` o una migración en el mismo lote. Se previene con el carril de esquema y el registro append-only |
| **Deriva catálogo↔código** | Un renglón se justifica citando un archivo que ya cambió. Se previene con una prueba de correspondencia |
| **Falsa confianza en la suite** | "1 751 pruebas verdes" mientras 54 de 105 archivos mockean la base. Verde restringe aritmética, no restringe el esquema, la frontera de tenant ni el camino de posteo |

---

## Lo primero que yo haría mañana

En orden, y ninguno depende de decisiones de producto:

1. **Arreglar el balance.** Agregar el resultado del ejercicio y, sobre todo, hacer que el reporte
   **compare sus dos totales y falle si difieren**. Hoy imprime −261.12 contra 16 008.00 sin
   inmutarse. Es medio día y elimina la peor señal falsa del sistema.
2. **Borrar el código que miente** — los seis puntos de la Fase 0. Es una sesión, es trabajo
   negativo, y es lo único del plan que retira un peligro activo en vez de agregar capacidad.
3. **Sembrar `payroll_account_mapping` y `sat_code_mappings`**, y agregarle a `doctor` una
   verificación por cada tabla de catálogo que tenga lector y no tenga escritor.
4. **Enrutar AR/AP por la taxonomía CFDI** para que el IVA sea sobre flujo. Es cablear código que ya
   existe y está probado, y tiene que estar **antes** del primer mes de un cliente.
5. **Coordinar con la otra sesión**, que ya escribió el test de contrato de esquema y la migración
   032 y está trabajando la misma Fase 0.
