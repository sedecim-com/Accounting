import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { query } from '../database/connection.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  resolveActiveEntity,
  exitCodeFor,
  usageError,
  notFound,
  blockedByState,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine audit · auditoria
//
// LA HOJA DE LECTURA DEL RASTRO.
//
// `audit_log` existe desde la migración 001 y hasta hoy no había forma de
// leerla sin abrir psql. Es la tabla sobre la que descansa la frase que este
// producto vende —se puede probar quién hizo qué—, y la prueba vivía a un
// `psql -c "SELECT * FROM audit_log"` de distancia, que es exactamente donde
// no puede vivir: quien tiene esa consola tiene también permiso de escritura
// sobre los libros, así que el auditor externo, que es quien pregunta, no
// podía preguntar.
//
// La fila del catálogo (docs/cli-command-catalog.md, `mnemosine audit list`)
// se respeta LITERAL en sus banderas: `--since`, `--until`, `--actor`,
// `--action`, `--object`, `-u/--user`, `--entity-type`, `--json`,
// `-n/--limit`. Ninguna se inventa y ninguna de las listadas falta.
//
//
// CUATRO DECISIONES QUE NO SON DE ESTILO.
//
// 1. UN FILTRO QUE NO SE PUEDE CONTESTAR SE NIEGA, NO DEVUELVE VACÍO.
//    `--actor agent` es la bandera que el catálogo documenta y que haría
//    implementable `agent activity list`. No hay columna de actor: cada fila
//    de `audit_log` se atribuye a un `user_id` humano y punto. Devolver cero
//    filas contestaría «el agente no hizo nada», que es falso y es la clase
//    de respuesta que un auditor se lleva a un informe. Sale BLOCKED (5) —
//    «el estado del sistema no permite contestar»— y dice qué falta.
//
// 2. UN VALOR FUERA DEL VOCABULARIO ES ERROR DE USO, NO CERO FILAS.
//    `--action pots` (por `post`) devolvería vacío en silencio y quien lo
//    escribiera concluiría que nadie contabilizó nada. El vocabulario lo fija
//    un CHECK de la 001; aquí se compara contra él antes de consultar.
//
// 3. EL RASTRO ES DEL INQUILINO, NO DE LA ENTIDAD LEGAL. `audit_log` no
//    tiene `entity_id` de entidad legal —su `entity_id` es el id del OBJETO
//    tocado—, así que no se puede preguntar «qué pasó en esta empresa».
//    `-e/--entity` sigue existiendo porque resuelve QUÉ INQUILINO mirar
//    cuando no se da `-t`, y el encabezado lo dice para que nadie lea un
//    listado creyendo que está acotado a una entidad. Es un hueco real del
//    esquema, no de este comando.
//
// 4. EL LISTADO NO SIRVE LOS VALORES, SÓLO SUS NOMBRES. `old_values` y
//    `new_values` son JSONB de tamaño arbitrario y meterlos en una celda de
//    tabla produce una pantalla ilegible que además puede arrastrar datos que
//    nadie pidió a un `--format csv`. El listado dice QUÉ CAMPOS cambiaron;
//    `audit show <id>` sirve el antes y el después completos, que es un acto
//    deliberado sobre una fila concreta.
// ============================================================

export interface AuditCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
}

interface ListOpts extends CommonOpts {
  since?: string;
  until?: string;
  actor?: string;
  action?: string;
  object?: string | boolean;
  entityType?: string;
  limit?: number;
  offset?: number;
}

/**
 * El vocabulario de `audit_log.action`, copiado del CHECK de la 001 a través
 * del tipo que ya lo declara en `services/audit/audit-log.ts`. Se importa el
 * significado, no la cadena: el día que el CHECK crezca, este arreglo tiene
 * que crecer con él y el criterio E0.2 del plan compara los dos.
 */
const ACCIONES = [
  'create', 'update', 'delete', 'post', 'void', 'approve', 'close', 'reopen',
] as const;

/**
 * FAMILIAS DE OBJETO, para `--object`.
 *
 * El catálogo usa `--object bank` en la sección de bancos y `--entity-type`
 * en la fila de `audit list`: son dos preguntas distintas y por eso hay dos
 * banderas. `--entity-type` es el valor EXACTO de la columna —lo que uno pone
 * cuando ya sabe qué busca—; `--object` es la familia, que es lo que uno pone
 * cuando lo que sabe es «algo del banco».
 *
 * La tabla se deriva de los `entityType` que los servicios escriben HOY, no
 * de un diseño: los valores son heterogéneos —unos en plural porque nombran
 * la tabla, otros en singular porque nombran el agregado, y el middleware
 * REST además mete segmentos de ruta— y una familia que prometa más de lo
 * que la columna contiene devolvería menos filas de las que hay, en silencio.
 * Por eso `--entity-type` nunca desaparece: es la salida cuando la familia
 * no alcanza.
 *
 * `--object` sin valor imprime las familias, igual que `--fields` sin valor
 * imprime las columnas.
 */
const FAMILIAS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ledger: ['journal_entries', 'journal_entry_import_batches', 'account', 'account_role'],
  period: ['fiscal_period'],
  bank: ['bank_accounts', 'bank_statements', 'reconciliation_sessions',
    'reconciliation_matches', 'reconciliation_match_groups'],
  ar: ['customers', 'invoices', 'credit_notes', 'customer_payments'],
  ap: ['vendor', 'vendors', 'bills', 'vendor_payments'],
  asset: ['fixed_assets'],
  fiscal: ['fiscal_credentials'],
});

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Una bandera mal escrita es error de USO (2), no una validación fallida del
 * dominio (4). La comprobación de ida y vuelta rechaza los días que no
 * existen: JS acepta `2026-02-31` y lo corre al 3 de marzo, de modo que un
 * `--until 2026-02-31` recortaría el rastro dos días más allá de lo pedido.
 */
function exigirFecha(flag: string, valor: string): string {
  const d = new Date(`${valor}T00:00:00Z`);
  if (!FECHA_RE.test(valor) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    throw usageError(`${flag} debe ser una fecha real en formato YYYY-MM-DD; llegó "${valor}".`);
  }
  return valor;
}

/**
 * Reescribe el texto de ayuda de `-u/--user` para esta familia. Ver el
 * comentario en la hoja `list`: la bandera es del diccionario y conserva su
 * grafía y su forma corta; lo que cambia es qué significa en un comando que
 * no escribe nada, y eso tiene que decirlo el `--help`, no sólo el código.
 */
function describirFiltroDeUsuario(cmd: Command): void {
  const opt = cmd.options.find((o) => o.long === '--user');
  if (opt) opt.description = 'only entries written by this user (email); this command attributes nothing';
}

/** Los nombres de campo que cambiaron, sin sus valores. Ver decisión 4. */
function camposTocados(viejo: unknown, nuevo: unknown): string {
  const nombres = new Set<string>();
  for (const v of [viejo, nuevo]) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v)) nombres.add(k);
    }
  }
  return [...nombres].sort().join(', ');
}

export function registerAuditCommand(program: Command, deps: AuditCommandDeps): void {
  const audit = program
    .command('audit')
    .alias('auditoria')
    .description('Read the audit trail: who changed what, when, and from which value');

  /**
   * El manejador DEVUELVE su código y `run` lo cierra UNA sola vez. La forma
   * heredada —`shutdown(4)` dentro del manejador y otro `shutdown(0)` al
   * volver— sólo funciona porque el `shutdown` real llama a `process.exit`;
   * contra un doble de prueba el segundo gana y el código observado es 0.
   */
  const run = async (fn: () => Promise<number | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? 0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const inquilinoDe = async (opts: CommonOpts): Promise<string> => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
    return ctx.tenantId;
  };

  /**
   * El correo de `-u/--user` a su id.
   *
   * Se resuelve ANTES de consultar y se NIEGA si no existe. Un `WHERE
   * user_id = (SELECT id … WHERE email = $1)` con un correo mal escrito
   * devuelve cero filas y se lee como «esa persona no tocó nada»: la
   * diferencia entre «no hizo nada» y «no existe» es la respuesta entera.
   */
  const usuarioDe = async (tenantId: string, email: string): Promise<string> => {
    const r = await query<{ id: string }>(
      'SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = lower($2) LIMIT 1',
      [tenantId, email]
    );
    if (r.rows.length === 0) {
      throw notFound(
        `Usuario "${email}" en este inquilino. El rastro no se filtró: un correo que no existe ` +
          'devolvería cero filas y se leería como que esa persona no hizo nada.'
      );
    }
    return r.rows[0].id;
  };

  // ---- audit list ---------------------------------------------------
  const list = audit
    .command('list')
    .alias('listar')
    .description('Audit trail of mutations: who, when, which object, and which fields changed');
  withOutput(withContext(list));
  // `-u/--user` cambia de SENTIDO en esta hoja, y hay que decirlo donde se
  // lee. En todo el resto del binario significa «actuando como», porque
  // alimenta a `resolveReviewer` para atribuir una escritura. Aquí no se
  // escribe nada: no hay a quién atribuir, así que la única lectura posible
  // es «de quién son las filas». La grafía y la forma corta siguen siendo las
  // del diccionario del núcleo —que es lo que el diccionario gobierna— y sólo
  // se reescribe el texto de ayuda: un lector que vea «acting user» en el
  // comando de «quién hizo esto» va a creer que está firmando su consulta.
  describirFiltroDeUsuario(list);
  list
    // `--since`/`--until` sueltas y no con `withTime()`: el grupo entero
    // arrastra `--period`, `--as-of` y `--date-basis`, y una bitácora no
    // tiene base de fecha que elegir —tiene UNA marca de tiempo—. Declarar
    // cinco banderas para rechazar tres es peor superficie que declarar dos.
    .option('--since <date>', 'inclusive lower bound on the entry timestamp (YYYY-MM-DD)')
    .option('--until <date>', 'inclusive upper bound on the entry timestamp (YYYY-MM-DD)')
    .option('--actor <who>', 'human | agent | agent:<session> (see the note on --actor agent)')
    .option('--action <name>', `one of: ${ACCIONES.join(', ')}`)
    .option('--object [family]', `object family: ${Object.keys(FAMILIAS).join(', ')}; with no value, lists them`)
    .option('--entity-type <name>', 'exact audit_log.entity_type value, when the family is not enough')
    // `-n/--limit` y `--offset` a mano en vez de `withSelection()`: el grupo
    // trae además `-s/--status` y `-a/--all`, y una fila de bitácora no tiene
    // ciclo de vida ni archivo. Las grafías y las formas cortas son las del
    // diccionario del núcleo, que es lo que el diccionario gobierna.
    .option('-n, --limit <n>', 'maximum rows to return', (v: string) => {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n <= 0) throw usageError(`--limit debe ser un entero positivo; llegó "${v}".`);
      return n;
    })
    .option('--offset <n>', 'skip this many rows', (v: string) => {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < 0) throw usageError(`--offset debe ser un entero no negativo; llegó "${v}".`);
      return n;
    });
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action((opts: ListOpts) =>
    run(async () => {
      // `--object` sin valor: descubrimiento de las familias, sin base de
      // datos ni inquilino de por medio. Mismo gesto que `--fields` a secas.
      if (opts.object === true) {
        for (const [familia, tipos] of Object.entries(FAMILIAS)) {
          process.stdout.write(`${familia.padEnd(8)} ${tipos.join(', ')}\n`);
        }
        return;
      }

      if (opts.action && !(ACCIONES as readonly string[]).includes(opts.action)) {
        throw usageError(
          `Acción desconocida "${opts.action}". El vocabulario lo fija el CHECK de audit_log ` +
            `(migración 001): ${ACCIONES.join(', ')}.`
        );
      }

      // Ver la decisión 1 de la cabecera. `human` y la ausencia son lo mismo
      // HOY, y se acepta para que un guion escrito ahora siga significando lo
      // mismo el día que la columna exista.
      if (opts.actor && opts.actor !== 'human') {
        if (opts.actor === 'agent' || opts.actor.startsWith('agent:')) {
          throw blockedByState(
            `El rastro no distingue todavía al agente: \`audit_log\` no tiene columna de actor y ` +
              `cada fila se atribuye a un \`user_id\` humano. Filtrar por "${opts.actor}" devolvería ` +
              'cero filas, que se leería como que el agente no hizo nada. Falta la columna ' +
              '`actor` (y `agent_session_id`) y que el puente del agente la escriba; hasta ' +
              'entonces, `--actor human` o sin bandera es todo lo que hay.'
          );
        }
        throw usageError(`--actor sólo admite "human", "agent" o "agent:<session>"; llegó "${opts.actor}".`);
      }

      let tipos: string[] | null = null;
      if (typeof opts.object === 'string') {
        const familia = FAMILIAS[opts.object];
        if (!familia) {
          throw usageError(
            `Familia de objeto desconocida "${opts.object}". Conocidas: ` +
              `${Object.keys(FAMILIAS).join(', ')}. Para un valor exacto de la columna usa --entity-type.`
          );
        }
        tipos = [...familia];
      }
      if (opts.entityType) {
        // Las dos banderas juntas se INTERSECAN, no se suman: pedir la
        // familia `bank` y el tipo `invoices` es una contradicción, y
        // devolver la unión contestaría a una pregunta que nadie hizo.
        tipos = tipos ? tipos.filter((t) => t === opts.entityType) : [opts.entityType];
        if (tipos.length === 0) {
          throw usageError(
            `--object "${String(opts.object)}" y --entity-type "${opts.entityType}" no se cruzan: ` +
              'la familia no contiene ese tipo. Da una de las dos.'
          );
        }
      }

      const tenantId = await inquilinoDe(opts);

      const cond: string[] = ['a.tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let i = 2;
      if (opts.since) {
        cond.push(`a.timestamp >= $${i++}::date`);
        params.push(exigirFecha('--since', opts.since));
      }
      if (opts.until) {
        // `< until + 1 día` y no `<= until`: `timestamp` es un instante, así
        // que `<= '2026-03-31'` corta a la medianoche y se come el día
        // entero que el usuario pidió incluir.
        cond.push(`a.timestamp < ($${i++}::date + INTERVAL '1 day')`);
        params.push(exigirFecha('--until', opts.until));
      }
      if (opts.action) {
        cond.push(`a.action = $${i++}`);
        params.push(opts.action);
      }
      if (tipos) {
        cond.push(`a.entity_type = ANY($${i++}::text[])`);
        params.push(tipos);
      }
      if (opts.user) {
        cond.push(`a.user_id = $${i++}`);
        params.push(await usuarioDe(tenantId, opts.user));
      }

      const total = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log a WHERE ${cond.join(' AND ')}`,
        params
      );

      const limite = opts.limit ?? 50;
      const result = await query<{
        id: string;
        timestamp: Date;
        actor: string | null;
        action: string;
        entity_type: string;
        entity_id: string;
        old_values: unknown;
        new_values: unknown;
        reason: string | null;
      }>(
        `SELECT a.id, a.timestamp, u.email AS actor, a.action, a.entity_type, a.entity_id,
                a.old_values, a.new_values, a.reason
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE ${cond.join(' AND ')}
          ORDER BY a.timestamp DESC, a.id DESC
          LIMIT $${i++} OFFSET $${i}`,
        [...params, limite, opts.offset ?? 0]
      );

      const rows: Row[] = result.rows.map((r) => ({
        id: r.id,
        // Instante, no fecha contable: se serializa aquí con toISOString(),
        // que es lo que output.ts pide para las marcas de bitácora.
        timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
        // Un `user_id` sin fila en `users` no es imposible: `audit_log` es de
        // sólo agregar (033) y sobrevive al alta de quien escribió la fila.
        // Se dice «desconocido» explícitamente en vez de dejar el hueco: una
        // celda vacía en una bitácora se lee como un dato que no se guardó.
        actor: r.actor ?? '(usuario dado de baja)',
        action: r.action,
        object: r.entity_type,
        object_id: r.entity_id,
        fields: camposTocados(r.old_values, r.new_values),
        reason: r.reason ?? '',
      }));

      render(rows, { ...opts, idField: 'id', total: parseInt(total.rows[0].n, 10) });

      if (result.rows.length === 0) {
        process.stderr.write(
          deps.palette.dim(
            'Sin filas. El rastro es del INQUILINO: `audit_log` no tiene columna de entidad legal, ' +
              'así que --entity sólo eligió a qué inquilino mirar.\n'
          )
        );
      }
    })
  );

  // ---- audit show ---------------------------------------------------
  //
  // Una fila entera, con `old_values` y `new_values` desplegados. Es lo que
  // el listado no puede hacer sin volverse ilegible, y es la pregunta que
  // sigue SIEMPRE a la primera: no «quién tocó esto», sino «desde qué valor».
  const show = audit
    .command('show')
    .alias('ver')
    .argument('<id>', 'audit_log row id (the id column of `audit list`)')
    .description('One audit entry in full: the value before, the value after, and the reason');
  withOutput(withContext(show));
  describirFiltroDeUsuario(show);
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((id: string, opts: CommonOpts) =>
    run(async () => {
      const tenantId = await inquilinoDe(opts);
      const r = await query<{
        id: string;
        timestamp: Date;
        actor: string | null;
        action: string;
        entity_type: string;
        entity_id: string;
        old_values: Record<string, unknown> | null;
        new_values: Record<string, unknown> | null;
        reason: string | null;
        request_id: string | null;
        ip_address: string | null;
      }>(
        `SELECT a.id, a.timestamp, u.email AS actor, a.action, a.entity_type, a.entity_id,
                a.old_values, a.new_values, a.reason, a.request_id, a.ip_address::text
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.id = $1 AND a.tenant_id = $2`,
        [id, tenantId]
      );
      // La frontera va DENTRO del SQL (`a.tenant_id = $2`), no en un `if`
      // sobre la fila leída: una comprobación después de traerla ya la trajo.
      if (r.rows.length === 0) throw notFound('Audit entry', id);
      const a = r.rows[0];

      // Una fila por CAMPO, no una fila por entrada: es lo que hace que
      // `--fields`, `--format csv` y la lectura humana digan lo mismo, y lo
      // que permite ver de un golpe qué se movió y desde dónde.
      const campos = camposTocados(a.old_values, a.new_values);
      const filas: Row[] = (campos ? campos.split(', ') : []).map((campo) => ({
        field: campo,
        before: a.old_values?.[campo] ?? null,
        after: a.new_values?.[campo] ?? null,
      }));

      if (opts.json || opts.output || (opts.format && opts.format !== 'table')) {
        render(
          [{
            id: a.id,
            timestamp: a.timestamp instanceof Date ? a.timestamp.toISOString() : String(a.timestamp),
            actor: a.actor,
            action: a.action,
            object: a.entity_type,
            object_id: a.entity_id,
            reason: a.reason,
            request_id: a.request_id,
            ip_address: a.ip_address,
            changes: filas,
          }],
          { ...opts, idField: 'id' }
        );
        return;
      }

      process.stdout.write(
        `${deps.palette.bold(a.action)} ${a.entity_type} ${a.entity_id}\n` +
          `  ${deps.palette.dim('cuándo')}  ${a.timestamp instanceof Date ? a.timestamp.toISOString() : String(a.timestamp)}\n` +
          `  ${deps.palette.dim('quién')}   ${a.actor ?? '(usuario desconocido: la bitácora es de sólo agregar y sobrevive al alta)'}\n` +
          `  ${deps.palette.dim('por qué')} ${a.reason ?? deps.palette.yellow('(sin razón registrada)')}\n`
      );
      if (filas.length === 0) {
        process.stdout.write(
          deps.palette.dim('  sin valores: la fila registra el acto, no el antes y el después\n')
        );
        return;
      }
      render(filas, { ...opts, idField: 'field' });
    })
  );
}
