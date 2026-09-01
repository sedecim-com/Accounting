Auditoría II · LENTE C — El instrumento: ¿el tablero mide lo que importa?
HEAD 689458a · rama fase-0-1-cli-y-cimientos · 2026-09-01

Medidores preguntados, no supuestos: `npm run plan:status` → 10/15 verdes, 69 criterios en 15 paquetes; `npx tsx scripts/catalogo-estado.ts` → 1624 filas, 119 invocables, fase 1 108/379, 134 hojas vivas en 45 familias; `npx tsx scripts/costo-por-fila.ts` → 423 líneas/fila, cola declarada 0.7 %.

---

## FORTALEZAS

1. **El trinquete del plan está al día, sin retraso.** La lista `--exigir` de `.github/workflows/ci.yml:94` (E0.0, E0.1, E0.2, E0.3, E1.1, E1.2, E1.3, E2.1, E2.2, E3.1) es EXACTAMENTE el conjunto de paquetes verdes de hoy. No hay ni un paquete cerrado fuera del trinquete: E1.2 volvió tras F02 y E1.3 entró. Un trinquete que se olvida de crecer es el modo normal de fallo de esta clase de instrumento, y aquí no ocurrió.

2. **La reapertura con causa está ejercitada y documentada en el diff.** `ci.yml:76-93` explica por qué E1.2, E4.1 y E3.2 salieron: falso verde con nombre y evidencia. El instrumento ha demostrado que ACEPTA BAJAR — la regla (d) «rojos honestos > verdes falsos» tiene tres precedentes reales, no una declaración de intenciones.

3. **`--exigir` a un paquete inexistente ya no pasa en silencio** (`src/plan/status.ts:217-227`). Era el desagüe del trinquete: borrar o renombrar un paquete en criterios.ts reabría lo cerrado sin ponerse rojo. El instrumento vive en el mismo commit que juzga, y esto lo cierra.

4. **`bloqueadoPorEntorno` distingue «regresión» de «aquí no hay instrumento»** (`status.ts:105-131`). Un criterio con `necesita:` no evaluado se muestra pero no exige. Es la única forma de que la misma compuerta signifique lo mismo en la portátil y en CI.

5. **El instrumento tiene su propio meta-test, y cada caso nació de un error real** (`tests/plan/criterios.spec.ts:11-16, 46-53, 64-71`): el regex que encontró su propia definición, `getPolicy` vs `getPolicySpec`, la prosa leída como conducta. La disciplina de anclar existe — le falta forma ejecutable (brecha 13).

6. **El suelo del catálogo sube en el MISMO commit que gana el terreno** (`docs/catalogo-minimos.json`), con la bajada de S0.7 anotada como corrección del instrumento y no como cesión de terreno. Y `--check` lleva dos invariantes estructurales antes del trinquete (fase legible ∈ {1,2,3}, y «el parseo no pierde filas», `scripts/catalogo-estado.ts:475-500`): son las dos formas exactas en que el medidor se rompió antes.

7. **El modelo de costes dejó de ser memoria y pasó a ser pregunta.** `scripts/costo-por-fila.ts` existe, corre y declara sus tres límites en el propio encabezado (proxy invocable≈fila, cola subestimada, segmentos Δinv=0). Cierra la brecha que la auditoría I levantó en `doce-cobertura`.

8. **La cobertura es trinquete POR ARCHIVO y las dos ausencias están dichas** (`vitest.config.ts:24-35`). Un umbral global es un promedio; éstos no. Que `period-close.ts` y `sequence.ts` lleven su hueco escrito en vez de un número inventado es exactamente la regla (d).

---

## BRECHAS

### CERRADAS desde la auditoría I (verificadas en HEAD)

1. **El modelo de costes ya tiene instrumento** — CERRADA. `scripts/costo-por-fila.ts` deriva la serie del movimiento del suelo; `npm run costo:por-fila` está en package.json.
2. **E3.2 dejó de ser falso verde** — CERRADA. Su criterio (`src/plan/criterios.ts:1589-1620`) hoy sale ⬜ 0/1 con detalle «ni SOAP, ni ZIP, ni comando», y el paquete salió del `--exigir` con su porqué en `ci.yml:86-93`.
3. **«Doctor sin huérfanos nuevos entra como criterio»** — CERRADA. `criterios.ts:744-777` congela tres huérfanos por nombre y destino; la lista sólo puede encoger.
4. **`checkSoDViolations` dejó de ser huérfano** — CERRADA en detección. Tiene llamador real (`src/ai/doctor-service.ts:882`) y criterio que lo ancla a la forma de llamada (`criterios.ts:689`).

### SIGUE-ABIERTAS

5. **E2.2 cierra con dos criterios que no miran la segregación preventiva** — SIGUE-ABIERTA (auditoría I, brecha 3). La SoD hoy se DETECTA en `runDoctor` (que nunca es `fail`), no se PREVIENE al asignar el rol ni al aprobar. E2.2 luce ✅ 2/2 midiendo el catálogo único de permisos y el secreto de producción. Un paquete con dos criterios no puede sostener el peso de «el estado es el peor de sus criterios».
6. **Las 147 tareas del plan de cierre siguen sin disposición individual** — SIGUE-ABIERTA (auditoría I, brecha 7). Ni `criterios.ts` ni el catálogo mapean tarea→(hecha/absorbida-en/retirada/caída). Las 69 filas de criterios no son trazables a las 147 obligaciones que dicen heredar.
7. **`costo-por-fila` mide la unidad equivocada para el trabajo que la casa dice que importa** — SIGUE-ABIERTA en forma nueva. Su serie sólo tiene puntos donde se movió el suelo del catálogo: los tramos R (el mayor inviolable) y A (el agente medible) ganan CERO filas invocables y su costo se diluye en el agregado sin aparecer como renglón. El instrumento premia superficie y hace invisible la garantía. Su cola correctiva declarada (0,7 % contra el 12,3 % fundacional) es el síntoma: el propio script dice que subestima, y nadie ha ajustado el método.

### NUEVAS

8. **El tablero mide TEXTO, no CONDUCTA — y lo hace en 66 de 69 criterios.** Sólo tres criterios ejecutan algo: el sello de periodo (`criterios.ts:399`), la auditoría del programa embarcado (`:1710-1711`) y el registro de riesgo (`:1741-1743`). Los otros 66 son 163 `.test()` de expresión regular sobre el fuente. **Ningún criterio postea un asiento, cierra un periodo, calcula una balanza ni compara un saldo.** El tablero puede quedarse en 15/15 con un motor contable que produce números equivocados, siempre que los símbolos sigan escritos como el regex espera. Es el límite estructural del instrumento, y no está declarado en ninguna parte del propio instrumento.

9. **La RECUPERACIÓN es el hueco total: cero código, cero criterio, cero ensayo.** `grep -rn "pg_dump|pg_restore|PITR|WAL"` sobre `src`, `scripts`, `.github` y los dos planes: **ninguna coincidencia**. No hay respaldo, ni restauración, ni RTO/RPO, ni prueba de que la cadena de 52 migraciones reconstruya una base con datos. En un sistema que el propio plan justifica citando el art. 30 del CFF (cinco años de conservación, `docs/plan-cierre-brechas.md:1623`), el tablero no tiene una sola fila sobre poder recuperar lo conservado. **Es la mayor capacidad crítica sin vigilancia del repositorio.**

10. **El único criterio que declara `necesita` no ha juzgado nada nunca, en ningún entorno.** `criterios.ts:373-455` (sello de periodo vs asientos posteados). En CI el job `plan` no tiene servicio Postgres (`ci.yml:60-102`), así que sale `no-evaluable` y `exigiblesAbiertos` lo descarta por diseño — E0.1 aparece 🟠 en CI y el trinquete pasa igual. Comprobado: `DATABASE_URL=…:1 npm run plan:status E0.1` → 🟠 12/13. Y con base accesible pero vacía retorna `ok('sin sellos de periodos cerrados que revisar')` — verde por no mirar, confesado en el detalle pero contado como verde por `estadoDe`. El campo `necesita` es hoy, en la práctica, un interruptor de apagado permanente con una sola posición ocupada.

11. **La cobertura real se mide sobre 17 de 266 archivos, y se atrinchera en 4.** `vitest.config.ts:16` incluye `src/services/accounting/**` (16 archivos) más `src/utils/sequence.ts`; los umbrales cubren 4. Queda **sin medición alguna** todo `src/ai` + `src/api` + `src/cli` (134 archivos): el agente que la casa acaba de dotar de presupuesto, sombra y autorizador único no tiene una sola línea de cobertura medida. El comentario del archivo justifica bien por qué no se mide TODO; no justifica por qué no se mide el subsistema más nuevo y más peligroso.

12. **Nada obliga a que un paquete que se pone verde entre al trinquete.** Hoy la lista de `ci.yml:94` coincide con los verdes por disciplina humana. `status.ts:229-238` sólo comprueba la dirección contraria (exigido y abierto → rojo). Un paquete puede cerrar y quedarse fuera del `--exigir` indefinidamente sin que nada lo acuse; el mismo olvido que el suelo del catálogo sí tiene cubierto.

13. **La disciplina de MUTACIÓN vive en la costumbre, no en el código.** `grep -i "mutante"` sobre src/tests/scripts: **cero coincidencias** fuera de prosa. Los «21 mutantes muertos» viven en el cuerpo del commit 1ff9ca8 y en comentarios de criterios. La evidencia de que hace falta herramienta está en el propio archivo: 163 `.test()`, **15 conteos ad-hoc** de la forma `(codigo.match(/…/g) ?? []).length`, y **3 rebanadas de cuerpo de función escritas a mano** con `indexOf('export', i+10)` (`criterios.ts:599-600, 672-673, 723`) — un delimitador que se rompe con el primer `export const` intermedio o con la palabra dentro de una cadena. Los cinco modos de fallo del enunciado están cada uno anotado en un comentario distinto, ninguno en una función reutilizable.

14. **El instrumento se exime de la regla que impone.** `fuentes()` excluye `src/plan` (`criterios.ts:71`) por una razón buena — se acusaría a sí mismo. El precio no dicho: la lista de huérfanos congelados de E0.2 no puede ver que **`apariciones()` (`criterios.ts:119`) tiene cero llamadores en todo el repositorio**, y que además lee el archivo EN CRUDO, sin `sinComentarios`, al revés que `dondeAparece`/`consumidoresDe`. Es capacidad huérfana con un defecto latente, dentro del medidor que persigue capacidad huérfana.

15. **Rendimiento y volumen de datos: cero criterios y cero fixtures.** Ni una prueba con volumen (un mayor de 10⁶ líneas, un cierre sobre un ejercicio completo), ni un `EXPLAIN`, ni una comprobación de que las particiones de `journal_entry_lines` se usan. El sistema particiona (`004_partitioning_and_views.sql`) y nada mide que la partición sirva.

16. **La latencia del agente en producción: el dato se captura y ninguna vara lo compara.** La migración 044 añade `duration_ms` y el criterio 12 de E5.1 exige que los dos runners midan (`criterios.ts:2081-2127`) — pero exige la EMISIÓN, no un umbral. No hay p95, ni trinquete de regresión, ni `ai stats` con vara de latencia. Se está registrando una serie que nadie ha prometido leer.

17. **Deuda de dependencias: hay instrumento, no hay medidor ni compuerta.** `.github/dependabot.yml` abre PR agrupados semanales; CI **no corre `npm audit`** y ningún criterio mira la antigüedad ni las advertencias de 29 dependencias + 13 de desarrollo. El tablero no sabe si el árbol está podrido.

18. **CI nunca construye el artefacto que se embarca.** Los jobs corren `typecheck` (`tsc --noEmit`, `ci.yml:43-44`) y nunca `npm run build`, que además de `tsc` copia `src/ai/docs/*.md|json` y `src/database/migrations/*.sql` a `dist/`. El criterio E5.1-1 dice «corre contra el binario que se embarca» y lo que importa es `src/cli/mnemosine.ts` (TypeScript), no `dist/`. Un fallo de emisión o una copia de activos rota pasa entera la CI.

19. **`FUERA_DEL_CATALOGO` esconde 30 de las 134 hojas vivas — el 22 % del binario.** `scripts/catalogo-estado.ts:81-88`. La ceguera está bien argumentada para `usage`/`providers`/`prompt-size`, pero dentro caen **`approvals list|grant|revoke`** (el maker-checker: la regla (b) de la casa, «el agente propone, el humano dispone»), **`jobs run-due|create|enable`** (la superficie desatendida), **`webhooks create|deliveries`** (salida a la red) y **`pending define|dismiss|reopen`** (el panel de decisiones contables, regla (a)). Eso no es plomería del agente: es la superficie de autoridad humana y de ejecución autónoma. Como no está catalogada, no cuenta para el suelo, no tiene fase, y `sinFila` no la vigila. Se puede añadir o borrar un comando de aprobaciones sin que ningún medidor lo note.

20. **El catálogo no publica su cifra más elocuente: 47 filas de fase 1 declaran motor ✅ y NO son invocables.** El bloque generado dice «379 filas de fase 1, 108 se teclean» y «191 filas con motor completo», pero no cruza las dos columnas. Esas 47 son la deuda más barata y mejor definida del producto (motor hecho, falta la puerta) y el instrumento la tiene en las manos sin imprimirla. Simétricamente: sólo 1 fila de fase 1 es invocable con motor ❌ (`init --file <f>`), lo que confirma que el juicio manual ✅/🟡/❌ es honesto.

21. **La aritmética del cierre anual no tiene criterio.** `hardClosePeriod` y `carryForwardBalances` existen (`src/services/accounting/period-close.ts:270, 378`), hay `tests/integration/period-close.int.spec.ts`, y **ninguno de los 69 criterios afirma nada sobre la corrección del arrastre de saldos ni del asiento de cierre**. El único trinquete cercano está deliberadamente ausente y dicho (`vitest.config.ts:27-30`: period-close.ts sin umbral). El hueco está confesado; lo que no existe es su dueño.

22. **Integridad referencial entre módulos: el escáner es un helper de pruebas, no un criterio.** E0.2 comprueba que `tests/integration/helpers/sql-scan.ts` sepa resolver alias (`criterios.ts:782-791`) — es decir, vigila el escáner, no el esquema. Ningún criterio cruza auxiliares contra el mayor (AR/AP/nómina/inventario contra sus cuentas de control), que es la comprobación que un cierre real necesita.

23. **Un paquete puede cerrarse con un criterio.** Distribución real: E5.1 15, E0.1 13, E2.1 7, E0.2 6, E0.0 5, E0.3 5, E4.1 3, E1.2 3, y **siete paquetes con ≤2**, entre ellos **E1.3 cerrado y exigido con UNO solo**. «El estado de un paquete es el peor de sus criterios» es una regla excelente y sólo tan fuerte como el número de criterios: 28 de los 69 (41 %) están en dos paquetes. No hay piso mínimo por paquete ni relación declarada entre criterios y tareas heredadas.

24. **Lo que un auditor externo pediría hoy y el tablero no puede entregarle** — NUEVA, agregada: (a) evidencia de una **restauración ensayada** (brecha 9); (b) **muestreo de completitud del `audit_log`** — hay criterios de que la bitácora es inmutable y de que el posteo escribe en ella, ninguno de que el % de mutaciones registradas sea 100; (c) **conciliación de auxiliares contra el mayor** (brecha 22); (d) **revisión de accesos y rotación de credenciales** — existe `fiscal_credential_access_log` y ningún criterio sobre antigüedad o revisión periódica; (e) **control de cambios**: nada liga una migración a quién la autorizó, y la cadena 001-047 no tiene ningún criterio sobre reversibilidad; (f) **segregación de funciones ejercida, no reportada** (brecha 5).

---

## RECOMENDACIONES

**R1 · (M) — El helper de criterios que ancla a FORMA DE LLAMADA y cuenta.** Fase destino: S2 (instrumento), antes de F03. Reemplaza los 163 `.test()` sueltos, los 15 conteos ad-hoc y las 3 rebanadas a mano. Forma concreta, en `src/plan/criterios.ts`:

```ts
export interface Ancla {
  simbolo: string;          // el nombre tal como se INVOCA
  con?: RegExp[];           // formas que los argumentos deben tener, en orden
  dentroDe?: string;        // sólo dentro del cuerpo de este export
  excluirDeclaracion?: true; // por omisión: SIEMPRE se excluye
}
export function tramoDe(archivo: string, exportado: string): string;   // llaves BALANCEADAS
export function llamadas(archivo: string, a: Ancla): number;           // sin comentarios, \b, forma `simbolo(`
export function importa(archivo: string, simbolo: string, desde: string): boolean;
export function exigeLlamadas(archivo: string, a: Ancla, n: number): Resultado; // === n, no >= n
```

Mata los cinco mutantes del enunciado por construcción: el **import** no casa porque `llamadas` exige `simbolo(`; la **firma vecina** no casa porque `tramoDe` cierra por llaves y no por `indexOf('export', i+10)`; el **substring** no casa por `\b`; la **firma-como-llamada** (`emitUsage(usage, durationMs?)`) no casa porque se descartan los sitios precedidos de `function`/`=>`/`:`; el **sufijo de nombre** ya lo cubre `\b`, y deja de reescribirse a mano en cada criterio. El `=== n` es la regla (c) codificada: cambiar el número exige un acto consciente en el mismo commit, en las dos direcciones. En el mismo cambio: darle un llamador a `apariciones()` o borrarla, y hacerla pasar por `sinComentarios` (brecha 14).

**R2 · (M) — Mutantes declarados y ejecutados, no narrados.** Fase destino: S2, junto a R1. Añadir a `Criterio` un campo `mutantes?: Array<{archivo, de, a, porque}>` y enrutar TODA lectura de fuente por un seam (`codigoDe`/`existe` sobre un overlay en memoria). Una prueba nueva en `tests/plan/criterios.spec.ts` aplica cada mutante, corre `evaluar()` y **exige rojo**; una segunda exige que el criterio esté verde sin mutar. Con eso los «21 mutantes muertos» dejan de vivir en el cuerpo de un commit y se vuelven regresión permanente. Regla de entrada: un criterio nuevo sin al menos un mutante no se admite.

**R3 · (S) — El trinquete se ata a los verdes.** Fase destino: inmediata. En `status.ts`, cuando se pasa `--exigir`, fallar también si un paquete `resuelto` NO está en la lista, salvo que venga nombrado en un `--reabierto=<id>:<causa>` explícito. Hoy la coincidencia es disciplina; mañana es invariante. Diez líneas.

**R4 · (S) — El catálogo publica las 47.** Fase destino: inmediata. Añadir al bloque generado de `catalogo-estado.ts` una línea: «N filas de fase 1 declaran motor completo y todavía no se teclean», y un tercer suelo `fase1ConMotorSinPuerta` que sólo pueda BAJAR. Es la cola de trabajo más barata del producto y el medidor ya tiene los dos datos.

**R5 · (S) — Sacar la autoridad humana de `FUERA_DEL_CATALOGO`.** Fase destino: inmediata. Retirar `approvals`, `pending`, `jobs` y `webhooks` de la lista de `catalogo-estado.ts:81`, darles fila con fase y riesgo, y subir el suelo en el mismo commit. `usage`, `providers`, `prompt-size`, `sessions`, `drafts`, `entities`, `ai` y `skills` sí son instrumentación y se quedan. Justificación: el maker-checker y el panel de decisiones son las reglas (a) y (b) de la casa; que su superficie sea invisible al único medidor de superficie es exactamente el desajuste que hizo que `report` entregara ocho comandos y cerrara cero filas.

**R6 · (M) — El criterio de RECUPERACIÓN, y el ensayo que lo respalda.** Fase destino: S2 / prerrequisito de cualquier F que toque datos de cliente. Un job de CI que, sobre la base de integración ya sembrada, haga `pg_dump` → base nueva → `pg_restore` → corra `mnemosine ledger check` (balance, audit-trail, continuity, que ya existen en `src/services/accounting/ledger-checks.ts:140`) y exija cero hallazgos. El criterio en E0.1: «un respaldo restaurado supera los tres chequeos del mayor». Es la única forma de que la conservación de cinco años deje de ser una promesa.

**R7 · (M) — Tres criterios que EJECUTAN contabilidad.** Fase destino: S2. Para romper el techo de la brecha 8, con `necesita: 'base-de-datos'` y un job `plan` con servicio Postgres en CI (hoy no lo tiene, y por eso el campo `necesita` es letra muerta): (a) sembrar, postear y cerrar un ejercicio, y exigir que `carryForwardBalances` deje la balanza en cero; (b) exigir que la suma de los auxiliares AR/AP iguale sus cuentas de control; (c) exigir que `account_balances` iguale Σ líneas posteadas contra datos reales, no contra el hecho de que doctor tenga el chequeo escrito. Con esto, `necesita` pasa de un caso apagado a cuatro que sí muerden.

**R8 · (S) — Cobertura del subsistema nuevo.** Fase destino: inmediata. Añadir `src/ai/**` al `include` de `vitest.config.ts` **sin umbrales** durante un sprint (medir antes de exigir), y en el siguiente fijar trinquetes por archivo donde ya esté ganado, empezando por `ingest-service.ts`, `budget.ts`, `shadow-verdicts.ts` y `draft-service.ts` — los cuatro que deciden si algo se postea solo.

**R9 · (S) — Dos jobs baratos de CI: `npm run build` y `npm audit --audit-level=high`.** Fase destino: inmediata. El primero cierra la brecha 18 (nadie construye lo que se embarca); el segundo le da compuerta a la deuda que dependabot sólo reporta.

**R10 · (M) — Vara para la latencia del agente.** Fase destino: tramo A (continuación). `ai stats` ya lee el rastro; añadir p50/p95 de `duration_ms` por comando y un criterio de trinquete contra la corrida anterior, igual que hace `eval-clasificador.ts` con la puntuación. Sin vara, `duration_ms` es una columna que se llena y nadie lee.

**R11 · (L) — Piso de criterios por paquete y trazabilidad a las 147 tareas.** Fase destino: S3. Ningún paquete se declara `resuelto` con menos de tres criterios; y un mapa tarea→criterio|absorbida-en|retirada, generado una vez y verificado por `plan:status`. Cierra las brechas 5, 6 y 23 de una vez: hoy E1.3 cierra con uno y E2.2 con dos, y la SoD se coló por esa malla exacta.

**R12 · (S) — `costo-por-fila` mide también las garantías.** Fase destino: S2. Añadir una segunda unidad además del suelo del catálogo: criterios de `plan:status` ganados. Los tramos R y A producen cero filas y muchos criterios; con las dos series al lado, el instrumento deja de castigar la garantía. Y ajustar la heurística de cola correctiva (0,7 % contra 12,3 % fundacional no es una mejora de veinte veces, es un método que no ve la cola dispersa — el propio script lo dice y hay que actuarlo).

