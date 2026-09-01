> **Anclaje de esta medición.** El árbol se movió DURANTE la auditoría: al empezar `HEAD` era `6e280dd`; al terminar es **`689458a`** (el A3–A4 del plan se comprometió en `1ff9ca8` mientras yo medía). Todas las cifras de abajo son de `689458a` con el árbol limpio. El artefacto auditado es `plan-maestro.html` md5 `101fc3c8a30eb18584602522df1ca8ff`, **modificado a las 00:59 del 2026-09-01** (también durante la auditoría: le añadieron la tarjeta ✓ A3–A4). El contexto de la tarea decía «HEAD = a149e62»: eso ya no es cierto — hay **28 commits** entre `a149e62` y hoy.

---

## FORTALEZAS

**F1. Los catorce commits que el plan cita existen, todos.** Verificados uno a uno con `git log -1`: `40a45af`, `5d24463`, `edb1468`, `c4d47c6`, `f41f6cc`, `abb7f60`, `205e1e0`, `d2eef08`, `e282fe4`, `2cd656e`, `5ec9750`, `a6932b1`, `a149e62`, y el recién estampado `1ff9ca8`. Ninguno inventado. **VERDADERA.**

**F2. Las cabeceras de flujo de §4, corregidas por la auditoría I, hoy casan EXACTAMENTE con el catálogo.** Agregando `scripts/catalogo-estado.ts --json` por familia sobre las 379 filas de fase 1:
- F01 = 31 (`account` 15 + `entry` 12 + `ledger` 4) ✓ — `plan-maestro.html:346`
- F02 = 42 (`cfdi` 20 + `sat` 17 + `rep` 5) ✓ — `:362`
- F03 = 37 (`customer` 11 + `invoice` 11 + `receipt` 6 + `credit-note` 5 + `ar` 4) ✓ — `:390`
- F04 = 11 (`bill` 7 + `payment` 2 + `ap` 1 + `vendor` 1) ✓ — `:398`
- F05 = 38, F06 = 21, F07 = 10, F08 = 9 ✓
- «Mayores» de la cola: `report` 10, `close` 8, `year` 7, `entity` 7, `job` 7 ✓ — `:478`
Ocho cabeceras y cinco mayores, todas VERDADERAS. La brecha 2 de la auditoría I se pagó casi entera.

**F3. Las entregas de las siete tarjetas «✓ Hecha» están en el árbol, verificadas pieza por pieza.**
- **R1** (`:279`): `src/database/migrations/041_el_mayor_inviolable.sql:65` y `:98` (`BEFORE UPDATE OR DELETE` en las dos tablas del mayor), candado de TRUNCATE a nivel sentencia (`:101-102`), y «Ledger integrity» vivo en `src/ai/doctor-service.ts:808,824`.
- **R2** (`:299`): `mnemosine_verifier` creado en `scripts/provision-roles.sql:37-39` como rol de clúster `NOLOGIN NOSUPERUSER NOBYPASSRLS` — exactamente como la tarjeta lo cuenta.
- **R3** (`:318`): `mnemosine_refresher` en `scripts/provision-roles.sql:51`, con el chequeo de propiedad de las materializadas en `scripts/verify-isolation.sh:97-102`; migraciones `042` y `043` presentes.
- **A1–A2** (`:331`): golden set de **nueve** CFDI en `tests/golden/cfdi/` (18 archivos = 9 `.xml` + 9 `.esperado.json`), con los dos casos de PREGUNTAR (`ask-ambiguo-servicios`, `ask-equipo-computo`), el hostil (`sospechoso-inyeccion`) y el REP (`rep-recibido`) — literalmente lo que promete. `mnemosine ai stats` vivo en `src/cli/ai-command.ts:69`; migración `044` presente.
- **F01** (`:346`): `mnemosine account --help` entrega `set`, `archive`, `balance`, `role`, `map`; `ledger check`, `entry line list|preview|edit|export|import` invocables en el catálogo; el staging de la `045` con `batch_id` que referencia su propio lote (`045_el_lote_de_polizas_importadas.sql:41`), sin tocar el mayor.
- **F02** (`:596`): migración `046` presente; `INSERT INTO cfdi_classifications` real en `src/services/xml-ingestion/pre-registration-service.ts:642`; cliente SOAP propio en `src/services/sat/cfdi-status.ts`; `cfdi status show|sync` invocables; `rep_faltante_recibido`/`rep_faltante_emitido` con lector real en `src/services/accounting/period-close.ts:172,178`.
- **A3–A4** (`:375`, commit `1ff9ca8`): `src/ai/budget.ts:44` — `onExceed: file.onExceed ?? (opts.unattended ? 'block' : 'warn')`, el «desatendido bloquea» tal cual lo prometía; `shadow` en el panel (`src/services/policy/pending-catalog.ts:342`); envoltura UNTRUSTED en 10 archivos de `src/ai/`; migración `047`.

**F4. El maker-checker de §5 se resolvió de verdad, y con las tres piezas que la regla de la casa exige.** Política en el panel (`src/services/policy/pending-catalog.ts:439`), lector DENTRO del motor de posteo (`src/services/accounting/posting.ts:320,327`), huérfano pagado con llamada real (`src/ai/doctor-service.ts:882` importando de `src/api/rest/middleware/auth.ts:312`), y dos criterios que lo vigilan (`src/plan/criterios.ts:668,689`). **VERDADERA.**

**F5. Las puertas reales están en verde y crecieron.** `npm test`: **2 185** pruebas, 142 archivos, 0 fallos. `npm run test:integration`: **253** pruebas, 28 archivos, 0 fallos. `npm run catalogo:estado -- --check`: al día. Las cifras del plan (2 077 + 211) están por debajo — la dirección es la correcta.

**F6. Los rojos honestos del tablero SON el estado real, y el plan no los maquilla.** `npm run plan:status` hoy: E1.4 1/2 (depreciación sin puerta), E3.2 0/1 (descarga masiva SAT inexistente), E4.1 2/3, E4.2 1/2 (las mismas 4 copias del SQL: `src/ai/external-service.ts`, `src/api/graphql/resolvers/index.ts`, `src/api/rest/routes/reports.ts`, `src/services/blockchain/orchestrator.ts`), E5.1 13/15. Cada rojo del plan que verifiqué existe en el código: `fx_gain`/`fx_loss` tienen **cero** referencias en `src` (R4 VERDADERA), `RegistroPatronal="B0000000000"` sigue en `src/services/payroll/mx/cfdi-nomina-generator.ts:117` (F08 VERDADERA), el rechazo sigue muriendo en `review_notes` sin `teach` (A5 VERDADERA).

**F7. §5 dice la verdad sobre la superficie PAC, y con las líneas exactas.** CUATRO adaptadores: Sovos 492, Finkok 146, SW Sapien 122, EDICOM 102; `pac-router.ts` 244 — las seis cifras exactas al renglón (`wc -l src/services/integrations/mexico/pac/*.ts`). Y el detalle fino se sostiene: `pac-router.ts:21-23` registra finkok/swSapien/edicom pero **NO** `sovosReachcoreAdapter`, que sólo aparece en el mapa `PACS` (`:26`) — «configurarlo muere en PROVIDER_NOT_FOUND» sigue siendo cierto. La brecha 6 de la auditoría I quedó cerrada con precisión.

**F8. La disposición de las 147 tareas es real.** `docs/auditorias/2026-08-31-integral/disposicion-plan-cierre.md` existe y su tabla cierra en `| **Total** | **147** |` (línea 274). §7 «la herencia es a nivel tarea» se cumplió una vez, de verdad.

---

## BRECHAS

### 1. NUEVA — La compuerta de auditoría adversarial de §7 es estructuralmente incapaz de disparar, y tres flujos ya cerraron a través de ella

§7 (`plan-maestro.html:570`) declara: *«La auditoría adversarial cierra cada tramo — ahora con compuerta. Un flujo no entra a `--exigir` sin su registro en `docs/auditorias/`»*. El criterio existe (`src/plan/criterios.ts:235`, paquete E0.0) y su registro está **vacío**:

```
243:      const FLUJOS_CERRADOS: Record<string, string> = {
244:        // 'F01': 'docs/auditorias/F01.md',
245:      };
```

El único renglón está comentado. La comprobación de `:249-254` itera sobre un objeto vacío, así que `sinRegistro.length === 0` siempre, y el criterio siempre da verde. Cerrar un flujo es *añadir* una entrada — nadie la añadió.

Mientras tanto: **F01** (`a6932b1`), **F02** (`a149e62`) y **A3–A4** (`1ff9ca8`) están marcados «✓ Hecha» en §4; E1.2 y E1.3 —los paquetes que F02 pagó— **entraron a `--exigir`** en `.github/workflows/ci.yml:94`; y `ls -R docs/auditorias/` devuelve un solo directorio, `2026-08-31-integral/`, con los siete informes de la auditoría I. No hay `F01.md`, no hay `F02.md`, no hay `A3-A4.md`.

Es la clase exacta que el propio repositorio persigue: un criterio que mide el instrumento y no la medición. Y es el criterio que —de haber estado armado— habría atrapado casi todo lo que sigue.

### 2. NUEVA — El «meta-criterio que cuenta criterios sin espejo» de §7 no existe

§7 (`plan-maestro.html:568-569`): *«Cada criterio nuevo llega con su espejo en `tests/plan` que neutraliza la conducta medida y afirma el rojo; un **meta-criterio cuenta criterios sin espejo**»*.

`tests/plan/` contiene dos archivos: `criterios.spec.ts` (99 líneas) y `status.spec.ts`. `grep -rn "espejo\|mutante\|meta-criterio" tests/plan/*.ts` → **cero coincidencias**. `tests/plan/criterios.spec.ts` no contiene un solo mutante: sus cuatro comprobaciones sobre `CRITERIOS` son estructurales (que `paquete` matchee `/^E\d+\.\d+$/`, que `enunciado` tenga ≥5 palabras, que `detalle` sea no vacío — líneas 74-97). Y en `src/plan/criterios.ts` no hay ningún criterio que cuente espejos.

Las «siete mutaciones, siete acusaciones» de S1, los «cinco mutantes» de R3 y los «trece mutantes» de A1–A2 fueron trabajo real de sesión — pero no dejaron artefacto. La disciplina existe; el mecanismo que §7 afirma haber añadido, no. Y §7 remata la frase con *«E3.2 es el costo documentado de la prosa sin mecanismo»*: la frase se autodescribe.

### 3. NUEVA — El eval del clasificador nunca ha corrido, y nada lo exige

§3 pilar 1 (`plan-maestro.html:222`): *«Ningún cambio de prompt, modelo o umbral sin su corrida de evals»*. §7: *«Ninguna ampliación de autonomía… sin eval (A1), calibración (A2) y sombra (A4) previas»*.

- `ls docs/evals/` → **sólo `README.md`**. El archivo `clasificador.jsonl` —que el propio README describe como *«la memoria del mejoró/empeoró»*— **no existe**. Ninguna corrida se ha registrado jamás.
- `scripts/eval-clasificador.ts` **no está en `package.json`** (no hay script `eval:*`) y `grep -rn "eval" .github/workflows/*.yml` → cero. No corre en CI ni tiene atajo.
- El criterio que lo cubre (`src/plan/criterios.ts:2011`) comprueba que el arnés **mencione** el archivo:
  ```
  2035:      if (!/clasificador\.jsonl/.test(arnes) || !/agregarPuntuaciones\(/.test(arnes)) {
  ```
  Un regex sobre el código fuente del arnés. Nada verifica que exista una lectura.

A3–A4 (`1ff9ca8`) acaba de ampliar la autonomía del agente —añadió el modo `shadow` al panel y el presupuesto que bloquea— sin que exista una sola corrida de eval registrada. La regla de §7 se estrenó incumplida.

### 4. SIGUE-ABIERTA (auditoría I, brecha 1) — §1 vuelve a estar caduca contra su propio commit estampado, y la republicación de HOY la dejó intacta

§1 (`plan-maestro.html:152-158`) declara siete cifras «al commit estampado» `a149e62` (`:142`). Medidas contra `a149e62` y contra hoy:

| §1 dice | en `a149e62` | hoy (`689458a`) | veredicto |
|---|---|---|---|
| **8 / 15** paquetes en verde | 10/15 | **10/15** | CADUCA |
| **108** comandos vivos | 134 | **134** | CADUCA |
| 1 624 filas · 1 603 rutas | 1 624 · 1 603 | 1 624 · 1 603 | **VERDADERA** |
| **92** invocables | 119 | **119** | CADUCA |
| **379 / 84** fase 1 | 379 / 108 | 379 / **108** | 379 ✓, 84 CADUCA |
| **37** violaciones congeladas | 36 | **36** | CADUCA |
| **2 077 + 211** pruebas | — | **2 185 + 253** | CADUCA |

Evidencia: `git show a149e62:docs/cli-command-catalog.md` publica literalmente «134 comandos… 119 (7.3 %) ya se pueden invocar… 379 filas, de las que 108 ya se teclean»; `docs/catalogo-minimos.json` lleva la nota `_f02` («F02 subió el suelo 110→119 y 102→108»); `LINEA_BASE` en `src/cli/kernel/audit.ts:197` tiene **36** entradas en `a149e62` y 37 en `5d24463`.

**Cinco de siete cifras estaban caducas el día que se estampó el commit.** Y el propio documento se contradice: la tarjeta F01 dice «suelo 92→110» y la F02 «suelo 110→119», que son los números correctos, tres pantallas más abajo de un §1 que sigue diciendo 92.

Lo agravante es el momento: el artefacto **se republicó a las 00:59 de hoy** para añadir la tarjeta ✓ A3–A4 con el commit `1ff9ca8` (`:375`) — quince commits después de `a149e62` — y §1 no se tocó. §7 (`:561`) dice: *«las cifras de esta página llevan commit y se re-preguntan, y **la §1 se corrige en cada republicación o no se publica**»*. La regla se rompió en la propia republicación que la gobierna. Y §1 conserva la nota que se jacta de haber aprendido: *«la auditoría atrapó a la versión anterior de esta página portando siete cifras caducas contra su propio commit»* (`:160-161`).

Coda: la tabla «Hecho» de §1 (`:167-178`) **no tiene renglón para A3–A4**, aunque §4 ya lo marca ✓. §1 y §4 no coinciden en qué está hecho.

### 5. NUEVA — El documento publica §3–§7 DOS VECES, y la única tarjeta «✓ F02» quedó archivada fuera de §4

`grep -n 'sec-num">§' plan-maestro.html` devuelve: §1 (150), §2 (185), §3 (214), §4 (238), §5 (490), §6 (543), §7 (561), **§3 (617), §4 (641), §5 (893), §6 (946), §7 (964)**. Las líneas 617–998 repiten 214–608. Toda la mitad prospectiva del plan —los seis pilares AI-first, las dieciocho tarjetas de la secuencia, las seis decisiones de §5, el compromiso de §6 y las siete reglas de §7— está duplicada.

Peor: la tarjeta **✓ F02 / `a149e62`** existe una sola vez, en la línea **596** — es decir, *dentro de §7*, entre la última regla de gobierno y el §3 duplicado. En las dos copias de §4 donde un lector la buscaría (`:362` y `:765`), F02 aparece **sin ✓**, como trabajo pendiente, con su cabecera de «42 filas». El commit que el encabezado del documento estampa figura como no hecho en los dos lugares donde se lee la secuencia.

Y el modo de fallo ya se manifestó: la edición de las 00:59 parchó **ambas** copias de A3–A4 (`:375` y `:778`) pero dejó F02 sin marcar en las dos. Un documento duplicado obliga a acertar dos veces en cada edición; ésta acertó en una tarjeta y falló en otra.

### 6. SIGUE-ABIERTA (auditoría I, brecha 2, parcial) — La cola y §6 no cuadran: 179 vs 180, 378 vs 379

Agregando el catálogo de hoy: los ocho flujos suman **199** filas de fase 1 y la cola F09–F12 son **180** filas en **65** familias con **24** de un solo comando. El plan dice **179** (`:475`, `:878`) y §6 (`:545`) dice: *«378 filas al medidor de hoy (31+42+37+11+38+21+10+9 en flujos + 179 de cola: **la suma cierra sin filas perdidas**)»*.

199 + 179 = 378 ≠ 379. La suma **no** cierra. La fila que falta es la que S1 rescató: `pac create`, cuyo pipe sin escapar corría las columnas — y `pac` es familia de cola (5 filas hoy: `pac create|list|status|balance show|test`). El propio documento lo cuenta dos veces: §1 (`:156`) dice 379 y la tarjeta S1 dice «fase 1 pasa a 379 al recuperarla». §6 sigue en 378 y afirma cuadrar.

Cerró: las tres cabeceras y las cinco mayores (ver F2). Queda abierta: la cola y el total de §6.

### 7. NUEVA — El tamaño de la cola, que §4 promete publicar, no lo publica ningún medidor

`plan-maestro.html:482`: *«El medidor publicará el tamaño de la cola para que «si tres sprints seguidos no la bajan, el orden se revisa» sea un dato y no una intención»*.

`grep -n "cola" scripts/catalogo-estado.ts` → tres coincidencias, ninguna de ellas emite un total de cola (`:125`, `:130` son comentarios sobre rutas colapsadas; `:493` es un mensaje de error sobre pipes sin escapar). El bloque generado en `docs/cli-command-catalog.md:52-78` publica comandos, familias, filas, invocables, objetivo comprometible, rutas únicas y una tabla por familia — **ninguna línea de cola, ninguna noción de F09–F12**. Las 180 filas de esta auditoría las derivé a mano agregando el `--json`. La regla de revisión de orden sigue siendo, exactamente, una intención.

### 8. NUEVA — §6 arrastra un modelo de costes que su propio instrumento ya contradice

§6 (`:547-552`) conserva ~250/~390/~520 líneas por fila y **12.3 %** de cola correctiva, y añade: *«`scripts/costo-por-fila.ts` lo vuelve serie: si el costo real de las ~42 filas nuevas divergió, hoy nadie lo sabría»*.

El instrumento existe, corre y ya tiene cuatro puntos. `npm run costo:por-fila` hoy:

```
  2bf6630     4    2499          625   S0.6
  a6932b1    18    8471          471   F01
  a149e62     9    2042          227   F02
  Agregado desde S0.1: 31 fila(s) · 13126 líneas · 423 líneas/fila
  Cola correctiva declarada: 111 de 15025 líneas = 0.7%
```

**423 líneas/fila** frente a las 390 de referencia, y **0.7 %** de cola frente al 12.3 % que §6 declara *«constante del oficio»*. El propio script advierte que su 0.7 % subestima la cola dispersa en commits mixtos, así que no es una refutación limpia del 12.3 % — pero §6 no cita ni una de las dos lecturas. Se construyó el instrumento para dejar de recordar el número, y §6 sigue recordándolo. «Hoy nadie lo sabría» dejó de ser cierto; el documento no se enteró.

### 9. SIGUE-ABIERTA (auditoría I, brecha 7) — GraphQL y blockchain siguen sin decisión, y la superficie blockchain CRECIÓ mientras esperaba

- **GraphQL**: `wc -l src/api/graphql/**/*.ts` = **918** líneas exactas (`schema.ts` 525 + `resolvers/index.ts` 393). La cifra del plan (`:207`, `:511`) es exacta. Gobierno: un solo criterio, y sólo vigila que el flag siga apagado (`src/plan/criterios.ts:1392-1393`: *«si no está montado, ok»*). Cero decisión escrita, cero `policy_decision`. Y sigue siendo una de las cuatro copias del SQL de saldos que E4.2 acusa.
- **Blockchain**: hoy **1 346** líneas (`orchestrator.ts` 554 + `crypto-service.ts` 233 + adaptadores), no 1 341 (`:520`, `:923`). Creció cinco líneas mientras espera la decisión «gobernar o congelar». `grep -ni "blockchain" src/plan/criterios.ts` → una sola coincidencia, y es un comentario incidental (`:1363`). Ni fila, ni criterio, ni congelación.

Dos mil doscientas sesenta y cuatro líneas de superficie de producción sin gobierno, once meses-commit después de que S0.5 se creara justamente para impedirlo.

### 10. SIGUE-ABIERTA (auditoría I, brecha 5 / recomendación 4) — Los cuatro adaptadores de integración siguen fuera de todo censo

`src/services/integrations/index.ts:12-15` registra `stripeAdapter`, `conektaAdapter`, `sendGridAdapter` y `s3Adapter` al importar. Buscando consumidores fuera de su propio directorio: **cero** — las únicas menciones son el import y el `register` del propio índice. La auditoría I recomendó congelarlos en la línea base de huérfanos. La lista de hoy (`src/plan/criterios.ts:761-768`) tiene **tres** entradas y ninguna es un adaptador:

```
765:        autoExecuteOpByPolicy: 'external-service.ts',
766:        earlyPaymentDiscount: 'bill-service.ts',
767:        calculateBenefitsForPaycheck: 'benefits-service.ts',
```

Tampoco están en `RECLAMADAS` (`:275-281`, que sólo cubre tablas). Y el caso agudo sigue vivo: F03 (`:392`) plantea «cablear el envío o retirar la promesa» de `invoice send` — y el catálogo mismo ya lo dice dos veces: *«`sendGridAdapter` registrado en `src/services/integrations/index.ts:14` sin consumidor»* (`docs/cli-command-catalog.md:970` y `:1047`). El dato está escrito en tres sitios y no lo vigila nadie.

### 11. NUEVA — Trece commits posteriores a `a149e62` tocan producción y no existen para el plan

`git log --oneline a149e62..HEAD` da 13 commits no-merge que modifican código embarcado: `236b2cf` (rate limiter, verificación pública, ingesta XML, `index.ts`, redis), `131b8b8`, `14b5167`, `5a16de1`, `9f10dcf`, `1c86e0c` (CodeQL: CSP, redacción de bitácora, credencial en el error final), `d873034` (acotar el verificador de Merkle), `6e280dd`, `d603e30`, `d0d883f`, `e5354ef`, `40bca4d`, `d77d86a`, `fa38ff7`, `a384fd6`.

Ninguno aparece en la tabla «Hecho» de §1 (`:167-178`), ninguno tiene fila de catálogo, ninguno tiene criterio. Es endurecimiento de seguridad real —el freno antes de autenticar, el CSP, la credencial tachada— entrando al árbol sin renglón que lo gobierne. La imagen especular de la capacidad huérfana: no código sin dueño, sino **trabajo sin registro**. Y `be0288f` («Fase 0-1 … (#1)») indica además que la rama ya se fusionó a `main`, hecho que el pie del plan (`:697-700`, «rama `fase-0-1-cli-y-cimientos`») no refleja.

### 12. NUEVA — La tarjeta F06 «cuatro compuertas fiscales, hoy cero» está caduca: dos ya están puestas

`plan-maestro.html:416,819`: *«el checklist de cierre gana sus **cuatro compuertas fiscales**, hoy cero»*. Hoy son dos de cuatro, y las puso F02:
- `src/services/accounting/period-close.ts:149-181` — «Payments in period have their REP», con los dos conteos separados por dirección (`vendor_payments` sin `cfdi_uuid` y `customer_payments` sin `cfdi_uuid`) y las políticas `rep_faltante_recibido`/`rep_faltante_emitido` decidiendo si bloquean o avisan (`:172`, `:178`).
- Más un ítem que no estaba en las cuatro: «Parked payment receipts (REP) resolved» (`:143-148`).

Faltan las dos que sí siguen a cero: «cuentas con movimientos sin agrupador SAT» y «IVA aparcado en 1135/2125 vs. saldo contable» — `grep agrupador` en `period-close.ts` no da nada. F06 debería leer «dos compuertas, no cuatro; y hoy no son cero».

### 13. NUEVA — La tarjeta de maker-checker de §5 quedó rota al marcarla resuelta, y sigue listada entre las decisiones pendientes

`plan-maestro.html:526-528` (y su gemela en `:929-931`):

> «`checkSoDViolations` existe con cero llamadores y el esquema soporta el flujo entero. O se **RESUELTA EN F01**: política del panel (`segregacion_de_funciones`, off/alertar/exigir) con lector en el motor para pólizas manuales y el huérfano pagado en doctor. Ya no se / fase 2 por escrito. Hoy el diferimiento es tácito, que es como se pierden las obligaciones.»

La inserción de «RESUELTA EN F01» partió la oración original en dos («O se… o se difiere a fase 2 por escrito») y dejó un fragmento sin sujeto. Peor que la prosa: la tarjeta sigue **dentro de §5, «Bloqueado y por decidir»**, con el mismo estilo de las decisiones vivas de Victor, y su primera frase sigue afirmando en presente que el símbolo tiene cero llamadores — cuando `src/ai/doctor-service.ts:882` lo llama desde F01. Una decisión resuelta que se lee como pendiente y afirma en falso su propio estado.

### 14. NUEVA — El PAC primario que el documento recomienda no es el que el código pone por omisión

§5 (`:500`, `:903`): *«SW Sapien sigue recomendado como primario y ya tiene arranque»*, coherente con `docs/pac-proveedores.md:237` («Primario: SW sapien. Failover: Finkok o Prodigia»). Pero el código, cuando un inquilino no ha elegido:

```
src/services/integrations/mexico/pac/pac-router.ts:52
        pac_primary: 'finkok',
        pac_secondary: 'sw_sapien',
```

El default operativo es Finkok. Un despacho que no decide hereda el proveedor que el documento *no* recomienda. Si esto es criterio contable/fiscal es material de panel; si es preferencia de operación, al menos el documento y el `pac-router` deberían decir lo mismo. Hoy no lo dicen.

### 15. NUEVA (menor) — Tres promesas cuya entrega difiere de la letra, sin que el plan lo señale

- **`REVOKE DELETE`**: la promesa de R1 (`:282`, `:685`) dice *«trigger… + REVOKE DELETE + la prueba»*. La migración lo declina explícitamente: `041_el_mayor_inviolable.sql:28` — *«No hay REVOKE aquí: el GRANT general de `rls-policies.sql`…»*. La decisión es razonada y el párrafo «Hecho» no lo reclama; pero la promesa quedó en la página sin la nota de que se cambió de opinión.
- **«los 6 exports huérfanos de hoy»** (tarjeta S1, `:259`, `:657`): nunca fueron seis. El comentario del propio criterio dice *«cuatro exports»* y nombra cuatro destinos (`src/plan/criterios.ts:756-760`); la lista congelada tuvo 4 y hoy tiene 3 (`:761-768`) porque F01 pagó `checkSoDViolations` y A3 pagó `autoApproveDraftByPolicy`. El mecanismo funciona; la cifra del documento no cuadró nunca.
- **«`npm run lint` es un no-op sin configuración»** (`:163`): es peor que un no-op. `npm run lint` **falla con código distinto de cero**: `ESLint: 8.57.1 / No files matching the pattern "src/" were found`. Inofensivo (no está en CI, cuyos jobs son typecheck/unit/integration/aislamiento) pero la descripción es imprecisa: no es un script silencioso, es un script roto.

---

### Dictamen sobre la auditoría I (`docs/auditorias/2026-08-31-integral/maestro-vs-codigo.md`)

| # | Brecha de la auditoría I | Hoy |
|---|---|---|
| 1 | §1 caduca en siete cifras contra su propio commit | **SIGUE-ABIERTA** (mutó: 5 de 7, y la republicación de hoy no la corrigió) → brecha 4 |
| 2 | Tres cabeceras de flujo y la cola no casan | **SIGUE-ABIERTA parcial** — cabeceras y mayores CERRADAS (F2), cola 179→180 abierta → brecha 6 |
| 3 | `pac create` con fase vacía, sin invariante | **CERRADA** — `scripts/catalogo-estado.ts:471-481` impone fase ∈ {1,2,3}; `pac` tiene 5 filas, todas con fase; `--check` al día |
| 4 | El criterio «doctor sin huérfanos nuevos» no existe | **CERRADA** — `src/plan/criterios.ts:745-777`, con el patrón de `LINEA_BASE`, y ya encogió dos veces |
| 5 | Los 4 adaptadores de integración, fuera del censo | **SIGUE-ABIERTA** → brecha 10 |
| 6 | §5 subdeclara la superficie PAC | **CERRADA** — enumera los cuatro con líneas exactas, verificadas (F7) |
| 7 | GraphQL y blockchain sin fila, criterio ni decisión | **SIGUE-ABIERTA** (y blockchain creció) → brecha 9 |

**3 cerradas · 4 abiertas · 11 nuevas.**

---

## RECOMENDACIONES

1. **(S · S1-bis, hoy) Armar la compuerta que ya existe.** Poblar `FLUJOS_CERRADOS` (`src/plan/criterios.ts:243`) con `F01`, `F02` y `A3-A4`, y escribir los tres registros en `docs/auditorias/`. Esta auditoría de siete lentes **es** el registro de F01/F02/A3-A4: archivarla bajo `docs/auditorias/2026-09-01-integral-ii/` y apuntar las tres entradas ahí paga la deuda en el mismo commit. Sin esto, la regla de §7 es prosa por segunda vez, y ya sabemos lo que cuesta (E3.2).

2. **(S · S1-bis) Cerrar §1 a mano de una vez y luego quitarle la mano.** Corregir las cinco cifras caducas (10/15, 134, 119, 108, 36, 2 185+253) y añadir el renglón A3–A4 a la tabla «Hecho». Después, el arreglo de fondo: que el bloque de §1 lo **genere** el mismo instrumento que ya regenera `docs/cli-command-catalog.md`, con su commit estampado. La regla de §7 («la §1 se corrige en cada republicación o no se publica») acaba de fallar por tercera vez; lo que falla tres veces no es disciplina, es diseño.

3. **(S · S1-bis) Desduplicar el documento y repatriar la tarjeta ✓ F02.** Borrar las líneas 617–998 de `plan-maestro.html` y mover la tarjeta de `:596` a su lugar en §4, sustituyendo el F02 sin ✓ de `:362`. Mientras el documento tenga dos copias, cada edición tiene dos oportunidades de mentir y ya usó una.

4. **(S · S1-bis) Reparar la tarjeta de maker-checker y sacarla de §5.** `plan-maestro.html:526-528` — reescribir la oración partida y mover la tarjeta a un bloque «decisiones resueltas» o a §4 junto a F01. Una decisión resuelta que se lee como pendiente y afirma en falso «cero llamadores» es, literalmente, un verde falso invertido.

5. **(M · tramo A, antes de A5) Que el eval deje una lectura, no sólo un instrumento.** Tres piezas: (a) añadir `"eval:clasificador"` a `package.json`; (b) correrlo una vez y **commitear `docs/evals/clasificador.jsonl`** — la primera línea es la línea base; (c) reforzar el criterio de `src/plan/criterios.ts:2011` para que exija que el `.jsonl` exista y tenga al menos una corrida, no que el arnés lo mencione. Sin esto, «medir antes de soltar» ya se incumplió una vez (A3–A4 amplió autonomía sin una sola corrida) y se volverá a incumplir en A4→`on`.

6. **(M · tramo A) El meta-criterio de los espejos, o borrar la promesa de §7.** Si cada criterio debe traer su mutante, el mutante tiene que ser un artefacto: una convención (`tests/plan/espejos/E5.1-*.spec.ts`) y un criterio que cuente criterios sin archivo espejo, con línea base congelada como la de los huérfanos —que ya demostró funcionar tres veces—. Si el coste no se quiere pagar, quitar la frase de §7: una regla que nadie puede comprobar es peor que no tenerla, porque se cita como si protegiera.

7. **(S · antes de F09–F12) Publicar la cola en el medidor.** Añadir a `scripts/catalogo-estado.ts` la línea «cola F09–F12: N filas · M familias» derivada de la resta flujos-vs-fase-1, y llevar el suelo de la cola a `docs/catalogo-minimos.json` como techo que sólo baja. Con eso, «si tres sprints seguidos no la bajan, el orden se revisa» pasa a ser un dato, y de paso §6 deja de poder decir 378 mientras el medidor dice 379.

8. **(S · S1-bis) Extender `HUERFANOS_CONGELADOS` a los cuatro adaptadores.** `stripeAdapter`, `conektaAdapter`, `sendGridAdapter`, `s3Adapter` en `src/plan/criterios.ts:761`, cada uno con su destino (`sendGrid` → F03; el resto, dueño o retiro como el costeo de S0.4). Cambia una decisión real: F03 debe saber que cablear `invoice send` cuesta 88 líneas ya escritas, no un motor nuevo.

9. **(M · §5, decisión de Victor) GraphQL y blockchain: la decisión, o el congelador con criterio.** Son 2 264 líneas y la de blockchain creció mientras esperaba. Mínimo ejecutable hoy sin decisión: un criterio de «superficie congelada» que falle si `wc -l` de `src/api/graphql` o `src/services/blockchain` **sube**. Retirar GraphQL, además, borra una de las cuatro copias del SQL de saldos y adelanta E4.2, que es prerrequisito declarado de `report` (10 filas, la mayor de la cola).

10. **(S · §5/§4) Alinear el PAC primario.** O `pac-router.ts:52` pasa a `sw_sapien`, o `docs/pac-proveedores.md:237` y §5 pasan a Finkok. Y si la elección de PAC tiene consecuencia fiscal (plazos, acuses, custodia), va al panel con su lector, según la regla de la casa.

11. **(S · §4) Actualizar F06 y §6 con lo que F02 ya entregó.** F06: «dos de las cuatro compuertas fiscales ya están (`period-close.ts:149-181`); faltan agrupador SAT e IVA aparcado en 1135/2125». §6: 379 filas, 199 en flujos + 180 en cola, y citar la lectura viva de `costo:por-fila` (423 líneas/fila, 0.7 % declarado con su límite dicho) junto a la referencia fundacional, en vez de en lugar de ella.

12. **(M · §7, regla nueva) La herencia también es de commits, no sólo de tareas.** §7 dice «la herencia es a nivel tarea, no prosa»; hay trece commits de producción sin renglón (brecha 11). Proponer la regla simétrica: **todo commit que toque `src/` entra a la tabla «Hecho» de §1 o a un criterio, o declara por qué no** — y un criterio que cuente commits desde el último estampado sin renglón. Es el mismo trinquete que ya funcionó para las violaciones del CLI y para los huérfanos, aplicado a la única superficie que hoy escapa: el trabajo mismo.


---

## VERIFICACIÓN ADVERSARIA DEL HALLAZGO MAYOR

**Hallazgo:** Las dos compuertas que §7 declara «ahora con mecanismo» están inertes en HEAD: `FLUJOS_CERRADOS` está vacío (`src/plan/criterios.ts:243-245`, único renglón comentado) así que F01/F02/A3-A4 se declararon hechos y E1.2/E1.3 entraron a `--exigir` (`.github/workflows/ci.yml:94`) sin un solo registro en `docs/auditorias/`, y el «meta-criterio que cuenta criterios sin espejo» no existe (`tests/plan/criterios.spec.ts` no contiene un solo mutante; cero coincidencias de «espejo» en `tests/plan/`).

**¿Refutado?** No: se sostiene

Intenté refutarlo y el código lo sostiene en lo sustancial, con tres imprecisiones que hay que corregir.

QUÉ SE CONFIRMA (evidencia propia):
1) `FLUJOS_CERRADOS` vacío. `src/plan/criterios.ts:243-245`: `const FLUJOS_CERRADOS: Record<string, string> = { // 'F01': 'docs/auditorias/F01.md', };` — un único renglón, comentado. La rama que acusa (`src/plan/criterios.ts:249-259`) filtra sobre un mapa vacío, así que `sinRegistro.length === 0` es una constante: la compuerta por flujo es inalcanzable. Idéntico en a149e62 (`git show a149e62:src/plan/criterios.ts` → misma línea 243).
2) El criterio vive en el paquete E0.0 (`src/plan/criterios.ts:234`), que SÍ está en `--exigir` (`.github/workflows/ci.yml:94`), o sea: corre en CI y pasa siempre.
3) F01/F02/A3-A4 se cometieron sin tocar `FLUJOS_CERRADOS` ni `docs/auditorias/`: `git show --stat` de a6932b1 (F01), a149e62 (F02) y 1ff9ca8 (A3-A4) da CERO archivos bajo `docs/auditorias/`. `git log --diff-filter=A -- docs/auditorias` sólo muestra abb7f60 (los 8 informes de la integral) y 205e1e0 (`disposicion-plan-cierre.md`), ambos anteriores a esos cierres.
4) E1.2/E1.3 entraron a `--exigir` en el MISMO commit que cerró F02: `git show a149e62 -- .github/workflows/ci.yml` es exactamente `-...E1.1,E2.1... / +...E1.1,E1.2,E1.3,E2.1...` (ci.yml:94), y `git log -S"E1.2,E1.3"` devuelve sólo a149e62. Además el comentario de arriba (ci.yml:78-86) sigue explicando por qué E1.2 SALIÓ, sin actualizarse ante su regreso.
5) El meta-criterio no existe: `tests/plan/criterios.spec.ts` (103 líneas, 8 pruebas) no neutraliza ninguna conducta medida — sus tests son sobre `sinComentarios`, `fuentes`, `consumidoresDe` y forma de los enunciados; `grep -c "espejo\|mutant\|mutación" tests/plan/*` = 0 en ambos archivos. Y no hay criterio en `src/plan/criterios.ts` que se mida a sí mismo (`CRITERIOS` sólo aparece en :6 y :160; ninguna referencia a `tests/plan`). Busqué otros nombres (meta-criterio, contra-prueba, mutante) y en `src/plan/` sólo salen menciones en prosa de comentarios (:635, :2039).

QUÉ NO SE SOSTIENE LITERALMENTE:
a) «sin un solo registro en docs/auditorias/» es falso como se lee: existen 9 archivos en `docs/auditorias/2026-08-31-integral/`. Lo que no existe es un registro POR FLUJO; los que hay son la integral previa (HEAD 5d24463) más `disposicion-plan-cierre.md`.
b) «inertes» es exagerado para la primera compuerta: `src/plan/criterios.ts:246-248` sí tiene una aserción viva — falla si desaparece `docs/auditorias/2026-08-31-integral/README.md`. Es un candado de conservación del archivo, no la compuerta por flujo. Lo inerte es la rama del mapa.
c) A3-A4 cae fuera del alcance declarado por el propio criterio: su comentario (`src/plan/criterios.ts:239-240`) habla de «declarar cerrado un F0x» y «cerrar un flujo». A3/A4 son tramo A, no flujos. Y la entrada de E1.2/E1.3 a `--exigir` responde al trinquete de paquetes (otro mecanismo), no a esta compuerta: el hallazgo los mezcla.

NOTA DE ALCANCE: el «§7 declara ahora con mecanismo» no es verificable en el repo — el Plan Maestro es un artifact externo (`docs/auditorias/2026-08-31-integral/README.md:16` lo llama «El Plan Maestro (artifact)») y no existe `plan-maestro.txt` en disco. Lo más cercano en repo es `docs/auditorias/2026-08-31-integral/doce-cobertura.md:32`, donde el meta-criterio de espejos aparece como RECOMENDACIÓN (M) pendiente, no como mecanismo entregado. También noto que HEAD real hoy es 250ac59, no a149e62; comprobé ambos y en los puntos citados no hay diferencia.

**Formulación corregida:** La compuerta de auditoría por flujo existe pero su registro está vacío: `FLUJOS_CERRADOS` en `src/plan/criterios.ts:243-245` no tiene ni una entrada (sólo `// 'F01': 'docs/auditorias/F01.md'`), de modo que la rama acusadora de `src/plan/criterios.ts:249-259` es inalcanzable y el criterio pasa siempre; lo único vivo es que no se borre `docs/auditorias/2026-08-31-integral/README.md` (`:246-248`). Con esa compuerta vacía, F01 (a6932b1) y F02 (a149e62) se declararon cerrados sin añadir su entrada ni ningún registro por flujo — `docs/auditorias/` sólo contiene la auditoría integral del 2026-08-31 (abb7f60) y `disposicion-plan-cierre.md` (205e1e0), ambas anteriores y ninguna específica de un flujo. En paralelo, el trinquete de paquetes avanzó sin ese respaldo: a149e62 añadió E1.2 y E1.3 a `--exigir` en `.github/workflows/ci.yml:94` en el mismo commit que cerró F02, dejando además sin actualizar el comentario de ci.yml:78-86 que aún justifica la SALIDA de E1.2. Y el meta-criterio que haría exigible la convención de espejos —recomendado en `docs/auditorias/2026-08-31-integral/doce-cobertura.md:32` como (M) pendiente— no se implementó: `tests/plan/criterios.spec.ts` no contiene un solo mutante (cero coincidencias de «espejo»/«mutante» en `tests/plan/`) y ningún criterio de `src/plan/criterios.ts` mide la cobertura de `CRITERIOS` por pruebas. Matices: A3-A4 (tramo A, 1ff9ca8) queda fuera del alcance que el propio criterio se fija («cerrar un flujo», F0x), y el que E1.2/E1.3 entren a `--exigir` pertenece al trinquete de paquetes, mecanismo distinto de esta compuerta.

