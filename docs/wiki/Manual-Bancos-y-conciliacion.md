# Bancos y conciliación

La conciliación bancaria es, después de la captura, el trabajo que más horas consume en un despacho. Esta página recorre la familia `bank` (alias `banco`) en el orden en que se trabaja un mes: dar de alta la chequera, cargar su estado de cuenta, cotejar, explicar la diferencia, cerrar la sesión, firmarla y contabilizar lo que descubrió.

Dos límites, dichos de entrada para que nadie los busque al final: **mnemosine no se conecta a ningún banco** —el estado de cuenta llega como archivo que tú descargas— y **nada de esta familia mueve el mayor salvo `bank reconciliation post`, `bank fee post`, `bank interest post` y `bank check reconcile`**, cada uno con su `--dry-run`.

Recuerda la convención: `mnemosine <algo>` se teclea como `npm run mnemosine -- <algo>`. Los ids de los ejemplos son de muestra: usa los que te devuelve cada comando.

---

## 1. Dar de alta la cuenta bancaria

La cuenta bancaria es un dato maestro atado 1:1 a una cuenta del catálogo. La CLABE se valida, dígito verificador incluido, antes de escribir nada.

```bash
mnemosine bank account create "BBVA Operativa MXN" --bank "BBVA Mexico" \
  --gl-account 1111 --currency MXN --clabe 012180001234567899
mnemosine bank account list
mnemosine bank account show "BBVA Operativa MXN"
```

`--currency` se compara contra la cuenta del catálogo y, si no coincide, se rechaza: nunca se convierte. Una tarjeta de crédito empresarial es un **pasivo** y va contra una cuenta de pasivo, con `--type credit-card`.

Cambiar la CLABE exige `--reason` y deja el antes y el después, enmascarados, en la bitácora:

```bash
mnemosine bank account edit "BBVA Operativa MXN" --clabe 012180001234567899 \
  --reason "Cambio de CLABE notificado por el banco el 2026-07-01"
```

Con la cuenta dada de alta, la bandera `--bank` de `payment create` y `receipt record` ya sirve, con el nombre de la cuenta o con su id (`bank account list -q` imprime los ids). El nombre exacto gana: con `BBVA` y `BBVA USD`, `--bank BBVA` es la primera; un fragmento sólo resuelve si nombra una sola cuenta, y la terminal imprime cuál eligió. Un nombre desconocido o ambiguo, una cuenta de otra entidad o una cuenta inactiva se rechazan sin escribir. Sin ella, el asiento sigue usando el rol `banco` de la entidad.

---

## 2. Cargar el estado de cuenta

```bash
mnemosine bank statement import ./extractos/bbva-2026-08.xml --account "BBVA Operativa MXN"
mnemosine bank statement check
```

El formato se detecta solo (CAMT.053, MT940, OFX y otros; `--format` lo fija). Volver a importar el mismo archivo no agrega nada: se deduplica por el hash del contenido. Un CSV no trae saldo final, así que se afirma con `--closing-balance`, y si el archivo sí lo trae y no coincide, la importación se niega: así se atrapa una descarga truncada.

```bash
mnemosine bank statement import ./extractos/santander-2026-08.csv --account "Santander Operativa MXN" \
  --format csv --profile santander-mx --closing-balance 184320.55
```

`bank statement check` corre siete verificaciones —la cadena de saldos entre extractos, entre ellas— y sale con código 4 nombrando la que se rompió.

---

## 3. El recorrido guiado del mes

Para el mes normal, un solo comando hace el recorrido: importa el extracto, corre el cotejo, abre la sesión y arma las partidas conciliatorias. **Siempre se detiene antes de firmar y de contabilizar**, e imprime lo que falta.

```bash
mnemosine bank reconciliation run "BBVA Operativa MXN" --period 2026-08 \
  --file ./extractos/bbva-2026-08.xml
mnemosine bank reconciliation status --account "BBVA Operativa MXN"
```

`--stop-at cotejo --dry-run` te deja mirar el cotejo antes de abrir nada, y `--resume` continúa la sesión ya abierta del periodo. `status` recalcula la variación **en vivo** y muestra los dos lados partida por partida.

La primera sesión de una cuenta migrada parte del saldo de apertura: `bank reconciliation open ... --baseline <saldo>` la abre y se niega, con la diferencia, si los libros no dicen lo mismo a esa fecha.

---

## 4. Cotejar lo que el banco dice con lo que dicen los libros

```bash
mnemosine bank transaction list --account "BBVA Operativa MXN" \
  --since 2026-08-01 --until 2026-08-31 --unmatched
mnemosine bank book-item list "BBVA Operativa MXN" --over-days 30
mnemosine bank match preview --account "BBVA Operativa MXN" \
  --since 2026-08-01 --until 2026-08-31 --min-confidence 0.9
mnemosine bank match run --account "BBVA Operativa MXN" \
  --since 2026-08-01 --until 2026-08-31 --min-confidence 0.9 --dry-run
```

`preview` enseña, señal por señal, qué propondría el motor y no aplica nada; `run` aplica sólo lo que pasa todas las compuertas. Una propuesta decidida sólo por parecido de descripción **nunca** se aplica sola, por alto que puntúe.

**Una transferencia que liquida varias facturas** se coteja a mano como un grupo, y el grupo se rechaza si el lado del banco, el de los libros y los ajustes no suman lo mismo:

```bash
mnemosine bank match create --account "BBVA Operativa MXN" \
  --transaction 4c8e21b7-0f53-4a19-9d62-71ea3c05b8d4 \
  --book-item invoice:2e6c94b1-7d05-4f83-a219-64bd8c30f7a5,invoice:3d91e7a5-24bf-4c68-9013-8ad5f6207e4c
```

Un cotejo equivocado se deshace con su motivo: `bank match unapply <match-id> --reason cotejo-erroneo`.

---

## 5. Explicar la diferencia

Lo que queda sin cotejar se convierte en **partidas conciliatorias**, con antigüedad, responsable y fecha esperada. El cierre se niega a firmar mientras una sola partida no tenga fecha esperada, y nada la inventa: ni el extracto ni el mayor saben cuándo se va a cobrar un cheque.

```bash
mnemosine bank reconciling-item list 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7
mnemosine bank reconciling-item assign 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 \
  3d91e7a5-24bf-4c68-9013-8ad5f6207e4c --owner "Tesoreria" --expected 2026-09-15
mnemosine bank reconciling-item correct 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 \
  3d91e7a5-24bf-4c68-9013-8ad5f6207e4c --type error-del-banco
```

La clasificación automática propone por **signo**, y el signo no distingue un cargo del banco de un **error** del banco; `correct` es donde se decide.

**Depósitos en tránsito y cheques en circulación no se contabilizan**: son diferencias de tiempo, no de registro. Viven como partidas conciliatorias, no en el mayor.

Las comisiones, los intereses y las retenciones que la conciliación descubre sí son registro. Hay dos caminos:

```bash
# Como ajustes de la sesión, que nacen BORRADOR y se contabilizan al final con la sesión.
mnemosine bank adjustment create 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 \
  --type comision --amount "-348.00" --gl-account 6310

# O como acto contable propio, una póliza por cargo, con su --dry-run primero.
mnemosine bank fee post "BBVA Operativa MXN" --period 2026-08 --iva-rate 0.16 --dry-run
mnemosine bank interest post "BBVA Operativa MXN" --period 2026-08 --rate 0.0125 --dry-run
```

Los ajustes de la sesión también aparecen en `mnemosine review`, junto con los demás borradores. Aprobar uno ahí está bien: lo contabiliza antes, y `bank reconciliation post` lo adopta en vez de duplicarlo. Rechazar uno ahí, en cambio, hace que `post` se niegue, porque la sesión se firmó contándolo: revisa la sesión —se reabre con `bank reconciliation reopen`— antes de volver a firmarla.

En `adjustment create` el importe lleva **signo** según su efecto en la cuenta: un cargo es negativo. En `fee post`, `--iva-rate` es el IVA que la comisión ya trae dentro y **no tiene valor por omisión**: 0 es una respuesta legítima, y hay que teclearla. En `interest post`, `--rate` es la tasa de **retención** del ISR, no la del interés: el interés se registra bruto y la retención como pago a favor de la entidad.

---

## 6. Cerrar, firmar y contabilizar

```bash
mnemosine bank reconciliation close 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --dry-run
mnemosine bank reconciliation close 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7
mnemosine bank reconciliation approve 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 \
  --reason "Revisada contra el estado de cuenta de agosto"
mnemosine bank reconciliation post 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --dry-run
mnemosine bank reconciliation post 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7
mnemosine bank reconciliation generate 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 \
  --json --output conciliacion-bbva-2026-08.json
```

- **`close`** recalcula toda la aritmética y pasa la sesión a `balanced` **sólo si de verdad cuadra**. Un residuo pequeño se absorbe con `--tolerance` únicamente donde la política de tolerancia lo admite, y la tolerancia queda guardada con la sesión.
- **`approve`** firma: quien aprueba **no puede ser** quien preparó, y la instantánea se congela con un hash de sus partidas y saldos.
- **`post`** contabiliza los ajustes que la firma congeló. Es la única hoja de la sesión que mueve el mayor.
- **`generate`** saca el documento de conciliación para el expediente, en texto o JSON. No hay PDF ni XLSX, y lo dice en vez de escribir un archivo que se haga pasar por uno.

Una sesión firmada se regresa a `in_progress` con `bank reconciliation reopen <sesión> --reason "..."`. La firma sale de la sesión, no de la bitácora. Si el periodo fiscal ya está cerrado, el rechazo te dice qué `period reopen` correr primero.

---

## Qué ve el cierre de mes

La partida `Bank reconciliations complete` del cierre cuenta las cuentas bancarias activas sin una sesión `balanced`, `approved` o `posted` que cubra el periodo. Como `balanced` ahora se gana con aritmética, la palomita significa lo que dice. Y con **cero** cuentas dadas de alta ya no sale en verde: dice «0 cuentas bancarias registradas: no se pudo comprobar».

La partida `Reconciliation variance frozen at zero` mira el dato que ese estado afirma: la variación congelada de la sesión. Una sesión `balanced` sin aritmética guardada **bloquea** el cierre; una variación congelada distinta de cero, que la política de tolerancia admitió, sólo avisa. Junto a ellas salen las partidas conciliatorias vencidas y las líneas del estado de cuenta sin explicar. Ver [[Manual-El-cierre-de-mes]].

El lado del mayor, para la hoja de trabajo, sigue saliendo del auxiliar:

```bash
mnemosine ledger auxiliary show --account 1111 --period 2026-08 \
  --format csv -o auxiliar-bancos-agosto.csv
```

El periodo de `ledger auxiliary` acepta `2026-08`, el uuid o un fragmento inequívoco del nombre (ver la tabla de las familias de `--period` en [[Manual-El-cierre-de-mes]]).

---

## Resumen

| Quiero… | Comando |
|---|---|
| Dar de alta una chequera | `bank account create` |
| Cargar el estado de cuenta | `bank statement import` · `bank statement check` |
| Hacer el mes de un jalón, sin firmar | `bank reconciliation run` |
| Ver qué está sin cotejar | `bank transaction list --unmatched` · `bank book-item list` |
| Cotejar | `bank match preview` · `bank match run` · `bank match create` |
| Explicar la diferencia | `bank reconciling-item list` · `assign` · `correct` |
| Registrar comisiones, intereses y retenciones | `bank adjustment create` · `bank fee post` · `bank interest post` |
| Cerrar, firmar y contabilizar | `bank reconciliation close` · `approve` · `post` |
| El documento para el expediente | `bank reconciliation generate` |
| Traer los movimientos del banco sin archivo | ❌ No hay conexión con ningún banco: se descarga el extracto |

---

## Ver también

- [[Manual-Cobrar-y-pagar]] — de dónde salen los movimientos de banco que después hay que conciliar.
- [[Manual-El-cierre-de-mes]] — la lista de verificación completa, y qué mira la partida de conciliación.
- [[Catalogo-de-comandos]] — la ayuda completa de cada hoja de `bank`, con sus ejemplos.
- [[Solucion-de-problemas]] — qué hacer cuando un comando falla sin explicar por qué.
