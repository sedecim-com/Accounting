> **Lente 3 — «Doce sprints o sesenta»: el modelo de costes y la velocidad real.**
> Auditoría II sobre el árbol en `a149e62` (rama `fase-0-1-cli-y-cimientos`). Toda cifra de este informe se recalculó con `git`, con el medidor vivo, o se leyó del archivo citado. Nada viene de memoria.
>
> **Caveat de higiene:** durante esta sesión aparecieron cambios sin cometer en el árbol de trabajo (`src/ai/budget.ts`, `src/ai/untrusted.ts`, `src/ai/shadow-verdicts.ts`, migración `047`, pruebas A3-A4) que no estaban al inicio. **Todas las mediciones de este informe son sobre historia COMETIDA hasta `a149e62`**; el trabajo A3-A4 en vuelo no está contado ni a favor ni en contra.

---

## 0. El modelo original, recuperado verbatim

Vive en `docs/plan-catalogo.md` (no en un `doce-sprints.txt`: ese documento es el borrador del que salió este archivo; el artefacto HTML `scripts/artefacto/plantilla.html:1` lleva el título «Doce sprints o sesenta»).

**La aritmética fundacional** (`docs/plan-catalogo.md:8-12`):

> «Cerrar **una** fila del catálogo ha costado **390 líneas** de código y prueba, todo incluido.
> No es una estimación. Es lo que costaron las 50 filas que esta rama cerró: 15 772 líneas de entrega (CLI-1, CLI-2, CLI-3, IVA-3) más 1 780 del núcleo del CLI (CLI-0) más 1 946 de cola correctiva — defectos encontrados *después* de entregar, un 12,3 %.»

Verificado que el modelo es internamente consistente: `15 772 + 1 780 + 1 946 = 19 498`; `19 498 / 50 = 390,0`. Y `1 946 / 15 772 = 12,3 %` — la cola se divide entre la **entrega**, no entre el total. Esa convención importa y la conservo abajo.

**La escala** (`docs/plan-catalogo.md:14-20`): «Quedan **1 543 filas**» · «Filas pendientes × 390 líneas → **~602 000 líneas**» · «Todo el TypeScript que hoy tiene el repositorio ~91 000» · «Razón **6,6×**». Verificado: `1543 × 390 = 601 770`; `601 770 / 91 000 = 6,61`.

**El coste escalonado por estado de motor** (`docs/plan-catalogo.md:34-39`):

| Estado del motor | Filas | Coste unitario observado |
|---|---:|---|
| ✅ existe | 55 | ~250 líneas |
| 🟡 a medias | 150 | ~390 líneas |
| ❌ no existe | 100 | ~520 líneas |
| **Total** | **305** | **~124 000 líneas** |

Verificado: `55×250 + 150×390 + 100×520 = 124 250`.

**La unidad de sprint y el número de sprints** (`docs/plan-catalogo.md:42-43`):

> «A razón de una entrega del tamaño de CLI-1 —10 153 líneas, la mayor que este repositorio ha producido en un commit— **la fase 1 son unos 12 sprints**. Las fases 2 y 3 son otros ~48.»

Verificado hasta el commit: `1ede661` («CLI-1: 52 comandos sobre ocho servicios extraídos del handler», 2026-08-26) → `33 files changed, 10153 insertions(+)`, **todas** en `src/tests/scripts`. `124 250 / 10 153 = 12,2` ✅. `(1543−305) × 390 / 10 153 = 47,6` ✅.

**La tesis** (`docs/plan-catalogo.md:186`): «La alternativa —comprometerse con las 1 543— son unos sesenta sprints y seis veces el código actual.»

El modelo es, en una línea: **390 líneas/fila = 351 de entrega + 39 de cola correctiva**, y un sprint son 10 153 líneas.

---

## FORTALEZAS

**F1. El instrumento que la auditoría I pidió EXISTE, corre y da un número.** `scripts/costo-por-fila.ts` (5 331 bytes), cableado como `npm run costo:por-fila` en `package.json:23`. Corrido hoy sobre `a149e62` produce serie, no anécdota:

```
  commit   Δinv  líneas  líneas/fila  asunto
  2bf6630     4    2499          625  S0.6: las banderas dicen la verdad...
  5d24463    -2     114            —  S0.7: el catálogo deja de mentir...
  a6932b1    18    8471          471  F01: catálogo y asiento manual...
  a149e62     9    2042          227  F02: el espejo por entidad, el SAT de verdad...

Agregado desde S0.1: 31 fila(s) invocable(s) ganadas · 13126 líneas · 423 líneas/fila
```

Esto cierra la brecha 1 de la auditoría I en su enunciado literal («no tiene instrumento»).

**F2. El método del instrumento declara sus límites en vez de fingir exactitud** (`scripts/costo-por-fila.ts:15-27`): dice que «invocable ≠ fila cerrada con motor ✅ — es un PROXY, más duro que el original», que la cola dispersa se subestima, y que los segmentos con Δinv=0 cargan sus líneas al agregado *a propósito*. Es el patrón correcto de la casa: rojos honestos, método dicho.

**F3. El suelo del catálogo es una serie real y monótonamente auditable.** Cinco puntos verificados leyendo `docs/catalogo-minimos.json` en cada commit que lo tocó: `40a45af` 90/82 → `2bf6630` 94/86 → `5d24463` **92/84** (bajada honesta: corrección de doble conteo) → `a6932b1` 110/102 → `a149e62` 119/108. El «92 → 110 → 119» del encargo es exacto. `catalogo:estado --check` sale limpio hoy y el bloque generado regenera sin diff.

**F4. El coste TOTAL por fila del modelo se sostiene con precisión casi absurda.** Medido entre `5d24463` y `a149e62`: **10 520 líneas de código para 27 filas invocables = 389,6 líneas/fila**, contra las 390 del modelo. Es la primera vez que un número rector de este repositorio sobrevive a su propia re-medición.

**F5. El coste de ENTREGA es estable a través de 100 commits y dos unidades de cuenta distintas.** `1ede661` (CLI-1) entregó 52 comandos por 10 153 líneas = **195,2 l/comando**. `a6932b1`+`a149e62` (F01+F02) entregaron 27 filas por 5 409 líneas = **200,3 l/fila**. Dos mediciones independientes, separadas por cinco días y ~100 commits, coinciden dentro del 3 %. El coste marginal de teclear un comando en este repositorio es un número real y conocido: **~200 líneas**.

**F6. Los conteos del encargo se verifican todos.** Medidor vivo: 134 comandos / 45 familias; 119 de 1624 filas invocables (7,3 %); motor 191 ✅ / 426 🟡 / 1007 ❌; fase 1 **379 filas, 108 tecleables**; objetivo comprometible 1380 (`docs/cli-command-catalog.md:52-58`). Pendientes calculados sobre las filas mismas: fase 1 → **271** (47 ✅ / 129 🟡 / 95 ❌); comprometible → **1261** (100 ✅ / 400 🟡 / 761 ❌).

---

## LA VELOCIDAD REAL, MEDIDA

Inserciones de código (`src`+`tests`+`scripts`, `git show --numstat`) por cada commit nombrado, cruzadas con el movimiento del suelo:

| commit | fase | +líneas código | Δ invocables |
|---|---|---:|---:|
| `205e1e0` | S1 (13 ítems de la auditoría) | 890 | 0 |
| `d2eef08` | R1 (mayor inviolable) | 634 | 0 |
| `0f17dcf` | gobernanza repo | 0 | 0 |
| `e282fe4` | R2 (perímetro) | 697 | 0 |
| `aeb85c0` | Apache 2.0 | 0 | 0 |
| `5c7dc8e` | fix RLS (`TO rol`) | 22 | 0 |
| `2cd656e` | R3 (serie/refresco) | 551 | 0 |
| `5ec9750` | A1-A2 (golden set + arnés) | 2 317 | 0 |
| `a6932b1` | **F01** | **3 367** | **+18** (92→110) |
| `a149e62` | **F02** | **2 042** | **+9** (110→119) |
| | **TOTAL** | **10 520** | **+27** |

### ¿Se sostienen las 390 líneas por fila? Sí en el total, no en su composición.

| | Modelo (50 filas, `plan-catalogo.md:10-12`) | Medido (27 filas, `5d24463..a149e62`) |
|---|---:|---:|
| Entrega de filas | 351,0 l/fila | **200,3** l/fila |
| Todo lo demás (núcleo, garantías, cola) | 38,9 l/fila | **189,3** l/fila |
| **Total** | **390,0** | **389,6** |

**El 390 sobrevive por cancelación, no por acierto.** La entrega se abarató un 43 % (351 → 200) y lo que no es entrega se encareció **4,9×** (39 → 189). El modelo acertó la suma y erró los dos sumandos. Presupuestar con la composición vieja —«casi todo es entrega, la cola es un 12 %»— produce un plan que se queda sin presupuesto a la mitad de cada tramo, porque **por cada línea que cierra una fila, este repositorio escribe hoy 0,94 líneas de garantía** (5 409 entrega : 5 111 garantía).

### La cola correctiva: el número del instrumento es un falso verde

El instrumento imprime `Cola correctiva declarada: 111 de 15025 líneas = 0.7%` junto a la referencia de 12,3 %. Un lector concluye que la cola se desplomó 17×. **Es al revés.**

La causa es `scripts/costo-por-fila.ts:67`: `const CORRECTIVO_RE = /^AUD-|falso verde|corrig|repara/i;` — clasifica por el **asunto** del commit. En la ventana `40a45af..a149e62` el único commit cuyo asunto casa es `f41f6cc` («AUD-6: los tres falsos verdes…», 111 líneas). Todo el trabajo correctivo posterior a la auditoría integral viaja bajo asuntos que la regex no ve: «S1: la verdad del tablero», «R1: el mayor inviolable», «R2: el perímetro que faltaba», «R3: la serie la fija la fecha».

Medida a mano, bajo la definición del propio modelo («defectos encontrados *después* de entregar»), con la convención del modelo (correctivo ÷ entrega):

| Lectura | Correctivo | Entrega | Cola |
|---|---:|---:|---:|
| Máxima (S1+R1+R2+RLS+R3 son todos respuesta a auditoría) | 2 794 | 5 409 | **51,7 %** |
| Media (A1-A2 cuenta como entrega) | 2 794 | 7 726 | **36,2 %** |
| Mínima conservadora (sólo S1 + fix RLS son estrictamente correctivos) | 912 | 7 726 | **11,8 %** |
| **El modelo** | 1 946 | 15 772 | **12,3 %** |
| **Lo que el instrumento imprime** | 111 | 15 025 | **0,7 %** |

Bajo **toda** convención razonable la cola está entre 11,8 % y 51,7 %. El instrumento la subestima por un factor de **17× a 74×**. El único número que S1 construyó para dejar de mentir, miente.

Agravante metodológico (`scripts/costo-por-fila.ts:63` vs `:76`): `lineasEntre` filtra a `src|tests|scripts`; `colaCorrectiva` cuenta **todos** los archivos, docs incluidos. La tabla y el porcentaje del mismo informe se calculan sobre universos distintos, así que el porcentaje no es comparable ni con su propia tabla.

### La unidad «sprint» no es la unidad en la que este repositorio entrega

El documento definió sprint = 10 153 líneas (CLI-1, `1ede661`). El commit de entrega más grande de los últimos 60 commits es F01 con 3 367 líneas; la media de F01/F02 es 2 705. **Un «sprint» del documento son 3,8 commits de entrega del tamaño que este repositorio produce hoy.** Y la tasa observada es 13,5 filas por commit de entrega (18 y 9).

---

## La respuesta al «cuántos sprints faltan», con su aritmética

Base verificada: fase 1 son **379 filas, 108 tecleables → 271 pendientes** (47 ✅ / 129 🟡 / 95 ❌). Objetivo comprometible **1380 filas, 119 invocables → 1261 pendientes** (100 ✅ / 400 🟡 / 761 ❌). Repositorio en `a149e62`: **103 868 líneas** de TypeScript en `src`+`tests`+`scripts` (`git ls-tree`).

**Fase 1 — lo comprometido:**

- Escalonado con las tarifas del modelo: `47×250 + 129×390 + 95×520 = 11 750 + 50 310 + 49 400 = 111 460 líneas` → `111 460 / 10 153 = ` **10,98 sprints**
- Plano con el coste medido hoy: `271 × 390 = 105 690 líneas` → `105 690 / 10 153 = ` **10,41 sprints**

→ **Faltan 10 a 11 sprints para la fase 1.** El documento prometió 12 desde 305 filas pendientes; se cerraron 34 y quedan ~11. **La promesa de los doce sprints se sostiene en su primera medición real** — y va ligeramente por delante.

Dicho en la unidad honesta: 111 460 líneas es **1,07 veces todo el TypeScript que hoy existe**. Terminar la fase 1 es escribir este repositorio otra vez. Y en commits del tamaño que se producen hoy: `271 / 13,5 = ` **~20 commits de entrega**, más su garantía (≈0,94 líneas por línea entregada).

**Las 1380 filas comprometidas — el escenario «sesenta»:**

- Escalonado: `100×250 + 400×390 + 761×520 = 25 000 + 156 000 + 395 720 = 576 720 líneas` → **56,8 sprints**, **5,55 veces el repositorio**
- Plano a 390: `1261 × 390 = 491 790 líneas` → **48,4 sprints**, **4,73 veces el repositorio**

→ **«Doce sprints o sesenta» se lee hoy, medido, como «once o cincuenta y siete».** La tesis original no sólo sobrevive: es la primera cifra rectora de este repositorio que la re-medición confirma. Lo que NO sobrevive es su interior — la mezcla entrega/garantía y la cola correctiva.

---

## BRECHAS

### Dictamen sobre las seis brechas de la auditoría I (`docs/auditorias/2026-08-31-integral/doce-cobertura.md`)

**B1 — El modelo de costes se midió una vez y no tiene instrumento. → CERRADA-DESDE-AUDITORIA-I.**
`scripts/costo-por-fila.ts` existe, corre y produce serie (`package.json:23`). El enunciado literal («no tiene instrumento») ya no es cierto. El residuo se abre abajo como B7–B11: cerrar esta brecha creó cinco nuevas.

**B2 — «Un criterio se prueba por mutación» es prosa sin mecanismo. → SIGUE-ABIERTA.**
`tests/plan/criterios.spec.ts` sigue teniendo **98 líneas y 12 pruebas**, exactamente lo que la auditoría I citó («criterios.spec.ts:1-98»). No existe ningún espejo que neutralice la conducta medida ni meta-criterio que cuente criterios sin espejo (`grep "espejo" tests/plan/*.ts`: vacío). Sí **mutó** en un sentido valioso: las mutaciones ejecutadas a mano quedaron registradas en comentarios del instrumento (`src/plan/criterios.ts:498`, `:1435`) — pero un comentario no lo vuelve a correr CI. El Plan Maestro §7 declara «ahora con mecanismo»; el mecanismo no está en el árbol.

**B3 — La auditoría adversarial por flujo es disciplina, no puerta. → SIGUE-ABIERTA (mutada).**
Ahora **hay** compuerta: criterio E0.0 «Un flujo no se declara cerrado sin su auditoría adversarial registrada» (`src/plan/criterios.ts:235`), y E0.0 está en `--exigir` (`.github/workflows/ci.yml:94`). Pero su registro está **vacío** (`src/plan/criterios.ts:243-245`):

```ts
const FLUJOS_CERRADOS: Record<string, string> = {
  // 'F01': 'docs/auditorias/F01.md',
};
```

y `docs/auditorias/` contiene sólo `2026-08-31-integral`. **F01 (`a6932b1`) y F02 (`a149e62`) se cerraron después de instalar la compuerta y ninguno se inscribió.** La compuerta es autodeclarativa: sólo acusa a quien se acuse a sí mismo. El enunciado literal de la auditoría I —«nada impide declarar cerrado un flujo F0x sin su auditoría»— sigue siendo cierto palabra por palabra.

**B4 — «doctor sin huérfanos nuevos entra como criterio» no existe. → CERRADA-DESDE-AUDITORIA-I.**
`src/plan/criterios.ts:745`, enunciado «La capacidad huérfana conocida sólo encoge», con lista congelada — el patrón de las 40 violaciones del CLI, aplicado.

**B5 — Las cifras estampadas del Plan Maestro no casan con su commit. → SIGUE-ABIERTA (recurrió).**
El artefacto vivo (`plan-maestro.html`, mtime 23:27 del 31-ago, un minuto **después** de `a149e62` 23:26) sigue portando cifras caducas: §1 dice «108 comandos vivos» y «379 / 84 fase 1: filas / tecleables» cuando el medidor de ese mismo commit dice **134 comandos** y **379 / 108**; y §6 dice «fase 1 — 378 filas al medidor de hoy» mientras §1 de la misma página dice 379. El documento se contradice a sí mismo en dos secciones y contradice al medidor en tres cifras — en la página cuyo §7 promete «las cifras de esta página llevan commit y se re-preguntan, y la §1 se corrige en cada republicación o no se publica».

**B6 — La vigilancia de la cola larga F09-F12 no tiene instrumento. → SIGUE-ABIERTA.**
`grep "F09"` sobre `docs/cli-command-catalog.md`: vacío. El bloque generado no publica el tamaño de la cola ni su serie. La regla «si tres sprints seguidos no la bajan, el orden se revisa» sigue sin dato que la haga comprobable. El Plan Maestro la mantiene en futuro: «El medidor **publicará** el tamaño de la cola».

### Brechas NUEVAS

**B7 (NUEVA, grave) — El número de cola correctiva que el instrumento publica es un falso verde de 17× a 74×.**
`scripts/costo-por-fila.ts:67` clasifica correctivo por el **asunto** del commit (`/^AUD-|falso verde|corrig|repara/i`). Resultado impreso: 0,7 %. Medición honesta de la misma ventana bajo la definición del modelo: entre 11,8 % (lectura mínima: sólo `205e1e0`+`5c7dc8e`) y 51,7 % (lectura máxima: S1+R1+R2+RLS+R3 = 2 794 líneas ÷ 5 409 de entrega). Y el instrumento lo imprime **junto a** la referencia de 12,3 %, que es exactamente la invitación a concluir que la cola se resolvió. Es la clase de defecto que AUD-6 purgó —una regex que mide la prosa en vez del hecho— cometida por el instrumento nuevo.

**B8 (NUEVA) — El instrumento mezcla dos universos de archivos en el mismo informe.**
`scripts/costo-por-fila.ts:63` restringe las líneas a `src|tests|scripts`; `:76` cuenta la cola sobre **todos** los archivos. El porcentaje no es comparable con la tabla que lo precede en la misma salida.

**B9 (NUEVA) — El desglose por estado de motor, que era el corazón de la recomendación 1 de la auditoría I, no se implementó.**
La recomendación pedía «recalcule líneas/fila **por estado de motor** y el % de cola correctiva». El script entrega lo segundo (mal, B7) y **nada** de lo primero. Las tarifas ✅250 / 🟡390 / ❌520 —las que el plan de sprints usa para presupuestar, y las que determinan que las 761 filas ❌ del objetivo comprometible cuesten 395 720 de las 576 720 líneas restantes— **siguen sin una sola re-medición.** El 79 % del presupuesto pendiente descansa en una tarifa (❌520) que nunca se comprobó.

**B10 (NUEVA) — El instrumento no está cableado a nada y es invisible al detector de huérfanos.**
`grep -rl "costo-por-fila"` sobre el árbol (excluyendo worktrees) devuelve exactamente tres archivos: el script, `package.json:23`, y los dos informes de la auditoría I que lo pidieron. No está en `.github/workflows/ci.yml`, ni en el bloque generado (`grep "costo" scripts/catalogo-estado.ts`: vacío), ni en `src/plan/criterios.ts` (allí «costo» sólo aparece en comentarios de `:1916-1917` y `:2086`, sobre otro tema), ni en ninguna prueba. Sus tres exports (`puntosDeSuelo`, `lineasEntre`, `colaCorrectiva`) no tienen ni un consumidor — **capacidad huérfana de manual**— y `doctor` no puede verla porque `src/ai/orphan-scan.ts:104` sólo escanea exports de `src/`, nunca de `scripts/`. Un número que nadie corre no es un instrumento: es un script. La brecha 1 se cerró en la letra y no en el espíritu.

**B11 (NUEVA) — El plan presupuesta con la composición equivocada del coste.**
El Plan Maestro §6 sigue declarando el modelo congelado («~250 ✅, ~390 🟡, ~520 ❌, cola correctiva 12,3 %») y añade, en presente, «si el costo real de las ~42 filas nuevas divergió, **hoy nadie lo sabría**» — frase escrita *después* de que S1 entregara el instrumento, y que el instrumento ya podía contestar. Peor: §6 declara la cola de 12,3 % «constante del oficio» confirmada por AUD-5 y por la auditoría integral. La medición de esta auditoría dice lo contrario: en la ventana post-auditoría la cola está entre 11,8 % y 51,7 %, y la garantía por línea entregada es 0,94, no 0,12. El plan lleva razón en el total y va a quedarse corto en cada tramo.

**B12 (NUEVA, menor pero conviene decirla) — Los dos «390» no comparten unidad de cuenta.**
El 390 fundacional se calculó sobre «50 filas» de commits que declaran otra cosa: `1ede661` dice «**52 comandos**» por sí solo, y era anterior a que S0.1 fijara la unidad (los «136 comandos» del documento incluían 30 menús; hoy son 134/119 bajo la unidad de S0.1). El 389,6 que mido usa el suelo de invocables, un proxy declaradamente más duro. **La coincidencia de los dos números al 0,1 % es notable pero no es una validación**, y presentarla como tal sería el mismo pecado que este lente audita. Lo que sí es sólido y comparable es el coste de entrega: 195,2 l/comando (CLI-1) vs 200,3 l/fila (F01+F02).

---

## RECOMENDACIONES

Ordenadas por lo que desbloquean. La fase es la del Plan Maestro; el tramo natural para las cuatro primeras es un **S2 de garantías antes de F03** —el mismo lugar donde S1 puso el instrumento— porque presupuestar F03–F12 con la composición vieja es empezar los diez sprints restantes con el presupuesto mal repartido.

1. **(S) Arreglar la clasificación de la cola correctiva antes que cualquier otra cosa** — tramo S2/garantías, prerequisito de §6 del Plan Maestro. El asunto del commit no puede ser el clasificador: sustituirlo por un *trailer* declarado (`Cola-correctiva: sí|no`, o mejor `Corrige: E1.2, AUD-6`) más un criterio que rechace un commit de código sin él. Mientras tanto, y en el mismo cambio, imprimir la banda honesta en vez de un número solo: el instrumento debe decir «entre 12 % y 52 % según convención» antes que decir «0,7 %». *Un instrumento que publica un falso verde es peor que no tener instrumento, porque cierra la pregunta.*

2. **(S) Unificar los universos de archivo del instrumento** — mismo tramo. `colaCorrectiva` debe filtrar a `src|tests|scripts` igual que `lineasEntre` (`scripts/costo-por-fila.ts:63` vs `:76`), o publicar ambos totales por separado con su etiqueta. Hoy el porcentaje y la tabla no son comparables entre sí.

3. **(S) Publicar entrega y garantía como dos renglones, no como uno** — mismo tramo. El total de 390 es correcto y engañoso; los números accionables son **200 de entrega + 190 de garantía**, y la razón **0,94 líneas de garantía por línea entregada**. Es una línea de salida más y cambia cómo se presupuesta cada F0x.

4. **(M) Implementar el desglose por estado de motor que la auditoría I pidió y no se entregó** — mismo tramo. Cruzar las filas que ganaron `viva` en cada segmento contra su celda ✅/🟡/❌ (el parser ya existe: `filasCompletas` en `scripts/catalogo-estado.ts:201` expone `estado` y `fase`) y publicar tres tarifas medidas. **Es la recomendación con más apalancamiento del informe**: 761 filas ❌ × 520 = 395 720 líneas, el 69 % de todo el presupuesto restante del objetivo comprometible, apoyado en una tarifa jamás re-medida.

5. **(M) Publicar el costo en el bloque generado y darle criterio con espejo** — mismo tramo, y cierra B10 junto con B2. Mismo patrón que `catalogo:estado`: el número vive en `docs/cli-command-catalog.md`, `--check` lo compara en CI (`.github/workflows/ci.yml:102` ya tiene el gancho), y un criterio nuevo en `src/plan/criterios.ts` entra a `--exigir`. Por la regla de la casa (c), llega con su espejo en `tests/plan` que neutraliza el movimiento del suelo y **afirma el rojo** — sería el primer espejo del repositorio y el prototipo que B2 lleva esperando desde la auditoría I.

6. **(S) Extender `orphan-scan` a los exports de `scripts/`** — `src/ai/orphan-scan.ts:104` sólo lee `src/`. Es un cambio de una línea que habría hecho visible este mismo hallazgo sin auditoría humana, y protege a todo instrumento futuro de nacer huérfano. Nunca `fail`, capacidad informativa, como manda la nota de la casa.

7. **(S) Inscribir F01 y F02 en `FLUJOS_CERRADOS` con su registro, o admitir que la compuerta es decorativa** — `src/plan/criterios.ts:243`. Dos flujos se cerraron después de instalar la puerta y ninguno pasó por ella. Si el registro va a quedar vacío, el criterio E0.0 debe decir en su salida «0 flujos inscritos: esta compuerta aún no ha acusado a nadie» en vez de un `ok` que se lee como cumplimiento.

8. **(S) Publicar el tamaño de la cola F09-F12 en el bloque generado** — cierra B6, que lleva dos auditorías abierta. Sin ese dato la regla de los «tres sprints seguidos» no es comprobable, y es la única regla que puede reordenar el plan.

9. **(S) Regenerar §1 y §6 del Plan Maestro con el medidor, o retirarles las cifras** — el artefacto porta hoy 108/84 donde el medidor dice 134/108, y se contradice a sí mismo (§1: 379, §6: 378). B5 recurrió en la republicación siguiente a que la auditoría I la señalara: eso ya no es un descuido, es que el documento no tiene mecanismo para re-preguntar. O las cifras se generan, o no se estampan.

10. **(M) Corregir la tesis de §6 con lo medido** — no la conclusión, que se confirma, sino su interior. La redacción correcta hoy es: *«el coste total por fila se re-midió y da 390 —la cifra fundacional se sostiene—, pero la entrega bajó a 200 y la garantía subió a 190; la cola correctiva no es una constante del 12 %, es una banda del 12 % al 52 % que depende de si hubo auditoría en la ventana; faltan 10-11 sprints para fase 1 y 48-57 para las 1380»*. Es una de las pocas ocasiones en que el plan puede citar una cifra suya **confirmada por medición** — conviene que la cite bien.


---

## VERIFICACIÓN ADVERSARIA DEL HALLAZGO MAYOR

**Hallazgo:** La velocidad real confirma el modelo en su total (389,6 líneas/fila medidas sobre 27 filas y 10 520 líneas entre 5d24463 y a149e62, contra las 390 de docs/plan-catalogo.md:8) pero lo refuta en su composición y en su cola: la entrega bajó de 351 a 200 l/fila mientras la garantía subió de 39 a 189, y el instrumento que S1 construyó para vigilarlo imprime «0,7 % de cola correctiva» cuando la medición honesta de esa misma ventana da entre 11,8 % y 51,7 % — un falso verde de 17× a 74× cuya causa es la regex de asunto en scripts/costo-por-fila.ts:67.

**¿Refutado?** No: se sostiene

SE SOSTIENE, y el núcleo mecánico es literal. Reproduje los tres bloques.

(1) LA CIFRA TOTAL — exacta. Sumando `git show --shortstat -- src tests scripts` commit a commit en 5d24463..a149e62: 890+634+697+22+551+2317+3367+2042 = 10 520 líneas. El suelo `docs/catalogo-minimos.json` pasa de 92 invocables en 5d24463 a 119 en a149e62 = 27 filas. 10 520/27 = 389,63 contra las 390 de docs/plan-catalogo.md:8. MATIZ IMPORTANTE: eso NO es lo que el instrumento imprime. `npx tsx scripts/costo-por-fila.ts` hoy publica «31 fila(s) · 13126 líneas · 423 líneas/fila» sobre su serie completa desde 40a45af (S0.1). El 389,6 es una subventana elegida por el auditor (arranca en 5d24463, deja fuera el segmento S0.6 de 625 l/fila y el de Δinv=−2). El «confirma el modelo» vale para esa ventana, no para el titular del tablero.

(2) LA COMPOSICIÓN — aritmética exacta, taxonomía discutible. Entrega = F01 (a6932b1, 3367) + F02 (a149e62, 2042) = 5409/27 = 200,3. Residual = S1 890 + R1 634 + R2 697 + RLS 22 + R3 551 + A1-A2 2317 = 5111/27 = 189,3. El par fundacional sale de docs/plan-catalogo.md:10-12: (15 772 entrega + 1 780 núcleo)/50 = 351,0 y 1 946/50 = 38,9. Pero los dos cubos de la derecha no son el mismo cubo: el 39 del documento es estrictamente «cola correctiva — defectos encontrados *después* de entregar» (plan-catalogo.md:11-12), mientras el 189 es todo-lo-que-no-es-F01/F02, y 2 317 de sus 5 111 líneas (45 %) son A1-A2 (5ec9750, «golden set, arnés fijado y ai stats») — capacidad de medición nueva, no reparación; R2 (e282fe4, «el perímetro que faltaba», 697) tampoco es reparación de defecto entregado. Como-por-como (R1+R2+R3+RLS = 1 904 líneas de código) la cola sube a 70,5 l/fila: 39 → 71 (1,8×), no 39 → 189 (4,8×).

(3) LA COLA Y SU CAUSA — confirmado, y peor de lo que la nota del script admite. La línea es scripts/costo-por-fila.ts:68 (la 67 está en blanco): `const CORRECTIVO_RE = /^AUD-|falso verde|corrig|repara/i;`. Clasifiqué los 18 commits de la ventana del instrumento (40a45af..a149e62) contra esa regex: acierta UNO, f41f6cc «AUD-6: los tres falsos verdes del tablero…», 111 inserciones de 15 025 = 0,739 % → imprime 0,7 %. Pasan como no-correctivos d2eef08 «R1: el mayor inviolable» (634), e282fe4 «R2: el perímetro que faltaba» (1 072), 2cd656e «R3: la serie la fija la fecha…» (552), 5c7dc8e «RLS: una política TO rol…» (22), abb7f60 «Auditoría integral» (305) y 205e1e0 «S1: la verdad del tablero» (1 341) — la convención de asuntos del repo no usa prefijo AUD- ni las palabras corrig/repara. No existe clasificador alternativo con otro nombre ni en otro módulo: `grep -rn "CORRECTIVO\|colaCorrectiva\|falso verde" scripts src tests` sólo cae en costo-por-fila.ts (24, 68, 70, 80, 114) y en dos comentarios de src/plan/criterios.ts:1254,1595. Tampoco hay prueba que cubra el instrumento.

El 51,7 % del hallazgo reproduce EXACTO: (305+1341+634+1072+22+552+2330)/12 112 inserciones totales de 5d24463..a149e62 = 51,65 %. El 11,8 % NO lo pude reproducir con ninguna clasificación evidente: el conjunto estricto R1+R2+R3+RLS da 18,8 % sobre 12 112 (18,1 % código-sobre-código, 15,2 % sobre los 15 025 de la ventana del propio instrumento); el suelo defendible más bajo que construí es 10,0 % (R1+R3+RLS, excluyendo R2 por ser perímetro nuevo). Y los múltiplos usan el 0,7 % redondeado: contra el 0,739 % real son 13×–70×, no 17×–74×.

MATIZ FINAL sobre «falso verde»: el script no afirma que ese número sea la cola verdadera — la línea 120 lo rotula «Cola correctiva **declarada** (asuntos AUD-*/correctivos)» y las líneas 23-25 y 123 confiesan que subestima. Pero confiesa el límite equivocado: dice que subestima «la cola dispersa en commits mixtos», y lo que aquí se pierde son commits correctivos ÍNTEGROS y dedicados (2 280 líneas en R1/R2/R3/RLS). Y lo imprime dos líneas por encima de «Referencia fundacional … 12.3% de cola» (línea 122) sin nada que advierta que no son comparables. Es falso verde en el efecto, no en la afirmación.

**Formulación corregida:** La velocidad medida confirma el orden de magnitud del modelo en la ventana 5d24463..a149e62 (10 520 líneas de src/tests/scripts sobre 27 filas invocables ganadas, 92→119 en docs/catalogo-minimos.json = 389,6 l/fila contra las 390 de docs/plan-catalogo.md:8) —aunque el titular que el instrumento realmente imprime sobre su serie completa desde S0.1 es 423 l/fila, y el 389,6 exige elegir esa subventana—, pero desplaza su composición: la entrega baja de 351 l/fila (los 15 772+1 780 sobre 50 filas de plan-catalogo.md:10-11) a 200 (F01 3 367 + F02 2 042 = 5 409/27), mientras el residual de garantía sube a 189 (5 111/27). Ese 189 no es comparable con el 39 fundacional: el 39 es cola correctiva estricta (plan-catalogo.md:11-12) y el 189 incluye 2 317 líneas de A1-A2 (capacidad de medición nueva) y 697 de R2 (perímetro que faltaba); la comparación como-por-como es 39 → 70,5 l/fila (R1+R2+R3+RLS = 1 904 líneas), un 1,8×, no un 4,8×.

Lo que sí es un falso verde neto es el porcentaje de cola: la regex de asunto `^AUD-|falso verde|corrig|repara` de scripts/costo-por-fila.ts:68 (la 67 está en blanco) acierta un solo commit de los 18 de su ventana —f41f6cc «AUD-6…», 111 de 15 025 inserciones— y por eso imprime 0,7 %, mientras dejan de contar commits correctivos íntegros cuyos asuntos siguen la convención del repo: R1 (d2eef08, 634), R2 (e282fe4, 1 072), R3 (2cd656e, 552), RLS (5c7dc8e, 22), más la auditoría (abb7f60, 305) y S1 (205e1e0, 1 341). Una medición honesta de la misma ventana da entre ~10 % y 18,8 % con criterio estricto y 51,7 % con criterio amplio —el 11,8 % citado no se reproduce con ninguna clasificación evidente—, es decir un factor de 13× a 70× sobre el 0,739 % real (el «17× a 74×» sale de redondear a 0,7 %). El script declara que subestima, pero declara el límite equivocado —«la cola dispersa en commits mixtos» (líneas 23-25)— cuando lo que pierde son commits correctivos completos, y coloca el 0,7 % dos líneas encima del «12.3 % de cola» fundacional (línea 122) sin advertir que no son comparables. No hay clasificador alternativo en el repo ni prueba que cubra el instrumento.

