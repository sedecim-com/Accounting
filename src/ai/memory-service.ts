import { query } from '../database/connection.js';
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE, neutralizarEscalar } from './untrusted.js';
import type { AgentContext } from './context.js';

// ============================================================
// FIRM MEMORY
// Precedents are the asset that makes the AI improve with use,
// but until now they were invisible: only the AI saw them.
// This makes them inspectable, correctable and removable —
// without that, "the AI learned" is something that happens TO
// the user, not something the user controls.
// ============================================================

export interface MemoryEntry {
  id: string;
  question: string;
  answer: string;
  context: string | null;
  topic: string | null;
  answered_by: string;
  answered_at: Date;
  is_precedent: boolean;
  /** Times the AI consulted it (approximated by topic match). */
  usage_hint?: number;
}

const COLUMNS = `id, question, answer, context, topic, answered_by, answered_at, is_precedent`;

export interface ListMemoryOptions {
  /** Free text over question/answer/context/topic. */
  search?: string;
  /** false = also include entries deactivated as precedent. */
  onlyActive?: boolean;
  limit?: number;
}

export async function listMemory(
  ctx: AgentContext,
  opts: ListMemoryOptions = {}
): Promise<MemoryEntry[]> {
  const conditions = ['entity_id = $1', "status = 'answered'"];
  const params: unknown[] = [ctx.entityId];

  if (opts.onlyActive !== false) conditions.push('is_precedent = true');
  if (opts.search) {
    // Escape LIKE metacharacters: a literal '%' would match everything.
    const escaped = opts.search.replace(/[\\%_]/g, (m) => '\\' + m);
    params.push(`%${escaped}%`);
    conditions.push(
      `(question ILIKE $${params.length} OR answer ILIKE $${params.length}
        OR context ILIKE $${params.length} OR topic ILIKE $${params.length})`
    );
  }

  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const r = await query<MemoryEntry>(
    `SELECT ${COLUMNS} FROM ai_questions
     WHERE ${conditions.join(' AND ')}
     ORDER BY answered_at DESC
     LIMIT ${limit}`,
    params
  );
  return r.rows;
}

export async function getMemoryEntry(ctx: AgentContext, id: string): Promise<MemoryEntry | null> {
  const r = await query<MemoryEntry>(
    `SELECT ${COLUMNS} FROM ai_questions
     WHERE id = $1 AND entity_id = $2 AND status = 'answered'`,
    [id, ctx.entityId]
  );
  return r.rows[0] ?? null;
}

/**
 * Correct a precedent's answer. The previous version is preserved in the
 * context: an accounting criterion that changed is information, not garbage,
 * and the trail matters for an audit.
 */
export async function correctMemory(
  ctx: AgentContext,
  id: string,
  newAnswer: string,
  correctedBy: string
): Promise<MemoryEntry> {
  const current = await getMemoryEntry(ctx, id);
  if (!current) throw new Error(`Precedent ${id} does not exist in this entity`);
  if (current.answer === newAnswer) return current;

  const trail =
    `${current.context ? current.context + '\n' : ''}` +
    `[corrected ${new Date().toISOString().split('T')[0]} by ${correctedBy}] ` +
    `previously said: ${current.answer}`;

  const r = await query<MemoryEntry>(
    `UPDATE ai_questions
     SET answer = $1, context = $2, answered_by = $3, answered_at = NOW()
     WHERE id = $4 AND entity_id = $5 AND status = 'answered'
     RETURNING ${COLUMNS}`,
    [newAnswer, trail, correctedBy, id, ctx.entityId]
  );
  if (r.rowCount !== 1) throw new Error(`Could not correct precedent ${id}`);
  return r.rows[0];
}

/**
 * Deactivate a precedent without deleting it: the AI stops seeing it, but
 * the history of what was decided and when survives. A DELETE here would
 * destroy audit evidence.
 */
export async function retireMemory(
  ctx: AgentContext,
  id: string,
  retiredBy: string,
  /**
   * Por qué se retira. Opcional, pero es lo que convierte la resolución de
   * un conflicto en rastro auditable: sin él la bitácora dice QUIÉN apagó el
   * precedente y no dice CONTRA QUÉ otro criterio perdió.
   */
  reason?: string
): Promise<void> {
  const params: unknown[] = [retiredBy, id, ctx.entityId];
  let nota = `'[retired ' || to_char(NOW(), 'YYYY-MM-DD') || ' by ' || $1 || ']'`;
  if (reason && reason.trim()) {
    params.push(reason.trim());
    nota =
      `'[retired ' || to_char(NOW(), 'YYYY-MM-DD') || ' by ' || $1 || ` +
      `' — ' || $${params.length} || ']'`;
  }
  const r = await query(
    `UPDATE ai_questions
     SET is_precedent = false,
         context = COALESCE(context || E'\\n', '') || ${nota}
     WHERE id = $2 AND entity_id = $3 AND status = 'answered' AND is_precedent = true`,
    params
  );
  if (r.rowCount !== 1) throw new Error(`No active precedent with id ${id} exists`);
}

/** Reactivate a retired precedent. */
export async function restoreMemory(ctx: AgentContext, id: string): Promise<void> {
  const r = await query(
    `UPDATE ai_questions SET is_precedent = true
     WHERE id = $1 AND entity_id = $2 AND status = 'answered' AND is_precedent = false`,
    [id, ctx.entityId]
  );
  if (r.rowCount !== 1) throw new Error(`No retired precedent with id ${id} exists`);
}

/**
 * Teach a criterion WITHOUT waiting for the AI to ask. It is the difference
 * between a memory that only reacts and one the firm can seed with its
 * policies from day one.
 */
export async function teachMemory(
  ctx: AgentContext,
  input: { rule: string; criterion: string; topic?: string; taughtBy: string }
): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO ai_questions (
       tenant_id, entity_id, status, question, answer, topic,
       answered_by, answered_at, is_precedent, ai_model, context
     ) VALUES ($1, $2, 'answered', $3, $4, $5, $6, NOW(), true, 'human-taught',
               'Criterion taught directly by the firm (did not arise from a question).')
     RETURNING id`,
    [ctx.tenantId, ctx.entityId, input.rule, input.criterion, input.topic ?? null, input.taughtBy]
  );
  return r.rows[0].id;
}

// ============================================================
// MEMORY DIGEST (frozen snapshot for the system prompt)
// Rendered ONCE at session start into the stable/cached block.
// Hard char budget (~tokens*4): the digest must never grow
// unbounded with the precedent table, and it must never mutate
// mid-session (that would invalidate the prompt cache).
//
// EL DIGEST VA ENVUELTO, igual que el índice de skills. `topic` y
// `question` de ai_questions NO los escribe un humano: los redacta el
// modelo con ask_user desde el contexto que tiene delante — y ese
// contexto incluye el CFDI o el payload de webhook del tercero.
// recordAnsweredQuestion los inserta ya como 'answered' + precedente,
// así que una cadena llegada en un CFDI hostil podía acabar viviendo
// SIN VALLA en la posición de máxima confianza del prompt: el bloque
// estable, cacheado, por encima de las reglas del sistema. Y la línea
// del digest empieza precisamente por `topic ?? question`.
//
// Tratamiento idéntico al de skillsPromptIndex(): cada campo se
// neutraliza a UNA línea (marcadores + controles: un «\n» en un campo
// forjaba una fila entera que nadie escribió) y el bloque entero viaja
// entre los marcadores que el prompt ya declara como datos de tercero
// — no se inventa un vocabulario nuevo; el preámbulo lo pone el
// llamador (system-prompt.ts), que es sistema, no tercero.
// ============================================================

/** Newest precedents fetched for the digest before the char budget cuts in. */
const DIGEST_MAX_ENTRIES = 50;

/**
 * El presupuesto de caracteres con el que el digest viaja DE VERDAD en cada
 * sesión: es el default de buildMemoryDigest, y system-prompt.ts lo toma sin
 * decir nada. Vive aquí —y no en la firma de cada llamador— por lo mismo que
 * el digest se lee por su función: quien MIDE la memoria efectiva tiene que
 * medir el presupuesto que el modelo recibe, no uno que se haya traído él.
 */
export const DIGEST_MAX_CHARS = 3000;

const DIGEST_TRUNCATION_NOTE =
  '[memory truncated at budget — use search_precedents for older criteria]';

/**
 * Compact digest of the most recent active precedents, newest first, one per
 * line: 'topic: answer (by, date)'. Cut at `maxChars` with an explicit note so
 * the model knows older criteria exist and how to reach them.
 *
 * `maxChars` acota el CONTENIDO; los marcadores de la valla van aparte, para
 * que endurecer la envoltura no eche precedentes fuera del presupuesto.
 */
export async function buildMemoryDigest(
  // Sólo necesita saber DE QUÉ ENTIDAD es la memoria (MemoryScope, más
  // abajo). Pedir el contexto entero obligaba a `doctor` —que recorre
  // entidades y no tiene sesión— a fabricarse un contexto de mentira para
  // poder leer el digest, y un lector que fabrica su propio objeto acaba
  // midiendo el objeto que fabricó en vez del que se embarca.
  ctx: MemoryScope,
  maxChars = DIGEST_MAX_CHARS
): Promise<string> {
  const r = await query<{
    topic: string | null; question: string; answer: string;
    answered_by: string; answered_at: Date;
  }>(
    `SELECT topic, question, answer, answered_by, answered_at
     FROM ai_questions
     WHERE entity_id = $1 AND status = 'answered' AND is_precedent = true
     ORDER BY answered_at DESC
     LIMIT ${DIGEST_MAX_ENTRIES}`,
    [ctx.entityId]
  );
  if (r.rows.length === 0) return '';

  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  // Reserve room for the note so appending it never busts the budget.
  const budget = maxChars - (DIGEST_TRUNCATION_NOTE.length + 1);
  for (const row of r.rows) {
    const date = new Date(row.answered_at).toISOString().split('T')[0];
    // Campo a campo: los cuatro son texto de fila, y `topic`/`question` los
    // redactó el modelo desde datos de tercero.
    const line =
      `${neutralizarEscalar(row.topic ?? row.question)}: ${neutralizarEscalar(row.answer)} ` +
      `(${neutralizarEscalar(row.answered_by)}, ${date})`;
    if (used + line.length + 1 > budget) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  // The entry cap also hides older precedents — flag that too.
  if (truncated || r.rows.length === DIGEST_MAX_ENTRIES) {
    lines.push(DIGEST_TRUNCATION_NOTE);
  }
  if (lines.length === 0) return '';
  return `${UNTRUSTED_OPEN}\n${lines.join('\n')}\n${UNTRUSTED_CLOSE}`;
}

export interface MemoryStats {
  active: number;
  retired: number;
  taught: number;
  topics: Array<{ topic: string; count: number }>;
}

export async function memoryStats(ctx: AgentContext): Promise<MemoryStats> {
  const r = await query<{ active: string; retired: string; taught: string }>(
    `SELECT
       count(*) FILTER (WHERE is_precedent)::text AS active,
       count(*) FILTER (WHERE NOT is_precedent)::text AS retired,
       count(*) FILTER (WHERE ai_model = 'human-taught')::text AS taught
     FROM ai_questions WHERE entity_id = $1 AND status = 'answered'`,
    [ctx.entityId]
  );
  const topics = await query<{ topic: string; count: string }>(
    `SELECT topic, count(*)::text AS count FROM ai_questions
     WHERE entity_id = $1 AND status = 'answered' AND is_precedent AND topic IS NOT NULL
     GROUP BY topic ORDER BY count(*) DESC LIMIT 10`,
    [ctx.entityId]
  );
  return {
    active: parseInt(r.rows[0].active, 10),
    retired: parseInt(r.rows[0].retired, 10),
    taught: parseInt(r.rows[0].taught, 10),
    topics: topics.rows.map((t) => ({ topic: t.topic, count: parseInt(t.count, 10) })),
  };
}

// ============================================================
// PRECEDENTES EN CONFLICTO
//
// El digest entra en el prompt de CADA sesión, así que dos precedentes
// activos que se contradicen no son ruido: son dos criterios contables
// incompatibles compitiendo por la misma decisión, y el modelo elegirá uno
// sin decir cuál ni por qué. Hasta aquí nada los miraba.
//
// QUÉ SE LLAMA CONFLICTO, Y POR QUÉ ASÍ:
//
//  · Dos precedentes ACTIVOS de la MISMA entidad que comparten la clave con
//    la que el propio sistema los agrupa —`topic`— y dan respuestas
//    DISTINTAS. `topic` no es decoración: es el slug con el que casa
//    search_precedents y con el que ABRE cada línea del digest. Si dos
//    respuestas cuelgan del mismo slug, el slug ya no identifica UNA
//    decisión: o el criterio cambió sin retirar el viejo, o el slug es
//    demasiado grueso. Las dos cosas son defectos y las dos se arreglan
//    igual — un humano dice cuál manda.
//  · Cuando no hay `topic` (ask_user lo trae opcional) la clave es la
//    PREGUNTA normalizada. Misma pregunta, dos respuestas: conflicto. Es una
//    comparación LITERAL, no semántica; por eso no grita.
//
// QUÉ NO SE LLAMA CONFLICTO — un detector que grita demasiado se apaga, y
// uno que calla no sirve:
//  · La misma respuesta escrita dos veces (mayúsculas, espacios o saltos
//    aparte) es una repetición, no una contradicción.
//  · Un precedente RETIRADO no compite: el modelo no lo ve.
//  · Dos entidades distintas NO se comparan jamás. Cada entidad tiene su
//    criterio y el digest se construye por entidad; cruzarlas inventaría
//    conflictos que no existen.
//
// LA RESOLUCIÓN ES HUMANA. Aquí no hay desempate automático: ni por fecha,
// ni por autor, ni «el más reciente gana». Detectar es del sistema; decidir
// cuál manda es del despacho, y se hace con el comando que el informe
// imprime. El día que alguien quiera un desempate automático, eso es una
// bifurcación de criterio contable y su sitio es el panel de políticas, con
// su default declarado y su lector — no un `if` en este archivo.
// ============================================================

/**
 * Lo mínimo que hace falta para saber si dos precedentes compiten. `answer`
 * admite null porque así lo declara la fila de ai_questions que devuelve
 * search_precedents: el comparador tiene que tragar la fila REAL que se
 * embarca, no una versión limpia de ella.
 */
export interface ComparablePrecedent {
  question: string;
  answer: string | null;
  topic: string | null;
}

/** Qué campo los agrupa: el slug del sistema o la pregunta literal. */
export type ConflictScope = 'topic' | 'question';

export interface ConflictGroup<T> {
  scope: ConflictScope;
  /** La clave normalizada: la decisión por la que compiten. */
  key: string;
  /** Todas las filas del grupo, en el orden recibido (más nuevas primero). */
  entries: T[];
  /**
   * Las respuestas DISTINTAS, en crudo. Se comparan normalizadas y se
   * muestran tal cual: dos respuestas que sólo difieren en espacios son el
   * mismo criterio, pero el informe tiene que enseñar lo que el precedente
   * dice de verdad, no una versión aplanada de lo que dice.
   */
  answers: string[];
}

const normalizar = (s: string | null | undefined): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function claveDe(r: ComparablePrecedent): { scope: ConflictScope; key: string } {
  const t = normalizar(r.topic);
  return t ? { scope: 'topic', key: t } : { scope: 'question', key: normalizar(r.question) };
}

/**
 * Agrupa por la decisión que disputan y devuelve SÓLO los grupos con dos o
 * más respuestas distintas. Es puro a propósito: lo usan el informe de
 * `doctor`, el listado del CLI y —donde más importa— la herramienta
 * search_precedents, que se lo enseña al modelo en el momento de usarlo.
 */
export function groupConflicts<T extends ComparablePrecedent>(rows: T[]): ConflictGroup<T>[] {
  const grupos = new Map<string, ConflictGroup<T>>();
  for (const r of rows) {
    const { scope, key } = claveDe(r);
    // Sin clave no hay decisión que identificar: un precedente sin topic y
    // sin pregunta no compite contra nadie.
    if (!key) continue;
    const id = `${scope} ${key}`;
    const g = grupos.get(id) ?? { scope, key, entries: [], answers: [] };
    g.entries.push(r);
    const yaVistas = new Set(g.answers.map(normalizar));
    if (!yaVistas.has(normalizar(r.answer))) g.answers.push(String(r.answer ?? ''));
    grupos.set(id, g);
  }
  return [...grupos.values()].filter((g) => g.answers.length >= 2);
}

export interface ConflictingPrecedent extends ComparablePrecedent {
  id: string;
  entityId: string;
  entityName: string;
  /** Ya normalizada a texto: esta fila viene de una consulta que filtra
   *  status='answered', donde el CHECK de la tabla la garantiza. */
  answer: string;
  answered_by: string;
  answered_at: Date;
}

export interface MemoryConflict extends ConflictGroup<ConflictingPrecedent> {
  entityId: string;
  entityName: string;
}

export interface MemoryConflictReport {
  conflicts: MemoryConflict[];
  /**
   * Precedentes activos examinados. El denominador va en el informe por lo
   * mismo que en el escáner de huérfanos: cero conflictos sobre cero memoria
   * no es un certificado de buena salud.
   */
  scanned: number;
}

interface FilaPrecedente {
  id: string;
  entity_id: string;
  entity_name: string;
  question: string;
  answer: string;
  topic: string | null;
  answered_by: string;
  answered_at: Date;
}

/**
 * Precedentes activos que se contradicen. Sin `entityId` barre TODAS las
 * entidades —así lo necesita `doctor`, que no tiene contexto de entidad—
 * pero los grupos se forman SIEMPRE dentro de una entidad.
 */
export async function detectMemoryConflicts(
  // El alcance es OBLIGATORIO aunque su contenido sea opcional: barrer todas
  // las entidades tiene que escribirse (`{}`), no obtenerse por omisión. Un
  // filtro de entidad que se cae solo al borrar un argumento es la forma en
  // que una frontera desaparece sin que nadie decida quitarla.
  scope: { entityId?: string }
): Promise<MemoryConflictReport> {
  const params: unknown[] = [];
  let filtro = '';
  if (scope.entityId) {
    params.push(scope.entityId);
    filtro = ` AND q.entity_id = $${params.length}`;
  }
  const r = await query<FilaPrecedente>(
    `SELECT q.id, q.entity_id, e.name AS entity_name, q.question, q.answer, q.topic,
            q.answered_by, q.answered_at
       FROM ai_questions q
       JOIN legal_entities e ON e.id = q.entity_id
      WHERE q.status = 'answered' AND q.is_precedent = true${filtro}
      ORDER BY q.answered_at DESC`,
    params
  );

  const porEntidad = new Map<string, ConflictingPrecedent[]>();
  for (const row of r.rows) {
    const entityId = String(row.entity_id ?? '');
    const lista = porEntidad.get(entityId) ?? [];
    lista.push({
      id: String(row.id ?? ''),
      entityId,
      entityName: String(row.entity_name ?? ''),
      question: String(row.question ?? ''),
      answer: String(row.answer ?? ''),
      topic: row.topic ?? null,
      answered_by: String(row.answered_by ?? ''),
      answered_at: row.answered_at,
    });
    porEntidad.set(entityId, lista);
  }

  const conflicts: MemoryConflict[] = [];
  for (const [entityId, filas] of porEntidad) {
    for (const g of groupConflicts(filas)) {
      conflicts.push({ ...g, entityId, entityName: filas[0].entityName });
    }
  }
  // Primero el que más precedentes enfrenta: es el que más veces va a
  // decidirse solo mientras nadie lo mire.
  conflicts.sort((a, b) => b.entries.length - a.entries.length || a.key.localeCompare(b.key));
  return { conflicts, scanned: r.rows.length };
}

// ============================================================
// LO QUE EL MODELO NO LLEGA A VER
//
// `DIGEST_MAX_ENTRIES` y el recorte por caracteres no son detalles de
// rendimiento: son el borde de la memoria EFECTIVA. Un precedente que cae
// fuera del corte sigue existiendo, sigue apareciendo en `mnemosine memory`
// y sigue siendo encontrable con search_precedents — pero deja de entrar
// solo en el prompt, así que el criterio deja de aplicarse por defecto y
// pasa a depender de que el modelo se acuerde de buscarlo. Es una capacidad
// huérfana silenciosa: existe y nada la alcanza.
//
// El digest se lee POR SU FUNCIÓN, no reimplementando su consulta: si
// mañana cambian el recorte, el presupuesto o la valla, esta medida cambia
// con ellos en vez de mentir sobre un digest que ya no existe.
// ============================================================

/** Lo único que la memoria necesita del contexto: de qué entidad es. */
export type MemoryScope = Pick<AgentContext, 'entityId'>;

export interface DigestCoverage {
  /** Precedentes activos de la entidad. */
  active: number;
  /** De ésos, cuántos RENDERIZA el digest que viaja en cada sesión. */
  visible: number;
  /** Los que existen y el digest no lleva. */
  hidden: number;
  /** El propio digest declara que lo cortaron. */
  truncated: boolean;
  /** El tope de filas que acota la consulta antes incluso del presupuesto. */
  maxEntries: number;
}

/**
 * NO recibe presupuesto, y esa ausencia es la medida.
 *
 * Llamar a `buildMemoryDigest` era NECESARIO Y NO SUFICIENTE: mientras esta
 * función admitió un `maxChars` propio, quien la llamara podía medir un
 * digest que ninguna sesión recibe —avisar de un recorte que no existe, o
 * callar sobre el que sí— sin que la llamada pareciera sospechosa. Ahora la
 * única llamada posible es literalmente la que hace system-prompt.ts, así
 * que el presupuesto medido y el embarcado no pueden separarse.
 */
export async function digestCoverage(ctx: MemoryScope): Promise<DigestCoverage> {
  const digest = await buildMemoryDigest(ctx);
  // El digest viaja envuelto: primera y última línea son la valla.
  const cuerpo = digest === '' ? [] : digest.split('\n').slice(1, -1);
  const visible = cuerpo.filter((l) => l !== DIGEST_TRUNCATION_NOTE).length;

  const r = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_questions
      WHERE entity_id = $1 AND status = 'answered' AND is_precedent = true`,
    [ctx.entityId]
  );
  const active = parseInt(r.rows[0]?.n ?? '0', 10) || 0;
  return {
    active,
    visible,
    hidden: Math.max(0, active - visible),
    truncated: cuerpo.includes(DIGEST_TRUNCATION_NOTE),
    maxEntries: DIGEST_MAX_ENTRIES,
  };
}

// ============================================================
// UN PRECEDENTE CONTRA UNA POLÍTICA YA CONTESTADA
//
// El panel de políticas y la memoria son dos fuentes de criterio y el
// modelo ve las dos. Cuando una política está RESUELTA, el despacho ya
// decidió; un precedente que diga lo contrario reabre por la puerta de
// atrás una decisión que ya se tomó por la de delante.
//
// El detector es DELIBERADAMENTE ESTRECHO, y conviene decirlo en voz alta
// en vez de esconderlo: sólo mira precedentes que NOMBRAN la clave de la
// política de forma literal y que NOMBRAN un valor de opción distinto del
// resuelto. Dos anclas literales, ninguna semántica. Un comparador que
// intentara decidir por significado acusaría a media memoria, y un aviso
// que acusa a media memoria se apaga a la semana. Prefiere callar de más a
// gritar de más, y esa preferencia es la decisión, no un descuido.
// ============================================================

export interface PolicyContradiction {
  entityId: string;
  entityName: string;
  policyKey: string;
  /** Lo que el despacho ya contestó en el panel. */
  resolvedValue: string;
  precedentId: string;
  precedentAnswer: string;
  /** Los valores de opción que el precedente nombra en su lugar. */
  namedInstead: string[];
}

interface FilaPolitica {
  policy_key: string;
  resolved_value: string;
  options: unknown;
  precedent_id: string;
  entity_id: string;
  entity_name: string;
  question: string;
  answer: string;
  topic: string | null;
}

const escaparRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ¿Aparece este valor de opción como palabra suelta en el texto? */
const nombra = (texto: string, valor: string): boolean =>
  new RegExp(`(^|[^a-z0-9_])${escaparRegex(valor)}([^a-z0-9_]|$)`, 'i').test(texto);

export async function detectPolicyContradictions(
  /** Obligatorio por lo mismo que en detectMemoryConflicts: `{}` se escribe. */
  scope: { entityId?: string }
): Promise<PolicyContradiction[]> {
  const params: unknown[] = [];
  let filtro = '';
  if (scope.entityId) {
    params.push(scope.entityId);
    filtro = ` AND q.entity_id = $${params.length}`;
  }
  const r = await query<FilaPolitica>(
    `SELECT p.key AS policy_key, p.resolved_value, p.options,
            q.id AS precedent_id, q.entity_id, e.name AS entity_name,
            q.question, q.answer, q.topic
       FROM policy_decisions p
       JOIN ai_questions q
         ON q.tenant_id = p.tenant_id
        AND (p.entity_id IS NULL OR q.entity_id = p.entity_id)
       JOIN legal_entities e ON e.id = q.entity_id
      WHERE p.status = 'resolved' AND p.resolved_value IS NOT NULL
        AND q.status = 'answered' AND q.is_precedent = true
        AND (q.topic ILIKE '%' || p.key || '%'
             OR q.question ILIKE '%' || p.key || '%'
             OR q.answer ILIKE '%' || p.key || '%')${filtro}
      ORDER BY p.key`,
    params
  );

  const salida: PolicyContradiction[] = [];
  for (const row of r.rows) {
    const opciones = Array.isArray(row.options) ? (row.options as Array<{ value?: unknown }>) : [];
    const valores = opciones
      .map((o) => (typeof o?.value === 'string' ? o.value : ''))
      .filter((v) => v.length > 0);
    const resuelto = String(row.resolved_value ?? '');
    if (!resuelto || valores.length === 0) continue;

    const texto = `${row.topic ?? ''} ${row.question ?? ''} ${row.answer ?? ''}`;
    // Si nombra el valor resuelto, está de acuerdo (o al menos lo cita): no
    // se acusa a un precedente que repite lo que el panel ya dice.
    if (nombra(texto, resuelto)) continue;
    const otros = valores.filter((v) => v !== resuelto && nombra(texto, v));
    if (otros.length === 0) continue;

    salida.push({
      entityId: String(row.entity_id ?? ''),
      entityName: String(row.entity_name ?? ''),
      policyKey: String(row.policy_key ?? ''),
      resolvedValue: resuelto,
      precedentId: String(row.precedent_id ?? ''),
      precedentAnswer: String(row.answer ?? ''),
      namedInstead: otros,
    });
  }
  return salida;
}

// ============================================================
// PRECEDENTES ANCLADOS A UNA ENTIDAD QUE YA NO OPERA
//
// `ai_questions.entity_id` tiene clave foránea, así que un precedente nunca
// queda apuntando a una entidad borrada: queda apuntando a una entidad
// DESACTIVADA, que para este sistema es lo mismo. `resolveEntity` sólo
// resuelve entidades con is_active = true, y el digest se construye desde
// un contexto de entidad — de modo que estos precedentes no pueden entrar
// en el prompt de ninguna sesión. Es la misma enfermedad que el recorte del
// digest, en su estadio terminal: memoria que existe y que nada alcanza.
// ============================================================

export interface StrandedMemory {
  entityName: string;
  count: number;
}

export async function detectStrandedMemory(): Promise<StrandedMemory[]> {
  const r = await query<{ entity_name: string; n: string }>(
    `SELECT e.name AS entity_name, count(*)::text AS n
       FROM ai_questions q
       JOIN legal_entities e ON e.id = q.entity_id
      WHERE q.status = 'answered' AND q.is_precedent = true
        AND e.is_active = false
      GROUP BY e.name
      ORDER BY count(*) DESC`
  );
  return r.rows
    // El nombre es lo que hace accionable el hallazgo, y en el esquema no es
    // nulo: una fila sin nombre no es un hallazgo, es una fila rota.
    .filter((x) => String(x.entity_name ?? '').trim().length > 0)
    .map((x) => ({ entityName: x.entity_name, count: parseInt(x.n, 10) || 0 }));
}
