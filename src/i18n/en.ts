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
  /** `src/cli/kernel/confirmacion.ts:64` (`noEntendi`). El «y/s» del español
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
} as const;
