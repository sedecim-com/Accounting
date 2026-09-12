# Auditoría de T4a «La tarifa que sí es de este año» (#91)

**Objeto:** la retención de ISR de una nómina semanal, y la tarifa con la que
se calcula.
**Fecha:** 2026-09-07.
**Método:** reproducción con cifras contra base migrada → investigación
normativa con fuentes primarias → un auditor adversario por entrega, con
mandato explícito de rechazar cualquier número sin fuente.

## Lo que el issue decía, y lo que había debajo

#91 reportaba que `isr-calculator.ts:27` mandaba `weekly`, `biweekly` y
`semimonthly` al `else` mensual. Reproducido antes de tocar nada:

```
weekly       3000.00   ISR 158.57   subsidio 406.62  →  RETIENE     0.00   [monthly]
weekly       7000.00   ISR 444.50   subsidio 253.54  →  RETIENE   190.96   [monthly]
quincenal    3000.00   ISR 175.29   subsidio 147.32  →  RETIENE    27.97   [quincenal]
```

Cierto, y con dos mitades que empujan en la misma dirección: la tarifa mensual
sobre base semanal cae en el primer tramo, y encima se entregaba el subsidio
mensual **íntegro** cada semana.

Pero la investigación normativa encontró que el issue se quedaba corto, y lo
verificó contra el Diario Oficial:

1. **La tarifa sembrada como 2026 es la de 2025**, al centavo (Anexo 8 RMF
   2025, DOF 30-dic-2024: primer límite 746.04). La de 2026 empieza en 844.59.
   Toda retención del ejercicio salía con la tabla del año anterior.
2. **La «quincenal» no es la de ningún año.** El archivo lo confiesa:
   «same structure, divided by 2» (009:162). El Anexo 8 no la construye así:
   la quincenal es la **diaria × 15**, y la diaria es la **mensual ÷ 30.4**.
   La mensual entre dos da 373.02 donde el DOF publica 416.70.
3. **La UMA también era la de 2025** (113.14 contra 117.31), y de ella cuelgan
   IMSS, INFONAVIT y las exenciones del art. 93.

La 009 lo decía de sí misma y nadie volvió: «Art. 96 LISR (mensual) 2026
**estimado**», «Mexico 2026 (**estimated** UMA + IMSS rates)».

## La norma, verificada

- **Art. 96 LISR**: la retención es MENSUAL. No contiene regla de periodo menor.
- **Arts. 175 y 176 RLISR**: permiten **optar** por la tarifa del periodo «que
  para tal efecto publique en el Diario Oficial de la Federación el SAT». El
  que gobierna 7, 10 y 15 días es el **176**, aunque el propio Anexo 8 encabece
  las cinco tablas citando el 175.
- **Anexo 8 RMF 2026** (DOF 28-dic-2025), rubro B: publica **cinco** tarifas —
  diaria, 7, 10, 15 días y mensual. **No publica catorcenal.**
- **La regla de derivación**: diaria = mensual ÷ 30.4 redondeada a centavos;
  periodo = diaria × días. No está escrita en la LISR ni en su Reglamento, pero
  el divisor 30.4 sí aparece por escrito en el Decreto del subsidio, y la
  aritmética cierra: **134 comparaciones contra las tablas publicadas, cero
  discrepancias**, reproducidas por dos lecturas independientes del PDF y por
  una tercera derivación propia.

## Lo entregado

**`073_la_tarifa_que_si_es_de_este_ano.sql`.** Se teclea **una sola tabla** —la
mensual de 2026— y las otras cuatro se **derivan en SQL** desde ella: 44 de los
55 renglones no pueden tener un error de transcripción. La migración se **aborta
a sí misma** si la derivación deja de reproducir los valores que las dos
lecturas atribuyen al DOF (27.78, 194.46, 277.80, 416.70 y las cuotas 0.53,
3.71, 5.30, 7.95). La tarifa de 2025 no se borra: se le pone su ventana
(2025-01-01→2025-12-31), para que un recálculo de aquel ejercicio la encuentre.

**`tax_parameters` gana vigencia.** No es cosmético: la UMA entra en vigor el
**1 de febrero**, así que 2026 tiene dos, y con `UNIQUE(jurisdiction, tax_year)`
no cabían. La fila que había se queda como la ventana de **enero** —donde sus
valores son correctos— y la nueva cubre de febrero en adelante. Lo que estaba
mal no era la cifra: era pretender que valía los doce meses.

**El lector deja de mentir dos veces**: pregunta por FECHA en vez de por año, y
**lanza** en vez de devolver `{}`. Antes, el mismo dato ausente producía un
error en `isr-calculator` y una cifra inventada en `imss-calculator`
(`uma_daily || 113.14`) y en `infonavit-calculator` (`|| 0.05`).

**La calculadora elige la tarifa de su periodo**, y el periodo sin tabla
publicada **se niega con nombre**: la catorcena no está en el Anexo 8, y la
equivalencia `semimonthly` = quincenal no está en ninguna norma verificable.
Adivinarla sería repetir el defecto con otro número.

**El subsidio se prorratea** por la regla del propio decreto (÷ 30.4 × días).

## El resultado, medido

| | antes | después |
|---|---|---|
| semanal 3 000 | **0.00** | **248.82** |
| semanal 7 000 | 190.96 | **1 060.39** |
| quincenal 3 000 | 27.97 | 27.90 |
| mensual 7 000 | 190.96 | 156.63 |
| catorcenal / semimonthly | *silenciosamente mensual* | **se niega, con nombre** |

El mensual BAJA porque la tarifa de 2026 tiene los tramos más altos: también
estaba mal, en la otra dirección.

## Lo que NO se sembró, y por qué

El mandato al auditor era explícito: un «no lo sé, pregúntale al contador» es
respuesta válida; una cifra plausible sin fuente es el defecto. Rechazó tres:

- **La cuota del subsidio 2026.** La investigación traía $536.22, tomada de un
  **considerando** firmado nueve días antes de que el INEGI publicara la UMA.
  Lo que obliga es el artículo: 15.02 % de la UMA mensual = **535.65**. El
  decreto no dice cómo redondear. No se siembra una cifra que no cierra con su
  propia fórmula.
- **El tope de Social Security.** 168 600 en la semilla contra 184 500 en la
  documentación, sin fuente para ninguno.
- **La fecha de fin de vigencia de la UMA.** No es verificable desde el
  repositorio, así que no viaja como afirmación en el código.

## Y un diseño rechazado antes de escribirse

El panel propuso además una capa de parámetros cuyo lector podía devolver una
tarifa **parcial** —un tramo en vez de once— y calcular en silencio una
retención **negativa** (−127.98 sobre 3 000). El auditor lo midió y lo tumbó.
No se adoptó nada de él.

**Incidente de método, para que quede escrito:** los agentes escribieron en MI
worktree porque el prompt les dio su ruta además de pedir aislamiento. Once
archivos modificados y una migración entera del diseño rechazado. Se detectó
porque mi propia migración falló contra una columna que yo no había creado.
Árbol limpiado antes de seguir.

## Lo que queda de #91

- El **finiquito**: prima de antigüedad (art. 162 fr. III) e ISR de separación
  con su exención de 90 UMA — que lee exactamente el parámetro con vigencia
  que este tramo construye.
- El **tope de Social Security** y el **subsidio**, con sus issues.
- Llevar la **fecha del acto** hasta cada motor: hoy el lector la acepta y usa
  hoy por omisión, lo que es correcto para el periodo corriente y explícito en
  vez de tácito.
