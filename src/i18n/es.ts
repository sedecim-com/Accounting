import type { EN } from './en.js';

// ============================================================
// EL CATÁLOGO ESPAÑOL, Y LA PUERTA QUE LO OBLIGA (I6 · issue #148)
//
// `Record<keyof typeof EN, string>` NO ES DECORACIÓN DE TIPOS: es la puerta
// entera del tramo. Una clave que se añade en `en.ts` y se olvida aquí es un
// error de `tsc` —«Property 'x' is missing»— y una clave que sobra aquí
// también lo es, porque la comprobación de propiedades excedentes de un
// literal de objeto contra un tipo mapeado la rechaza. Las dos direcciones,
// sin una sola prueba de por medio y sin esperar a CI: el compilador que ya
// corre antes de cada commit.
//
// POR QUÉ ESTO Y NO UN JSON. Un catálogo en JSON obliga a una prueba que lo
// lea, y esa prueba corre después —y sólo si alguien la corre—. Un `Record`
// tipado falla en el editor, en la tecla siguiente. La sincronía deja de ser
// algo que se vigila y pasa a ser algo que no se puede escribir.
//
// LO QUE `tsc` NO VE, y por eso existe `tests/i18n/sync.spec.ts`: que los
// PARÁMETROS sean los mismos en los dos idiomas (un `{command}` traducido a
// `{comando}` compila igual de bien y sale vacío en pantalla), que las ramas de
// un `select` coincidan, que ninguna cadena esté vacía, que ninguna sea la
// inglesa copiada sin traducir, y que no quede ningún `__TRANSLATE__` dentro.
//
// EL ESPAÑOL DE AQUÍ ES EL QUE EL CLI YA IMPRIME, palabra por palabra, con su
// archivo y su renglón en `en.ts`. No es una traducción nueva: es la que hay,
// mudada a una clave.
// ============================================================

export const ES: Record<keyof typeof EN, string> = {
  // --- El kernel: confirmación y salida --------------------------------
  confirm_answer_not_understood:
    'no entendí «{answer}»: responde y/s para sí, n para no',

  no_changes_ledger_untouched: 'Sin cambios: el mayor no se tocó.',

  no_changes_no_terminal:
    'Sin cambios: no hay terminal donde confirmar. Añade -y para que `{command}` corra ' +
    'sin preguntar, o --dry-run para ver el efecto completo sin escribir nada.',

  // --- Los ensayos, que dicen qué se deshizo ---------------------------
  dry_run_rolled_back: 'Ensayo: se escribió de verdad y se deshizo.',

  dry_run_no_asset_created: 'Ensayo: la transacción se deshizo. No se creó ningún activo.',

  dry_run_ledger_untouched: 'Ensayo: el mayor no se tocó y no se escribió ningún renglón.',

  // --- Los tres `(s)` que el plural propio viene a jubilar -------------
  cfdi_cancelled_by_issuer:
    '{count, plural, one {# CFDI cancelado} other {# CFDI cancelados}} por el emisor: ' +
    'revisa su efecto contable con cfdi list --json',

  diot_checks_passed:
    'sin hallazgos: la DIOT pasa ' +
    '{count, plural, one {la # verificación pedida} other {las # verificaciones pedidas}}.',

  diot_findings_summary:
    '{blocking, plural, one {# bloqueante} other {# bloqueantes}}, ' +
    '{warnings, plural, one {# aviso} other {# avisos}}. ' +
    'Un bloqueante impide capturar la declaración.',

  // --- El único `select` de la siembra ---------------------------------
  prepaid_row_skipped:
    '{reason, select, ' +
    'coverage_not_started {la cobertura todavía no empieza} ' +
    'coverage_ended {la cobertura ya terminó} ' +
    'zero_month_row {el renglón del mes es cero} ' +
    'no_balance_left {no queda saldo por devengar} ' +
    'other {no hay nada que devengar este mes}}',

  // --- Prosa de listado ------------------------------------------------
  prepaid_no_live_schedule: 'No hay ningún calendario vivo en esta entidad.',

  prepaid_no_schedule_covers_date: 'Ningún calendario cubre el {date}. Con -a se listan todos.',

  bank_run_hit_cap:
    'La corrida llegó a su tope: quedan movimientos sin evaluar. Vuelve a correrla.',
  // ====================================================================
  // I7 · EL CROMO DEL CLI, EL KERNEL Y LAS HOJAS DE `mnemosine.ts`
  //
  // EL ESPAÑOL DE UN TÍTULO DE COMMANDER NO ES UNA TRADUCCIÓN LIBRE. `Uso:`,
  // `Opciones:` y `Comandos:` son las palabras con las que un contador mexicano
  // ya lee cualquier binario traducido; inventar sinónimos aquí obligaría a
  // aprender dos vocabularios para la misma pantalla.
  //
  // LO QUE NO SE TRADUCE, y está decidido: los NOMBRES de las banderas
  // (`--dry-run`, `--entity`) y de los comandos. La R8 del catálogo dice que
  // el nombre canónico sigue en inglés con alias español; lo que se traduce es
  // el TEXTO que los explica. Por eso `--dry-run` aparece igual en las dos
  // columnas y `compute and show the full effect` no.
  // ====================================================================

  // --- El cromo que Commander maqueta solo -----------------------------
  'cli.chrome.usage': 'Uso:',
  'cli.chrome.arguments': 'Argumentos:',
  'cli.chrome.options': 'Opciones:',
  'cli.chrome.global_options': 'Opciones globales:',
  'cli.chrome.commands': 'Comandos:',
  'cli.chrome.help_description': 'muestra la ayuda del comando',
  'cli.chrome.version_description': 'imprime el número de versión',

  // --- Los errores que Commander escribe por `outputError` -------------
  'cli.error.unknown_command': 'error: no existe el comando «{name}»',
  'cli.error.unknown_option': 'error: no existe la opción «{flag}»',
  'cli.error.missing_argument': 'error: falta el argumento obligatorio «{name}»',
  'cli.error.option_missing_argument': 'error: a la opción «{flags}» le falta su valor',
  'cli.error.missing_mandatory_option': 'error: falta la opción obligatoria «{flags}»',
  'cli.error.did_you_mean': '(¿Querías decir {suggestion}?)',
  'cli.error.did_you_mean_one_of': '(¿Querías decir alguno de {suggestions}?)',

  // --- El diccionario de banderas (`src/cli/kernel/flags.ts`) ----------
  'cli.flag.entity': 'entidad legal sobre la que operar (por omisión, la activa)',
  'cli.flag.tenant_scope': 'inquilino (despacho) al que se acota lo que se lee y se escribe',
  'cli.flag.user': 'usuario que actúa, para la atribución y los permisos',
  'cli.flag.format': 'formato de salida',
  'cli.flag.json': 'atajo de --format json',
  'cli.flag.output': 'escribe en un archivo en vez de en la salida estándar',
  'cli.flag.fields':
    'columnas separadas por comas; sin valor, lista las disponibles',
  'cli.flag.quiet': 'sólo identificadores, uno por renglón, para encadenar por tubería',
  'cli.flag.limit': 'máximo de renglones a devolver',
  'cli.flag.offset': 'salta estos renglones',
  'cli.flag.status': 'filtra por estado del ciclo de vida (se puede repetir)',
  'cli.flag.all': 'sin límite por omisión; incluye lo archivado y lo cerrado',
  'cli.flag.period':
    'selector de periodo: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06',
  'cli.flag.since': 'límite inferior inclusivo (AAAA-MM-DD)',
  'cli.flag.until': 'límite superior inclusivo (AAAA-MM-DD)',
  'cli.flag.as_of': 'fecha de valuación o de saldo (AAAA-MM-DD)',
  'cli.flag.date_basis': 'a qué fecha se aplican los filtros',
  'cli.flag.strict': 'trata los avisos como bloqueantes (salida 4)',
  'cli.flag.force':
    'pasa por encima de una validación bloqueante (periodo cerrado, fecha de bloqueo, ' +
    'duplicado); exige --reason',
  'cli.flag.note': 'anotación libre que se guarda con el registro',

  'cli.flag.error_not_whole_number':
    '{name} tiene que ser un entero no negativo; llegó "{value}".',
  'cli.flag.error_not_date': '{name} tiene que ser una fecha AAAA-MM-DD; llegó "{value}".',

  // --- Las banderas que inyecta la declaración de riesgo (risk.ts) -----
  'cli.flag.dry_run':
    'calcula y muestra el efecto completo; no escribe nada ni llama a nada externo',
  'cli.flag.yes': 'omite la confirmación',
  'cli.flag.idempotency_key':
    'llave de deduplicación del cliente, guardada al tener éxito: un reintento con la misma ' +
    'llave y la misma carga devuelve el resultado registrado',
  'cli.flag.idempotency_key_unhonored':
    'este comando TODAVÍA NO la honra: un reintento vuelve a escribir en vez de devolver el ' +
    'resultado registrado',
  'cli.flag.idempotency_key_unneeded':
    'no hace falta: este comando ya deduplica por el estado que escribe; se acepta y se ignora',
  'cli.flag.live': 'realiza el efecto externo de verdad (por omisión se usa el entorno de pruebas)',
  'cli.flag.reason': 'justificación que queda en el rastro de auditoría (obligatoria)',

  // --- La compuerta de mutación (`src/cli/kernel/risk.ts`) -------------
  'cli.risk.key_not_honored':
    '«{command}» acepta --idempotency-key porque su clase de riesgo la exige, pero TODAVÍA NO ' +
    'LA HONRA: {reason}. La llave «{key}» no deduplicaría nada: un reintento volvería a ' +
    'escribir. Vuelve a ejecutar SIN la llave y comprueba antes el estado del dominio que este ' +
    'comando toca (el documento, el saldo o el asiento), o repite con --dry-run para ver qué haría.',
  'cli.risk.undeclared':
    '«{command}» pide una compuerta de mutación sin haber declarado su riesgo. Toda hoja que ' +
    'muta declara con `declareRisk` junto a su registro; sin declaración no hay confirmación, ' +
    'ni marcha seca, ni rastro de auditoría que decir.',
  'cli.risk.force_needs_reason':
    '--force pasa por encima de una regla de seguridad, así que exige --reason "<por qué>". ' +
    'El motivo queda escrito en el rastro de auditoría.',
  'cli.risk.undo_needs_reason':
    '«{command}» deshace o revoca algo, así que exige --reason "<por qué>".',
  'cli.risk.gate_flags_not_honored':
    '"{command}" acepta {flags} pero su manejador todavía no las honra: ejecutaría de verdad ' +
    'mientras la bandera promete lo contrario. Se rechaza en vez de fingir. (La bandera existe ' +
    'porque la clase de riesgo la exige; el cableado del manejador es trabajo de CLI-F2.)',

  // --- La entidad activa (`src/cli/kernel/entity-context.ts`) ----------
  'cli.entity.database_unreachable':
    'No se pudo llegar a la base al resolver la entidad activa ({entity}): {detail}',
  'cli.entity.database_unreachable_remedy':
    'mnemosine doctor   (y revisa DATABASE_URL en .env)',
  'cli.entity.pinned_unresolved': 'La entidad fijada ({entity}) no se pudo resolver: {detail}',
  'cli.entity.pinned_unresolved_remedy':
    'mnemosine entity use <id|nombre>   (o `mnemosine entity unset` para soltarla)',
  'cli.entity.pin_was_kept': 'La entidad fijada se conservó.',
  'cli.entity.must_be_named':
    'Este comando cambia datos, así que no va a adivinar la entidad. Nómbrala con ' +
    '--entity <id|nombre> o fija una con `mnemosine entity use`.',

  // --- El renderizador (`src/cli/kernel/output.ts`) --------------------
  'cli.output.unknown_format': 'No existe el --format "{value}". Usa uno de: {formats}.',
  'cli.output.unknown_fields': 'Campos que no existen: {unknown}. Disponibles: {available}.',

  // --- La salida (`src/cli/kernel/exit.ts`) ----------------------------
  'cli.exit.aborted': 'Cancelado.',

  // --- La raíz y sus dos banderas globales -----------------------------
  'help.root.description':
    'Asistente contable con IA — conversa con tu contabilidad desde la terminal',
  'cli.flag.tenant_root':
    'Inquilino sobre el que operar. Precedencia: esta bandera > MNEMOSINE_TENANT > ' +
    'mnemosine.config.json. Acota TODA consulta por RLS',
  'cli.flag.locale':
    'Idioma y convenciones de lo que se IMPRIME ({locales}). Precedencia: esta bandera > ' +
    '{envVar} ({envAlias} es su alias permanente) > ~/.mnemosine/config.json > ' +
    './mnemosine.config.json > lo que diga el inquilino > {fallback}. No cambia nada de lo que ' +
    'se entrega a una autoridad',

  // --- Las hojas que `src/cli/mnemosine.ts` registra por su cuenta ------
  'help.entities.description':
    'Lista las entidades legales activas (en desuso: usa `mnemosine entity list`)',
  'help.providers.description':
    'Lista los proveedores de modelos configurados (los de fábrica + mnemosine.config.json)',
  'help.ask.description': 'Hace una sola pregunta y sale',
  'help.chat.description': 'Abre una sesión de conversación (es el comando por omisión)',
  'help.sessions.description':
    'Lista las sesiones de conversación recientes (retoma una con: mnemosine chat --resume <id>)',
  'help.drafts.description': 'Lista los borradores de póliza que creó la IA',
  'help.review.description':
    'Revisa los borradores pendientes: aprobar (crea la póliza y la contabiliza), corregir y ' +
    'aprobar, o rechazar — un rechazo puede sembrar el criterio para la próxima vez',
  'help.ingest.description':
    'Ingesta por lote de CFDI (XML): reglas → clasificación por IA → borradores (o alta ' +
    'automática según los umbrales)',
  'help.lang.description':
    'Muestra o fija el idioma de las respuestas del AGENTE (la interfaz del CLI sigue su ' +
    'propio locale; los alias españoles funcionan siempre)',
  'help.onboard.description':
    'Importa la contabilidad de un cliente desde un sistema externo (catálogo de cuentas + ' +
    'saldos iniciales)',
  'help.outbox.description':
    'Operaciones encoladas para sistemas contables externos: listar, revisar y ejecutar',
  'help.outbox.list.description': 'Lista las operaciones externas encoladas (por omisión, las pendientes)',
  'help.outbox.run.description':
    'Ejecuta las operaciones encoladas contra el sistema externo del cliente (el efecto real ' +
    'exige --live)',
  'help.question.description':
    'Las preguntas pendientes del agente: listar, responder (queda como precedente) o descartar',
  'help.question.list.description': 'Lista las preguntas del agente (por omisión, las pendientes)',
  'help.question.answer.description':
    'Responde una pregunta (la respuesta queda como precedente), o atiende la cola de pendientes',
  'help.login.description': 'Inicia sesión con tu proveedor de identidad (OIDC)',
  'help.logout.description': 'Borra la credencial guardada en esta máquina',
  'help.whoami.description': 'Muestra la credencial activa y hasta cuándo sirve',
  'help.subscription.description':
    'Suscripciones a eventos salientes: a quién avisamos y qué no se pudo entregar',

  // ==== I7 · EL PILOTO: `src/cli/bank-command.ts` (issue #149) =====
  // --- Los analizadores de bandera: uso (2), no validación (4) ---------
  'bank.parse.date_invalid': '{flag} debe ser una fecha real en formato YYYY-MM-DD; llegó "{value}".',
  'bank.parse.amount_invalid': '{flag} debe ser un importe decimal; llegó "{value}".',
  'bank.parse.rate_invalid': '{flag} debe ser una tasa decimal; llegó "{value}".',
  'bank.parse.rate_out_of_range':
    '{flag} va entre 0 y 1, no en porcentaje: 0.16 para el 16%, 0.0125 para el 1.25%, 0 para ' +
    'ninguna. Llegó "{value}".',
  'bank.parse.account_type_unknown':
    '--type "{value}" no es un tipo de cuenta. Los cinco son: {types}.',
  'bank.parse.account_status_unknown':
    '--status {values} no existe para una cuenta bancaria: sólo active y archived.',
  'bank.parse.transaction_status_unknown':
    '-s {values} no existe para un movimiento bancario: sólo matched y unmatched. El resto de su ' +
    'estado —de qué estado de cuenta vino, qué lo explica— se lee con `bank transaction show`.',
  'bank.parse.unmatched_contradicts_status':
    '--unmatched y `-s matched` piden lo contrario. --unmatched es el atajo de `-s unmatched`: ' +
    'pasa uno de los dos.',
  'bank.parse.direction_unknown':
    '--direction "{value}" no existe: in es dinero que entra (importe positivo) y out el que sale.',
  'bank.parse.id_list_empty': '{flag} llegó vacía: nombra al menos un identificador.',
  'bank.parse.id_list_invalid':
    '{flag} {values} no es un identificador: se esperan uuid separados por comas, como los que ' +
    'imprime `bank transaction list -q`.',
  'bank.parse.uuid_invalid': '{flag} "{value}" no es un identificador: se espera un uuid.',
  'bank.parse.matchable_type_unknown':
    '"{value}" no es un tipo cotejable. Los cinco son: {types}. Escribe <tipo>:<id>, o sólo <id> ' +
    'para una partida de póliza.',
  'bank.parse.book_item_uuid_missing':
    '--book-item "{value}" no trae un identificador válido después del tipo.',
  'bank.parse.residual_unknown':
    '--residual "{value}" no existe. keep deja el residual vivo como partida conciliatoria; ' +
    'write-off lo cancela contra la cuenta que diga --write-off-account.',
  'bank.parse.unapply_reason_required':
    '--reason es obligatorio y es un CÓDIGO, no prosa: {codes}. Una taxonomía cerrada es lo que ' +
    'permite preguntar cuántos cotejos se deshicieron por documento cancelado este trimestre; un ' +
    'campo libre contesta eso con un grep.',
  'bank.parse.item_type_unknown':
    '--type "{value}" no es un tipo de partida conciliatoria. Los seis son: {types}.',
  'bank.parse.adjustment_type_unknown':
    '--type "{value}" no es un tipo de ajuste de conciliación. Los cinco son: {types}.',
  'bank.parse.run_step_unknown':
    '--stop-at "{value}" no es un paso del pase guiado. Los cinco, en orden: {steps}. Ninguno ' +
    'llega a `approve` ni a `post`.',
  'bank.parse.session_status_one_only':
    '-s admite un estado a la vez en esta hoja (llegaron {count}): {statuses}. Sin la bandera ' +
    'salen los cuatro.',
  'bank.parse.session_status_unknown':
    '-s "{value}" no es un estado de sesión de conciliación. Los cuatro son: {statuses}.',
  'bank.parse.item_status_unknown':
    '-s {values} no existe para una partida conciliatoria: sólo open y resolved. Una partida ' +
    'resuelta dejó de explicar una diferencia y por eso no sale por omisión.',
  'bank.query.unclosed_quote': 'La consulta "{query}" abre una comilla y no la cierra.',
  'bank.query.term_unknown':
    'La consulta no conoce el término "{term}:". Los que hay son {terms}, y una palabra sin ' +
    'prefijo busca en la descripción. El resto se acota con banderas (--account, --since, ' +
    '--until, --direction, --type).',
  'bank.query.term_without_value': 'El término "{term}" no trae valor: escribe {key}:<valor>.',
  'bank.query.amount_invalid':
    '"amt:{value}" no es un importe. La forma es amt:250, amt:>1000, amt:<=99.99 o amt:-250 ' +
    '(con signo compara el importe tal cual; sin signo, la magnitud).',
  'bank.query.narrows_nothing':
    'La consulta "{query}" no acota nada. Nombra al menos un término ({terms}), o quítala para ' +
    'listar todo.',

  // --- Lo que comparten todas las hojas de la familia -------------------
  'bank.list.hit_limit':
    'Se {count, plural, one {listó # fila} other {listaron # filas}}, que es el tope de --limit: ' +
    'puede haber más. Sube --limit, o usa --all en `{command}`.',
  'bank.offset.unsupported':
    '--offset no está implementado en esta familia: la consulta ordena y acota con --limit, sin ' +
    'cursor estable. {alternative}',
  'bank.offset.narrow_accounts': 'Acota con [query], --type o --currency, o pide todo con --all.',
  'bank.offset.narrow_statements': 'Acota con --account, --since o --until.',
  'bank.offset.narrow_sessions': 'Acota con --account, --period o -s, o pide todo con --all.',
  'bank.confirm.taken_as_no': '{reason}; lo tomo como no.',
  'bank.aborted.no_changes': 'Sin cambios.',
  'bank.idempotency.hit':
    'Idempotency hit: la llave "{key}" ya consumó este acto — {what}. Nada se ejecutó otra vez; ' +
    'esto es el resultado grabado.',

  // --- bank account -----------------------------------------------------
  'bank.account.create.dry_run':
    'Ensayo: el alta se ejecutó de verdad —índice único incluido— y se deshizo. Nada quedó escrito.',
  'bank.account.show.liability': 'PASIVO',
  'bank.account.show.label.account_number': 'Número de cuenta',
  'bank.account.show.label.routing': 'Ruteo ABA',
  'bank.account.show.label.sat_bank_key': 'Clave de banco SAT',
  'bank.account.show.label.gl_account': 'Cuenta de mayor',
  'bank.account.show.label.book_balance': 'Saldo en libros',
  'bank.account.show.label.bank_balance': 'Saldo del banco',
  'bank.account.show.label.difference': 'Diferencia',
  'bank.account.show.label.last_reconciled': 'Última conciliación',
  'bank.account.show.label.status': 'Estado',
  'bank.account.show.routing_on_file': 'en archivo (cifrado)',
  'bank.account.show.gl_unmapped': 'sin mapear',
  'bank.account.show.bank_balance_never_synced': 'nunca sincronizado',
  'bank.account.show.never_reconciled': 'nunca',
  'bank.account.show.status_active': 'activa',
  'bank.account.show.status_archived': 'archivada',
  'bank.account.edit.nothing_to_change':
    'Nada que cambiar. Pasa --name, --bank, --branch, --type, --currency, --clabe, ' +
    '--account-number, --routing-ach, --routing-wire, --sat-bank-code, --swift o --iban.',
  'bank.account.edit.reason_required':
    '{fields} cambia uno de los identificadores por los que sale el dinero ({sensitive}): exige ' +
    '--reason "<por qué>". El motivo se guarda en la bitácora, que es append-only.',
  'bank.account.edit.confirm': 'Vas a cambiar {fields} de "{account}". ¿Continuar?',
  'bank.account.edit.nothing_changed': 'Nada cambió: los valores ya eran esos.',
  'bank.account.edit.fields_changed': '{count, plural, one {# campo} other {# campos}}',
  'bank.account.edit.dry_run': 'Ensayo: el UPDATE corrió de verdad y se deshizo.',
  'bank.account.set.already_mapped':
    '{account} ya estaba mapeada a {gl}: nada que escribir.',
  'bank.account.set.forced':
    'FORZADO sobre {count, plural, one {# línea contabilizada} other {# líneas contabilizadas}}',

  // --- bank statement ----------------------------------------------------
  'bank.dir.unreadable': 'No se pudo leer --dir {dir}: {error}',
  'bank.dir.no_files': '--dir {dir} no tiene archivos que importar.',
  'bank.import.no_file': 'Qué archivo. Pásalo como argumento o apunta a un directorio con --dir.',
  'bank.import.counts':
    '{added, plural, one {# nueva} other {# nuevas}}, ' +
    '{duplicated, plural, one {# ya estaba} other {# ya estaban}}',
  'bank.import.findings':
    '{file}: {count, plural, one {# hallazgo} other {# hallazgos}} de integridad. Están en ' +
    'staging igual — es `bank statement check` quien sale 4.',
  'bank.import.dry_run': 'Ensayo: se parseó, se verificó y la escritura se deshizo.',
  'bank.import.staging_note':
    'Staging bancario: nada de esto está en el mayor hasta que se cotee y se concilie.',
  'bank.statement.list.status_not_applicable':
    '-s/--status no aplica a un estado de cuenta: no tiene estado de ciclo de vida. Su veredicto ' +
    'se calcula al leerlo (columna `chain`), y quien lo juzga es `bank statement check`, que sale 4.',
  'bank.statement.list.broken_chains':
    '{count, plural, one {# estado} other {# estados}} con la cadena de saldos rota. ' +
    '`bank statement check` dice cuál prueba falló y sale 4.',
  'bank.statement.show.line_count_mismatch':
    'El documento trae {document, plural, one {# línea} other {# líneas}} y la base le atribuye ' +
    '{stored}: las que faltan se dedujeron contra un estado anterior y conservan el statement_id ' +
    'de aquél.',
  'bank.statement.show.lines_omitted':
    '{count, plural, one {# línea más no se listó} other {# líneas más no se listaron}}. Sube --limit.',
  'bank.statement.check.skipped':
    '{count, plural, one {# estado más cumplía} other {# estados más cumplían}} el filtro y no ' +
    'se verificaron: la corrida tiene tope. Acota con --account o con --since.',

  // --- bank transaction · book-item · match -------------------------------
  'bank.transaction.show.no_extractors':
    'Sin extractores todavía ({fields}): lo que el banco escribió está en --raw. Los poblará ' +
    '`bank transaction apply`.',
  'bank.book_item.oldest_unseen':
    'La más antigua lleva {days, plural, one {# día} other {# días}} sin aparecer en el banco ' +
    '({entry}). Un cheque expedido y no cobrado vive aquí y nunca en el extracto.',
  'bank.match.preview.needs_target':
    'Previsualizar necesita saber sobre qué: pasa el id de un movimiento, o --account para ' +
    'recorrer los no cotejados de una cuenta.',
  'bank.match.preview.no_proposal': 'sin propuesta',
  'bank.match.preview.candidate': 'confianza {confidence} · regla {rule}',
  'bank.match.preview.label.amount': 'importe',
  'bank.match.preview.label.date': 'fecha',
  'bank.match.preview.label.description': 'descripción',
  'bank.match.preview.label.period': 'periodo',
  'bank.match.preview.label.verdict': 'veredicto',
  'bank.match.preview.amount_signal':
    '{bank} vs {candidate} · diferencia {difference} · exacto {exact} · misma dirección {sameDirection}',
  'bank.match.preview.date_signal':
    '{days, plural, one {# día} other {# días}} · dentro de ventana {withinWindow}',
  'bank.match.preview.description_signal': 'similitud {similarity}',
  'bank.match.preview.soft_signal': '(señal blanda: nunca aplica sola)',
  'bank.match.preview.would_apply': '`run` lo aplicaría',
  'bank.match.preview.not_applied': 'no se aplica',
  'bank.match.preview.summary':
    '{count, plural, one {movimiento} other {movimientos}} · {applicable} que `bank match run` aplicaría.',
  'bank.match.preview.hit_top':
    'Se previsualizaron {count}, que es el tope de --top: puede haber más.',
  'bank.match.applied': '{count, plural, one {# aplicado} other {# aplicados}}',
  'bank.match.run.tally':
    '· {already, plural, one {# ya lo estaba} other {# ya lo estaban}} · ' +
    '{skipped, plural, one {# omitido} other {# omitidos}} · ' +
    '{evaluated, plural, one {# evaluado} other {# evaluados}}',
  'bank.match.apply.tally':
    '· {already, plural, one {# ya lo estaba} other {# ya lo estaban}} · ' +
    '{skipped, plural, one {# omitido} other {# omitidos}}',
  'bank.match.apply.stdin_empty':
    'La entrada estándar no trajo ningún id. `bank match preview -q` los escupe uno por línea.',
  'bank.match.apply.no_transactions':
    'Qué movimientos. Pásalos como argumento, o encadena `bank match preview -q | mnemosine bank ' +
    'match apply --stdin`.',
  'bank.match.apply.confirm':
    'Vas a aplicar el cotejo que el motor propone para ' +
    '{count, plural, one {# movimiento} other {# movimientos}}. ¿Continuar?',
  'bank.match.apply.no_terminal':
    'Sin cambios: no hay terminal donde confirmar (la entrada estándar es la tubería). Añade -y ' +
    'para aplicar sin preguntar.',
  'bank.match.create.write_off_declared':
    'El residual de {amount} queda DECLARADO como cancelado contra la cuenta, pero no se ' +
    'contabiliza: no hay póliza detrás todavía. Regístrala a mano o espera a F05c.',
  'bank.match.create.dry_run': 'Ensayo: el grupo se escribió de verdad y se deshizo.',
  'bank.match.unapply.confirm':
    'Vas a desaplicar el cotejo {match} y todos los de su grupo (la igualdad ' +
    'Σbanco = Σlibros + Σajustes no sobrevive a que le quiten una pata). ¿Continuar?',
  'bank.match.unapply.closed':
    '{count, plural, one {# cotejo clausurado} other {# cotejos clausurados}}',
  'bank.match.unapply.released':
    '· {transactions, plural, one {# movimiento} other {# movimientos}} y ' +
    '{items, plural, one {# partida} other {# partidas}} de vuelta al flujo · motivo {reason}',
  'bank.match.unapply.group': 'grupo {group}',
  'bank.match.unapply.closure_note':
    'Clausura, no borrado: la fila se queda en el expediente con su motivo, porque el auditor ' +
    'pregunta por qué se deshizo y una fila borrada no contesta.',
  'bank.match.unapply.dry_run': 'Ensayo: se clausuró de verdad y se deshizo.',

  // --- bank reconciliation: la aritmética de dos lados ---------------------
  'bank.reconciliation.not_observed': 'sin observar',
  'bank.reconciliation.side.bank': 'BANCO',
  'bank.reconciliation.side.books': 'LIBROS',
  'bank.reconciliation.label.statement_balance': 'saldo del extracto',
  'bank.reconciliation.label.book_balance': 'saldo de libros',
  'bank.reconciliation.label.adjusted': '= ajustado',
  'bank.reconciliation.label.variance': 'VARIACIÓN',
  'bank.reconciliation.variance_not_computed': 'NO CALCULADA',
  'bank.reconciliation.variance_missing_side':
    'No es cero: es que falta un lado. Un cero aquí significaría «nadie restó nada».',
  'bank.reconciliation.tolerance_line': 'tolerancia {tolerance} · política {policy}',
  'bank.reconciliation.counters.items_label': 'partidas',
  'bank.reconciliation.counters.items':
    '{total} · {unclassified} sin clasificar · {undated} sin fechar · ' +
    '{resolved, plural, one {# resuelta} other {# resueltas}}',
  'bank.reconciliation.counters.statement_label': 'extracto',
  'bank.reconciliation.counters.unexplained':
    '{count, plural, one {# movimiento} other {# movimientos}} sin cotejo y sin partida ({amount})',
  'bank.reconciliation.frozen.title': 'RESUMEN CONGELADO',
  'bank.reconciliation.frozen.caption': '(la aseveración, no la respuesta)',
  'bank.reconciliation.frozen.never_computed':
    'nadie ha hecho la aritmética de esta sesión: la fila guarda variance {variance} por DEFAULT',
  'bank.reconciliation.frozen.line':
    'variance {variance} · libros {books} · cheques {checks} · depósitos {deposits} · ' +
    'cargos {charges} · abonos {credits} · otros {other}',
  'bank.reconciliation.frozen.computed_on': 'calculada el {date}',
  'bank.reconciliation.frozen.drifted':
    'la aritmética viva dice {live} y la sesión afirmó {frozen}: algo cambió debajo desde que se cerró.',
  'bank.reconciliation.ready_to_close': 'lista para `bank reconciliation close`.',
  'bank.reconciliation.whats_missing': 'LO QUE FALTA',
  'bank.reconciliation.session_label': 'sesión {session}',
  'bank.reconciliation.run.file_flags_without_file':
    '--format y --profile describen el archivo de --file, y no hay archivo. Pasa --file, o ' +
    'quítalas para tomar el extracto que ya esté importado.',
  'bank.reconciliation.run.dry_run':
    'Ensayo: los pasos que escriben se ejecutaron de verdad y se deshicieron.',
  'bank.reconciliation.open.summary':
    'saldo inicial {opening} · cierre de banco {closingBank} {currency} · extracto {statement}',
  'bank.reconciliation.open.continues': 'continúa {session}',
  'bank.reconciliation.open.no_arithmetic_yet':
    'La sesión nace sin aritmética (`arithmetic_computed_at` NULL): `bank reconciliation status` ' +
    'la calcula viva y `close` la firma. Nada de esto toca el mayor.',
  'bank.reconciliation.open.dry_run':
    'Ensayo: la sesión se abrió de verdad —continuidad incluida— y se deshizo.',
  'bank.reconciliation.list.variance_blank':
    '{count, plural, one {# sesión} other {# sesiones}} con la variación en blanco: nadie ha ' +
    'hecho su aritmética. La columna de la fila vale 0 por DEFAULT y por eso no se imprime.',
  'bank.reconciliation.status.needs_target':
    'Di qué sesión: `bank reconciliation status <session>`, o --account para la que esté en curso ' +
    'en esa cuenta.',
  'bank.reconciliation.status.two_ways':
    'El identificador y --account dicen lo mismo de dos maneras: da uno de los dos. Con --account ' +
    'se lee la sesión EN CURSO de esa cuenta.',
  'bank.reconciliation.status.statement_line':
    'extracto {statement} · declarado por el banco {declared} · saldo inicial {opening}',
  'bank.reconciliation.status.no_statement':
    'sin extracto atado: el saldo del banco NO se puede observar',
  'bank.reconciliation.status.items_title': 'PARTIDAS',
  'bank.reconciliation.status.adjustments_title': 'AJUSTES',
  'bank.reconciliation.status.adjustments_caption': '(borradores: nada se contabilizó solo)',

  // --- bank reconciling-item · adjustment · close · approve ----------------
  'bank.item.list.ageing':
    'La más antigua lleva {days, plural, one {# día} other {# días}}. ' +
    '{overdue, plural, one {# vencida} other {# vencidas}} y {undated} sin fecha esperada: una ' +
    'partida sin fecha no se persigue, envejece.',
  'bank.item.assign.expected_contradiction':
    '`--expected` y `--clear-expected` piden lo contrario: o se fija una fecha o se quita.',
  'bank.item.assign.nothing_to_assign':
    'No hay nada que asignar: indica al menos --owner, --expected, --clear-expected, --escalation o --note.',
  'bank.item.assign.escalation_unknown': '--escalation admite {values}; llegó "{value}".',
  'bank.adjustment.create.summary':
    '· {type} · {amount} · contrapartida {account} · banco {bankAccount} · borrador {draft}',
  'bank.adjustment.create.draft_note':
    'Es un BORRADOR: espera a `mnemosine review`. `journal_entry_id` queda NULL hasta que ' +
    '`bank reconciliation post` (F05d) lo contabilice detrás de una firma.',
  'bank.reconciliation.close.refused':
    'La sesión {session} no cierra: variación {variance}, ' +
    '{unclassified, plural, one {# partida sin clasificar} other {# partidas sin clasificar}} y ' +
    '{undated} sin fechar.',
  'bank.reconciliation.close.variance_missing_side': 'NO CALCULADA (no es cero: falta un lado)',
  'bank.reconciliation.close.what_balanced_would_claim':
    'Marcarla "balanced" con esto abierto le diría al tablero de cierre que el efectivo de esta ' +
    'cuenta está verificado contra el banco.',
  'bank.reconciliation.close.confirm':
    'Vas a firmar que la cuenta {account} cuadra con el banco al {until} (variación {variance}). ' +
    '`period-close` lo leerá como la evidencia de que el efectivo se verificó. ¿Continuar?',
  'bank.reconciliation.close.no_terminal':
    'Sin cambios: no hay terminal donde confirmar. Añade -y para cerrar sin preguntar.',
  'bank.reconciliation.close.summary':
    '· {status} · variación {variance} · banco ajustado {bankAdjusted} = libros ajustado {booksAdjusted}',
  'bank.reconciliation.close.frozen_summary':
    'resumen congelado: libros {books} · cheques {checks} · depósitos {deposits} · ' +
    'cargos {charges} · abonos {credits} · otros {other}',
  'bank.reconciliation.close.arithmetic_stamp':
    'Aritmética calculada el {date}. Balanceada NO es aprobada ni contabilizada: `approve` exige ' +
    'que el aprobador no sea el preparador, y `post` es lo que mueve el mayor.',
  'bank.reconciliation.close.dry_run': 'Ensayo: se cerró de verdad y se deshizo.',
  'bank.reconciliation.approve.title': 'LO QUE SE VA A FIRMAR',
  'bank.reconciliation.approve.label.session': 'sesión',
  'bank.reconciliation.approve.label.account': 'cuenta',
  'bank.reconciliation.approve.label.statement': 'extracto',
  'bank.reconciliation.approve.label.variance': 'variación',
  'bank.reconciliation.approve.label.members': 'miembros',
  'bank.reconciliation.approve.label.segregation': 'segregación',
  'bank.reconciliation.approve.no_statement': 'ninguno atado a la sesión',
  'bank.reconciliation.approve.variance_value': '{live} (congelada al cerrar: {frozen})',
  'bank.reconciliation.approve.members_value':
    '{items, plural, one {# partida} other {# partidas}} · ' +
    '{matches, plural, one {# cotejo} other {# cotejos}} · ' +
    '{adjustments, plural, one {# ajuste} other {# ajustes}}',
  'bank.reconciliation.approve.segregation_value': 'preparó {preparer} · política {policy}',
  'bank.reconciliation.approve.nobody_recorded': 'nadie registrado',
  'bank.reconciliation.approve.policy_default': '(por omisión)',
  'bank.reconciliation.approve.confirm':
    'Vas a FIRMAR la sesión {session} con la instantánea {hash}… ' +
    '({items, plural, one {# partida} other {# partidas}}, ' +
    '{adjustments, plural, one {# ajuste} other {# ajustes}}, variación {variance}). La firma no ' +
    'se retira: volver a aprobarla se rechaza. ¿Continuar?',
  'bank.reconciliation.approve.already_signed': 'sesión {session} ya firmada',
  'bank.reconciliation.approve.summary': '· {status} · firmada por {by} el {on}',
  'bank.reconciliation.approve.not_posted_yet':
    'Aprobada NO es contabilizada: el mayor lo mueve `bank reconciliation post`, que postea los ' +
    'ajustes que esta firma acaba de congelar.',
  'bank.reconciliation.approve.dry_run':
    'Ensayo: se firmó de verdad y se deshizo. El hash es el que quedaría.',

  // --- bank reconciliation post · generate --------------------------------
  'bank.reconciliation.post.already_posted': 'La sesión ya está contabilizada',
  'bank.reconciliation.post.already_posted_detail':
    '{count, plural, one {# asiento} other {# asientos}} en el libro y nada que postear.',
  'bank.reconciliation.post.already_posted_short': 'sesión {session} ya contabilizada',
  'bank.reconciliation.post.entries_title': 'ASIENTOS QUE SE VAN A CREAR',
  'bank.reconciliation.post.no_entries': 'ninguno: la sesión no tiene ajustes que contabilizar',
  'bank.reconciliation.post.adopted': 'adoptado',
  'bank.reconciliation.post.new': 'nuevo',
  'bank.reconciliation.post.entry_ref': '· póliza {entry} · borrador {draft}',
  'bank.reconciliation.post.counterpart_note':
    'contrapartida de cada uno: la que fijó `bank adjustment create` en su borrador',
  'bank.reconciliation.post.sealed_title': 'Y LO QUE SE SELLA',
  'bank.reconciliation.post.sealed_lines':
    '{count, plural, one {línea de libros} other {líneas de libros}} contra la cuenta de mayor del banco',
  'bank.reconciliation.post.sealed_matches':
    '{count, plural, one {cotejo} other {cotejos}} contra el movimiento del extracto que las explica',
  'bank.reconciliation.post.sealed_items':
    '{count, plural, one {partida conciliatoria} other {partidas conciliatorias}} que el ajuste deja sin objeto',
  'bank.reconciliation.post.confirm_noop':
    'La sesión {session} ya está contabilizada y no se va a postear nada. ¿Continuar de todos modos?',
  'bank.reconciliation.post.confirm':
    'Vas a CONTABILIZAR {entries, plural, one {# asiento nuevo} other {# asientos nuevos}} en el ' +
    'mayor de la sesión {session} y sellar {lines, plural, one {# línea} other {# líneas}} de ' +
    'libros. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.reconciliation.post.summary':
    '· {status} · {posted, plural, one {# posteado} other {# posteados}} · ' +
    '{adopted, plural, one {# adoptado} other {# adoptados}} · ' +
    '{lines, plural, one {# línea sellada} other {# líneas selladas}} · ' +
    '{matches, plural, one {# cotejo} other {# cotejos}} · ' +
    '{items, plural, one {# partida resuelta} other {# partidas resueltas}}',
  'bank.reconciliation.post.seal_note':
    'El sello dice «este renglón ya está explicado por el banco», no «esta sesión terminó»: los ' +
    'cheques en circulación y los depósitos en tránsito siguen abiertos para el cotejo del mes que viene.',
  'bank.reconciliation.post.dry_run':
    'Ensayo: se contabilizó de verdad y se deshizo. No hay póliza en el libro.',
  'bank.reconciliation.generate.no_pdf_or_xlsx':
    '--format {format} no existe todavía: el proyecto no tiene dependencia de PDF ni de XLSX y no ' +
    'se le añade una para fingir un documento que acabaría en un expediente. Lo que hay: --format ' +
    'json (el estado entero, con las dos columnas y el resumen congelado), --format md|csv|tsv ' +
    '(el estado en renglones) y la salida de texto por omisión, que es la que se imprime y se archiva.',
  'bank.reconciliation.generate.title': 'ESTADO DE CONCILIACIÓN BANCARIA',
  'bank.reconciliation.generate.items_title': 'PARTIDAS CONCILIATORIAS',
  'bank.reconciliation.generate.drafts_caption': '(borradores)',
  'bank.reconciliation.generate.prepared_by': 'preparó',
  'bank.reconciliation.generate.approved_by': 'aprobó',
  'bank.reconciliation.generate.not_closed': 'sin cerrar',
  'bank.reconciliation.generate.not_approved': 'sin aprobar',

  // --- bank fee · interest · check ------------------------------------------
  'bank.skipped.title': 'OMITIDAS',
  'bank.entry_ref': '{description} · póliza {entry}',
  'bank.entry_number': 'póliza {entry}',
  'bank.no_description': 'sin descripción',
  'bank.entry_dry_run': '(ensayo)',
  'bank.posting.dry_run': 'Ensayo: se contabilizó de verdad y se deshizo; los ids salen en null.',
  'bank.fee.post.title': 'COMISIONES',
  'bank.fee.post.nothing_to_post': 'ningún cargo que contabilizar',
  'bank.fee.post.totals': 'totales: cargo {charge} · gasto {expense} · IVA {vat}',
  'bank.fee.post.confirm':
    'Vas a CONTABILIZAR {count, plural, one {# comisión} other {# comisiones}} del {from} al {to} ' +
    'en la cuenta {account}, por {total} (IVA {vat} a pendiente de acreditar). El mayor es ' +
    'inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.fee.post.fees': '{count, plural, one {# comisión} other {# comisiones}}',
  'bank.fee.post.summary':
    '· {posted, plural, one {# contabilizada} other {# contabilizadas}} · ' +
    '{skipped, plural, one {# omitida} other {# omitidas}} · cargo {charge} · IVA {vat}',
  'bank.fee.post.vat_pending_note':
    'El IVA queda en pendiente de acreditar: se acredita con `bank fee apply` cuando llegue el ' +
    'CFDI del banco, no aquí.',
  'bank.interest.post.title': 'INTERESES',
  'bank.interest.post.withholding': 'retención {rate}',
  'bank.interest.post.nothing_to_post': 'ningún abono que contabilizar',
  'bank.interest.post.totals': 'totales: bruto {gross} · retenido {withheld} · neto {net}',
  'bank.interest.post.confirm':
    'Vas a CONTABILIZAR {count, plural, one {# abono de interés} other {# abonos de interés}} del ' +
    '{from} al {to} en la cuenta {account}: {gross} de ingreso bruto y {withheld} de ISR retenido ' +
    'a favor. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.interest.post.credits':
    '{count, plural, one {# abono de interés} other {# abonos de interés}}',
  'bank.interest.post.summary':
    '· {posted, plural, one {# contabilizado} other {# contabilizados}} · ' +
    '{skipped, plural, one {# omitido} other {# omitidos}} · bruto {gross} · retenido {withheld}',
  'bank.interest.post.withholding_note':
    'El ISR retenido queda como pago provisional A FAVOR, no como gasto: es lo que se acredita ' +
    'contra el impuesto del ejercicio.',
  'bank.check.reconcile.title': 'EL MES EN QUE CAE EL ASIENTO',
  'bank.check.reconcile.label.check': 'cheque',
  'bank.check.reconcile.label.cleared_on': 'cobrado el',
  'bank.check.reconcile.check_value': '{check} · pago {payment}',
  'bank.check.reconcile.no_number': 'sin folio',
  'bank.check.reconcile.dated_by_bank':
    '(lo fecha el banco: movimiento {transaction}, {amount})',
  'bank.check.reconcile.no_open_period': 'sin periodo abierto en esa fecha',
  'bank.check.reconcile.no_period': 'sin periodo',
  'bank.check.reconcile.why':
    'por qué: bajo la LIVA el pago con cheque se entiende efectuado el día del COBRO y no el de ' +
    'la firma, así que el IVA de este pago se acredita en ese mes.',
  'bank.check.reconcile.entry_title': 'ASIENTO',
  'bank.check.reconcile.no_vat': 'ninguno: no hay IVA que reclasificar',
  'bank.check.reconcile.total': 'total reclasificado {amount}',
  'bank.check.reconcile.confirm':
    'Vas a registrar que el banco cobró el cheque {check} el {date} y a reclasificar {amount} de ' +
    'IVA en el periodo {period}. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.check.reconcile.already_cleared': 'cheque cobrado el {date}',
  'bank.check.reconcile.summary':
    '· cobrado el {date} · periodo {period} · IVA reclasificado {amount}',
  'bank.check.reconcile.dry_run': 'Ensayo: se registró el cobro de verdad y se deshizo.',
  'bank.transaction.show.unmatched': 'sin cotejar',
  'bank.match.create.summary':
    '· banco {bank} = libros {books} + ajustes {adjustments} · residual {residual} ({mode}) · ' +
    '{matches, plural, one {# cotejo} other {# cotejos}} · ' +
    '{sealed, plural, one {# partida sellada} other {# partidas selladas}}',
  // ==== fin del piloto bank (I7) ====================================
};
