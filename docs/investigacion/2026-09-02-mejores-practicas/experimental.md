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
