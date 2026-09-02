# Manual: dar de alta el primer cliente

Esta página va de la nada al primer asiento contabilizado. Al terminarla vas a tener una empresa dada de alta con su RFC, su ejercicio fiscal abierto, su catálogo de cuentas revisado, sus saldos iniciales en el mayor y una póliza contabilizada de verdad.

Antes de empezar conviene haber leído las convenciones de [[Manual-de-usuario]]: sobre todo la diferencia entre inquilino y entidad, y la regla de que a las confirmaciones se contesta `y` y nunca `s`.

**Recuerda cómo se teclea.** Donde el manual dice `mnemosine algo`, tú escribes:

```bash
npm run mnemosine -- algo
```

Los bloques de código de esta página ya vienen en la forma correcta.

**Cuánto se tarda.** Los pasos 1 a 4 son media hora. El paso 5 —el agrupador del SAT— es el trabajo pesado del alta y depende de cuántas cuentas tenga el catálogo del cliente; con un CSV preparado son minutos, sin él son horas. Los pasos 6 en adelante son otra media hora.

---

## Paso 0 · Comprobar que el sistema responde

**Qué quieres lograr.** Saber que la base de datos está arriba y el agente configurado, antes de invertir tiempo en capturar datos.

```bash
npm run mnemosine -- doctor
```

**Qué vas a ver.** Una lista de comprobaciones con su estado. Cuando algo falla, trae el remedio pegado:

```
Mnemosine health check

  ✘ Database        no connection: role "postgres" does not exist
      → Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d postgres)
  ✘ Model provider  anthropic requires ANTHROPIC_API_KEY and it is not set
      → Set ANTHROPIC_API_KEY in .env, or use --provider ollama
  ⚠ Encryption key  ENCRYPTION_KEY not set (the code default is used)
      → openssl rand -hex 32  → ENCRYPTION_KEY in .env

  There are failures that prevent operation. Resolve them in the order shown.
```

**Qué hacer si sale distinto.** Resuélvelo en el orden que dice, empezando por la base de datos: sin conexión no funciona absolutamente nada. La instalación completa está en [[Puesta-en-marcha]]; los fallos frecuentes, en [[Solucion-de-problemas]].

No sigas al paso 1 hasta que la línea `Database` esté en verde. Todo lo que viene escribe en la base.

---

## Paso 1 · Crear la entidad

**Qué quieres lograr.** Dar de alta la razón social con su RFC. Este comando además siembra el catálogo de cuentas base, mapea los roles semánticos de cuentas y prepara el mapeo de nómina.

```bash
npm run mnemosine -- entity create "Aceros del Centro SA de CV" \
  --tax-id ACO850101AB1 \
  --country MX \
  --currency MXN \
  --chart auto
```

**Sobre `--chart`.** Acepta tres valores, y están en español aunque el resto de la ayuda esté en inglés: `auto` (siembra el catálogo base si la entidad no tiene ninguno), `siempre` y `nunca`. Usa `auto` salvo que vayas a importar el catálogo completo del sistema anterior; en ese caso, `nunca`.

**Sobre el RFC.** Se acepta el de persona moral (12 caracteres) y el de persona física (13), con `Ñ` y `&`, que son los dos caracteres legales que rompen las validaciones mal hechas. Si el RFC te lo rechaza, revisa que no traiga espacios ni guiones.

**Qué vas a ver.** Una confirmación con el nombre y el RFC de la entidad creada, las cuentas base sembradas, y una línea sugiriendo el siguiente paso:

```
  pin it with: mnemosine entity use ACO850101AB1
```

**Qué hacer si sale distinto.** Si el error habla de un RFC duplicado, la entidad ya existe: sáltate al paso 2 y fíjala. Si menciona `role` o `connection`, es la base de datos, no tu comando; vuelve al paso 0.

**Lo que este comando NO hace, y es lo que más tropieza a la gente:** no crea el ejercicio fiscal. Si intentas contabilizar algo ahora mismo, vas a recibir un error de periodo que no te va a decir esto. Sigue al paso 3.

---

## Paso 2 · Fijar la entidad activa

**Qué quieres lograr.** Que todos los comandos siguientes trabajen sobre esta empresa sin tener que nombrarla cada vez.

```bash
npm run mnemosine -- entity use ACO850101AB1
```

Acepta el RFC, el identificador interno o un fragmento del nombre. Comprueba que quedó:

```bash
npm run mnemosine -- entity show
```

**Qué vas a ver.** Los datos de la entidad y, lo más útil, **de dónde salió la selección**: si la fijaste tú, si viene de una bandera de línea de comandos o de una variable de entorno, o si es la única entidad activa. Vale la pena acostumbrarse a correrlo al empezar el día.

**Qué hacer si sale distinto.** Si te dice que no pudo resolver la entidad activa y menciona `role ... does not exist`, **no es un problema de selección**: es la conexión a la base. Corre `doctor`. El consejo que te da ese mensaje —usar `entity use` o `entity unset`— no arregla nada en ese caso y `entity unset` te borra la selección.

Para trabajar sobre otra empresa sin cambiar la fijada, todos los comandos aceptan `-e`:

```bash
npm run mnemosine -- report trial-balance show -e OTRO910202XY3 --period 2026-08
```

---

## Paso 3 · Abrir el ejercicio y los periodos

**Qué quieres lograr.** Que exista el calendario contable. Sin un periodo abierto que cubra la fecha de la póliza, no se puede contabilizar nada; y el mensaje de error que vas a recibir en algunos caminos no menciona este paso.

```bash
npm run mnemosine -- year create 2026
```

Crea el ejercicio y sus doce periodos mensuales de un golpe. Si quieres ver el calendario antes de escribirlo:

```bash
npm run mnemosine -- year create 2026 --dry-run
```

Revisa cómo quedaron:

```bash
npm run mnemosine -- period list
```

**Qué vas a ver.** Los doce periodos con su nombre, sus fechas y su estado.

Una advertencia de vocabulario: **los nombres de periodo se graban en inglés** —«January 2026», «February 2026»— porque se acuñan al crearlos y no se traducen al mostrarlos. Vas a verlos así en los reportes y en el alcance de cada consulta. No es configurable hoy.

Si necesitas capturar en un mes que todavía no está abierto:

```bash
npm run mnemosine -- period open 2026-09 --reason "captura anticipada de septiembre"
```

`period open` sólo abre periodos **futuros**. No reabre uno cerrado, y **no existe un comando para reabrir un periodo cerrado**: el motor lo tiene, pero no está expuesto. Piénsalo bien antes de cerrar un mes, porque una corrección que pertenecía a marzo se va a tener que registrar en el mes abierto.

**Qué hacer si sale distinto.** Si `year create` te dice que el ejercicio ya existe, corre `period list` y sigue. Si un comando posterior te contesta «No open fiscal period covers 2026-08-31», es este paso el que faltó.

---

## Paso 4 · Revisar el catálogo y los roles de cuenta

**Qué quieres lograr.** Que el catálogo tenga las cuentas que este cliente necesita, y —esto es lo que casi nadie sabe que existe— que los **roles semánticos** apunten a las cuentas correctas. Los roles son lo que lee el posteo automático: cuando aprueban una factura de proveedor, el sistema no adivina en qué cuenta va el IVA acreditable, lo busca por su rol.

Primero mira lo que sembró el alta:

```bash
npm run mnemosine -- account list --type expense
```

```bash
npm run mnemosine -- account role list
```

**Qué vas a ver.** En el segundo, cada rol (`banco`, `cxc`, `cxp`, `iva_acreditable`, `iva_trasladado`, `activo_fijo`, `anticipo_clientes`, `anticipo_proveedores`…) y la cuenta a la que apunta. Los que aparezcan sin cuenta son los que hay que resolver.

Para crear de un golpe las cuentas base que falten y mapear cada rol sin asignar:

```bash
npm run mnemosine -- account role seed
```

Ese comando **nunca pisa una decisión manual**: si ya mapeaste un rol a mano, lo respeta. Es seguro correrlo más de una vez.

Para apuntar un rol a la cuenta que este despacho usa:

```bash
npm run mnemosine -- account role set banco 1120 --note "chequera BBVA del cliente"
```

Y si necesitas una variante por contexto —por ejemplo, IVA acreditable al 16 % en una cuenta distinta del IVA al 8 %:

```bash
npm run mnemosine -- account role set iva_acreditable 1190 --qualifier tasa16
```

Para añadir cuentas propias del cliente:

```bash
npm run mnemosine -- account create 5110 "Papelería y artículos de oficina" \
  --type expense --normal-balance debit --parent 5100
```

Los tipos válidos son `asset`, `liability`, `equity`, `revenue`, `expense`, `contra_asset`, `contra_liability` y `contra_equity`. Si el tipo ya implica el saldo normal, puedes omitir `--normal-balance`. Con `--header` creas una cuenta de agrupación que no acepta movimientos.

**Qué hacer si sale distinto.** Si `account create` se queja de la cuenta padre, créala primero o quita `--parent`. Si `account role set` te dice que el rol no existe, corre `account role list` para ver la lista exacta: los nombres de rol están en español (`banco`, `cxc`, `cxp`) y no admiten sinónimos.

**Antes de seguir**, verifica que existan las cuentas **3900** (resultado del ejercicio, cuenta puente del cierre) y **3200** (resultado de ejercicios anteriores) marcadas como cuentas de sistema. Si el catálogo se sembró con `--chart auto` ya están. Si lo importaste de otro sistema, puede que no, y en diciembre el cierre duro va a reportar éxito **sin generar los asientos de cierre**, en silencio. Es la falla más cara de esta página y se previene ahora, no en diciembre.

---

## Paso 5 · El agrupador del SAT (Anexo 24)

**Qué quieres lograr.** Asociar cada cuenta del catálogo con su código agrupador del SAT. Es el trabajo más pesado del alta de un cliente mexicano, y hay que hacerlo aunque hoy mnemosine todavía no genere el XML de contabilidad electrónica: el mapeo es el que después alimenta esa generación y el que te permite exportar el catálogo a un generador externo.

El formato del archivo es un CSV de dos columnas —código de cuenta y valor del agrupador—, una cuenta por línea, con coma o punto y coma como separador:

```
1100,101.01
1120,102.01
5100,601.01
```

Primero en seco, que no escribe nada:

```bash
npm run mnemosine -- account map import ./agrupador.csv --scheme sat-agrupador --dry-run
```

Si la vista previa cuadra, de verdad:

```bash
npm run mnemosine -- account map import ./agrupador.csv --scheme sat-agrupador
```

Revisa el resultado y mide la cobertura:

```bash
npm run mnemosine -- account map list --scheme sat-agrupador
```

```bash
npm run mnemosine -- account map check --scheme sat-agrupador --level 3 --strict
```

**Qué vas a ver.** `account map check` es una compuerta de cobertura: lista las cuentas de los primeros niveles que todavía no tienen agrupador. Con `--strict`, si encuentra algo, el comando termina con código de salida 4 —o sea, «encontré hallazgos», no «fallé»—, que es lo que permite meterlo en una automatización.

También puedes mapear una cuenta suelta:

```bash
npm run mnemosine -- account map set 5110 --scheme sat-agrupador --value 601.01
```

**Qué hacer si sale distinto.** Si la importación se queja de que el archivo no trae pares legibles, revisa que no tenga encabezado y que el separador sea coma o punto y coma. Si una cuenta del CSV no existe en el catálogo, resuélvela primero con `account create`: el mapeo no crea cuentas.

---

## Paso 6 · Los saldos iniciales

**Qué quieres lograr.** Meter en el mayor los saldos con los que el cliente llega, a la fecha de corte.

Hay tres caminos y sólo dos funcionan hoy. Léelos antes de elegir.

### Camino A · Importar del sistema anterior (sólo Contalink)

```bash
npm run mnemosine -- onboard -p contalink \
  --cutoff 2025-12-31 \
  --from 2025-01-01 \
  --balance-account 3200 \
  --dry-run
```

Si el plan se ve bien, quita `--dry-run`. `--balance-account` es la cuenta donde se cuadra la diferencia si la balanza remota no suma cero; 3200 es la elección habitual.

**El saldo inicial llega como borrador**, no contabilizado: hay que aprobarlo con `mnemosine review` (ver [[Manual-El-dia-a-dia]]). Si quieres que se contabilice de inmediato, añade `--post`.

**Límite importante:** el único adaptador que existe es `contalink`. **No hay adaptador de CONTPAQi ni de Aspel**, que son de donde viene la mayoría de los clientes de un despacho mexicano. Si el cliente viene de ahí, usa el camino B. Y si escribes un proveedor que no existe, el error que vas a recibir puede ser un error de base de datos, no un «ese proveedor no existe»: la validación del nombre ocurre después de conectar.

### Camino B · Capturar los saldos como una póliza (el camino que siempre funciona)

Es una póliza normal, con tantos renglones como cuentas con saldo tenga el cliente. El formato de cada renglón es:

```
<cuenta>:<debit|credit>:<importe>[:descripción]
```

Ojo con dos cosas: el separador es **dos puntos**, y el lado se escribe en inglés, `debit` o `credit`. **`cargo` y `abono` no se aceptan**, aunque sean las palabras del oficio.

```bash
npm run mnemosine -- entry create \
  --date 2025-12-31 \
  --type standard \
  --description "Saldos iniciales al 31/12/2025" \
  --line "1100:debit:250000.00:Caja y bancos" \
  --line "1200:debit:480000.00:Clientes" \
  --line "2100:credit:310000.00:Proveedores" \
  --line "3200:credit:420000.00:Resultado de ejercicios anteriores"
```

Si son muchos renglones, `entry create` también acepta `--file <ruta>` con un documento JSON que lleva fecha, tipo, descripción y renglones.

Un detalle práctico: el importe se escribe con punto decimal y **sin separador de miles**. `12000.00`, no `12,000.00`.

### Camino C · Migrar el histórico completo (hoy no llega al mayor)

```bash
npm run mnemosine -- entry import polizas-2025.csv --layout csv
```

Este comando existe, funciona y **deja el lote escenificado sin tocar el mayor**. El propio comando te lo dice al terminar. La familia que valida y aplica ese lote todavía no existe, así que un `batch_id` hoy no se puede consumir con ningún comando. Los layouts de CONTPAQi, Aspel, IIF y pólizas del SAT están anunciados en la ayuda pero todavía sin lector: los formatos que sí lee son `csv` y `ndjson`.

**Recomendación:** para el alta de un cliente, usa el camino B. El histórico completo déjalo en el sistema anterior hasta que la familia de lotes exista.

---

## Paso 7 · Contabilizar el primer asiento

**Qué quieres lograr.** Cerrar el ciclo: validar la póliza, ver su efecto y meterla al mayor. Éste es el momento en que la empresa deja de ser una ficha y pasa a tener libros.

La póliza del paso 6 quedó en **borrador**. Crear y contabilizar son dos actos separados a propósito.

Primero, busca su folio:

```bash
npm run mnemosine -- entry list --status draft
```

Valida las siete reglas NIF sin escribir nada:

```bash
npm run mnemosine -- entry check --entry P-2026-0001 --strict
```

Mira el efecto exacto sobre los saldos, todavía sin tocar nada:

```bash
npm run mnemosine -- entry preview P-2026-0001
```

Y contabiliza:

```bash
npm run mnemosine -- entry post P-2026-0001
```

**Qué vas a ver.** Una pregunta con el folio y el importe:

```
Post P-2026-0001 (1,210,000.00) to the ledger? This cannot be undone. [y/N]
```

Contesta **`y`**. Recuerda: `s` y `sí` no se entienden aquí, y el comando aborta con un escueto `Aborted.` sin decirte que el problema fue el idioma.

Si prefieres verlo primero sin comprometerte, `entry post` acepta `--dry-run`, que calcula el efecto completo y no escribe.

Comprueba el resultado:

```bash
npm run mnemosine -- entry show P-2026-0001
```

**Qué hacer si sale distinto.**

- *«does not pass validation»*: `entry check` te dice qué regla falló. Lo más común es que no cuadre la partida doble, o que una cuenta sea de agrupación y no acepte movimientos.
- *«No open fiscal period covers ...»*: te faltó el paso 3, o la fecha de la póliza cae en un mes cerrado.
- *«is already posted»*: ya estaba contabilizada. El mensaje te va a proponer `entry reverse`, que es lo correcto: en este sistema una póliza contabilizada no se edita ni se borra, se corrige con su espejo (NIF B-1).
- *`Aborted.`*: contestaste algo que no era `y`.

---

## Paso 8 · Los maestros de clientes y proveedores

**Qué quieres lograr.** Tener dados de alta a los proveedores y clientes con los que vas a operar. No es obligatorio para contabilizar, pero sí para capturar facturas.

```bash
npm run mnemosine -- vendor create "Papelería del Centro SA de CV" \
  --tax-id PCE010101AB1 --tax-id-type rfc \
  --terms "Net 30" --currency MXN --default-account 5100
```

```bash
npm run mnemosine -- customer create \
  --name "Comercializadora del Norte SA de CV" \
  --tax-id CNO120315QX8 --tax-id-type rfc \
  --terms "Net 30" --currency MXN
```

**Fíjate en la asimetría**, porque cuesta un intento fallido: el nombre del **proveedor** va como argumento suelto, y el del **cliente** va en la bandera `--name`. Son la misma idea escrita de dos formas distintas.

**Qué hacer si sale distinto.** No hay alta masiva: no existen `vendor import` ni `customer import`. Un cliente con trescientos proveedores se captura de uno en uno. En la práctica conviene dar de alta sólo los recurrentes y dejar que la ingesta de CFDI vaya revelando el resto.

Una consulta que agradecerás en la primera DIOT:

```bash
npm run mnemosine -- vendor list --no-tax-id
```

Lista los proveedores sin RFC en el expediente, que son exactamente los que bloquean la declaración.

---

## Paso 9 · El panel de criterios contables

**Qué quieres lograr.** Definir las decisiones de criterio que no son regla de ley sino política del despacho: a partir de qué monto se capitaliza un activo en vez de mandarlo a gasto, cómo se registran los consumos en restaurantes, si la empresa lleva inventarios perpetuos, si es contribuyente de IEPS. El agente las consulta cada vez que clasifica.

```bash
npm run mnemosine -- pending -v
```

**Qué vas a ver.** Las decisiones abiertas con su clave, el valor con el que el sistema está operando por omisión, y —con `-v`— el impacto, las opciones y por qué ese valor es el predeterminado. Las preguntas están **en inglés** aunque los conceptos sean irreductiblemente mexicanos (IEPS, el 8.5 % de restaurantes, REP). Es una brecha conocida.

Para fijar una:

```bash
npm run mnemosine -- pending define umbral_capitalizacion_mxn 50000 \
  -n "criterio del despacho: activos por debajo de 50 mil van a gasto"
```

Hay que teclear la clave completa, tal como aparece en el panel; no hay selector numérico. Si te equivocas al copiarla, el error te va a decir que no existe una decisión con esa clave y te va a mandar de vuelta a `mnemosine pending`.

Las otras dos operaciones del panel:

```bash
npm run mnemosine -- pending dismiss <clave>      # no aplica a esta empresa
npm run mnemosine -- pending reopen <clave>       # cambió la política
```

**Qué hacer si sale distinto.** Si no entiendes una pregunta, déjala como está: el valor por omisión es el conservador y está razonado. Lo peligroso no es dejarla abierta, es definirla mal. Y si la contestas mal, `pending reopen` la devuelve a la agenda.

---

## Paso 10 · Las credenciales fiscales (opcional, y con una advertencia)

Se puede registrar la e.firma de la entidad:

```bash
npm run mnemosine -- sat cred add --cer ./fiel.cer --key ./fiel.key --live
```

```bash
npm run mnemosine -- sat cred status
```

La ceremonia está bien hecha: la contraseña se pide sin eco, hay un texto de consentimiento explícito, el material se guarda cifrado, cada acceso queda en bitácora (`sat cred audit`) y la revocación es irreversible.

**La advertencia:** hoy esa credencial **no se usa para nada**. La ayuda de la familia dice «SAT services (credentials and CFDI download)», pero la descarga masiva de CFDI no existe: el único subcomando es `cred`. Si tu razón para registrar la e.firma era bajar los CFDI del mes, no la registres todavía. Los CFDI se siguen bajando del portal del SAT a mano.

Lo que sí funciona sin e.firma es la consulta del estatus de un CFDI ante el SAT, que usa el servicio público (`mnemosine cfdi status sync`).

---

## Paso 11 · Comprobar que quedó bien

**Qué quieres lograr.** Salir del alta con la certeza de que la empresa está lista para operar, en vez de descubrirlo el día 12 del mes.

Cuatro comandos, en este orden:

```bash
npm run mnemosine -- entity show
```
Que la entidad activa sea la correcta y el RFC esté bien escrito.

```bash
npm run mnemosine -- period list
```
Que existan los doce periodos y que al menos uno esté abierto.

```bash
npm run mnemosine -- ledger check
```
Corre las comprobaciones de integridad del mayor: cuadre, rastro de auditoría y continuidad. Si encuentra algo, termina con código 4; si no pudo mirar —porque no hay conexión, por ejemplo—, termina con otro código. Esa distinción es deliberada y es la que evita que una automatización cante victoria sin haber revisado nada.

```bash
npm run mnemosine -- report trial-balance show --period 2025-12
```
Que la balanza de saldos iniciales cuadre y diga lo que el cliente te entregó.

**Qué hacer si sale distinto.** Si la balanza no cuadra, la póliza de saldos iniciales tiene un renglón mal. Si ya está contabilizada, no la edites: revérsala y captura la buena.

```bash
npm run mnemosine -- entry reverse P-2026-0001 --reason "saldo inicial de clientes mal capturado"
```

`--reason` es obligatorio y queda en la bitácora. La reversa crea el asiento espejo, contabilizado y ligado al original; los dos quedan visibles, que es como debe ser.

---

## La lista de verificación del alta

Para tenerla a la mano:

1. `doctor` en verde.
2. `entity create` con el RFC correcto.
3. `entity use` y `entity show`.
4. `year create` y al menos un periodo abierto.
5. `account role list` sin roles huérfanos; cuentas 3900 y 3200 presentes.
6. `account map check --strict` sin hallazgos, o con los que aceptas.
7. Saldos iniciales contabilizados y balanza cuadrada.
8. Proveedores y clientes recurrentes dados de alta.
9. `pending -v` revisado.
10. `ledger check` limpio.

Cuando los diez estén, la empresa está lista. El siguiente paso es el trabajo del mes: **[[Manual-El-dia-a-dia]]**.
