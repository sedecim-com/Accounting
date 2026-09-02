# Auditoría adversarial de G1a «Los estados que ya se firman, y que hoy mentían»

**Objeto:** el commit del tramo G1a — la primera mitad de G1, la aritmética que
estaba mal en código que YA CORRÍA y que producía documentos firmados.
**Fecha:** 2026-09-02.
**Método:** reconocimiento en cinco frentes (todo verificado EJECUTANDO contra
Postgres, no leyendo) → dos agentes de motor → un agente de instrumento → dos
verificadores adversariales. El adversarial escribió 17 ataques y confirmó
**tres defectos, uno de gravedad 1**, que arregló.

## Lo que el tramo cerró

1. **El cierre emitía por `abs()` y DUPLICABA las contra-naturales.** El saldo
   viene de `SUM(debit_total − credit_total)` —deudor-positivo, con signo— y
   `abs()` lo borraba: siempre cargaba los ingresos y siempre abonaba los
   gastos. Acierta por casualidad en la cuenta de naturaleza normal; en la
   contra-natural añade un segundo cargo donde tocaba abonar. Con ventas
   10 000, devolución sobre ventas 2 000 (4400), costo 6 000 y devolución
   sobre compras 1 000 (5200): Resultados Acumulados quedaba en 5 000 donde
   iban 3 000, las dos cuentas quedaban al DOBLE en vez de en cero, y una
   utilidad de 3 000 se publicaba como **pérdida de 2 000**. Y el balance
   decía `is_balanced: true` con `out_of_balance: 0.0000`, porque el renglón
   del resultado cancelaba exactamente el exceso. Ahora el lado lo decide el
   SIGNO y `abs()` sólo fija el importe una vez elegido el lado.
   · **La auditoría III sólo vio la mitad**: nombró la 4400 y no su gemela, la
   5200, que es `expense` de naturaleza acreedora y que F04 y R4 pueblan en
   cada descuento por pronto pago y en cada descuento cambiario.
2. **Nada comprobaba que el ejercicio quedara en cero** — por eso lo anterior
   vivió tanto: el asiento cuadraba. Ahora se verifica, y con el defecto de la
   política `severidad_resultado_sin_barrer` el cierre duro **revierte su
   transacción** y nombra las cuentas que no barrieron.
3. **El asiento de cierre se fecha DENTRO del rango que el informe consulta.**
   Un ejercicio cerrado imprimía «Net income 0.0000» sin una advertencia, en
   las TRES superficies a la vez —CLI, REST y agente comparten la consulta, y
   por eso no había segunda opinión que delatara el error—. El criterio vive
   ahora en una capa compartida: el estado de resultados los excluye, la
   balanza los incluye Y LO DICE.
4. **`checkBalance` era ciego a `ending_balance`**: inyectarle 99 999 devolvía
   cero hallazgos. Es la columna que el cierre escribe y el ejercicio
   siguiente HEREDA. Ahora se contrasta contra su invariante declarado
   (`ending = beginning + debit − credit`) y contra el encadenamiento entre
   periodos consecutivos.
5. **El cierre no era idempotente**, y `period reopen` —que entregué yo en
   F06b— volvió eso alcanzable desde la terminal: reabrir y volver a cerrar
   emitía un segundo juego completo y el resultado entraba dos veces al
   capital. Ahora se reversa el cierre anterior con motivo auditado antes de
   emitir el nuevo.
6. **`inicial_confiable` juraba por el periodo equivocado** y
   **`restorePeriodStatus` recerraba con un UPDATE pelado sin re-arrastrar**,
   con un llamador vivo (la reclasificación del IVA PPD).

## Los tres que el adversarial cazó

1. **Gravedad 1 — el estado de resultados salía al DOBLE tras un recierre.**
   El defecto que este tramo vino a matar **reapareció por la puerta de su
   propio arreglo**: el filtro excluía `entry_type='closing'`, pero el espejo
   que emite la reversa del recierre nace `'reversing'`, así que entraba al
   informe como actividad del negocio y devolvía al ingreso y al gasto
   exactamente lo que el cierre reversado les había quitado. Salida real:
   `revenue 16000.0000` donde iban 8 000. El reconocimiento es ahora por el
   asiento QUE SE REVERSA, no por el tipo del espejo — lo que mantiene la
   frontera estrecha: la reversa de una venta sigue contando y sigue bajando
   el ingreso, y hay un ataque dedicado a esa frontera.
2. **Gravedad 2 — un saldo que se va a cero nunca llegaba al mes siguiente.**
   El arrastre llevaba `AND ab.ending_balance <> 0`, así que una cuenta cuyo
   final queda en cero no estaba en el origen y el inicial VIEJO sobrevivía:
   reabrir junio para cancelar una cuenta por cobrar de 3 000 dejaba junio
   cerrando en 0 y **julio abriendo en 3 000**. Era justo la corrección que
   uno reabre el periodo a hacer. El chequeo de encadenamiento nuevo SÍ lo
   denunciaba: el instrumento funcionó antes que el motor.
3. **Gravedad 2 — un ejercicio se declaraba cerrado sin emitir una línea.** El
   `return` temprano de `generateClosingEntries` estaba ANTES de leer las
   políticas y de verificar el barrido: con la 3900 sin su marca de cuenta de
   sistema —un catálogo tocado a mano, o migrado— el periodo pasaba a
   `hard_close` con los ingresos intactos y sin un error.

## Lo que el instrumento cobró

- **Invertir el signo del saldo sobrevivía a las 3 500 pruebas.** La única
  prueba del módulo FABRICA `ending_balance` recomponiendo la resta que la
  consulta declara, así que la mutación pasaba en verde y sólo la acusaba un
  regex sobre el TEXTO del SQL. Ahora hay prueba de cifras contra Postgres, y
  el criterio nuevo ancla el orden de la resta con su mutante.
- El criterio de este tramo nació con **los dos mutantes sobreviviendo**: sus
  anclas no leían los archivos que los mutantes tocan. Un criterio sólo mata
  lo que inspecciona. Y el segundo sobrevivió aún después, porque la consulta
  del saldo tiene DOS gemelas textuales —ingresos y gastos— y mutar una deja
  la otra en pie: se cuentan las dos, no se comprueba que haya una.

## Límites de esta auditoría

**Lo que G1a NO cubre, dicho aquí para que nadie lo dé por auditado.** G1a es
la PRIMERA MITAD de G1; un auditor futuro que lea este registro debe saber que
lo siguiente quedó fuera del alcance, no fuera de existencia:

| Fuera de alcance | Dónde vive ahora |
|---|---|
| El estado de flujos de efectivo entero | G1b — su propio tramo y su propio registro |
| `--level N` y las 29 de 61 cuentas sin padre en la semilla | sin tramo asignado; nombrado abajo |
| La deuda de prueba de `report-service` (88 % contra un mock) | S4 |
| Las seis implementaciones del universo de cuentas | sin tramo asignado |

## Lo reportado y NO hecho, con domicilio

- **El flujo de efectivo entero**, que es la otra mitad de G1: no se amarra
  contra el efectivo real, su parámetro `method` se devuelve al cliente sin
  cambiar un número, y AR/AP se detectan **por nombre en INGLÉS** dentro de un
  catálogo mexicano. No existe siquiera `report cash-flow` en el binario.
- **`--level N` filtra donde su ayuda promete AGREGAR**, y el árbol de cuentas
  está roto en la SEMILLA: 29 de 61 cuentas nacen sin padre.
- **La deuda de prueba de `report-service`**: 88 % de cobertura contra un mock
  y cero archivos de integración lo importaban. G1a puso los primeros; el
  resto es de S4.
- Seis implementaciones distintas del universo de cuentas: la balanza excluye
  archivadas y el balance general las incluye a propósito.

## Nota de proceso

El segundo verificador midió **dos rondas sobre un árbol en movimiento**,
porque corría en paralelo con el adversarial, que arregla. Es un defecto del
diseño de este taller, no suyo: cuando un agente repara y otro mide, el que
mide va después. La medición final de este registro se hizo con el árbol
quieto.

## Veredicto

G1a **cierra**. La mitad más urgente del plan —la que produce números falsos
hoy sobre documentos que se firman— deja de producirlos, y cada arreglo llega
con prueba de conducta contra Postgres, no de regex. La otra mitad de G1 (el
flujo de efectivo y el roll-up) queda nombrada arriba, con su tamaño.
