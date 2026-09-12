# Auditoría de T4b «La prestación más grande, que no se calculaba» (#91)

**Objeto:** el finiquito mexicano sumaba cuatro conceptos y llamaba `total` al
resultado.
**Fecha:** 2026-09-08.
**Método:** reproducción con cifras → investigación normativa con fuentes
primarias (LFT en el PDF de la Cámara de Diputados, DOF) → un auditor
adversario por entrega, con mandato explícito de rechazar toda cifra sin
fuente.

## Lo reproducido

Trabajador con quince años cumplidos, salario diario de 1 000, baja el
30-jun-2026:

```
salario pendiente 15 000.00 · aguinaldo 7 438.36 · prima vacacional 2 172.60
total 24 610.96
```

Falta la **prima de antigüedad** (LFT art. 162): doce días de salario por año
de servicio, sin tope de años. Para quince años son **180 días**. Con el
salario mínimo de 2026 son **113 414.40** — más de cuatro veces el finiquito
entero.

## La norma, verificada

- **Art. 162 fr. I**: «doce días de salario, por cada año de servicios».
- **Art. 162 fr. II** no define el salario: remite a los **485 y 486**.
  - **485**: la base «no podrá ser inferior al salario mínimo».
  - **486**: si el salario «excede del doble del salario mínimo del área
    geográfica … se considerará esa cantidad como **salario máximo**».
  - Es decir: `base = min( max(salario, SM), 2 × SM )`, y **se topa el
    salario, no el resultado**. Topar los 113 414.40 finales da otra cifra.
- **Art. 162 fr. III**: la renuncia la paga sólo con **quince años cumplidos**;
  el despido la paga «**independientemente de la justificación o injustificación
  del despido**»; la separación por causa justificada también. **Fr. V**: en
  caso de muerte, «cualquiera que sea su antigüedad».
- **El tope se mide en salario mínimo, no en UMA.** La desindexación de 2016
  prohíbe usar el mínimo «para fines ajenos a su naturaleza»; topar una
  prestación laboral es un fin propio.

## Lo entregado

**`074_el_minimo_del_que_cuelga_la_prima.sql`** corrige el salario mínimo de
2026 —**315.04** general y **440.87** frontera, DOF 09-12-2025— en las dos
ventanas de vigencia que dejó T4a. Nótese el detalle que justifica la capa: el
**mínimo cambia el 1 de enero** y la **UMA el 1 de febrero**, así que las dos
ventanas de 2026 llevan el mismo mínimo y distinta UMA. Con el 278.80 sembrado
la prima habría salido en 100 368.00: **13 046.40 de menos por trabajador**.

**La prima de antigüedad**, con sus tres reglas y una cuarta que es de método:

1. El tope del 486 sobre la **base diaria**.
2. El **despido** la cobra sin umbral de antigüedad.
3. El **motivo de la baja es obligatorio** en el tipo: sin él no se puede saber
   si se debe la prestación más grande del finiquito, y un valor por omisión la
   callaría justo en el caso que más dinero mueve. El compilador obliga a cada
   llamador a declararlo.
4. **Y el cero se explica.** Si falta el salario mínimo, la prima no se cifra en
   cero en silencio: el desglose dice `SIN CALCULAR` y **cuántos días se deben**.

## El resultado, medido

| escenario | prima | total |
|---|---|---|
| 15 años, renuncia, mínimo general 2026 | **113 414.40** | 24 610.96 → **138 025.36** |
| 15 años, zona frontera | 158 713.20 | 183 324.16 |
| 15 años, **sin** el mínimo | 0.00 | *«SIN CALCULAR: se deben 180 días y NO están en este total»* |
| **3 años, despido** | **22 682.88** | — |
| 3 años, renuncia | 0.00 | *«no se devenga… quince años»* |

## Lo que NO se entrega, y por qué

**EL ISR DE SEPARACIÓN, a propósito y por este orden.** En el caso reproducido
mueve **0.00**: la exención del art. 93 fr. XIII —90 UMA por año de servicio—
son 90 × 117.31 × 15 = **158 368.50**, que se traga la prima entera. Y su
mecánica no es la tarifa ordinaria del periodo: el art. 96, último párrafo, y el
174 del Reglamento mandan una **tasa efectiva** construida sobre el último
sueldo mensual ordinario. Implementarlo con la tarifa del periodo —como
proponía la primera versión de la investigación— **retiene de más**. Además
quedaron dos preguntas abiertas que el auditor no pudo cerrar y que mueven
dinero: si el ISR del último sueldo va bruto de tarifa o neto de subsidio
(11 903.25 pesos sobre 200 000 gravados) y el redondeo del prorrateo. Van a su
issue, con el panel de políticas donde corresponda.

**LA ZONA GEOGRÁFICA.** El art. 486 mide el tope con el mínimo del área donde
se presta el trabajo, y este esquema **no tiene dónde guardarla**: no hay
columna en `employees` ni en `legal_entities`, y `salario_minimo_frontera_diario`
llevaba sembrado desde la 009 **sin un solo lector**. La diferencia es de
**45 298.80** por trabajador fronterizo en el caso medido. Este tramo siembra el
dato correcto y hace visible el supuesto; el campo va a su issue.

**LOS MÍNIMOS PROFESIONALES.** La misma resolución fija 61 para 2026 (316.85 a
705.46). Si el tope del 486 se mide con el profesional del oficio, un reportero
con quince años cobraría 180 000.00 en vez de 113 414.40 — **66 585.60** de
diferencia. Qué lectura rige no se pudo verificar. No se siembra ninguno.

## Lo que el auditor corrigió

Los tres dictámenes fueron SIRVE CON CAMBIOS, y dos correcciones cambiaron el
trabajo:

- **El orden.** La investigación proponía empezar por el ISR. El auditor puso
  las cifras que faltaban —prima 113 414.40, ISR 0.00 en el mismo caso— y con
  ellas el orden se invierte solo: primero lo que mueve cien mil.
- **La mecánica del ISR.** Se propuso `getBrackets(…, <periodo>)`, la tarifa
  ordinaria. Es el régimen equivocado para un pago por separación.

Y una advertencia que llegó a tiempo: sin el PR #193 (T4a), la tarifa con la que
se calcularía cualquier retención de separación seguiría siendo la de 2025, y
sobre un despido de quince años eso retiene **2 438.54 de más**.
