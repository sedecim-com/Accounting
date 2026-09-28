# Cuentas de orden (8xx): no se migran en esta versión

**Decisión del dueño del plan, 2026-09-26, en [#219](https://github.com/sedecim-com/Accounting/issues/219): opción (b).** Las cuentas de orden del Anexo 24 —rubros 800 a 811 del `c_CodAgrup`: UFIN, CUFIN, CUCA, ajuste anual por inflación y sus contracuentas— **no entran al catálogo ni al mayor** de este sistema. Quedan fuera a propósito, se dice cuáles son, y no bloquean la migración. La opción (a), un tipo de memoria en `accounts.account_type`, queda para después del MVP.

## Por qué no migran

- **No hay casilla honesta para ellas.** `accounts.account_type` sólo tiene activo, pasivo, capital, ingreso y gasto (con sus contracuentas). Una cuenta de orden no es ninguna: es de memoria, vive fuera del balance y va siempre en pareja con su contracuenta.
- **Meterlas en la casilla menos mala descuadra el balance.** Una CUFIN tipada como activo suma al balance dinero que no existe; heredar el tipo del padre hace exactamente lo mismo. Por eso el importador no las empuja a ninguna casilla ni las hace heredar.
- **Darles casilla propia es un cambio grande.** Exige una migración del CHECK y enseñar a excluirlas al balance, al estado de resultados, a la balanza, al cuadre y al Anexo 24. Eso es la opción (a), y no cabe en el MVP.

## Qué hace el sistema con ellas

| Momento | Qué pasa |
|---|---|
| `chart import` (catálogo `CatalogoCuentas`) | Cada cuenta con agrupador 8xx —y toda subcuenta que cuelgue de una— se queda fuera con el aviso `IMP-CUENTAS-DE-ORDEN`, que remite a este documento. **Es aviso, no bloqueo**: el resto del catálogo se escribe sin `--parcial`. Una cuenta de orden que **ya existe** en la entidad no se toca: se declara el conflicto (`IMP-ORDEN-YA-EN-EL-MAYOR`) y sus subcuentas nuevas tampoco se crean. |
| `opening-balance check` (el cotejo al peso) | Al servicio (`checkOpeningBalance`, `compareToSource`) se le nombran las cuentas de orden; no se cotejan, **se declaran excluidas con su código y el saldo que declara el origen**, y el cotejo puede salir igual al peso. Una exclusión que no se escribe es una diferencia escondida, así que siempre se imprime. Si el mayor de este sistema llevara dinero en uno de esos códigos, sale como sobrante aunque cuelgue de una cuenta que el origen sí declara: el origen lo tiene fuera del balance. |

## Qué hace el contador con la CUFIN, la CUCA y la UFIN

Son **registros fiscales de control**, no saldos contables: la CUFIN (art. 77 LISR) y la CUCA (art. 78 LISR) se actualizan con el INPC y se consultan cuando se distribuyen dividendos o se reembolsa capital; el ajuste anual por inflación (art. 44 LISR) se determina al cierre del ejercicio. Mientras esta versión no los lleve:

1. **Conserva el saldo al corte.** La balanza del sistema anterior con la que se migró declara el saldo de cada cuenta de orden al cierre; guárdala con los papeles de trabajo de la migración. `opening-balance check` imprime esos mismos importes como excluidos, y esa salida es la constancia de qué se dejó fuera.
2. **Lleva el control fuera del mayor.** Las actualizaciones y los movimientos de la CUFIN y la CUCA se siguen en los papeles de trabajo (la cédula de CUFIN y la de CUCA), como se hacía antes, y se concilian contra la declaración anual.
3. **No las captures como cuentas del catálogo.** Darlas de alta a mano con cualquier tipo las mete en el balance, que es justo lo que esta doctrina evita.

## Lo que todavía no está hecho

- **La terminal no le pasa aún al cotejo cuáles cuentas son de orden.** La balanza de comprobación del Anexo 24 no trae el código agrupador, así que la lista tiene que salir del catálogo; `opening-balance check` por la terminal todavía no la recibe y reporta esas cuentas como «sin cuenta en el plan».
- **`opening-balance import` rechaza una balanza que trae cuentas de orden** (`APE-CUENTA-DESCONOCIDA`): la cuenta no existe en el catálogo, precisamente porque no se migró. Hasta que la exclusión llegue a la carga, las filas 8xx se quitan de la balanza que se carga, no de la que se coteja.

Ambos puntos los decide el dueño del plan; el código que los resuelva actualiza esta sección en el mismo PR.
