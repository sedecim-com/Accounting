# Plan para cerrar el catálogo de comandos

> Derivado de medir lo que este repositorio ha producido, no de estimar lo que podría producir.
> Estado en vivo: `npm run catalogo:estado` · `npm run plan:status`
> **Re-medido el 2026-09-01** contra siete fases entregadas (auditoría integral II, lente
> [doce-cobertura](auditorias/2026-09-01-integral-ii/doce-cobertura.md)). La versión anterior de este
> documento midió una vez, en agosto; ésta la contrasta contra datos nuevos y dice qué sobrevivió.

## La aritmética, antes que nada

Cerrar **una** fila del catálogo cuesta **390 líneas** de código y prueba, todo incluido.

Ese número se estimó en agosto sobre 50 filas. Se volvió a medir en septiembre sobre las **27 filas**
que cerraron F01 y F02, con las **10 520 líneas** del tramo `5d24463…a149e62`: **389,6**.

El total sobrevivió. La **composición** no:

| | agosto | septiembre | |
|---|---:|---:|---|
| Entrega — el comando y su servicio | 351 | **200** | ▼ 43 % |
| Garantía — pruebas, criterios, correcciones | 39 | **189** | ▲ 385 % |
| **Total por fila** | **390** | **390** | = |

**Por cada línea entregada hoy se escriben 0,94 líneas de garantía.** En agosto eran 0,11. El
sistema no se volvió más caro: cambió en qué se gasta. El kernel de la CLI, los patrones y el
tablero ya construidos hicieron que un comando nuevo cueste sobre todo su servicio — y a cambio,
cada comando llega con criterios verificados por mutación, pruebas de integración contra Postgres
real y correcciones de lo que esas pruebas destaparon.

Es una noticia buena disfrazada de neutra: **la mitad del presupuesto de cada fila es ahora
reutilizable**. Los criterios y los arneses no se vuelven a escribir en la fila siguiente.

### El número que no se ha vuelto a medir, y que decide el 69 % del presupuesto

De las filas que faltan, **761 están marcadas ❌** —motor inexistente— y se presupuestan a **520
líneas** cada una: **395 720 líneas, el 69 % de todo lo que resta**. Esa tarifa de 520 se estimó
en agosto y **nunca se re-midió**, porque el instrumento no cruza las filas que ganó cada tramo
contra su estado de motor.

Es la incertidumbre dominante de este plan. Cualquier otra afinación mueve decimales; ésta mueve
cientos de miles de líneas en las dos direcciones.

---

## El instrumento que vigila esto publica un falso verde

`scripts/costo-por-fila.ts` existe desde S1 para que este documento no vuelva a ser una medición de
una vez. Hoy **imprime 0,7 % de cola correctiva** donde la medición honesta de la misma ventana da
entre **11,8 % y 51,7 %** según la convención que se use: un falso verde de 17× a 74×.

La causa es que clasifica por el **asunto del commit**, y los asuntos de esta casa son narrativos
(«R3: la serie la fija la fecha…») en vez de etiquetados. Además cuenta la cola sobre todo el árbol
y la entrega sólo sobre `src|tests|scripts`, así que el porcentaje y la tabla ni siquiera son
comparables entre sí.

**Un instrumento que publica un falso verde es peor que no tener instrumento, porque cierra la
pregunta.** Arreglarlo es la primera partida de S2 (abajo).

---

## Dónde estamos, medido

| | |
|---|---:|
| Comandos que el binario ejecuta | **134** en 45 familias |
| Filas invocables, de 1 624 | **119** (7,3 %) |
| **Fase 1: invocables de 379** | **108** |
| Filas de fase 1 que faltan | **271** |
| TypeScript del repositorio | **105 535** líneas |

### Lo que falta, en líneas

| | a 390 (medido) | sólo entrega (200) |
|---|---:|---:|
| **Fase 1** — 271 filas | **~105 700** | ~54 200 |
| Objetivo comprometible — 1 261 filas | ~491 800 | ~252 200 |

Fase 1 sigue siendo **aproximadamente el repositorio entero otra vez**. A razón de una entrega del
tamaño de la mayor que este repositorio ha producido en un commit (~10 150 líneas), son **unos diez
sprints** — el «doce sprints» de agosto sobrevivió a la re-medición con dos de holgura.

El objetivo comprometible completo son ~48 sprints más. Sigue sin recomendarse, y ningún dato nuevo
lo sostiene.

---

## S0 se cerró; lo que viene es S2

Los cinco trabajos de S0 —el medidor, la migración que caducaba, la fuga de la frontera del agente,
el conflicto de dueño y el recorte de alcance— **están hechos** (`40a45af…5d24463`). El recorte dejó
el objetivo en 1 380 filas y la fase 1 en 379.

Lo que la auditoría II encontró es que hace falta un tramo equivalente **antes de F03**, por la
misma razón que S0 fue antes que F01: presupuestar diez sprints con la composición vieja es empezar
con el presupuesto mal repartido, y varias de las garantías que este plan da por buenas no lo son.

### S2 · Las garantías, antes de seguir entregando

1. **La cola correctiva se clasifica por declaración, no por adivinanza.** Un *trailer* en el commit
   (`Corrige: E1.2, AUD-6`) y un criterio que rechace un commit de código sin él. Mientras tanto, el
   instrumento publica la **banda** («entre 12 % y 52 % según convención»), no un número solo.
2. **Los dos universos de archivo se unifican.** `colaCorrectiva` filtra a `src|tests|scripts` igual
   que `lineasEntre`, o se publican los dos totales por separado con su etiqueta.
3. **Entrega y garantía se publican como dos renglones.** El total de 390 es correcto y engañoso;
   los números accionables son 200 + 190.
4. **La tarifa por estado de motor se mide.** Cruzar las filas que cada tramo volvió invocables
   contra su celda ✅/🟡/❌ y publicar tres tarifas medidas. El parser ya existe
   (`filasCompletas` en `scripts/catalogo-estado.ts`). **Es la partida con más apalancamiento de
   todo el documento.**
5. **El costo entra al bloque generado y gana criterio con espejo.** Mismo patrón que
   `catalogo:estado`: el número vive en el documento, `--check` lo compara en CI, y el criterio
   llega con su espejo en `tests/plan` que neutraliza la conducta y afirma el rojo.

---

## Qué NO se recorta

**La cola larga no es relleno.** 190 familias de menos de diez comandos concentran el 41,5 % del
catálogo, y dentro de ellas hay **179 filas de fase 1** que nadie puede saltarse. 24 familias tienen
un solo comando.

Es el riesgo estructural de este plan: no es trabajo concentrado que se pueda atacar en bloque, son
190 cosas pequeñas. Un plan ordenado por familias grandes deja ese 41,5 % como «el resto» y no lo
cierra nunca.

---

## Los sprints de fase 1 se ordenan por FLUJO, no por familia

Terminar media familia `bank` —120 comandos— no le entrega nada a nadie. «Recibo un CFDI, lo
contabilizo, lo pago y concilio el pago contra el estado de cuenta» cruza cinco familias y es algo
que alguien usa el lunes.

Cada sprint cierra un flujo que un contador puede ejecutar de punta a punta. El orden lo fijan las
dependencias de esquema y lo que hace falta para cerrar un mes.

| # | Flujo | Familias que cruza | Filas fase 1 | Estado |
|---|---|---|---:|---|
| 1 | **Catálogo y asiento manual** | account, entry, ledger | 31 | ✅ `a6932b1` |
| 2 | **Ingesta fiscal MX** | cfdi, sat, rep | 42 | ✅ parcial `a149e62` — timbrado y descarga siguen bloqueados |
| 3 | **Cobrar** | customer, invoice, credit-note, receipt, ar | 37 | |
| 4 | **Pagar** | vendor, bill, ap, payment | 11 | |
| 5 | **Banco** | bank, reconciliation | 38 | |
| 6 | **Cerrar el mes** | closing, period, batch | 21 | |
| 7 | **Contabilidad electrónica** | e-accounting | 10 | |
| 8 | **Nómina** | pay-run, payslip, employee | 9 | |
| 9–12 | La cola larga de fase 1 | 190 familias pequeñas | 179 | |

Los sprints 9 a 12 siguen siendo la parte que ningún plan anterior nombró.

**Lo que este orden no contenía y ahora sí:** entre el flujo 2 y el 3 va S2 (arriba), y las
garantías que la auditoría II encontró rotas —el respaldo que no existe, el trinquete que no
protege criterios, las tres puertas del auto-posteo con una sola custodiada— tienen su lugar en la
secuencia del Plan Maestro, no aquí. Este documento cuenta filas; aquél cuenta riesgos.

---

## Cómo se mide, sin escribir un número a mano

Este plan **no lleva tabla de estado**. Se pregunta:

```bash
npm run catalogo:estado    # cuántas filas se pueden teclear hoy, por familia
npm run plan:status        # qué paquetes están cerrados y qué comprobación falla
npm run costo:por-fila     # cuánto costó cada fila — con la banda, no con un número solo
```

Cada sprint añade sus criterios a `src/plan/criterios.ts` y su paquete a la lista `--exigir` de CI en
el mismo commit que lo cierra.

Con una salvedad que la auditoría II obliga a escribir aquí: **`--exigir` es de granularidad
paquete**, así que 16 criterios verdes viven hoy dentro de paquetes rojos sin que ningún commit
pueda ponerlos en rojo. Hasta que eso se arregle, «entró al trinquete» significa menos de lo que
este documento daba por hecho.

---

## La decisión que este plan pide

Diez sprints para que un contador pueda llevar los libros enteros desde la terminal —dos menos de
los que estimó agosto, medidos con datos nuevos—. Después, un respaldo de ~1 000 filas que se
atenderá por demanda y no por completitud.

La alternativa —comprometerse con las 1 261 restantes— son unos cincuenta sprints y cinco veces el
código actual. Sigue sin recomendarse.

Y una advertencia que la re-medición añade: **el 69 % de ese presupuesto descansa en una tarifa que
nadie ha vuelto a medir**. La partida 4 de S2 existe para eso, y hasta que corra, cualquier cifra
sobre las filas ❌ es la estimación de agosto con ropa nueva.
