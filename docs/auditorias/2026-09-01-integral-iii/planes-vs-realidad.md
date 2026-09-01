		# Lente 11 · Los tres documentos rectores contra el código

**Árbol:** `61379d0` (origin/main `cfe40c6` + los dos commits de documentación del PR 19).
**Artefactos:** Plan Maestro v3 (HTML, fuera del repo — se cita por §), `docs/plan-catalogo.md`, `docs/plan-cierre-brechas.md`.
**Medidores re-corridos por mí en ese árbol**, no supuestos: `plan:status`, `catalogo:estado --json`, `costo:por-fila`, `npm test`.

> Nota de método: al correr los medidores encontré `vitest.config.ts` con los cuatro umbrales de cobertura en 0 — obra sin comprometer de una sonda de mutación previa, no un defecto del código. La restauré con `git checkout --` antes de medir. Ninguna de las cifras de abajo depende de eso.

---

## LO QUE RESISTE

Audito también a favor. Esto lo verifiqué y aguantó:

1. **Los once commits que las tarjetas citan existen Y están en el tronco.** `40a45af`, `5d24463`, `205e1e0`, `d2eef08`, `e282fe4`, `2cd656e`, `5ec9750`, `a6932b1`, `a149e62`, `1ff9ca8`, `689458a`: `git merge-base --is-ancestor <c> HEAD` da **EN TRONCO** para los once. Sobrevivieron la fusión del PR 17 (`b0056b9`… `b0bd2a3`). Ninguno inventado, ninguno huérfano de rama.

2. **Las ocho cabeceras de flujo casan al renglón con el catálogo.** Re-derivadas por mí desde `scripts/catalogo-estado.ts --json`, agregando por familia sobre las 379 filas de fase 1:
   F01 = 31 (`account` 15 + `entry` 12 + `ledger` 4) · F02 = 42 (`cfdi` 20 + `sat` 17 + `rep` 5) · F03 = 37 (11+11+6+5+4) · F04 = 11 (7+2+1+1) · F05 = 38 (30+8) · F06 = 21 (10+6+5) · F07 = 10 · F08 = 9 (5+2+2). **Las ocho, exactas.** Y las cinco «mayores de la cola» también: `report` 10, `close` 8, `year` 7, `entity` 7, `job` 7.

3. **El 761 —la cifra que decide el 69 % del presupuesto— reproduce EXACTO.** De las 1 261 filas que restan del objetivo comprometible, las marcadas ❌ son **761** (= 1 005 ❌ no invocables − 244 de fase 3 excluidas por el recorte de S0.5). Igual el resto del andamio: 1 624 filas · 1 603 rutas únicas · 119 invocables · 379 de fase 1 · 108 tecleables · objetivo 1 380 · restan 1 261. Ocho cifras del bloque generado, ocho correctas.

4. **«2 185 pruebas unitarias» es exacta y está viva.** Corrí `npm test`: `Test Files 142 passed (142) · Tests 2185 passed (2185)`, código 0. (Las 253 de integración: **no verificado** — no hay Postgres en esta corrida.)

5. **La re-medición de las 147 aguanta el muestreo.** Verifiqué **doce** partidas de la tabla de cambios de estado de `docs/auditorias/2026-09-01-integral-ii/cierre-cobertura.md:252-264` contra el código, una por una. **Doce de doce resistieron:**
   `E1.2-b` `pre-registration-service.ts:642` (INSERT a `cfdi_classifications`) · `E1.2-c` `:520` (UPDATE) · `E1.3-d` `fiscal-credentials/service.ts:259-262` · `E2.2-e` `doctor-service.ts:882` + `posting.ts:318` · `E2.1-f` `src/database/consulta-publica.ts` + `rls-policies.sql:291` · `E4.2-c` `042_el_refresco_sale_del_posteo.sql:25-26` · `E4.2-i` `doctor-service.ts:806-810` («Ledger integrity» con `fail`) · `E3.2-g` `sat/cfdi-status.ts:46` · `E3.2-h` `cfdi-decisions.ts:316` + `cfdi-classifier.ts:152` · `E1.2-h` `iva-ppd-reclass.ts` · `E5.1-c` `compaction.ts:244` (`MONTO_RE`) · `E2.1-e` `rls-guard.ts` + `src/index.ts:9`.
   Las dos rutas que parecían mal (`prices.ts`, `rls-guard.ts`) son abreviatura de archivos reales (`src/ai/providers/prices.ts`, `src/database/rls-guard.ts`). **No hay ninguna partida que la prosa dé por hecha y el código desmienta**, tal como la II afirma.

6. **La regla de la casa (a) se cumple: cero políticas huérfanas.** 17 claves declaradas en `src/services/policy/pending-catalog.ts`, **17 con lector real**. (Mi primer `grep` acusó a `segregacion_de_funciones`; era falso positivo mío — el lector está en `posting.ts:318`, con el contexto en literal multilínea.)

7. **La regla de la casa (f) se cumple donde la muestreé.** `fiscal-credentials/service.ts:259-262` combina el techo del panel con el de la fila usando `Math.min`, no un `??` ni un máximo.

8. **Las afirmaciones de tarjeta que muestreé son ciertas.** R1: `041_el_mayor_inviolable.sql:65` y `:98` (`BEFORE UPDATE OR DELETE` en las dos tablas) más el candado de `TRUNCATE` a nivel sentencia (`:112`, `:116`). A1–A2: `tests/golden/cfdi/` con 18 archivos = 9 pares, y `ai stats` en `src/cli/ai-command.ts:69`. A3–A4: `src/ai/budget.ts:44` (`opts.unattended ? 'block' : 'warn'`) y `shadow` en `pending-catalog.ts:342`. E4.2: las cuatro copias del SQL de saldos son exactamente las cuatro que el plan nombra.

9. **Tres hallazgos de la auditoría II CERRARON con la republicación** (detalle en el dictamen de abajo): la duplicación de §3–§7, la tarjeta rota del maker-checker, y cinco de las siete cifras caducas de §1.

10. **La compuerta vacía ahora se declara.** `FLUJOS_CERRADOS` sigue vacío, pero §7 del v3 ya no presume mecanismo: dice «La compuerta existía y estaba vacía; S2 la puebla. Hasta entonces, "hecha" significa lo que el commit demuestre». Eso es rojo honesto, y hay que reconocerlo.

---

## HALLAZGOS

### 1 · [NUEVA] ALTA — §1 rompe, en su propio párrafo, la regla que ese párrafo enuncia: tres de sus ocho baldosas no son lectura de ningún medidor

§1 abre con: *«Ninguno de estos números se escribe aquí a mano: se copian de la última corrida de los medidores, y si el documento y el medidor discrepan, gana el medidor.»* Corrí los tres medidores. Tres baldosas no salen de ninguno:

| §1 publica | Lo que imprime el medidor | Veredicto |
|---|---|---|
| «390 líneas por fila — 200 entrega + 190 garantía» | `Agregado desde S0.1: 31 fila(s) · 13126 líneas · **423 líneas/fila**`. El 390 aparece sólo rotulado «**Referencia fundacional** («Doce sprints», medida una vez sobre 50 filas)». El desglose 200/190 **no lo imprime ningún medidor**: sale a mano de `docs/plan-catalogo.md:20-22`. | **FALSA como lectura** |
| «047 migraciones» | `ls src/database/migrations/*.sql \| wc -l` = **52**. 047 es la cabeza de la cadena, no un conteo. | **FALSA como conteo** |
| «10 de 15 paquetes en verde» | `plan:status` imprime **8 de 15**. Llega a 10 sólo descontando E0.0 (artefacto de worktree) y E0.1 (no evaluable sin Postgres). | **Defendible, pero sin convención declarada** |

Y §1 remata: *«Los cinco paquetes en rojo lo están a propósito»*, enumerando E1.4, E3.2, E4.1, E4.2, E5.1. El medidor lista **seis** no-verdes: falta E0.1 (12/13), que el propio comando pinta 🟠 y excluye del verde.

**Escenario de fallo concreto:** Victor dimensiona la fase 1 leyendo «390 líneas por fila» en §1 y la tabla de §6 (271 filas → ~105 700 líneas). El instrumento vivo dice 423. Sobre 271 filas son **~114 700 líneas: ~8 900 líneas fuera de presupuesto**, casi un sprint entero, en la única cifra que convierte el plan en un compromiso de calendario. Y la baldosa que lo esconde es la que promete que no esconde nada.

Es la brecha 4 de la auditoría II reincidiendo por cuarta vez, ahora sobre baldosas distintas — con el agravante de que §7 dice *«la §1 se corrige en cada republicación»* y ésta **es** la republicación correctora.

---

### 2 · [NUEVA] ALTA — El «69 %» y el «~491 800» no pueden ser ciertos a la vez: el documento publica dos modelos de coste como si fueran uno

`docs/plan-catalogo.md:35-36`: *«De las filas que faltan, **761 están marcadas ❌** … y se presupuestan a **520 líneas** cada una: **395 720 líneas, el 69 % de todo lo que resta**.»*
`docs/plan-catalogo.md:76`, cuarenta renglones después: *«Objetivo comprometible — 1 261 filas | **~491 800**»* (= 1 261 × 390, tarifa plana).

Aritmética verificada por mí sobre el `--json`: las 1 261 restantes son **761 ❌ + 400 🟡 + 100 ✅**.

- Contra el presupuesto **publicado**: 395 720 / 491 790 = **80,5 %**, no 69 %.
- El 69 % sólo sale del modelo de **tres tarifas** que el documento *no* publica en su tabla: 761×520 + 400×390 + 100×250 = **576 720**, y 395 720 / 576 720 = **68,6 % ≈ 69 %**. Reproducido al decimal.

Es decir: la baldosa que cuantifica el compromiso usa tarifa plana (390) y el titular que justifica la partida «con más apalancamiento de todo el plan» usa tarifa por estado de motor (250/390/520). El Plan Maestro §6 hereda la contradicción textual: *«el 69 % de ese presupuesto»*, donde «ese presupuesto» es, tres renglones arriba en su propia tabla, los ~491 800.

**Escenario de fallo concreto:** el objetivo comprometible está subdeclarado en **~85 000 líneas (~17 %)** bajo el propio modelo con el que el documento calcula su cifra estrella. Si Victor decide «diez sprints para fase 1, cincuenta para todo» leyendo la tabla, decide con el modelo barato mientras el argumento que lo convence viene del modelo caro. Los dos números están en la misma página, a cuarenta renglones de distancia, y ninguno cita al otro.

---

### 3 · [II-SIGUE-VIVA] MEDIA — La cola son 180 filas, no 179: la suma da 378 ≠ 379, en LOS DOS documentos, y la corrección ya estaba escrita

Re-sumé las filas de fase 1 por flujo, como pide el encargo:

```
31 + 42 + 37 + 11 + 38 + 21 + 10 + 9 = 199   (flujos)
199 + 179 (cola declarada)            = 378   ✗
```

El medidor dice **379**. Mi conteo directo del `--json`: la cola son **180 filas en 65 familias**, de las que **24** tienen una sola fila de fase 1.

- `docs/plan-catalogo.md:143` — fila «9–12 | La cola larga | 190 familias pequeñas | **179**».
- Plan Maestro §4, tarjeta F09–F12 — «**179 filas** · 190 familias pequeñas · 24 de un solo comando».

Esto es exactamente la brecha 6 de la auditoría II, y su **recomendación 11 entregó los números corregidos servidos en bandeja**: *«§6: 379 filas, 199 en flujos + 180 en cola»*. El commit `61379d0` reescribió los dos documentos sin aplicarla.

**Escenario de fallo concreto:** una fila de fase 1 —la que S1 rescató, `pac create`, familia de cola— no pertenece a ningún flujo ni a ninguna cuenta de cola en la secuencia. Cuando F09–F12 se planifique contra «179», esa fila no tendrá tarjeta, y el único lugar donde aparece es el total del medidor que ningún documento reconcilia.

*Matiz de justicia:* el «190 familias pequeñas» y el «24 de un solo comando» sí verifican, pero bajo universos distintos: 190 son las familias con <10 filas de **todo** el catálogo (miden 41,3 %, no el 41,5 % publicado), y 24 son familias de **cola de fase 1** con una sola fila. La frase mezcla los dos universos en un renglón.

---

### 4 · [NUEVA] MEDIA — El inventario de 147 partidas y los 16 cabos sin fase no tienen dueño en ninguna secuencia: el Plan Maestro nunca nombra a `plan-cierre-brechas.md`

`docs/plan-cierre-brechas.md:8260`: *«Las secciones **prospectivas** de este plan las sustituyó el Plan Maestro.»* La herencia es de ida y no de vuelta:

- `grep -niE "cabo|sin dueño|147|cierre-brechas|plan de cierre"` sobre el texto completo del Plan Maestro v3 → **cero coincidencias** relevantes.
- Lo mismo sobre `docs/plan-catalogo.md` → **cero**.

Mientras tanto el apéndice declara abiertas: **15 PENDIENTE + 4 PENDIENTE† + 3 CAÍDA-RESCATADA + 16 cabos sin fase = 38 deudas**, y de los 16 dice literalmente (`:8331`): *«no tienen fase … hasta hoy no figuraban en ningún inventario, así que ningún tablero podía ponerse rojo por ellos.»*

De las 38, la secuencia del v3 heredó **una**: `E1.2-i` (los trece manuales del agente), que aparece en §2 y en §3 pilar 3 → S2·A5. Las otras 37 no tienen tramo, no tienen criterio y no tienen rojo.

**Escenario de fallo concreto:** el apéndice arranca con *«El estado **no se lee aquí**: se pregunta con `plan:status`»*. Pero el tablero no conoce esas 37, y la secuencia tampoco. Su único domicilio es un documento que declara no ser domicilio. Cuando alguien pregunte «¿qué falta?», los tres instrumentos —tablero, catálogo y secuencia— darán la misma respuesta incompleta, y las 37 desaparecen sin que nadie las haya cerrado ni retirado por escrito. Es capacidad huérfana invertida: **deuda huérfana**, la brecha clásica de esta casa mirada desde el otro lado.

---

### 5 · [NUEVA] MEDIA — Como §2 republicó una formulación que el propio escéptico de la II ya había corregido, la primera partida de S2 poblará una compuerta de flujos con algo que no es un flujo

§4, tarjeta S2, pieza (1): *«`FLUJOS_CERRADOS` se puebla con **los tres flujos ya cerrados**»*, y §2 los nombra: *«F01, F02 y A3–A4 se declararon hechos sin un solo registro de auditoría»*.

El criterio se auto-limita a flujos. Su comentario, `src/plan/criterios.ts:239-241`: *«nada impedía **declarar cerrado un F0x** sin auditarlo. **Cerrar un flujo** es AÑADIR su entrada aquí»*. **A3–A4 es tramo A, no un flujo.**

Y esto no es un descubrimiento mío: la verificación adversaria de la propia auditoría II lo escribió (`docs/auditorias/2026-09-01-integral-ii/maestro-vs-codigo.md:263`): *«A3-A4 cae fuera del alcance declarado por el propio criterio»*, junto con *«"sin un solo registro en docs/auditorias/" es falso como se lee: existen 9 archivos»* (`:261`). El informe publicó una **«Formulación corregida»** completa en `:267`. **El v3 republicó la formulación refutada, palabra por palabra, e ignoró la corregida.**

**Escenario de fallo concreto:** S2 entrega `FLUJOS_CERRADOS = { F01, F02, 'A3-A4' }`. El criterio queda contradiciendo su propio comentario el día que nace, y la compuerta que existe para impedir que se declare cerrado lo no auditado empieza su vida con una entrada que su contrato no admite. La regla de la casa (c) —los criterios se verifican por mutación en ambas direcciones— no puede aplicarse a una llave cuyo tipo no está definido.

---

### 6 · [II-SIGUE-VIVA] MEDIA — El sello del documento va cuatro commits por detrás de su propio árbol, y dos de esos commits cambian conducta contable sin renglón

El encabezado estampa *«estado al commit `689458a` · 2026-09-01»*. HEAD es `61379d0`.
`git log --no-merges 689458a..HEAD -- src/ scripts/ .github/` devuelve **cuatro** commits, dos de ellos de conducta:

- **`8502ad7`** — *«anular una factura exige un motivo, y el motivo llega al mayor»*. `POST /:id/void` no llevaba `validateBody`, así que el motivo que el esquema pedía nunca se exigía ni se guardaba, y `voidJournalEntryInTx` persistía la tautología «Invoice N voided» **dentro del mayor** (`posting.ts:545`, `:549`). Toca la superficie que R1 hizo inmutable.
- **`b0056b9`** — *«Tres entradas que se aceptaban y se tiraban en silencio»*. `/public/v1/entities/:entityId/aggregates` recortaba a 100 filas y servía el recorte como si fuera el conjunto; `invalidateReportCache` ignoraba `periodId`.

Ninguno tiene renglón en la tabla «Hecho» de §1, fila de catálogo ni criterio. Es la brecha 11 de la auditoría II (trece commits entonces) **reincidiendo dentro del commit que existía para corregir los documentos**: `61379d0` reescribió las tres páginas sentado encima de estos cambios y estampó un commit anterior a ellos.

**Escenario de fallo concreto:** el plan afirma en §7 *«El estado no se escribe, se pregunta»* — pero el trabajo entra al árbol por una superficie que ningún medidor mira. Un cambio en la ruta de anulación que toca el mayor no puede ponerse rojo, porque ningún criterio sabe que existe.

---

### 7 · [II-SIGUE-VIVA] MEDIA — El documento recomienda SW Sapien como PAC primario; el código reparte Finkok a quien no elige

Plan Maestro §5: *«SW Sapien sigue siendo el primario recomendado y ya tiene arranque escrito»*, coherente con `docs/pac-proveedores.md`. El código, cuando el inquilino no ha elegido:

```
src/services/integrations/mexico/pac/pac-router.ts:52
        pac_primary: 'finkok',
        pac_secondary: 'sw_sapien',
```

Brecha 14 de la auditoría II, con su recomendación 10 («o el router pasa a `sw_sapien`, o el documento pasa a Finkok»). La republicación repitió la recomendación sin tocar ni el código ni la nota.

*Lo que sí sigue siendo cierto en el mismo párrafo:* `sovosReachcoreAdapter` se importa (`:9`) y vive en el mapa `PACS` (`:26`) pero **no** está en los tres `integrationRegistry.register(...)` de `:21-23`. «A una línea de registrarse» resiste.

**Escenario de fallo concreto:** un despacho que no decide hereda el proveedor que el documento rector no recomienda, y lo hereda en silencio. Si la elección de PAC tiene consecuencia fiscal (plazos, acuses, custodia del acuse), es bifurcación de criterio y por la regla de la casa (a) va al panel con su lector — hoy no está ni en el panel ni de acuerdo consigo misma.

---

### 8 · [II-SIGUE-VIVA] MEDIA — «La brecha madre era no tener evals. Se cerró.» El arnés existe; ninguna corrida se ha registrado jamás

§3 del v3 abre así. Verificado hoy:

- `ls docs/evals/` → **sólo `README.md`**. El `clasificador.jsonl` que ese README describe como «la memoria del mejoró/empeoró» **no existe**.
- `grep -n "eval" package.json` → **cero**. No hay script `eval:*`.
- El golden set sí es real y verificado (9 pares en `tests/golden/cfdi/`) — el instrumento se construyó. Lo que no existe es una sola lectura.

Brecha 3 de la auditoría II, con su recomendación 5, no aplicada.

**Escenario de fallo concreto:** §7 conserva *«Ninguna ampliación de autonomía sin eval, calibración y sombra previas»*. A3–A4 (`1ff9ca8`) amplió la autonomía —añadió el modo `shadow` y el presupuesto— con cero corridas registradas, y A7 va a encender el auto-posteo con la misma evidencia vacía. Declarar «se cerró» sobre un instrumento que nunca ha juzgado nada es el verde falso que la regla de la casa (d) prohíbe, publicado en la sección que existe para explicar por qué el plan se reordenó.

---

### 9 · [NUEVA] BAJA — `plan-catalogo.md` se contradice consigo mismo sobre la garantía: 189 en la tabla, 190 en la recomendación, y la columna de septiembre no suma

`docs/plan-catalogo.md:20-22`:

```
| Entrega  | 351 | 200 |
| Garantía |  39 | 189 |
| Total    | 390 | 390 |     ← 200 + 189 = 389
```

La columna de agosto suma bien (351+39 = 390); la de septiembre **no**. Y `:105`, en la partida 3 de S2, dice *«los números accionables son 200 + 190»*. El Plan Maestro §1 y §6 adoptaron el 190.

**Escenario de fallo concreto:** cuando S2 entregue «entrega y garantía como dos renglones», el instrumento tendrá que elegir entre 189 y 190 sin que ningún documento diga cuál se midió; y `plan-cierre-brechas.md:8355` ya derivó de ahí un tercer número redondeado («el 49 % de cada fila es garantía»). Un decimal, tres documentos, ninguna fuente.

---

### 10 · [NUEVA] BAJA — «La cadena va por la 047 sin colisiones» es falso: hay cinco colisiones toleradas

`docs/plan-cierre-brechas.md:8342-8343`: *«`assertNumeracionUnica` en `src/database/migrate.ts` rechaza duplicados, y la cadena va por la 047 **sin colisiones**.»*

Hay **52 archivos bajo 47 números**: `012`×2, `014`×3, `015`×2, `018`×2. El guardián los exime explícitamente (`src/database/migrate.ts:19`):

```
const DUPLICADOS_HISTORICOS = new Set(['012', '014', '015', '018']);
```

**El mecanismo está bien y está bien razonado** (`:14-17`: ya están aplicados en bases desplegadas, renumerar rompería instalaciones; `:31` rechaza cualquier duplicado nuevo). Lo que está mal es la frase del documento, que convierte «toleradas y documentadas» en «inexistentes» — y de paso explica por qué la baldosa «047 migraciones» del hallazgo 1 no cuadra con el `ls`.

---

### 11 · [II-EXAGERADA en un sentido, NUEVA en otro] BAJA — La tarjeta F06 reclama una compuerta que existe con otro nombre, y perdió de vista la que sigue faltando

§4, F06: *«El checklist ya sabe del IVA aparcado y de los REP faltantes (F02). Falta la puerta de la depreciación … y el amarre fiscal del cierre.»*

Lo que hay en `src/services/accounting/period-close.ts`:
- `:141-147` — «Parked payment receipts (REP) resolved»: cuenta **REP aparcados en `needs_review`**.
- `:164-180` — «Payments in period have their REP», con `rep_faltante_recibido` / `rep_faltante_emitido` decidiendo si bloquea o avisa.

Las dos compuertas son sobre **documentos REP**, no sobre el **saldo** del IVA aparcado. La compuerta que la brecha 12 de la II nombró como faltante —«IVA aparcado en 1135/2125 vs. saldo contable»— no existe: no hay consulta que compare esas cuentas de control contra el mayor; `1135` sólo aparece en un texto de aviso (`:174`). Y la otra que faltaba, «cuentas con movimientos sin agrupador SAT», **desapareció de la tarjeta**: `grep agrupador period-close.ts` → nada, y la tarjeta la sustituyó por el más vago «el amarre fiscal del cierre».

*A favor del documento:* el comentario del propio código (`:120`) llama a su chequeo «el checklist del IVA aparcado», así que la tarjeta está repitiendo fielmente un nombre que el código sobrecarga. La corrección honesta va en el código o en los dos.

**Escenario de fallo concreto:** F06 se planifica creyendo dos compuertas puestas y dos por poner; en realidad son dos puestas (ambas de REP), una por poner que ya nadie nombra (agrupador SAT) y una por poner que se cree puesta (conciliación de 1135/2125). Un cierre de mes puede pasar el checklist con el IVA aparcado descuadrado contra el mayor y con cuentas sin agrupador — y el Anexo 24 de F07 se construye justo sobre el agrupador.

---

### 12 · [II-SIGUE-VIVA] BAJA — Los cuatro adaptadores de integración siguen fuera del censo de huérfanos

`src/plan/criterios.ts:761` — `HUERFANOS_CONGELADOS` sigue con tres símbolos (`autoExecuteOpByPolicy`, `earlyPaymentDiscount`, `calculateBenefitsForPaycheck`) y **ningún adaptador**. La recomendación 8 de la II (congelar `stripeAdapter`, `conektaAdapter`, `sendGridAdapter`, `s3Adapter`) no se aplicó.

*Progreso real que hay que reconocer:* la tarjeta F03 del v3 **ya nombra** el hallazgo («un adaptador SendGrid ya existe, 88 líneas, cero usos — cablear el envío es más barato de lo que el plan creía, o se retira la promesa junto con el adaptador»). El documento aprendió; el trinquete no.

**Escenario de fallo concreto:** un quinto adaptador registrado sin consumidor entra sin que nada falle, porque la línea base sólo congela símbolos de servicio.

---

### 13 · [II-SIGUE-VIVA] BAJA — `FLUJOS_CERRADOS` sigue vacío, y la recomendación 1 de la II era ejecutable en el mismo commit que la publicó

`src/plan/criterios.ts:243` sigue siendo `const FLUJOS_CERRADOS: Record<string, string> = { // 'F01': … };`. `tests/plan/` sigue sin un solo espejo (`grep -c "espejo\|mutante"` = 0 en los dos archivos).

Lo notable es el momento: la recomendación 1 de la II decía *«archivarla bajo `docs/auditorias/2026-09-01-integral-ii/` y apuntar las tres entradas ahí paga la deuda en el mismo commit»*. El commit `3caf499` **creó ese directorio**. `61379d0` reescribió los tres documentos. Ninguno de los dos tocó `criterios.ts`.

Severidad BAJA **como hallazgo documental** —§7 ya lo declara honestamente y S2 lo tiene asignado—, pero se registra porque el artefacto habilitante existe desde ayer y el renglón que lo cobra sigue comentado.

---

## RECOMENDACIONES

| # | Qué | Tamaño | Tramo destino |
|---|---|---|---|
| 1 | **Generar §1, no escribirla.** Que el bloque de baldosas lo emita el mismo instrumento que ya regenera `docs/cli-command-catalog.md`, con `--check` en CI. Mientras tanto, corregir hoy las tres baldosas del hallazgo 1: «423 líneas/fila (medido) · 390 (referencia de agosto)», «52 migraciones, cabeza 047», y declarar la convención de conteo de verdes o publicar el 8/15 del medidor. La regla «la §1 se corrige en cada republicación» lleva cuatro fallos: ya no es disciplina, es diseño. | **S** | **S2**, partida 5 (el costo entra al bloque generado) |
| 2 | **Publicar UN modelo de coste, o los dos rotulados.** La tabla de `plan-catalogo.md:74-77` y el titular del 69 % usan modelos distintos. Publicar las dos filas —«tarifa plana 390: ~491 800» y «tarifa por motor 250/390/520: ~576 700»— y decir cuál gobierna el compromiso. Sin esto, la partida 4 de S2 («medir la tarifa de las 761 ❌») no tiene contra qué comparar su resultado. | **S** | **S2**, partida 4 |
| 3 | **Aplicar la recomendación 11 de la auditoría II, que sigue en el cajón.** Cola = 180 filas en 65 familias; flujos = 199; total 379. Corregir los dos documentos y, en el mismo commit, añadir a `scripts/catalogo-estado.ts` el renglón «cola F09–F12: N filas · M familias» derivado de la resta flujos-vs-fase-1 — que es también la recomendación 7 de la II, y la que impide que este número vuelva a divergir. | **S** | **S2** (medidor) + republicación |
| 4 | **Dar domicilio a las 37 deudas huérfanas.** Que el Plan Maestro §4 abra un renglón —aunque sea uno solo— que herede explícitamente el inventario de `plan-cierre-brechas.md`: las 15 PENDIENTE, las 4 PENDIENTE†, las 3 CAÍDA-RESCATADA y los 16 cabos sin fase. Mínimo ejecutable: repartirlas entre F09–F12 y S3, y un criterio que cuente partidas sin tramo. Hoy los tres documentos rectores no se citan entre sí en ninguna dirección salvo una. | **M** | **F09–F12** (o un tramo de gobierno propio) |
| 5 | **Adoptar la «Formulación corregida» de la II antes de escribir S2.** `maestro-vs-codigo.md:267` ya trae el texto. Concretamente: decidir si `FLUJOS_CERRADOS` admite tramos además de flujos —y entonces ampliar el comentario de `criterios.ts:239-241` y renombrar la constante— o si A3–A4 sale de la lista. Y quitar de §2 el «sin un solo registro de auditoría», que el escéptico marcó como falso al pie de la letra. | **S** | **S2**, partida 1 |
| 6 | **Cerrar el lazo del eval antes de A7, no después.** Las tres piezas de la recomendación 5 de la II: `"eval:clasificador"` en `package.json`, una corrida commiteada en `docs/evals/clasificador.jsonl` como línea base, y reforzar el criterio de `criterios.ts:2011` para que exija que el `.jsonl` exista con ≥1 corrida en vez de que el arnés lo mencione. Y corregir §3: «el instrumento se cerró; la lectura no». A7 enciende autonomía; encenderla sobre evidencia vacía es el escenario que §3 pilar 1 existe para prohibir. | **M** | **A7** (prerrequisito, antes de F03) |
| 7 | **Alinear el PAC primario, y decidir si es materia de panel.** O `pac-router.ts:52` pasa a `sw_sapien`, o §5 y `docs/pac-proveedores.md` pasan a Finkok. Si la elección tiene consecuencia fiscal, por la regla de la casa (a) va al panel con su lector en el mismo commit. Va junto con registrar `sovosReachcoreAdapter` en `:21-23`, que es el renglón que separa «no tenemos PAC» de «no se puede ni intentar». | **S** | **F07** (o antes, es una línea) |
| 8 | **La herencia también de commits.** Recomendación 12 de la II, hoy más barata: un criterio que cuente commits desde el último sello que toquen `src/` sin renglón en §1 ni criterio propio. Es el mismo trinquete que ya funciona tres veces (violaciones del CLI, huérfanos, mínimos del catálogo) aplicado a la única superficie que escapa. Cierra los cuatro commits del hallazgo 6 y los trece de la II. | **M** | **S2**, partida 2 (trinquete a granularidad criterio) |
| 9 | **Correcciones de renglón, todas juntas en la republicación:** blockchain 1 346 (no 1 341, la II ya lo midió); garantía 189 o 190 pero uno solo; «047 sin colisiones» → «cuatro números con duplicado histórico tolerado, `migrate.ts:19`»; F06 → «dos compuertas de REP puestas; faltan agrupador SAT y la conciliación de 1135/2125 contra el mayor»; y `HUERFANOS_CONGELADOS` extendido a los cuatro adaptadores con su destino. | **S** | republicación + **S2** |

---

## Dictamen sobre la auditoría II

Fui severo con ella también. De lo que toca esta lente:

| Hallazgo de la II | Hoy en `61379d0` |
|---|---|
| Brecha 4 — §1 caduca en 7 cifras | **CERRADA en su mayor parte**: 134, 119, 1 624/1 603, 108/379 y 2 185+253 ahora son exactas y verificadas. Sobrevive en tres baldosas nuevas → hallazgo 1 |
| Brecha 5 — §3–§7 duplicadas, tarjeta ✓F02 exiliada | **CERRADA**: `grep 'sec-num">§'` da exactamente una ocurrencia de cada sección |
| Brecha 13 — tarjeta de maker-checker rota dentro de §5 | **CERRADA**: §5 tiene ahora un bloque «✓ Resueltas desde la v2» y la oración partida desapareció |
| Brecha 6 — cola 179 vs 180, 378 vs 379 | **SIGUE VIVA**, en los dos documentos, con la corrección ya escrita → hallazgo 3 |
| Brecha 14 — PAC primario | **SIGUE VIVA** → hallazgo 7 |
| Brecha 3 — el eval nunca ha corrido | **SIGUE VIVA**, y ahora el documento la declara cerrada → hallazgo 8 |
| Brecha 11 — commits de producción sin renglón | **SIGUE VIVA y reincidió** dentro del commit corrector → hallazgo 6 |
| Brecha 10 — adaptadores fuera del censo | **SIGUE VIVA** (el documento sí aprendió) → hallazgo 12 |
| Brecha 9 — GraphQL/blockchain sin gobierno | **SIGUE VIVA**; GraphQL 918 exacto, blockchain 1 346 vs 1 341 publicado → hallazgo 9(9) |
| Brechas 1 y 2 — `FLUJOS_CERRADOS` vacío, sin meta-criterio de espejos | **SIGUEN VIVAS en código**, pero **ahora declaradas honestamente** en §7 y en el apéndice → hallazgo 13, severidad rebajada |
| Brecha 12 — F06 «cuatro compuertas, hoy cero» | **PARCIALMENTE CERRADA**: la tarjeta se actualizó, pero introdujo una imprecisión nueva y perdió una compuerta de vista → hallazgo 11 |
| Brecha 8 — §6 arrastra un modelo que su instrumento contradice | **MUTÓ**: §6 ya no cita el 12,3 %, pero el 390 y el 69 % siguen desalineados con el 423 vivo → hallazgos 1 y 2 |
| «La re-medición de las 147 resistió» | **CONFIRMADO en muestra de 12/12**, con evidencia propia |
| «Los catorce commits existen» | **CONFIRMADO y ampliado**: los once que el v3 cita están además **en el tronco** tras la fusión del PR 17 |

**Ninguna afirmación de la II que verifiqué resultó falsa. Una resultó exagerada** —«inertes» / «sin un solo registro», que su propio escéptico ya había matizado en `:261-263`— y el problema no es de la II sino de que el v3 republicó la versión sin matizar en lugar de la corregida (hallazgo 5).

---

## Balance

**Lo que la republicación arregló es real** y hay que decirlo: la duplicación estructural, la tarjeta rota, cinco de siete cifras caducas, y una honestidad nueva sobre la compuerta vacía. El v3 es mejor documento que el v2.

**Lo que no arregló tiene una forma sola:** de las nueve correcciones que la auditoría II dejó escritas con sus números ya calculados —cola 180, blockchain 1 346, PAC primario, `FLUJOS_CERRADOS`, adaptadores, eval, la formulación corregida—, la republicación aplicó las que eran de **prosa** y no aplicó **ninguna de las que eran de cifra o de código**. El resultado es un documento que se lee mejor y mide igual.

Y el nudo está en §1: la sección que promete no escribir números a mano es la que los escribe. Mientras esa baldosa no la genere el instrumento, cada auditoría va a volver a encontrar lo mismo, porque la única defensa que hoy tiene es que alguien se acuerde.
