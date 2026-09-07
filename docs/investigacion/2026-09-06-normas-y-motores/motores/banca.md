# Motores del subsistema banca (`src/services/banking/`)

> **Método.** Escribió el inventario un lector de código (2026-09-06, rama `investigacion/normas-y-motores`: los 22 archivos de `src/services/banking/` —12 servicios y 10 lectores en `parsers/`—, la puerta CLI `src/cli/bank-command.ts`, la REST `src/api/rest/routes/bank-reconciliation.ts`, el manual del agente `src/ai/docs/banking.md`, las migraciones 003/051/052/054/055 y el panel de políticas) y lo verificó un escéptico independiente con la instrucción de refutar, que abrió cada `archivo:línea`, buscó cada «ausente» y cada «sin puerta» por `grep` sobre todo `src/` (no sólo el subsistema) y contrastó cada «quemado» con las 39 claves del panel (`src/services/policy/pending-catalog.ts`) y con `tax_tables` (migraciones 008/009). Ninguno ejecutó nada; esta fusión —cada reclamo como el escéptico lo dejó, más sus hallazgos— se escribió contra HEAD `4b1d8fe`.

**Resultado.** Los 15 reclamos del original se confirmaron; ninguno fue refutado de fondo. Siete citas o formulaciones se corrigieron (§6) y el escéptico añadió hallazgos que aquí van integrados en su motor. Recuento con el vocabulario de la casa: **7 motores completos** (M2, M3, M6, M7, M8, M9, M10), **8 parciales** (M1, M4, M5, M11, M12, M13, M14, M15), **2 sub-motores inertes** (la retención de intereses por importes y el IVA de comisiones en modo `sin-iva`/`importes`: escritos en el servicio, sin puerta), **17 motores ausentes** (§3–§4, marcados A1…A17 para no contarlos dos veces cuando ambas jurisdicciones los exigen).

**Vocabulario.** Estado: `completo` (existe, tiene puerta y hace lo que dice) · `parcial` (existe con huecos nombrados) · `inerte` (motor sin puerta, o con puerta que no escribe) · `ausente` (no hay motor bajo ningún nombre; se buscó por `grep`). Parámetro: `ley` (debería estar en tabla con vigencia) · `panel` (criterio del despacho en `pending-catalog.ts`) · `casa` (constante del motor, legítima) · `quemado` (ley o criterio escrito en código, que es lo que hay que mover).

**Convención de citas.** Dentro de cada motor, un nombre corto (`matching.ts:90`) es un archivo de `src/services/banking/` (los lectores, de `src/services/banking/parsers/`). `bank-command.ts` es `src/cli/bank-command.ts`; `bank-reconciliation.ts` es `src/api/rest/routes/bank-reconciliation.ts`; `floor.ts` es `src/ai/floor.ts`; `pending-catalog.ts` es `src/services/policy/pending-catalog.ts`; `iva-cash-basis.ts`, `pais-contable.ts`, `moneda-origen.ts` y `ar-ap-posting.ts` son de `src/services/accounting/`. Las migraciones viven en `src/database/migrations/NNN_*.sql` y se citan por número (051 = `051_la_cuenta_y_el_extracto.sql`, 052 = `052_el_cotejo.sql`, 054 = `054_la_sesion_que_cuadra.sql`, 055 = `055_la_firma_y_el_sello.sql`; la 053 es `053_la_nomina_deja_de_cargarse_a_devoluciones.sql` y **no toca banca**).

---

## 0. Cómo ve la jurisdicción este subsistema

No la ve. Es el hallazgo transversal, confirmado por el escéptico con el `grep` ampliado:

- `grep -rnE "esContabilidadMexicana|pais-contable|incorporation_country|accounting_standard"` sobre `src/services/banking/` y `src/cli/bank-command.ts` devuelve **cero**. Ningún motor bancario consulta `src/services/accounting/pais-contable.ts`.
- La **única** bifurcación por país es indirecta: el cobro de cheque llama a `entityUsesCashBasisIva` (`treasury-posting.ts:1459-1462`), que decide `incorporation_country === 'MX' || accounting_standard === 'mx_nif'` (`iva-cash-basis.ts:300-311`). Es un segundo conmutador, paralelo al de `pais-contable.ts`, y **sus reglas no coinciden en el caso nulo**: `esContabilidadMexicana` (`pais-contable.ts:35-43`) trata país nulo o vacío como México; `entityUsesCashBasisIva` devuelve `false` para una entidad sin país y sin `mx_nif`. Una entidad sin país declarado es mexicana para el núcleo contable y **no** lo es para banca. (El original decía «la misma regla nulo = México en espíritu»; el escéptico lo corrigió: son reglas distintas.)
- Las cuatro claves del panel que lee el subsistema (`cotejo_umbral_confianza`, `cotejo_monto_maximo_auto`, `conciliacion_tolerancia`, `linea_banco_sin_partida_al_cierre`; `matching.ts:586-588`, `reconciliation-service.ts:894-897`) más `segregacion_de_funciones` (`reconciliation-service.ts:2332-2336`) no tienen dimensión de jurisdicción (`pending-catalog.ts:943-1046`). Y dos de ellas ni siquiera llegan a la CLI de cotejo: `cotejo_umbral_confianza` y `cotejo_monto_maximo_auto` se leen sólo en `matching.ts:587-588` (la ruta REST `auto-match`); `match-service.ts` —lo que hay detrás de `bank match preview|run`— no contiene `getPolicy` (grep vacío) y usa sus propios 0.85 y 50 000 (`match-service.ts:997`, `:1003-1004`; la CLI le pasa `opts.minConfidence`/`opts.maxAmount` crudos, `bank-command.ts:3184-3185`). Ver M7.
- Los dos pisos irrompibles no tienen jurisdicción ni conversión: `FLOOR_MAX_AUTO_POST = 50000` está expresado «in the entity's functional currency» (`floor.ts:36-39`); `FLOOR_MAX_TOLERANCIA_CONCILIACION = '500.0000'` está expresado, a propósito, «en la moneda de la cuenta que se concilia» (`floor.ts:108-114`). 500 MXN y 500 USD son tolerancias distintas por un orden de magnitud; el piso no distingue. (El original atribuía «moneda funcional» a los dos; el escéptico corrigió el segundo.)
- El vocabulario fiscal del subsistema es mexicano y no tiene equivalente US: roles `iva_pendiente_acreditar`, `iva_acreditable`, `isr_retenido_a_favor` (`treasury-posting.ts:885-891`, `:1165-1170`, `:1480-1485`), tipos de ajuste `iva-comision`/`isr-retenido` (`reconciliation-adjustments.ts:53`), bandera obligatoria `--iva-rate` (`bank-command.ts:5252-5257`). Los lectores asumen la convención de fecha DD/MM «de México» cuando el formato es ambiguo (`parsers/fecha.ts:148-158`) y los cuatro perfiles CSV llevan `pais: 'MX'` (`parsers/perfiles-csv.ts:55`, `:92`, `:132`, `:176`).

---

## 1. Motores

### M1 · Lectura de estados de cuenta (`parsers/`)

**Estado: parcial.** Archivo principal: `parsers/index.ts:98-120` (`leerExtracto`), olfateo `:164-173`. Jurisdicciones: MX (perfiles CSV) + formatos internacionales (MT940, camt.053). Ningún formato nativo de la banca estadounidense.

Reglas implementadas:
- Catálogo de 9 formatos, **3 con lector** (`csv`, `camt053`, `mt940`) y 6 «pendientes» (`ofx`, `qfx`, `mt942`, `camt054`, `bai2`, `xlsx`): `index.ts:37-83`; `ofx`/`qfx` `estado: 'pendiente'` (`:53-62`), `bai2` (`:74-78`); `LEIBLES = {csv, camt053, mt940}` (`:85`); `switch` de tres casos (`:98-120`). El CHECK de la tabla admite los diez (`src/database/enums.ts:114-116`; 051 `:139`).
- Olfateo por contenido (XML → camt053; `:20|:25|:28C|:60F|:61` → mt940; resto → csv): `index.ts:169-171`.
- **CSV con perfiles declarativos** (`csv.ts:69-166`): detección por especificidad —todas las columnas requeridas presentes; empate = rechazo— (`:181-223`); tokenizador RFC 4180 propio (`:582-656`); derivación de saldo inicial/final desde el saldo corrido, siempre con aviso (`:515-565`); membrete (cuenta, moneda, nº de estado) por regex (`:473-500`). Perfiles (`perfiles-csv.ts:197-202`): `bbva-mx` (`:50-75`), `banorte-mx` (`:87-112`), `santander-mx` (`:127-156`), `generico` (`:172-194`). **Los tres de banco están marcados `confianza: 'conjetura'`** —construidos sin archivo real— (`:8-22`, `:53`, `:90`, `:130`); no hay fixture `*bbva*|*banorte*|*santander*` bajo `tests/`.
- **MT940** (`mt940.ts:47-111`): saldos `:60F:/:62F:` con `M` intermedio avisado (`:150-198`); `:61:` con marcas `C/D/RC/RD` —reverso invierte sentido— (`:236-313`); continuaciones `:86:` (`:120-144`); año deducido del MMDD con salto de año (`fecha.ts:80-96`).
- **camt.053** (`camt053.ts:47-170`): rechaza camt.052/054 por namespace (`:64-79`); valida XML (`:85-88`); `parseTagValue:false` para que el dinero no pase por float (`:97`); saldos OPBD/PRCD/OPAV y CLBD/CLAV/ITBD (`:44-45`, `:172-248`); excluye `Sts≠BOOK` (`:277-285`); lotes `TxDtls>1` avisados (`:313-323`).
- **Importe** (`importe.ts:53-148`): sin `parseFloat`; paréntesis negativo, signo al final, `DR/CR`, decisión de separadores con validación de grupos de miles (`:243-305`); tope `1e15` (`:41`); 4 decimales (`:48`).
- **Fecha** (`fecha.ts:42-70`): formato declarado por perfil; `auto` con desambiguación y aviso. **Codificación** (`texto.ts:28-86`): BOM, UTF-16 LE/BE, `auto` UTF-8→Latin-1.

Reglas por definir:
- **US:** lectores **OFX/QFX** (OFX Specification 2.x; lo que exportan los bancos minoristas y Quicken) y **BAI2** (BAI Cash Management Balance Reporting; tesorería corporativa). No hay lector bajo otro nombre: `grep -rniEl '\bofx\b|\bqfx\b|\bbai2\b' src` sólo da la lista del CHECK (`enums.ts:114-116`, 051 `:139`), un comentario (`bank-command.ts:172`), `src/ai/docs/cli-reference.md` y el propio `index.ts`; `package.json` no trae `ofx`, `xlsx`, `exceljs`, `pdfkit` ni `puppeteer`. Perfil CSV nativo de algún banco US: ninguno. Matiz del escéptico: el perfil `generico` (`perfiles-csv.ts:172-194`) es formato propio de mnemosine y sirve para cualquier país si el usuario reexporta; lo ausente es el perfil nativo.
- **MX:** verificación de los tres perfiles contra archivo real (el código mismo lo exige, `perfiles-csv.ts:24-35`). La herramienta que lo haría, `bank format create|test`, **no existe**: `grep -rnE "command\(['\"](format|formato)" src/cli/` → cero. Quien la da por existente es el **código, en comentarios y mensajes** (`perfiles-csv.ts:32-35`, `:57`, `:162`; `csv.ts:209` —mensaje al usuario: «crea el que falta con `bank format create --file <muestra>`»—; `tipos.ts:97`, `:166`); el catálogo la marca **❌ fase 2** (`docs/cli-command-catalog.md:1170-1176`). (El original decía «que el propio código promete»; corregido: el código remite a comandos que el catálogo tiene en fase 2.)
- **Ambas:** `mt942`/`camt054` (intradía/notificación) sin lector; `xlsx` sin dependencia.
- **Ambas:** el catálogo promete para tarjetas «separar importe en moneda original, cargo en moneda local y diferencial cambiario del emisor» (`docs/cli-command-catalog.md:1161`): `ExtractoLeido` (`tipos.ts:66-87`) y `LineaLeida` (`tipos.ts:30-60`: `fecha, fechaValor?, importe, descripcion, referencia?, tipo?, crudo`) no tienen campo de moneda original ni de diferencial.

Parámetros:
- **quemado** — fecha ambigua en `auto` leída **DD/MM «convención de México»** (`fecha.ts:148-158`): un CSV estadounidense sin perfil se leería con día y mes invertidos. Monedas toleradas `mxn|mxp|usd|eur|cad|m\.n\.|mn|pesos?` (`importe.ts:51`). Nombres de mes sólo es/en (`fecha.ts:19-32`). Perfiles de banco en código con `pais: 'MX'` fijo, no en una tabla por jurisdicción/banco.
- **casa** — `BISAGRA_SIGLO = 69` (`fecha.ts:40`); tope de avisos `crearAvisos(max = 200)` (`avisos.ts:23`); tope `1e15` y 4 decimales (`importe.ts:41`, `:48`).

Puerta: `bank statement import` (`bank-command.ts:2519-2540`: `--format`, `--profile`, `--dir`, `--closing-balance`, `--dry-run`); `bank reconciliation run --file` (`reconciliation-service.ts:1766-1788`). La REST **no** usa estos lectores. Pruebas: `tests/services/banking/parsers/{csv,mt940,camt053}.spec.ts`.

---

### M2 · Importación del estado de cuenta como documento

**Estado: completo** para los tres formatos que se leen. Archivo: `bank-statement-service.ts:489-670` (`importarEstadoDeCuenta`). Jurisdicción: neutral. Lo que le pide la norma mexicana (conservar el documento) es un motor ausente (A9), no un hueco de éste.

Reglas implementadas:
- sha256 sobre los **bytes originales** antes de parsear (`:493-497`); dedupe de documento `UNIQUE(bank_account_id, file_sha256)` con mensaje que dice cuándo entró (`:511-524`, `:663-667`).
- Dedupe de línea por `content_hash` del disparador de la 051 + id nativo, `ON CONFLICT DO NOTHING` sin blanco (`:723-737`); sólo se promueven a `bank_transaction_id` las referencias que aparecen **una** vez en el archivo (`referenciasPromovibles`, `:322-331`).
- Normalización (`normalizarExtracto`, `:364-479`): periodo deducido de las líneas si falta; saldo inicial = del archivo → del estado anterior → final − Σ; `--closing-balance` contrastado y `ConflictError` si contradice al archivo (`:408-417`); moneda de la cuenta si el archivo no la trae (`:457-460`); aviso para caja chica (`:461-465`).
- Tipo de movimiento: respeta el del banco sólo si es uno de los cinco del CHECK 003 (`debit|credit|fee|interest|adjustment`, 003 `:50-51`); si no, lo deriva del signo (`tipoDeMovimiento`, `:333-339`).
- Las siete pruebas corren **antes** de escribir; sólo `identidad` y `moneda` abortan (`:574-583`). Auditoría en `audit_log` con `dry_run` (`:608-626`).

Reglas por definir:
- **MX (CFF art. 28 fr. I y IV; RCFF art. 33 apartado B fr. III; conservación CFF art. 30, cinco años):** `bank_statements` guarda `file_name TEXT` y `file_sha256 CHAR(64)` (051 `:122-160`; INSERT `:585-596`) pero **no los bytes**: sin `BYTEA` en la tabla, `grep "ALTER TABLE bank_statements" src/database/migrations/` → cero (ninguna migración posterior los añadió; los únicos `BYTEA` del esquema son de la 006, blockchain). `tipos.ts:7-9` habla de «releerse meses después desde los bytes archivados cuando `bank statement apply` reaplique otra versión del perfil», y `bank statement apply` es ❌ fase 2 (`docs/cli-command-catalog.md:1167`). Matiz del escéptico: `bank_transactions.raw_data` **sí** conserva la fila parseada de cada línea (`bank-statement-service.ts:319`, INSERT `:730`); es conservación del contenido tabular, no del documento, y no basta para el CFF 28/30 porque no reproduce el archivo ni su hash.
- **Ambas:** no hay reglas de clasificación de movimientos (comisión/interés) más allá del `tipo` que traiga el archivo; `treasury-posting.ts:774-779` lo reconoce literalmente: «no existe una tabla de reglas de banco; `processing_rules` (005) es de la ingesta de CFDI».
- **Ambas:** la ruta REST de importación (§5.2) no crea documento, no corre las siete pruebas y pone `'debit'` a todo; convive con este motor sin compartir sus invariantes.

Parámetros — **casa**, operativos, no de jurisdicción: `LOTE_LINEAS = 200` (`:84`), `MAX_ESTADOS = 200` (`:87`), `MAX_LINEAS_CHECK = 50_000` (`:95`).

Puerta: `bank statement import|list|show` (`bank-command.ts:2519-2822`).

---

### M3 · Las siete pruebas de integridad del extracto

**Estado: completo.** Archivo: `statement-checks.ts:50-58` (`STATEMENT_CHECK_NAMES`), `:559-570` (runners). Jurisdicción: neutral.

Reglas implementadas:
- `cadena-de-saldos` inicial + Σ = final, con aviso si faltan líneas por dedupe (`:212-249`); `continuidad` inicial = final del anterior (`:284-305`); `huecos-y-traslapes` marca de agua sobre todos los anteriores (`:307-350`).
- `identidad`: huella sha256 del identificador normalizado (CLABE/IBAN/nº de cuenta, ≥ 8 caracteres, `if (limpio.length < 8) return null` `:197`; `:194-199`) o últimos 4 (`:352-413`); nunca viaja el identificador en claro (`:415-419`).
- `moneda` (`:421-435`); `secuencia` con prefijo de serie (`:437-491`); `reversos` pares opuestos en ventana (`:493-552`), la única que nunca bloquea.
- `bank statement check` sale 4 con un bloqueante (`bank-command.ts:2826`).

Reglas por definir: ninguna norma exige más. La identidad para cuentas US funciona vía `account_number_encrypted` (`bank-statement-service.ts:255-274`).

Parámetros — **casa**: `DIAS_REVERSO = 5` (`:135`), `MAX_REVERSOS = 50` (`:142`), huella mínima `8` (`:197`). La ventana de reversos tiene opción `diasReverso` en el servicio (`bank-statement-service.ts:138`, `:571`, `:1023`, `:1195`) y **ninguna bandera CLI** (`grep -rn "diasReverso\|dias-reverso\|reverso" src/cli/*.ts` → cero): parámetro escrito y sin puerta.

Puerta: `bank statement check [id] --check a,b -a --account --since` (`bank-command.ts:2823-2835`).

---

### M4 · Cuenta bancaria como dato maestro (identificadores y mapeo 1:1)

**Estado: parcial.** Archivo: `bank-account-service.ts`. Jurisdicciones: MX y US, con huecos en US.

Reglas implementadas:
- **CLABE** (Banxico/ABM, 18 dígitos, ponderación 3-7-1 con `mod 10` por término): `digitoVerificadorClabe` `:79-93`, `clabeValida` `:96-99`, `exigirClabe` `:128-152`; clave de banco = 3 primeros dígitos, rechaza `000` (`:144-150`).
- **c_Banco del SAT**: 3 dígitos por forma (`exigirClaveSat` sólo `/^\d{3}$/`, `:800-809`); si viene con CLABE tienen que coincidir (`:893-903`); sin clave → advertencia «el Anexo 24 la exige dentro de la póliza» (`:905-910`).
- **Routing ABA** (US, 9 dígitos, checksum 3-7-1 múltiplo de 10): `routingAbaValido` `:110-117`, `exigirRoutingAba` `:162-184`; rechaza `000000000`.
- **SWIFT/BIC** (ISO 9362) por forma (`exigirSwift` `:819-828`); **IBAN** por forma (`exigirIban` regex `^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$`, `:830-839`).
- Mapeo 1:1 a cuenta de mayor: activa, de movimiento, tipo `asset` (o `liability` para `credit-card`), misma moneda (`exigirCuentaDeMayor` `:520-591`); `uq_bank_accounts_gl` traducido a frase (`:628-654`); remapeo con historia exige `--force` + motivo (`:1299-1325`).
- Identificadores cifrados, sólo últimos 4 en toda proyección (`:265-312`); cambio de identificador exige `reason` (`:1137-1144`).

Reglas por definir / huecos (todos confirmados con `grep` ampliado):
- **US:** `routing_number_encrypted` es **una sola columna** para ACH y wire (`resolverRouting` `:855-870`; migración 003): si difieren, se rechaza el alta; `grep routing_wire|routing_ach src/database/migrations/` → cero. No se valida el prefijo de distrito de la Reserva Federal (00-12, 21-32, 61-72, 80) —decisión explícita (`:154-161`)— ni se consulta FedACH (`grep -rni fedach src` → cero).
- **Ambas:** IBAN **sin mod-97 (ISO 7064)**: sólo regex; `grep -rniE "mod.?97|iso.?7064" src` → cero.
- **MX:** el c_Banco no se contrasta contra catálogo: `grep -rniE "c_banco|cat_banco|sat_bank|bank_catalog" src` → sólo el comentario 051 `:96` y las opciones CLI `bank-command.ts:2125`, `:2323`. No hay tabla ni constante. El catálogo de comandos tiene `bank institution sync` en fase 3 (`docs/cli-command-catalog.md:1155`).
- **Ambas:** `bank account archive`, nombrado como el camino para `is_active` (`:990-992`), **no existe**: `grep "command('archive'" bank-command.ts` → cero; ningún `UPDATE … is_active =` en el servicio (el único `is_active =` es un `WHERE`, `:715`); el `--status active|archived` de `bank-command.ts:428-440` es filtro de `list`, no un setter.
- **Ambas:** la «segunda aprobación de otro usuario» para cambiar CLABE/routing no existe; el código lo advierte (`:1145-1152`).

Parámetros — **casa**: algoritmos de dígito verificador CLABE/ABA y regex SWIFT/IBAN (estables, sin vigencia). **ley sin tabla**: catálogo c_Banco (el SAT lo publica y cambia; hoy sólo forma).

Puerta: `bank account create|list|show|edit|set` (`bank-command.ts:2093-2457`).

---

### M5 · Movimientos y partidas de libros (lectores + sello)

**Estado: parcial.** Archivos: `transactions.ts`, `book-items.ts`. Jurisdicción: neutral, con vocabulario MX pendiente.

Reglas implementadas:
- `listarMovimientos` con filtros, dirección por signo, `amt:` con comparador, paginación estable (`transactions.ts:204-253`); ficha con cotejos vivos (`unapplied_at IS NULL`) y `raw_data` sólo con `--raw` (`:290-362`).
- `listarPartidasDeLibros`: líneas posteadas contra la cuenta de mayor del banco, `is_reconciled = false`, antigüedad, frontera en los dos extremos del JOIN (`book-items.ts:87-161`).
- Sello de tres columnas (`is_reconciled`, `reconciled_at`, `reconciliation_id`) juntas o vacías —CHECK `jel_sello_coherente` de la 052— (`sellarPartidas` `:173-224`, `liberarPartidas` `:233-274`).

Reglas por definir:
- **MX (SPEI / Anexo 24, CFF 28 fr. IV):** `CAMPOS_SIN_EXTRACTOR = ['clave-de-rastreo','clabe-de-la-contraparte','rfc-de-la-contraparte','numero-de-cheque']` (`transactions.ts:106-111`, comentario «NADIE extrae todavía» `:97-105`). El Anexo 24 pide en la póliza de transferencia/cheque banco, cuenta origen/destino, RFC del beneficiario y, en cheque, número y banco. `grep -rniE "clave.?de.?rastreo|trace.?number|check_number|numero.?de.?cheque" src` → `src/types/index.ts:480`, `bank-command.ts`, `treasury-posting.ts`, `transactions.ts`: ningún extractor sobre `raw_data`. **`bank_transactions` no tiene columna** para nada de eso (`grep check_number|tracking_key|clave_rastreo src/database/migrations/` → sólo `vendor_payments.check_number` 002 `:124`, `customer_payments` 002 `:288`, nómina 008 `:205`).
- **US:** no hay extractor de *trace number* ACH ni de número de cheque del lado del banco.
- Matiz del escéptico: el **número de cheque emitido** sí es dato maestro del pago (`vendor_payments.check_number`) y `conciliarCheque` lo lee (`treasury-posting.ts:1387`, `:1496`, `:1574`). Lo que falta es el extractor del lado del **banco** (leer el folio en el movimiento del extracto) y la columna que lo reciba; «sin número de cheque en el movimiento» no significa «el sistema no sabe qué cheque emitió».

Parámetros: ninguno de jurisdicción.

Puerta: `bank transaction list|show` (`bank-command.ts:2915-3070`), `bank book-item list` (`:3071-3130`).

---

### M6 · Motor de cotejo (reglas de emparejamiento)

**Estado: completo** como heurística. Archivo: `matching.ts`. Jurisdicción: neutral, con sesgo lingüístico inglés.

Reglas implementadas (`MATCH_RULES` `:341-346`):
1. Importe exacto + misma fecha, candidato único → 1.00, auto-aplicable (`:138-165`).
2. Importe exacto ± 3 días (`threeDays` `:174`) → 0.90, auto-aplicable (`:168-196`).
3. Descripción difusa (Levenshtein 0.4 + Jaccard 0.6, `:113-131`) con banda de importe 5 % (`times(0.05)` `:204`), umbral 0.70 y ganador > 0.85 (`:233-236`); auto-aplicable **sólo** si el importe es exacto y único (`:242-260`).
4. Puntaje ponderado .45/.25/.30 (`:306`), `UMBRAL_PONDERADO = 0.75` (`:268`), `MARGEN_DESEMPATE = 0.05` (`:275`); **nunca** auto-aplicable (`:331-336`).
- Candidatos en banda ±10 % (`0.90/1.10`, `:373-374`): facturas y gastos por **saldo** (`amount_due`), líneas de la cuenta de mayor del banco (`:411-460`).
- Compuertas: `getPolicy(…, 'cotejo_umbral_confianza')` y `'cotejo_monto_maximo_auto'` (`:587-588`), techo apretado por `floorMaxAutoAmount` (`:514-518`; panel `pending-catalog.ts:996-1046`). Escritura transaccional del auto-match (`:613-638`).

Reglas por definir: ninguna norma; es práctica de despacho.

Parámetros:
- **panel** — `cotejo_umbral_confianza`, `cotejo_monto_maximo_auto` (leídas aquí y **sólo aquí**: ver M7).
- **quemado** (criterio de despacho en código) — ventana 3 días (`:174`), banda 5 % (`:204`), banda de candidatos 10 % (`:373-374`), pesos .45/.25/.30 y umbrales 0.75/0.05/0.70/0.85 (`:268`, `:275`, `:306`, `:233-236`); **stopwords sólo en inglés** (`:95-99`) y `normalizeDescription` con `replace(/[^a-z0-9\s]/g, '')` (`:90-92`): «depósito», «comisión», «transferencia» pierden acentos y ñ y no se filtran como ruido. `FLOOR_MAX_AUTO_POST = 50000` «in the entity's functional currency» (`floor.ts:36-39`), sin jurisdicción. REST `suggestions` con `times(0.01)` (`bank-reconciliation.ts:166`).

Puerta: REST `POST …/:account_id/auto-match` (`bank-reconciliation.ts:320-329`) → `autoMatchUnreconciled`; la CLI **no** pasa por aquí para sus compuertas (M7).

---

### M7 · El cotejo como hecho (grupos N:M, Σ, sello, desaplicación)

**Estado: completo.** Archivo: `match-service.ts`. Jurisdicción: neutral.

Reglas implementadas:
- Invariante **Σbanco = Σlibros + Σajustes + residual** antes de escribir (`cuadrarGrupo` `:196-213`, `exigirCuadre` `:240-288`; residual `keep|write-off` con cuenta obligatoria).
- Signo por tipo de candidato (`signoDe` `:180-182`); dirección opuesta rechazada (`:1509-1519`).
- Reparto N:M voraz y en orden, `is_partial` (`asignarGrupo` `:330-370`); ningún lado huérfano (`:1522-1553`).
- Señales de la pareja (`medirSenales` `:423-451`, `VENTANA_DIAS = 3` `:114`) y compuertas de aplicación en un solo sitio (`compuertaDeAplicacion` `:990-1031`): confianza, piso de monto, periodo `open` para el automático / no `hard_close|locked` para el humano (`periodoAdmite` `:638-642`), misma dirección, importe exacto, veto `solo-similitud` (fila 1225 del catálogo), ventana.
- `run` propone fuera y aplica dentro de la transacción revalidando bajo candado (`:1103-1130`, `:1223-1369`); `apply` idempotente (`:1147-1211`); `create` N:M (`:1419-1630`); `unapply` clausura sin borrar, arrastra el grupo, libera sello, rehúsa sesión `approved|posted` (`:1666-1792`), motivos tipificados (`:72-80`).

Reglas por definir:
- **Ambas:** `bank match approve --force`, nombrado en `:1145`, **no existe**: los subcomandos de `match` son `preview, run, apply, create, unapply` (`bank-command.ts:3131-3599`); el único `.command('approve')` (`:4784`) cuelga de `reconciliation`.

Parámetros:
- **quemado** — `CONFIANZA_POR_OMISION = 0.85` (`:117`). El original decía que «duplica el defecto del panel»; el escéptico lo corrigió y lo agrava: **`match-service.ts` no lee el panel** (`grep -nE "getPolicy|policy" match-service.ts` → cero). `compuertaDeAplicacion` usa `opts.minConfianza ?? CONFIANZA_POR_OMISION` (`:997`) y `floorMaxAutoAmount(opts.maxMonto ?? FLOOR_MAX_AUTO_POST)` (`:1003-1004`); la CLI le pasa `opts.minConfidence`/`opts.maxAmount` crudos (`bank-command.ts:3184-3185`). Una política decidida en el panel (`cotejo_umbral_confianza`, `cotejo_monto_maximo_auto`) **no llega a `bank match preview|run`**: la CLI de cotejo tiene su propio 0.85 y su propio 50 000.
- **casa** — `LIMITE_PROPUESTAS = 500` (`:127`), `VENTANA_DIAS = 3` (`:114`).

Puerta: `bank match preview|run|apply|create|unapply` (`bank-command.ts:3131-3599`). Pruebas: `tests/integration/f05b-cotejo-adversarial.int.spec.ts`.

---

### M8 · Sesión de conciliación (abrir, estado, cerrar, aprobar, contabilizar, pase guiado)

**Estado: completo**, con una política del panel declarada sin motor (A14). Archivo: `reconciliation-service.ts`. Jurisdicción: neutral.

Reglas implementadas:
- `abrirSesion` (`:435-634`): exige extracto importado (`:508-515`), extractos contiguos (`:516-526`), moneda (`:530-535`), `--closing-balance` contrastado (`:540-549`), **continuidad de saldo** con la sesión anterior (`:551-559`) y **sin hueco de fechas** (`:560-567`), sin traslape (`:467-484`); `beginning_balance` sale del extracto y la sesión queda atada por `statement_id` (`:576-586`).
- Marco de signos: tarjeta de crédito negada al marco del mayor (`enMarcoDelMayor` `:307-310`).
- `estadoDeSesion`/`leerEstado` (`:1047-1173`): saldo del banco **vivo desde el extracto** con detección de deriva (`:1090-1105`); saldo de libros acumulado hasta el cierre, `null` si el mayor es de otra entidad (`saldoDeLibros` `:834-857`); movimientos sin explicar por cotejo vivo, no por `is_matched` (`:778-815`).
- `criteriosDeCierre` (`:889-950`): lee `conciliacion_tolerancia` y `linea_banco_sin_partida_al_cierre` (`:894-897`); `--tolerance` sólo con `tolerancia_con_residual`, acotada por `floorTolerancia` y rechazada si excede (`:900-944`).
- `reparosQueBloquean` (`:1187-1237`): la política sólo indulta `linea-de-banco-sin-explicar` para que se arrastre como partida; la rama `'suspenso'` hace `bloqueantes.push(…)` «exige CONTABILIZAR, que es F05d» (`:1215-1225`); la deriva del extracto bloquea siempre.
- `cerrarSesion` (`:1471-1621`): `arithmetic_computed_at` y `status='balanced'` en la misma sentencia (CHECK `sesion_balanceada_con_aritmetica`, **054 `:39`**), congela los seis escalares **firmados** y persiste `closing_tolerance` (`:1537-1576`, `congelar` `:1648-1665`).
- `correrConciliacion` (`:1744-1954`): pase `extracto → cotejo → sesion → partidas → estado`, `--resume`, `detenidaAntesDeAprobar: true` siempre (`:1931-1953`).
- `aprobarSesion` (`:2305-2519`): sólo desde `balanced`; segregación por `segregacion_de_funciones` (`exigir|alertar`, `:2331-2363`); recalcula con la tolerancia **del cierre** (`:2378-2390`) y exige reproducir `variance` (`:2402-2418`); instantánea determinista + sha256 (`serializacionCanonica` `:2154-2183`, `hashDeInstantanea` `:2186-2188`) en `approval_snapshot/approval_hash` (055).
- `contabilizarSesion` (`:2666-3166`): sólo desde `approved`, todo en una transacción; idempotente por sesión/ajuste/borrador; adopta asientos ya aprobados por `mnemosine review`; postea con `source_type='bank_reconciliation'` (`:2844-2862`); sella las líneas de banco de esos asientos bajo un grupo con Σ (`:2946-3008`); escribe el cotejo que cierra el círculo (`:3025-3067`); resuelve las partidas explicadas (`:3083-3095`).

Reglas por definir:
- **Ambas — política `suspenso`** (`pending-catalog.ts:969-996`, opción en `:980`): declarada en el panel y **sin motor** que postee a cuenta puente (`:1215-1225`). Elegirla hoy bloquea el cierre.
- **Ambas:** la ruta REST sigue abriendo sesiones sin extracto (§5.2) y `GET /reconciliations/:id` devuelve `variance` de columna (`bank-reconciliation.ts:296-300`).
- **Ambas:** `bank reconciliation generate --format pdf|xlsx`, prometido por el catálogo, se rechaza (`bank-command.ts:5106-5121`); no hay dependencia PDF/XLSX en `package.json`.

Parámetros:
- **panel** — `conciliacion_tolerancia`, `linea_banco_sin_partida_al_cierre`, `segregacion_de_funciones`.
- **quemado** — `FLOOR_MAX_TOLERANCIA_CONCILIACION = '500.0000'` (`floor.ts:114`), expresado «en la moneda de la cuenta que se concilia» (`floor.ts:108-114`), sin jurisdicción ni conversión.
- **casa** — `LIMITE_SESIONES = 500` (`:128`).

Puerta: `bank reconciliation open|list|status|run|close|approve|post|generate` (`bank-command.ts:3845-5229`). Pruebas: `tests/integration/banco-sesion-invariantes.int.spec.ts`, `tests/services/banking/reconciliation-firma.spec.ts`.

---

### M9 · Aritmética de dos lados

**Estado: completo.** Archivo: `reconciliation-math.ts`. Jurisdicción: neutral.

- Seis tipos de partida (`TIPOS_DE_PARTIDA` `:53-61`; CHECK en **054 `:67`**) y su lado (`LADO_DE` `:77-84`): cheque en circulación y depósito en tránsito corrigen el **banco**; cargo y abono del banco corrigen **libros**; errores a su lado.
- `calcularAritmetica` (`:255-393`): `null ≠ 0` («nadie observó»), partidas resueltas excluidas, sin tipo no suman, tolerancia, cinco códigos de reparo (`:144-155`); `cuadra: variacionDec !== null && …` nunca cierto con variación `null` (`:386`).
- Tipo por omisión por signo (`:404-420`).

Reglas por definir: ninguna. Parámetros: ninguno de jurisdicción. Pruebas: `tests/services/banking/reconciliation-math.spec.ts`.

---

### M10 · Partidas conciliatorias (descubrir, clasificar, perseguir)

**Estado: completo.** Archivo: `reconciling-items.ts`. Jurisdicción: neutral.

Reglas implementadas:
- `clasificarPartidas` (`:477-705`): levanta movimientos sin cotejo vivo (≤ fin del periodo, **sin límite inferior de fecha**, `:454-459`) y líneas de mayor sin sellar ni cotejar (`:547-589`); tipifica por signo (`proponerPartida` `:153-171`); idempotente por origen incluido lo resuelto (`:461-471`); **resuelve automáticamente** las partidas cuyo origen ya se cotejó o selló (`:624-645`); `LIMITE_DE_CLASIFICACION = 1000` con `topeAlcanzado` (`:385`, `:591-592`).
- Escalamiento derivado sólo de `fecha_esperada` (`derivarEscalamiento` `:121-129`): **sin umbral de días por decisión declarada** («una política contable disfrazada de constante», `:90-115`).
- `reclasificarPartida` exige importe nuevo al cambiar de lado (`:793-870`); `asignarPartida` no admite `vencido` a mano (`:896-976`); ambas bajo el candado de la sesión en curso (`:736-758`).
- INSERT con `fecha_esperada`/`responsable` vacíos a propósito (`:664-676`); `sinFechaEsperada: levantadas.length` (`:701`).

Reglas por definir (la casa dejó el plazo en blanco a propósito, pero la norma sí lo fija):
- **MX — LGTOC art. 181:** plazos de presentación del cheque (15 días misma plaza, 1 mes distinta plaza nacional, 3 meses extranjero) para envejecer «cheque en circulación» y proponer `fecha_esperada`; hoy toda partida nace sin fecha.
- **US — UCC §4-404:** el banco no está obligado a pagar un cheque con más de seis meses (*stale-dated*); **leyes estatales de propiedad no reclamada (escheatment)** para cheques no cobrados. `grep -rniE "escheat|unclaimed|stale.?dated|lgtoc" src` → sólo dos comentarios (`treasury-posting.ts:1278`, `:1657`); ningún motor, ninguna de las 39 claves del panel recoge un plazo de cheque.
- **Ambas:** flujo de reclamación al banco para `error-del-banco` (sólo se etiqueta).

Parámetros — **ley sin tabla ni clave**: plazos LGTOC 181 / UCC 4-404. Lo que falta es la clave del panel o la tabla de ley que reciba los plazos, **no un número en el código**: la decisión de no quemar el umbral (`:90-115`) es coherente con la casa. **casa**: `LIMITE_DE_CLASIFICACION = 1000` (`:385`).

Puerta: `bank reconciling-item list|assign|correct` (`bank-command.ts:4263-4454`).

---

### M11 · Ajustes de conciliación (borradores)

**Estado: parcial.** Archivo: `reconciliation-adjustments.ts`. Jurisdicción: MX (vocabulario fiscal mexicano).

Reglas implementadas:
- Cinco tipos: `TIPOS_DE_AJUSTE = ['comision','iva-comision','interes','isr-retenido','error']` (`:53`; CHECK en **054 `:135-136`**).
- Contrapartida por rol (`ROL_DE_AJUSTE` `:86-93`): `iva-comision → iva_acreditable (1130)`, `isr-retenido → isr_retenido_a_favor (1145)`; `comision: null` e `interes: null` = cuenta obligatoria a mano. `ROLES_QUE_FALTAN` (`:100-119`) confirma que `comision_bancaria` y `producto_financiero` existen como roles y que `treasury-posting` los consume; este motor decidió no resolverlos.
- Signo esperado por tipo, rechazado si contradice (`SIGNO_ESPERADO` `:131-137`, `direccionDeAjuste` `:207-245`). Rechaza importes que no caben en dos decimales en vez de redondear (`:262-274`).
- Crea **borrador** en `ai_drafts` con `CONFIANZA_POR_OMISION = 0.5` (`:149`) y fila en `reconciliation_adjustments` con `journal_entry_id` NULL; no importa nada de `posting.ts` (`:17-29`, `:375-535`).

Reglas por definir:
- **US:** no hay tipo neutro `bank-fee`/`service-charge`, ni `nsf-fee`, ni `returned-item`, ni `interest-expense`.
- **Ambas:** el criterio 1130 vs 1135 —aquí el IVA de la comisión va a **1130** (`:75-80`); en `treasury-posting.ts:25-38` va a **1135** y el comentario nombra la contradicción aparente («el eje es el REQUISITO DE COMPROBANTE»)— está explicado en comentarios y **no parametrizado**: ninguna de las 39 claves del panel lo recoge.

Parámetros — **quemado**: vocabulario de tipos MX (`:53`), roles fijos (`:86-93`), criterio 1130/1135 en comentarios. **casa**: confianza del borrador 0.5 (`:149`).

Puerta: `bank adjustment create <session>` (`bank-command.ts:4491-4512`, `--type` y `--amount` obligatorios).

---

### M12 · Comisiones bancarias (posteo con IVA aparcado)

**Estado: parcial.** Archivo: `treasury-posting.ts:786-1008` (`contabilizarComisiones`). Jurisdicción: MX, sin compuerta.

Reglas implementadas:
- Fuente: `bank_transactions.transaction_type = 'fee'` del periodo (`:802-820`).
- IVA **contenido**: base = total / (1 + t), IVA por resta para que cuadre exacto (`desglosarComision` `:177-192`); alternativa con IVA declarado (`:203-229`); tratamiento **obligatorio y sin valor por omisión** (`TratamientoDeIva` `:294-323`; CLI `.requiredOption('--iva-rate …')`, `bank-command.ts:5252-5257`).
- Asiento por cargo: DR `comision_bancaria` (6310), DR `iva_pendiente_acreditar` (**1135**, no 1130: **LIVA art. 5 fr. II** exige comprobante y el CFDI del banco no ha llegado, `:25-30`; roles `:885-891`; texto «VAT on bank fee parked in 1135 - no CFDI from the bank yet» `:903-913`), CR banco (`:893-940`); `source_type='bank_fee'`, `source_id` = movimiento → idempotente (`asientoPrevio` `:676-692`).
- Omisiones nombradas: `signo-contrario` (devolución de comisión, `:834-846`), `ya-contabilizada`, `sobre-el-tope` (`--max-amount`), `periodo-cerrado` (`:657-665`).
- Cotejo automático del cargo con su línea de banco (`cotejarMovimientoConSuLinea` `:613-650`, `:962-969`) para que la sesión no lo levante dos veces.
- Rechaza cuenta en moneda ≠ funcional (`:516-527`) y tarjeta de crédito (`:528-541`). Fecha del asiento a medianoche **local** (`fechaDelAsiento` `:652-654`, motivo `:578-598`).

Reglas por definir:
- **MX:** la tasa de IVA se pide en cada corrida y no vive en panel ni en `tax_tables`: las 39 claves (`grep "key: '" pending-catalog.ts`) no contienen ninguna `iva*`. Las tasas legales **sí** existen como constante, pero como catálogo del SAT (`c_TasaOCuota`: `'16': '0.160000'`, `'8': '0.080000'`, `src/services/xml-ingestion/sat-catalogs.ts:95-101`), no como política, y `treasury-posting` no las consulta. La de frontera (8 %) y las comisiones exentas se resuelven a mano.
- **MX:** `bank fee apply` —acreditar 1135→1130 cuando llegue el CFDI— **no existe**: `grep "command('apply'" bank-command.ts` → sólo `:3369` (`match apply`). El comentario `treasury-posting.ts:29-30` afirma que se libera «cuando el CFDI se ingiere, por el camino que ya existe»; el escéptico lo comprobó y **el camino no lo alcanza**: `grep -rn "bank_fee\|bank_interest" src/services src/cli` fuera de banca → cero; `iva-ppd-reclass.ts` mueve 1130→**1135** (sentido inverso) y sólo para facturas PPD; `ivaReclassificationsFor` (`iva-cash-basis.ts:593`) opera sobre `vendor_payments`/bills. Un asiento `source_type='bank_fee'` no tiene factura ni pago que lo enganche. El IVA de una comisión queda en 1135 sin motor que lo libere (A8).
- **US:** no hay IVA y no hay compuerta de jurisdicción: `contabilizarComisiones` no consulta `esContabilidadMexicana` ni `entityUsesCashBasisIva` (grep cero; la única llamada a `entityUsesCashBasisIva` en el subsistema es `:1459`, cheques). Con `--iva-rate 0` el asiento **no lleva** línea de 1135 (`:888-891` pide el rol sólo si `iva > 0`; `:902-912` sólo empuja la línea si `iva > 0`): sale limpio. Lo mexicano que queda para una entidad US es el **nombre de la bandera** y el mensaje de `stderr` «El IVA queda en pendiente de acreditar: se acredita con `bank fee apply` cuando llegue el CFDI del banco, no aquí», que se imprime **incondicionalmente** (`bank-command.ts:5367-5372`, sin `if` que mire la tasa).
- **Ambas (inerte):** la CLI sólo construye `iva: { modo: 'tasa', tasa }` (`bank-command.ts:5290`); los modos `'sin-iva'` e `'importes'` del servicio (`:311-316`) **no tienen puerta**. Hallazgo nuevo del escéptico (el original no lo decía para M12).

Parámetros — **ley, hoy pregunta por corrida**: tasa de IVA (`--iva-rate` obligatoria). **quemado**: roles `comision_bancaria`/`iva_pendiente_acreditar` (`:885-891`); mensaje de CFDI incondicional (`bank-command.ts:5367-5372`). **panel** (ausente): ninguna clave de IVA.

Puerta: `bank fee post <account> --period --iva-rate [--max-amount]` (`bank-command.ts:5230-5386`), irreversible, IA ✗.

---

### M13 · Intereses ganados y retención de ISR

**Estado: parcial.** Archivo: `treasury-posting.ts:1067-1265` (`contabilizarIntereses`). Jurisdicción: MX, sin compuerta.

Reglas implementadas:
- Fuente: `transaction_type = 'interest'` del periodo (`:1083-1098`); `signo-contrario` para interés pagado (`:1107-1123`).
- Interés **bruto**: `bruto = neto / (1 − tasa)`, retención por resta (`desglosarInteres` `:252-267`); o retención declarada en pesos (`:270-292`).
- Asiento de tres líneas: DR banco (neto), DR `isr_retenido_a_favor` (**1145**, pago provisional a favor, nunca gasto), CR `producto_financiero` (**4310**, bruto) (`:1174-1196`, roles `:1165-1170`, razones `:40-45`, `:1049-1065`); `source_type='bank_interest'`. Cotejo automático por el **neto** (`:1221-1228`).

Reglas por definir:
- **MX — LISR art. 54 + LIF art. 21:** la retención del sistema financiero es una **tasa anual sobre el capital**, no un porcentaje del interés. El motor modela `--rate` como fracción **del interés** («tasa de RETENCIÓN … lo que se despeja es cuánto se quedó por el camino», `:245-251`; ayuda «0.0125 for 1.25%», `bank-command.ts:5405-5413`). Es un hallazgo de **modelo**, no de cifra. La CLI sólo expone `retencion: { modo: 'tasa', tasa }` (`bank-command.ts:5439`; el original citaba `:5432`, misma acción); el modo `'importes'` por movimiento (`:317-323`, `:353-358`) **no tiene puerta** (inerte). La tasa LIF no está en `tax_tables`: la tabla **tiene columna `jurisdiction`** («US-FEDERAL, US-CA, MX, US-NYC», 008 `:356`) —es el lugar natural—, pero 009 sólo siembra `fit`, `isr`, `sit`, `subsidio_empleo`; `grep -rniE "interes|\bLIF\b"` en 008/009 → cero.
- Matiz del escéptico: la **retención declarada en pesos** sí tiene una puerta, en otro motor: `bank adjustment create --type isr-retenido --amount …` (`reconciliation-adjustments.ts:53`, rol `:86-93`; `bank-command.ts:4491-4512`). Es un **borrador** de sesión, no un asiento por movimiento con cotejo automático como el de `interest post`; el caso de uso (el banco publica la retención en pesos) se puede capturar a mano por esa vía.
- **MX:** conciliación con la **constancia de retenciones / CFDI de intereses** del banco: `grep -rniE "constancia|intereses" src/services/xml-ingestion` → sólo dos textos descriptivos de roles (`src/services/xml-ingestion/account-roles-seed.ts:56`, `:173`). Sin ingesta ni cotejo (A15).
- **US:** el interés es ingreso gravable (IRC §61(a)(4)); el banco emite **Form 1099-INT** (≥ $10) y sólo retiene *backup withholding* (IRC §3406, 24 %) por excepción. `grep -rniE "1099|backup.?withholding" src` → sólo `is_1099_vendor` (proveedores, 1099-NEC/MISC: `src/types/index.ts:400`, `src/cli/vendor-command.ts:90,108,125`). **Nada de 1099-INT ni backup withholding**; el único rol de retención es el activo fiscal mexicano 1145 (A5).
- **MX (NIF C-2 / LISR art. 18 fr. IX, personas morales):** el devengo de intereses a fecha de corte no se modela; se contabiliza el abono cuando el banco lo acredita (A17).

Parámetros — **ley, hoy pregunta por corrida y con modelo equivocado**: tasa de retención (`--rate`, fracción del interés). **quemado**: roles `producto_financiero`/`isr_retenido_a_favor` (`:1165-1170`).

Puerta: `bank interest post <account> --period --rate` (`bank-command.ts:5387-5541`), irreversible, IA ✗.

---

### M14 · Cobro de cheque y reclasificación de IVA en el mes del cobro

**Estado: parcial.** Archivo: `treasury-posting.ts:1370-1731` (`conciliarCheque`). Jurisdicción: MX, con compuerta que deja pasar a otras.

Reglas implementadas:
- Un cheque **es** un `vendor_payments` con `payment_method='check'` (`:1401-1407`); rechaza `void|failed` (`:1412-1418`); idempotente por `check_cleared_tx_id` (`:1419-1426`).
- Movimiento del cobro: nombrado con `--transaction` o buscado por importe exacto negativo, misma cuenta, misma moneda, fecha ≥ fecha del cheque, **sin ventana superior** (`movimientoDelCobro` `:1611-1690`; la ventana abierta se justifica por LGTOC art. 181, `:1654-1657`; `LIMIT 6` `:1669`); varios candidatos → se listan y se exige `--transaction` (`:1680-1688`); compatibilidad exacta (`:1693-1731`).
- `--as-of` se contrasta, nunca se impone (`:1431-1437`); cobro anterior al cheque rechazado (`:1441-1446`).
- **LIVA art. 1-B** (pago con cheque efectuado al cobro): reclasificación **1135 → 1130** en el periodo del cobro con `ivaReclassificationsFor` (`:1459-1463`, `:1479-1525`; roles `iva_acreditable`/`iva_pendiente_acreditar` `:1480-1485`); periodo cerrado con IVA que mover → rechazo; sin IVA → cobro registrado sin asiento (`:1465-1473`, `:1526-1538`).
- **Compuerta de jurisdicción:** `entityUsesCashBasisIva` (`:1459`; regla en `iva-cash-basis.ts:300-311`): una entidad no mexicana registra el cobro sin reclasificar nada (`:1536-1537`). Regla distinta de `esContabilidadMexicana` en el caso nulo (§0).
- Escribe `check_cleared_date` + `check_cleared_tx_id` juntas (CHECK `pago_cheque_cobro_coherente`, 055, `:1546-1553`).

Reglas por definir:
- **Ambas:** registro de cheques como sustantivo (folio, beneficiario, máquina de estados, `bank check list|issue|void|lock|remit|export`): fase 2 (`:1274-1279`) (A2).
- **MX:** `postVendorPaymentEntry` libera el IVA en la fecha del **pago** y no del cobro, así que este comando reclasifica cero para esos pagos (`:1360-1368`). El escéptico lo **corroboró fuera del subsistema**, cosa que el original no había hecho: `ar-ap-posting.ts:440-475` (`ivaReclassLines`) llama a `ivaReclassificationsFor` desde el posteo del pago, con compuerta `entityUsesCashBasisIva`. El criterio LIVA 1-B pide que el asiento del pago con cheque deje el IVA en 1135; la decisión está pendiente en `ar-ap-posting.ts`.
- **MX — LISR art. 27 fr. III:** pagos > $2 000 con cheque nominativo «para abono en cuenta del beneficiario»: `grep -rniE "nominativo|stop.?payment|positive.?pay|abono en cuenta" src` → sólo la etiqueta `'02': 'Cheque nominativo'` del catálogo c_FormaPago (`src/services/xml-ingestion/sat-catalogs.ts:72`). Sin campo ni validación (A16).
- **US:** *stop payment*, *stale-dated* (UCC §4-404), *positive pay*, NSF de cheques recibidos: nada (mismo grep).

Parámetros — **casa**: `LIMIT 6` de candidatos (`:1669`). **ley sin tabla**: umbral LISR 27-III ($2 000) no existe en ningún sitio.

Puerta: `bank check reconcile <payment-id> [--transaction] [--as-of]` (`bank-command.ts:5542-5700`), irreversible, IA ✗.

---

### M15 · Rutas REST heredadas (importación JSON, sugerencias, match manual, sesión)

**Estado: parcial**, obsoleto respecto a la CLI; su `complete` es una puerta que no escribe. Archivo: `bank-reconciliation.ts`. Jurisdicción: neutral.

Lo relevante como motor (detalle en §5.2): importa sin documento ni pruebas (`:103-144`, `'debit'` en `:128`); sugiere con `times(0.01)` (`:163-218`, `:166`); coteja a mano con `INSERT INTO reconciliation_matches (… match_type 'manual' …)` y `matched_amount || 0`, **sin grupo, sin Σ, sin sello** (`:221-244`, `:231`); abre sesión con `beginning_balance` literal `0` (`:247-270`, `:257`); `complete` → `NotImplementedError` 501 (`:360-369`). El manual del agente lo describe tal cual (`src/ai/docs/banking.md:1-15`).

Parámetros — **quemado**: banda ±1 % (`:166`); `'debit'` por omisión (`:128`).

---

## 2. Parámetros quemados, consolidados

Sólo lo que es ley o criterio escrito en código (lo que hay que mover). Las constantes operativas —`LOTE_LINEAS 200`, `MAX_ESTADOS 200`, `MAX_LINEAS_CHECK 50 000` (`bank-statement-service.ts:84-95`), `LIMITE_PROPUESTAS 500` (`match-service.ts:127`), `LIMITE_SESIONES 500` (`reconciliation-service.ts:128`), `LIMITE_DE_CLASIFICACION 1000` (`reconciling-items.ts:385`), `MAX_REVERSOS 50`, huella 8 (`statement-checks.ts:142`, `:197`), `BISAGRA_SIGLO 69` (`fecha.ts:40`), avisos 200 (`avisos.ts:23`), `LIMIT 6` (`treasury-posting.ts:1669`)— son **casa** y no entran en la tabla.

| Parámetro | Valor hoy | Dónde | Hoy es | Debería ser | Por qué |
|---|---|---|---|---|---|
| Fecha ambigua en `auto` | DD/MM | `parsers/fecha.ts:148-158` | quemado | panel (por jurisdicción) | Convención MX; US es MM/DD |
| Monedas toleradas en importes | `mxn, mxp, usd, eur, cad, m.n., mn, pesos` | `parsers/importe.ts:51` | quemado | panel | Lista por país |
| Nombres de mes | es/en | `parsers/fecha.ts:19-32` | quemado | casa ampliable | Otras locales |
| Perfiles CSV de bancos | 3 MX + genérico, `pais:'MX'` | `parsers/perfiles-csv.ts:50-202` | quemado | tabla de perfiles por jurisdicción/banco | Los tres son conjetura; `bank format` fase 2 |
| Ventana de reversos | 5 días | `statement-checks.ts:135` | casa sin puerta | panel o bandera | Opción `diasReverso` existe en el servicio y no en la CLI |
| Ventana de fecha del cotejo | 3 días | `matching.ts:174`; `match-service.ts:114` | quemado | panel | Práctica de despacho |
| Bandas de importe | 5 %, 10 %, 1 % | `matching.ts:204`, `:373-374`; `bank-reconciliation.ts:166` | quemado | panel | Práctica de despacho |
| Pesos y umbrales del puntaje | .45/.25/.30; 0.75; 0.05; 0.70/0.85 | `matching.ts:306`, `:268`, `:275`, `:233-236` | quemado | panel (el umbral ya lo está, sólo para REST) | Práctica de despacho |
| Stopwords y normalización | inglés; `a-z0-9` | `matching.ts:95-99`, `:90-92` | quemado | por idioma/jurisdicción | Español con acentos y ñ para MX |
| Techo de auto-aplicación | 50 000 «functional currency» | `floor.ts:36-39` | quemado | piso por moneda | 50 000 MXN ≠ 50 000 USD |
| Techo de tolerancia de cierre | 500.0000 «moneda de la cuenta que se concilia» | `floor.ts:108-114` | quemado | piso por moneda | Idem; sin conversión a propósito |
| Confianza por omisión de `bank match run` | 0.85 | `match-service.ts:117`, `:997` | quemado | panel (`cotejo_umbral_confianza`) | **La CLI no lee el panel**; la clave sólo se lee en `matching.ts:587` (REST) |
| Tope de monto de `bank match run` | `FLOOR_MAX_AUTO_POST` salvo `--max-amount` | `match-service.ts:1003-1004`; `bank-command.ts:3184-3185` | quemado | panel (`cotejo_monto_maximo_auto`) | Idem: la clave no llega a la CLI |
| Roles contables de tesorería | `comision_bancaria`, `iva_pendiente_acreditar`, `producto_financiero`, `isr_retenido_a_favor`, `iva_acreditable` | `treasury-posting.ts:885-891`, `:1165-1170`, `:1480-1485`; `reconciliation-adjustments.ts:86-93` | quemado | conjunto por jurisdicción | El rol es neutro; el conjunto (IVA/ISR) es mexicano |
| Tipos de ajuste | `comision, iva-comision, interes, isr-retenido, error` | `reconciliation-adjustments.ts:53`; 054 `:135-136` | quemado | vocabulario por jurisdicción | Fiscal MX; sin `nsf`, `returned-item`, `bank-fee` |
| Criterio 1130 vs 1135 para el IVA de comisiones | comprobante sí/no | `reconciliation-adjustments.ts:75-80`; `treasury-posting.ts:25-38` | quemado (en comentarios) | panel | Ninguna de las 39 claves lo recoge |
| Tasa de IVA de comisiones | obligatoria por corrida | `bank-command.ts:5252-5257` | ley preguntada cada vez | `tax_tables`/panel por jurisdicción y región | 16 %, 8 % frontera, exento; existe en `sat-catalogs.ts:95-101` como catálogo, no como política |
| Aviso de CFDI tras `fee post` | siempre | `bank-command.ts:5367-5372` | quemado | condicional a jurisdicción/tasa | Se imprime aun con `--iva-rate 0` |
| Tasa de retención de intereses | obligatoria por corrida, % del interés | `bank-command.ts:5405-5413`; `treasury-posting.ts:252-267` | ley preguntada cada vez, modelo distinto | `tax_tables` (columna `jurisdiction` ya existe, 008 `:356`) | LIF art. 21: tasa anual sobre capital |
| Plazos de cheque en circulación | ninguno (a propósito) | `reconciling-items.ts:90-115` | ley sin tabla ni clave | panel/`tax_tables` por jurisdicción | LGTOC 181 / UCC 4-404 |
| Umbral de cheque nominativo | ninguno | — | ley ausente | `tax_tables` MX | LISR 27-III: $2 000 |
| Conmutador de jurisdicción del subsistema | ninguno; `entityUsesCashBasisIva` sólo en cheques | `treasury-posting.ts:1459`; `iva-cash-basis.ts:300-311` | quemado (ausencia) | `pais-contable.ts` en las puertas de tesorería | Dos conmutadores con reglas distintas en el caso nulo |

---

## 3. Lo que Estados Unidos exige y no existe

Motores ausentes marcados A*n*; los que también exige México llevan la misma etiqueta en §4 y se cuentan una vez. Lo que es parámetro y no motor remite a §2.

1. **A1 · Lectores OFX/QFX y BAI2** — los formatos que entregan los bancos estadounidenses (OFX/QFX en banca minorista, Quicken/QuickBooks; BAI2 en tesorería corporativa). Declarados «sin lector» (`parsers/index.ts:53-62`, `:74-78`); ningún lector bajo otro nombre en `src`; ninguna dependencia en `package.json`. Ningún perfil CSV nativo de banco US (`perfiles-csv.ts:197-202`); el `generico` sirve si el usuario reexporta.
2. **Convención de fecha MM/DD por jurisdicción** — `auto` asume DD/MM (`parsers/fecha.ts:148-158`). Parámetro (§2).
3. **A2 · Registro de cheques emitidos y su ciclo** (issue/void/stop payment/stale-dated UCC §4-404/positive pay) — fase 2 (`treasury-posting.ts:1274-1279`); `grep stop.?payment|positive.?pay src` → cero.
4. **A3 · Escheatment / propiedad no reclamada** (leyes estatales) para cheques no cobrados y depósitos inactivos — `grep -rniE "escheat|unclaimed|stale.?dated" src` → dos comentarios (`treasury-posting.ts:1278`, `:1657`), ningún código.
5. **A4 · Devoluciones NSF / *returned items*** (Reg CC, UCC §4-214) y su comisión — el CHECK de `transaction_type` es `('debit','credit','fee','interest','adjustment')` (003 `:50-51`); sin tipo en `TIPOS_DE_PARTIDA` (`reconciliation-math.ts:53-61`) ni en `TIPOS_DE_AJUSTE` (`reconciliation-adjustments.ts:53`); en CxC el `--fee` de devolución está «not yet supported: needs a fee role account» (`src/ai/docs/cli-reference.md:3829-3830`).
6. **A5 · Interés sin retención, cotejo con Form 1099-INT y *backup withholding*** (IRC §3406, 24 %) — el único rol de retención es `isr_retenido_a_favor` (1145, mexicano) (`treasury-posting.ts:1165-1170`); `grep 1099|backup.?withholding src` → sólo `is_1099_vendor` (proveedores).
7. **Comisión bancaria sin impuesto al consumo** — `bank fee post` exige `--iva-rate` (`bank-command.ts:5252-5257`); con `0` el asiento sale limpio, pero la pregunta es mexicana y el aviso de CFDI se imprime siempre (`:5367-5372`); no hay compuerta de jurisdicción en `contabilizarComisiones`; el ajuste `comision` no resuelve rol (`reconciliation-adjustments.ts:86-93`). Parámetro y compuerta (§2), no motor.
8. **Routing ACH y wire distintos** — una sola columna (`bank-account-service.ts:855-870`), ninguna migración añadió la segunda; sin validación de prefijo FRB ni FedACH (`:154-161`). Hueco de M4.
9. **A6 · Revaluación al cierre de cuentas en moneda extranjera (ASC 830)** — tesorería rechaza cuentas en moneda ≠ funcional (`treasury-posting.ts:516-527`); la conciliación no convierte. Redacción corregida por el escéptico: **no** es «sin motor de FX». La fase *realizada* de la diferencia cambiaria existe en `moneda-origen.ts:6-13` (`convertirAFuncional`, `DiferenciaCambiaria`; la usan `ar-ap-posting.ts` y `payment-service.ts`) y el panel tiene `fuente_tipo_cambio` (`pending-catalog.ts:708`). Lo ausente es la fase **no realizada** —revaluar saldos vivos al cierre—, declarada «fase 2» en `moneda-origen.ts:12` y `ar-ap-posting.ts:985`, y que banca invoque algo de eso.
10. **Pisos monetarios por moneda** — 50 000 «functional currency» (`floor.ts:36-39`) y 500 «moneda de la cuenta que se concilia» (`floor.ts:108-114`), ninguno con jurisdicción. Parámetro (§2).
11. **A7 · Extractor de ACH *trace number* y número de cheque en el movimiento** — `CAMPOS_SIN_EXTRACTOR` (`transactions.ts:106-111`); `bank_transactions` sin columna.
12. **A12 · Envejecimiento de cheques en circulación por plazo legal** (UCC §4-404, seis meses) hacia `fecha_esperada` — toda partida nace sin fecha (`reconciling-items.ts:664-676`, `:701`); compartido con MX (LGTOC 181).
13. **A14 · Asiento a cuenta puente para la política `suspenso`** — declarada (`pending-catalog.ts:980`) y bloqueante (`reconciliation-service.ts:1215-1225`); compartido con MX.

## 4. Lo que México exige y no existe

1. **Retención de ISR sobre intereses conforme LISR art. 54 + LIF art. 21** (tasa anual **sobre el capital**, fijada cada ejercicio) — el motor toma `--rate` como fracción del interés (`treasury-posting.ts:245-267`; `bank-command.ts:5405-5413`, `:5439`); el modo por importes (`:317-323`, `:353-358`) no tiene puerta (inerte; a mano vía `bank adjustment create --type isr-retenido`); la tasa LIF no está en `tax_tables` (009 sólo nómina; 008 `:356` ya tiene `jurisdiction`). Modelo y parámetro (§2), no motor ausente.
2. **A8 · Acreditamiento del IVA de comisiones al llegar el CFDI del banco (LIVA art. 5 fr. II)** — `bank fee apply` prometido (`bank-command.ts:5370`) e inexistente; el «camino que ya existe» de `treasury-posting.ts:29-30` no alcanza a `source_type='bank_fee'` (nada fuera de banca lo referencia; `iva-ppd-reclass.ts` va en sentido inverso; `ivaReclassificationsFor` opera sobre pagos/bills). El IVA queda en 1135 sin salida.
3. **A9 · Conservación del estado de cuenta como parte de la contabilidad (CFF art. 28 fr. I y IV, art. 30; RCFF art. 33 B fr. III)** — se guarda `file_name` + `file_sha256`, no los bytes (`bank-statement-service.ts:585-596`; 051 `:122-160`; sin `ALTER TABLE bank_statements` posterior). `raw_data` conserva la fila parseada (`:319`, `:730`), no el documento.
4. **A7 · Datos de póliza para Anexo 24 (contabilidad electrónica)** — extractores de clave de rastreo SPEI, CLABE y RFC de la contraparte y número de cheque: nombrados sin implementar (`transactions.ts:106-111`); columna inexistente. **A10 · Catálogo c_Banco** — sólo forma (`bank-account-service.ts:800-809`); ninguna tabla ni constante; `bank institution sync` fase 3 (`docs/cli-command-catalog.md:1155`).
5. **A11 · Perfiles CSV de BBVA/Banorte/Santander verificados y la herramienta que los verificaría** (`bank format create|test`) — los tres son `conjetura` (`perfiles-csv.ts:8-35`); sin fixtures; el código remite a comandos que el catálogo tiene en fase 2 (`csv.ts:209`; `docs/cli-command-catalog.md:1170-1176`).
6. **A12 · Plazos LGTOC art. 181 para envejecer cheques en circulación** (15 días / 1 mes / 3 meses) y proponer `fecha_esperada` — toda partida nace sin fecha (`reconciling-items.ts:664-676`, `:701`); el escalamiento no tiene umbral por decisión (`:90-115`); ninguna clave del panel lo recibe.
7. **A2 · Registro de cheques (folio, beneficiario, estados)** — fase 2 (`treasury-posting.ts:1274-1279`). **A16 · Cheque nominativo «para abono en cuenta» (LISR art. 27 fr. III, pagos > $2 000)** — sin campo ni validación; sólo la etiqueta c_FormaPago `'02'` (`sat-catalogs.ts:72`).
8. **Coherencia LIVA 1-B en el asiento del pago con cheque** — hoy el IVA se libera en la fecha del pago (`ar-ap-posting.ts:440-475`, corroborado) y `bank check reconcile` reclasifica cero (`treasury-posting.ts:1360-1368`). Decisión pendiente fuera del subsistema; hueco de M14.
9. **Tasa de IVA por jurisdicción/región (16 %, 8 % frontera, exento) en panel o `tax_tables`** en vez de `--iva-rate` obligatorio por corrida (`bank-command.ts:5252-5257`); ninguna clave `iva*` en el panel; las tasas viven sólo como catálogo SAT (`sat-catalogs.ts:95-101`). Parámetro (§2).
10. **A6 · Diferencia cambiaria en cuentas en USD (NIF B-15; LISR art. 8)** — sin revaluación al cierre; la fase realizada existe en `moneda-origen.ts:6-13` y banca no la usa (mismo hueco que US-9).
11. **A13 · Arqueo de caja chica** — sólo avisos (`bank-statement-service.ts:461-465`; `reconciliation-service.ts:453-458`).
12. **A14 · Cuenta puente («suspenso») para líneas sin explicar** — política declarada en el panel (`pending-catalog.ts:980`) y bloqueante por falta de motor (`reconciliation-service.ts:1215-1225`).
13. **A15 · Constancia de retención / CFDI de intereses del banco** — sin ingesta ni cotejo con lo posteado (`src/services/xml-ingestion` sólo tiene textos descriptivos; `account-roles-seed.ts:56`, `:173`).
14. **A17 · Devengo de intereses a fecha de corte (NIF C-2 / LISR art. 18 fr. IX)** — se contabiliza el abono cuando el banco lo acredita; no hay motor de devengo (anotado en M13 del original, no en su lista).

Compartidos con US y contados una vez: A2, A6, A7, A12, A14. Sólo US: A1, A3, A4, A5. Sólo MX: A8, A9, A10, A11, A13, A15, A16, A17. Total: **17**.

---

## 5. Puertas

### 5.1 CLI (`src/cli/bank-command.ts`)

Árbol `bank` / alias `banco` (`:1889-1891`). Subcomandos reales (awk sobre `.command(` en `:2093-5701`):

| Sustantivo / alias | Verbos | Líneas | Servicio |
|---|---|---|---|
| `account` / `cuenta` | `create`, `list`, `show`, `edit`, `set` | 2093-2457 | `bank-account-service.ts` |
| `statement` / `estado-cuenta` | `import`, `list`, `show`, `check` | 2098-2835 | `bank-statement-service.ts` + `parsers/index.ts` (`leerExtracto`, importado en `:37`) |
| `transaction` / `movimiento` | `list`, `show` | 2915-3070 | `transactions.ts` |
| `book-item` / `partida-libros` | `list` | 3071-3130 | `book-items.ts` |
| `match` / `cotejo` | `preview`, `run`, `apply`, `create`, `unapply` | 3131-3599 | `match-service.ts` (no lee el panel) |
| `reconciliation` / `conciliacion` | `run`, `open`, `list`, `status`, `close`, `approve`, `post`, `generate` | 3845-5229 | `reconciliation-service.ts` |
| `reconciling-item` / `partida-conciliatoria` | `list`, `assign`, `correct` | 4263-4454 | `reconciling-items.ts` |
| `adjustment` | `create` | 4491-4512 | `reconciliation-adjustments.ts` |
| `fee` / `comision` | `post` | 5230-5386 | `treasury-posting.ts` (`contabilizarComisiones`) |
| `interest` / `interes` | `post` | 5387-5541 | `treasury-posting.ts` (`contabilizarIntereses`) |
| `check` / `cheque` | `reconcile` | 5542-5700 | `treasury-posting.ts` (`conciliarCheque`) |

Comandos **nombrados por el código y sin `.command(` detrás** (cada uno verificado con `grep`):
- `bank fee apply` — `fee post` remite a él en el mensaje incondicional de `stderr` (`:5367-5372`); el único `command('apply'` es `:3369` (`match apply`).
- `bank format list|show|create|test|explain|apply` — los perfiles CSV remiten a ellos (`perfiles-csv.ts:32-35`, `:57`, `:162`; `csv.ts:209`; `tipos.ts:97`, `:166`); el catálogo los marca ❌ fase 2 (`docs/cli-command-catalog.md:1170-1176`).
- `bank match approve --force` — nombrado en `match-service.ts:1145`; el único `command('approve')` (`:4784`) es de `reconciliation`.
- `bank check list|issue|void|lock|remit|export` — declarados fase 2 (`treasury-posting.ts:1274-1279`).
- `bank account archive` — nombrado en `bank-account-service.ts:990-992`; no existe; `--status active|archived` (`:428-440`) es filtro de `list`.
- `bank signer`, `bank limit` — fase 3 (`bank-account-service.ts:41-44`). `bank institution sync` — fase 3 en el catálogo (`:1155`). `bank statement apply|diff|delete|export|download` — ❌ (`:1163-1169`).
- `bank reconciliation generate --format pdf|xlsx` — rechazado (`:5106-5121`).

Banderas que el servicio admite y la CLI no expone: `diasReverso` (M3); `iva: {modo:'sin-iva'|'importes'}` (M12, `:5290` sólo `'tasa'`); `retencion: {modo:'importes'}` (M13, `:5439` sólo `'tasa'`).

### 5.2 REST (`src/api/rest/routes/bank-reconciliation.ts`)

- `POST /v1/bank-accounts/:account_id/import` (`:103-144`): inserta `bank_transactions` desde JSON, **sin pasar por los lectores ni por `bank_statements`**; `tx.transaction_type || 'debit'` sin mirar el signo (`:128`); deduplica sólo por `bank_transaction_id` (`:113-118`).
- `GET …/transactions/unmatched` (`:147-160`); `GET …/transactions/:id/suggestions` (`:163-218`; banda ±1 % quemada en `:166`; sólo facturas y gastos).
- `POST …/transactions/:id/match` (`:221-244`): escribe `reconciliation_matches` con `match_type='manual'` **sin grupo, sin Σ, sin sello** y con `matched_amount || 0` (`:231`); diverge de los invariantes de `match-service.ts`.
- `POST …/:account_id/reconciliations` (`:247-270`): sesión con `beginning_balance` literal `0` (`:257`) y sin `statement_id`; `reconciliation-service.ts:71-78` lo documenta como la fuente del «saldo no observado».
- `GET /reconciliations/:id` (`:273-310`; comentario CAUTION sobre `variance` de columna `:296-300`); `POST …/auto-match` (`:320-329`) → `autoMatchUnreconciled`, **la única puerta que lee `cotejo_umbral_confianza` y `cotejo_monto_maximo_auto`** (`matching.ts:587-588`); `POST /reconciliations/:id/complete` → **501** (`:360-369`): puerta que no escribe (inerte).

### 5.3 GraphQL (`src/api/graphql/`)

No expone ningún motor bancario. Lo único con nombre de banco: la suscripción `bankTransactionImported(bankAccountId: ID!): Int!` (`src/api/graphql/schemas/schema.ts:491`), **declarada y sin resolutor ni transporte** («sería lectura continua del banco: pediría reports:read», `src/api/graphql/permisos.ts:192-193`); el campo `JournalEntryLine.isReconciled` (`schema.ts:154`; resolutor `src/api/graphql/resolvers/index.ts:658`) que sólo lee el sello de M5; el valor `AUTO_RECONCILIATION` del enum de tipos de asiento (`schema.ts:50`); y `bankAccountId: null` fijo en el registro de cobros (`resolvers/index.ts:576`). Ni el original ni el escéptico habían mirado esta puerta; se añade aquí.

### 5.4 Agente

`src/ai/docs/banking.md` (47 líneas) marca IA ✓ para `statement import|list|show|check`, `transaction`, `book-item`, `match preview`, `reconciliation open|list|status`, `reconciling-item list`, `adjustment create`; IA ✗ para todo lo que toca el mayor o firma (`:18`, `:25`, `:42`, `:44-46`). Describe las rutas REST tal cual son (`:1-15`: `complete` responde 501; `variance` es default de columna; no hay conector Plaid/Belvo). El manifiesto (`src/ai/docs/manifiesto.json:32-43`) ata `banking.md` a once archivos: ocho del subsistema (`matching`, `bank-statement-service`, `statement-checks`, `match-service`, `book-items`, `reconciliation-service`, `reconciling-items`, `reconciliation-adjustments`), la ruta REST, `src/database/enums.ts` y la propia CLI; **no** incluye `treasury-posting.ts`, `bank-account-service.ts`, `transactions.ts`, `reconciliation-math.ts` ni los lectores de `parsers/`. (El original decía «diez archivos del subsistema»; la lista es de once y sólo ocho son del subsistema.)

---

## 6. Lo que el escéptico refutó o corrigió

Ningún reclamo fue refutado de fondo: los 15 se sostienen. Lo que **no** hay que creerse del original, tal como estaba escrito:

**Corregido (la cita o la formulación era falsa):**
1. **«CHECK 053» en M8, M9 y M11.** Los tres CHECK viven en la **054** `_la_sesion_que_cuadra.sql` (`:39` sesión balanceada con aritmética; `:67` tipo de partida; `:135-136` tipo de ajuste). La 053 es «la nómina deja de cargarse a Devoluciones sobre Compras» y no toca banca.
2. **`FLOOR_MAX_TOLERANCIA_CONCILIACION` «en moneda funcional» (M6, M8, §0, tabla).** El comentario de `floor.ts:108-114` dice lo contrario y a propósito: «una magnitud en la moneda de la cuenta que se concilia». La crítica de fondo (500 sin moneda ni jurisdicción) se sostiene; la cita no.
3. **`CONFIANZA_POR_OMISION 0.85` «duplica el defecto del panel» (M7).** Es peor: `match-service.ts` **no lee el panel** (sin `getPolicy`); `cotejo_umbral_confianza` y `cotejo_monto_maximo_auto` sólo se leen en `matching.ts:587-588` (REST `auto-match`). Una política del panel no llega a `bank match preview|run`.
4. **`bank format create|test` «que el propio código promete» (M1).** Los promete el código en **comentarios y mensajes** (`perfiles-csv.ts:32-35,57,162`; `csv.ts:209`; `tipos.ts:97,166`); el catálogo los marca **❌ fase 2** (`docs/cli-command-catalog.md:1170-1176`), no los da por hechos.
5. **`bank-command.ts:5432` (M13).** Es `:5439` (`retencion: { modo: 'tasa', tasa }`); misma acción.
6. **«Sin motor de FX» (US-9 / MX-10).** La diferencia cambiaria **realizada** existe en `moneda-origen.ts:6-13` y el panel tiene `fuente_tipo_cambio` (`pending-catalog.ts:708`). Lo ausente es la **revaluación al cierre** (fase 2, `moneda-origen.ts:12`, `ar-ap-posting.ts:985`) y que banca use algo de eso.
7. **«Misma regla nulo = México en espíritu» para los dos conmutadores (§0).** No: `esContabilidadMexicana` (`pais-contable.ts:35-43`) trata nulo como México; `entityUsesCashBasisIva` (`iva-cash-basis.ts:300-311`) devuelve `false` para país nulo sin `mx_nif`. Una entidad sin país declarado es mexicana para el núcleo y no para banca.

**Añadido (hallazgos nuevos del escéptico, no estaban en el original):**
8. **M12:** la CLI de `fee post` sólo construye `{modo:'tasa'}` (`bank-command.ts:5290`); `'sin-iva'` e `'importes'` sin puerta. El aviso de CFDI se imprime aun con `--iva-rate 0` (`:5367-5372`). Con tasa 0 el asiento sale sin línea de 1135 (`treasury-posting.ts:888-891`, `:902-912`). El «camino que ya existe» para liberar 1135 (`:29-30`) **no alcanza** a `bank_fee`.
9. **M14:** `ar-ap-posting.ts:440-475` corrobora, fuera del subsistema, que el IVA se libera en la fecha del pago (el original sólo citaba el comentario del código bancario).
10. **§5.3:** GraphQL no expone banca; la suscripción `bankTransactionImported` está declarada sin resolutor (`permisos.ts:192-193`). Añadido en esta fusión, no por el escéptico.

**Matizado (acota el alcance; no refuta):**
11. **M1:** el perfil `generico` sirve para cualquier país si el usuario reexporta; lo ausente es el perfil nativo de banco US.
12. **M2:** `bank_transactions.raw_data` conserva la fila parseada (`bank-statement-service.ts:319`, `:730`); no basta para el CFF 28/30.
13. **M5:** el número de cheque **emitido** sí existe (`vendor_payments.check_number`, 002 `:124`) y `conciliarCheque` lo lee; lo ausente es el extractor del lado del banco.
14. **M12:** las tasas de IVA existen como catálogo SAT (`sat-catalogs.ts:95-101`), no como política; `treasury-posting` no las consulta.
15. **M13:** la retención en pesos se puede capturar a mano por `bank adjustment create --type isr-retenido --amount` (borrador, no asiento por movimiento).

**Lo que el escéptico intentó refutar y no pudo** (cada búsqueda sobre todo `src/` y las migraciones): lector OFX/BAI2 bajo otro nombre; IBAN mod-97 en otro módulo; catálogo c_Banco en otra tabla; tasa LIF de intereses en `tax_tables`/`tax_parameters`; puerta que libere 1135 de una comisión al ingerir el CFDI; segunda columna de routing; bytes del extracto en migración posterior; escheatment/stale/LGTOC como motor; fixtures reales de BBVA/Banorte/Santander. Todas vacías.

**Lo que sigue sin verificar** (ambos lectores): nada se ejecutó; los artículos de ley citados (CFF 28/30, RCFF 33, LIVA 1-B/5-II, LISR 27-III/54/18-IX, LIF 21, LGTOC 181, UCC 4-404/4-214, IRC 61/3406, Reg CC, ASC 830, NIF B-15/C-2) se citan de memoria como la norma que exige cada regla, no contra el texto legal; las tasas concretas de la LIF vigente no se citan a propósito, porque el hallazgo de M13 es de modelo y no de cifra.
