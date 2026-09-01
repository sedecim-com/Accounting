// ============================================================
// LA SUPERFICIE DE LA CORRIDA DESATENDIDA, NOMBRADA.
//
// Una corrida desatendida (jobs run-due → makeRunAgentTurn) construía su
// sesión con TODAS las herramientas: la fábrica ni siquiera admitía un
// recorte. Hoy eso no es una fuga —ninguna herramienta puede postear ni
// ejecutar hacia fuera; lo vigilan las tres cercas del criterio E5.1— pero
// era una propiedad por accidente: la primera herramienta futura que
// escribiera algo entraría a la corrida desatendida sin que nadie lo
// decidiera.
//
// Esta lista lo convierte en propiedad por construcción. La sesión
// desatendida recibe EXACTAMENTE estos nombres; una herramienta nueva no
// aparece aquí sola, así que nace excluida de lo desatendido hasta que
// alguien la añada — y ese añadido es una línea en un diff que se revisa.
// Un nombre que deje de existir rompe en el arranque (buildTools rechaza
// nombres desconocidos), así que la lista no puede quedarse mintiendo tras
// un renombre.
//
// La lista de hoy es la superficie completa actual, a propósito: el commit
// que la introduce no cambia comportamiento, cambia quién decide el futuro.
// Nota sobre `external_pull` y `external_diff_trial_balance`: son LECTURAS,
// pero contra el sistema externo del cliente con su credencial — los jobs de
// conciliación las necesitan; si algún día se restringe lo desatendido, son
// las primeras candidatas a salir.
// ============================================================

export const SUPERFICIE_DESATENDIDA: readonly string[] = [
  // lectura del propio sistema
  'search_accounts',
  'search_customers',
  'search_vendors',
  'search_journal_entries',
  'search_precedents',
  'get_journal_entry',
  'get_general_ledger',
  'get_trial_balance',
  'get_balance_sheet',
  'get_income_statement',
  'get_aged_payables',
  'get_aged_receivables',
  'get_entity_status',
  'read_docs',
  'session_search',
  'skills_list',
  'skill_view',
  'list_drafts',
  'list_external_ops',
  // escritura SÓLO en colas de revisión
  'draft_journal_entry',
  'ask_user',
  'external_push', // encola en la bandeja de salida; no ejecuta
  // lectura contra el sistema externo del cliente (con su credencial)
  'external_pull',
  'external_diff_trial_balance',
];

/**
 * La superficie desatendida SIN el alcance externo: lo que corre
 * `jobs run-due` cuando NO se pasó --live.
 *
 * El único brazo de una corrida desatendida que sale de este sistema son las
 * dos lecturas contra el sistema del cliente con su credencial (el runner no
 * escribe fuera jamás; external_push sólo encola). `--live` es la compuerta
 * del kernel para efectos externos, y aquí significa exactamente eso: sin la
 * bandera, los trabajos corren completos sobre los datos propios y el brazo
 * externo no viaja — un cron que concilia contra Contalink lo dice explícito
 * en su línea: `mnemosine jobs run-due --live`.
 */
export const SUPERFICIE_DESATENDIDA_SANDBOX: readonly string[] = SUPERFICIE_DESATENDIDA.filter(
  (n) => n !== 'external_pull' && n !== 'external_diff_trial_balance'
);
