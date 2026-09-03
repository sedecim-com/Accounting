# La contabilidad como centro

## Lo que cambió el 2026-09-02 por la tarde

Esta página decía, en su primera línea, que **nada de esto existe ni se construirá antes de G1**. Las dos mitades de esa frase quedaron desmentidas por la segunda pasada de investigación, y en la dirección incómoda:

- **Sí existe.** La maquinaria de publicar cifras al público ya está en el árbol: tabla, configuración, endpoint de escritura, lector público sin credenciales y fila de catálogo. No hay que construir X2 desde cero.
- **Y lo que existe publica mal.** Sella un número y publica otro, invierte el signo de ingresos y pasivos, borra renglones en silencio, sobrescribe la cifra publicada en su sitio y no dice con qué tipo de cambio se armó.

De ahí el titular del tramo: **el experimento dejó de estar bloqueado por G1 y pasó a estar bloqueado por sí mismo.** El primer paso ya no es X1 en papel: es **auditar o retirar lo que hoy publica**. Ver [`docs/BRECHAS-PARA-LA-PERFECCION.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/BRECHAS-PARA-LA-PERFECCION.md) §1.4 y §8, y el expediente completo en [`docs/investigacion/2026-09-02-mejores-practicas/experimental.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/investigacion/2026-09-02-mejores-practicas/experimental.md).

> Sigue siendo una **lente de investigación, no una obra**: nada de lo que esta página propone está aprobado ni construido. El estado real del plan se pregunta, no se supone: `npm run plan:status`. Ver [[Hoja-de-ruta]].

## Lo que ya publica, y sus cinco defectos

Las piezas, todas verificables:

- **`published_aggregates`** ([`006_blockchain_integration.sql:280-302`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/006_blockchain_integration.sql)): `dimension_type` con seis valores, `aggregate_commitment`, `transaction_count`, `public_amount`, único por (inquilino, entidad, periodo, dimensión). Su bandera `is_simulated` la añade la [034](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/034_atestaciones_simuladas.sql).
- **`disclosure_config`** (misma migración, `:51-71`): `category_disclosure` con omisión `{"assets":2,"liabilities":2,"equity":2,"revenue":3,"expenses":3}`, más siete columnas de política.
- **El escritor**: `BlockchainOrchestrator.publishAggregates` ([`orchestrator.ts:406-471`](https://github.com/sedecim-com/Accounting/blob/main/src/services/blockchain/orchestrator.ts)), alcanzable por `POST /v1/admin/blockchain/publish-aggregates` con permiso `periods:close` ([`blockchain.ts:442`](https://github.com/sedecim-com/Accounting/blob/main/src/api/rest/routes/blockchain.ts)).
- **El lector público**, sin credenciales: `/public/v1/entities/:id/aggregates` ([`public-verification.ts:368`](https://github.com/sedecim-com/Accounting/blob/main/src/api/rest/routes/public-verification.ts)).
- **La fila de catálogo**: `mnemosine attest issue <period>` ([`docs/cli-command-catalog.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/cli-command-catalog.md)).

Y esto es lo que hace, ninguno documentado antes de la segunda pasada:

1. **El compromiso sella un número y se publica otro.** El commitment es `sha256(dimensionHash:periodId:total)` sobre el `total` sin redondear; lo que va a `public_amount` es `Math.round(total / roundTo) * roundTo`, con `roundTo` de omisión 1 000 (`orchestrator.ts:445-452`). **La cifra que el inversionista ve no es la cifra que la prueba cubre**, por construcción — la respuesta literalmente peor a «¿cómo demuestro que lo publicado corresponde a los libros?».
2. **El signo.** Agrega `SUM(debit − credit)` por `account_type`: deudor-positivo. **Ingresos, pasivo y capital se publican en negativo.** Es la misma clase de error que G1a acaba de matar en el asiento de cierre, viva en el camino de publicación.
3. **Los renglones bajo el mínimo desaparecen en silencio.** `if (count < minCount) continue`, omisión 5. El conjunto publicado **no suma**, y nada lo dice. La k-anonimidad es legítima; la omisión muda no.
4. **Dinero en punto flotante.** `parseFloat` y `Math.round` sobre un `DECIMAL(20,2)`, en la casa donde todo lo demás usa `Decimal`.
5. **Siete columnas de configuración que se escriben y nadie lee.** `blockchain.ts:216-238` persiste `category_disclosure`, `publish_geography`, `publish_line_of_business`, `publish_customer_segment`, `publish_channel`, `publication_delay_minutes` y `aggregation_period`; `publishAggregates` sólo lee `minimum_aggregation_count` y `round_to_nearest`. El despacho configura «publicar activo a dos niveles» y el publicador agrega por `account_type`. **Es un ajuste que miente.**

Hoy no ha salido al mundo por dos frenos, y conviene saber exactamente cuáles son: `/public/v1` sólo se monta con `PUBLIC_VERIFICATION_ENABLED=true` ([`src/index.ts:184`](https://github.com/sedecim-com/Accounting/blob/main/src/index.ts)), y el lector filtra `pa.is_simulated = false`, que hoy descarta todo porque ningún adaptador ancla de verdad. **Eso es una bandera de entorno y un filtro, no una garantía.** El escritor sigue alcanzable con `periods:close`.

## La unidad de la transparencia no hay que inventarla

La primera versión de esta página proponía inventar el corte público: una política nueva del panel que dijera «hasta el nivel N». **La norma mexicana ya lo fijó, dos veces, y las dos coinciden en el mes.**

- El **Anexo 24 de la RMF 2026** ([SAT, DOF 13-01-2026](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo_24_RMF2026-13012026.pdf)) obliga a enviar **mensualmente** una balanza de comprobación con Saldo Inicial, Debe, Haber y Saldo Final, sobre un catálogo cuyo Código Agrupador se declara «de las cuentas de nivel mayor y subcuenta de primer nivel». Trae además **Tipo de Envío normal o complementaria** y **Fecha de Modificación de la Balanza**.
- La **LGSM** ([Cámara de Diputados, ref. DOF 20-10-2023](https://www.diputados.gob.mx/LeyesBiblio/pdf/LGSM.pdf)) art. **166-II** faculta al comisario a exigir **información mensual** con estado de situación financiera y de resultados.

Es decir: **la entidad mexicana ya publica una balanza a un tercero, cada mes, a un nivel que la ley fija.** La consecuencia de diseño es dura y simplifica todo: el corte público debe ser **el nivel del código agrupador**, no un `account_level` inventado. Compra tres cosas que un nivel arbitrario no compra — es el mismo corte que el despacho ya mantiene, es comparable entre entidades, y ya tiene compuerta en el binario: `mnemosine account map check --check coverage --scheme sat-agrupador --level 2` ([`account-command.ts:735-760`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/account-command.ts)), cuya omisión de nivel 2 coincide con la del Anexo 24. Y esquiva por completo el problema del árbol roto que viene abajo: el agrupador es un atributo de la cuenta, no una posición en una jerarquía.

**Falta el catálogo contra el cual validar.** El propio código lo confiesa: «No valida contra el catálogo `c_CodAgrup` (no existe en el repo todavía)» ([`account-service.ts:519`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/account-service.ts)). Los 139 códigos de nivel 1 y el resto están en el Anexo 24 verificado arriba. Y hay **dos columnas para el mismo concepto**: `accounts.mx_nif_code` (001), que es a donde apunta `MAPPING_SCHEMES` y lo único que `map set --scheme sat-agrupador` escribe; y `accounts.codigo_agrupador_sat` ([`037:28-31`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/037_etiquetado_que_encarece.sql)), cuyo comentario promete que «F07 entero lo consume» y que **no tiene una sola referencia en TypeScript**. Lea F07 la que lea, una de las dos estará vacía. Ver [[Onboarding-de-contabilidad]], que ya arrastra esta misma consolidación.

## Por qué el corte no puede ser el `account_level`

La regla que esta página proponía —«cuentas públicas = los niveles altos del catálogo»— tiene un veneno que la segunda pasada encontró: **el árbol nace roto y no hay forma soportada de repararlo.**

- **Cinco caminos crean cuentas sin `parent_id`**: [`account-roles-seed.ts:397`](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/account-roles-seed.ts), [`payroll-account-mapping-seed.ts:308`](https://github.com/sedecim-com/Accounting/blob/main/src/services/payroll/common/payroll-account-mapping-seed.ts), [`onboarding-service.ts:178` y `:200`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/onboarding-service.ts) y la [053](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/053_la_nomina_deja_de_cargarse_a_devoluciones.sql)`:127`. El disparador de la 001 (`:151-172`) les asigna entonces `account_level = 1`.
- Bajo la regla del nivel, **una cuenta de detalle que nadie colgó de un padre se vuelve la más pública de todas**: «IMSS por Pagar» sale al lado de «Pasivo». La frontera se invierte exactamente donde el catálogo se descuidó.
- **No se puede recolgar por la API soportada**: `UPDATABLE_FIELDS` de `account-service.ts:205-207` no incluye `parent_id` — «Structure (code, type, parent) is immutable here».
- Y el camino que más huérfanas produce, `onboarding-service.ts`, inserta además **sin `fs_category`**: el camino de la compuerta G1 siembra cuentas huérfanas de padre y de categoría.

**Peor para la tesis:** `--level N` no agrega, **poda**. `report-service.ts:309-311` es `where += ' AND a.account_level <= $N'`, mientras la ayuda del CLI promete «roll up to at most this account level»; y como el CHECK de la 001 prohíbe que una cuenta `is_header` acepte asientos (`001:141`), los niveles altos no tienen movimiento propio. **Esto desmiente al pie de la letra** lo que esta página afirmaba: que la agregación derivada es «imposible de descuadrar respecto al detalle por construcción». No es imposible. El contraejemplo lleva meses en el árbol, con su bandera documentada y su ayuda mintiendo.

Lo que sobrevive de la tesis es más modesto y sigue siendo cierto: **la agregación pública debe ser derivada y jamás persistirse como tabla paralela** — patrón REA ([síntesis](https://en.wikipedia.org/wiki/Resources,_Events,_Agents)) y event sourcing ([Fowler](https://martinfowler.com/eaaDev/EventSourcing.html), que señala que el asiento contable ya *es* event sourcing). Derivarla no la hace correcta por sí sola; la hace **corregible en un solo lugar**.

## Una cifra publicada no se edita

Es el modo de fallo que mataría el experimento, y ya está implementado **al revés**. `publishAggregates` cierra con `ON CONFLICT ... DO UPDATE SET aggregate_commitment = ..., public_amount = ..., published_at = NOW()` (`orchestrator.ts:455-459`): **sobrescribe la cifra publicada en su sitio y mueve la fecha.** Nada conserva lo que se publicó antes.

Y `published_aggregates` **no está** en la lista de garantías selladas de la [058](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/058_el_sello_de_las_garantias.sql), que cubre `audit_log`, `fiscal_credential_access_log`, `journal_entries`, `journal_entry_lines` y `bank_transactions`. mnemosine blinda los libros privados y deja **editable en el sitio lo único que un tercero llegó a ver.** Es la peor asimetría posible en un producto que vende transparencia.

Las dos normas verificadas coinciden en la forma correcta: el SAT no corrige una balanza, manda una **complementaria** con Fecha de Modificación, y el envío anterior no se pisa; y la **NIFBdM B-1 ¶18** ([Banxico](https://www.banxico.org.mx/marco-normativo/d/%7BBC29EC34-45EB-F249-C001-50E86A858F84%7D.pdf)) exige, al corregir un error, revelar su naturaleza, **el efecto en cada renglón** afectado de los periodos anteriores presentados, una declaración de ajuste retrospectivo, y en reclasificaciones los importes antes y después.

**Regla de diseño, a escribir antes que una línea de código:** una cifra publicada no se edita, no se borra y no se sustituye en silencio. Cada publicación es una versión con fecha; una corrección es una versión nueva que carga, legible por máquina, el delta por renglón y el motivo; y la versión vieja **sigue siendo recuperable en su dirección vieja**, porque si no, el inversionista que actuó sobre ella no puede reconstruir qué vio.

*Aviso de vigencias:* el proyecto de auscultación de la nueva NIF B-1 «Bases para la preparación de los estados financieros» ([CINIF, 31-jul-2025](https://www.cinif.org.mx/uploads/NIF_B-1_proyecto_auscultacion.pdf)) entra en vigor para ejercicios que inicien a partir del **1º de enero de 2028** (anticipada en 2027) y **deja sin efecto la NIF B-1 «Cambios contables y correcciones de errores»** vigente desde 2006. Quien cite «NIF B-1» tiene que decir cuál.

## Tamper-evident, no inmutable

Esta página decía «el mayor es físicamente inmutable». **La 058 corrige a la 041 de frente** (`058:11-29`): un disparador ordinario tiene interruptor, por `DISABLE TRIGGER` y por `SET session_replication_role = 'replica'`. La 058 cierra la segunda vía con `ENABLE ALWAYS` y vigila la primera desde `doctor` leyendo `pg_trigger.tgenabled`; «contra el dueño del esquema no hay candado dentro del esquema. Lo que hay es una sola puerta y un testigo».

**Al inversionista se le puede prometer evidencia de alteración, no imposibilidad de alteración.** La palabra es *tamper-evident*, y una página que prometa la otra le está vendiendo una garantía que la base no da. Lo que sí sigue exacto: la lista blanca de la 041 (`:46`), que ya contempla `entry_hash`, `blockchain_attestation_id` y `commitment`, y protege también las líneas (`:104`, `:122`).

## El recibo de Grigg, y por qué `entry_hash` no basta

El paper de la triple entrada ([Grigg](https://iang.org/papers/triple_entry.html)) no menciona blockchain: son Alice, Bob e Ivan y un **recibo firmado** — «the receipt is the transaction». Eso sobrevive intacto y sigue siendo la sustitución natural del anclaje Bitcoin simulado que está en decisión de retiro.

Lo que la segunda pasada añadió, y ninguna anterior había nombrado: **`entry_hash` es un digestivo por asiento, no una cadena.** No hay `prev_hash`, así que probar que ningún asiento fue alterado **no prueba que no falte ninguno** — una omisión no deja hueco. Lo que la pregunta pide es un compromiso al **conjunto**, y la materia ya existe: `period_commitments` lleva `merkle_root`, `entry_count` y `tree_depth` (`006:246-274`), y `bitcoin-anchor.ts` ya construye el árbol con `leaf_index` y `merkle_proof`. Con eso, el accionista que tiene una factura en la mano puede probar que está **dentro** del total publicado sin ver el resto del mayor. Falta que el compromiso cubra el número publicado, que el redondeo se declare o se retire, y que el renglón suprimido por k-anonimidad **se publique con nombre y sin importe** en vez de desaparecer. La llave que firma se nombra por perfil (`api_key_env`/`api_key_cmd`); jamás es la e.firma ni el CSD, que no salen de la bóveda.

## El marco que decide qué debe producir el mecanismo

Para una entidad mexicana que enseña cifras a inversionistas la referencia **no es Reg FD ni la SEC: es la LGSM.** El art. 172 exige siete piezas, y la séptima son **las notas**; el 173 las quiere quince días antes de la asamblea con derecho a copia; el 166-IV agrega el informe del comisario sobre «veracidad, suficiencia y razonabilidad»; el 176 hace de la omisión un motivo de remoción. De ahí tres faltas concretas:

- **Las notas no existen en el repositorio.** Lo dijo ya la auditoría III ([`normas-de-informacion.md:171`](https://github.com/sedecim-com/Accounting/blob/main/docs/auditorias/2026-09-01-integral-iii/normas-de-informacion.md)): `disclosure_config` es divulgación de blockchain, no notas. Un paquete a inversionistas sin notas no cumple el 172, y ninguna cantidad de criptografía lo sustituye.
- **El comisario no está en el modelo.** Todo el diseño supone despacho → inversionista; en una S.A. el camino legal es administradores → comisario → asamblea. Hace falta un papel que **opine** sobre la cifra publicada y cuya opinión viaje pegada a la versión.
- **iXBRL es elección, no obligación** — y esto **cierra la pregunta abierta que X3 declaraba**. La obligación de entregar información financiera trimestral en XBRL alcanza a las emisoras desde el 1T2016 ([CNBV/BMV](https://www.bmv.com.mx/work/models/Grupo_BMV/Resource/1928/Presentacion_XBRL_Portal_10feb16_7.56.pdf)); la PyME no la tiene. Publicar en [iXBRL](https://www.xbrl.org/the-standard/what/ixbrl/) compra comparabilidad y nada más: decisión de producto.

Reg FD ([17 CFR 243.100](https://www.law.cornell.edu/cfr/text/17/243.100)) sigue sirviendo para una sola cosa, y hay que decirla bien: **no prohíbe la selectividad, prohíbe la selectividad sin rastro.** De ahí que el paquete a inversionistas siga siendo un data room con bitácora ([práctica Intralinks](https://www.intralinks.com/guides/leveraging-virtual-data-rooms): permisos «up to eight levels deep», marca de agua, bitácora inmutable de cada vista) — y de ahí también que **anónimo y nominal sean dos productos distintos**: `/public/v1` es anónimo por diseño ([`consulta-publica.ts:15-33`](https://github.com/sedecim-com/Accounting/blob/main/src/database/consulta-publica.ts), `SET LOCAL ROLE mnemosine_verifier` con SELECT enumerado); el paquete nominal no puede ser el mismo endpoint.

## Dimensiones y `fs_category`: dos correcciones

**Las columnas de dimensión no eran cuatro huérfanas: eran dos.** `posting.ts:169-182` inserta `cost_center_id` y `project_id` en cada línea posteada, y lo hace desde el 2026-08-31. Huérfanas de escritor son sólo `department_id` y `class_id`. Lo que sí es cierto y nadie había nombrado: **el camino de edición de borrador tira las dos que sí se escriben** — [`journal-entry-service.ts:741-748`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/journal-entry-service.ts) borra las líneas y las reinserta con siete columnas, sin `cost_center_id` ni `project_id`. Es la clase exacta de R4 —columnas para decir la verdad y un INSERT que la tiraba— viva en otro camino.

La regla de industria sigue en pie: la subcuenta responde «¿de quién es este saldo ante terceros?» (estructura estable); la dimensión responde «¿cómo lo rebano para adentro?» (analítica, privada siempre). Es el molde del **thin GL** de [Dynamics 365](https://learn.microsoft.com/en-us/dynamics365/finance/general-ledger/ledger-subledger) («main account + financial dimension values», transferencia al mayor «either in detail or summary») y de los [custom segments de NetSuite](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4732448748.html).

**`fs_category` dejó de ser cosmética: G1b la volvió portante.** Hoy clasifica el estado de flujos —`cash-flow-service.ts:407-426` decide financiamiento / inversión / capital de trabajo por `fs_category`, y una cuenta sin categoría cae en `sin_clasificar`— y `report-service.ts:471-484` (`buildBalanceSheetSection`) agrupa las secciones del **estado de situación financiera** por `fs_category || 'other'` — el expediente decía «estado de resultados»; la función es la del balance. El censo que esta página pedía sigue vigente y **ahora es urgente**: el CHECK sigue en clave anglosajona (`current_assets`, `cogs`…, `001:113-121`), la columna sigue NULLable, y **sigue sin haber coherencia padre-hijo** — ninguna migración de la 042 a la 060 la añadió. Falta el disparador (la lección de la 041: el disparador aguanta, el GRANT no).

## El tramo, renumerado: X0 antes que X1

**X0 — auditar o retirar `publishAggregates` (el peligro activo).** Nada de X1–X3 se sostiene sobre una publicación que ya sabe mentir. Es lo que `docs/BRECHAS-PARA-LA-PERFECCION.md` §8 pone entre las tres cosas que se harían si sólo se pudieran hacer tres.

**X1 — papel, con criterio de refutación (no toca esquema).** El corte por código agrupador y no por nivel; el mapeo y la consolidación de las dos columnas del agrupador; el versionado de lo publicado; el compromiso al conjunto vía `period_commitments`. Criterio de refutación escrito antes que el código: «existe una secuencia de asientos posteados y reversas tal que la balanza pública difiere al peso del rollup del detalle, o tal que dos lectores difieren entre sí». La primera pasada creía que ese contraejemplo no podía existir; **ya existe** (`report-service.ts:309-311`), así que la prueba nace con un caso conocido que tiene que atrapar.

**X2 — la superficie pública, corregida.** Vista derivada de `mv_trial_balance` cortada por agrupador, servida en `/public/v1` vía `consultaPublica`, con GRANT enumerado en migración. Hereda las dos negativas del router: sin bandera no existe; con bandera, se niega a servir agregados simulados. El agente puede proponer el corte y el mapeo; publicar dispone el humano, y ninguna herramienta del agente alcanza el mayor ni la vista (ver [[El-agente-y-sus-limites]]).

**X3 — el paquete a inversionistas.** Data room de un documento, con las notas del 172, la opinión del comisario, acceso nominal y bitácora. iXBRL opcional.

**Lo que además echaría de menos un despacho, y hoy no está en ningún diseño:** el **grupo** —un inversionista quiere las cifras del grupo, y nadie ha decidido la aritmética de dos balanzas públicas ni de lo intercompañía, que la 037 ya empezó a modelar—; la **moneda** —una cifra en MXN salida de un mayor con líneas en USD tiene que decir con qué tipo de cambio y a qué fecha, o el inversionista no puede reproducirla, y reproducirla es el punto entero (ver R4)—; y la **configuración duplicada** —`disclosure_config` contra el panel de políticas: dos superficies para la misma decisión es cómo esta casa se ha quemado antes; hay que elegir el panel, por su lector y su registro, y retirar la otra (ver [[El-tablero-y-los-criterios]])—.

## Lo que la industria y la norma confirman

| Fuente | Qué le toma mnemosine |
|---|---|
| [SAT · Anexo 24 RMF 2026](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo_24_RMF2026-13012026.pdf) | **La unidad de la transparencia**: balanza mensual a nivel cuenta y subcuenta de primer nivel, y la corrección por complementaria con fecha |
| [LGSM arts. 166, 172, 173, 176](https://www.diputados.gob.mx/LeyesBiblio/pdf/LGSM.pdf) | El marco real del reporte a socios: siete piezas, notas, comisario, quince días |
| [Banxico · NIFBdM B-1 ¶18](https://www.banxico.org.mx/marco-normativo/d/%7BBC29EC34-45EB-F249-C001-50E86A858F84%7D.pdf) | Qué se revela al corregir: efecto por renglón, declaración, importes antes y después |
| [CINIF · proyecto NIF B-1](https://www.cinif.org.mx/uploads/NIF_B-1_proyecto_auscultacion.pdf) | El aviso de vigencias: hay dos NIF B-1 y hay que decir cuál |
| [CNBV/BMV · XBRL](https://www.bmv.com.mx/work/models/Grupo_BMV/Resource/1928/Presentacion_XBRL_Portal_10feb16_7.56.pdf) | Cierra la pregunta de X3: la obligación existe y no alcanza a la PyME |
| [Modern Treasury Ledgers](https://docs.moderntreasury.com/docs/ledgers-guarantees) | Gemelo de la 041 — con el matiz nuevo: un posteado tampoco se archiva |
| [TigerBeetle](https://docs.tigerbeetle.com/concepts/debit-credit/) | «Transfers are always immutable»: corregir = asiento nuevo, patrón de industria |
| [Dynamics 365 ledger-subledger](https://learn.microsoft.com/en-us/dynamics365/finance/general-ledger/ledger-subledger) · [NetSuite segments](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4732448748.html) | El molde del thin GL y el destino correcto de las columnas de dimensión |
| [REA](https://en.wikipedia.org/wiki/Resources,_Events,_Agents) · [event sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) | «La agregación se deriva, no se persiste» — necesario, no suficiente |
| [Triple entrada (Grigg)](https://iang.org/papers/triple_entry.html) | El recibo firmado sustituye al anclaje simulado; cero blockchain |
| [Reg FD](https://www.law.cornell.edu/cfr/text/17/243.100) · [data rooms](https://www.intralinks.com/guides/leveraging-virtual-data-rooms) | Selectividad con rastro; la forma del acceso nominal |
| [Continuous accounting](https://www.blackline.com/ebooks/continuous-accounting/) | El relato comercial que la lente habilitaría — decorativo, no sostiene ninguna decisión |

## Lo que esta página decía ayer y hoy se corrige

Se dice en vez de reescribirse en silencio, porque alguien la leyó ayer.

1. **«Nada de esto existe ni se construirá antes de G1.»** Existe: `published_aggregates`, `disclosure_config`, el endpoint y el lector público llevan meses en el árbol. Y G1a/G1b cerraron el trabajo de código; la compuerta G1 de `completion-plan.md:62` sigue abierta, pero es un hito de **operación** (cargar el histórico de un cliente real y cuadrar al peso), no de commit. Ya no impide diseñar y probar.
2. **«Es imposible descuadrar la vista respecto al detalle por construcción.»** Falso. `report-service.ts:309-311` filtra donde el CLI promete agregar.
3. **«Nada declara hoy hasta qué nivel es público.»** Falso: `disclosure_config.category_disclosure` lo declara por categoría con omisión razonable. El problema no es que falte, es que **nadie la lee**.
4. **«El corte público es criterio del despacho ⇒ política nueva del panel.»** Superado: el corte lo fija el Anexo 24 en el código agrupador, y ya hay compuerta de cobertura en el binario.
5. **«El mayor es físicamente inmutable.»** La 058 corrige a la 041: hay interruptores. La palabra correcta ante un inversionista es *tamper-evident*.
6. **«Las cuatro columnas de dimensión son huérfanas, sin escritor ni lector.»** Eran dos: `posting.ts:169-182` escribe `cost_center_id` y `project_id`. Y la edición de borrador las tira.
7. **«Falta el mapeo `fs_category`→NIF.»** El mapeo que manda en México ya tiene columna —dos— y lo que falta es elegir una, borrar la otra y sembrar `c_CodAgrup`.
8. **«La taxonomía iXBRL mexicana queda como pregunta abierta.»** Cerrada: obligación CNBV para emisoras desde 1T2016; la PyME no la tiene.

## Páginas relacionadas

- [[Onboarding-de-contabilidad]] — la otra página que arrastra la consolidación de las dos columnas del agrupador.
- [[El-tablero-y-los-criterios]] — el panel de políticas, y por qué la configuración de divulgación debería vivir ahí y no en `disclosure_config`.
- [[Arquitectura]], [[Aislamiento-multi-inquilino]] — el mayor sellado y la RLS sobre los que este corte se apoya.
- [[El-agente-y-sus-limites]] — el agente propone el corte y el mapeo; publicar dispone el humano.
- [[Hoja-de-ruta]] — dónde vive la compuerta G1 y qué sigue esperando detrás de ella.
