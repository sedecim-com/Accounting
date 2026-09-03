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
  // A7·2 · el panel de políticas del despacho y el mapa de roles de cuenta.
  // Entra a lo desatendido a mano y a propósito: es de LECTURA pura, y sin
  // ella una corrida nocturna clasifica con MENOS criterio del que el
  // despacho ya contestó — que es justo el defecto que este tramo cierra.
  'get_accounting_policies',
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

// ============================================================
// LA SUPERFICIE DE LA INGESTA, NOMBRADA APARTE (A7·3).
//
// La hoja de `mnemosine ingest` construía su sesión por su cuenta y no le
// pasaba lista: recibía TODAS las herramientas porque nadie se lo impidió —
// la misma propiedad por accidente que la desatendida ya cerró arriba, en el
// camino que MÁS importa, porque la ingesta es el único que puede POSTEAR al
// mayor sin humano cuando el panel autoriza el auto-posteo.
//
// Y no reusa SUPERFICIE_DESATENDIDA: la ingesta hace UN trabajo —clasificar
// un comprobante y proponer su asiento—, no concilia y no reporta. Una lista
// propia y más corta es la única forma de que ese recorte sea una decisión
// escrita y no una coincidencia.
//
// LO QUE ENTRA, y por qué cada uno:
//   · search_precedents, search_journal_entries — el prompt del CFDI las pide
//     por su nombre: cómo clasificó el despacho a este emisor antes.
//   · search_accounts — el prompt las pide: verificar la cuenta en el
//     catálogo antes de proponerla.
//   · search_vendors — el emisor. El prompt ya dice si viene identificado;
//     confirmarlo es parte de clasificar (el CFDI recibido va contra
//     proveedores: la ingesta escribe bills, no facturas).
//   · get_journal_entry — el precedente COMPLETO. La búsqueda devuelve
//     resúmenes; copiar un tratamiento anterior exige verlo entero.
//   · get_accounting_policies — el panel del despacho (A7·2). La ingesta es
//     justo el camino que más lo necesita: el umbral de capitalización se
//     aplica CLASIFICANDO, y sin el panel una corrida nocturna decide activo
//     contra gasto con menos criterio del que el despacho ya contestó.
//   · read_docs, skills_list, skill_view — locales, de sólo lectura, y son
//     donde el despacho escribe «así clasificamos nosotros».
//   · draft_journal_entry — la salida. La ingesta existe para producirla.
//   · ask_user — el camino BLOQUEADO. Sin ella, un CFDI que exige una
//     decisión humana se clasificaría a ciegas en vez de quedar en la cola
//     de preguntas.
//
// LO QUE SE QUEDA FUERA, y por qué:
//   · external_pull, external_push, external_diff_trial_balance,
//     list_external_ops — el brazo externo entero. La ingesta clasifica
//     archivos que ya llegaron; no habla con el sistema del cliente ni encola
//     nada hacia fuera. `external_push` sólo encola, pero una cola que este
//     camino nunca abre es superficie sin uso, y la superficie sin uso es la
//     que se aprovecha sola el día que alguien la ensancha.
//   · get_general_ledger, get_trial_balance, get_balance_sheet,
//     get_income_statement, get_aged_payables, get_aged_receivables — los
//     estados y los saldos son el trabajo de reportar y conciliar, no el de
//     clasificar UN comprobante que trae su método de pago escrito. Son
//     además los resultados más grandes (los que topan MAX_TOOL_RESULT_CHARS)
//     y en un bucle de mil quinientos archivos desalojarían el prefijo
//     cacheado a cambio de nada.
//   · session_search — busca en CONVERSACIONES pasadas, y una corrida por
//     lotes reinicia la sesión en cada archivo: no hay conversación. El canal
//     diseñado para «qué hicimos antes con este emisor» es search_precedents.
//   · list_drafts — el dedupe es determinista y ocurre ANTES del modelo; leer
//     los borradores ajenos no añade criterio sobre ESTE comprobante, y en un
//     lote largo el modelo estaría leyendo una lista que él mismo engorda.
//   · get_entity_status — es el diagnóstico de arranque («¿por dónde
//     empiezo?», catálogo, ejercicio, saldos iniciales). La ingesta no
//     arranca nada: corre sobre una entidad que ya opera.
//   · search_customers — la ingesta procesa comprobantes RECIBIDOS (escribe
//     bills, cuentas por pagar): la contraparte es un proveedor. El día que
//     ingiera comprobantes emitidos, esta línea es el diff que hay que
//     revisar.
// ============================================================

export const SUPERFICIE_INGESTA: readonly string[] = [
  // lectura para clasificar
  'search_precedents',
  'search_journal_entries',
  'search_accounts',
  'search_vendors',
  'get_journal_entry',
  // el criterio del despacho, no el del modelo
  'get_accounting_policies',
  'read_docs',
  'skills_list',
  'skill_view',
  // escritura SÓLO en colas de revisión
  'draft_journal_entry',
  'ask_user',
];
