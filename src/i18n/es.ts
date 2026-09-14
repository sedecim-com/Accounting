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
};
