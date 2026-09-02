# La contabilidad como centro

## EXPERIMENTAL: una lente de investigación, no una obra

> **Nada de esta página existe ni se construirá antes de G1** — la compuerta de cargar el histórico de un cliente real con balanza que cuadre al peso (`docs/completion-plan.md`). La razón cabe en una frase: **transparencia sobre números equivocados es publicidad del error.** Una balanza pública derivada de estados que hoy pueden mentir no informa: difama al propio despacho. Esta página documenta la investigación del 2026-09-02 (lente 6) y la dirección que tomaría el tramo experimental "X" si algún día se abre. El estado real del plan se pregunta, no se supone: `npm run plan:status`. Ver [[Hoja-de-ruta]].

## La tesis, en corto

La frontera entre lo que un tercero puede ver y lo que es del despacho **no es una tabla nueva ni una copia: es un corte sobre la jerarquía de cuentas que ya existe.** Cuentas públicas = los niveles altos del catálogo, atestadas con la criptografía que el mayor ya produce. Subcuentas privadas = el detalle del despacho, bajo RLS exactamente como hoy (ver [[Aislamiento-multi-inquilino]]). Y la agregación pública es una **vista derivada**, jamás una tabla: al derivarse, es imposible de descuadrar respecto al detalle por construcción.

Lo que ya existe y hace la tesis pensable — todo verificable en el árbol:

- La jerarquía es real: `accounts` tiene `parent_id` y `account_level` con disparador que calcula nivel y `full_code` ([`src/database/migrations/001_core_schema.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/001_core_schema.sql)).
- El mayor es físicamente inmutable, y su lista blanca de metadatos ya contempla la atestación: `entry_hash`, `blockchain_attestation_id` y `commitment` ([`src/database/migrations/041_el_mayor_inviolable.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/041_el_mayor_inviolable.sql)); el orquestador escribe hash y compromiso después de postear ([`src/services/blockchain/orchestrator.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/blockchain/orchestrator.ts)).
- La balanza ya es vista derivada: `mv_trial_balance` agrega solo posteados y su refresco sale del posteo.
- La verificación pública existe, apagada, y se niega a mentir: el router `/public/v1` solo se monta con `PUBLIC_VERIFICATION_ENABLED=true` y responde 501 ante atestaciones simuladas — una prueba fabricada es peor que ninguna ([`src/api/rest/routes/public-verification.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/api/rest/routes/public-verification.ts)). Las consultas corren bajo `mnemosine_verifier` con SELECT enumerado, nunca un rol que ignore RLS ([`src/database/consulta-publica.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/consulta-publica.ts)).

## El libro delgado y las dimensiones

El patrón de industria que le da forma al corte es el **thin GL**: el mayor guarda el mínimo — catálogo corto, cuentas resumen — y el detalle vive en subledgers, con drill-back del saldo agregado al documento original. La referencia verificada es [Dynamics 365 Finance](https://learn.microsoft.com/en-us/dynamics365/finance/general-ledger/ledger-subledger). Para mnemosine la lectura es directa: los niveles altos son el libro delgado que un tercero ve; el detalle del despacho es el subledger.

El complemento es la dimensión: en Dynamics la cuenta es `main account + valores de dimensión`, y [NetSuite](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4732448748.html) resuelve lo mismo con segmentos. La regla: la subcuenta responde "¿de quién es este saldo ante terceros?" (estructura estable, pública en sus niveles altos); la dimensión responde "¿cómo lo rebano para adentro?" (analítica, volátil, privada siempre). Si el despacho explota subcuentas por cliente o proyecto, cada alta engorda el catálogo y acerca detalle privado a los niveles públicos.

Las limitaciones del esquema actual, dichas primero:

1. **Las dimensiones son hoy capacidad huérfana.** `journal_entry_lines` trae cuatro columnas — `cost_center_id`, `department_id`, `project_id`, `class_id` — como UUID sueltos: sin FK, sin catálogo, sin escritor ni lector. Prometen contabilidad dimensional y nadie las sirve. La decisión "¿el detalle por cliente/proyecto va en subcuenta o en dimensión?" es criterio del despacho: iría al panel de políticas con su lector, con omisión = subcuenta (lo que hoy funciona), y las columnas o ganan catálogo y escritor, o se retiran — por decisión registrada, no por deriva.
2. **`fs_category` cojea.** Su CHECK enumera categorías anglosajonas (`cogs`, `current_assets`...) — no NIF —, es NULLable sin obligación para cuentas posteables, y no hay coherencia padre-hijo: una subcuenta puede contradecir la categoría de su padre y desamarrar la agregación por categoría de la agregación por jerarquía — exactamente el descuadre que la lente quiere hacer imposible. Falta un disparador (la lección de la 041: el disparador aguanta, el GRANT no) y el mapeo a NIF B-6.
3. **Nada declara hasta qué nivel es público.** El corte por entidad es criterio del despacho: política en el panel, leída por la vista. Omisión: **nada es público** — la vista existe vacía hasta que el humano dispone.

## REA y el asiento como proyección

El modelo REA (McCarthy, 1982, The Accounting Review; [síntesis](https://en.wikipedia.org/wiki/Resources,_Events,_Agents)) registra Recursos, Eventos y Agentes de la realidad económica; los cargos y abonos desaparecen como objetos persistidos y las cuentas se **derivan** de los documentos fuente. La misma tesis en clave de software es el event sourcing de [Fowler](https://martinfowler.com/eaaDev/EventSourcing.html), quien señala que los asientos contables son event sourcing avant la lettre.

mnemosine ya vive esto a medias: el CFDI o el estado de cuenta es el evento, la clasificación con sus hechos y decisiones es la interpretación auditada, y el asiento es la proyección. La lente no pide adoptar REA; pide reconocer una consecuencia: **el asiento público de nivel alto es una proyección más del mismo evento**, igual de derivada que la privada. De ahí que la agregación pública sea vista y jamás tabla — lo derivado no se persiste, se calcula, y por eso no puede descuadrar.

## Lo que sobrevive de la triple entrada — sin blockchain

El paper de la triple entrada ([Grigg](https://iang.org/papers/triple_entry.html)) no menciona blockchain. Son Alice, Bob e Ivan, y un **recibo firmado** que contiene la instrucción y la confirmación, selladas con firma digital: "the receipt is the transaction". Lo que sobrevive es exactamente eso: evidencia compartida y firmada entre partes — sin cadena, sin minado, sin gas.

Para mnemosine esto reencuadra el anclaje Bitcoin simulado que está en decisión de retiro: lo que el inversionista necesita no es un bloque, es **un recibo que el despacho no pueda reescribir y que él pueda re-verificar**. El `entry_hash` por asiento que la 041 ya protege, más una firma del servidor sobre la balanza agregada del periodo, ES un recibo de Grigg. La fila simulada de "anclaje" no aporta nada que ese recibo no dé — y fabrica lo que el recibo no fabricaría. La propuesta del tramo: retirar el anclaje simulado a favor del recibo firmado. La llave que firma se nombra por perfil (`api_key_env`/`api_key_cmd`), y jamás es la e.firma ni el CSD, que no salen de la bóveda.

## La arquitectura pública/privada, por fases — todas bloqueadas por G1

**X1 — papel (puede empezar cuando sea; no toca esquema).** Documento de diseño que fija el corte público como política, el rollup recursivo, el mapeo `fs_category`→NIF y el recibo firmado. Con un **criterio de refutación escrito antes que el código**: "existe una secuencia de asientos posteados y reversas tal que la balanza pública atestada difiere al peso del rollup del detalle, o tal que dos lectores difieren entre sí". Si la prueba encuentra el contraejemplo, el diseño se refuta y X2 no se construye.

**X2 — la vista pública derivada (bloqueada por G1).** Vista que rollupea por `parent_id` desde `mv_trial_balance` hasta el corte que dicte la política, servida en `/public/v1` vía `mnemosine_verifier` con GRANT enumerado en migración. Hereda las dos negativas del router: sin bandera no existe; con bandera, se niega a servir agregados cuyos asientos solo tengan atestación simulada. El agente puede proponer el corte y el mapeo; publicar dispone el humano — y ninguna herramienta del agente alcanza el mayor ni la vista (ver [[El-agente-y-sus-limites]]). Con su fila de catálogo y su criterio, como todo.

**X3 — divulgación a inversionistas (bloqueada por X2 y por el retiro del anclaje).** No una página pública: un paquete por inversionista al estilo data room — la balanza del periodo en [iXBRL](https://www.xbrl.org/the-standard/what/ixbrl/) (un solo documento legible por humano y por máquina, [spec 1.1](https://www.xbrl.org/Specification/inlineXBRL-part1/REC-2013-11-18/inlineXBRL-part1-REC-2013-11-18.html)) más PDF, con el recibo firmado adjunto, bajo acceso nominal con marca de agua y **bitácora inmutable de quién vio qué versión y cuándo** (práctica estándar de los [data rooms](https://www.intralinks.com/guides/leveraging-virtual-data-rooms)). El principio viene de [Regulation FD](https://www.law.cornell.edu/cfr/text/17/243.100): no aplica a la PyME mexicana, pero fija el diseño — la divulgación selectiva sin bitácora es el pecado, no la selectividad. Pregunta abierta declarada: la taxonomía iXBRL mexicana aplicable no quedó verificada en fuente oficial.

El relato comercial que la lente habilita — y solo entonces — es el del [continuous accounting](https://www.blackline.com/ebooks/continuous-accounting/): el inversionista no ve un PDF trimestral, ve una balanza de niveles altos siempre al día y siempre cuadrada, porque el refresco sale del posteo y el cierre es continuo. mnemosine ya está estructuralmente ahí; lo que falta es que los números merezcan el escaparate. Por eso G1 va primero.

## Lo que la industria confirma

| Sistema / idea | Qué le toma mnemosine |
|---|---|
| [Modern Treasury Ledgers](https://docs.moderntreasury.com/ledgers/docs/ledgers-overview) ([guarantees](https://docs.moderntreasury.com/docs/ledgers-guarantees)) | Sus garantías — posteado inmutable salvo metadatos, archivo en vez de borrado — son el gemelo de la lista blanca de la 041 |
| [TigerBeetle](https://docs.tigerbeetle.com/) ([debit-credit](https://docs.tigerbeetle.com/concepts/debit-credit/)) | Confirmación de que "corregir = asiento nuevo, jamás edición" es patrón de industria, elevado ahí a motor de almacenamiento |
| [Formance Ledger](https://github.com/formancehq/ledger) | El ledger como servicio programable sobre Postgres; nada urgente que copiar (su doc detallada no fue verificable en esta corrida) |
| [Dynamics 365: ledger-subledger](https://learn.microsoft.com/en-us/dynamics365/finance/general-ledger/ledger-subledger) | El molde exacto de la frontera pública/privada |
| [NetSuite custom segments](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4732448748.html) | El destino correcto de las cuatro columnas huérfanas de `journal_entry_lines` |
| [REA](https://en.wikipedia.org/wiki/Resources,_Events,_Agents) y [event sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) | Legitiman "la agregación es vista, jamás tabla" |
| [Triple entrada (Grigg)](https://iang.org/papers/triple_entry.html) | El recibo firmado sustituye al anclaje simulado; cero blockchain |

## Páginas relacionadas

- [[El-tablero-grafico]] — la superficie donde el despacho vería su lado privado de la misma jerarquía.
- [[Canales-de-mensajeria]] — la otra investigación de superficie; comparte el principio de que el agente propone y el humano dispone.
- [[Arquitectura]], [[Aislamiento-multi-inquilino]] — el mayor inviolable y la RLS sobre los que este corte se apoyaría.
- [[Hoja-de-ruta]] — dónde vive G1 y por qué todo lo de esta página espera detrás.
