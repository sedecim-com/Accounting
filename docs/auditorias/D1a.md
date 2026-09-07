# Auditoría adversarial de D1a «El devengo existe, y lo que ya se pagaba se paga bien»

**Objeto:** el commit del tramo D1a, primera mitad de D1 — la respuesta a «¿puede
un contador firmar unos estados salidos de aquí?».
**Fecha:** 2026-09-02.
**Método:** reconocimiento en cuatro frentes (verificado ejecutando contra
Postgres) → dos agentes de motor → un agente de superficie → dos verificadores
adversariales. El adversarial escribió **40 ataques** contra Postgres y confirmó
**dos defectos de gravedad 1**, que arregló.

## Lo que el tramo cerró

### La 1160 era una promesa escrita en la descripción de una cuenta

`1160 Pagos Anticipados` se sembraba diciendo «se devengan mes a mes». No había
tabla, ni migración, ni motor: **cero** tablas de amortización en 58 migraciones.
Y el camino de ESCRITURA estaba vivo —la decisión `gasto_vs_anticipado` del CFDI
ya mandaba importes ahí— mientras el de lectura no existía. Como lo dijo el
reconocimiento: *hoy el saldo es cero por suerte, no por diseño*.

Peor: la etiqueta ofrecía el diferimiento **citando la NIF A-2** como respaldo de
algo que no ocurría. Es peor que no ofrecer la opción, porque el error quedaba
avalado por la norma. Ahora la etiqueta dice la verdad, tiene piso de importe
(`umbral_anticipado_mxn`, materialidad de la NIF A-4) y su fundamento nombra el
comando que la vuelve cierta — el mismo trato que su decisión hermana recibió
cuando F06a entregó la depreciación.

**Dos tablas y no una**, y el argumento importa: el hueco se cuenta ANTES de que
exista renglón. La 1160 ya puede tener saldo posteado sin calendario, y para
decir «hay 340 000 y sólo 120 000 tienen quién los devengue» hace falta una fila
que exista desde el alta. Con renglones solos, un anticipo recién dado de alta y
uno inexistente son indistinguibles.

### Tres defectos de dinero que ya se pagaban a personas

Vivían encerrados dentro de `calculateFiniquito`, detrás de una conexión a
Postgres, y sus pruebas comprobaban **rangos** (`toBeGreaterThan(2400)`), así que
los tres caían dentro del rango:

1. **La tabla del art. 76 pagaba dos días de menos.** Tras la reforma de 2023 el
   incremento es de dos días por QUINQUENIO desde el sexto año; se contaba por
   año. Medido: los cinco años 11-15 deben dar 24 días y cuatro de ellos daban 22.
2. **El aguinaldo no miraba la fecha de alta**: quien entró el 1 de julio cobraba
   el año entero. Medido: 7,5616 días frente a los 15,0000 del veterano.
3. **La base salía del SBC** —el salario diario integrado, que ya lleva dentro el
   factor de aguinaldo y prima vacacional—, así que la prestación se calculaba
   sobre una base inflada por sí misma. Medido: 500,0000 contra 524,6575.

Y **dos centavos que la coma flotante se comía**: el módulo calculaba con `float`.
La aritmética salió a una capa pura con 60 casos, cada uno con su número a mano.

## Los dos de gravedad 1 que el adversarial cazó

### 1 · La reversa dejaba cuatro instrumentos mintiendo y el gasto perdido para siempre

El mayor es inmutable (041) y sólo se corrige por reversa, así que **reversar es
un camino normal, no una excepción**. Al reversar el asiento de una amortización
el importe volvía a la 1160 en el acto, pero el renglón seguía contando
(`is_posted = true`, apuntando a un asiento que existe y ya tiene espejo).
Medido: ficha afirmando 3 100 devengados con el gasto en 0; el respaldo
disponible ofreciendo esos mismos 3 100 como saldo libre —invitación a adoptar
dos veces el mismo cargo—; la casilla del cierre en verde sobre un mes que no
está en el resultado; y el freno de doble corrida impidiendo reponerlo, de modo
que **el gasto no volvía nunca**. Con el último renglón de un anticipo ya
liquidado, salía de la corrida para siempre.

El arreglo es un solo principio: **un renglón vale mientras el mayor lo
respalde**. El respaldo y la casilla se calculan en vivo contra el mayor y no
sobre la caché; la corrida se gobierna por el hecho y no por la etiqueta de
estado; y el estado se mueve en los DOS sentidos.

### 2 · La guarda del respaldo era un TOCTOU

Dos altas simultáneas sobre el mismo cargo de 24 000 pasaban **las dos**.
Consecuencia medida en el mayor: 48 000 abonados sobre 24 000 cargados, la 1160
en −20 900 —un activo con saldo acreedor— y el balance cuadrando tan tranquilo.
Se mide y se consume en la misma transacción, serializado con `SELECT … FOR
UPDATE`, y el `entity_id` va dentro de ese SQL.

## Lo confirmado sano, con números

Póliza de 120 000 del 20 de marzo al 19 de marzo: 13 renglones, último
**6 246,5754** —no 6 246,5753: el tapón— y la 1160 en 0,0000 tras 13 corridas
reales a caballo de dos ejercicios. `hard_close` y `locked` no dejan pasar ni
medio renglón; `soft_close` sí devenga, deliberadamente. Frontera de entidad
probada también por SQL crudo.

## Nota sobre el proceso

Este tramo se implementó mientras **otra sesión trabajaba en G0 sobre el mismo
árbol**. La consecuencia se pagó: la migración 063 de F07a, escrita en paralelo y
todavía sin trackear, desapareció del árbol y hubo que reescribirla. Un archivo
nuevo sin commitear no sobrevive al `checkout` de otro. La lección es de higiene,
no de código: en un árbol compartido, lo que no está en un commit no existe.

## Lo que queda fuera, con domicilio

El **periodo 13** —los cinco resolutores fecha→periodo no coinciden entre sí y el
arrastre sembraría el ejercicio siguiente con saldos falsos: es tramo propio—,
las **provisiones mensuales de D-3**, la **PTU** (no existe ni la base gravable),
el estado de cambios en el capital (B-4), y D-4, D-5 y C-13.

## Veredicto

D1a **cierra**. El devengo existe: la promesa que la 1160 llevaba escrita en la
descripción de una cuenta tiene por fin motor, y las prestaciones que ya se
pagaban se calculan como manda la ley. Las cuatro hojas son de fase 2 en el
catálogo, así que el suelo de fase 1 no se mueve; el de invocables sube a 200.
