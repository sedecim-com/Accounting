# Manual de usuario

Esta es la puerta del manual. Las otras dos páginas son recorridos completos: [[Manual-Primer-cliente]] lleva de la nada al primer asiento contabilizado, y [[Manual-El-dia-a-dia]] cubre el trabajo de todos los días. Esta página existe para que sepas cuál de las dos abrir, y para explicarte las cuatro cosas que hay que entender **antes** de teclear nada.

Si lo que buscas es instalar el sistema —Node, PostgreSQL, el `.env`, las migraciones—, eso no está aquí: está en [[Puesta-en-marcha]]. Este manual empieza cuando `mnemosine doctor` ya te contesta.

---

## Para quién es

Para el contador. Da por hecho que sabes contabilidad y fiscal mexicano: qué es una póliza, qué es un cargo y qué un abono, qué es la balanza de comprobación, qué diferencia hay entre PUE y PPD y por qué el IVA de una factura PPD no se acredita hasta que se paga. Nada de eso se explica aquí.

Lo que **no** da por hecho es que sepas de terminales. No hace falta saber git, ni programar, ni entender qué es una variable de entorno. Los comandos de este manual se copian y se pegan.

Lo que sí necesitas antes de empezar:

- Una terminal abierta en la carpeta donde está instalado mnemosine.
- Que alguien haya hecho ya la instalación de [[Puesta-en-marcha]]: base de datos arriba, migraciones corridas, `.env` escrito.

Compruébalo con una sola línea:

```bash
npm run mnemosine -- doctor
```

Si las tres comprobaciones salen en verde, estás listo. Si alguna sale en rojo, `doctor` te dice exactamente qué hacer y en qué orden; ese comando es el mejor del sistema y vale la pena aprendérselo. Volveremos a él cada vez que algo falle.

---

## Cómo se teclea un comando

mnemosine **no se instala como un comando del sistema**. Si escribes `mnemosine doctor` a secas, la terminal te va a contestar `command not found`. Esto importa, porque los propios mensajes del programa te van a decir cosas como «Run: `mnemosine init`» o «→ `mnemosine doctor`», y no se pueden teclear tal cual.

La forma real de invocarlo es siempre ésta:

```bash
npm run mnemosine -- <lo que diga el manual>
```

El `--` es obligatorio. Sin él, `npm` se queda con las banderas en vez de pasárselas al programa. Ejemplo completo, para que quede fijo:

```bash
npm run mnemosine -- report trial-balance show --period 2026-08
```

**Regla de lectura para todo el manual:** cuando veas escrito `mnemosine algo`, tecleas `npm run mnemosine -- algo`. En los bloques de código ya está puesto de la forma correcta; puedes copiarlos sin pensar.

---

## Las cuatro convenciones

### 1. Inquilino y entidad no son lo mismo

Son los dos niveles del sistema y se confunden con facilidad porque en español a los dos les diríamos «cliente».

**El inquilino (*tenant*)** es el despacho. Es quien tiene la instalación. Si eres un contador independiente, el inquilino eres tú. Casi nunca lo vas a nombrar: se toma de la configuración.

**La entidad** es cada empresa a la que le llevas los libros: una razón social, con su RFC, su catálogo de cuentas, su ejercicio fiscal y su mayor. Un despacho con cuarenta clientes tiene cuarenta entidades dentro del mismo inquilino, y los libros de una jamás se mezclan con los de otra: el aislamiento está en la base de datos, no en el programa ([[Aislamiento-multi-inquilino]]).

Casi todo comando trabaja sobre **una** entidad. Por eso lo primero que se hace en una sesión de trabajo es fijar cuál:

```bash
npm run mnemosine -- entity use ACO850101AB1
```

A partir de ahí, todos los comandos operan sobre esa empresa hasta que la cambies. Para saber sobre cuál estás parado —y, lo que es mejor, **por qué**:

```bash
npm run mnemosine -- entity show
```

Te dice el nombre de la entidad y de dónde salió la selección: si la fijaste tú con `entity use`, si viene de una bandera, o si es la única activa. Es la primera cosa que hay que mirar cuando un número no cuadra: puede que estés en los libros del cliente equivocado.

Y hay una tercera palabra que **no** significa ninguna de las dos: `mnemosine customer` (alias `cliente`) es el maestro de clientes de la entidad activa, es decir, los clientes de tu cliente, los de cuentas por cobrar. `mnemosine cliente listar` no lista las empresas del despacho.

### 2. Los comandos tienen alias en español, pero la interfaz está en inglés

Casi todo comando se puede teclear en español y funciona igual:

```bash
npm run mnemosine -- poliza contabilizar P-0042
npm run mnemosine -- reporte balanza ver --period 2026-08
npm run mnemosine -- factura-proveedor aprobar F-1234
```

El vocabulario contable de los alias es el correcto: `balanza`, `mayor`, `auxiliar`, `resultados`, `póliza` (escrito `poliza`, sin acento), `ejercicio`, `contabilizar`, `antiguedad-cobrar`. Quien los escribió sabe contabilidad mexicana.

Dicho eso, hay que ser claro sobre tres límites, porque encontrarlos a ciegas cuesta media mañana:

- **Los alias son sin acentos.** `mnemosine poliza` funciona; `mnemosine póliza` no. Y falla mal: en el primer nivel, una palabra que el programa no reconoce se la traga el comando de conversación y te contesta con un error que menciona `chat`, un comando que tú no escribiste:

  ```
  error: too many arguments for 'chat'. Expected 0 arguments but got 1: balanza.
  ```

  Si ves ese mensaje, no está roto nada: escribiste una palabra que no es un comando de primer nivel. `balanza` sí existe, pero vive dentro de la familia de reportes (`report balanza show`), no suelta en la raíz.

- **No todas las familias tienen alias completos.** `approvals`, `jobs` y `skills` no tienen subcomandos en español. Se tecleán en inglés.

- **Los alias traducen cómo se escribe el comando, no cómo se lee la respuesta.** La ayuda, los encabezados de las tablas y los mensajes de error están en inglés. La balanza sale con columnas `account_code`, `debit_total`, `credit_total`, `ending_balance` sobre nombres de cuenta en español. Es feo y está reconocido como una brecha del producto; hoy es así. La equivalencia de términos está en [[Glosario]].

Una consecuencia práctica: si vas a entregarle la balanza a un cliente, la vas a tener que renombrar las columnas en Excel. Exporta a CSV (ver [[Manual-El-dia-a-dia]]) y hazlo ahí, no a mano en la terminal.

### 3. La IA propone y tú dispones

Éste es el principio del que cuelga todo el diseño, y conviene entenderlo antes de usar el sistema, no después.

El agente **no puede escribir en el mayor**. Nunca. Cuando ingestas los CFDI del mes, la IA no contabiliza: crea **borradores** (`ai_drafts`), que son propuestas de póliza con su razonamiento y su nivel de confianza. Un borrador no mueve un solo saldo. Se convierte en póliza contabilizada únicamente cuando una persona lo aprueba, y la aprobación queda amarrada al contenido exacto que esa persona vio en pantalla: si el borrador cambia entre que lo lees y que lo apruebas, la aprobación se cancela sola.

Lo mismo pasa con todo lo que sale al mundo exterior —timbrar, enviar, pagar—: se encola y espera a un humano.

Esto tiene una consecuencia que hay que decir sin rodeos: **revisar es tu trabajo, no un trámite.** El sistema está construido sobre la idea de que alguien mira cada propuesta. Si apruebas en automático, el diseño entero deja de protegerte. Por eso [[Manual-El-dia-a-dia]] le dedica su sección más larga a la revisión, y por eso vale la pena leerla completa antes de la primera ingesta de verdad.

Los límites del agente y por qué viven en código y no en configuración están explicados en [[El-agente-y-sus-limites]].

### 4. Cuando el sistema te pregunta, contesta `y`

Todo acto que toca el mayor te pide confirmación antes de hacerlo. La pregunta se ve así:

```
Post P-0042 (18,500.00) to the ledger? This cannot be undone. [y/N]
```

Dice el folio, dice el importe, y avisa que no se deshace. Está bien hecho. Pero hay que memorizar dos cosas:

**Para decir que sí, escribe exactamente `y` (o `yes`).** En los comandos que contabilizan —`entry post`, `entry reverse`, `entry void`, `invoice issue`, `invoice void`, `payment create`, `bill approve`— la letra `s` y la palabra `sí` **no** se entienden como afirmación: el comando aborta y te contesta `Aborted.` sin explicar que no te entendió. Si tecleaste `s` y el sistema canceló, no fue una regla contable: fue el idioma.

**Para decir que no, escribe `n`.** No escribas `salir`, ni `stop`, ni ninguna otra cosa. En el comando de cierre de periodo (`mnemosine close`) la validación de la respuesta es laxa y cualquier palabra que empiece con `s` —`salir` incluida— se toma como un sí. En un cierre duro eso es irreversible. `n` es la respuesta segura en todas las compuertas del sistema.

Y si prefieres ver el efecto antes de decidir, casi todos esos comandos aceptan `--dry-run`, que calcula y muestra lo que pasaría sin escribir nada.

---

## El mapa de tareas

### Quiero dar de alta un cliente nuevo

**[[Manual-Primer-cliente]]** — de la nada al primer asiento contabilizado: crear la entidad con su RFC, abrir el ejercicio y los periodos, revisar el catálogo de cuentas, mapear el agrupador del SAT, capturar los saldos iniciales y comprobar que todo quedó bien antes de empezar a operar.

### Quiero contabilizar mis CFDI del mes

**[[Manual-El-dia-a-dia]] → «Recibir los CFDI y contabilizarlos»** — cómo se ingestan los XML, qué hace cada una de las tres capas (reglas, IA, umbrales) y qué esperar de la corrida.

### Quiero revisar lo que propuso la IA

**[[Manual-El-dia-a-dia]] → «Revisar los borradores»** — la sección más importante del manual. Qué ves en pantalla, qué hace cada tecla, qué mirar antes de aprobar y cuáles son las trampas de la cola de revisión.

### Quiero capturar una factura que no llegó por CFDI

**[[Manual-El-dia-a-dia]] → «Capturar a mano»** — facturas de proveedor, facturas de cliente y pólizas manuales. Cuidado especial ahí: los tres comandos usan **tres formatos distintos** para escribir un renglón, y `tax=` significa una cosa en facturas de cliente y otra en facturas de proveedor.

### Quiero facturar y cobrar

**[[Manual-El-dia-a-dia]] → «Facturar a un cliente» y «Registrar cobros y pagos»**. Con una advertencia que hay que leer antes: **mnemosine no timbra**. `mnemosine invoice issue` (alias `emitir`) contabiliza la factura en el mayor —cargo a clientes, abono a ingresos y al IVA— pero no la manda al PAC ni genera el CFDI. El timbrado se sigue haciendo en el portal de tu PAC, a mano. El alias español `emitir` es engañoso justamente por esto.

### Quiero saber cómo va el mes

**[[Manual-El-dia-a-dia]] → «Consultar cómo va el mes»** — balanza, auxiliar de una cuenta, saldo por periodo, pólizas del mes, borradores que llevan mucho sin resolverse, y la lista de lo que le falta al periodo para poder cerrarse.

### Quiero entregarle sus estados al cliente

**[[Manual-El-dia-a-dia]] → «Consultar cómo va el mes»**, apartado de exportación. Los seis reportes salen a CSV, TSV, JSON o Markdown con `--format` y `-o`. Lo que **no** hay hoy: PDF, Excel, columna comparativa contra el mes anterior, ni un comando que arme el paquete completo. Son seis comandos, uno por reporte, y el formato final se le da en Excel.

### Algo falló y no entiendo el mensaje

Una sola línea, siempre la misma:

```bash
npm run mnemosine -- doctor
```

Es importante porque **los mensajes de error de los demás comandos no te van a mandar aquí**. Cuando la base de datos no responde, casi todos los comandos escupen el error crudo de PostgreSQL y nada más:

```
role "postgres" does not exist
```

Eso significa «no hay conexión con la base de datos», aunque no lo diga. Y hay una variante peor, que aparece cuando tienes una entidad fijada:

```
Could not resolve the active entity (1ddac7ab-1f0d-42a2-8e21-6387fd1789bb): role "postgres" does not exist
The selection was kept. Use `mnemosine entity use <id|name>` to change it, or `mnemosine entity unset` to clear it.

role "postgres" does not exist
```

**No hagas caso de ese consejo.** Te está diciendo que arregles la selección de empresa, pero el problema no es la selección: es la conexión. Correr `entity use` va a fallar igual, y `entity unset` te va a borrar la selección sin arreglar nada. Cuando veas cualquier mensaje que mencione `role`, `connection`, `postgres` o `timeout`, corre `doctor` y sigue lo que diga.

El catálogo de fallos frecuentes y su remedio está en [[Solucion-de-problemas]].

---

## Lo que hoy no se puede hacer desde la terminal

Un manual que promete un paso que no existe es peor que no tener manual. Ésta es la lista completa de lo que un despacho espera y hoy **no** está, con lo que se usa en su lugar. Cada una está explicada en su sitio dentro de las otras dos páginas.

| Lo que buscas | Estado hoy | Con qué se sustituye |
|---|---|---|
| Descarga masiva de CFDI del SAT | No existe. La familia `sat` sólo tiene `cred`, aunque su ayuda diga «and CFDI download» | Bajar el ZIP del portal del SAT a mano y descomprimirlo |
| Timbrar un CFDI | No existe | Timbrar en el portal del PAC. `invoice issue` sólo contabiliza |
| Cancelar un CFDI ante el SAT | No existe | Cancelar en el PAC y después `entry reverse <folio> --reason "CFDI cancelado, acuse ..."` |
| Emitir el REP (complemento de pago) | No existe | Emitirlo en el PAC. `rep missing list` sí te dice cuáles faltan |
| Conciliación bancaria | No hay familia `bank` en la terminal, ni alta de cuentas bancarias | Conciliar fuera y capturar los hallazgos (comisiones, intereses, cheques en tránsito) como pólizas manuales |
| XML de contabilidad electrónica (Anexo 24) y DIOT | No se generan | Exportar la balanza y el auxiliar a CSV y generarlos fuera |
| Reabrir un periodo cerrado | No hay comando | La corrección se registra en un periodo abierto. Piénsalo antes de cerrar |
| Aplicar un lote de `entry import` | El lote se queda escenificado; la familia que lo aplica no existe todavía | Capturar los saldos iniciales como una póliza manual (ver [[Manual-Primer-cliente]]) |
| Migrar desde CONTPAQi o Aspel con `onboard` | Sólo hay adaptador de Contalink | Saldos iniciales a mano, como póliza |
| Programar pagos | No existe, y el sistema lo dice: no habla con ningún banco | `payment create` registra dinero que **ya salió**, no lo manda |
| Estados financieros en PDF o Excel | No existe | `--format csv -o archivo.csv` y darles formato en Excel |

Dos ausencias merecen un aviso especial, porque no fallan: pasan calladas.

**El checklist de cierre da verde en la conciliación bancaria.** Como no hay forma de dar de alta una cuenta bancaria desde la terminal, el conteo de cuentas sin conciliar da cero, y `mnemosine close --check` reporta «Bank reconciliations complete». No significa que esté conciliado: significa que no había nada que contar. Trátalo como una partida que verificas fuera del sistema.

**El cierre duro de fin de ejercicio puede saltarse los asientos de cierre.** Si el catálogo de la entidad no tiene las cuentas 3900 y 3200 marcadas como cuentas de sistema —cosa que pasa cuando el catálogo se importó de otro sistema en vez de sembrarse—, `close --hard` de diciembre reporta éxito sin generar el traspaso de resultados a capital. Antes de cerrar un ejercicio, verifica que esas dos cuentas existan.

---

## Qué leer ahora

- Si es tu primer cliente en el sistema: **[[Manual-Primer-cliente]]**.
- Si la empresa ya está dada de alta y quieres trabajar el mes: **[[Manual-El-dia-a-dia]]**.
- Si quieres el catálogo completo de lo que se puede teclear: [[Catalogo-de-comandos]].
- Si te encontraste un término que no reconoces: [[Glosario]].
