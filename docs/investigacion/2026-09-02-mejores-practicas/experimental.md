# Lente 6 — EXPERIMENTAL: la contabilidad como centro y la arquitectura pública/privada de cuentas

> Informe de investigación (2026-09-02). Estado del repo leído del árbol de referencia
> `/private/tmp/claude-501/-Users-victor-projects-Accounting/d48ca5a0-ac05-4c38-a2d6-62373f8f-inv`
> (espejo de solo lectura del repo); las rutas citadas son relativas a la raíz del repo.
> Toda liga de la tabla fue verificada con WebFetch en esta corrida; lo que no se pudo verificar
> está en la sección final y así se dice. Ninguna página visitada contenía instrucciones dirigidas
> al agente.

## Dónde estamos

**La jerarquía existe y es real.** `accounts` tiene `parent_id` y `account_level` con disparador
que calcula nivel y `full_code` al insertar (`src/database/migrations/001_core_schema.sql:106-107`
y `:158-172`). Encima vive la capa semántica de ROLES: `account_roles` ancla roles abstractos de
la taxonomía CFDI («iva_pendiente_acreditar») a cuentas concretas por entidad, con `qualifier`
para variantes (`src/database/migrations/015_account_roles.sql:9-25`).

**`fs_category` existe pero cojea.** El CHECK enumera categorías de estado financiero en clave
anglosajona (`current_assets`, `cogs`, `operating_expenses`...) — no NIF — y la columna es
NULLable sin regla de coherencia padre-hijo (`001_core_schema.sql:115-125`). Nada impide que una
subcuenta declare una `fs_category` distinta a la de su padre: una agregación por `fs_category`
puede desamarrar de la agregación por `parent_id`, que es exactamente el descuadre que la lente
quiere hacer imposible.

**Las dimensiones son hoy capacidad huérfana.** `journal_entry_lines` trae cuatro columnas de
dimensión — `cost_center_id`, `department_id`, `project_id`, `class_id` — como UUID sueltos, sin
FK, sin tabla catálogo, sin escritor ni lector en el código (`001_core_schema.sql:270-273`).
Es la clase exacta que el doctor señala como huérfana: la columna promete contabilidad
dimensional y nadie la sirve.

**El mayor es físicamente inmutable, con lista blanca que ya contempla la atestación.** El
disparador de la 041 rechaza UPDATE/DELETE de posteados salvo metadatos enumerados, y tres de
ellos son precisamente `entry_hash`, `blockchain_attestation_id` y `commitment`
(`src/database/migrations/041_el_mayor_inviolable.sql:36-66`). El orquestador escribe el hash y
el compromiso DESPUÉS de postear (`src/services/blockchain/orchestrator.ts:108-121`). Es decir:
la materia prima criptográfica de una balanza atestada ya se produce por asiento.

**La verificación pública existe, apagada, y se niega a mentir.** El router `/public/v1` solo se
monta con `PUBLIC_VERIFICATION_ENABLED=true` (`src/index.ts:162-171`); encendido, cada endpoint
responde 501 `ATTESTATION_SIMULATED` ante filas simuladas — «una prueba fabricada es peor que
ninguna» (`src/api/rest/routes/public-verification.ts:30-64`). Las consultas públicas corren bajo
`mnemosine_verifier` con `SET LOCAL ROLE`: SELECT enumerado y políticas de predicado público,
nunca un rol que ignore RLS (`src/database/consulta-publica.ts:15-33`).

**La balanza ya es vista derivada.** `mv_trial_balance` agrega solo posteados
(`src/database/migrations/010_fix_mv_trial_balance.sql:17-50`) y su refresco sale del posteo (042).

**El freno de la casa.** El anclaje Bitcoin es simulado y está en decisión de retiro; el plan
prohíbe construir sobre él antes del sello de disparadores. Y la compuerta G1 — cargar el
histórico de un cliente real con balanza que cuadre al peso — sigue abierta
(`docs/completion-plan.md:62`). Transparencia sobre números equivocados es publicidad del error.

## La investigación

### (a) Ledger como centro

**Modern Treasury (Ledgers API).** Base de datos administrada para transacciones y saldos, de
partida doble («the gold standard for businesses with complex or high-velocity payment flows»).
Sus garantías documentadas son la trinidad que mnemosine ya implementa por otros medios: por
divisa los cargos igualan a los abonos; una transacción posteada es financieramente inmutable
(solo metadatos editables — el gemelo exacto de la lista blanca de la 041); atomicidad de
escritura (todas las entradas o ninguna); historial de versiones auditable y archivado en lugar
de borrado. Ligas: [Ledgers Overview](https://docs.moderntreasury.com/ledgers/docs/ledgers-overview),
[Ledgers Guarantees](https://docs.moderntreasury.com/docs/ledgers-guarantees).

**TigerBeetle.** Base de datos de transacciones financieras («designed for mission critical
safety and performance»), con cargo/abono como primitiva nativa: cada transferencia lleva
`debit_account_id`/`credit_account_id`, y las transferencias registradas «cannot be erased» —
la corrección es una transferencia nueva, jamás edición (append-only). Es la 041 elevada a motor
de almacenamiento. Ligas: [docs.tigerbeetle.com](https://docs.tigerbeetle.com/),
[Debit-Credit](https://docs.tigerbeetle.com/concepts/debit-credit/).

**Formance Ledger.** «Programmable financial core ledger» de código abierto sobre Postgres, con
transacciones multi-posting atómicas y Numscript (DSL) para modelar movimientos; réplica de la
bitácora del ledger a otros almacenes para consulta analítica. Su documentación (docs.formance.com)
no fue verificable en esta corrida — el sitio rinde por JavaScript y WebFetch solo obtiene títulos —
así que la única liga que afirmo es el repositorio:
[github.com/formancehq/ledger](https://github.com/formancehq/ledger). Dato relevante no verificado
en fuente oficial (va a ligas muertas): sus docs describen un modelo fuente/destino con cuentas de
dirección jerárquica por segmentos.

**Libro delgado + subledgers (thin GL).** El patrón: el mayor guarda el mínimo — catálogo corto,
cuentas resumen — y el detalle vive en subledgers ricos en datos, con drill-back del saldo agregado
a la transacción original. La referencia oficial verificada es Microsoft Dynamics 365 Finance:
los subledgers (CxP, CxC, inventario, impuestos) capturan el detalle del documento; el asiento
de subledger, balanceado por partida doble, «is then transferred to the ledger, either in detail
or summary, depending on the setup», con el voucher como referencia compartida para el drill-back.
Liga: [Ledger, subledger, and subledger journal entries](https://learn.microsoft.com/en-us/dynamics365/finance/general-ledger/ledger-subledger).
El documento de Oracle «Thick Versus Thin General Ledger» existió pero hoy redirige a una página
genérica (ligas muertas). **Lectura para mnemosine:** la frontera pública/privada de la lente ES
un thin GL: los niveles altos son el libro delgado que un tercero ve; el detalle del despacho es
el subledger.

**Dimensiones vs explosión de cuentas.** Dynamics lo dice de frente: la cuenta de mayor es
`main account + financial dimension values`, y las estructuras de cuenta definen qué combinaciones
son válidas — la dimensión es un eje ortogonal, no una subcuenta más. NetSuite: tres segmentos
nativos (Department, Class, Location; Subsidiary en OneWorld) y **custom segments** ilimitados,
clasificaciones con impacto visible en GL y usables como dimensiones horizontales en reportes
financieros ([Custom Segments Overview](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4732448748.html)).
Xero resuelve lo mismo con «tracking categories» (dos categorías activas, ~100 opciones) explícitamente
para NO engordar el catálogo — pero su página oficial no fue verificable en esta corrida (ligas
muertas), así que ese dato queda como no verificado. **Lectura:** la subcuenta responde «¿de quién
es este saldo ante terceros?» (estructura, estable, pública en sus niveles altos); la dimensión
responde «¿cómo lo rebano para adentro?» (analítica, volátil, privada siempre).

### (b) REA y event sourcing contable

**REA (McCarthy, 1982).** «The REA Accounting Model: A Generalized Framework for Accounting
Systems in a Shared Data Environment», The Accounting Review, jul-1982, pp. 554-578. El modelo
registra Recursos, Eventos y Agentes de la realidad económica; cargos y abonos desaparecen como
objetos persistidos — «double-entry bookkeeping disappears in an REA system» — y las cuentas
(CxC, CxP) se DERIVAN en tiempo real de los documentos fuente. Influyó en ISO 15944-4 y ebXML.
El PDF original en msu.edu está muerto (el AFS de MSU se retiró); la síntesis verificada:
[Wikipedia — Resources, Events, Agents](https://en.wikipedia.org/wiki/Resources,_Events,_Agents).

**Event sourcing (Fowler).** «Capture all changes to an application state as a sequence of
events»: el estado se reconstruye reproduciendo la bitácora, admite consultas temporales y
reversa de eventos con recálculo de consecuencias; Fowler señala que los asientos contables SON
event sourcing avant la lettre. Liga: [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html).
**Lectura:** mnemosine ya vive esta tesis a medias — el CFDI/estado de cuenta es el evento, la
clasificación (`cfdi_classifications`, con `facts` y `decisions`) es la interpretación auditada,
y el asiento es la proyección. La lente no pide adoptar REA; pide reconocer que el asiento
público de nivel alto es una proyección MÁS del mismo evento, igual de derivada que la privada.

### (c) Triple-entry accounting (Grigg) y lo que sobrevive sin blockchain

El paper ([iang.org/papers/triple_entry.html](https://iang.org/papers/triple_entry.html)) no
menciona blockchain: son Alice, Bob e Ivan (el emisor) y un **recibo firmado** que contiene la
instrucción del usuario y la confirmación del emisor, ambas selladas con firma digital; «the
receipt is the transaction», y las tres partes conservan el mismo registro. Lo que sobrevive de
la idea es exactamente eso: **evidencia compartida y firmada entre partes, con solo paso de
mensajes confiable** — sin cadena, sin minado, sin gas. Para mnemosine esto reencuadra el retiro
del anclaje simulado: lo que el inversionista necesita no es un bloque de Bitcoin, es un recibo
que el despacho no pueda reescribir y que él pueda re-verificar. El `entry_hash` por asiento
(041 + orquestador) más una firma del servidor sobre la balanza agregada ES un recibo de Grigg;
la fila simulada de «anclaje» no aporta nada que ese recibo no dé.

### (d) Transparencia a inversionistas

**XBRL/iXBRL.** iXBRL incrusta etiquetas XBRL en HTML: «a single document to provide both
human-readable and structured, machine-readable data»; lo exigen SEC, ESMA (ESEF desde 2021) y
lo usan más de dos millones de sociedades ante HMRC/Companies House
([xbrl.org — iXBRL](https://www.xbrl.org/the-standard/what/ixbrl/)). La spec:
[Inline XBRL 1.1, REC 2013-11-18](https://www.xbrl.org/Specification/inlineXBRL-part1/REC-2013-11-18/inlineXBRL-part1-REC-2013-11-18.html);
el índice de especificaciones base (XBRL 2.1):
[specifications.xbrl.org](https://specifications.xbrl.org/spec-group-index-group-base-spec.html).

**Divulgación selectiva.** El marco de referencia es Regulation FD (17 CFR 243.100): cuando un
emisor revela información material no pública a ciertos actores, debe hacerla pública —
simultáneamente si fue intencional, prontamente si no
([LII — 17 CFR 243.100](https://www.law.cornell.edu/cfr/text/17/243.100)). Aplica a emisores
públicos de EU, no a la PyME mexicana de mnemosine, pero fija el principio de diseño: si el
mecanismo permite enseñar números a UN inversionista, debe dejar rastro de a quién, qué versión
y cuándo — la divulgación selectiva sin bitácora es el pecado, no la selectividad.

**Data rooms.** La práctica estándar (guía de Intralinks, verificada): permisos granulares «up to
eight levels deep» revocables al instante, marcas de agua dinámicas, restricciones por IP, y «an
immutable audit trail, capturing every upload, view or permission change», con Q&A estructurado
([Intralinks — Leveraging VDRs](https://www.intralinks.com/guides/leveraging-virtual-data-rooms)).
**Lectura:** el paquete a inversionistas de mnemosine no es una página pública: es un data room
de un solo documento — la balanza atestada — con acceso nominal, marca de agua y bitácora.

### (e) Continuous accounting / continuous close

BlackLine (eBook oficial): tareas de cierre «spread across the entire month, instead of relegated
to the end of the month», conciliación y verificación continuas, automatización de lo repetitivo
([BlackLine — Continuous Accounting](https://www.blackline.com/ebooks/continuous-accounting/)).
**Lectura:** mnemosine ya está estructuralmente ahí — el refresco de la balanza sale del posteo
(042), la conciliación bancaria es sesión con invariantes (F05), el periodo se cierra con sello.
La vista pública derivada convierte eso en el argumento comercial de la lente: el inversionista
no ve un PDF trimestral, ve una balanza de niveles altos siempre al día y siempre cuadrada.

## Tabla comparativa

| Sistema / idea | Qué es | Inmutabilidad | Jerarquía / dimensiones | Qué le toma mnemosine | Liga (verificada) |
|---|---|---|---|---|---|
| Modern Treasury Ledgers | Ledger API administrado, partida doble | Posteado inmutable salvo metadatos; versiones; archivo, no borrado | Ledger accounts + metadatos | Las «guarantees» como espejo de la 041; versionado explícito | [Overview](https://docs.moderntreasury.com/ledgers/docs/ledgers-overview) · [Guarantees](https://docs.moderntreasury.com/docs/ledgers-guarantees) |
| TigerBeetle | BD de transacciones financieras, cargo/abono nativo | Append-only; corrección por transferencia nueva | Cuentas planas + `ledger`/`code`/`user_data` | Confirmación de que «corregir = asiento nuevo» es patrón de industria | [Docs](https://docs.tigerbeetle.com/) · [Debit-Credit](https://docs.tigerbeetle.com/concepts/debit-credit/) |
| Formance Ledger | Core ledger programable OSS sobre Postgres, Numscript | Bitácora replicable; (tamper-evidence en docs, no verificado) | Direcciones de cuenta por segmentos (no verificado en doc oficial) | El ledger como servicio con DSL de posteo; nada urgente que copiar | [GitHub](https://github.com/formancehq/ledger) |
| Thin GL + subledger (Dynamics 365) | Mayor delgado, detalle en subledgers, transferencia «in detail or summary», voucher para drill-back | Por asiento | Cuenta = main account + dimensiones financieras validadas por estructura | El molde exacto de la frontera pública/privada | [Ledger-subledger](https://learn.microsoft.com/en-us/dynamics365/finance/general-ledger/ledger-subledger) |
| NetSuite segments | Department/Class/Location + custom segments ilimitados con impacto GL | n/a | Dimensiones como eje, no como subcuentas | El destino correcto de las 4 columnas huérfanas de `journal_entry_lines` | [Custom Segments](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4732448748.html) |
| REA (McCarthy 1982) | Recursos-Eventos-Agentes; cuentas y cargos/abonos como DERIVADOS | El evento es el hecho | Sin cuentas persistidas | Legitima «la agregación es vista, jamás tabla» | [Wikipedia REA](https://en.wikipedia.org/wiki/Resources,_Events,_Agents) |
| Event sourcing (Fowler) | Estado como proyección de bitácora de eventos | Bitácora append-only | n/a | El asiento público de nivel alto = segunda proyección del mismo evento | [EventSourcing](https://martinfowler.com/eaaDev/EventSourcing.html) |
| Triple-entry (Grigg) | Recibo firmado compartido entre Alice, Bob e Ivan; «the receipt is the transaction» | La firma congela la evidencia | n/a | El recibo firmado de la balanza sustituye al anclaje simulado; cero blockchain | [triple_entry.html](https://iang.org/papers/triple_entry.html) |
| iXBRL | Un documento legible por humano y máquina a la vez | n/a | Taxonomías | Formato del paquete X3 | [iXBRL](https://www.xbrl.org/the-standard/what/ixbrl/) · [Spec 1.1](https://www.xbrl.org/Specification/inlineXBRL-part1/REC-2013-11-18/inlineXBRL-part1-REC-2013-11-18.html) · [Base specs](https://specifications.xbrl.org/spec-group-index-group-base-spec.html) |
| Reg FD | Divulgación selectiva ⇒ divulgación pública simultánea/pronta | n/a | n/a | Principio: selectividad con bitácora, nunca sin ella | [17 CFR 243.100](https://www.law.cornell.edu/cfr/text/17/243.100) |
| Data rooms (Intralinks) | Permisos granulares, marcas de agua, bitácora inmutable, Q&A | Bitácora de acceso | n/a | La forma del acceso del inversionista en X3 | [Guía VDR](https://www.intralinks.com/guides/leveraging-virtual-data-rooms) |
| Continuous accounting (BlackLine) | Cierre repartido en el mes, conciliación continua | n/a | n/a | El relato: la balanza pública siempre al día porque el cierre es continuo | [eBook](https://www.blackline.com/ebooks/continuous-accounting/) |

## El mecanismo (EXPERIMENTAL de punta a punta)

Todo lo que sigue está marcado EXPERIMENTAL y condicionado: **nada se construye antes de G1**
(`docs/completion-plan.md:62`) — una balanza pública derivada de estados que hoy mienten es
publicidad del error. X1 es papel y puede empezar cuando sea; X2 y X3 esperan la compuerta.

**Tesis.** La frontera pública/privada NO es una tabla nueva ni una copia: es un corte sobre la
jerarquía que ya existe. Cuentas PÚBLICAS = los niveles altos del catálogo (`account_level` bajo,
`is_header` en la práctica), que forman la balanza que un inversionista puede ver. Subcuentas
PRIVADAS = el detalle del despacho, bajo RLS exactamente como hoy. La agregación pública es una
VISTA derivada por recursión sobre `parent_id` desde `mv_trial_balance` — al ser vista y no tabla,
es imposible de descuadrar respecto al detalle POR CONSTRUCCIÓN (patrón REA: el agregado se
deriva, jamás se persiste). La atestación reutiliza los `entry_hash` que la 041 ya protege y el
orquestador ya escribe; lo que se publica del anclaje simulado: nada, igual que hoy.

**Lo que le falta al esquema (censo, no obra):**

1. **Dimensiones vs subcuentas — la bifurcación va al panel.** Las cuatro columnas de dimensión
   de `journal_entry_lines` (`001_core_schema.sql:270-273`) son huérfanas. La regla de industria
   (Dynamics/NetSuite): subcuenta para estructura estable, dimensión para el rebanado analítico.
   Si el despacho hoy explota subcuentas por cliente/proyecto, cada alta engorda el catálogo y
   acerca detalle privado a los niveles públicos. La decisión «¿el detalle por
   cliente/proyecto/centro va en subcuenta o en dimensión?» es criterio del despacho: entra al
   panel de políticas con su lector (como manda la casa), con omisión = subcuenta (lo que hoy
   funciona), y las columnas huérfanas o ganan catálogo y escritor, o se retiran — pero por
   decisión registrada, no por deriva.
2. **El CHECK de `fs_category`.** (i) Enumera categorías anglosajonas; falta el mapeo NIF (la
   balanza pública mexicana habla NIF B-6, no `cogs`). (ii) Es NULLable sin obligación para
   cuentas posteables. (iii) No hay coherencia padre-hijo: una subcuenta puede contradecir la
   `fs_category` de su padre y desamarrar la agregación por categoría de la agregación por
   jerarquía. Falta un disparador (la lección 041: el disparador aguanta, el GRANT no) que
   obligue `fs_category` del hijo = la del padre cuando el padre la tiene, más un check del
   doctor para el censo del catálogo existente.
3. **El marcador de corte público.** Nada declara hoy hasta qué nivel es público. No se
   inventa columna a la ligera: el corte por entidad (nivel N, u opt-in por cuenta) es criterio
   del despacho ⇒ política en el panel, leída por la vista. Omisión: **nada es público** (la
   política más conservadora; la vista existe vacía hasta que el humano dispone).

**X1 — Diseño sobre papel con criterio de refutación (S).** Documento en `docs/investigacion/`
que fija: el corte público como política, el rollup recursivo, el mapeo `fs_category`→NIF, y el
**recibo firmado** de Grigg como sustituto del anclaje: hash de la balanza pública del periodo,
encadenado a los `entry_hash` de los asientos que la componen, firmado con una llave de servidor
cuyo perfil solo NOMBRA la fuente (`api_key_env`/`api_key_cmd`) — jamás la e.firma ni el CSD, que
no salen de la bóveda; entregado al inversionista como archivo re-verificable. Criterio de
refutación (se escribe como prueba de propiedad antes que el código): «existe una secuencia de
asientos posteados y reversas tal que la balanza pública atestada difiere al peso del rollup del
detalle, o tal que dos lectores (por jerarquía y por fs_category) difieren entre sí» — si la
prueba encuentra el contraejemplo, el diseño se refuta y no se construye X2.

**X2 — La vista pública derivada, detrás de PUBLIC_VERIFICATION_ENABLED (M).** Vista (no MV
propia: deriva de `mv_trial_balance`, cuyo refresco ya sale del posteo) que rollupea por
`parent_id` hasta el corte que dicte la política, por entidad y periodo. Se sirve en
`/public/v1/balance/:entidad/:periodo` vía `consultaPublica` (`SET LOCAL ROLE
mnemosine_verifier`, `src/database/consulta-publica.ts:15-33`): el GRANT enumerado de la vista y
su política de predicado público van en migración, nunca un rol que ignore RLS. Hereda las dos
negativas del router: sin bandera no existe; con bandera, se niega a servir agregados cuyos
asientos tengan solo atestación simulada (misma clase que `rechazarSimulada`,
`public-verification.ts:47-64`). El agente puede PROPONER el corte y el mapeo; publicar dispone
el humano — y ninguna herramienta del agente alcanza el mayor ni la vista. Contra capacidad
huérfana: la obra trae su fila de catálogo (`balance publico consultar`, o el nombre que el
catálogo dicte) y su criterio en `docs/criterios-minimos.json`, más el criterio del panel para
el corte.

**X3 — Divulgación a inversionistas (L).** No página pública: paquete por inversionista al estilo
data room — balanza pública del periodo en iXBRL (un solo documento legible por humano y máquina,
spec 1.1) + PDF, ambos con el recibo firmado adjunto, entregados bajo acceso nominal con marca de
agua y **bitácora inmutable de quién vio qué versión y cuándo** (práctica VDR; principio Reg FD:
selectividad con rastro). La taxonomía iXBRL mexicana aplicable (CNBV/BMV usan XBRL para
emisoras; la PyME no tiene mandato) queda como pregunta abierta de X3 — no se verificó liga
oficial de taxonomía CNBV en esta corrida y así se dice. Requiere además decidir en el panel qué
periodos y qué notas acompañan la balanza.

## Qué entra al plan maestro

**Tramo propuesto: «X — La balanza que un tercero puede creer» (EXPERIMENTAL, bloqueado por G1
y por el retiro del anclaje simulado).**

1. **X1 (S)** — diseño en papel + criterio de refutación como prueba de propiedad; incluye el
   censo de `fs_category` y la decisión de panel dimensiones-vs-subcuentas. Puede empezar hoy;
   no toca esquema.
2. **X2 (M)** — migración (coherencia padre-hijo de `fs_category`, GRANT a `mnemosine_verifier`,
   vista rollup), endpoint en `/public/v1`, política de corte en el panel con su lector, fila de
   catálogo + criterio, pruebas de integración (incluida la de ataque: intentar descuadrar
   vista vs detalle). Bloqueado por G1.
3. **X3 (L)** — recibo firmado de periodo, paquete iXBRL/PDF, acceso tipo data room con bitácora.
   Bloqueado por X2 y por la decisión de retiro del anclaje (el recibo firmado es su reemplazo
   natural: da al inversionista lo que el anclaje simulado fingía dar, sin fabricar nada).

**Decisión que el tramo obliga a tomar (y propone):** retirar el anclaje simulado a favor del
recibo firmado estilo Grigg — la evidencia compartida y firmada sobrevive; la fila fabricada no.

## Ligas verificadas y muertas

**Verificadas con WebFetch en esta corrida (16):**
- https://docs.moderntreasury.com/ledgers/docs/ledgers-overview
- https://docs.moderntreasury.com/docs/ledgers-guarantees
- https://docs.tigerbeetle.com/
- https://docs.tigerbeetle.com/concepts/debit-credit/
- https://github.com/formancehq/ledger
- https://learn.microsoft.com/en-us/dynamics365/finance/general-ledger/ledger-subledger
- https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4732448748.html
- https://en.wikipedia.org/wiki/Resources,_Events,_Agents
- https://martinfowler.com/eaaDev/EventSourcing.html
- https://iang.org/papers/triple_entry.html
- https://www.xbrl.org/the-standard/what/ixbrl/
- https://www.xbrl.org/Specification/inlineXBRL-part1/REC-2013-11-18/inlineXBRL-part1-REC-2013-11-18.html
- https://specifications.xbrl.org/spec-group-index-group-base-spec.html
- https://www.law.cornell.edu/cfr/text/17/243.100
- https://www.intralinks.com/guides/leveraging-virtual-data-rooms
- https://www.blackline.com/ebooks/continuous-accounting/

**Muertas o no verificadas (5) — no se usan como soporte de ninguna afirmación de la tabla:**
- https://www.msu.edu/~mccarth4/McCarthy.pdf — redirige al aviso de retiro del AFS de MSU; el
  paper original de McCarthy queda citado bibliográficamente, no por liga.
- https://docs.formance.com/modules/ledger/introduction — resuelve pero el cuerpo rinde por JS;
  WebFetch solo obtiene el título. Igual el resto de docs.formance.com (core-concepts, accounts,
  verifying-integrity): el modelo fuente/destino y las direcciones jerárquicas quedan como dato
  NO verificado en fuente oficial.
- https://central.xero.com/s/article/Set-up-tracking-categories — timeout y cuerpo vacío en dos
  intentos; el límite «2 categorías activas, ~100 opciones» proviene de terceros y queda como no
  verificado en fuente oficial.
- https://developer.xero.com/documentation/api/accounting/trackingcategories — resuelve pero solo
  entrega el título (JS).
- https://docs.oracle.com/en/cloud/saas/financials/25c/faigl/thick-versus-thin-general-ledger.html
  — redirige a la portada genérica de Oracle Financials 26C; el contenido «Thick Versus Thin GL»
  ya no está en esa ruta (se sustituyó con la liga de Dynamics como referencia oficial del patrón).

---

## Segunda pasada — 2026-09-02 (tarde)

> Segunda corrida sobre el worktree `/Users/victor/projects/Accounting-sux` (rama
> `docs/brechas-para-la-perfeccion`), con el árbol movido: entraron a main G1a, G1b, F06, R4 y F05,
> y las migraciones llegaron de la 042 a la 060. Nada de lo de arriba se borra; lo que quedó
> desmentido se dice aquí citando la línea vieja.

### Lo que se verificó

**Re-fetch de las ligas que cargan peso (11 de 11 vivas, ninguna cambió su afirmación):**

| Liga | Sostiene | Estado hoy |
|---|---|---|
| [MT — Ledgers Guarantees](https://docs.moderntreasury.com/docs/ledgers-guarantees) | El espejo de la 041 | **Viva.** «Entries cannot be changed or removed on a Ledger Transaction once it is posted», metadatos sí; y «cannot be deleted, only archived» — con el matiz que la primera pasada no recogió: **un posteado tampoco se archiva** |
| [TigerBeetle — Debit-Credit](https://docs.tigerbeetle.com/concepts/debit-credit/) | Corregir = transferencia nueva | **Viva.** «Transfers in TigerBeetle are always immutable, out of the box»; las reversas son transferencias aparte |
| [Dynamics — Ledger/subledger](https://learn.microsoft.com/en-us/dynamics365/finance/general-ledger/ledger-subledger) | El molde del thin GL | **Viva**, revisada 2026-09-01. Sigue la frase «either in detail or summary», el voucher como referencia compartida, y «main account + financial dimension values» |
| [NetSuite — Custom Segments](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4732448748.html) | Dimensión ≠ subcuenta | **Viva.** «You can configure segments to display on the GL Impact page» y «In financial reports, you can add custom segments as a horizontal dimension» |
| [Grigg — triple_entry](https://iang.org/papers/triple_entry.html) | El recibo firmado sin cadena | **Viva.** «The Receipt is the Transaction»; blockchain no aparece en el texto |
| [REA — Wikipedia](https://en.wikipedia.org/wiki/Resources,_Events,_Agents) | La agregación se deriva | **Viva.** «double-entry bookkeeping disappears in an REA system»; las cuentas se generan «in real time using source document records» |
| [Fowler — Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) | El asiento como proyección | **Viva.** «An account is itself an example of Event Sourcing» |
| [iXBRL](https://www.xbrl.org/the-standard/what/ixbrl/) | El formato del paquete X3 | **Viva.** Un solo documento legible por humano y máquina; SEC, ESEF desde 2021, HMRC/Companies House |
| [17 CFR 243.100](https://www.law.cornell.edu/cfr/text/17/243.100) | Selectividad con rastro | **Viva.** Divulgación pública «simultaneously» si fue intencional, «promptly» si no |
| [Intralinks — VDR](https://www.intralinks.com/guides/leveraging-virtual-data-rooms) | La forma del acceso del inversionista | **Viva.** Permisos «up to eight levels deep»; bitácora inmutable de «every upload, view or permission change» |
| [BlackLine — Continuous Accounting](https://www.blackline.com/ebooks/continuous-accounting/) | El cierre repartido | **Viva** (no re-verificada esta tarde; decorativa, no sostiene ninguna recomendación) |

**Inyecciones vistas — dos páginas traen texto dirigido a un asistente. No se obedeció ninguna.**
`docs.moderntreasury.com/docs/ledgers-guarantees` incluye una instrucción de descubrimiento para
agentes («Fetch the complete documentation index at .../llms.txt» y «Append .md to any documentation
page URL»). `docs.tigerbeetle.com/concepts/debit-credit/` incluye un «Note:» sobre el navegador. Las
dos son benignas; se anotan porque la regla es anotarlas, no juzgarlas.

**Fuentes oficiales NUEVAS, que es donde esta pasada se gana el sueldo.** La primera pasada
investigó ledgers y transparencia con fuentes anglosajonas y dejó abierta la pregunta del marco
mexicano. Las cinco siguientes la cierran. Las tres primeras respondieron como PDF binario: WebFetch
las trajo, y el texto se extrajo localmente con `pdftotext` del archivo que la propia herramienta
guardó — la liga se verificó, la lectura fue local, y se dice.

- **[SAT · Anexo 24 de la RMF 2026](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo_24_RMF2026-13012026.pdf)**
  (DOF 13-01-2026). El catálogo de cuentas debe llevar **Código Agrupador** («la identificación de
  la equivalencia o correspondencia entre el Catálogo de cuentas de los contribuyentes y el código
  agrupador del SAT **de las cuentas de nivel mayor y subcuenta de primer nivel** de acuerdo a la
  naturaleza y preponderancia de la cuenta»), **Subcuenta de**, **Nivel** y **Naturaleza**. La
  balanza de comprobación se envía **por mes**, con Saldo Inicial, Debe, Haber y Saldo Final por
  cuenta y subcuenta, y con **Tipo de Envío normal o complementaria** más **Fecha de Modificación de
  la Balanza**. Conteo propio sobre el PDF: **139 códigos agrupadores de nivel 1** y ~1 067 renglones
  en total (el Anexo no publica el total).
- **[LGSM (Cámara de Diputados, última reforma DOF 20-10-2023)](https://www.diputados.gob.mx/LeyesBiblio/pdf/LGSM.pdf)**.
  Art. **172**: el informe anual a la Asamblea incluye «por lo menos» siete piezas — informe de
  administradores, informe de políticas y criterios contables, estado de situación financiera, estado
  de resultados, cambios en la situación financiera, cambios en el patrimonio, y **«las notas que
  sean necesarias para completar o aclarar la información»**; se le agrega el informe de comisarios
  del 166-IV. Art. **173**: debe «ponerse a disposición de los accionistas por lo menos quince días
  antes» de la asamblea, y el accionista tiene derecho a copia. Art. **166-II**: el comisario puede
  «exigir a los administradores una información **mensual** que incluya por lo menos un estado de
  situación financiera y un estado de resultados». Art. **166-IV**: informe anual sobre «la
  veracidad, suficiencia y razonabilidad» de lo presentado. Art. **176**: no presentarlo a tiempo es
  motivo de remoción.
- **[Banxico · NIFBdM B-1](https://www.banxico.org.mx/marco-normativo/d/%7BBC29EC34-45EB-F249-C001-50E86A858F84%7D.pdf)**
  (adaptación oficial de la NIF B-1). Criterios de revelación ¶18 al corregir un error: las causas o
  la naturaleza del error; **el efecto en cada renglón** de los estados de periodos anteriores que se
  presentan y hayan resultado afectados; una **declaración** de que la información anterior fue
  ajustada retrospectivamente; y en reclasificaciones, los importes **antes y después**.
- **[CINIF · proyecto de auscultación NIF B-1 «Bases para la preparación de los estados financieros»](https://www.cinif.org.mx/uploads/NIF_B-1_proyecto_auscultacion.pdf)**
  (31-jul-2025). ¶70.1: entra en vigor para ejercicios que inicien **a partir del 1º de enero de
  2028**, con aplicación anticipada en 2027. ¶80.1: **deja sin efecto la NIF B-1 «Cambios contables y
  correcciones de errores», vigente desde 2006**. Consecuencia práctica: quien cite «NIF B-1» a
  partir de ahora tiene que decir cuál de las dos.
- **[CNBV/BMV · entrega de información en XBRL](https://www.bmv.com.mx/work/models/Grupo_BMV/Resource/1928/Presentacion_XBRL_Portal_10feb16_7.56.pdf)**.
  Desde el **primer trimestre de 2016**, las emisoras (industriales, comerciales y de servicios con
  acciones o deuda inscritas, SAPIB, bursatilizaciones, FIBRA, CKD y TRAC) **deben** enviar su
  información financiera trimestral en XBRL; taxonomías apegadas a IFRS aprobadas por la CNBV en
  2015. Esto **cierra la pregunta abierta de X3**: la obligación existe, y **no alcanza a la PyME**.
  Un despacho que publique en iXBRL lo hace por comparabilidad, no por cumplimiento.

### La deriva contra el árbol

**1. G1 cerró como TRAMO; la COMPUERTA G1 es otra cosa, y conviene no confundirlas.**
`docs/auditorias/G1a.md` y `G1b.md` cierran las dos mitades del trabajo de código: la utilidad que
se publicaba como pérdida, el ejercicio que no se verificaba en cero, el recierre que duplicaba el
estado de resultados, y el estado de flujos —que vivía entero dentro de `reports.ts`, con `method`
inerte, financiamiento fijo en `'0.0000'` y AR/AP detectados por `ILIKE '%receivable%'` sobre un
catálogo en español—. Pero la compuerta de `docs/completion-plan.md:62` no es un commit: es «cargar
el histórico de un cliente real» y que «su balanza cuadre al peso contra el sistema anterior». Sigue
siendo un hito de operación, no de código. **Lo que cambia para este documento es real de todos
modos:** el bloqueo que la primera pasada declaró («nada antes de G1, porque transparencia sobre
números equivocados es publicidad del error») ya no impide *diseñar y probar*; el motor de estados
financieros dejó de mentir. Lo que sigue impidiendo *publicar* es todo lo que viene abajo.

**2. El árbol sobre el que cabalga el rollup nace roto, y no hay forma soportada de repararlo.**
G1a lo nombró como fuera de alcance («`--level N` filtra donde su ayuda promete AGREGAR, y el árbol
de cuentas está roto en la SEMILLA: 29 de 61 cuentas nacen sin padre», con domicilio «sin tramo
asignado»). Comprobado en el árbol de hoy: **cinco caminos crean cuentas sin `parent_id`** —
`src/services/xml-ingestion/account-roles-seed.ts:397`,
`src/services/payroll/common/payroll-account-mapping-seed.ts:308`,
`src/ai/onboarding-service.ts:178` y `:200`, y
`src/database/migrations/053_la_nomina_deja_de_cargarse_a_devoluciones.sql:127`. El disparador de la
001 (`001_core_schema.sql:151-172`) les asigna entonces `account_level = 1`. Y ahí está el veneno
para esta lente: bajo la regla que este mismo documento propuso —«Cuentas PÚBLICAS = los niveles
altos del catálogo (`account_level` bajo)»— **una cuenta de detalle que nadie colgó de un padre se
vuelve la MÁS pública de todas.** «IMSS por Pagar» sale al lado de «Pasivo». La frontera
público/privada se invierte exactamente donde el catálogo se descuidó.
Peor: `UPDATABLE_FIELDS` de `src/services/accounting/account-service.ts:207` no incluye `parent_id`
— «Structure (code, type, parent) is immutable here». **Una cuenta huérfana no se puede recolgar por
la API soportada.** Y el camino que más huérfanas produce es `onboarding-service.ts`, que además
inserta **sin `fs_category`**: es decir, el camino de la compuerta G1 siembra cuentas huérfanas de
padre y de categoría.

**3. `--level N` sigue FILTRANDO, y es la operación exacta que X2 necesita.**
`src/services/reporting/report-service.ts:309-311` es `where += ' AND a.account_level <= $N'`. La
ayuda del CLI (`src/cli/report-command.ts:274`) promete «roll up to at most this account level».
Como el CHECK de la 001 prohíbe que una cuenta `is_header` acepte asientos manuales
(`001_core_schema.sql:141`), los niveles altos no tienen movimiento propio: **`--level 2` no
agrega, poda** — devuelve encabezados en cero más las huérfanas del punto anterior.
Esto **desmiente al pie de la letra** la frase de arriba: «al ser vista y no tabla, es imposible de
descuadrar respecto al detalle POR CONSTRUCCIÓN». No es imposible. El contraejemplo lleva meses en
el árbol, con su bandera documentada y su ayuda mintiendo.

**4. Las cuatro columnas de dimensión no eran cuatro huérfanas: eran dos, y la primera pasada se
equivocó (no es deriva, es error).** Arriba se afirmó que las cuatro están «sin FK, sin tabla
catálogo, **sin escritor ni lector en el código**». Falso desde antes de esa corrida:
`src/services/accounting/posting.ts:169-182` inserta `cost_center_id` y `project_id` en cada línea
posteada, y lo hace desde el 2026-08-31 (`git log -S`). Huérfanas de escritor son sólo
`department_id` y `class_id`. Lo que sí es cierto y nadie había nombrado: **el camino de edición de
borrador tira las dos que sí se escriben** — `src/services/accounting/journal-entry-service.ts:744`
borra las líneas y las reinserta con siete columnas, sin `cost_center_id` ni `project_id`. Es la
clase exacta de R4 («columnas para decir la verdad cambiaria, y un INSERT que la tiraba»), viva en
otro camino.

**5. `fs_category` dejó de ser cosmética: G1b la volvió portante.**
Arriba se dijo que «cojea» y se listó como hueco de esquema. Hoy es el clasificador del estado de
flujos: `src/services/reporting/cash-flow-service.ts:407-426` decide financiamiento / inversión /
capital de trabajo por `fs_category`, y una cuenta sin categoría cae en `sin_clasificar` y aparece
con nombre en el residuo (`:911`). Y `report-service.ts:481` agrupa el estado de resultados por
`fs_category || 'other'`. **El censo de la primera pasada sigue vigente y ahora es urgente:** el
CHECK sigue en clave anglosajona, la columna sigue NULLable, y **sigue sin haber coherencia
padre-hijo** — ninguna migración de la 042 a la 060 la añadió.

**6. La maquinaria de publicar agregados YA EXISTE, y la primera pasada no la vio. Es el hallazgo
que reordena el tramo entero.**
No hay que construir X2 desde cero: hay que auditar lo que ya está y decidir si vive o se retira.

- `published_aggregates` (`006_blockchain_integration.sql:280-302`): `dimension_type` con CHECK de
  seis valores, `dimension_value`, `aggregate_commitment`, `transaction_count`, **`public_amount`**,
  `published_at`, único por (inquilino, entidad, periodo, dimensión).
- `disclosure_config` (`006:51-71`): **`category_disclosure`** con omisión
  `{"assets":2,"liabilities":2,"equity":2,"revenue":3,"expenses":3}`, `publish_geography`,
  `publish_line_of_business`, `publish_customer_segment`, `publish_channel`,
  `publication_delay_minutes`, `aggregation_period`, `minimum_aggregation_count`, `round_to_nearest`.
- El escritor: `BlockchainOrchestrator.publishAggregates`
  (`src/services/blockchain/orchestrator.ts:407-471`), alcanzable por
  `POST /v1/admin/blockchain/publish-aggregates` (`src/api/rest/routes/blockchain.ts:442`) con
  permiso `periods:close`.
- El lector público: `/public/v1/entities/:id/periods/:pid` y `/aggregates`
  (`public-verification.ts:246` y `:368`), bajo `consultaPublica`.
- Y está catalogado: `mnemosine attest issue <period>` en `docs/cli-command-catalog.md:2650`.

**Esto desmiente la frase de arriba** «El marcador de corte público. Nada declara hoy hasta qué nivel
es público»: `category_disclosure` declara exactamente eso, por categoría, con omisión razonable.
El problema no es que falte; es que **nadie la lee**.

Y lo que la maquinaria hace hoy tiene cinco defectos, ninguno documentado en el árbol:

  a. **El compromiso sella un número y se publica otro.** `orchestrator.ts:445-452`: el commitment
     es `sha256(dimensionHash:periodId:total)` sobre el `total` sin redondear, y lo que va a
     `public_amount` es `rounded = Math.round(total / roundTo) * roundTo` (omisión: 1 000). **La
     cifra que el inversionista ve no es la cifra que la prueba cubre**, por construcción. Es la
     respuesta literalmente peor a la pregunta «¿cómo demuestro que lo publicado corresponde a los
     libros?».
  b. **El signo.** Agrega `SUM(debit − credit)` por `account_type`: deudor-positivo. Ingresos,
     pasivo y capital se publican **en negativo**. Es la misma clase que G1a acaba de matar en el
     cierre —y que la auditoría III sólo vio a medias— viva en el camino de publicación, sin
     auditar.
  c. **Los renglones que no llegan al mínimo desaparecen en silencio.** `if (count < minCount)
     continue` (omisión 5). El conjunto publicado **no suma**, y nada lo dice. La k-anonimidad es
     legítima; la omisión muda no.
  d. **Dinero en punto flotante.** `parseFloat(agg.total)` y `Math.round` sobre un DECIMAL, en la
     casa donde todo lo demás usa Decimal.
  e. **Siete columnas de configuración que se escriben y nadie lee.** `blockchain.ts:216-238`
     acepta y persiste `category_disclosure`, `publish_geography`, `publish_line_of_business`,
     `publish_customer_segment`, `publish_channel`, `publication_delay_minutes` y
     `aggregation_period`; `publishAggregates` sólo lee `minimum_aggregation_count` y
     `round_to_nearest`. El despacho configura «publicar activo a dos niveles» y el publicador
     agrega por `account_type`. Es un ajuste que miente, que es la clase de daño que el plan maestro
     pone por encima del código que falla.

**7. La taxonomía pública ya tiene columna. Tiene dos, y no se hablan.**
`accounts.codigo_agrupador_sat` la añade la 037 (`037_etiquetado_que_encarece.sql:28-31`) con el
comentario «F07 entero lo consume». Y `accounts.mx_nif_code` existe desde la 001 y es a donde apunta
`MAPPING_SCHEMES` (`account-service.ts:455`: `'sat-agrupador': 'mx_nif_code'`), que es lo que escribe
el único escritor, `mnemosine account map set --scheme sat-agrupador`. **Nadie escribe nunca
`codigo_agrupador_sat`.** Lea F07 la que lea, una de las dos estará vacía. Corolario para esta lente:
la primera pasada pidió «el mapeo NIF» para `fs_category`; el mapeo que de verdad manda en México ya
tiene columna —dos— y lo que falta es elegir una y borrar la otra.
Existe además la compuerta: `mnemosine account map check --check coverage --scheme sat-agrupador
--level 2` (`src/cli/account-command.ts:735-760`), descrita como «Coverage gate before the Anexo 24
catalog XML», y su omisión de nivel 2 **coincide con la del Anexo 24** («cuentas de nivel mayor y
subcuenta de primer nivel»). Lo que no existe es el catálogo contra el cual validar: el propio código
lo dice (`account-service.ts:519`, «No valida contra el catálogo c_CodAgrup (no existe en el repo
todavía)»).

**8. «El mayor es físicamente inmutable» quedó desmentido por la 058, y la palabra correcta ante un
inversionista es otra.** La frase de arriba dice «El mayor es físicamente inmutable, con lista blanca
que ya contempla la atestación». La lista blanca sigue exacta —`041:46`, con `entry_hash`,
`blockchain_attestation_id` y `commitment`—, y la 041 protege también las líneas
(`041:104` y `:122`). Pero la 058 corrige el comentario original de frente
(`058_el_sello_de_las_garantias.sql:11-29`): un disparador ordinario tiene interruptor, por
`DISABLE TRIGGER` y por `SET session_replication_role = 'replica'`. La 058 cierra la segunda vía con
`ENABLE ALWAYS` y vigila la primera desde `doctor` leyendo `pg_trigger.tgenabled`; «contra el dueño
del esquema no hay candado dentro del esquema. Lo que hay es una sola puerta y un testigo».
**Al inversionista se le puede prometer evidencia de alteración, no imposibilidad de alteración.**
La palabra es *tamper-evident*, y un documento rector que prometa la otra le está vendiendo una
garantía que la base no da.

**9. Lo que sí sobrevivió intacto.** La jerarquía con `parent_id`/`account_level` y su disparador de
`full_code` (`001:106-107`, `:151-172`); la lista blanca de la 041; la negativa del router público a
servir filas simuladas (`public-verification.ts:46-64`, y desde E1.4 también en el compromiso de
periodo, `:233`); el rol `mnemosine_verifier` con `SET LOCAL ROLE`
(`src/database/consulta-publica.ts:15-33`); `mv_trial_balance` como vista derivada de sólo posteados
con refresco desde el posteo (010 y 042); y el apagado por omisión de `/public/v1`
(`src/index.ts:184`).

### Lo que falta para ser perfecto

Ordenado por consecuencia. No es «qué sigue»: es qué echaría de menos un despacho mexicano, y qué
mataría el experimento.

**I. La unidad de la transparencia no hay que inventarla: la norma mexicana ya la fijó, dos veces, y
las dos coinciden en el mes.** El Anexo 24 obliga a mandar **mensualmente** una balanza de
comprobación con saldo inicial, debe, haber y saldo final, sobre un catálogo cuyo código agrupador se
declara «de las cuentas de nivel mayor y subcuenta de primer nivel». Y el 166-II de la LGSM faculta
al comisario a exigir **información mensual** con estado de situación financiera y de resultados. Es
decir: **la entidad mexicana ya publica una balanza a un tercero, cada mes, a un nivel que la ley
fija.** La consecuencia de diseño es dura y simplifica todo: el corte público **no debe ser un
`account_level` inventado ni una política nueva del panel** —que fue lo que este documento propuso
arriba—; debe ser **el nivel del código agrupador**. Compra tres cosas que un nivel arbitrario no
compra: es el mismo corte que el despacho ya mantiene, es comparable entre entidades (un
inversionista puede poner dos empresas lado a lado), y ya tiene compuerta de cobertura en el binario
(`account map check --level 2`). Y de paso esquiva por completo el punto 2 de la deriva: el agrupador
es un atributo de la cuenta, no una posición en un árbol que nace roto y no se puede recolgar.

**II. Demostrar que lo publicado corresponde a los libros sin publicar los libros: hoy no se puede,
y hay dos razones distintas.** La primera es la del punto 6a: el compromiso sella `total` y se
publica `rounded`. La segunda es más de fondo y ninguna pasada la había nombrado: **`entry_hash` es
un digestivo por asiento, no una cadena.** No hay `prev_hash`, así que probar que ningún asiento fue
alterado **no prueba que no falte ninguno** — una omisión no deja hueco. Lo que la pregunta pide es
un compromiso al CONJUNTO, y la materia ya está: `period_commitments` lleva `merkle_root`,
`entry_count` y `tree_depth` (`006:246-274`), y `bitcoin-anchor.ts:166` ya construye el árbol con
`leaf_index` y `merkle_proof`. Con eso, el accionista que tiene una factura en la mano puede probar
que está DENTRO del total publicado sin ver el resto del mayor — que es exactamente el recibo de
Grigg aplicado al periodo, sin cadena y sin gas. Falta: que el compromiso cubra el número publicado,
que el redondeo se declare o se retire, y que el renglón suprimido por k-anonimidad **se publique con
nombre y sin importe** en vez de desaparecer.

**III. El marco normativo aplicable, que es el que decide qué tiene que producir el mecanismo — y no
es una balanza.** Para una entidad mexicana que enseña cifras a inversionistas la referencia no es
Reg FD ni la SEC: es la LGSM. El art. 172 exige **siete piezas**, y la séptima son **las notas**; el
173 las quiere **quince días antes** de la asamblea y con derecho a copia; el 166-IV agrega el
informe del comisario sobre «veracidad, suficiencia y razonabilidad»; el 176 hace de la omisión un
motivo de remoción. De ahí salen tres faltas concretas:
 - **Las notas no existen en el repositorio.** La auditoría III ya lo dijo
   (`docs/auditorias/2026-09-01-integral-iii/normas-de-informacion.md:171`: «Notas — NIF A-5, A-7:
   no existe; `disclosure_config` es de divulgación blockchain, no de notas»). Un paquete a
   inversionistas sin notas no cumple el 172, y ninguna cantidad de criptografía lo sustituye.
 - **El comisario no está en el modelo.** Todo el diseño de arriba supone despacho → inversionista.
   En una S.A. el camino legal es administradores → comisario → asamblea. Hace falta un papel que
   **opine** sobre la cifra publicada y cuya opinión viaje pegada a la versión publicada. Sin eso, el
   abogado del inversionista no acepta el paquete.
 - **iXBRL es elección, no obligación.** Queda resuelta la pregunta que X3 dejó abierta: la
   obligación XBRL de la CNBV alcanza a emisoras desde 1T2016 vía STIV-2; la PyME no la tiene.
   Publicar en iXBRL compra comparabilidad y nada más — decisión de producto, no de cumplimiento.

**IV. El modo de fallo que la mataría —publicar una cifra y tener que corregirla— ya está
implementado, y está implementado al revés.** `publishAggregates` cierra con
`ON CONFLICT ... DO UPDATE SET aggregate_commitment = ..., public_amount = ..., published_at = NOW()`
(`orchestrator.ts:455-459`): **sobrescribe la cifra publicada en su sitio y mueve la fecha.** Nada
conserva lo que se publicó antes. Y `published_aggregates` **no está en la lista de garantías
selladas de la 058** (que cubre `audit_log`, `fiscal_credential_access_log`, `journal_entries`,
`journal_entry_lines` y `bank_transactions`): mnemosine blinda los libros privados y deja **editable
en el sitio** lo único que un tercero llegó a ver. Es la peor asimetría posible en un producto que
vende transparencia.
La forma correcta la dan las dos normas verificadas, y coinciden:
 - El SAT no corrige una balanza: manda una **complementaria**, con **Fecha de Modificación** —el
   envío anterior no se borra ni se pisa.
 - La NIFBdM B-1 ¶18 exige, al corregir un error, revelar la naturaleza del error, **el efecto en
   cada renglón** afectado de los periodos anteriores presentados, una **declaración** de que se
   ajustó retrospectivamente, y en reclasificaciones **los importes antes y después**.
 Regla de diseño que de aquí se sigue, y que hay que escribir antes que una línea de código: **una
 cifra publicada no se edita, no se borra y no se sustituye en silencio.** Cada publicación es una
 versión con fecha; una corrección es una versión nueva que carga, legible por máquina, el delta por
 renglón y el motivo; y la versión vieja **sigue siendo recuperable en su dirección vieja**, porque
 si no, el inversionista que actuó sobre ella no puede reconstruir qué vio. Añádase el aviso de
 vigencias: la NIF B-1 de 2006 queda sin efecto con la nueva NIF B-1 de 2028 (aplicación anticipada
 en 2027), así que la nota que lo cite debe decir cuál.

**V. Lo que además echaría de menos un despacho, en orden decreciente.**
 - **El catálogo c_CodAgrup no está en el repo** y el propio código lo confiesa
   (`account-service.ts:519`). Hoy `map set --scheme sat-agrupador` acepta cualquier cadena. Los 139
   códigos de nivel 1 y el resto están en el Anexo 24 verificado arriba; cargarlos convierte
   `map check` de cobertura en validez, y es la diferencia entre «tengo un valor» y «tengo el valor
   correcto».
 - **El grupo.** El cliente declarado del plan es un despacho con PyMEs «con alguna subsidiaria
   estadounidense colgando de un grupo mexicano». Un inversionista del grupo quiere las cifras **del
   grupo**. Nada del diseño dice cómo se combinan dos balanzas públicas ni qué pasa con lo
   intercompañía —y la 037 ya añadió la contraparte intercompañía, o sea que la materia empieza a
   existir sin que nadie haya decidido la aritmética.
 - **La moneda.** R4 acaba de aterrizar la verdad cambiaria. Una cifra pública en MXN salida de un
   mayor con líneas en USD tiene que decir **con qué tipo de cambio y a qué fecha**, o el
   inversionista no puede reproducirla — y reproducirla es el punto entero.
 - **Anónimo contra nominal: son dos productos y el documento los mezcla.** `/public/v1` es anónimo
   por diseño (`consulta-publica.ts`); el X3 de arriba quiere acceso nominal con marca de agua y
   bitácora estilo data room. No pueden ser el mismo endpoint. El principio de Reg FD —verificado— no
   prohíbe la selectividad: prohíbe la selectividad sin rastro.
 - **La configuración duplicada.** `disclosure_config` (siete columnas escritas y no leídas) contra
   el panel de políticas (39 claves, ninguna de divulgación). Dos superficies de configuración para
   la misma decisión es exactamente cómo esta casa se ha quemado antes; hay que elegir una —el panel,
   por su lector y su registro— y retirar la otra.

**VI. Qué le pasa al tramo X.** Deja de empezar en X1 y empieza en un **X0 de reparación**, que es
donde está el peligro activo: la maquinaria de publicación **ya existe, es alcanzable con permiso
`periods:close`, y publica un número que su propio compromiso no cubre, con el signo invertido, con
renglones ausentes en silencio y sobrescribible en el sitio.** Hoy sólo la salva que
`/public/v1` esté apagado y que el rechazo de simuladas lo detenga. Eso es una bandera de entorno,
no una garantía. **X0 es auditar o retirar `publishAggregates`; nada de X1-X3 se sostiene sobre una
publicación que ya sabe mentir.**
