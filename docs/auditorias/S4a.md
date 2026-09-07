# Auditoría adversarial de S4a «El instrumento se mide a sí mismo»

**Objeto:** el commit del tramo S4a, primera mitad de S4.
**Fecha:** 2026-09-02.
**Método:** tres agentes de motor → dos verificadores adversariales. El
adversarial escribió 23 ataques y confirmó **dos defectos de gravedad 1-2**,
uno de ellos en la propia sonda que este tramo estrenaba.

## El hallazgo, que es el más grave del día

Se saboteó `rls-policies.sql` sobre una base migrada de verdad y se corrió la
suite entera:

| sabotaje | resultado |
|---|---|
| `USING (true OR …)` en **las 20** políticas hijas | 1 fallo |
| `true OR …` sólo en `journal_entry_lines`, `invoice_lines`, `bill_lines` | **VERDE: 75 archivos, 984 pruebas, exit 0** |

Es decir: **con todo inquilino leyendo y escribiendo los renglones del mayor,
de las facturas y de las cuentas por pagar de todos los demás, la suite de
integración entera pasaba.** La única prueba que cazaba algo lo hacía por
accidente — existe porque hace poco se arregló un bug de clave foránea en esa
tabla, no porque nadie juzgara predicados.

Ese es el argumento entero de S4: un criterio que mide su propio texto informa
de su propio texto, y una suite que nunca comprueba el aislamiento certifica un
aislamiento que no existe.

## La sonda nueva era ciega a la política inofensiva más probable

Y aquí está la lección que da nombre al tramo. La sonda de RLS censaba las
políticas uniendo con `pg_depend … AND d.refobjsubid > 0` — o sea, pidiendo que
la política dependiera de alguna COLUMNA. Medido contra este Postgres:
`USING (true)`, `USING (1 = 1)` y `USING ((SELECT true))` producen **cero**
dependencias de columna, así que el JOIN las borraba de la lista **antes de
juzgarlas**.

Lo que lo vuelve instructivo: `1 = 1` y `(SELECT true)` **estaban en la lista
de catorce formas del implementador y se reportaron como cazadas**, porque en
su prueba viajaban por otro camino —tabla temporal, `pg_get_expr` y al juez—
que no pasaba por el censo. El instrumento afirmaba cubrir justo lo que no
miraba.

## Los criterios que ejecutan

Tres, sembrados con defectos que ya ocurrieron de verdad: el signo del saldo,
el barrido del cierre con contra-naturales, y el aislamiento por inquilino.
El adversarial los verificó con **tres roturas que el implementador no había
declarado** —quitarle la frontera de entidad a la balanza, dejar los gastos
fuera del cierre, y sustituir `entity_id = $2` por algo con forma de frontera
que no acota— y las tres ponen el criterio en rojo.

**La decisión de diseño que merece quedar escrita**: el escenario corre en un
**proceso hijo**. `config.database.url` se congela al importarse el módulo de
configuración, y ese módulo **ya está importado** cuando se evalúan los
criterios, así que cambiar `DATABASE_URL` a esas alturas no mueve el pool: un
criterio que creyera escribir en una base desechable **habría escrito en el
mayor de alguien**. El hijo lo hace imposible por construcción, no por
disciplina. Coste medido: 4 s para los tres, incluido un cierre anual completo.

Y sin base, el tablero **lo dice**: «aquí no corrió NINGUNO … en esta máquina
nadie midió una cifra». Un criterio que se salta en silencio es un verde falso.

## Los trinquetes que no apretaban

- **El de cobertura contaba LLAVES**: `(c.match(/'src\/…\.ts':/g)).length >= 3`.
  Poner los tres umbrales en cero lo dejaba verde. Ahora hay suelo por archivo
  y por métrica, y se comprobó en las cuatro direcciones: ceros → rojo, **una
  rebaja de un punto** → rojo, borrar una entrada → rojo, y un señuelo dentro
  de un comentario → rojo. Lo que el suelo NO compra queda dicho en el código:
  nada impide bajar umbral y suelo en el mismo commit — lo que compra es que
  el descenso deje de ser invisible.
- **La integración no declaraba cobertura**: 1 100 pruebas contra Postgres, las
  que de verdad ejercitan el dinero, no contaban para ninguna medida.
- **`npm run mutantes`** es ahora puerta propia y no un spec escondido en la
  suite, y su salida dice lo que un humano necesita — incluida su propia
  limitación: «los 58 criterios sin espejo no se midieron aquí; nadie sabe si
  muerden».

## Lo que la convivencia costó, y queda registrado

El árbol es compartido con otra sesión. Durante este tramo: un agente dejó un
`throw new Error('rotura al importar (simulada en el ataque de S4a)')` **sin
revertir** en `period-close.ts`, que tumbó la suite entera hasta que se retiró;
el merge de la otra sesión **revirtió** el paso de cobertura que este tramo
añadía a CI, y el arnés de mutación lo cazó al instante («el código cambió y el
espejo no»); y hubo que esperar a que su merge terminara para poder commitear,
con el trabajo guardado fuera del árbol mientras tanto.

Tres instrumentos crecieron porque el mundo creció, y ninguno se relajó:
la lista de tablas globales gana `mx_isn_tasas_estatales` **con su razón**, y
el sello pasa de nueve garantías a **diez** nombrando la que entró (la 067, que
impide vigencias solapadas del ISN).

## Lo reportado y NO hecho, con domicilio

- **130 de 133 criterios siguen leyendo el fuente.** Este tramo es una
  SEMILLA, no un cierre: pone el mecanismo y tres criterios. Decirlo de otro
  modo sería el mismo defecto que vino a matar.
- El corpus del agente bajo criterio y el instrumento de coste en dos
  renglones (entrega y garantía) → S4b.

## Veredicto

S4a **cierra como semilla**. El tablero ya distingue lo que ejecuta de lo que
lee —y lo publica en su última línea—, la RLS se juzga por su predicado y no
por su existencia, y los trinquetes leen valores. Lo que no puede decirse es
que el instrumento ya se mida entero: se mide en tres sitios, y esos tres son
donde más caro salía no medirse.
