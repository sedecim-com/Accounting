// ============================================================
// VOCABULARY — the closed verb list (rulebook R3, R4, R8)
//
// Generated from the command registry (docs/cli-command-registry.md).
// Two properties this table exists to guarantee, both checked by
// the consistency test:
//
//   1. CLOSED. A command whose final token is not in this list is
//      rejected. Without a closed list, `list`/`ls`/`show`/`get`
//      all appear and the surface stops being learnable.
//   2. A BIJECTION. Exactly one Spanish word per English verb, and
//      no Spanish word serving two English verbs. Spanish is an
//      alias layer, never a second surface — and an alias claimed
//      by two commands is a hard failure of the bilingual matrix,
//      not a style question.
//
// Adding a verb is a deliberate act: add the row here, with its
// Spanish counterpart, and the test will accept it everywhere.
// ============================================================

/** English verb → its one canonical Spanish alias. */
export const VERBS: Readonly<Record<string, string>> = Object.freeze({
  'accrue'     : 'devengar',
  'add'        : 'agregar',
  'allocate'   : 'prorratear',
  'answer'     : 'responder',
  'apply'      : 'aplicar',
  'approve'    : 'aprobar',
  'archive'    : 'archivar',
  'assign'     : 'asignar',
  'calculate'  : 'calcular',
  'cancel'     : 'cancelar',
  'check'      : 'verificar',
  'clone'      : 'clonar',
  'close'      : 'cerrar',
  'compact'    : 'compactar',
  'correct'    : 'corregir',
  'create'     : 'crear',
  'delete'     : 'eliminar',
  'diff'       : 'comparar',
  'disable'    : 'desactivar',
  'dismiss'    : 'descartar',
  'download'   : 'descargar',
  'edit'       : 'editar',
  'enable'     : 'activar',
  'explain'    : 'explicar',
  'export'     : 'exportar',
  'file'       : 'presentar',
  'generate'   : 'generar',
  'grant'      : 'otorgar',
  'history'    : 'historial',
  'import'     : 'importar',
  'install'    : 'instalar',
  'issue'      : 'emitir',
  'list'       : 'listar',
  'lock'       : 'bloquear',
  'match'      : 'cotejar',
  // Deliberate amendment (2026-08-25): three commands — account/customer/vendor
  // merge — fold one record's history into another and emit a source→target
  // journal so the fold can be undone by hand. No verb in the original list
  // absorbs it: `apply` is idempotent, `import` reads from outside, `correct`
  // amends one record rather than collapsing two.
  'merge'      : 'fusionar',
  'open'       : 'abrir',
  'post'       : 'contabilizar',
  'prepare'    : 'preparar',
  'preview'    : 'previsualizar',
  'reconcile'  : 'conciliar',
  'record'     : 'registrar',
  'recover'    : 'recuperar',
  'reject'     : 'rechazar',
  'remit'      : 'enterar',
  'remove'     : 'quitar',
  'reopen'     : 'reabrir',
  'restore'    : 'restaurar',
  'resume'     : 'reanudar',
  'retry'      : 'reintentar',
  'reverse'    : 'reversar',
  'review'     : 'revisar',
  'revoke'     : 'revocar',
  'rotate'     : 'rotar',
  'run'        : 'ejecutar',
  'search'     : 'buscar',
  'seed'       : 'sembrar',
  'send'       : 'entregar',
  'set'        : 'fijar',
  'show'       : 'ver',
  'stamp'      : 'timbrar',
  'start'      : 'iniciar',
  // Deliberate amendment (2026-08-31, A2): `ai stats` es el informe de
  // calibración del agente comprometido por el plan maestro y la auditoría
  // integral — el nombre embarcado gana (lección S0.1). Sustantivo-como-verbo
  // con el mismo precedente que 'status'→'estado' e 'history'→'historial'.
  'stats'      : 'estadisticas',
  'status'     : 'estado',
  'stop'       : 'detener',
  'submit'     : 'enviar',
  'sync'       : 'sincronizar',
  'test'       : 'probar',
  'trace'      : 'rastrear',
  'unapply'    : 'desaplicar',
  'unlock'     : 'desbloquear',
  'unset'      : 'limpiar',
  'upgrade'    : 'actualizar',
  'upload'     : 'subir',
  'use'        : 'usar',
  'verify'     : 'comprobar',
  'void'       : 'anular',
  'watch'      : 'observar',
});

export type Verb = keyof typeof VERBS;

/** The Spanish alias for a verb, for building alias command names. */
export function spanishVerb(verb: string): string | undefined {
  return VERBS[verb];
}

export function isVerb(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERBS, token);
}

/**
 * Root-level commands that legitimately have no object. A closed,
 * short list: every new top-level word costs a name that can never
 * be a noun again (rulebook R1, R10).
 */
export const OBJECTLESS_COMMANDS: readonly string[] = Object.freeze([
  'chat', 'ask', 'init', 'doctor', 'status', 'review', 'close', 'ingest',
  'onboard', 'pending', 'login', 'logout', 'whoami', 'help', 'completion',
  'version', 'upgrade', 'lang',
]);

/**
 * Nouns whose plural spelling is the shipped name and stays for
 * compatibility, each aliased from its singular. Nothing new joins
 * this list: R2 makes nouns singular.
 */
export const LEGACY_PLURALS: readonly string[] = Object.freeze([
  'entities', 'drafts', 'providers', 'questions', 'sessions',
  'jobs', 'skills', 'webhooks', 'approvals',
]);
