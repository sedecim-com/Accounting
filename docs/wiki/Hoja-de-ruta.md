# Hoja de ruta

Este proyecto tiene tres documentos rectores y ninguno de ellos lleva tabla de
estado. El estado se pregunta con dos comandos; los documentos dicen otra cosa:
**qué falta**, **cuánto cuesta** y **en qué orden**.

| Documento | Responde | Dónde vive |
|---|---|---|
| Plan Maestro | La secuencia y las garantías: qué tramo va antes de cuál y qué riesgo cierra cada uno | Fuera del repositorio, como artefacto HTML; los informes lo citan por sección |
| «Doce sprints o sesenta» | Cuántas filas del catálogo faltan, cuánto cuesta cada una y en qué orden se cierran | [`docs/plan-catalogo.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/plan-catalogo.md) |
| Plan de cierre de brechas | El censo de la deuda heredada, partida por partida | [`docs/plan-cierre-brechas.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/plan-cierre-brechas.md) |

Antes que nada, la regla de la casa: **dos marcadores, cero copias**. Ninguna
cifra de esta página es autoritativa. Si tu árbol responde otra cosa, gana tu
árbol.

```bash
npm run plan:status
```

```bash
npm run catalogo:estado
```

## El Plan Maestro: la secuencia y los riesgos

El plan maestro es el documento que ordena. No cuenta filas: absorbe los
hallazgos de las [[Auditorias]] y decide qué se hace antes que qué, con el
criterio de que un riesgo cuyo daño es retroactivo se cierra antes que una
funcionalidad visible. Esa es la lógica de la secuencia que ya corrió: S0 y S1
(los cimientos y los falsos verdes del tablero), el tramo R (el mayor inviolable,
el perímetro, el refresco fuera del posteo), el tramo A (el agente medible) y
los flujos F01–F12.

Vive fuera del repositorio, que es su principal defecto: los informes lo citan
por sección y no por commit, y la tercera auditoría encontró que su sello va
cuatro commits por detrás de su propio árbol, dos de ellos con cambio de conducta
contable. Un documento que se republica no deja rastro de qué decía antes.

## «Doce sprints o sesenta»: el modelo de coste

Este es el documento que convierte «faltan filas» en «faltan sprints». Su unidad
es la **fila del catálogo de comandos**: una fila es un comando invocable, y
cerrarla cuesta código de entrega y código de garantía.

La medición fundacional, hecha una vez en agosto sobre 50 filas, dio **390 líneas
por fila**, todo incluido. En septiembre se volvió a medir sobre las 27 filas que
cerraron F01 y F02: **389,6**. El total sobrevivió; la composición no.

| | agosto | septiembre |
|---|---:|---:|
| Entrega — el comando y su servicio | 351 | 200 |
| Garantía — pruebas, criterios, correcciones | 39 | 189 |

Por cada línea entregada hoy se escriben **0,94 líneas de garantía**; en agosto
eran 0,11. El sistema no se volvió más caro: cambió en qué se gasta. El kernel
del CLI, los patrones y el tablero ya construidos hicieron que un comando nuevo
cueste sobre todo su servicio, y a cambio cada comando llega con criterios
verificados por mutación y pruebas contra Postgres real.

Es una noticia buena disfrazada de neutra: **la mitad del presupuesto de cada
fila es reutilizable**. Los criterios y los arneses no se vuelven a escribir en
la fila siguiente.

### El instrumento, y por qué hoy no se le puede creer del todo

El número no se guarda: se pregunta.

```bash
npm run costo:por-fila
```

[`scripts/costo-por-fila.ts`](https://github.com/sedecim-com/Accounting/blob/main/scripts/costo-por-fila.ts)
recorre los commits que movieron el suelo del catálogo
(`docs/catalogo-minimos.json`), y entre dos puntos de suelo mide las líneas
insertadas sobre `src`, `tests` y `scripts`. La unidad de avance es «fila
invocable», que es un proxy más duro que «fila cerrada»: exige que el comando se
pueda teclear. El script lo dice en su propia salida en vez de fingir
equivalencia.

**Y aquí va la limitación, antes que la virtud: hoy ese instrumento publica una
cola correctiva que no coincide con la medición honesta, y está señalado para
arreglo.** Imprime **0,7 %** donde la medición honesta de la misma ventana da
entre **11,8 % y 51,7 %** según la convención que se use: un falso verde de 17× a
74×. Hay dos causas y las dos son de método:

- **Clasifica por el asunto del commit**, con la expresión
  `/^AUD-|falso verde|corrig|repara/i`. Los asuntos de esta casa son narrativos
  —«R3: la serie la fija la fecha, el refresco sale del posteo»— en vez de
  etiquetados, así que casi ningún commit correctivo se declara como tal.
- **Los dos universos de archivo no coinciden.** La entrega se mide sobre
  `src|tests|scripts`; la cola, sobre todo el árbol. El porcentaje y la tabla ni
  siquiera son comparables entre sí.

La corrección está dispuesta como primera partida del tramo S2: un *trailer* de
commit que declare la corrección (`Corrige: E1.2, AUD-6`), un criterio que
rechace un commit de código sin él, la unificación de los dos universos de
archivo, y —mientras tanto— publicar la **banda** («entre 12 % y 52 % según
convención») en vez de un número solo.

Hay una segunda discrepancia, esta señalada por la tercera auditoría: el agregado
vivo que imprime el script hoy no es 390, y los documentos publican el 390 como
si fuera lectura del medidor. Cuando el documento y el medidor discrepan, gana el
medidor. Corre el comando.

### La cifra que decide el 69 % del presupuesto y nadie ha vuelto a medir

De las filas que faltan, **761 están marcadas ❌** —motor inexistente— y se
presupuestan a **520 líneas** cada una. Esa tarifa se estimó en agosto y nunca se
re-midió, porque el instrumento no cruza las filas que ganó cada tramo contra su
estado de motor.

Es la incertidumbre dominante del plan: cualquier otra afinación mueve decimales,
ésta mueve cientos de miles de líneas en las dos direcciones. La partida que la
cierra —cruzar las filas que cada tramo volvió invocables contra su celda
✅/🟡/❌ y publicar tres tarifas medidas— es la de más apalancamiento de todo el
documento, y el parser que hace falta ya existe dentro de
`scripts/catalogo-estado.ts`.

Mientras esa partida no corra, cualquier cifra sobre las filas ❌ es la
estimación de agosto con ropa nueva.

## El orden es por FLUJOS, no por familias

Ésta es la decisión de forma más importante del plan, y la que más contraintuitiva
resulta.

Terminar media familia `bank` —son 120 comandos— no le entrega **nada a nadie**.
El usuario no puede hacer más el lunes que el viernes: tiene la mitad de las
piezas de una operación que necesita todas. En cambio, «recibo un CFDI, lo
contabilizo, lo pago y concilio el pago contra el estado de cuenta» cruza cinco
familias y es algo que un contador ejecuta de punta a punta.

Así que cada sprint cierra un **flujo**, no una familia. El orden lo fijan las
dependencias de esquema y lo que hace falta para cerrar un mes.

| # | Flujo | Familias que cruza | Estado |
|---|---|---|---|
| 1 | Catálogo y asiento manual | account, entry, ledger | Cerrado (`a6932b1`) |
| 2 | Ingesta fiscal MX | cfdi, sat, rep | Parcial (`a149e62`): timbrado y descarga siguen bloqueados |
| 3 | Cobrar | customer, invoice, credit-note, receipt, ar | Cerrado (F03) |
| 4 | Pagar | vendor, bill, ap, payment | Cerrado (F04) |
| 5 | Banco | bank, reconciliation | `bank` cerrado en cuatro tramos (F05a–d); `reconciliation` genérica diferida al cierre |
| 6 | Cerrar el mes | closing, period, batch | En tramos: F06a adelanta `asset create` y `depreciation run\|post` DESDE LA COLA LARGA — el motor calculaba mal y la ventana de arreglarlo gratis se cerraba con la primera alta; F06c aplica el lote que F01 dejó sin salida; F06d (el cierre como proceso) se difiere y compite contra F07 |
| 7 | Contabilidad electrónica | e-accounting | |
| 8 | Nómina | pay-run, payslip, employee | |
| 9–12 | La cola larga de fase 1 | ~190 familias pequeñas | |

El conteo de filas por flujo no se copia aquí a propósito: sale de
`npm run catalogo:estado -- --json` agregando por familia, y la tercera auditoría
encontró que la suma publicada en los documentos da 378 donde el medidor dice
379 —la cola son 180 filas, no 179—. Una fila de fase 1 no pertenece hoy a
ningún flujo ni a ninguna cuenta de cola.

### Lo que no se recorta

**La cola larga no es relleno.** Las familias de menos de diez comandos concentran
alrededor del 41 % del catálogo, y dentro de ellas hay unas 180 filas de fase 1
que nadie puede saltarse. Veinticuatro familias tienen un solo comando.

Es el riesgo estructural del plan: no es trabajo concentrado que se pueda atacar
en bloque, son casi doscientas cosas pequeñas. Un plan ordenado por familias
grandes deja ese 41 % como «el resto» y no lo cierra nunca.

## El plan de cierre de brechas: el censo de la deuda

[`docs/plan-cierre-brechas.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/plan-cierre-brechas.md)
nació como plan prospectivo —15 paquetes, 147 tareas, 85 decisiones— y hoy es
otra cosa. Sus secciones prospectivas las sustituyó el plan maestro; el documento
**no se edita**, a propósito: es el registro de lo que se creía en su momento, y
buena parte de lo que decía era cierto entonces y es falso ahora. Lo que se le
añadió es un apéndice al final que reparte propiedad.

Lo que sólo vive ahí, y por eso el documento sigue importando:

**1. El inventario de las 147 partidas** (`E0.0-a` … `E5.1-k`), el censo más
completo que se ha hecho de la deuda de este sistema. Re-medido en septiembre:

| Disposición | agosto | septiembre |
|---|---:|---:|
| Hecha | 83 | 97 |
| Absorbida por una fase del plan maestro | 34 | 28 |
| Pendiente, con rojo en el tablero | 18 | 15 |
| Pendiente, sin dueño | 4 | 4 |
| Caída y rescatada, aún abierta | 8 | 3 |

Catorce partidas cambiaron de estado y las catorce resistieron la verificación:
no hay ninguna que la prosa de un commit dé por hecha y el código desmienta.

**2. La clase peligrosa: absorbida por una fase que corrió y no la entregó.** Una
partida marcada «absorbida» se da por muerta cuando su fase cierra. Si la fase
corre y no la entrega, la deuda desaparece del inventario sin haberse pagado. La
auditoría buscó exactamente eso y encontró tres. La peor es la documentación del
agente: los trece manuales que el agente lee siguen en la línea base de agosto, y
dos de ellos no están desactualizados sino **equivocados** —uno le enseña el
tratamiento de IVA que otro módulo existe para reparar—. Es la partida más
peligrosa del inventario porque su consumidor no es un humano que pueda dudar.

**3. Los 24 cabos.** Asuntos reales que ningún paquete recogía y que nunca
entraron al conteo de 147: «147/147» fue un conteo completo de lo numerado y un
conteo incompleto del documento. Su disposición: seis cerraron solos por efecto
colateral, uno mutó —el parser de constancias de retenciones ya no revienta, lo
rechaza con explicación, pero la capacidad sigue ausente—, uno tiene dueño, y
**dieciséis no tienen fase**. Ésos no figuran en ningún tablero, así que ningún
tablero puede ponerse rojo por ellos. Es la brecha clásica de esta casa mirada
desde el otro lado: no capacidad huérfana, sino **deuda huérfana**.

## Qué está comprometido y qué no

**El compromiso es la fase 1.** Son 379 filas del catálogo —el subconjunto con el
que un contador puede llevar los libros enteros desde la terminal— y a la
velocidad medida son del orden de **diez sprints** del tamaño de la mayor entrega
que este repositorio ha producido en un commit. El «doce sprints» de agosto
sobrevivió a la re-medición con dos de holgura.

Cuántas de esas 379 se pueden teclear hoy, y cuáles:

```bash
npm run catalogo:estado
```

**Lo que no está comprometido** son las 1 261 filas restantes del objetivo
completo: del orden de cincuenta sprints más y unas cinco veces el código actual.
Sigue sin recomendarse y ningún dato nuevo lo sostiene. Después de la fase 1, el
respaldo de ~1 000 filas se atiende por demanda, no por completitud.

Y dos cosas están **por delante** de seguir entregando flujos, porque las
auditorías las elevaron a bloqueo:

- **No existe respaldo ni restauración.** Ni una línea en todo el árbol. Lo
  agrava lo que el proyecto hizo bien: desde la migración 041 el mayor es
  físicamente inmutable y `audit_log` es de sólo agregar, así que un error de
  datos no se puede reparar a mano. La única salida sería restaurar, y no hay de
  dónde.
- **El tramo S2 de garantías**, entre el flujo 2 y el 3: arreglar el medidor de
  coste, medir la tarifa por estado de motor, poblar la compuerta de flujos
  cerrados y darle al trinquete granularidad de criterio y no de paquete.

## Cómo se pregunta el estado, sin escribir un número a mano

```bash
npm run plan:status
```

```bash
npm run plan:status -- E2.1
```

```bash
npm run catalogo:estado
```

Cada tramo añade sus criterios a
[`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts)
y su paquete a la lista `--exigir` de la CI **en el mismo commit que lo cierra**.
Con una salvedad que hay que escribir aquí: `--exigir` es de granularidad
paquete, así que hay criterios verdes viviendo dentro de paquetes rojos sin que
ningún commit pueda ponerlos en rojo. Hasta que eso se arregle, «entró al
trinquete» significa menos de lo que estos documentos daban por hecho.

## Para seguir

- [[El-tablero-y-los-criterios]] — cómo funciona `plan:status` por dentro y qué
  hace que un criterio sea creíble.
- [[Catalogo-de-comandos]] — qué es una fila, qué es fase 1 y cómo se cuenta.
- [[Auditorias]] — de dónde salen la mitad de las partidas de esta página.
- [[Como-contribuir]] — la mecánica de cerrar y reabrir un paquete a la vista.
