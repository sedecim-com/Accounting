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

Los nombres de periodo se **guardan en inglés** —`August 2026`— porque se acuñan al crear el ejercicio y no se traducen al mostrarlos ([`fiscal-calendar-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/fiscal-calendar-service.ts)). Por eso lo más seguro es nombrar el mes por su fecha: `close --period` acepta `2026-08`, el uuid del periodo o un fragmento **inequívoco** del nombre, igual que `period show` (#327):

```bash
mnemosine close --period 2026-08      # funciona, y es la forma recomendada
mnemosine close --period "August 2026" # funciona
mnemosine close --period August       # funciona si sólo un periodo se llama así
mnemosine close --period agosto       # NO encuentra nada: el nombre está en inglés
```

Si no encuentra, el comando enumera los que se pueden cerrar. Si el mes existe pero ya está cerrado en duro o bloqueado, lo dice por su estado en vez de contestar «no encontrado». Y si fijaste una entidad con `entity use`, `close` y `closing` la respetan: `-e` gana, luego `MNEMOSINE_ENTITY`, luego la entidad fijada. No todos los comandos lo hacen todavía (`drafts` y `review`, por ejemplo, aún no leen la entidad fijada): en una firma con varias entidades, pásales `-e`. Las banderas `--period` caen en dos familias:

| Familia | Banderas | Qué acepta |
|---|---|---|
| **Resuelto contra el calendario** | `close` · `closing preview/check/explain/run` · `ledger auxiliary show` · `ledger check` · `ledger stale-draft list` · `ledger balance show` · `account balance show` · `entry list` · `entry export` · `invoice list` · `period show` | `2026-08`, el nombre, un fragmento inequívoco, o el uuid. Un periodo que no existe **lanza** en vez de contestar sobre la nada. |
| **Selector de rango (reportes)** | `report trial-balance show` y los demás `report`, `bill list` | `2026-08`, `2026-Q3`, `FY2026`, `2026`, y rangos `2026-01..2026-06`. |

Dos advertencias sobre esa tabla, las dos comprobadas corriendo:

- **`last-month` no funciona en ninguna parte**, aunque la ayuda de la propia bandera lo anuncie (`flags.ts:131`). No hay código que lo resuelva: `report trial-balance show --period last-month` sale con 4 y `No period matches "last-month"`. Usa `2026-08` o un rango.
- **`cfdi list --period` no filtra nada.** El comando declara la bandera pero su acción nunca la lee (`cfdi-command.ts:103-111`, la llamada a `listCfdis` no recibe `period`): un CFDI de agosto sale igual con `--period 2026-01` y con `--period no-existe-este-periodo`. Ahí el mes se acota con `--since` y `--until`, que sí funcionan.

Para ver qué hay:

```bash
mnemosine close --list
```

```bash
mnemosine period list
```

---

## La lista de verificación

```bash
mnemosine close --period 2026-08 --check
```

`--check` nunca cierra. Imprime la lista con `✔` y `✘`, después lo que bloquea y lo que sólo avisa, y termina diciendo si el periodo está listo. Sale con **1** cuando no puede cerrar, para que un `cron` pueda actuar sobre eso.

La lista se evalúa **dentro de la misma transacción del cierre**, con el candado de la fila del periodo cruzado contra el que toma todo posteo. Antes se evaluaba fuera, y un posteo en vuelo podía confirmar entre la foto y el cierre: el periodo cerraba con una lista que no lo contaba. Es un detalle de implementación, pero es la razón por la que la lista que ves al cerrar es la lista que se guarda.

Abajo van las partidas que todo mes encuentra, en el orden en que salen ([`period-close.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/period-close.ts)). La lista que arma el código tiene más —que el periodo anterior esté cerrado, la variación congelada de la conciliación, las partidas conciliatorias vencidas, las líneas del banco sin explicar, la amortización de pagos anticipados, la integridad del mayor, el agrupador del SAT y los auxiliares de CxC y CxP contra su cuenta de control—, y cada una sale en `close --check` con su nombre, su severidad y su remedio:

### 1. `All journal entries posted` — **BLOQUEA**

Cuenta las pólizas del periodo en `draft` o `pending_approval`. Es el bloqueador número uno de todo cierre, y casi siempre son borradores viejos que nadie revisó.

```bash
mnemosine ledger stale-draft list --days 7 --period 2026-08
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

Cuenta las cuentas bancarias activas sin una sesión `balanced`, `approved` o `posted` que cubra el periodo completo.

**Con cero cuentas bancarias dadas de alta la partida no sale en verde**: dice «0 cuentas bancarias registradas: no se pudo comprobar». Nada que revisar no es lo mismo que revisado y bien. Las cuentas se dan de alta con `bank account create` y la sesión del mes se cierra con `bank reconciliation close`, que sólo la pasa a `balanced` si la aritmética de verdad cuadra. El recorrido completo está en [[Manual-Bancos-y-conciliacion]].

```bash
mnemosine bank reconciliation list --status in_progress
```

### 3. `All invoices reviewed` — avisa

Facturas de cliente con fecha dentro del periodo y estado `draft`: capturadas y nunca contabilizadas. Su ingreso y su IVA no están en los libros.

```bash
mnemosine invoice list -s draft --period 2026-08
```

```bash
mnemosine invoice issue F-2026-0091
```

### 4. `Depreciation calculated and posted` — **bloquea o avisa, según el panel**

Activos fijos activos sin depreciación contabilizada del periodo.

Con el registro vacío la partida tampoco sale en verde: dice «0 activos fijos registrados: no se pudo comprobar», y si las cuentas de activo fijo sí traen saldo te pide registrarlos con `asset create`. Con activos registrados, la depreciación del mes se calcula, se mira y después se contabiliza, una póliza por activo:

```bash
mnemosine asset create "Camioneta Nissan NP300 2026" --category "Equipo de Transporte" \
  --cost 489000.00 --acquired 2026-07-08 --capitalized yes --dry-run
mnemosine depreciation run --period 2026-08
mnemosine depreciation post --period 2026-08 --dry-run
mnemosine depreciation post --period 2026-08
```

`--capitalized yes` dice que el costo **ya** está cargado en la cuenta de activo —porque el CFDI se capitalizó al ingerirlo— y entonces `asset create` no escribe póliza: una segunda duplicaría el activo. Si `asset create` te dice que la entidad no tiene clases de activo, siémbralas una vez con `asset category seed`. La severidad de esta partida la fija la política `depreciacion_faltante_al_cierre`.

Un aviso que todavía no se entera: cuando la ingesta capitaliza un CFDI como activo fijo, el aviso que viaja con el documento dice que el sistema no registra el activo ni calcula su depreciación. La segunda mitad ya no es cierta —el camino es `asset create` y `depreciation post`, arriba—; la primera sí: la ingesta no da de alta el activo en el registro, eso lo haces tú.

### 5. `Trial balance balanced` — **BLOQUEA**

Hace dos preguntas. La primera suma cargos menos abonos sobre los saldos del periodo y exige que la diferencia no pase de un centavo; como cada póliza cuadra antes de postearse, sólo falla si alguien escribió esa tabla por fuera del sistema.

La segunda es la que muerde: que el **saldo inicial** de cada cuenta de balance sea el que da el mayor, es decir, la suma de todo lo posteado en los periodos anteriores. Se pregunta cuando el periodo anterior está cerrado en duro, que es cuando el arrastre ya puso una cifra. Si reabriste un mes, lo corregiste y lo volviste a cerrar sólo en suave, el arrastre no llegó a los meses siguientes y éstos abren con la cifra vieja: la casilla sale ✘ con la cuenta, lo arrastrado y lo que dice el mayor, y `mnemosine closing explain trial-balance` las lista todas. El remedio es sellar el mes corregido, `mnemosine close --period "<mes>" --hard`: su arrastre baja en cascada.

Si la suma descuadra, el primer sospechoso no es el mayor sino las vistas de reporte, que se refrescan por separado:

```bash
mnemosine report view show
```

Dice si cada vista sigue de acuerdo con el mayor y por cuánto difiere. Si no lo está:

```bash
mnemosine report view sync
```

Y si el descuadre es real, las verificaciones de integridad del mayor lo localizan:

```bash
mnemosine ledger check --period 2026-08
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

- **Pagos a proveedor sin REP** del proveedor. Al registrarse, el pago ya pasó el IVA de esa factura de la 1135 a la 1130: el acreditamiento está en libros. Lo que falta es el REP, el comprobante que lo respalda (LIVA art. 5 fr. III, CFF art. 29, RMF 2.7.1.35).
- **Cobros sin REP emitido por nosotros**. Es una **obligación fiscal propia, con plazo del SAT**.

**Qué pagos cuenta la casilla.** Sólo los del periodo que de verdad esperan un REP, leídos con la misma regla con la que el mayor decidió el método de pago:

- el pago está `completed` (uno revertido o anulado no cuenta) y no tiene REP ligado;
- está **aplicado** a un documento, con una aplicación viva (un pago sin aplicar es un anticipo, y una aplicación deshecha con `payment unapply` ya no liquida nada);
- ese documento es **PPD** para el mayor. Un gasto sin método dicho es PPD (el valor conservador del lado recibido), así que cuenta;
- del lado emitido, además, la factura está **timbrada** (`cfdi_status = stamped`): una sin timbrar, un timbrado simulado o un CFDI cancelado no tienen CFDI vivo al que relacionar un REP.

**Qué no cuenta**: los documentos PUE, de los dos lados. Y un cobro de factura timbrada cuyo método de pago no está en el espejo ni en `--terms`: el mayor la trató como PUE y causó su IVA al emitirla, así que la casilla no afirma un REP que el mayor no cree deber. No se esconde: el cierre lo avisa aparte («sin método de pago conocido») y `rep missing list --direction issued` lo lista marcado `desconocido`. Las entidades que no llevan libros mexicanos no esperan REP.

Para ver exactamente los pagos que la casilla contó:

```bash
mnemosine closing explain rep-missing --period "August 2026"
```

```bash
mnemosine rep missing list --direction received
```

```bash
mnemosine rep missing list --direction issued
```

Los valores de esta bandera son ingleses (`received`, `issued`), a diferencia de los de `cfdi list --direction`, que son españoles. `rep missing list` no se limita al periodo: lista todo lo pendiente de la entidad, con la misma regla que la casilla.

Si bloquea o sólo avisa lo decide el despacho, con dos claves del panel de criterios. Las dos vienen en `avisar` por omisión:

```bash
mnemosine pending -v
```

```bash
mnemosine pending define rep_faltante_recibido bloquear -n "No cerramos con IVA acreditado sin su REP"
```

| Clave | Qué decide |
|---|---|
| `rep_faltante_recibido` | Si un REP de proveedor que no llegó bloquea el cierre, sólo avisa, o no se vigila en el cierre (`no_vigilar`) |
| `rep_faltante_emitido` | Si un REP nuestro sin emitir bloquea el cierre |

Sólo el literal `bloquear` bloquea. Cualquier otro valor avisa, incluido uno mal escrito: un valor raro del panel no puede congelarle el cierre a un despacho.

El razonamiento del valor por omisión, escrito en el propio catálogo, es defendible: un proveedor que se retrasa con su REP no debería congelarte el mes entero, pero un acreditamiento sin su comprobante es una exposición ante una revisión, así que el cierre lo deja a la vista. Con `no_vigilar` el lado del proveedor sale del cierre y sólo `rep missing list` lo muestra. Del lado emitido el argumento es distinto —la obligación es tuya— y la recomendación del catálogo es cambiarlo a `bloquear` el día que el timbrado de REP exista dentro del sistema y la obligación se pueda cumplir desde aquí. Hoy no existe.

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

**3. Comprobar el saldo de las dos cuentas de aparcado.** Ojo: no se cuadran contra la lista de faltantes. Un pago ya registrado liberó su IVA aunque le falte el REP; lo que queda en la 1135 y la 2125 es el IVA de las facturas PPD **todavía sin pagar o sin cobrar**.

```bash
mnemosine ledger balance show --account 1135 --as-of 2026-08-31
```

```bash
mnemosine ledger balance show --account 2125 --as-of 2026-08-31
```

```bash
mnemosine ledger auxiliary show --account 1135 --period 2026-08 \
  --format csv -o iva-pendiente-agosto.csv
```

El saldo de la 1135 al cierre **es** el IVA que no vas a acreditar este mes: el de los gastos PPD que aún no pagas. Si no coincide con el IVA de esas facturas pendientes de pago, hay algo mal capturado, y conviene encontrarlo antes de firmar la declaración, no después.

Dos causas frecuentes de descuadre, las dos con remedio:

- Una factura que era PUE se capturó sin decirlo, y el valor conservador del lado recibido es PPD, así que su IVA se aparcó de más. Se corrige solo al registrar el pago, un mes tarde. Para prevenirlo, escribe el literal `PUE` dentro de `--terms` al capturar (ver [[Manual-Cobrar-y-pagar]]).
- La entidad no tiene sembrada la capa de roles semánticos. En ese caso el motor se detiene con un mensaje explícito en vez de liberar cero en silencio, y el remedio es `mnemosine account role seed`.

Cuando el asiento tomó una suposición, la lleva escrita: busca `· MetodoPago missing: PPD assumed` en la descripción de la póliza con `entry show`.

---

## El cierre suave

Cuando la lista está en verde:

```bash
mnemosine close --period 2026-08 --dry-run
```

```bash
mnemosine close --period 2026-08 --reason "Cierre mensual de agosto"
```

El periodo pasa a `soft_close`. El `--reason` no es decorativo: queda en la bitácora de auditoría junto con quién cerró y cuándo, dentro de la misma transacción del cierre. Antes esa transacción y el renglón de auditoría eran dos operaciones distintas, y si la segunda fallaba el periodo quedaba cerrado sin constancia de quién lo cerró.

**La compuerta de confirmación de `close` tiene una trampa que hay que conocer.** Pregunta `Proceed with soft close (reversible)? [y/N]` y acepta como «sí» **cualquier respuesta que empiece con `y` o con `s`** ([`close-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/close-command.ts), línea 179). Eso incluye `s`, `si` y `sí` —que es lo que quieres— pero también incluye `salir`, `stop` y `sale`. Y `salir` es, en este mismo binario, el alias en español de `logout`.

**Responde `y` para seguir y `n` para cancelar. Nada más.** Si te arrepientes a media pregunta, escribe `n`, no `salir`.

Sin terminal el comando no asume tu consentimiento: se niega y te dice que vuelvas a correrlo con `--yes` o con `--dry-run`. Un guion desatendido tiene que llevar `--yes` explícito.

---

## El cierre duro

```bash
mnemosine close --period 2026-08 --hard --reason "Cierre definitivo de agosto"
```

Es un segundo acto deliberado, y exige que el periodo ya esté en `soft_close`. Hace tres cosas:

1. **Si es el último periodo del ejercicio**, genera los asientos de cierre: barre ingresos y gastos contra la 3900 «Resumen de Ingresos y Gastos» y traspasa el resultado a la cuenta que fija la política `destino_del_resultado_del_ejercicio`.
2. **Arrastra los saldos de balance** al periodo siguiente, después de los asientos de cierre para que el arrastre de fin de año ya refleje el resultado traspasado.
3. Sella el periodo y deja su rastro en la bitácora, en la misma transacción.

**El último periodo del ejercicio es el 13, no diciembre.** Cada ejercicio trae un periodo de ajustes de cierre («Year-end adjustments 2026», el periodo 13) que empieza el 31 de diciembre. Cerrar diciembre en duro no genera los asientos de cierre; cerrar el 13 sí. Como los dos empiezan en diciembre, `close --period 2026-12` **se niega** y enumera ambos con su id: nombra el que quieres por su nombre completo o su id.

```bash
mnemosine close --period "Year-end adjustments 2026" --hard --reason "Cierre anual 2026" --dry-run
```

Dos advertencias sobre el cierre anual:

**A dónde va el resultado lo decide el panel.** Por omisión, a la 3300 «Resultado del Ejercicio», y una reclasificación posterior, cuando la asamblea lo aprueba, lo lleva a la 3200 «Resultado de Ejercicios Anteriores»; la otra opción de `destino_del_resultado_del_ejercicio` lo manda directo a la 3200. Si la política pide 3300 y el catálogo no la tiene, se usa la 3200 y el cierre lo dice. La cuenta se resuelve por **código** y tiene que estar marcada como cuenta de sistema. Nunca a la 3100: es Capital Social, y NIF C-11 sólo lo mueve por actos corporativos formales.

**Si faltan la 3900 o la 3200, el barrido no se puede hacer, y el cierre lo dice.** Sin cuentas puente no se emite ningún asiento de cierre, y entonces se comprueba si alguna cuenta de resultados conserva saldo. Si la hay, por omisión el cierre duro se revierte entero, el periodo sigue abierto y el error nombra cada cuenta con su saldo; la política `severidad_resultado_sin_barrer` puede bajarlo a un aviso. Con el catálogo sembrado por el sistema las dos existen y están marcadas; con un catálogo importado del sistema anterior, puede que no. **Compruébalo antes del cierre anual en duro:**

```bash
mnemosine account list --type equity
```

Si no están, o no están marcadas como cuentas de sistema, dales de alta o márcalas antes de cerrar: el cierre duro del periodo 13 se va a detener hasta que el resultado se pueda barrer. Si el panel lo dejó en aviso, el cierre termina y el balance de enero arrastra ingresos y gastos del año anterior.

---

## Qué se puede reabrir y qué no

Al terminar un cierre suave, el sistema imprime:

```
  Soft close is reversible. To seal it: mnemosine close --hard
```

Y es cierto: `period reopen` reabre un periodo cerrado para que la corrección caiga en el mes al que pertenece. Exige `--reason`, y la bitácora guarda quién, por qué y el estado anterior. Mira primero la transición con `--dry-run`, que no escribe ni registra nada:

```bash
mnemosine period reopen 2026-07 --dry-run
mnemosine period reopen "July 2026" --reason "Llegó un CFDI de CFE con fecha de julio"
```

| Estado | ¿Se reabre? |
|---|---|
| `open` | No aplica |
| `soft_close` | Sí, con `period reopen --reason` |
| `hard_close` | Sí, con `--force` además de `--reason`. Después de corregir hay que volver a cerrarlo en suave y en duro, como te lo imprime el propio comando |
| `locked` | **Nunca**, ni con `--force`. Su información ya salió del sistema |

```bash
mnemosine period reopen "December 2026" --force --reason "Ajuste pedido por el auditor externo"
```

**Después de reabrir un periodo en duro, no basta con el cierre suave.** El arrastre de saldos que hizo el cierre duro sigue con las cifras de antes: si el periodo se queda en `soft_close`, todos los meses siguientes abren con el saldo viejo, y la comprobación de la cadena no lo ve porque sólo lee cierres duros. Corrige, y luego:

```bash
mnemosine close --period "December 2026"
mnemosine close --period "December 2026" --hard
```

Y regenera todo lo que salió de ese periodo antes de reabrirlo: estados financieros, balanza, XML del Anexo 24 y DIOT.

**Cuando el periodo está `locked`.** La corrección que pertenece a ese mes no se puede registrar en él. Se registra en el periodo abierto más próximo, con una descripción que diga a qué mes corresponde, y se anota en el papel de trabajo:

```bash
mnemosine entry create \
  --date 2026-10-05 --type correction \
  --description "Corrección de IVA acreditable de marzo 2026 (periodo cerrado)" \
  --reference "Ajuste marzo" \
  --line "..."
```

Es lo que el propio mensaje de la función dice cuando el periodo está `locked`: *«La corrección va en el periodo abierto más próximo.»*

Cierra en suave con confianza; piénsatelo dos veces antes del duro, y mucho más antes de bloquear.

---

## Los reportes que se sacan al cerrar

Los de la familia `report`; el flujo de efectivo sale de `cashflow`, más abajo. Todos aceptan `--format csv|md|json` y `-o <archivo>`, y el archivo se escribe de verdad.

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
mnemosine ledger auxiliary show --account 1120 --period 2026-08 \
  --format csv -o auxiliar-clientes-agosto.csv
```

Dos notas de lectura. En la balanza, la fila de totales sale por el flujo de diagnóstico y **no entra al CSV**, a propósito: una fila TOTAL extraviada dentro de un archivo que alguien importa a Excel es una mina. Y los totales se calculan sobre **todas** las cuentas antes de paginar, así que un `--limit` cambia lo que ves pero nunca lo que la balanza dice.

### Los entregables del SAT y el flujo de efectivo

Se generan desde aquí, y ninguno se sella ni se presenta desde aquí: sellar con la e.firma y enviar por el Buzón Tributario o capturar en el portal son actos tuyos, fuera del sistema.

```bash
mnemosine e-accounting catalog generate --period 2026-08 --dry-run
mnemosine e-accounting balance check --period 2026-08
mnemosine e-accounting balance generate --period 2026-08 --dry-run
mnemosine diot generate --period 2026-08
mnemosine diot check --period 2026-08 --strict
mnemosine diot export --period 2026-08 -o diot-2026-08.txt
mnemosine cashflow generate --period 2026-08
mnemosine cashflow reconcile --period 2026-08
```

- **Anexo 24.** `e-accounting` arma el catálogo (CtaCatalogo 1.3) y la balanza (BCE 1.3, normal, complementaria con `--type C --modified <fecha>`, o de cierre con `--closing`). Las pólizas y los auxiliares en XML no se generan.
- **DIOT.** `diot export` saca hoy el papel de trabajo por tercero; `--layout sat` se niega en vez de inventar el formato de carga masiva. `vendor list --no-tax-id` sigue siendo la lista de proveedores que la bloquean.
- **Flujos de efectivo (NIF B-2).** `cashflow generate` usa el método de la política `flujo_efectivo_metodo` salvo que pases `--method`, y `cashflow reconcile` imprime el residuo contra el efectivo real en vez de absorberlo.

### Lo que no se genera

| Entregable | Estado | Sustituto |
|---|---|---|
| Pólizas y auxiliares del Anexo 24 en XML | ❌ No existe el generador | Exportar pólizas y auxiliar a CSV y armarlos fuera |
| Estado de variaciones en el capital contable (NIF B-4) | ❌ No existe | Fuera del sistema |
| Comparativo contra el mes o el ejercicio anterior | ❌ No hay columna de variación | Correr el reporte dos veces y comparar |

Antes del catálogo XML va la compuerta de cobertura del agrupador, que sale con código 4 si quedan cuentas sin mapear:

```bash
mnemosine account map check --scheme sat-agrupador --strict
```

---

## Una lista para pegar en la pared

```bash
mnemosine entity use <RFC>
mnemosine close --list
mnemosine close --period 2026-08 --check

# 1 · pólizas sin contabilizar (BLOQUEA)
mnemosine ledger stale-draft list --days 7 --period 2026-08
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
mnemosine ledger check --period 2026-08

# 2 · la conciliación, fuera del sistema; dejar los papeles en el expediente

# cerrar
mnemosine close --period 2026-08 --dry-run
mnemosine close --period 2026-08 --reason "Cierre mensual de agosto"

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
