# Crítico de completitud — lo que las tres auditorías no miraron

_Árbol medido: `/private/tmp/claude-501/-Users-victor-projects-Accounting/d48ca5a0-ac05-4c38-a2d6-62373f8f-aud`, HEAD `36ca62e`. Corpus revisado: los 11 informes de la III, los 13 de la II y los 9 de la I (896 KB de prosa, concatenados y censados). Una corrida propia: ejecuté el CLI._

---

## 0. El método, y la advertencia que me aplico a mí mismo

Hice tres cosas. (1) Un **censo por nombre de archivo**: para cada archivo de `src/`, `scripts/`, `skills/` y `docker/`, pregunté si su nombre base aparece siquiera una vez en los 33 informes de las tres auditorías. El censo es **conservador en la dirección que me perjudica**: nombres genéricos (`index.ts`, `types.ts`, `store.ts`) salen «mencionados» por coincidencia, así que el hueco real es mayor que el que reporto. (2) Leí los once informes de la III completos. (3) Y tecleé una cosa que ninguna de las tres auditorías tecleó nunca:

```
$ npx tsx src/cli/mnemosine.ts --help
```

Arranca. Imprime 46 renglones de comando de primer nivel. Y en el renglón 40 dice:

```
  login|entrar [options]   Signs in with your identity provider (OIDC)
  logout|salir             Deletes the stored credential
  whoami|quien             Shows the active credential and its validity
```

Ese `--help` es el origen de la mitad de este informe. Costó cuarenta segundos.

---

## 1. La superficie que ninguna de las tres abrió

### El censo, en frío

| Universo | Total | Nunca nombrado en I, II ni III | Nombrado exactamente una vez |
|---|---|---|---|
| `src/**/*.ts` | 267 archivos · 68 632 líneas | **57 archivos · 8 464 líneas** | 33 archivos |
| Migraciones `.sql` | 48 | **16** | — |
| Familias de comando del CLI (`src/cli/*-command.ts`) | 27 | **7 · 2 315 líneas** | 12 con ≤2 menciones |

Traducción: **el 34 % de los archivos de `src/` recibió como máximo una mención** en tres auditorías, once lentes y casi un megabyte de prosa. Y «mención» aquí quiere decir que el nombre aparece —normalmente dentro de una lista—, no que alguien lo haya abierto.

Ahora las zonas, por orden de lo que le cuesta a un despacho.

### Zona A · La identidad de la terminal existe, está completa, y no la consume nadie (el peor hueco del censo)

`src/auth/` tiene **784 líneas** repartidas en cinco archivos: `oidc.ts` (135, descubrimiento OIDC + JWKS + verificación), `login-flows.ts` (228, PKCE S256 y device-code), `token-store.ts` (97, keychain primero, archivo 0600 como respaldo), `provisioning.ts` (162, `resolveIdentity` → usuario del inquilino con roles y `accessible_entities`) y `roles.ts` (162). `src/cli/mnemosine.ts:2034` declara `.command('login')` con alias `entrar`; `:2081` `logout`; `:2089` `whoami`. Hay tres specs (`tests/auth/`).

Y ahora la pregunta que ninguna auditoría hizo: **¿quién lee la credencial que `login` guarda?**

```
$ grep -rn "loadToken" src/
src/auth/token-store.ts:76:  export async function loadToken(...)
src/cli/mnemosine.ts:11:     import { ... loadToken ... }
src/cli/mnemosine.ts:2093:   const token = await loadToken();     ← dentro de `whoami`
```

**Un solo consumidor en todo el árbol, y es el comando que imprime la credencial.** `resolveIdentity` (`src/auth/provisioning.ts:48`) —el único lugar donde una identidad verificada se convierte en un usuario con roles— tiene **un solo importador**: `src/api/rest/middleware/auth.ts:6`. Es decir: `mnemosine login` te autentica contra tu IdP corporativo, guarda el token en el llavero del sistema, lo renueva… y ningún comando contable vuelve a preguntarle nada. `entry post`, `bill approve`, `period close` y las otras 42 lecturas de `--user` siguen resolviendo por `resolveReviewer` (`src/ai/draft-service.ts:289-301`), que sólo hace `SELECT id FROM users WHERE email = $2`.

Lo grave no es el defecto. Lo grave es **el recorrido de ese subsistema por las tres auditorías**:

- **Auditoría I** lo listó como **fortaleza**: «Credenciales del CLI: keychain primero, archivo 0600 como último recurso… OIDC con PKCE S256 + state» (`2026-08-31-integral/seguridad-multitenant.md:13`).
- **Auditoría III**, lente de control interno, lo propuso como **trabajo futuro**: «Que `--user` exija una credencial: sesión local con expiración (`mnemosine login`)» (`control-interno.md:229`, recomendación C(i)).
- **El escéptico de esa misma lente** lo declaró **inexistente**: «no hay ningún `compare` ni comando `login`». Es falso, y sostiene un veredicto SOSTIENE.

Alabado como logro, propuesto como pendiente y negado como ausente — las tres en cuatro semanas, sobre las mismas 784 líneas. Nadie preguntó por el cable. El hallazgo correcto no es «falta autenticar la terminal» (que implica construir), es **«la terminal ya sabe autenticar y decidió no preguntar»** (que implica una llamada). Presupuestos distintos, urgencias distintas, y una de las dos redacciones es vendible a un auditor externo y la otra no.

### Zona B · El alta del cliente: 2 645 líneas que nadie abrió, y es el día uno

| Archivo | Líneas | Menciones en I+II+III |
|---|---|---|
| `src/cli/init-command.ts` | 322 | **0** |
| `src/cli/init/s0-infra.ts` | 201 | **0** |
| `src/cli/init/s1-identity.ts` | 214 | **0** |
| `src/cli/init/s4-policies.ts` | 250 | **0** |
| `src/cli/init/section.ts` | 61 | **0** |
| `src/cli/first-run.ts` | 152 | **0** |
| `src/ai/onboarding-service.ts` | 240 | **0** |
| `src/cli/init/s5-import.ts` | 351 | 1 |
| `src/services/integrations/accounting/contalink-adapter.ts` | 143 | 1 |

`mnemosine onboard|alta` se describe a sí mismo en el `--help` como «Imports a client's accounting from an external system (chart of accounts + opening balances)», y `mnemosine.ts:1383` le declara riesgo. **Los saldos iniciales son la escritura más consecuente de la vida de un expediente**: todo saldo posterior es esa cifra más movimientos. Si el importador equivoca un signo, una moneda o una cuenta, el error no se descubre nunca por descuadre —el sistema cuadra— sino tres años después, cuando alguien concilie contra el estado de cuenta de apertura. Once lentes auditaron el posteo, el cierre, la balanza, el mayor inviolable y la política de cuatro ojos. Ninguna abrió la puerta por la que entran los números que todo lo demás hereda.

Igual con `s1-identity.ts` (214 líneas, cero menciones): es donde el asistente de `init` establece quién es quién. La lente de control interno concluyó que «no existe baja de usuario, ni cambio de rol auditado» y que «`init` es una puerta de escalada silenciosa» **citando únicamente `s2-users.ts`** — uno de los ocho archivos del asistente.

### Zona C · Siete familias de comando del producto CLI-first, jamás nombradas

`period-command.ts` (449) · `status-command.ts` (364) · `payment-command.ts` (335) · `init-command.ts` (322) · `entity-command.ts` (314) · `pending-command.ts` (284) · `skills-command.ts` (247).

La ironía es exacta y merece decirse sin adornos: la lente de aritmética del cierre auditó `period-close.ts` renglón por renglón, encontró el mejor hallazgo de toda la III (el estado de resultados en ceros) — **y nunca abrió `period-command.ts`, que es lo que el contador teclea para llegar ahí.** Se auditó el motor y no el volante. Cuatro de esas siete (`period`, `payment`, `pending`, `entity`) tampoco tienen spec propia en `tests/`.

### Zona D · La nómina: 4 176 líneas, y la mexicana es la mitad de la estadounidense

`src/services/payroll/` son 30 archivos. `usa/` 1 551 líneas (FICA, FIT, FUTA, formas 940/941, W-2, W-3, NACHA, embargos, impuesto local); `mx/` 709 (ISR 88 líneas, IMSS 148, INFONAVIT 86, finiquito 94, SUA 131, CFDI de nómina 162). Especificaciones: **5 para la nómina estadounidense, 2 para la mexicana**. Menciones en las tres auditorías: `isr-calculator.ts` 2, `imss-calculator.ts` 2, `sua-generator.ts` 1, `w2-generator.ts` 0, `w3-generator.ts` 0, `garnishment-engine.ts` 0, `fica-calculator.ts` 0, `ytd-service.ts` 0.

La única lente que tocó nómina (`normas-de-informacion.md`) auditó **a dónde apuntan las cuentas**, no **qué números producen**. Nadie preguntó lo obvio: un sistema que se presenta como «contable mexicano» embarca un motor de nómina de EUA con más código y más pruebas que el mexicano. Eso es una pregunta de producto y de alcance que ninguna lente tenía encargo de hacer.

### Zona E · Los datos fiscales: 200 renglones de tarifas que nadie contrastó contra el DOF

`src/database/migrations/009_tax_tables_2026.sql` trae, a mano, la tarifa de ISR y el **subsidio para el empleo 2026** (`:183-192` y siguientes), más las cuotas IMSS. Menciones del archivo en las tres auditorías: **1**.

De los 147 hallazgos de la III, **cero** son sobre un número equivocado en una tabla fiscal. No porque estén bien —nadie los revisó— sino porque verificar una tarifa exige una autoridad externa (el DOF, la LISR, el Anexo 8 de la RMF) y ninguna lente tenía una. Un agente que audita un repositorio puede probar que la tabla *existe*, que *se lee* y que el cálculo *la usa*. No puede probar que el 407.02 del primer renglón del subsidio es el 407.02 que publicó Hacienda.

### Zona F · Las tres «skills» que el agente ejecuta, contra el motor que debe ejecutarlas

`skills/` son 4 archivos, 144 líneas: `month-end-close`, `sat-reconciliation`, `diot-checklist`. `SKILL.md` aparece **2 veces** en las tres auditorías. Y `src/ai/skills/store.ts:311` dice, textualmente, que «Skills are attacker-controllable input».

Estas 144 líneas son **el procedimiento operativo del agente para los dos trabajos mensuales que le importan a un despacho**. Y no cuadran con el motor. `skills/month-end-close/SKILL.md` promete dejar el periodo «with no pending drafts, **no unreconciled bank movements**, and the recurring accruals recorded» — pero la conciliación bancaria lanza `NotImplementedError` (`bank-reconciliation.ts:303-312`, celebrado como honestidad en `calidad-de-pruebas.md`) y **no existe motor de devengo** (`normas-de-informacion.md` #9). `skills/diot-checklist/SKILL.md:3` exige conciliar el IVA acreditable «cash basis — PPD bills count when paid» contra un módulo, `iva-ppd-reclass.ts`, cuya cobertura la lente de suministro midió en la suite que no lo mide. Nadie confrontó el guion con el escenario.

### Zona G · El empaque y el arranque: cómo llega esto a una máquina que no es la de Victor

`docker/` recibió 24 menciones y **un solo hallazgo** (III, `operacion-y-fallos.md` #16: el Dockerfile corre como root y sin healthcheck). Abriendo los dos archivos con la pregunta «¿esto entrega el producto?»:

1. **`package.json` no tiene `bin`.** No hay binario `mnemosine`, no hay `npm pack` útil, no hay release. El producto CLI-first se invoca con `npx tsx src/cli/mnemosine.ts` desde un clon del repositorio.
2. **La imagen de producción no lleva `skills/`.** El `Dockerfile` copia `package.json`, `tsconfig.json` y `src` — nada más. `skill-drafts.ts:80` resuelve `<projectRoot>/skills` y `store.ts:199` busca en `cwd/skills` y `~/.mnemosine/skills`. En el contenedor, las tres skills no existen. El agente arranca sin sus procedimientos y `system-prompt.ts:96` está escrito precisamente para que eso no truene: «a broken skills dir must never break the session». Falla en silencio.
3. **`docker-compose.yml` monta `../src/database/migrations` en `/docker-entrypoint-initdb.d`.** Postgres las corre **como superusuario, alfabéticamente y sin `schema_migrations`**: `migrate.ts` creerá después que la base está sin migrar, y `scripts/provision-roles.sql` —que crea `mnemosine_app`, el rol `NOBYPASSRLS` sobre el que descansa toda la premisa multi-inquilino— **nunca corre**. El servicio `app` se conecta como `postgres` con `NODE_ENV=development`, así que `verificarRolSujetoARls` (que sólo `src/index.ts:9` invoca, y sólo bloquea en producción) lo deja pasar. **La única receta de arranque del repositorio produce un sistema sin aislamiento de inquilinos.**
4. **`ENCRYPTION_KEY=0000…` (64 ceros) y `JWT_SECRET=dev-secret-change-in-production` versionados** en el compose.
5. **Levanta un Elasticsearch con 512 MB de heap que nada consume**: `elasticsearch` aparece en `src/` exactamente una vez, en `src/config/index.ts:124`, leyendo una URL que ningún cliente usa.

Ninguno de los cinco está en los 147 hallazgos.

### Zona H · Lo demás, en una línea cada uno

`src/database/tunnel.ts` (136 líneas, **0 menciones**) y `src/database/ssl.ts` (94, **0**) — la postura TLS y de túnel de la conexión a la base, en un producto multi-inquilino, sin auditar. `src/cli/kernel/vocabulary.ts` (142, **0**) y `banner.ts` (131, **0**) — la capa bilingüe que hace que `poliza` sea `entry`, en un producto cuyo diferenciador es que el contador mexicano teclea en español. `README_ACCOUNTANT.md` (**636 líneas, 2 menciones**) — el documento que lee el cliente, que promete conciliación bancaria, control de inventarios, activos fijos y consolidación, cuatro cosas que las auditorías ya saben que no existen o no se ejecutan, sin que nadie haya cruzado la promesa con el árbol. Y 16 de las 48 migraciones jamás nombradas.

---

## 2. La afirmación central que sigue sin verificarse por conducta

**Nadie ha usado nunca este producto.**

No es retórica; es censo sobre los 33 informes:

| Cadena buscada en las tres auditorías | Apariciones |
|---|---|
| `tsx src/index` / `node dist` | **0** |
| `docker compose` | **0** |
| `ANTHROPIC_API_KEY` (o cualquier llamada real a un modelo) | **0** |
| `ai chat` / evidencia de una sesión del agente | **0** |
| `mnemosine init` (como corrida, no como cita) | **0** |

Lo que sí se ejecutó, y es mérito real: `npm test`, `vitest --coverage`, clústeres de Postgres levantados a mano con el DDL literal, mutación de código fuente, `EXPLAIN ANALYZE`, sembradores corridos contra un `pg` falso. Todo eso es conducta **de piezas**. Lo que no existe es una sola corrida **del producto**.

Consecuencia, afirmación por afirmación:

- **«CLI-first»** — verificada por lectura del árbol de comandos. Nadie ejecutó un comando. Yo ejecuté `--help` y con eso solo encontré tres comandos cuya existencia una auditoría negaba.
- **«Con agente de IA»** — cero verificación. El arnés de evaluación existe y `planes-vs-realidad.md` #8 confirma que **ninguna corrida se ha registrado jamás**. La lente del contexto del agente midió el corte de 32 000 caracteres con `head -c`, no preguntándole al agente. La afirmación «el agente ayuda a un contador» no tiene una sola línea de evidencia conductual en tres auditorías.
- **«Multi-inquilino con RLS forzada»** — parcialmente verificada, y la propia III lo confesó: `calidad-de-pruebas.md` #2 documenta que **ninguna ruta de código de aplicación se ejerce nunca bajo RLS**; la única prueba con rol `NOBYPASSRLS` cubre 3 tablas de 70 con política. Nadie ha creado dos inquilinos reales y ha intentado que uno lea al otro por la superficie del producto.
- **«Instalable»** — no verificada por nadie, y la Zona G sugiere que no lo es.

---

## 3. El sesgo compartido: qué clase de defecto es invisible a este método

Las tres auditorías son el mismo instrumento: un agente con `grep`, `read` y un encargo temático, que sondea puntualmente cuando la hipótesis se lo pide. Ese instrumento tiene un campo ciego con forma, y la forma es ésta:

**(a) El defecto de cableado.** El método pregunta «¿existe X?» y «¿falta X?». No pregunta «¿quién llama a X?». Por eso la Zona A sobrevivió tres auditorías: `grep requirePermission src/cli/` da cero y el agente escribe «no hay control»; el paso siguiente —`grep loadToken`, tres resultados, uno útil— exige sospechar de un subsistema que *sí* está. Un agente que busca ausencias no encuentra presencias desconectadas. Este defecto aparece **repetido** en el árbol: el lector de webhooks montado sin consumidor, `fixed_assets` sin escritor, `soap` y `kysely` sin importador, `3300` sembrada sin escritor, `next_retry_at` escrito sin lector, el guardián de RLS que sólo cubre el HTTP. La III encontró seis instancias del patrón y **no lo nombró como patrón**, así que no lo fue a buscar donde más duele.

**(b) El defecto de dato, no de código.** El agente verifica que la tarifa se lea; no puede verificar que la tarifa sea la del DOF, que `c_UsoCFDI` esté completo, que el código agrupador del Anexo 24 corresponda. Cero hallazgos de esta clase en 147.

**(c) El defecto que sólo aparece con el tiempo.** El propio escéptico de escala lo tropezó y lo puso como matiz: el costo de la balanza crece con la historia acumulada, no con la base. Un método que mide el árbol de hoy no ve el quinto ejercicio.

**(d) El defecto de experiencia.** Cuántos comandos hay que teclear para cerrar un mes; si el mensaje de error dice qué hacer; si un contador que se equivoca puede deshacerlo. Ninguna lente tenía asiento de usuario. Cero hallazgos.

**(e) El defecto que requiere un adversario.** El código declara que las skills son entrada controlable por un atacante (`store.ts:311`) y monta un envoltorio anti-inyección para el texto de terceros (`ingest-service.ts:459-510`, lista negra de frases con `MAX_SCAN_LENGTH = 5000` y sanitizado que **sí entrega el texto completo al modelo**). «Inyección de prompt» aparece **2 veces** en 896 KB de auditoría. Nadie fabricó un CFDI hostil. Nadie soltó una skill maliciosa en `./skills`. Nadie levantó dos inquilinos y atacó la frontera. Las tres auditorías **describen** defensas; ninguna las **prueba contra alguien que quiera romperlas**.

**(f) El sesgo de encargo.** Once lentes con once temas producen once informes que auditan **lo que hay dentro del tema**. Nadie tenía el encargo de preguntar «¿qué hace un despacho en un mes que este producto no puede hacer en absoluto?». La única lente que se acercó (normas) comparó contra una lista de NIF, no contra un calendario de obligaciones.

Y sobre el método adversarial, que es lo mejor que tienen estas auditorías, un dato duro: **los escépticos verificaron once hallazgos — uno por lente, el titular. Los otros 136 no han sido cuestionados por nadie.** El aparato de refutación cubre el 7,5 % de la producción. El 92,5 % restante entra a la síntesis con la misma autoridad y sin una sola prueba de resistencia.

---

## 4. Lo que un despacho real mediría en su primera semana, y nadie midió

1. **¿Se instala?** Sin `bin`, sin release, con un compose que anula el aislamiento y una imagen sin `skills/`. Medición: minutos hasta el primer comando útil en una máquina limpia. Nadie lo intentó.
2. **¿Puedo traerme a mi cliente?** `onboard` + `s5-import` + `contalink-adapter` = 734 líneas, cero auditadas. Medición: importar un catálogo de Contpaqi de 900 cuentas con saldos iniciales y ver si la balanza de apertura cuadra contra la del sistema viejo.
3. **¿Cuánto tardo en cerrar un mes?** Medición: reloj de pared, de 200 CFDI recibidos a estado financiero firmado, con un contador de verdad tecleando. Cero datos en tres auditorías. Lo que sí se midió (840 ms de balanza, 20,8 asientos/s) es tiempo de máquina, no de persona.
4. **¿Cuánto cuesta al mes en tokens por cliente?** Existen `ai usage` y `costo:por-fila`, pero nadie ha convertido eso en pesos por cliente por mes — que es el número del que depende la decisión de compra. Y no puede haberlo: el agente nunca se ha corrido.
5. **¿Qué pasa cuando me equivoco?** El mayor es inmutable (041), la bitácora es append-only (033), y el remedio único es la reversa manual. Medición: capturar una póliza mal, postearla, y cronometrar la recuperación. Nadie ejercitó el camino del error humano.
6. **¿Los números fiscales son los correctos?** Contrastar `009_tax_tables_2026.sql` contra el DOF, renglón por renglón. Cero.
7. **¿Puedo entregarle a la autoridad lo que me pide?** DIOT, contabilidad electrónica del Anexo 24, declaración anual. El código agrupador es hoy **una columna vacía** (`037:28`, «NULL mientras el despacho no lo asigne») y el generador de XML no existe: `codigo_agrupador` aparece en `src/` únicamente en esa migración. Está planeado como F07; nadie midió qué tan lejos está.
8. **¿Puedo irme?** No hay respaldo ni restauración (`verificacion-ii.md` #9), `pg_dump` no aparece en el árbol, y la única exportación CSV (`utils/csv.ts`) la consume una sola ruta REST — el CLI no exporta. Un despacho que no puede sacar sus datos no firma.

---

## 5. Los «114 hallazgos nuevos»: cuántos aguantan

**Primero, la cuenta.** El encargo dice 114. Yo cuento **147 encabezados de hallazgo** en los once informes, de los cuales **110 llevan la etiqueta `[NUEVA]`**, 28 `[II-SIGUE-VIVA]`, 7 `[II-EXAGERADA]` y 2 `[II-CERRADA]`. La cifra de 114 no la reproduce el corpus; puede venir de contar variantes («NUEVA, ampliada», «NUEVA, nivel plan»). Un informe que audita medidores debería empezar por saber cuántos hallazgos publicó.

**Segundo, la severidad.** 65 de 147 encabezados dicen ALTA — el 44 %. Una distribución en la que casi la mitad de todo es máxima urgencia no ordena nada: es un semáforo con una sola luz.

**Tercero, las categorías de relleno.** Nombradas, con ejemplares:

- **Errata editorial de documento de planeación** (~5 hallazgos, todos en `planes-vs-realidad.md`): «la cola son 180 filas, no 179, la suma da 378 ≠ 379» (#3), «189 en la tabla, 190 en la recomendación» (#9), «el sello va cuatro commits atrás» (#6), «cinco colisiones de numeración de migración toleradas» (#10). Costo para un despacho: **cero**. El escéptico ya calificó esa lente de EXAGERADA; sus 13 hallazgos deberían entrar redimensionados en bloque, no uno por uno.
- **Hallazgo condicional sobre código sin llamador** (~10): el enum UEPS —etiquetado por el propio informe «BAJA hoy, ALTA cuando S0.4 escriba el motor»—, la depreciación sin pruebas, `fixed_assets` sin escritor, `queryUnclosedEarnings` filtrando por un tipo que el esquema prohíbe (rama inalcanzable), `soap`/`kysely`/cinco dependencias sin importador, el lector de webhooks sin cablear. Son higiene legítima; **no son defectos que puedan lastimar hoy**, y varios entran con severidad ALTA.
- **Ausencia en un plan** (~3): «el plan de cierre de 147 partidas no contiene una sola de reconocimiento NIF» (normas #16), «los 16 cabos sin fase no tienen dueño» (planes #4). Es observación de gestión, no defecto de sistema.
- **Higiene de suministro con daño no demostrado** (~7): `.gitignore` sin `.cer`, CodeQL ausente, agrupación de dependabot, `graphql:codegen` invocando un binario inexistente, la suite unitaria corriendo dos veces, tres índices redundantes, un `float` en un resumen. Cada uno es un renglón de configuración.
- **Duplicado entre lentes** (~12 pares y tríos): `ledger check --check balance` ciego a `ending_balance` aparece **tres veces** (calidad #10, aritmética #13, verificación #4); el salto del maker-checker por `autoPost` **tres veces** (superficies #1, control-interno #2, verificación #6); la ausencia de `statement_timeout` dos; `bulk` sin tope dos; los reintentos de webhook cosméticos dos; el flujo de efectivo dos; el trinquete de cobertura tres. Un lector que cuente hallazgos cree tener más problemas de los que tiene.
- **Re-verificación por diseño** (37): todo lo etiquetado `[II-*]`, y `verificacion-ii.md` entera. Es trabajo valioso —confirmar que nada se cerró lo es— pero **no son hallazgos nuevos** y no deberían sumar a un total que se presenta como descubrimiento.

**Cuarto, cuántos son de verdad accionables.** Mi criterio: que tenga (i) evidencia de conducta —mutación que sobrevive, SQL ejecutado contra Postgres, medición en clúster— y (ii) un camino de ejecución vivo hoy. Con ese filtro sobreviven aproximadamente **35 a 40 de los 110**: el signo de la balanza que sobrevive a la mutación, las 19 tablas hijas fuera de toda prueba de RLS, el estado de resultados en ceros tras el cierre, el `.abs()` del asiento de cierre, el choque de los dos sembradores de catálogo, el salto del SoD por `autoPost`, `--user` sin credencial, la divergencia de GraphQL contra el CLI, `/metrics` devolviendo etiquetas de un anónimo a otro, el timbrado al primer intento sin marcha seca, la quema de la clave de idempotencia del webhook, el costo por línea de la política hija, el pool sin tope, y las migraciones sin contexto de inquilino (con la 040 registrada como aplicada habiendo podido afectar cero filas).

Los otros **70 y pico** son observaciones correctas de lectura. No están mal; están **sin pesar**. Y el escéptico sólo pesó once.

**Un dato de método que lo explica:** el texto de cinco de las once lentes —control interno (17 hallazgos), normas de información (16), operación y fallos (16), aritmética del cierre (14) y suministro (12)— **no registra una sola corrida propia**. Setenta y cinco hallazgos, el 51 % del total, nacieron de leer. La conducta llegó después, del escéptico, y sólo para el titular de cada una.

---

## 6. Las tres lentes que debería tener la auditoría IV

Ninguna de las tres se parece a las treinta y tres que ya existen, y ninguna se puede hacer con `grep`.

### Lente IV-1 · **La corrida del despacho** — el producto usado, de la instalación al estado financiero

**Pregunta:** ¿puede un contador, en una máquina limpia, dar de alta un despacho, migrar un cliente, capturar un mes y firmar un estado financiero — y cuánto le cuesta en tiempo, en tokens y en errores?

**Método:** una sola sesión continua, con transcripción íntegra publicada como evidencia. Máquina limpia, `git clone`, seguir **exactamente** lo que dice `README.md`; si falla, ése es el primer hallazgo y se anota el minuto. Después: `docker compose up` y verificar bajo qué rol quedó la base y si `provision-roles.sql` corrió. Luego `mnemosine init` completo (las seis secciones), `onboard` con un catálogo real de 300+ cuentas y saldos iniciales, 50 CFDI recibidos por `ingest` con una llave de modelo de verdad, un pago, una factura emitida, `period close`, y los estados. Cronómetro en cada paso. Cuenta de tokens y de pesos al final. Cada error de operador que ocurra de verdad —no imaginado— se registra con su camino de recuperación.

**Criterio de refutación:** si la corrida llega al estado financiero sin intervención de quien conoce el código, la lente falla y hay que decirlo.

**Por qué ninguna la tuvo:** las once lentes de la III tenían tema; ninguna tenía **tarea**. Y esta lente es la única que puede pronunciarse sobre la afirmación central del producto, que hoy no tiene una sola línea de evidencia conductual.

### Lente IV-2 · **El adversario** — atacar en vez de describir

**Pregunta:** las defensas que el código declara (envoltorio de terceros, sanitizador de inyección, RLS forzada, skills como entrada hostil, bitácora append-only), ¿resisten a alguien que quiera romperlas?

**Método:** cuatro ataques ejecutados, no razonados. **(1) Inyección por CFDI**: fabricar comprobantes con carga útil en `Concepto/Descripcion` —después del carácter 5 000 para pasar bajo `MAX_SCAN_LENGTH`, con frases fuera de la lista negra, con unicode invisible, con delimitadores anidados— pasarlos por `ingest` con un modelo real, y ver si el agente ejecuta una instrucción del proveedor. **(2) Skill hostil**: soltar un directorio en `./skills` y en `~/.mnemosine/skills` y medir qué llega al prompt. **(3) Frontera real**: dos inquilinos, dos identidades, `mnemosine_app` de verdad, e intentar leer por las 70 tablas con política —y por las 19 hijas que ninguna prueba mira— desde el producto, no desde `psql`. **(4) Falsificación de bitácora**: la cadena `--user` de punta a punta, y después intentar que `ledger check --check audit-trail` la delate.

**Criterio de refutación:** si los cuatro rebotan, se publica que rebotaron — y entonces las defensas dejan de estar verificadas por prosa.

**Por qué ninguna la tuvo:** «inyección de prompt» aparece dos veces en 896 KB. Las tres auditorías **leyeron el escudo**; ninguna tiró la flecha.

### Lente IV-3 · **Lo que no es código** — datos fiscales, catálogos y los procedimientos del agente contra el motor que debe cumplirlos

**Pregunta:** los números y los guiones que el sistema trata como verdad, ¿son verdad?

**Método:** tres frentes. **(a) Tarifas y catálogos**: contrastar `009_tax_tables_2026.sql` (ISR, subsidio para el empleo, cuotas IMSS) renglón por renglón contra el DOF y la RMF vigentes, y `sat-catalogs.ts` contra los catálogos publicados del CFDI 4.0; cualquier discrepancia es un error que ninguna prueba puede encontrar porque todas las pruebas usan la misma tabla. **(b) Los tres SKILL.md contra el motor**: cada paso del guion, ¿tiene comando, herramienta y dato que lo cumpla? El del cierre pide conciliación bancaria (retirada) y devengos recurrentes (inexistentes); el de DIOT pide IVA en flujo (módulo con 6,93 % de cobertura). El entregable es una tabla paso-por-paso: cumplible / no cumplible / cumplible sólo a mano. **(c) `README_ACCOUNTANT.md` contra el árbol**: sus 18 capítulos son las promesas que el cliente lee — conciliación, inventarios, activos fijos, consolidación, triple partida con anclaje en Bitcoin — cruzados contra lo que las tres auditorías ya probaron que no existe o no se ejecuta.

**Criterio de refutación:** si las tarifas cuadran, si los tres guiones son ejecutables y si el README no promete de más, la lente entrega una página en blanco y eso vale.

**Por qué ninguna la tuvo:** las once lentes auditaron **código**. El daño de un dato falso o de un guion imposible es idéntico al de un `if` invertido, y no deja huella en ningún linter, en ninguna mutación y en ningún `plan:status`.

---

## 7. Correcciones de hecho que la III debe absorber antes de publicarse

1. **`control-interno.md` — veredicto del escéptico.** «No hay ningún `compare` ni comando `login`» es **falso**: `src/cli/mnemosine.ts:2034` (`login|entrar`), `:2081` (`logout|salir`), `:2089` (`whoami|quien`), sobre `src/auth/login-flows.ts` (PKCE S256 y device-code) y `src/auth/token-store.ts` (llavero del sistema). El hallazgo **sobrevive y empeora**: `loadToken` tiene un solo consumidor en el árbol (`mnemosine.ts:2093`, dentro de `whoami`) y `resolveIdentity` un solo importador (`src/api/rest/middleware/auth.ts:6`). Enunciado correcto: *«la terminal sabe autenticar —OIDC completo, con llavero y renovación— y ningún comando contable se lo pregunta: `--user` sigue siendo una declaración libre porque nadie leyó la credencial que `login` ya guardó.»*
2. **`control-interno.md:229`, recomendación C(i).** Propone «sesión local con expiración (`mnemosine login`)» como camino a construir. Ya está construido. La recomendación correcta es de una línea: que `resolveReviewer` reciba la identidad de `loadToken()` y que `--user` sólo pueda **restringir**, nunca **sustituir**, al sujeto autenticado. Cambia el tramo destino y cambia el presupuesto.
3. **El total.** 110 hallazgos con etiqueta `[NUEVA]`, no 114; 147 encabezados en total. Y la síntesis debe decir en voz alta que **once fueron verificados por un escéptico y ciento treinta y seis no**.
