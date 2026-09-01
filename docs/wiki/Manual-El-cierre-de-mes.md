# El cierre de mes

Cerrar un mes es una sola pregunta hecha en voz alta: ¿está todo lo del periodo dentro de los libros, y cuadran? El comando responde esa pregunta primero y cierra después, en dos actos separados a propósito.

Recuerda la convención: `mnemosine <algo>` se teclea como `npm run mnemosine -- <algo>`.

---

## El recorrido, de un vistazo

```bash
mnemosine close --list                     # qué periodos se pueden cerrar
mnemosine close --check                    # la lista de verificación, sin cerrar
# ...resolver lo que aparezca...
mnemosine close --dry-run                  # el veredicto sin escribir
mnemosine close --reason "Cierre agosto"   # cierre suave, reversible por diseño
mnemosine close --hard --reason "..."      # sello definitivo, un paso aparte
```

El valor por omisión del periodo es siempre **el más viejo abierto**, nunca «el mes en curso». No es una preferencia: un periodo no se puede cerrar mientras uno anterior siga abierto, así que el más viejo es el único que de verdad estorba.

---

## Cómo se nombra el periodo

Hay una trampa aquí que cuesta diez minutos la primera vez. Los nombres de periodo se **guardan en inglés** —`August 2026`— porque se acuñan al crear el ejercicio y no se traducen al mostrarlos ([`fiscal-calendar-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/fiscal-calendar-service.ts), línea 505). Y `close --period` busca por **fragmento del nombre**, no por fecha:

```bash
mnemosine close --period August       # funciona
mnemosine close --period "August 2026" # funciona
mnemosine close --period 2026-08      # NO encuentra nada
mnemosine close --period agosto       # NO encuentra nada
```

Si no encuentra, el comando enumera los disponibles, así que la corrección es rápida. Pero ojo: es la única bandera `--period` que se comporta así. Las de los reportes (`report trial-balance show --period 2026-08`) son un selector de rango y sí aceptan `2026-08`, `2026-Q3`, `FY2026`, `last-month` y `2026-01..2026-06`. Y `period show` acepta las dos formas.

Para ver qué hay:

```bash
mnemosine close --list
```

```bash
mnemosine period list
```

---

## La lista de verificación: siete compuertas

```bash
mnemosine close --period August --check
```

`--check` nunca cierra. Imprime la lista con `✔` y `✘`, después lo que bloquea y lo que sólo avisa, y termina diciendo si el periodo está listo. Sale con **1** cuando no puede cerrar, para que un `cron` pueda actuar sobre eso.

La lista se evalúa **dentro de la misma transacción del cierre**, con el candado de la fila del periodo cruzado contra el que toma todo posteo. Antes se evaluaba fuera, y un posteo en vuelo podía confirmar entre la foto y el cierre: el periodo cerraba con una lista que no lo contaba. Es un detalle de implementación, pero es la razón por la que la lista que ves al cerrar es la lista que se guarda.

Siete partidas, en el orden en que salen ([`period-close.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/period-close.ts), líneas 36-183):

### 1. `All journal entries posted` — **BLOQUEA**

Cuenta las pólizas del periodo en `draft` o `pending_approval`. Es el bloqueador número uno de todo cierre, y casi siempre son borradores viejos que nadie revisó.

```bash
mnemosine ledger stale-draft list --days 7 --period August
```

```bash
mnemosine drafts -s pending_review
```

```bash
mnemosine review
```

`review` abre la cola de borradores de la IA uno por uno: `[a]` aprueba **y contabiliza** en un solo acto, `[r]` rechaza pidiendo el motivo, `[s]` salta, `[q]` sale. Cualquier otra tecla **salta en silencio**, así que un Enter de más pasa el borrador de largo sin decírtelo. La cola no se puede filtrar ni ordenar; si son cientos, conviene trabajarla en varias sesiones y volver a correr `stale-draft list` al final para ver qué quedó.

Si la póliza no es de la IA sino tuya:

```bash
mnemosine entry list -s draft --period 2026-08
```

```bash
mnemosine entry check --entry JE-2026-0455 --strict
```

```bash
mnemosine entry post JE-2026-0455
```

### 2. `Bank reconciliations complete` — avisa

Cuenta las cuentas bancarias activas sin sesión conciliada que cubra el periodo.

**Lee esta partida con desconfianza.** Hoy no existe comando ni ruta para dar de alta una cuenta bancaria, así que el conteo da cero, la palomita sale en verde, y no se comprobó absolutamente nada. Y aunque la cuenta existiera, la conciliación no se puede cerrar: el endpoint que lo hacía está retirado a propósito. El detalle completo, y qué hacer en su lugar, está en [[Manual-Bancos-y-conciliacion]].

### 3. `All invoices reviewed` — avisa

Facturas de cliente con fecha dentro del periodo y estado `draft`: capturadas y nunca contabilizadas. Su ingreso y su IVA no están en los libros.

```bash
mnemosine invoice list -s draft --period 2026-08
```

```bash
mnemosine invoice issue F-2026-0091
```

### 4. `Depreciation calculated and posted` — avisa

Activos fijos activos sin depreciación contabilizada del periodo.

Segunda partida que hay que leer con desconfianza, y por la misma razón que la segunda: **no existe un solo `INSERT INTO fixed_assets` en todo el código**, y el cálculo mensual de depreciación no tiene ni un llamador. Así que no hay activos que contar y la palomita sale en verde por vacuidad. Si el cliente tiene activo fijo, su depreciación se captura como póliza de ajuste, a mano, todos los meses:

```bash
mnemosine entry create \
  --date 2026-08-31 --type adjusting \
  --description "Depreciación de agosto" \
  --line "6200:debit:8333.33:Depreciación del ejercicio" \
  --line "1290:credit:8333.33:Depreciación acumulada"
```

El sistema es honesto sobre esto en el punto de decisión: cuando la IA pregunta si un desembolso se capitaliza, la opción dice literalmente que la depreciación *no* la calcula el sistema todavía. Vale la pena tenerlo presente al elegir.

### 5. `Trial balance balanced` — **BLOQUEA**

Suma cargos menos abonos sobre los saldos del periodo y exige que la diferencia no pase de un centavo.

Si descuadra, el primer sospechoso no es el mayor sino las vistas de reporte, que se refrescan por separado:

```bash
mnemosine report view show
```

Dice si cada vista sigue de acuerdo con el mayor y por cuánto difiere. Si no lo está:

```bash
mnemosine report view sync
```

Y si el descuadre es real, las verificaciones de integridad del mayor lo localizan:

```bash
mnemosine ledger check --period August
```

Corre las verificaciones bloqueantes (`balance`, `audit-trail`, `continuity`) y sale con **código 4** si encuentra algo. Ese 4 significa «encontré problemas», nunca «no pude mirar»: si la base no responde, sale 1, 2, 3 u 8, jamás 4. Es lo que permite meter la verificación en un `cron` sin que una caída de red se disfrace de balanza descuadrada.

### 6. `Parked payment receipts (REP) resolved` — avisa

REP que llegaron, no se pudieron ligar a un pago y quedaron aparcados esperando decisión.

```bash
mnemosine rep reconcile --dry-run
```

```bash
mnemosine rep reconcile
```

Es seguro repetirlo: los ya resueltos se saltan. Reintenta hasta cincuenta por corrida salvo que le des `-n`.

### 7. `Payments in period have their REP` — **bloquea o avisa, según el panel**

Ésta es la partida específicamente mexicana, y la que más fácil se olvida. Cuenta dos cosas distintas:

- **Pagos a proveedor sin REP** del proveedor. Su IVA sigue aparcado en la 1135 y **no es acreditable** este mes.
- **Cobros sin REP emitido por nosotros**. Es una **obligación fiscal propia, con plazo del SAT**.

```bash
mnemosine rep missing list --direction received
```

```bash
mnemosine rep missing list --direction issued
```

Los valores de esta bandera son ingleses (`received`, `issued`), a diferencia de los de `cfdi list --direction`, que son españoles.

Si bloquea o sólo avisa lo decide el despacho, con dos claves del panel de criterios. Las dos vienen en `avisar` por omisión:

```bash
mnemosine pending -v
```

```bash
mnemosine pending define rep_faltante_recibido bloquear -n "No cerramos con IVA aparcado"
```

| Clave | Qué decide |
|---|---|
| `rep_faltante_recibido` | Si un REP de proveedor que no llegó bloquea el cierre |
| `rep_faltante_emitido` | Si un REP nuestro sin emitir bloquea el cierre |

Sólo el literal `bloquear` bloquea. Cualquier otro valor avisa, incluido uno mal escrito: un valor raro del panel no puede congelarle el cierre a un despacho.

El razonamiento del valor por omisión, escrito en el propio catálogo, es defendible: un proveedor que se retrasa con su REP no debería congelarte el mes entero, y el IVA aparcado se ve en la lista de todas formas. Del lado emitido el argumento es distinto —la obligación es tuya— y la recomendación del catálogo es cambiarlo a `bloquear` el día que el timbrado de REP exista dentro del sistema y la obligación se pueda cumplir desde aquí. Hoy no existe.

---

## El barrido del IVA de los REP

Esto merece su propia sección porque es lo que separa un cierre mexicano de uno traducido, y porque el sistema no lo hace por ti.

La LIVA causa y acredita el impuesto **cuando el dinero se mueve**. En una factura PPD el IVA no se acredita al recibirla: se aparca. Del lado recibido, en el rol `iva_pendiente_acreditar` (la 1135 del catálogo sembrado); del lado emitido, en `iva_trasladado_no_cobrado` (la 2125). Sólo sale de ahí cuando el pago se registra, y sólo se sostiene ante una revisión cuando existe el REP que lo documenta.

**Antes de cerrar, el barrido es de tres pasos:**

**1. Reintentar los aparcados.** Un REP que quedó en revisión suele desbloquearse solo cuando la factura o el pago que le faltaba ya se capturó.

```bash
mnemosine rep reconcile
```

**2. Listar lo que sigue sin comprobante, de los dos lados.**

```bash
mnemosine rep missing list --direction received --min-amount 1000
```

```bash
mnemosine rep missing list --direction issued
```

**3. Comprobar el saldo de las dos cuentas de aparcado contra esa lista.**

```bash
mnemosine ledger balance show --account 1135 --as-of 2026-08-31
```

```bash
mnemosine ledger balance show --account 2125 --as-of 2026-08-31
```

```bash
mnemosine ledger auxiliary show --account 1135 --period August \
  --format csv -o iva-pendiente-agosto.csv
```

El saldo de la 1135 al cierre **es** el IVA que no vas a acreditar este mes. Si no coincide con lo que la lista de faltantes dice, hay algo mal capturado, y conviene encontrarlo antes de firmar la declaración, no después.

Dos causas frecuentes de descuadre, las dos con remedio:

- Una factura que era PUE se capturó sin decirlo, y el valor conservador del lado recibido es PPD, así que su IVA se aparcó de más. Se corrige solo al registrar el pago, un mes tarde. Para prevenirlo, escribe el literal `PUE` dentro de `--terms` al capturar (ver [[Manual-Cobrar-y-pagar]]).
- La entidad no tiene sembrada la capa de roles semánticos. En ese caso el motor se detiene con un mensaje explícito en vez de liberar cero en silencio, y el remedio es `mnemosine account role seed`.

Cuando el asiento tomó una suposición, la lleva escrita: busca `· MetodoPago missing: PPD assumed` en la descripción de la póliza con `entry show`.

---

## El cierre suave

Cuando la lista está en verde:

```bash
mnemosine close --period August --dry-run
```

```bash
mnemosine close --period August --reason "Cierre mensual de agosto"
```

El periodo pasa a `soft_close`. El `--reason` no es decorativo: queda en la bitácora de auditoría junto con quién cerró y cuándo, dentro de la misma transacción del cierre. Antes esa transacción y el renglón de auditoría eran dos operaciones distintas, y si la segunda fallaba el periodo quedaba cerrado sin constancia de quién lo cerró.

**La compuerta de confirmación de `close` tiene una trampa que hay que conocer.** Pregunta `Proceed with soft close (reversible)? [y/N]` y acepta como «sí» **cualquier respuesta que empiece con `y` o con `s`** ([`close-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/close-command.ts), línea 179). Eso incluye `s`, `si` y `sí` —que es lo que quieres— pero también incluye `salir`, `stop` y `sale`. Y `salir` es, en este mismo binario, el alias en español de `logout`.

**Responde `y` para seguir y `n` para cancelar. Nada más.** Si te arrepientes a media pregunta, escribe `n`, no `salir`.

Sin terminal el comando no asume tu consentimiento: se niega y te dice que vuelvas a correrlo con `--yes` o con `--dry-run`. Un guion desatendido tiene que llevar `--yes` explícito.

---

## El cierre duro

```bash
mnemosine close --period August --hard --reason "Cierre definitivo de agosto"
```

Es un segundo acto deliberado, y exige que el periodo ya esté en `soft_close`. Hace tres cosas:

1. **Si es el último periodo del ejercicio**, genera los asientos de cierre: barre ingresos y gastos contra la 3900 «Resumen de Ingresos y Gastos» y traspasa el resultado a la 3200 «Resultado de Ejercicios Anteriores».
2. **Arrastra los saldos de balance** al periodo siguiente, después de los asientos de cierre para que el arrastre de fin de año ya refleje el resultado traspasado.
3. Sella el periodo y deja su rastro en la bitácora, en la misma transacción.

Dos advertencias sobre el cierre anual:

**El resultado va a la 3200, no a la 3300.** La cuenta se resuelve por **código** y tiene que estar marcada como cuenta de sistema. Se eligió 3200 y no 3100 a propósito: la 3100 es Capital Social, y barrer ahí el resultado del ejercicio distorsiona el capital y contraviene NIF C-11, que sólo mueve el capital social por actos corporativos formales. Difiere de la práctica de dejar el resultado del ejercicio en una 3300 durante el año siguiente; si tu despacho lo hace así, el traspaso a 3300 es una póliza manual.

**Si faltan la 3900 o la 3200, los asientos de cierre se saltan en silencio.** El código devuelve una lista vacía y el cierre reporta éxito ([`period-close.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/period-close.ts), líneas 437-441). Con el catálogo sembrado por el sistema las dos existen y están marcadas; con un catálogo importado del sistema anterior, puede que no. **Compruébalo antes de cerrar diciembre en duro:**

```bash
mnemosine account list --type equity
```

Si no están, o no están marcadas como cuentas de sistema, el cierre de diciembre va a terminar bien sin haber traspasado nada, y el balance de enero va a arrastrar ingresos y gastos del año anterior.

---

## Qué se puede reabrir y qué no

Aquí hay que ser directo, porque el mensaje del propio comando promete algo que no está.

Al terminar un cierre suave, el sistema imprime:

```
  Soft close is reversible. To seal it: mnemosine close --hard
```

Es cierto como afirmación de diseño y **falso como instrucción operativa**: no existe ningún comando que reabra un periodo. La función está escrita, probada y con sus tres cerrojos —no reabre un periodo `locked`, exige motivo, y devuelve el estado anterior— pero su único invocador es un guion interno de recálculo de IVA. No hay `period reopen`, no hay ruta REST, y el propio catálogo de permisos lo declara así.

| Estado | ¿Se reabre? |
|---|---|
| `open` | No aplica |
| `soft_close` | Reversible por diseño — **pero no hay comando** |
| `hard_close` | Reversible por diseño — **pero no hay comando** |
| `locked` | **Nunca.** Su información ya salió del sistema |

**Consecuencia práctica.** Una corrección que pertenece a un mes cerrado no se puede registrar en ese mes. Se registra en el periodo abierto más próximo, con una descripción que diga a qué mes corresponde, y se anota en el papel de trabajo:

```bash
mnemosine entry create \
  --date 2026-10-05 --type correction \
  --description "Corrección de IVA acreditable de marzo 2026 (periodo cerrado)" \
  --reference "Ajuste marzo" \
  --line "..."
```

Es lo que el propio mensaje de la función dice cuando el periodo está `locked`: *«La corrección va en el periodo abierto más próximo.»* Hoy vale también para `soft_close` y `hard_close`, no por regla contable sino porque falta el cable.

Cierra en suave con confianza; piénsatelo dos veces antes del duro.

---

## Los reportes que se sacan al cerrar

Cinco de los siete estados que un despacho entrega. Todos aceptan `--format csv|md|json` y `-o <archivo>`, y el archivo se escribe de verdad.

```bash
mnemosine report trial-balance show --period 2026-08 --level 4 --exclude-zero \
  --format csv -o balanza-2026-08.csv
```

```bash
mnemosine report balance-sheet show --as-of 2026-08-31 -o balance.md --format md
```

```bash
mnemosine report income-statement show --period 2026-08 -o resultados.md --format md
```

```bash
mnemosine report general-ledger show --account 1120 --period 2026-08
```

```bash
mnemosine report aged-receivable show --as-of 2026-08-31
```

```bash
mnemosine report aged-payable show --as-of 2026-08-31
```

Y el respaldo de pólizas, con sus renglones y sin tope de página:

```bash
mnemosine entry export --period 2026-08 --format csv -o polizas-2026-08.csv
```

Más el auxiliar por cuenta, que es la forma que pide el auxiliar XC del SAT:

```bash
mnemosine ledger auxiliary show --account 1120 --period August \
  --format csv -o auxiliar-clientes-agosto.csv
```

Dos notas de lectura. En la balanza, la fila de totales sale por el flujo de diagnóstico y **no entra al CSV**, a propósito: una fila TOTAL extraviada dentro de un archivo que alguien importa a Excel es una mina. Y los totales se calculan sobre **todas** las cuentas antes de paginar, así que un `--limit` cambia lo que ves pero nunca lo que la balanza dice.

### Lo que no se genera

| Entregable | Estado | Sustituto |
|---|---|---|
| XML de contabilidad electrónica (Anexo 24) | ❌ No existe el generador | Exportar la balanza a CSV y armarlo fuera |
| DIOT | ❌ No existe | `vendor list --no-tax-id` para desbloquear los RFC faltantes; el armado, fuera |
| Estado de flujos de efectivo (NIF B-2) | ❌ No existe | Fuera del sistema |
| Estado de variaciones en el capital contable (NIF B-4) | ❌ No existe | Fuera del sistema |
| Comparativo contra el mes o el ejercicio anterior | ❌ No hay columna de variación | Correr el reporte dos veces y comparar |

La materia prima del Anexo 24 sí está —el agrupador del SAT por cuenta, la compuerta de cobertura y el auxiliar con la forma XC—, pero el armado del XML sigue pendiente. La compuerta previa se corre así, y sale con código 4 si quedan cuentas sin mapear:

```bash
mnemosine account map check --scheme sat-agrupador --level 3 --strict
```

---

## Una lista para pegar en la pared

```bash
mnemosine entity use <RFC>
mnemosine close --list
mnemosine close --period August --check

# 1 · pólizas sin contabilizar (BLOQUEA)
mnemosine ledger stale-draft list --days 7 --period August
mnemosine drafts -s pending_review
mnemosine review
mnemosine entry list -s draft --period 2026-08

# 3 · facturas de cliente en borrador
mnemosine invoice list -s draft --period 2026-08

# 6 y 7 · el barrido del IVA de los REP
mnemosine rep reconcile
mnemosine rep missing list --direction received
mnemosine rep missing list --direction issued
mnemosine ledger balance show --account 1135 --as-of 2026-08-31
mnemosine ledger balance show --account 2125 --as-of 2026-08-31

# 5 · la balanza cuadra (BLOQUEA)
mnemosine report view show
mnemosine report view sync
mnemosine ledger check --period August

# 2 · la conciliación, fuera del sistema; dejar los papeles en el expediente

# cerrar
mnemosine close --period August --dry-run
mnemosine close --period August --reason "Cierre mensual de agosto"

# reportes
mnemosine report trial-balance show --period 2026-08 --format csv -o balanza-2026-08.csv
mnemosine report income-statement show --period 2026-08 --format md -o resultados-2026-08.md
mnemosine entry export --period 2026-08 --format csv -o polizas-2026-08.csv
```

---

## Ver también

- [[Manual-Cobrar-y-pagar]] — de dónde salen las pólizas, las facturas y los REP que el cierre revisa.
- [[Manual-Bancos-y-conciliacion]] — por qué la partida de conciliación sale en verde sin haber comprobado nada.
- [[El-tablero-y-los-criterios]] — el panel de decisiones donde viven `rep_faltante_recibido` y `rep_faltante_emitido`.
- [[Fiscal-mexicano]] — la base de flujo del IVA, las cuentas de control y los límites del timbrado.
- [[Solucion-de-problemas]] — qué hacer cuando un comando falla con un error de Postgres en crudo.
