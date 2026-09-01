# Reportes y entregables

Lo que un despacho le entrega a su cliente cada mes: la balanza, los estados financieros, los auxiliares de las cuentas que le interesan, la antigüedad de saldos y —cuando toca— los archivos para el SAT. Esta página dice **exactamente** qué sale hoy desde la terminal, en qué formato, y qué todavía no sale, para que nadie prometa un entregable que no existe.

> Si al teclear `mnemosine` tu terminal responde «command not found», todo lo de esta página se escribe `npm run mnemosine -- <comando>`, con los dos guiones. Ver [[Puesta-en-marcha]].

---

## El resumen, primero

| Entregable | Comando | Hoy |
|---|---|---|
| Balanza de comprobación | `report trial-balance show` | Sí |
| Balance general | `report balance-sheet show` | Sí |
| Estado de resultados | `report income-statement show` | Sí |
| Mayor (movimientos posteados) | `report general-ledger show` | Sí |
| Auxiliar de una cuenta (forma XC) | `ledger auxiliary show` | Sí |
| Saldos de una cuenta por periodo | `ledger balance show` · `account balance show` | Sí |
| Antigüedad de cuentas por cobrar | `report aged-receivable show` | Sí |
| Antigüedad de cuentas por pagar | `report aged-payable show` | Sí |
| Pólizas con sus renglones, planas | `entry export` | Sí |
| Espejo de CFDI y el XML original | `cfdi list` · `cfdi show --format xml` | Sí |
| Estado de flujos de efectivo (NIF B-2) | — | **No** |
| Variaciones en el capital contable (NIF B-4) | — | **No** |
| Comparativo contra el periodo anterior | — | **No** |
| XML de contabilidad electrónica (Anexo 24) | — | **No** |
| DIOT | — | **No** |
| PDF o XLSX | — | **No** (CSV a Excel) |

Los formatos de salida de todos los que sí salen son los mismos seis: `table`, `json`, `ndjson`, `csv`, `tsv`, `md`.

---

## Antes de sacar nada

Tres comprobaciones que cuestan segundos y evitan entregar un estado financiero equivocado.

```bash
mnemosine entity use <RFC del cliente>     # trabaja en los libros correctos
mnemosine entity show                      # y confirma cuáles son, y por qué
```

`entity show` dice además **de dónde salió** esa selección: si la nombraste en la línea, si viene de una variable de entorno, si la fijaste con `entity use`, o si es la única entidad activa. Trabajar en la contabilidad equivocada es el error más caro de un despacho, y esta línea lo previene.

```bash
mnemosine ledger check --period 2026-08
```

Corre las verificaciones de integridad del mayor. **Sale con código 4 si encuentra algo**, y ese 4 significa «encontré problemas», no «no pude mirar»: si la base no responde, sale con otro código. La diferencia importa cuando esto vive en un guion.

```bash
mnemosine report view show
```

Hay dos vistas materializadas de apoyo —balanza y resumen de saldos— que se refrescan cuando una póliza pasa a posteada. Una migración o una carga masiva las deja atrás. `view show` dice si cada una sigue de acuerdo con el mayor y por cuánto; si no, se reconstruyen:

```bash
mnemosine report view sync
```

Esa reconstrucción es de toda la instalación, no de una entidad, y toma candados: no la corras a media captura de otro compañero.

---

## La balanza de comprobación

```bash
mnemosine report trial-balance show --period 2026-08
```

Columnas: código de cuenta, nombre, tipo, cargos del periodo, abonos del periodo y saldo final.

**El selector de periodo** es el mismo en todos los reportes y acepta más de lo que parece:

```text
--period 2026-08          un mes
--period 2026-Q3          un trimestre
--period FY2026           el ejercicio
--period last-month       el mes anterior
--period 2026-01..2026-06 un rango
```

Cuando la expresión casa con un periodo fiscal exacto, el reporte usa **ese periodo por su identificador**, que es la lectura estricta. Cuando no casa con ninguno, te lo dice y usa el rango de calendario. Es un aviso, no un error, y conviene leerlo.

Alternativas: `--as-of 2026-08-31` da el **acumulado** hasta esa fecha en vez de la actividad del periodo, y `--since`/`--until` un rango libre. Y `--date-basis document|posting|value` decide sobre qué fecha se filtra; por omisión es la de posteo.

Dos banderas que un contador usa todos los meses:

```bash
mnemosine report trial-balance show --period 2026-08 --level 4 --exclude-zero
```

`--level` acumula hasta ese nivel de cuenta —la balanza a cuarto nivel es lo que se entrega, no la de renglón por renglón—, y `--exclude-zero` omite las cuentas cuyo saldo final es exactamente cero.

**Dos propiedades que hay que conocer del pie de la balanza:**

- Los totales se calculan sobre **todas** las cuentas que casaron, no sobre la página que ves. Poner `--limit 50` cambia lo que lees, nunca lo que la balanza dice.
- El pie —`Debits … Credits … (N accounts)` y la palabra `balanced`, o el aviso de descuadre con la diferencia exacta— **no sale con los datos**, sale por el canal de avisos. Es deliberado: una fila de totales colada dentro de un CSV es una mina para quien lo importa a Excel. Cuando exportas, el archivo trae sólo cuentas.

Si la página se cortó, también te lo dice, con cuántas de cuántas filas viste y los tres remedios: subir `--limit`, paginar con `--offset`, o pedir `--all`.

---

## El balance general

```bash
mnemosine report balance-sheet show --as-of 2026-08-31
```

Activo, pasivo y capital a una fecha de corte, en signo natural. Los **subtotales viajan dentro de los datos**, no sólo en la pantalla: cada renglón trae una columna `line` que dice si es `account`, `subtotal` o `total`, además de la sección y la categoría. Eso significa que el CSV que exportas ya trae el estado armado con sus sumas, no una lista de cuentas que alguien tenga que subtotalizar en Excel.

Y una decisión que conviene conocer: **si el balance no cuadra, el comando falla**, con código 4 y un mensaje que dice por cuánto y qué hacer (`entry check` y conciliar los auxiliares). No advierte y sigue. Un balance que no cuadra no es una advertencia, es un defecto del mayor a esa fecha, y entregarlo sería peor que no entregar nada. El resultado del ejercicio en curso ya está dentro del capital, así que el estado cuadra esté cerrado o no el año.

---

## El estado de resultados

```bash
mnemosine report income-statement show --period 2026-08
```

Ingresos, gastos y utilidad del periodo, con la misma estructura de secciones y totales dentro de los datos.

Un estado de resultados cubre un periodo, así que **el comando exige uno**: sin `--period` —o sin `--since` y `--until` juntos— se niega en vez de inventar un rango que se vería autoritario. Es la respuesta correcta.

---

## El mayor

```bash
mnemosine report general-ledger show --period 2026-08
mnemosine report general-ledger show --account 1120 --period 2026-08
```

Movimiento por movimiento: fecha, número de póliza, cuenta, nombre, número de renglón, cargo, abono y descripción. Si le pasas una cuenta que no existe, falla diciéndolo en vez de devolverte un mayor vacío.

**Es el único reporte con tope por omisión: 100 renglones.** El mayor no está acotado por naturaleza, y volcar cuarenta mil movimientos a la terminal no ayuda a nadie. El pie te dice cuántos de cuántos viste. Para el archivo completo, `--all` o un `--limit` alto, y siempre con `-o`.

Con `--as-of` el significado es el mismo que en la balanza: todo lo posteado hasta esa fecha, sin límite inferior.

---

## El auxiliar de una cuenta

```bash
mnemosine ledger auxiliary show --account 1120 --period 2026-08
```

Saldo inicial, cada movimiento, saldo final: **la forma XC que pide el SAT**. Las dos banderas son obligatorias; el periodo acepta un fragmento del nombre si es inequívoco.

El encabezado trae la cuenta, el periodo, **el estatus del periodo** y el saldo inicial. Y aquí hay una advertencia que este comando da y que casi ningún sistema da: si el periodo anterior no tiene cierre duro, el saldo inicial se marca como *actividad, no acumulado*. Es la diferencia entre un auxiliar que se puede entregar y uno que hay que explicar.

Al pie: cargos, abonos y saldo final. Si el saldo final guardado no coincide con el calculado a partir de los movimientos, lo dice y manda a `ledger check`. Ese aviso nunca hay que ignorarlo.

Para el saldo de una cuenta descompuesto por periodo, con el estatus de cada uno:

```bash
mnemosine ledger balance show --account 1120
mnemosine account balance show 1120 --period 2026-08
```

(`--dim`, el desglose por dimensión, está declarado pero todavía no existe: el comando te lo dice en lugar de ignorar la bandera.)

---

## Antigüedad de saldos

```bash
mnemosine report aged-receivable show
mnemosine report aged-payable show
```

Facturas abiertas por cubeta de antigüedad, ordenadas por lo más vencido, con el saldo que sigue debiéndose. Las cubetas son `current`, `1-30`, `31-60`, `61-90` y `90+` días de vencido, y el pie da el total abierto y cuántos documentos son.

**El límite, dicho en voz alta.** Con `--as-of` de una fecha pasada, el reporte **envejece las fechas de vencimiento contra esa fecha, pero los importes son los saldos abiertos de hoy**. El propio comando lo advierte cuando la fecha no es la de hoy. Reconstruir lo que se debía en una fecha pasada requiere el historial de pagos, y este reporte no lo reconstruye. Para el corte del mes, córrelo el día del cierre y guárdalo; no lo reconstruyas después.

---

## Exportar

Todos los reportes comparten el mismo contrato de salida.

```bash
--format table|json|ndjson|csv|tsv|md
--json                 atajo de --format json
-o, --output <ruta>    escribe a un archivo en vez de a la pantalla
--fields <a,b,c>       elige columnas; sin valor, lista las disponibles
-q, --quiet            sólo identificadores, uno por renglón, para encadenar
```

```bash
mnemosine report trial-balance show --period 2026-08 --format csv -o balanza-2026-08.csv
mnemosine report trial-balance show --fields          # ¿qué columnas hay?
mnemosine report income-statement show --period 2026-08 --format md -o resultados.md
```

Y las pólizas completas, con sus renglones, sin tope de página, para auditoría o migración:

```bash
mnemosine entry export --period 2026-08 --format csv -o polizas-2026-08.csv
```

**Cinco cosas que hay que saber del archivo que sale:**

1. **El dinero es texto, nunca número de punto flotante.** Es deliberado: un viaje de ida y vuelta por flotante es como una balanza deja de cuadrar por un centavo que nadie encuentra. Al abrir el CSV en Excel, formatea la columna como número.
2. **Los encabezados son nombres técnicos en inglés** (`account_code`, `debit_total`, `ending_balance`). Es una brecha conocida —está en [[Auditorias]]— y hoy la salida es la que es. Con `--fields` eliges y ordenas columnas; los nombres hay que renombrarlos al armar el entregable.
3. **Las fechas salen en formato ISO** (`2026-08-31`), no `dd/mm/aaaa`.
4. **Los importes salen sin separador de miles y con cuatro decimales.** Correcto para importar, incómodo para leer en pantalla.
5. **Los avisos no ensucian el archivo.** El encabezado, el pie de totales, la advertencia de truncamiento y los descuadres salen por el canal de avisos; el archivo trae sólo datos. Y si el comando falla, el archivo no queda escrito a medias.

No hay salida a PDF ni a XLSX. El camino real es CSV y darle formato una vez en una plantilla de Excel.

---

## Los archivos del SAT

Aquí es donde hay que ser más preciso, porque es donde más fácil se promete de más.

### Lo que sí hay

**El agrupador del Anexo 24**, que es el trabajo pesado del alta de un cliente:

```bash
mnemosine account map import ./agrupador.csv --scheme sat-agrupador --dry-run
mnemosine account map import ./agrupador.csv --scheme sat-agrupador
mnemosine account map list --scheme sat-agrupador
mnemosine account map check --scheme sat-agrupador --level 3 --strict
```

El archivo es `code,valor`, una cuenta por renglón, con coma o punto y coma. `map check` es la **compuerta de cobertura**: dice qué cuentas de nivel alto siguen sin mapear, y con `--strict` sale con código 4 si falta alguna.

**El espejo de CFDI:**

```bash
mnemosine cfdi list --direction recibido --period 2026-08
mnemosine cfdi show <uuid>
mnemosine cfdi show <uuid> --format xml     # los bytes exactos del comprobante
mnemosine cfdi explain <uuid>               # por qué se registró así
mnemosine cfdi status sync --live           # revalida el estatus ante el SAT
```

El `--format xml` es el que entregas cuando alguien pide el comprobante original: son los bytes tal como llegaron, no una reconstrucción.

**Los complementos de pago:**

```bash
mnemosine rep missing list --direction received
mnemosine rep missing list --direction issued
mnemosine rep reconcile
```

**La lista de bloqueadores de la DIOT** —proveedores sin RFC capturado, que no pueden aparecer en la declaración—:

```bash
mnemosine vendor list --no-tax-id
```

### Lo que no hay

- **No se genera el XML de contabilidad electrónica.** Ni catálogo de cuentas, ni balanza, ni pólizas, ni auxiliares. Las piezas de preparación existen —el agrupador, su compuerta de cobertura, y el auxiliar ya en la forma XC— pero el generador no. El archivo se arma hoy exportando a CSV y produciéndolo fuera.
- **No se genera la DIOT.** Existe la lista de proveedores que la bloquearían; no la declaración.
- **No hay descarga masiva de CFDI del SAT.** La familia `sat` administra credenciales (`cred add`, `status`, `audit`, `revoke`) y nada más, aunque su descripción diga otra cosa. Los comprobantes se bajan del portal a mano y se ingieren con `mnemosine ingest`. Consecuencia directa, dicha sin rodeos: **desde aquí no se puede afirmar completitud de los CFDI recibidos.** Ver [[Fiscal-mexicano]] y [[Hoja-de-ruta]].

---

## El paquete del mes

No existe un comando que arme el paquete completo. Existe la secuencia, y se deja escrita para copiarla:

```bash
mnemosine entity use ACO850101AB1
mkdir -p entregables/2026-08

# 1. Que el mayor esté sano y las vistas al día
mnemosine ledger check --period 2026-08
mnemosine report view show

# 2. Los estados
mnemosine report trial-balance show --period 2026-08 --level 4 --exclude-zero \
  --format csv -o entregables/2026-08/balanza.csv
mnemosine report balance-sheet show --as-of 2026-08-31 \
  --format csv -o entregables/2026-08/balance.csv
mnemosine report income-statement show --period 2026-08 \
  --format csv -o entregables/2026-08/resultados.csv

# 3. La cartera, el mismo día del corte
mnemosine report aged-receivable show \
  --format csv -o entregables/2026-08/antiguedad-cobrar.csv
mnemosine report aged-payable show \
  --format csv -o entregables/2026-08/antiguedad-pagar.csv

# 4. El soporte
mnemosine entry export --period 2026-08 \
  --format csv -o entregables/2026-08/polizas.csv
mnemosine ledger auxiliary show --account 1120 --period 2026-08 --all \
  --format csv -o entregables/2026-08/auxiliar-bancos.csv
```

Dos notas sobre el orden. La antigüedad de saldos va **el día del corte**, por la razón explicada arriba. Y el paquete se arma **después** de cerrar el periodo, no antes: si alguien postea una póliza más tarde, el CSV que ya mandaste deja de corresponder al mayor. Ver [[Manual-El-cierre-de-mes]].

Si el despacho lleva varios clientes, la lista de entidades se puede encadenar:

```bash
mnemosine entity list -q
```

Devuelve un identificador por renglón, listo para un bucle. No hay todavía una vista de todos los clientes a la vez: cada reporte es de una entidad por invocación.

---

## Lo que todavía no sale

Dicho aquí para que nadie lo prometa:

- **Estado de flujos de efectivo (NIF B-2)** y **estado de variaciones en el capital contable (NIF B-4)**. La familia de reportes cubre cinco de los siete estados que un despacho entrega.
- **Comparativos.** Cada reporte es de un corte. Agosto contra julio son dos corridas y la comparación se hace fuera.
- **PDF y XLSX.** El camino es CSV más plantilla.
- **XML del Anexo 24 y DIOT.**
- **Un comando que arme el paquete.** Por ahora es la secuencia de arriba.
- **Ejemplos en la ayuda.** Ningún comando trae ejemplos en su `--help`; esta página y el resto del manual son, por ahora, el sustituto.

El estado real de cada hueco no se lee de aquí: se pregunta al código con `npm run plan:status`, y la evidencia de cada uno está en [[Auditorias]].

---

## Para seguir

- [[Manual-El-cierre-de-mes]] — qué tiene que estar hecho antes de que estos reportes sean entregables.
- [[Manual-El-dia-a-dia]] — la captura y el posteo que alimentan todo esto.
- [[Manual-Cobrar-y-pagar]] — de dónde salen las antigüedades de saldos.
- [[Fiscal-mexicano]] — CFDI, REP, IVA en base a flujo y el estado del timbrado.
- [[Catalogo-de-comandos]] — la superficie completa, medida contra el binario.
- [[Hoja-de-ruta]] — en qué orden se van a cerrar los huecos de esta página.
