# Plan para terminar mnemosine

> Cómo llevar el sistema de 52 comandos a un producto que un despacho mexicano pueda usar
> con clientes reales. Derivado de siete análisis del código, dos revisiones adversariales
> y mediciones sobre la base de datos real.

## Cómo leer este documento

**Esta es la carta de alcance**, no el backlog. Responde qué significa «terminado», qué se
construye, qué no se construye nunca, y en qué orden. El backlog de ejecución —paquetes, tareas
dimensionadas, criterios de cierre— vive en [plan-cierre-brechas.md](plan-cierre-brechas.md) y está
subordinado a este documento: cuando los dos discrepen sobre si algo debe construirse, manda éste;
cuando discrepen sobre cómo, manda aquél.

> **Regla dura de esta carta: enuncia decisiones y compuertas, nunca conteos.**
>
> La versión anterior abría con un balance descuadrado por 16 269.12 pesos. Ese hecho fue cierto
> durante meses y dejó de serlo **74 segundos antes** de que el documento se commiteara: el commit
> que lo arregló entró primero. Todas sus demás cifras —número de pruebas, líneas de código, el
> reparto del catálogo— caducaron igual de rápido.
>
> El razonamiento sobrevivió; los números nunca lo hacen. Así que aquí no hay ninguno. Donde hace
> falta una cifra, se cita el artefacto que la genera.

## Lo que la evidencia enseñó, y sigue siendo cierto

El balance ya cuadra y falla ruidosamente si no; el resultado del ejercicio vive en el capital. Pero
lo que hizo falta para llegar ahí es lo que gobierna el resto del trabajo:

**La lógica de negocio vive dentro de los handlers de Express.** Implementar una capacidad nunca es
conectar un CLI: es extraer el servicio, refactorizar la ruta preservando su contrato HTTP, y recién
entonces construir el comando. Ésa es la razón de que un tercio del catálogo esté marcado como
«parcial» en vez de «existe».

**Un ✅ falso es el peor defecto posible en un plan**, porque hace que un comando imposible parezca
trabajo de una hora. Por eso cada fila del catálogo se verificó abriendo el archivo que dice
implementarla, y por eso los estados de los paquetes deben generarse desde el código y no
escribirse a mano. Ambos documentos se desincronizaron exactamente por esto.

**El código que triunfa en falso es más peligroso que el que falla.** Quien llama a una función
llamada «enviar al IRS» y recibe estado `pending` cree que presentó. Quien cancela un CFDI y recibe
200 cree que lo canceló. Retirar ese código es la única clase de trabajo que quita un peligro activo
en vez de agregar capacidad, y por eso nadie la agenda.

**Un criterio de cierre que nombra identificadores en vez de comportamiento no sirve.** El cerrojo
antisimulación del timbrado se construyó bien, se documentó mejor que su especificación, y falla el
100% de sus criterios escritos porque su autor eligió nombres en español. Un criterio debe ser una
aserción ejecutable sobre lo observable.

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
CI verde + migración de identidad de entidad        ▓▓▓▓░  migración ✓ · CI NUNCA HA CORRIDO
  → alta de entidad como servicio + principal autenticado   ▓▓▓▓░  servicio ✓ · principal ✗
    → una frontera de tenant/entidad, como NO superusuario  ▓▓░░░  middleware ✓ · 105 endpoints sin guarda
      → un solo almacén de saldos + un solo modo de posteo  ░░░░░  sin empezar
        → calendario + tipo de cambio + N impuestos/renglón ░░░░░  sin empezar
          → IVA sobre flujo por la taxonomía CFDI           ▓▓▓▓▓  ✓
            → CSD → cadena original → sello → PAC → …       ░░░░░  fuera de v1
```

El eslabón que sigue es el tercero, y su primera mitad ya está: el contexto de inquilino se monta
una sola vez para todo `/v1`, así que ningún router puede olvidarlo. Lo que falta es la mitad que
decide si el perímetro existe de verdad — que `requireEntityAccess` verifique la entidad que usa el
*handler* y no la del encabezado, y que la aplicación corra como un rol que la RLS pueda filtrar.

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

Sobre la nómina de EUA vale la pena ser explícito, porque la política se sostiene pero **la
evidencia que la sustentaba ya no**. La versión anterior daba cuatro hechos del código; tres fueron
reparados por el otro flujo de trabajo y **el cuarto nunca fue cierto**:

| Lo que se afirmó | Estado real |
|---|---|
| Seis consultas contra una tabla `entities` que no existe | **Reparado.** No queda ninguna referencia |
| Seis columnas de embargo que nunca se escribieron | **Reparado.** El motor de embargos se reescribió sobre las columnas reales |
| `calculateGarnishments` se llama incondicionalmente, así que toda nómina de EUA lanza excepción | **Nunca fue cierto.** La llamada está dentro de `if (emp.country_code === 'US')` desde el commit inicial |
| Dos adaptadores que «envían» sin enviar nada | **Retirado**, junto con sus tres rutas |

La política no cambia, pero ahora descansa donde debe: **no en que el código esté roto, sino en que
el negocio es de otro**. Correr nómina estadounidense conforme significa poseer las tasas de 51
jurisdicciones para siempre, las reducciones de crédito FUTA que se publican cada noviembre, y la
responsabilidad cuando salga mal. Eso es una compañía de nómina, no un despacho contable mexicano.

La frontera que el código ya dibujó es mejor que la que declaraba cualquiera de los dos planes: los
**transmisores** están retirados y los **generadores** siguen vivos. Ésa es exactamente la línea
correcta —preparar y entregar, nunca transmitir— y hay que escribirla así en lugar de «nómina de
EUA fuera», que contradecía al propio plan cuando su carril de EUA decía «941/940/W-2 como preparar
y entregar».

México es distinto y se queda dentro: ahí el CFDI de nómina **es** un documento contable y lo hace
el despacho.

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

## Calibración

Aquí no van conteos: caducan. Van las dos proporciones que se sostuvieron a través de dos olas de
trabajo y que sirven para dimensionar la tercera.

| Proporción | Valor | Para qué sirve |
|---|---|---|
| Prueba : código | ≈ 1.1 : 1 | Un paquete que estima solo el código estima la mitad del trabajo |
| Coste por comando entregado **y verificado** | ≈ 50 k tokens de subagente | Solo vale para comandos cuyo motor ya existe; los que exigen construir el motor son de otra magnitud |

El estado real —comandos, pruebas, líneas, reparto del catálogo— se genera, no se escribe. Mientras
`npm run plan:status` no exista, la fuente es `npx vitest run`, `npm run test:integration` y
`mnemosine doctor`, y cualquier cifra en un documento es una fotografía vencida.

La aritmética de alcance que sí importa no es de comandos sino de decisión: dimensionar el catálogo
completo da del orden de 780 semanas-sesión; dimensionar **un libro que cierra** da entre 90 y 110.
La diferencia compra funcionalidad que este cliente no va a usar.

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

## Dónde estamos, y qué sigue

La lista «lo primero que haría mañana» de la versión anterior está hecha, salvo media pieza:

| | |
|---|---|
| Arreglar el balance | ✅ cuadra y sale con código 4 si no |
| Borrar el código que miente | ✅ seis endpoints retirados, tres archivos borrados — **más `/cfdi/cancel`, que se escapó en la primera pasada y se retiró después** |
| Sembrar las tablas de catálogo huérfanas | 🟡 `payroll_account_mapping` sembrado con chequeo en `doctor`; **`sat_code_mappings` sigue sin un solo escritor** |
| Enrutar AR/AP por la taxonomía CFDI | ✅ el IVA se reconoce al cobrar |
| Coordinar con la otra sesión | ✅ dos flujos, cero colisiones, y una división de labores escrita |

**La propuesta del siguiente sprint vive en [sprint-01.md](sprint-01.md)** y se ordena por daño
retirado ÷ costo, no por importancia declarada.

## La lección que este documento aprendió de sí mismo

Los dos planes se desincronizaron por la misma razón: ambos **reflejan a mano el estado del
repositorio en prosa**. Uno se fechó y quedó vencido en un día; el otro no se fechó y quedó vencido
en 74 segundos.

La cura no es revisarlos más seguido. Es que el estado se **genere**:

- Los criterios de cierre del backlog ya están escritos como comprobaciones ejecutables —greps,
  conteos SQL, comandos con su código de salida. Nadie los ha corrido nunca como conjunto.
- `npm run plan:status` debe evaluarlos y decir ✅/🟡/⬜ nombrando la comprobación que falla.
- Un criterio puede nombrar un archivo solo cuando el plan está prescribiendo **dónde va el
  código**. En cualquier otro caso debe ser una aserción sobre comportamiento observable, o pasa lo
  que pasó con el cerrojo antisimulación: trabajo correcto que falla el 100% de sus criterios
  porque su autor eligió otros nombres.

Hasta que eso exista, cualquier ✅ en cualquiera de los dos documentos es una afirmación, no un
hecho — y esta carta prefiere decir eso a fingir precisión.
