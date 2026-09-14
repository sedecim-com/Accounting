// ============================================================
// EL CATÁLOGO FUENTE (I6 · issue #148)
//
// Aquí nacen las CLAVES. `es.ts` se declara `Record<keyof typeof EN, string>`,
// así que este archivo es el que manda: una clave que no exista aquí no puede
// existir allí, y una que exista aquí y falte allí es un error de `tsc` antes
// de que nadie corra una prueba. El orden de sincronía va en una sola
// dirección, y por eso hay un solo archivo `as const`.
//
// LAS TRECE CADENAS DE LA SIEMBRA SON REALES, y cada una lleva escrito de dónde
// salió. Ninguna es un `hello_world`: son mensajes que el CLI imprime HOY en
// español, elegidos porque tres de ellos se repiten palabra por palabra en dos
// y tres archivos distintos —`Sin cambios: el mayor no se tocó.` vive en
// `batch-command.ts:268`, `bank-command.ts:2010` y `prepaid-command.ts:1072`—,
// que es la señal de que una cadena ya era una clave y nadie lo había escrito.
//
// TRES DE ELLAS TRAEN EL DEFECTO QUE JUSTIFICA EL PLURAL PROPIO. El CLI de hoy
// resuelve el plural con `(s)`: `cancelado(s)` en `cfdi-command.ts:308`,
// `verificación(es)` en `diot-command.ts:744`, `bloqueante(s), aviso(s)` en
// `diot-command.ts:752`. Eso no es una elección de estilo, es la ausencia de un
// mecanismo: con uno, «1 CFDI cancelado» y «2 CFDI cancelados» se escriben cada
// uno en su rama, y el inglés —donde el plural cae en otro sitio de la frase—
// deja de ser inexpresable.
//
// LO QUE NO ENTRA EN EL CATÁLOGO, y es la mitad del contrato:
//
//   · NI SANGRÍAS NI `\n`. La cadena es la FRASE; el renglón, el margen y el
//     `⚠` los pone quien imprime. El original de `bank-command.ts:3362` trae
//     dos espacios delante y un salto detrás, y meterlos aquí obligaría a
//     traducir la maquetación de cada sitio de llamada.
//   · NI DINERO NI FECHAS FORMATEADOS. Un `{date}` llega ya como cadena, hecha
//     por el formateador de la jurisdicción (`src/i18n/format.ts`). El idioma
//     no decide el separador de miles: ésa es la regla 5 del epic —idioma ≠
//     formato ≠ jurisdicción— y confundirla es el error caro.
//   · NADA QUE VAYA A UNA AUTORIDAD. Ni un nombre de campo del SAT, ni un
//     código de la DIOT, ni un renglón del Anexo 24. Un artefacto que se
//     entrega no se traduce; aquí sólo hay prosa para el operador.
// ============================================================

export const EN = {
  // --- El kernel: confirmación y salida --------------------------------
  /** `src/cli/kernel/confirmacion.ts:76` (`noEntendi`, que ya la llama). El «y/s» del español
   *  es una gramática de DOS idiomas a la vez; en inglés sobra la mitad. */
  confirm_answer_not_understood:
    'did not understand “{answer}”: answer y or yes for yes, n or no for no',

  /** `src/cli/batch-command.ts:268`, `src/cli/bank-command.ts:2010` y
   *  `src/cli/prepaid-command.ts:1072`. Tres copias idénticas: la prueba de que
   *  esto ya era una clave. */
  no_changes_ledger_untouched: 'No changes: the ledger was not touched.',

  /** `src/cli/batch-command.ts:269`, `src/cli/bank-command.ts:2011`. El aborto
   *  que NO es un fallo: sin terminal se nombra `-y` por su nombre. */
  no_changes_no_terminal:
    'No changes: there is no terminal to confirm at. Add -y so `{command}` runs ' +
    'without asking, or --dry-run to see the full effect without writing anything.',

  // --- Los ensayos, que dicen qué se deshizo ---------------------------
  /** `src/cli/bank-command.ts:3362` y `:3456`. «Se escribió de verdad» no es
   *  una floritura: el ensayo corre la escritura y la revierte, y un operador
   *  que crea que no se tocó la base no entiende por qué avanzó una secuencia. */
  dry_run_rolled_back: 'Dry run: it really was written, and then rolled back.',

  /** `src/cli/asset-command.ts:432`. */
  dry_run_no_asset_created: 'Dry run: the transaction was rolled back. No asset was created.',

  /** `src/cli/prepaid-command.ts:1060`. */
  dry_run_ledger_untouched: 'Dry run: the ledger was not touched and no row was written.',

  // --- Los tres `(s)` que el plural propio viene a jubilar -------------
  /** `src/cli/cfdi-command.ts:308`, hoy `${n} CFDI cancelado(s)`. */
  cfdi_cancelled_by_issuer:
    '{count, plural, one {# CFDI cancelled} other {# CFDIs cancelled}} by the issuer: ' +
    'check the accounting effect with cfdi list --json',

  /** `src/cli/diot-command.ts:743-744`, hoy `las ${n} verificación(es) pedidas`. */
  diot_checks_passed:
    'no findings: the DIOT passes {count, plural, one {the # check} other {the # checks}} requested.',

  /** `src/cli/diot-command.ts:752-753`, hoy `bloqueante(s), aviso(s)`. Dos
   *  cuentas en una frase, cada una con su propia rama. */
  diot_findings_summary:
    '{blocking, plural, one {# blocker} other {# blockers}}, ' +
    '{warnings, plural, one {# warning} other {# warnings}}. ' +
    'A blocker stops the return from being filed.',

  // --- El único `select` de la siembra ---------------------------------
  /** `src/cli/prepaid-command.ts:374-380`: cuatro llamadas a `omitido(...)`, una
   *  por causa. Eran cuatro cadenas sueltas en cuatro renglones; como `select`
   *  son UNA clave, y el día que aparezca una quinta causa el compilador no
   *  dirá nada pero la rama `other` sí, que para eso es obligatoria. */
  prepaid_row_skipped:
    '{reason, select, ' +
    'coverage_not_started {coverage has not started yet} ' +
    'coverage_ended {coverage already ended} ' +
    'zero_month_row {the row for this month is zero} ' +
    'no_balance_left {there is no balance left to accrue} ' +
    'other {there is nothing to accrue this month}}',

  // --- Prosa de listado ------------------------------------------------
  /** `src/cli/prepaid-command.ts:887`. */
  prepaid_no_live_schedule: 'No live schedule in this entity.',

  /** `src/cli/prepaid-command.ts:888`. `{date}` llega YA formateada: el
   *  formato de fecha lo fija la jurisdicción de la entidad, no este catálogo. */
  prepaid_no_schedule_covers_date: 'No schedule covers {date}. Use -a to list them all.',

  /** `src/cli/bank-command.ts:3428`. */
  bank_run_hit_cap:
    'The run hit its cap: some movements were left unevaluated. Run it again.',
  // ====================================================================
  // I7 · EL CROMO DEL CLI, EL KERNEL Y LAS HOJAS DE `mnemosine.ts`
  // (issue #149)
  //
  // Tres bloques, y conviene saber cuál es cuál antes de tocarlos:
  //
  //   · `cli.chrome.*` — lo que Commander 15 maqueta SOLO: los cinco títulos
  //     que `Help.styleTitle` recibe (`help.js:454`, `:478`, `:494`, `:507`,
  //     `:524`), la descripción de `-h, --help` y de `help [command]`
  //     (`command.js:422` y `:2591`, la misma frase, y por eso UNA sola clave)
  //     y la de `-V, --version` (`command.js:2213`).
  //   · `cli.error.*` — los mensajes que Commander escribe por
  //     `_outputConfiguration.outputError`. Se traducen por RECONOCIMIENTO del
  //     texto que él arma, y sólo los cinco de aquí: ver el porqué y el límite
  //     en `src/cli/kernel/help.ts`.
  //   · `cli.flag.*`, `cli.risk.*`, `cli.entity.*`, `cli.output.*`,
  //     `cli.exit.*` — las cadenas del kernel (`src/cli/kernel/**`).
  //   · `help.<familia>.<hoja>.description` — la descripción de cada hoja que
  //     `src/cli/mnemosine.ts` registra por su cuenta. Las demás familias
  //     viven en sus propios archivos y NO están aquí; su adopción es otro
  //     tramo, y decirlo es más útil que insinuar que ya están.
  //
  // LAS DOS CARAS DE UNA DESCRIPCIÓN, Y POR QUÉ NO SON LA MISMA. Lo que se
  // guarda en el objeto de Commander (`Option.description`, `Command._description`)
  // sigue siendo el INGLÉS de estas claves, porque ese valor es superficie de
  // MÁQUINA: lo leen el censo de `scripts/ux-status.ts` (`prosaDe`, :467) y el
  // generador de `cli-reference.md`. Lo que se TRADUCE es el renderizado, en
  // `Help` — ver `src/cli/kernel/help.ts`. Una sola prosa, dos lectores.
  // ====================================================================

  // --- El cromo que Commander maqueta solo -----------------------------
  /** `node_modules/commander/lib/help.js:454`. */
  'cli.chrome.usage': 'Usage:',
  /** `help.js:478`. */
  'cli.chrome.arguments': 'Arguments:',
  /** `help.js:485` (el encabezado por omisión de un grupo de opciones). */
  'cli.chrome.options': 'Options:',
  /** `help.js:507`. */
  'cli.chrome.global_options': 'Global Options:',
  /** `help.js:515` (el encabezado por omisión de un grupo de comandos). */
  'cli.chrome.commands': 'Commands:',
  /** `command.js:422` y `command.js:2591`: la MISMA frase para `-h, --help` y
   *  para `help [command]`. Sale 389 veces en el árbol embarcado, una por
   *  nodo, y por eso es una clave y no dos. */
  'cli.chrome.help_description': 'display help for command',
  /** `command.js:2213`. */
  'cli.chrome.version_description': 'output the version number',

  // --- Los errores que Commander escribe por `outputError` -------------
  /** `command.js:2192`. */
  'cli.error.unknown_command': "error: unknown command '{name}'",
  /** `command.js:2147`. */
  'cli.error.unknown_option': "error: unknown option '{flag}'",
  /** `command.js:2047`. */
  'cli.error.missing_argument': "error: missing required argument '{name}'",
  /** `command.js:2059`. */
  'cli.error.option_missing_argument': "error: option '{flags}' argument missing",
  /** `command.js:2071`. */
  'cli.error.missing_mandatory_option': "error: required option '{flags}' not specified",
  /** El sufijo que Commander cuelga de los dos «unknown» (`command.js:2140`),
   *  y que `src/cli/mnemosine.ts` escribe también por su cuenta cuando la
   *  compuerta de la raíz ataja un tecleo antes de que Commander lo vea. */
  'cli.error.did_you_mean': '(Did you mean {suggestion}?)',
  /** `suggestSimilar.js:93`: la forma con empate. Va aparte y no como un
   *  `{suggestion}` con la lista dentro porque «one of» es prosa, y metida en
   *  el parámetro viajaría en inglés dentro de la frase española. */
  'cli.error.did_you_mean_one_of': '(Did you mean one of {suggestions}?)',

  // --- El diccionario de banderas (`src/cli/kernel/flags.ts`) ----------
  'cli.flag.entity': 'legal entity to operate on (defaults to the active one)',
  'cli.flag.tenant_scope': 'tenant (firm) whose data to scope to',
  'cli.flag.user': 'acting user, for attribution and permissions',
  'cli.flag.format': 'output format',
  'cli.flag.json': 'shorthand for --format json',
  'cli.flag.output': 'write to a file instead of stdout',
  'cli.flag.fields': 'comma-separated columns; with no value, lists the available ones',
  'cli.flag.quiet': 'identifiers only, one per line, for piping',
  'cli.flag.limit': 'maximum rows to return',
  'cli.flag.offset': 'skip this many rows',
  'cli.flag.status': 'filter by lifecycle state (repeatable)',
  'cli.flag.all': 'no default limit; include archived and closed',
  'cli.flag.period':
    'period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06',
  'cli.flag.since': 'inclusive lower bound (YYYY-MM-DD)',
  'cli.flag.until': 'inclusive upper bound (YYYY-MM-DD)',
  'cli.flag.as_of': 'valuation/balance date (YYYY-MM-DD)',
  'cli.flag.date_basis': 'which date the filters apply to',
  'cli.flag.strict': 'treat warnings as blocking (exit 4)',
  'cli.flag.force':
    'override a blocking validation (closed period, lock date, duplicate); requires --reason',
  'cli.flag.note': 'free annotation stored with the record',

  /** `src/cli/kernel/flags.ts:parsePositiveInt`. */
  'cli.flag.error_not_whole_number':
    '{name} must be a non-negative whole number; got "{value}".',
  /** `src/cli/kernel/flags.ts:parseDate`. */
  'cli.flag.error_not_date': '{name} must be a date as YYYY-MM-DD; got "{value}".',

  // --- Las banderas que inyecta la declaración de riesgo (risk.ts) -----
  'cli.flag.dry_run':
    'compute and show the full effect; write nothing and call nothing external',
  'cli.flag.yes': 'skip the confirmation prompt',
  'cli.flag.idempotency_key':
    'client dedupe key, stored on success: a retry with the same key and payload returns ' +
    'the recorded result',
  /** La bandera que se acepta y NO se honra: la hoja lo dice en su ayuda en
   *  vez de fingir. `src/cli/kernel/risk.ts`. */
  'cli.flag.idempotency_key_unhonored':
    'NOT honored by this command yet: a retry writes again instead of returning the ' +
    'recorded result',
  /** La que no hace falta porque el dominio ya deduplica. */
  'cli.flag.idempotency_key_unneeded':
    'not needed: this command already deduplicates on the state it writes; accepted and ignored',
  'cli.flag.live': 'perform the real external effect (default is the sandbox endpoint)',
  'cli.flag.reason': 'justification recorded in the audit trail (required)',

  // --- La compuerta de mutación (`src/cli/kernel/risk.ts`) -------------
  /** El `{command}` es la RUTA de la hoja, no su nombre suelto: hay más de un
   *  `apply` en el árbol. */
  'cli.risk.key_not_honored':
    '"{command}" accepts --idempotency-key because its risk class demands it, but DOES NOT ' +
    'HONOR IT YET: {reason}. The key "{key}" would deduplicate nothing: a retry would write ' +
    'again. Run it again WITHOUT the key after checking the state of the domain it touches ' +
    '(the document, the balance or the entry), or repeat it with --dry-run to see what it would do.',
  'cli.risk.undeclared':
    '"{command}" asks for a mutation gate without having declared its risk. Every leaf that ' +
    'mutates declares with `declareRisk` next to its registration; with no declaration there ' +
    'is no confirmation, no dry run, and no audit trail to speak of.',
  'cli.risk.force_needs_reason':
    '--force overrides a safety rule, so it requires --reason "<why>". The reason is written ' +
    'to the audit trail.',
  'cli.risk.undo_needs_reason':
    '"{command}" undoes or overrides something, so it requires --reason "<why>".',
  /** `src/cli/kernel/riesgos-retrofit.ts`, dentro del `preAction` que la tabla
   *  engancha. Es el ÚNICO texto de ese archivo que sale por pantalla: sus
   *  `writes` no los imprime nadie y por eso están en inglés ahí mismo, no
   *  aquí. `{flags}` llega ya unido con comas — una conjunción es gramática y
   *  no cabe en un `join` del sitio de llamada. */
  'cli.risk.gate_flags_not_honored':
    '"{command}" accepts {flags} but its handler does not honor them yet: it would really run ' +
    'while the flag promises the opposite. It is refused instead of pretending. (The flag ' +
    'exists because the risk class demands it; wiring the handler is CLI-F2 work.)',

  // --- La entidad activa (`src/cli/kernel/entity-context.ts`) ----------
  /** Dos causas, dos remedios opuestos: `entity use` NECESITA la base, así que
   *  ofrecerlo ante una conexión caída manda al usuario a otro fallo igual. */
  'cli.entity.database_unreachable':
    'Could not reach the database while resolving the active entity ({entity}): {detail}',
  'cli.entity.database_unreachable_remedy':
    'mnemosine doctor   (and check DATABASE_URL in .env)',
  'cli.entity.pinned_unresolved': 'The pinned entity ({entity}) could not be resolved: {detail}',
  'cli.entity.pinned_unresolved_remedy':
    'mnemosine entity use <id|name>   (or `mnemosine entity unset` to clear it)',
  /** Se dice en las dos ramas: el pin NO se borra por un fallo al resolverlo. */
  'cli.entity.pin_was_kept': 'The pinned entity was kept.',
  'cli.entity.must_be_named':
    'This command changes data, so it will not guess the entity. Name it with ' +
    '--entity <id|name> or pin one with `mnemosine entity use`.',

  // --- El renderizador (`src/cli/kernel/output.ts`) --------------------
  'cli.output.unknown_format': 'Unknown --format "{value}". Use one of: {formats}.',
  'cli.output.unknown_fields': 'Unknown field(s): {unknown}. Available: {available}.',

  // --- La salida (`src/cli/kernel/exit.ts`) ----------------------------
  /** El aborto por decisión del usuario, que NO es un fallo. */
  'cli.exit.aborted': 'Aborted.',

  // --- La raíz y sus dos banderas globales -----------------------------
  'help.root.description': 'AI accounting assistant — converse with your accounting from the terminal',
  'cli.flag.tenant_root':
    'Tenant to operate on. Precedence: this flag > MNEMOSINE_TENANT > mnemosine.config.json. ' +
    'Scopes EVERY query via RLS',
  /** Los escalones se nombran con parámetros y no a mano: la lista de locales
   *  y los nombres de las variables viven en `src/i18n/locale.ts` y una copia
   *  escrita aquí se desincronizaría en silencio. */
  'cli.flag.locale':
    'Language and formatting of what is PRINTED ({locales}). Precedence: this flag > {envVar} ' +
    '({envAlias} is a permanent alias) > ~/.mnemosine/config.json > ./mnemosine.config.json > ' +
    'the tenant setting > {fallback}. Never changes what is filed with an authority',

  // --- Las hojas que `src/cli/mnemosine.ts` registra por su cuenta ------
  'help.entities.description':
    'Lists the active legal entities (deprecated: use `mnemosine entity list`)',
  'help.providers.description':
    'Lists the configured model providers (built-in + mnemosine.config.json)',
  'help.ask.description': 'Asks a single question and exits',
  'help.chat.description': 'Opens an interactive chat session (default)',
  'help.sessions.description':
    'Lists recent chat sessions (resume one with: mnemosine chat --resume <id>)',
  'help.drafts.description': 'Lists the journal entry drafts created by the AI',
  'help.review.description':
    'Reviews pending drafts: approve (creates and posts the journal entry), correct then ' +
    'approve, or reject — a rejection can seed the criterion for next time',
  'help.ingest.description':
    'Batch ingestion of CFDIs (XML): rules → AI classification → drafts (or auto-post by thresholds)',
  'help.lang.description':
    "Shows or sets the language of the AGENT's answers (CLI UI stays English; Spanish command " +
    'aliases always work)',
  'help.onboard.description':
    "Imports a client's accounting from an external system (chart of accounts + opening balances)",
  'help.outbox.description':
    'Operations queued for external accounting systems: list, review and execute',
  'help.outbox.list.description': 'List queued external operations (default: pending)',
  'help.outbox.run.description':
    "Execute queued operations against the client's external system (the real effect requires --live)",
  'help.question.description':
    "The agent's pending questions: list, answer (saved as a precedent) or dismiss",
  'help.question.list.description': "List the agent's questions (default: pending)",
  'help.question.answer.description':
    'Answer a question (the answer is saved as a precedent), or work the pending queue',
  'help.login.description': 'Signs in with your identity provider (OIDC)',
  'help.logout.description': 'Deletes the stored credential',
  'help.whoami.description': 'Shows the active credential and its validity',
  'help.subscription.description':
    'Outbound event subscriptions: who we notify, and what we could not deliver',

  // ==== I7 · EL PILOTO: `src/cli/bank-command.ts` (issue #149) =====

  // Las cadenas que `bank`/`banco` imprime PARA UNA PERSONA. Lo que NO está
  // aquí, y se decidió midiendo (ver el informe de I7): `declareRisk({ writes })`
  // —19 literales, contados con `grep -c 'writes:' src/cli/bank-command.ts`—
  // porque ningún archivo de `src/` ni de `scripts/` lo imprime, sólo lo
  // afirman pruebas; los nombres de columna y la lista de `--fields`,
  // que son el contrato de `--json`; los alias españoles de comando, que D9 R8
  // manda conservar; y los bloques de `EJEMPLOS`, congelados por
  // `src/ai/docs/cli-reference.md`.
  // --- Los analizadores de bandera: uso (2), no validación (4) ---------
  'bank.parse.date_invalid': '{flag} must be a real date in YYYY-MM-DD form; got "{value}".',
  'bank.parse.amount_invalid': '{flag} must be a decimal amount; got "{value}".',
  'bank.parse.rate_invalid': '{flag} must be a decimal rate; got "{value}".',
  'bank.parse.rate_out_of_range':
    '{flag} goes between 0 and 1, not as a percentage: 0.16 for 16%, 0.0125 for 1.25%, 0 for ' +
    'none. Got "{value}".',
  'bank.parse.account_type_unknown':
    '--type "{value}" is not an account type. The five are: {types}.',
  'bank.parse.account_status_unknown':
    '--status {values} does not exist for a bank account: only active and archived.',
  'bank.parse.transaction_status_unknown':
    '-s {values} does not exist for a bank transaction: only matched and unmatched. The rest of ' +
    'its state —which statement it came from, what explains it— is read with `bank transaction show`.',
  'bank.parse.unmatched_contradicts_status':
    '--unmatched and `-s matched` ask for opposite things. --unmatched is the shorthand for ' +
    '`-s unmatched`: pass one of the two.',
  'bank.parse.direction_unknown':
    '--direction "{value}" does not exist: in is money coming in (positive amount) and out is money going out.',
  'bank.parse.id_list_empty': '{flag} arrived empty: name at least one identifier.',
  'bank.parse.id_list_invalid':
    '{flag} {values} is not an identifier: comma-separated uuids are expected, like the ones ' +
    '`bank transaction list -q` prints.',
  'bank.parse.uuid_invalid': '{flag} "{value}" is not an identifier: a uuid is expected.',
  'bank.parse.matchable_type_unknown':
    '"{value}" is not a matchable type. The five are: {types}. Write <type>:<id>, or just <id> ' +
    'for a journal entry line.',
  'bank.parse.book_item_uuid_missing':
    '--book-item "{value}" carries no valid identifier after the type.',
  'bank.parse.residual_unknown':
    '--residual "{value}" does not exist. keep leaves the residual alive as a reconciling item; ' +
    'write-off cancels it against whatever account --write-off-account names.',
  'bank.parse.unapply_reason_required':
    '--reason is mandatory and it is a CODE, not prose: {codes}. A closed taxonomy is what lets ' +
    'you ask how many matches were undone for a cancelled document this quarter; a free-text ' +
    'field answers that with a grep.',
  'bank.parse.item_type_unknown':
    '--type "{value}" is not a reconciling item type. The six are: {types}.',
  'bank.parse.adjustment_type_unknown':
    '--type "{value}" is not a reconciliation adjustment type. The five are: {types}.',
  'bank.parse.run_step_unknown':
    '--stop-at "{value}" is not a step of the guided pass. The five, in order: {steps}. None of ' +
    'them reaches `approve` or `post`.',
  'bank.parse.session_status_one_only':
    '-s takes one status at a time on this leaf ({count} arrived): {statuses}. Without the flag ' +
    'all four come out.',
  'bank.parse.session_status_unknown':
    '-s "{value}" is not a reconciliation session status. The four are: {statuses}.',
  'bank.parse.item_status_unknown':
    '-s {values} does not exist for a reconciling item: only open and resolved. A resolved item ' +
    'stopped explaining a difference, and that is why it does not come out by default.',
  'bank.query.unclosed_quote': 'The query "{query}" opens a quote and does not close it.',
  'bank.query.term_unknown':
    'The query does not know the term "{term}:". The ones that exist are {terms}, and a word ' +
    'with no prefix searches the description. The rest is narrowed with flags (--account, ' +
    '--since, --until, --direction, --type).',
  'bank.query.term_without_value': 'The term "{term}" carries no value: write {key}:<value>.',
  'bank.query.amount_invalid':
    '"amt:{value}" is not an amount. The form is amt:250, amt:>1000, amt:<=99.99 or amt:-250 ' +
    '(with a sign it compares the amount as it stands; without one, the magnitude).',
  'bank.query.narrows_nothing':
    'The query "{query}" narrows nothing. Name at least one term ({terms}), or drop it to list everything.',

  // --- Lo que comparten todas las hojas de la familia -------------------
  /** El `(s)` de `fila(s)` era la ausencia del plural, no una elección. */
  'bank.list.hit_limit':
    'Listed {count, plural, one {# row} other {# rows}}, which is the --limit cap: there may be ' +
    'more. Raise --limit, or use --all on `{command}`.',
  'bank.offset.unsupported':
    '--offset is not implemented in this family: the query orders and caps with --limit, with no ' +
    'stable cursor. {alternative}',
  'bank.offset.narrow_accounts': 'Narrow with [query], --type or --currency, or ask for everything with --all.',
  'bank.offset.narrow_statements': 'Narrow with --account, --since or --until.',
  'bank.offset.narrow_sessions': 'Narrow with --account, --period or -s, or ask for everything with --all.',
  'bank.confirm.taken_as_no': '{reason}; I take it as a no.',
  'bank.aborted.no_changes': 'No changes.',
  'bank.idempotency.hit':
    'Idempotency hit: the key "{key}" already consummated this act — {what}. Nothing ran a second ' +
    'time; this is the recorded result.',

  // --- bank account -----------------------------------------------------
  'bank.account.create.dry_run':
    'Dry run: the insert really did run —unique index included— and was rolled back. Nothing was written.',
  /** La etiqueta de la ficha, no el valor de `account_type`: ese es dato. */
  'bank.account.show.liability': 'LIABILITY',
  // LOS ROTULOS DE LA FICHA DE `bank account show`.
  //
  // Estaban escritos en inglés dentro del archivo, y el carril del idioma no
  // los veía porque el carril mide ESPAÑOL: una etiqueta inglesa sin clave es
  // exactamente la misma deuda que una española —el operador que pide es-MX
  // lee la ficha en inglés— y sólo se distingue en que nadie la contaba.
  //
  // CLABE, IBAN y SWIFT/BIC NO ENTRAN, por la misma razón que `hash` no entró
  // en `bank.reconciliation.approve.*`: son los nombres de tres estándares,
  // se escriben igual en los dos idiomas, y una clave cuya traducción es la
  // fuente copiada es lo que `tests/i18n/sync.spec.ts` §5 rechaza por su
  // nombre. Se quedan como literales en el sitio de llamada, dicho allí.
  'bank.account.show.label.account_number': 'Account number',
  'bank.account.show.label.routing': 'Routing',
  'bank.account.show.label.sat_bank_key': 'SAT bank key',
  'bank.account.show.label.gl_account': 'GL account',
  'bank.account.show.label.book_balance': 'Book balance',
  'bank.account.show.label.bank_balance': 'Bank balance',
  'bank.account.show.label.difference': 'Difference',
  'bank.account.show.label.last_reconciled': 'Last reconciled',
  'bank.account.show.label.status': 'Status',
  /** El routing no se enseña nunca: sólo se dice que está, y que va cifrado. */
  'bank.account.show.routing_on_file': 'on file (encrypted)',
  'bank.account.show.gl_unmapped': 'unmapped',
  'bank.account.show.bank_balance_never_synced': 'never synced',
  'bank.account.show.never_reconciled': 'never',
  'bank.account.show.status_active': 'active',
  'bank.account.show.status_archived': 'archived',
  'bank.account.edit.nothing_to_change':
    'Nothing to change. Pass --name, --bank, --branch, --type, --currency, --clabe, ' +
    '--account-number, --routing-ach, --routing-wire, --sat-bank-code, --swift or --iban.',
  'bank.account.edit.reason_required':
    '{fields} changes one of the identifiers the money leaves by ({sensitive}): it requires ' +
    '--reason "<why>". The reason is kept in the audit trail, which is append-only.',
  'bank.account.edit.confirm': 'You are about to change {fields} of "{account}". Continue?',
  'bank.account.edit.nothing_changed': 'Nothing changed: the values were already those.',
  'bank.account.edit.fields_changed': '{count, plural, one {# field} other {# fields}}',
  'bank.account.edit.dry_run': 'Dry run: the UPDATE really did run and was rolled back.',
  'bank.account.set.already_mapped':
    '{account} was already mapped to {gl}: nothing to write.',
  'bank.account.set.forced':
    'FORCED over {count, plural, one {# posted line} other {# posted lines}}',

  // --- bank statement ----------------------------------------------------
  'bank.dir.unreadable': 'Could not read --dir {dir}: {error}',
  'bank.dir.no_files': '--dir {dir} has no files to import.',
  'bank.import.no_file': 'Which file. Pass it as an argument or point at a folder with --dir.',
  'bank.import.counts':
    '{added, plural, one {# new} other {# new}}, ' +
    '{duplicated, plural, one {# already there} other {# already there}}',
  'bank.import.findings':
    '{file}: {count, plural, one {# integrity finding} other {# integrity findings}}. They are ' +
    'in staging all the same — it is `bank statement check` that exits 4.',
  'bank.import.dry_run': 'Dry run: it was parsed, it was checked, and the write was rolled back.',
  'bank.import.staging_note':
    'Bank staging: none of this is in the ledger until it is matched and reconciled.',
  'bank.statement.list.status_not_applicable':
    '-s/--status does not apply to a bank statement: it has no lifecycle state. Its verdict is ' +
    'computed as it is read (the `chain` column), and what judges it is `bank statement check`, ' +
    'which exits 4.',
  'bank.statement.list.broken_chains':
    '{count, plural, one {# statement} other {# statements}} with a broken balance chain. ' +
    '`bank statement check` says which test failed and exits 4.',
  'bank.statement.show.line_count_mismatch':
    'The document carries {document, plural, one {# line} other {# lines}} and the database ' +
    'attributes {stored} to it: the missing ones were inferred against an earlier statement and ' +
    "keep that one's statement_id.",
  'bank.statement.show.lines_omitted':
    '{count, plural, one {# more line was} other {# more lines were}} not listed. Raise --limit.',
  'bank.statement.check.skipped':
    '{count, plural, one {# more statement} other {# more statements}} met the filter and were ' +
    'not checked: the run has a cap. Narrow with --account or with --since.',

  // --- bank transaction · book-item · match -------------------------------
  'bank.transaction.show.no_extractors':
    'No extractors yet ({fields}): what the bank wrote is in --raw. `bank transaction apply` will ' +
    'fill them in.',
  'bank.book_item.oldest_unseen':
    'The oldest one has gone {days, plural, one {# day} other {# days}} without showing up at the ' +
    'bank ({entry}). A check issued and never cashed lives here and never on the statement.',
  'bank.match.preview.needs_target':
    'Preview needs to know about what: pass a transaction id, or --account to sweep the unmatched ' +
    'ones of an account.',
  'bank.match.preview.no_proposal': 'no proposal',
  'bank.match.preview.candidate': 'confidence {confidence} · rule {rule}',
  'bank.match.preview.label.amount': 'amount',
  'bank.match.preview.label.date': 'date',
  'bank.match.preview.label.description': 'description',
  'bank.match.preview.label.period': 'period',
  'bank.match.preview.label.verdict': 'verdict',
  'bank.match.preview.amount_signal':
    '{bank} vs {candidate} · difference {difference} · exact {exact} · same direction {sameDirection}',
  'bank.match.preview.date_signal':
    '{days, plural, one {# day} other {# days}} · within window {withinWindow}',
  'bank.match.preview.description_signal': 'similarity {similarity}',
  'bank.match.preview.soft_signal': '(soft signal: never applies on its own)',
  'bank.match.preview.would_apply': '`run` would apply it',
  'bank.match.preview.not_applied': 'not applied',
  'bank.match.preview.summary':
    '{count, plural, one {movement} other {movements}} · {applicable} that `bank match run` would apply.',
  'bank.match.preview.hit_top':
    '{count} were previewed, which is the --top cap: there may be more.',
  'bank.match.applied': '{count, plural, one {# applied} other {# applied}}',
  'bank.match.run.tally':
    '· {already, plural, one {# already was} other {# already were}} · ' +
    '{skipped, plural, one {# skipped} other {# skipped}} · ' +
    '{evaluated, plural, one {# evaluated} other {# evaluated}}',
  'bank.match.apply.tally':
    '· {already, plural, one {# already was} other {# already were}} · ' +
    '{skipped, plural, one {# skipped} other {# skipped}}',
  'bank.match.apply.stdin_empty':
    'Standard input brought no id. `bank match preview -q` spits them out one per line.',
  'bank.match.apply.no_transactions':
    'Which transactions. Pass them as arguments, or pipe `bank match preview -q | mnemosine bank ' +
    'match apply --stdin`.',
  'bank.match.apply.confirm':
    'You are about to apply the match the engine proposes for ' +
    '{count, plural, one {# movement} other {# movements}}. Continue?',
  'bank.match.apply.no_terminal':
    'No changes: there is no terminal to confirm at (standard input is the pipe). Add -y to apply ' +
    'without asking.',
  'bank.match.create.write_off_declared':
    'The residual of {amount} is DECLARED written off against the account, but it is not posted: ' +
    'there is no journal entry behind it yet. Record it by hand or wait for F05c.',
  'bank.match.create.dry_run': 'Dry run: the group really was written, and then rolled back.',
  'bank.match.unapply.confirm':
    'You are about to unapply match {match} and every match in its group (the identity ' +
    'Σbank = Σbooks + Σadjustments does not survive having a leg taken off it). Continue?',
  'bank.match.unapply.closed':
    '{count, plural, one {# match closed} other {# matches closed}}',
  'bank.match.unapply.released':
    '· {transactions, plural, one {# transaction} other {# transactions}} and ' +
    '{items, plural, one {# item} other {# items}} back in the flow · reason {reason}',
  'bank.match.unapply.group': 'group {group}',
  'bank.match.unapply.closure_note':
    'Closure, not deletion: the row stays in the file with its reason, because the auditor asks ' +
    'why it was undone and a deleted row does not answer.',
  'bank.match.unapply.dry_run': 'Dry run: it really was closed, and then rolled back.',

  // --- bank reconciliation: la aritmética de dos lados ---------------------
  /** Un lado que nadie observó. NUNCA la palabra «cero». */
  'bank.reconciliation.not_observed': 'not observed',
  'bank.reconciliation.side.bank': 'BANK',
  'bank.reconciliation.side.books': 'BOOKS',
  'bank.reconciliation.label.statement_balance': 'statement balance',
  'bank.reconciliation.label.book_balance': 'book balance',
  'bank.reconciliation.label.adjusted': '= adjusted',
  'bank.reconciliation.label.variance': 'VARIANCE',
  'bank.reconciliation.variance_not_computed': 'NOT COMPUTED',
  'bank.reconciliation.variance_missing_side':
    'It is not zero: it is that a side is missing. A zero here would mean «nobody subtracted anything».',
  'bank.reconciliation.tolerance_line': 'tolerance {tolerance} · policy {policy}',
  'bank.reconciliation.counters.items_label': 'items',
  'bank.reconciliation.counters.items':
    '{total} · {unclassified} unclassified · {undated} undated · ' +
    '{resolved, plural, one {# resolved} other {# resolved}}',
  'bank.reconciliation.counters.statement_label': 'statement',
  'bank.reconciliation.counters.unexplained':
    '{count, plural, one {# movement} other {# movements}} with no match and no item ({amount})',
  'bank.reconciliation.frozen.title': 'FROZEN SUMMARY',
  'bank.reconciliation.frozen.caption': '(the assertion, not the answer)',
  'bank.reconciliation.frozen.never_computed':
    'nobody has done the arithmetic of this session: the row keeps variance {variance} by DEFAULT',
  'bank.reconciliation.frozen.line':
    'variance {variance} · books {books} · checks {checks} · deposits {deposits} · ' +
    'charges {charges} · credits {credits} · other {other}',
  'bank.reconciliation.frozen.computed_on': 'computed on {date}',
  'bank.reconciliation.frozen.drifted':
    'the live arithmetic says {live} and the session asserted {frozen}: something changed ' +
    'underneath since it was closed.',
  'bank.reconciliation.ready_to_close': 'ready for `bank reconciliation close`.',
  'bank.reconciliation.whats_missing': 'WHAT IS MISSING',
  'bank.reconciliation.session_label': 'session {session}',
  'bank.reconciliation.run.file_flags_without_file':
    '--format and --profile describe the file of --file, and there is no file. Pass --file, or ' +
    'drop them to take the statement already imported.',
  'bank.reconciliation.run.dry_run':
    'Dry run: the steps that write really did run, and were rolled back.',
  'bank.reconciliation.open.summary':
    'opening balance {opening} · bank close {closingBank} {currency} · statement {statement}',
  'bank.reconciliation.open.continues': 'continues {session}',
  'bank.reconciliation.open.no_arithmetic_yet':
    'The session is born with no arithmetic (`arithmetic_computed_at` NULL): `bank reconciliation ' +
    'status` computes it live and `close` signs it. None of this touches the ledger.',
  'bank.reconciliation.open.dry_run':
    'Dry run: the session really was opened —continuity included— and was rolled back.',
  'bank.reconciliation.list.variance_blank':
    '{count, plural, one {# session} other {# sessions}} with the variance blank: nobody has done ' +
    "its arithmetic. The row's column is 0 by DEFAULT and that is why it is not printed.",
  'bank.reconciliation.status.needs_target':
    'Say which session: `bank reconciliation status <session>`, or --account for the one in ' +
    'progress on that account.',
  'bank.reconciliation.status.two_ways':
    'The identifier and --account say the same thing two ways: give one of the two. With ' +
    '--account the IN-PROGRESS session of that account is read.',
  'bank.reconciliation.status.statement_line':
    'statement {statement} · declared by the bank {declared} · opening balance {opening}',
  'bank.reconciliation.status.no_statement':
    'no statement attached: the bank balance CANNOT be observed',
  'bank.reconciliation.status.items_title': 'ITEMS',
  'bank.reconciliation.status.adjustments_title': 'ADJUSTMENTS',
  'bank.reconciliation.status.adjustments_caption': '(drafts: nothing posted itself)',

  // --- bank reconciling-item · adjustment · close · approve ----------------
  'bank.item.list.ageing':
    'The oldest one has been open {days, plural, one {# day} other {# days}}. ' +
    '{overdue, plural, one {# overdue} other {# overdue}} and {undated} with no expected date: an ' +
    'item with no date is not chased, it ages.',
  'bank.item.assign.expected_contradiction':
    '`--expected` and `--clear-expected` ask for opposite things: either a date is set or it is cleared.',
  'bank.item.assign.nothing_to_assign':
    'There is nothing to assign: name at least --owner, --expected, --clear-expected, ' +
    '--escalation or --note.',
  'bank.item.assign.escalation_unknown': '--escalation takes {values}; got "{value}".',
  'bank.adjustment.create.summary':
    '· {type} · {amount} · counterpart {account} · bank {bankAccount} · draft {draft}',
  'bank.adjustment.create.draft_note':
    'It is a DRAFT: wait for `mnemosine review`. `journal_entry_id` stays NULL until ' +
    '`bank reconciliation post` (F05d) posts it behind a signature.',
  'bank.reconciliation.close.refused':
    'Session {session} does not close: variance {variance}, ' +
    '{unclassified, plural, one {# unclassified item} other {# unclassified items}} and ' +
    '{undated} undated.',
  'bank.reconciliation.close.variance_missing_side': 'NOT COMPUTED (not zero: a side is missing)',
  'bank.reconciliation.close.what_balanced_would_claim':
    'Marking it "balanced" with this open would tell the close dashboard that the cash of this ' +
    'account is verified against the bank.',
  'bank.reconciliation.close.confirm':
    'You are about to sign that account {account} agrees with the bank as of {until} ' +
    '(variance {variance}). `period-close` will read it as the evidence that the cash was ' +
    'verified. Continue?',
  'bank.reconciliation.close.no_terminal':
    'No changes: there is no terminal to confirm at. Add -y to close without asking.',
  'bank.reconciliation.close.summary':
    '· {status} · variance {variance} · bank adjusted {bankAdjusted} = books adjusted {booksAdjusted}',
  'bank.reconciliation.close.frozen_summary':
    'frozen summary: books {books} · checks {checks} · deposits {deposits} · charges {charges} · ' +
    'credits {credits} · other {other}',
  'bank.reconciliation.close.arithmetic_stamp':
    'Arithmetic computed on {date}. Balanced is NOT approved and NOT posted: `approve` requires ' +
    'that the approver is not the preparer, and `post` is what moves the ledger.',
  'bank.reconciliation.close.dry_run': 'Dry run: it really was closed, and then rolled back.',
  'bank.reconciliation.approve.title': 'WHAT IS ABOUT TO BE SIGNED',
  'bank.reconciliation.approve.label.session': 'session',
  'bank.reconciliation.approve.label.account': 'account',
  'bank.reconciliation.approve.label.statement': 'statement',
  'bank.reconciliation.approve.label.variance': 'variance',
  'bank.reconciliation.approve.label.members': 'members',
  'bank.reconciliation.approve.label.segregation': 'segregation',
  'bank.reconciliation.approve.no_statement': 'none attached to the session',
  'bank.reconciliation.approve.variance_value': '{live} (frozen at close: {frozen})',
  'bank.reconciliation.approve.members_value':
    '{items, plural, one {# item} other {# items}} · ' +
    '{matches, plural, one {# match} other {# matches}} · ' +
    '{adjustments, plural, one {# adjustment} other {# adjustments}}',
  'bank.reconciliation.approve.segregation_value': 'prepared by {preparer} · policy {policy}',
  'bank.reconciliation.approve.nobody_recorded': 'nobody recorded',
  'bank.reconciliation.approve.policy_default': '(by default)',
  'bank.reconciliation.approve.confirm':
    'You are about to SIGN session {session} with snapshot {hash}… ' +
    '({items, plural, one {# item} other {# items}}, ' +
    '{adjustments, plural, one {# adjustment} other {# adjustments}}, variance {variance}). ' +
    'A signature is not withdrawn: approving it again is refused. Continue?',
  'bank.reconciliation.approve.already_signed': 'session {session} already signed',
  'bank.reconciliation.approve.summary': '· {status} · signed by {by} on {on}',
  'bank.reconciliation.approve.not_posted_yet':
    'Approved is NOT posted: the ledger is moved by `bank reconciliation post`, which posts the ' +
    'adjustments this signature has just frozen.',
  'bank.reconciliation.approve.dry_run':
    'Dry run: it really was signed, and then rolled back. The hash is the one that would remain.',

  // --- bank reconciliation post · generate --------------------------------
  'bank.reconciliation.post.already_posted': 'The session is already posted',
  'bank.reconciliation.post.already_posted_detail':
    '{count, plural, one {# entry} other {# entries}} in the book and nothing to post.',
  'bank.reconciliation.post.already_posted_short': 'session {session} already posted',
  'bank.reconciliation.post.entries_title': 'ENTRIES ABOUT TO BE CREATED',
  'bank.reconciliation.post.no_entries': 'none: the session has no adjustments to post',
  'bank.reconciliation.post.adopted': 'adopted',
  'bank.reconciliation.post.new': 'new',
  'bank.reconciliation.post.entry_ref': '· entry {entry} · draft {draft}',
  'bank.reconciliation.post.counterpart_note':
    'the counterpart of each one: whatever `bank adjustment create` set in its draft',
  'bank.reconciliation.post.sealed_title': 'AND WHAT GETS SEALED',
  'bank.reconciliation.post.sealed_lines':
    '{count, plural, one {book line} other {book lines}} against the bank GL account',
  'bank.reconciliation.post.sealed_matches':
    '{count, plural, one {match} other {matches}} against the statement movement that explains them',
  'bank.reconciliation.post.sealed_items':
    '{count, plural, one {reconciling item} other {reconciling items}} the adjustment leaves without object',
  'bank.reconciliation.post.confirm_noop':
    'Session {session} is already posted and nothing will be posted. Continue anyway?',
  'bank.reconciliation.post.confirm':
    'You are about to POST {entries, plural, one {# new entry} other {# new entries}} into the ' +
    'ledger of session {session} and seal {lines, plural, one {# book line} other {# book lines}}. ' +
    'The ledger is immutable: this is only corrected by reversal. Continue?',
  'bank.reconciliation.post.summary':
    '· {status} · {posted, plural, one {# posted} other {# posted}} · ' +
    '{adopted, plural, one {# adopted} other {# adopted}} · ' +
    '{lines, plural, one {# line sealed} other {# lines sealed}} · ' +
    '{matches, plural, one {# match} other {# matches}} · ' +
    '{items, plural, one {# item resolved} other {# items resolved}}',
  'bank.reconciliation.post.seal_note':
    'The seal says «this line is already explained by the bank», not «this session is over»: ' +
    'outstanding checks and deposits in transit stay open for next month’s matching.',
  'bank.reconciliation.post.dry_run':
    'Dry run: it really was posted, and then rolled back. There is no journal entry in the book.',
  'bank.reconciliation.generate.no_pdf_or_xlsx':
    '--format {format} does not exist yet: the project has no PDF or XLSX dependency and one is ' +
    'not added to fake a document that would end up in a file. What there is: --format json (the ' +
    'whole state, with both columns and the frozen summary), --format md|csv|tsv (the state as ' +
    'rows) and the default text output, which is the one that is printed and archived.',
  'bank.reconciliation.generate.title': 'BANK RECONCILIATION STATEMENT',
  'bank.reconciliation.generate.items_title': 'RECONCILING ITEMS',
  'bank.reconciliation.generate.drafts_caption': '(drafts)',
  'bank.reconciliation.generate.prepared_by': 'prepared',
  'bank.reconciliation.generate.approved_by': 'approved',
  'bank.reconciliation.generate.not_closed': 'not closed',
  'bank.reconciliation.generate.not_approved': 'not approved',

  // --- bank fee · interest · check ------------------------------------------
  'bank.skipped.title': 'SKIPPED',
  'bank.entry_ref': '{description} · entry {entry}',
  'bank.entry_number': 'entry {entry}',
  'bank.no_description': 'no description',
  'bank.entry_dry_run': '(dry run)',
  'bank.posting.dry_run':
    'Dry run: it really was posted, and then rolled back; the ids come out null.',
  'bank.fee.post.title': 'FEES',
  'bank.fee.post.nothing_to_post': 'no charge to post',
  'bank.fee.post.totals': 'totals: charge {charge} · expense {expense} · VAT {vat}',
  'bank.fee.post.confirm':
    'You are about to POST {count, plural, one {# fee} other {# fees}} from {from} to {to} on ' +
    'account {account}, for {total} (VAT {vat} to pending-creditable). The ledger is immutable: ' +
    'this is only corrected by reversal. Continue?',
  'bank.fee.post.fees': '{count, plural, one {# fee} other {# fees}}',
  'bank.fee.post.summary':
    '· {posted, plural, one {# posted} other {# posted}} · ' +
    '{skipped, plural, one {# skipped} other {# skipped}} · charge {charge} · VAT {vat}',
  'bank.fee.post.vat_pending_note':
    'The VAT stays pending-creditable: it is credited with `bank fee apply` when the bank’s CFDI ' +
    'arrives, not here.',
  'bank.interest.post.title': 'INTEREST',
  'bank.interest.post.withholding': 'withholding {rate}',
  'bank.interest.post.nothing_to_post': 'no credit to post',
  'bank.interest.post.totals': 'totals: gross {gross} · withheld {withheld} · net {net}',
  'bank.interest.post.confirm':
    'You are about to POST {count, plural, one {# interest credit} other {# interest credits}} ' +
    'from {from} to {to} on account {account}: {gross} of gross income and {withheld} of ISR ' +
    'withheld in the entity’s favour. The ledger is immutable: this is only corrected by ' +
    'reversal. Continue?',
  'bank.interest.post.credits':
    '{count, plural, one {# interest credit} other {# interest credits}}',
  'bank.interest.post.summary':
    '· {posted, plural, one {# posted} other {# posted}} · ' +
    '{skipped, plural, one {# skipped} other {# skipped}} · gross {gross} · withheld {withheld}',
  'bank.interest.post.withholding_note':
    'The ISR withheld stays a prepayment IN THE ENTITY’S FAVOUR, not an expense: it is what gets ' +
    'credited against the year’s tax.',
  'bank.check.reconcile.title': 'THE MONTH THE ENTRY FALLS IN',
  'bank.check.reconcile.label.check': 'check',
  'bank.check.reconcile.label.cleared_on': 'cleared on',
  'bank.check.reconcile.check_value': '{check} · payment {payment}',
  'bank.check.reconcile.no_number': 'no number',
  'bank.check.reconcile.dated_by_bank':
    '(the bank dates it: transaction {transaction}, {amount})',
  'bank.check.reconcile.no_open_period': 'no open period on that date',
  'bank.check.reconcile.no_period': 'no period',
  'bank.check.reconcile.why':
    'why: under the VAT law a payment by check counts as made on the day it CLEARED and not the ' +
    'day it was signed, so the VAT of this payment is credited in that month.',
  'bank.check.reconcile.entry_title': 'ENTRY',
  'bank.check.reconcile.no_vat': 'none: there is no VAT to reclassify',
  'bank.check.reconcile.total': 'total reclassified {amount}',
  'bank.check.reconcile.confirm':
    'You are about to record that the bank cleared check {check} on {date} and to reclassify ' +
    '{amount} of VAT in period {period}. The ledger is immutable: this is only corrected by ' +
    'reversal. Continue?',
  'bank.check.reconcile.already_cleared': 'check cleared on {date}',
  'bank.check.reconcile.summary':
    '· cleared on {date} · period {period} · VAT reclassified {amount}',
  'bank.check.reconcile.dry_run':
    'Dry run: the clearing really was recorded, and then rolled back.',
  'bank.transaction.show.unmatched': 'unmatched',
  'bank.match.create.summary':
    '· bank {bank} = books {books} + adjustments {adjustments} · residual {residual} ({mode}) · ' +
    '{matches, plural, one {# match} other {# matches}} · ' +
    '{sealed, plural, one {# item sealed} other {# items sealed}}',
  // ==== fin del piloto bank (I7) ====================================
} as const;
