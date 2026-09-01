# Bancos y conciliación

Esta es la página más corta del manual, y no porque el tema sea menor. La conciliación bancaria es, después de la captura, el trabajo que más horas consume en un despacho. Lo que sigue explica exactamente hasta dónde llega mnemosine hoy, dónde se acaba, y qué se hace con lo que queda fuera.

La conclusión, dicha de una vez para que nadie la busque al final: **la conciliación bancaria no se puede hacer desde la terminal, y la parte que sí existe no puede cerrarse.** El resto de la página es el detalle y el sustituto.

Recuerda la convención: `mnemosine <algo>` se teclea como `npm run mnemosine -- <algo>`.

---

## Lo primero: no hay familia de bancos

```bash
mnemosine banco
```

```
error: too many arguments for 'chat'. Expected 0 arguments but got 1: banco.
```

No existe `bank`, ni `banco`, ni `conciliacion` en el árbol de comandos. El mensaje que recibes menciona `chat` porque cualquier palabra desconocida en el primer nivel se la lleva el comando por omisión; no es que hayas escrito mal.

El motor sí existe. Lo que no existe es la puerta.

---

## Qué hay construido y por dónde se alcanza

El módulo de banca vive completo en el código y se publica **sólo por la API REST**, montada en `/v1/bank-accounts`. Para usarla hace falta el servidor levantado (`npm run dev`), un token `Bearer` de tu proveedor de identidad y la cabecera `x-entity-id` de la entidad sobre la que actúas — ver [[Seguridad-y-credenciales]].

| Paso | Estado | Ruta |
|---|---|---|
| Dar de alta la cuenta bancaria | ❌ **No existe**, ni en CLI ni en REST | sólo el sembrador de demostración |
| Importar movimientos del estado de cuenta | Existe, sólo REST | `POST /v1/bank-accounts/:id/import` |
| Listar movimientos sin casar | Existe, sólo REST | `GET /v1/bank-accounts/:id/transactions/unmatched` |
| Sugerencias de coincidencia | Existe, sólo REST | `GET /v1/bank-accounts/transactions/:id/suggestions` |
| Casar un movimiento a mano | Existe, sólo REST | `POST /v1/bank-accounts/transactions/:id/match` |
| Casar automáticamente | Existe, sólo REST | `POST /v1/bank-accounts/:id/auto-match` |
| Abrir una sesión de conciliación | Existe, sólo REST | `POST /v1/bank-accounts/:id/reconciliations` |
| **Cerrar la conciliación** | ❌ **501 deliberado** | `POST /v1/bank-accounts/reconciliations/:id/complete` |

### El alta de la cuenta bancaria es el primer muro

En todo el código hay **un solo** `INSERT INTO bank_accounts`, y está en el sembrador de datos de demostración ([`seed.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/seed.ts), línea 172). No hay comando ni ruta que dé de alta la chequera de un cliente.

La consecuencia práctica es que ni siquiera el camino por REST está completo: la ruta de importación necesita un `:account_id` que sólo puede existir si alguien lo escribió por SQL.

Y tiene un segundo efecto, que se nota en la captura diaria. `payment create` y `receipt record` traen una bandera `--bank <account>` que pide el **id** de una cuenta bancaria. Hoy es inutilizable. **Omítela.** Sin ella, el asiento usa el rol `banco` de la entidad, que sí funciona:

```bash
mnemosine account role list
```

```bash
mnemosine account role set banco 1111
```

Si la entidad tiene dos chequeras, esa indirección no alcanza: el rol es uno solo. Mientras no exista el alta de cuentas, la segunda chequera se maneja apuntando los renglones a mano con `entry create`, no con `--bank`.

### Qué hace el casado automático

Cuando el casado sí se puede correr, aplica cuatro reglas en orden y se queda con la primera que dé un resultado inequívoco ([`matching.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/banking/matching.ts)):

1. **Importe exacto y fecha exacta** — confianza 1.00. Si hay más de un candidato, no casa.
2. **Importe exacto y fecha a ±3 días** — confianza 0.90. Ambiguo también significa no casar.
3. **Descripción parecida**, con el importe dentro del 5 %, comparando además el nombre del comercio contra el del cliente o el del proveedor. Sólo casa si hay un único candidato por encima de 0.85.
4. **Puntaje compuesto** de importe, fecha y descripción.

Sólo se casa solo lo que llega a **0.85 de confianza**; lo demás queda para una persona. Es el umbral correcto y hay que acreditarlo.

**Pero casar no contabiliza nada.** Un casado escribe `is_matched = true` y una fila en `reconciliation_matches`. No genera pólizas, no ajusta saldos, no reconoce comisiones. Es una anotación de correspondencia entre un renglón del banco y un documento que ya existía en los libros.

---

## Dónde se acaba, y por qué se acabó ahí a propósito

El endpoint que cierra una conciliación está **retirado con un 501 explícito**, y conviene leer la razón porque explica el diseño de todo el módulo:

> mnemosine no puede completar una conciliación bancaria: no calcula el saldo en libros, la variación, los cheques en tránsito ni los depósitos en camino, y no contabiliza las comisiones, los intereses ni las devoluciones que una conciliación descubre.

La implementación anterior era un solo `UPDATE` que ponía la sesión en `balanced`. Nunca comparaba nada. Las columnas de variación y de partidas en tránsito conservaban su cero por omisión, y ese cero —que significaba «nadie restó nada»— se mostraba como «la cuenta concuerda».

Eso importaba más allá del módulo de bancos, porque **el cierre de periodo lee ese estado como evidencia**: una sesión en `balanced`, `approved` o `posted` marca en verde la partida «Bank reconciliations complete» de la lista de cierre. Un `UPDATE` incondicional se convertía así en una afirmación firmada de que el saldo de efectivo había sido verificado contra el banco.

Retirar el endpoint es la decisión correcta: una funcionalidad sin terminar es un problema, una atestación falsa es otro mucho peor.

### El falso verde que sí sigue ahí

Hay una consecuencia de todo esto que un contador tiene que conocer antes de firmar un cierre. La partida de conciliación de la lista de cierre cuenta **cuentas bancarias activas sin sesión conciliada** ([`period-close.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/period-close.ts), líneas 51-69). Si no hay ninguna cuenta bancaria dada de alta —y hoy no puede haberla—, ese conteo da cero, la partida se marca **cumplida**, y el cierre reporta:

```
  ✔ Bank reconciliations complete
```

Con cero cuentas revisadas. No es una mentira del programa: es la aritmética de contar un conjunto vacío. Pero se lee como una verificación que nunca ocurrió, y hay que leerla con esa advertencia puesta. Mientras el alta de cuentas bancarias no exista, **esa palomita no significa nada**.

---

## Lo que sí se hace hoy: conciliar fuera y registrar los hallazgos

Es el sustituto que el propio 501 recomienda: concilia la cuenta fuera de mnemosine —en Excel, en el módulo de bancos del sistema anterior, o a mano contra el estado de cuenta— y captura como pólizas los ajustes que encuentres. Deja la advertencia del cierre en pie hasta que la hayas hecho.

### 1. Sacar el lado del mayor

Lo que la contabilidad dice de la chequera se saca completo, y esta parte sí es cómoda:

```bash
mnemosine ledger auxiliary show --account 1111 --period August
```

Es el auxiliar: saldo inicial, cada movimiento y saldo final, con la forma que pide el auxiliar XC del SAT. El periodo va por **fragmento del nombre** —en inglés—, no por fecha: `--period 2026-08` no encuentra nada aquí (ver la tabla de las tres familias en [[Manual-El-cierre-de-mes]]). Sin `--limit` devuelve **todos** los movimientos, así que en una chequera con miles de renglones conviene acotar o exportar:

```bash
mnemosine ledger auxiliary show --account 1111 --period August \
  --format csv -o auxiliar-bancos-agosto.csv
```

Para el saldo suelto a una fecha:

```bash
mnemosine ledger balance show --account 1111 --as-of 2026-08-31
```

Y para verlo con el detalle del mayor, renglón por renglón:

```bash
mnemosine report general-ledger show --account 1111 --period 2026-08
```

Ese CSV es el que se pega junto al estado de cuenta en la hoja de trabajo. Los importes salen sin separador de miles y con cuatro decimales, que es lo correcto para importarlos a Excel.

### 2. Capturar los ajustes que aparezcan

Los cuatro que aparecen todos los meses. Todos con el separador de `entry create`, que son **dos puntos**: `<cuenta>:<debit|credit>:<importe>[:descripción]`.

**Comisión bancaria con su IVA.** No la olvides: el IVA de la comisión es acreditable y casi siempre se queda fuera.

```bash
mnemosine entry create \
  --date 2026-08-31 --type adjusting \
  --description "Comisiones bancarias agosto - BBVA 4567" \
  --line "5910:debit:850.00:Comisión por manejo de cuenta" \
  --line "1130:debit:136.00:IVA acreditable de comisiones" \
  --line "1111:credit:986.00:Cargo BBVA 31/08"
```

**Intereses ganados.**

```bash
mnemosine entry create \
  --date 2026-08-31 --type adjusting \
  --description "Intereses ganados agosto - BBVA 4567" \
  --line "1111:debit:1240.50:Abono de intereses" \
  --line "7100:credit:1240.50:Productos financieros"
```

**Cheque devuelto.** Reversa el efectivo y revive la cuenta por cobrar.

```bash
mnemosine entry create \
  --date 2026-08-22 --type correction \
  --description "Cheque devuelto 001234 - Comercializadora del Norte" \
  --line "1120:debit:11600.00:Se restablece el saldo del cliente" \
  --line "1111:credit:11600.00:Devolución BBVA 22/08"
```

**Depósito en tránsito o cheque en circulación.** Estos **no se contabilizan**: son diferencias de tiempo, no de registro. Van en la hoja de conciliación como partidas de conciliación, no en el mayor. Si los capturas, duplicas.

### 3. Validar y contabilizar

Toda póliza nace como borrador. El paso de contabilizar es humano y separado, a propósito:

```bash
mnemosine entry check --entry JE-2026-0455 --strict
```

Corre las siete reglas de validación NIF sin escribir nada. `--strict` trata los avisos como bloqueantes y sale con código 4 si encuentra algo.

```bash
mnemosine entry preview JE-2026-0455
```

Muestra el delta exacto de saldos que la póliza produciría, sin tocar nada.

```bash
mnemosine entry post JE-2026-0455
```

Recuerda: en esta compuerta la única respuesta afirmativa es `y` o `yes`. Escribir `s` o `sí` cancela.

### 4. Dejar constancia

La advertencia del cierre va a seguir ahí, y eso es correcto. Lo que hay que hacer es dejar en el expediente del mes la hoja de conciliación, el estado de cuenta y el CSV del auxiliar, y anotar en la razón del cierre que la conciliación se hizo fuera:

```bash
mnemosine close --period August --reason "Cierre agosto; conciliación bancaria hecha fuera del sistema, papeles en el expediente"
```

Ese motivo queda en la bitácora de auditoría junto con quién cerró y cuándo.

---

## Un detalle de captura que complica la conciliación

`payment create` y `receipt record` aplican el importe a **un solo documento** por invocación. Una transferencia SPEI que liquida tres facturas de un mismo proveedor se captura como tres pagos, con tres números distintos.

En el estado de cuenta hay un movimiento; en los libros hay tres. Ninguna de las reglas de casado automático resuelve un uno-a-muchos, así que ese renglón siempre va a quedar para una persona. Vale la pena saberlo antes de perseguir la diferencia: no es un error de captura, es cómo funciona hoy.

---

## Resumen honesto

| Quiero… | Puedo | Cómo |
|---|---|---|
| Dar de alta una chequera | ❌ No | Sólo por SQL directo |
| Cargar el estado de cuenta | Parcialmente | API REST, si la cuenta ya existe |
| Ver qué está sin casar | Parcialmente | API REST |
| Casar movimientos | Parcialmente | API REST, manual o automático a ≥0.85 |
| Cerrar la conciliación | ❌ No | 501 deliberado; conciliar fuera |
| Calcular la variación y las partidas en tránsito | ❌ No | Hoja de trabajo aparte |
| Contabilizar comisiones, intereses y devoluciones | Sí | `entry create` + `entry check` + `entry post` |
| Sacar el auxiliar de la chequera | Sí | `ledger auxiliary show --account 1111` |
| Que el cierre lo compruebe | ❌ No | La palomita sale en verde sin haber comprobado nada |

---

## Ver también

- [[Manual-Cobrar-y-pagar]] — de dónde salen los movimientos de banco que después hay que conciliar.
- [[Manual-El-cierre-de-mes]] — la lista de verificación completa, y qué hacer con la partida de conciliación.
- [[Hoja-de-ruta]] — dónde está la familia de bancos en el plan.
- [[Solucion-de-problemas]] — qué hacer cuando un comando falla sin explicar por qué.
