# Plan para cerrar el catálogo de comandos

> Derivado de medir lo que este repositorio ha producido, no de estimar lo que podría producir.
> Estado en vivo: `npm run catalogo:estado` · `npm run plan:status`

## La aritmética, antes que nada

Cerrar **una** fila del catálogo ha costado **390 líneas** de código y prueba, todo incluido.

No es una estimación. Es lo que costaron las 50 filas que esta rama cerró: 15 772 líneas de entrega
(CLI-1, CLI-2, CLI-3, IVA-3) más 1 780 del núcleo del CLI (CLI-0) más 1 946 de cola correctiva —
defectos encontrados *después* de entregar, un 12,3 %.

Quedan **1 543 filas**.

| | |
|---|---|
| Filas pendientes × 390 líneas | **~602 000 líneas** |
| Todo el TypeScript que hoy tiene el repositorio | ~91 000 líneas |
| Razón | **6,6×** |

**Cerrar el catálogo tal como está escrito no es un plan.** Es seis veces reescribir el sistema
entero. Cualquier documento que prometa lo contrario está mintiendo con un cronograma.

Lo que sigue no es cómo cerrar 1 623 comandos. Es qué subconjunto vale la pena, en qué orden, y
cómo se mide el avance sin que nadie tenga que creerse una tabla.

---

## El hito que sí significa algo

**Fase 1 son 377 filas: «sin esto no se puede llevar una contabilidad completa desde el CLI».**
72 ya se teclean. Faltan **305**.

| Estado del motor | Filas | Coste unitario observado |
|---|---:|---|
| ✅ existe | 55 | ~250 líneas (el servicio ya está; se paga la capa CLI y sus pruebas) |
| 🟡 a medias | 150 | ~390 líneas |
| ❌ no existe | 100 | ~520 líneas (no hay manejador del que extraer: el servicio es neto nuevo) |
| **Total** | **305** | **~124 000 líneas** |

A razón de una entrega del tamaño de CLI-1 —10 153 líneas, la mayor que este repositorio ha
producido en un commit— **la fase 1 son unos 12 sprints**. Las fases 2 y 3 son otros ~48. Por eso
este plan compromete la fase 1 y deja el resto como respaldo, no como promesa.

---

## S0 · Antes de escribir un comando nuevo

Cinco trabajos que no entregan ni un comando y sin los cuales los doce sprints siguientes no se
pueden ni medir ni hacer con seguridad. Ninguno es opcional y uno **caduca**.

### S0.1 · El avance no se puede medir hoy, en las dos direcciones

**69 de los 136 comandos vivos no tienen fila en el catálogo** — el 51 %. La familia `report` es el
caso entero: 2 741 líneas invertidas, 8 comandos entregados, **cero filas cerradas**, porque el
catálogo deletrea esos actos como `statement show <bs|is|cf|equity|all>` y lo construido se llama
`report balance-sheet show`.

Y al revés: la tabla de portada dice 153 ✅ / 462 🟡 / 1 008 ❌; contar las filas da **160 / 447 /
1 016**. La portada es otro espejo escrito a mano.

- Reconciliar los 69 nombres: renombrar la fila del catálogo o el comando, fila por fila, con una
  decisión explícita en cada una.
- Que el bloque generado emita también el conteo ✅/🟡/❌ desde las filas. La maquinaria ya existe
  (`filasCompletas()`); falta publicarla.
- Añadir un trinquete: `viva` no puede bajar. Hoy `catalogo-estado.ts --check` sólo verifica que el
  bloque esté regenerado, no que el número no retroceda.

**Sin esto, cada sprint siguiente entrega trabajo real y el medidor marca cero.**

### S0.2 · La migración que caduca

Casi todo el ❌ cuelga de unos 20 objetos de datos ausentes —43 tablas candidatas no existen—, pero
el que va primero no es el mayor: es **una sola migración de etiquetado sobre tablas ya pobladas**
(dimensiones, UUID del CFDI, contraparte intercompañía, agrupador, naturaleza del gasto).

Es la única cuyo coste crece con el tiempo: etiquetar cien asientos es trivial y etiquetar cien mil
es un proyecto. **Cada mes que se postea sin ella la encarece.**

De paso: `docs/migraciones.md` dice que el siguiente número libre es 031. Es **037**.

### S0.3 · La fuga que condiciona a las 902

De las tres fugas de la frontera de la IA que el catálogo denuncia, dos desbloquean **10 filas entre
las dos** — deuda pequeña que puede esperar a su familia. La tercera no desbloquea ninguna y
condiciona **las 902 filas que el catálogo marca como invocables por el agente**: la sesión
desatendida recibe la superficie completa de herramientas, y lo único que le pide producir sólo
borradores es una frase del prompt.

`buildTools()` no acepta lista blanca y `CreateLlmSessionOptions` no tiene campo de herramientas.

Y su criterio miente por partida doble: es un regex sobre el texto de **uno** de los **tres** sitios
que construyen sesión desatendida. `ingest` —que además puede auto-postear— no lo mira nadie. El
criterio debe comparar conjuntos de nombres de herramientas de las tres sesiones contra `buildTools`,
y el conjunto exigido no puede ser «ninguna que escriba», porque eso rompe `ingest`.

**Arreglar el criterio antes que la fuga**, o el arreglo pasará el medidor sin cerrar el agujero.

### S0.4 · Un conflicto de dueño sobre código que duplicaría ingresos

`recordInventorySale` no tiene un solo llamador y postea directo `DR CxC / CR Ingresos / DR Costo /
CR Inventario` con `autoPost: true`. Si alguien la cableara hoy, duplicaría el ingreso de toda venta
ya facturada.

Dos documentos se contradicen sobre qué hacer con ella: `plan-cierre-brechas.md` manda borrarla,
`cli-command-catalog.md` manda partirla. **Borrarla ahora** —no tiene llamadores— y dejar el costo de
ventas para cuando exista la ruta de facturación por ítem. Las 4 filas que la citan se reescriben.

### S0.5 · Recortar el alcance con un criterio, no con el gusto

Dos cortes mecánicos, verificables:

- **244 filas de fase 3 sin backend.** «Best-in-class: consolidación, analítica, automatización
  avanzada» sobre motores que no existen. Salen del plan y quedan declaradas fuera.
- **5 solapamientos vivos**: familias distintas que resuelven lo mismo con otro sustantivo. El propio
  catálogo ya hizo uno de estos movimientos cuando llevó el amarre de auxiliares a `report`.

El objetivo baja de 1 623 a ~1 374 filas. No cambia la fase 1 —ninguna de las 249 lo es— pero deja
de contarse como deuda lo que nadie va a construir.

---

## Qué NO se recorta

**La cola larga no es relleno.** 190 familias de menos de diez comandos concentran el 41,5 % del
catálogo, y dentro de ellas hay **197 filas de fase 1** que nadie puede saltarse. 43 familias tienen
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
dependencias de esquema (S0.2 primero) y lo que hace falta para cerrar un mes.

| # | Flujo | Familias que cruza | Filas fase 1 |
|---|---|---|---:|
| 1 | **Catálogo y asiento manual** — dar de alta cuentas, asentar, revisar el mayor | account, entry, ledger | ~20 |
| 2 | **Ingesta fiscal MX** — recibir el CFDI, clasificarlo, contabilizarlo | cfdi, sat, rep | ~38 |
| 3 | **Cobrar** — facturar, emitir nota de crédito, registrar el cobro | customer, invoice, credit-note, receipt, ar | ~21 |
| 4 | **Pagar** — factura de proveedor, programación, pago | vendor, bill, ap, payment | ~15 |
| 5 | **Banco** — importar el estado de cuenta, conciliar, postear la diferencia | bank, reconciliation | ~38 |
| 6 | **Cerrar el mes** — checklist, ajustes, cierre suave y duro | closing, period, batch | ~20 |
| 7 | **Contabilidad electrónica** — pólizas y balanza al SAT | e-accounting | ~10 |
| 8 | **Nómina** — corrida, recibos, timbrado | pay-run, payslip, employee | ~10 |
| 9–12 | La cola larga de fase 1 | 190 familias pequeñas | ~197 |

Los sprints 9 a 12 son la mitad del trabajo y la parte que ningún plan anterior nombró. Se atacan
por flujo igual que los demás, no familia por familia.

---

## Cómo se mide, sin escribir un número a mano

Este plan **no lleva tabla de estado**. Se pregunta:

```bash
npm run catalogo:estado    # cuántas filas se pueden teclear hoy, por familia
npm run plan:status        # qué paquetes están cerrados y qué comprobación falla
```

Los cuatro paquetes abiertos del plan de cierre —E1.3, E1.4, E4.2, E5.1— **no son deuda residual:
son las compuertas de las familias más grandes de este catálogo**. E4.2 (cuatro copias del SQL de
saldos) bloquea `report`; E5.1 bloquea toda la superficie del agente.

Cada sprint añade sus criterios a `src/plan/criterios.ts` y su paquete a la lista `--exigir` de CI en
el mismo commit que lo cierra. Ésa es la única forma de avance que este repositorio acepta como
prueba.

---

## La decisión que este plan pide

Doce sprints para que un contador pueda llevar los libros enteros desde la terminal. Después, un
respaldo de ~1 000 filas que se atenderá por demanda y no por completitud.

La alternativa —comprometerse con las 1 543— son unos sesenta sprints y seis veces el código
actual. No la recomiendo, y ningún dato de los que produjo esta medición la sostiene.
