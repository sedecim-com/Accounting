import * as readline from 'node:readline/promises';
import * as path from 'node:path';
import type { Command } from 'commander';
import {
  crearRespaldo,
  listarRespaldos,
  verificarRespaldo,
  restaurarRespaldo,
} from '../services/backup/backup-service.js';
import {
  exportarInquilino,
  listarExportaciones,
  type ResultadoExportacion,
} from '../services/backup/exportacion-inquilino.js';
import { enterTenant, currentTenant } from '../database/connection.js';
import { resolveEntity } from '../ai/context.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  withOutput,
  withSelection,
  withContext,
  globalsOf,
  usageError,
  abortedByUser,
  exitCodeFor,
  checkExitCode,
} from './kernel/index.js';
import { confirmarConReintento, noEntendi, yesNoPrompt } from './kernel/confirmacion.js';
import { t, type MessageParams, type TranslationKey } from '../i18n/index.js';

// ============================================================
// mnemosine backup · respaldo
//
// POR QUÉ ESTE COMANDO ES CONDICIÓN DE ENTREGA. El mayor de este sistema es
// inmutable a propósito: un asiento posteado no admite UPDATE ni DELETE
// (041), la bitácora sólo agrega (033). Esa inmutabilidad es lo que hace
// confiables los libros — y es exactamente lo que impide repararlos a mano.
// La 041 llega a prescribir «bórrala entera y vuelve a migrar» como única
// salida ante un mayor inservible: la vía de recuperación que el esquema
// nombra ES la restauración, y hasta S3 no existía ni una línea sobre ella.
//
// UN RESPALDO NO PROBADO NO ES UN RESPALDO. `verify` hace lo barato por
// omisión —hash contra manifiesto, versión de esquema— y lo dice cuando eso
// es todo lo que hizo. Con `--restore` ENSAYA la restauración en una base de
// usar y tirar y le corre los chequeos del mayor. Sólo eso demuestra algo.
//
// DOS ARTEFACTOS, DOS NOMBRES. `create` vuelca la INSTALACIÓN entera con
// pg_dump: es restaurable y es la vía ante desastre, y por eso su manifiesto
// dice ahora cuántos inquilinos SIN REDACTAR lleva dentro. `export` saca UN
// inquilino (o una de sus entidades) leyendo por RLS: está acotado y es
// consistente, pero NO se puede volver a meter, así que no se llama respaldo
// en ninguna de las tres superficies —CLI, manifiesto y catálogo—.
//
// `create` y `export` son IA ✗ por la regla (f) del catálogo: los dos
// materializan datos sin redactar. `restore` es irreversible y crea una base
// NUEVA siempre — restaurar encima de una viva destruiría justo lo que se
// intenta salvar.
// ============================================================

export interface BackupCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  confirm?: (question: string) => Promise<boolean>;
}

interface CommonOpts {
  tenant?: string;
  entity?: string;
  target?: string;
  json?: boolean;
  quiet?: boolean;
  format?: string;
  fields?: string | boolean;
  output?: string;
  limit?: number;
  strict?: boolean;
  status?: string[];
  all?: boolean;
  offset?: number;
  restore?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  reason?: string;
  idempotencyKey?: string;
}

const DESTINO_OMISION = './respaldos';

const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

/**
 * What `backup export` prints, built apart from the action (MNE-001-223) so
 * that it can be read without a database: the summary of the file on stdout,
 * and on stderr what the file is not and what it carries.
 */
export function exportReport(r: ResultadoExportacion, p: Palette): { out: string; err: string } {
  const m = r.manifiesto;
  const owner =
    m.alcance.tipo === 'entidad'
      ? t('platform.backup.export.entity_of', { entity: m.alcance.entityNombre ?? '', tenant: m.alcance.tenantNombre })
      : m.alcance.tenantNombre;
  const out =
    `${p.green('✔')} ${p.bold(path.basename(r.archivo))} ` +
    p.dim(
      `${t('platform.backup.export.size', { mb: megabytes(m.bytes), rows: m.totalFilas, tables: m.tablas.length })}\n`
    ) +
    p.dim(`  ${t('platform.backup.export.scope_line', { scope: m.alcance.tipo, owner })}\n`) +
    p.dim(`  ${t('platform.backup.export.read_as', { role: m.leidoComo.rol })}\n`) +
    p.dim(`  ${t('platform.backup.manifest_line', { file: path.basename(r.manifiestoEn) })}\n`);
  const err =
    p.yellow(`  ${t('platform.backup.export.not_a_backup')}\n`) +
    p.dim(`  ${t('platform.backup.export.disaster_hint')}\n`) +
    (m.fueraDeAlcance.length > 0
      ? p.dim(`  ${t('platform.backup.export.out_of_scope', { count: m.fueraDeAlcance.length })}\n`)
      : '') +
    p.dim(`  ${t('platform.backup.export.unredacted')}\n`);
  return { out, err };
}

/**
 * A prose cell of `backup list` (MNE-001-223). The ROW stores the English
 * catalogue, because --json and csv are read by scripts and must not change
 * with the locale; `labels` remembers how the table says it in the user's
 * language, for the kernel's `labelled` hook.
 */
function englishCell(labels: Map<string, string>, key: TranslationKey, params: MessageParams = {}): string {
  const english = t(key, params, 'en');
  labels.set(english, t(key, params));
  return english;
}

export function registerBackupCommand(program: Command, deps: BackupCommandDeps): void {
  const backup = program
    .command('backup')
    .alias('respaldo')
    .description(
      'Logical backups of the whole installation (create, list, verify by rehearsing the restore, restore) ' +
        'and per-tenant logical exports (export)'
    );

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const confirmOrAbort = async (
    opts: CommonOpts,
    question: { key: TranslationKey; params: Record<string, string | number> }
  ): Promise<void> => {
    if (opts.yes) return;
    if (deps.confirm) {
      if (await deps.confirm(t(question.key, question.params))) return;
      throw abortedByUser();
    }
    if (!process.stdin.isTTY) {
      throw abortedByUser({
        key: 'platform.backup.restore.no_terminal',
        params: { question: { key: question.key, params: question.params } },
      });
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const veredicto = await confirmarConReintento(
        (p) => rl.question(p).catch(() => null),
        yesNoPrompt(t(question.key, question.params))
      );
      if (veredicto.si) return;
      throw abortedByUser(
        veredicto.incomprendida !== undefined
          ? { key: 'bank.confirm.taken_as_no', params: { reason: noEntendi(veredicto.incomprendida) } }
          : undefined
      );
    } finally {
      rl.close();
    }
  };

  // ---- backup create ------------------------------------------------
  //
  // LO QUE ESTE COMANDO ES: el volcado de la INSTALACIÓN ENTERA con pg_dump —
  // la vía de recuperación ante desastre, y por eso su comportamiento no
  // cambia.
  //
  // LO QUE DEJÓ DE FINGIR: publicaba `-t/--tenant` («tenant (firm) whose data
  // to scope to») y `-e/--entity` porque llamaba a `withContext`, y los
  // ignoraba — pg_dump no filtra filas. Con un UUID de inquilino inexistente
  // el archivo pesaba EXACTAMENTE lo mismo y traía los datos de los dos
  // despachos de la prueba. Ahora esas dos banderas responden, y lo que
  // responden es a dónde ir: `mnemosine backup export`. Se declaran a
  // propósito en vez de borrarse —«unknown option» no enseña nada a quien ya
  // las tiene escritas en un script— y `--tenant` se comprueba TAMBIÉN en la
  // raíz, porque Commander entrega la opción larga repetida al programa padre
  // y no al subcomando (kernel/flags.ts lo documenta).
  const create = backup
    .command('create')
    .alias('crear')
    .description('Take a logical dump of the WHOLE installation with its schema-version manifest');
  create
    .option(
      '-t, --tenant <id>',
      'NOT here: this dump is not scoped. A per-tenant archive is `mnemosine backup export --tenant <id>`'
    )
    .option(
      '-e, --entity <idOrName>',
      'NOT here: a per-entity archive is `mnemosine backup export --entity <idOrName>`'
    )
    .option('--target <dir>', `directory to write into (default: ${DESTINO_OMISION})`)
    .option('--json', 'JSON output');
  // Lectura para la base (no la modifica), pero IA ✗ por la regla (f) del
  // catálogo: produce un volcado SIN REDACTAR de todos los inquilinos.
  declareRisk(create, { risk: 'lectura', agent: false });
  create.action((opts: CommonOpts) =>
    run(async () => {
      const acotado =
        opts.tenant !== undefined ||
        opts.entity !== undefined ||
        program.getOptionValueSource('tenant') === 'cli';
      if (acotado) {
        throw usageError({ key: 'platform.backup.create.not_scoped' });
      }
      const destino = opts.target ?? DESTINO_OMISION;
      const r = await crearRespaldo({ destino });
      const p = deps.palette;

      if (opts.json) {
        render([{ archivo: r.archivo, manifiesto: r.manifiestoEn, bytes: r.manifiesto.bytes, sha256: r.manifiesto.sha256, alcance: r.manifiesto.alcance.tipo, inquilinos: r.manifiesto.alcance.inquilinos }], { json: true });
        return;
      }
      const schema = t('platform.backup.schema_of', { schema: r.manifiesto.esquema.ultimaMigracion });
      process.stdout.write(
        `${p.green('✔')} ${p.bold(path.basename(r.archivo))} ` +
          p.dim(`(${megabytes(r.manifiesto.bytes)} MB · ${schema})\n`) +
          p.dim(`  ${t('platform.backup.manifest_line', { file: path.basename(r.manifiestoEn) })}\n`)
      );
      // DE QUIÉN ES ESTE ARCHIVO, en voz alta y antes que nada. El manifiesto
      // declaraba con cuidado lo que el volcado NO lleva y callaba a quién
      // pertenece lo que sí lleva; un respaldo que no dice de quién es no se
      // puede custodiar.
      process.stderr.write(
        p.yellow(`  ${t('platform.backup.create.unredacted', { tenants: r.manifiesto.alcance.inquilinos })}\n`) +
          p.dim(`  ${t('platform.backup.create.one_tenant_hint')}\n`) +
          p.yellow(`  ${t('platform.backup.create.no_crypto')}\n`) +
          p.dim(`  ${t('platform.backup.create.crypto_detail')}\n`) +
          p.dim(`  ${t('platform.backup.create.untested_hint')}\n`)
      );
    })
  );

  // ---- backup export ------------------------------------------------
  //
  // SE LLAMA `export` Y NO `create --tenant`, y el nombre ES la decisión.
  //
  // El catálogo prometía «un respaldo lógico consistente del tenant (o de una
  // entidad)». La mitad de la promesa —consistente, acotado, con manifiesto—
  // se cumple aquí. La otra mitad, RESTAURABLE, no: `users.password_hash` sale
  // redactado y es NOT NULL, el orden de dependencias por clave foránea no está
  // resuelto, y `account_balances` volvería a calcularse con los disparadores
  // del mayor. Un artefacto que no se puede volver a meter NO es un respaldo,
  // así que no se llama así en ningún sitio: ni aquí, ni en el manifiesto
  // (`restaurable: false`), ni en el catálogo. Una exportación honesta y bien
  // nombrada vale más que un «respaldo» que no restaura.
  //
  // `export` es el verbo que §1 ya tiene para «sacar datos internos», y el
  // sustantivo sigue siendo `backup`·`respaldo`, que plataforma posee (§5
  // regla 41).
  const exportar = backup
    .command('export')
    .alias('exportar')
    .description(
      "Logical EXPORT of ONE tenant (or one entity): consistent, scoped by the database's own RLS, with a manifest. NOT a restorable backup"
    );
  exportar
    .option('-t, --tenant <id>', 'tenant (firm) to export (defaults to --tenant / MNEMOSINE_TENANT)')
    .option('-e, --entity <idOrName>', 'narrow it further to one legal entity of that tenant')
    .option('--target <dir>', `directory to write into (default: ${DESTINO_OMISION})`)
    .option('--json', 'JSON output');
  // IA ✗ por la misma regla (f) del catálogo: materializa los datos sin
  // redactar de un despacho entero, RFC de terceros incluidos.
  declareRisk(exportar, { risk: 'lectura', agent: false });
  exportar.action((opts: CommonOpts, command: Command) =>
    run(async () => {
      const p = deps.palette;
      // De los globales: Commander entrega `--tenant` al programa PADRE y `-t`
      // al subcomando, así que leer `opts.tenant` a secas perdería la mitad de
      // las invocaciones. Es exactamente el aviso de kernel/flags.ts.
      const tenantId =
        (globalsOf<{ tenant?: string }>(command).tenant ?? currentTenant() ?? '').trim();
      if (!tenantId) {
        throw usageError({ key: 'platform.backup.export.tenant_required' });
      }
      // El contexto se fija ANTES de resolver la entidad: sin esto, resolver un
      // nombre buscaría en los libros de todos los despachos.
      enterTenant(tenantId);

      const entityId = opts.entity ? (await resolveEntity(opts.entity)).entityId : undefined;
      const destino = opts.target ?? DESTINO_OMISION;
      const r = await exportarInquilino({ tenantId, entityId, destino });
      const m = r.manifiesto;

      if (opts.json) {
        render(
          [
            {
              archivo: r.archivo,
              manifiesto: r.manifiestoEn,
              alcance: m.alcance.tipo,
              tenant: m.alcance.tenantId,
              entidad: m.alcance.entityId ?? '',
              bytes: m.bytes,
              sha256: m.sha256,
              filas: m.totalFilas,
              restaurable: m.restaurable,
            },
          ],
          { json: true }
        );
        return;
      }

      const report = exportReport(r, p);
      process.stdout.write(report.out);
      process.stderr.write(report.err);
    })
  );

  // ---- backup list --------------------------------------------------
  const list = backup
    .command('list')
    .alias('listar')
    .description(
      'List known backups and exports with their date, scope, size, schema version and whether their hash still matches'
    );
  withOutput(withSelection(withContext(list)));
  list.option('--target <dir>', `directory to read (default: ${DESTINO_OMISION})`);
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action((opts: CommonOpts) =>
    run(async () => {
      // El grupo de selección trae --status para toda lista; un archivo de
      // respaldo no tiene ciclo de vida, así que se rechaza en vez de
      // ignorarse (mismo trato que `invoice series list`).
      if (opts.status?.length) {
        throw usageError({ key: 'platform.backup.list.no_status' });
      }
      // Y el mismo trato para las banderas de acotación, por la misma razón que
      // en `create`: se publicaban y se ignoraban. Aquí engaña MÁS que allí,
      // porque la columna «alcance» que esta lista estrena hace que parezcan un
      // filtro que existe — pedir el inquilino B listaría lo de A. Filtrar el
      // inventario por alcance no está hecho; decirlo es lo que separa un
      // límite utilizable de uno silencioso.
      if (
        opts.tenant !== undefined ||
        opts.entity !== undefined ||
        program.getOptionValueSource('tenant') === 'cli'
      ) {
        throw usageError({ key: 'platform.backup.list.not_scoped' });
      }
      const directorio = opts.target ?? DESTINO_OMISION;
      const respaldos = await listarRespaldos(directorio);
      // La columna «alcance» era una promesa escrita del catálogo —«fecha,
      // alcance (tenant o entidad), tamaño…»— que no se podía cumplir mientras
      // el único artefacto fuese el volcado entero: todos habrían dicho lo
      // mismo. Con la exportación por inquilino la columna distingue de verdad,
      // así que el inventario mira los dos tipos de archivo del directorio.
      const exportaciones = await listarExportaciones(directorio);
      const labels = new Map<string, string>();
      const cell = (key: TranslationKey, params?: MessageParams): string => englishCell(labels, key, params);
      const intact = (v: boolean | null): string => (v === null ? '?' : v ? cell('platform.backup.list.intact_yes') : 'NO');
      const filas = [
        ...respaldos.map((r) => {
          const tenants = r.manifiesto?.alcance?.inquilinos;
          return {
            archivo: path.basename(r.archivo),
            creado: r.manifiesto?.creado ?? '',
            alcance: r.manifiesto
              ? tenants === undefined
                ? cell('platform.backup.list.scope_installation_unknown')
                : cell('platform.backup.list.scope_installation', { tenants })
              : cell('platform.backup.no_manifest'),
            esquema: r.manifiesto?.esquema.ultimaMigracion ?? cell('platform.backup.no_manifest'),
            mb: r.manifiesto ? megabytes(r.manifiesto.bytes) : '',
            integro: intact(r.integro),
            verificado: r.manifiesto?.verificacion
              ? cell('platform.backup.list.verified_on', {
                  date: r.manifiesto.verificacion.fecha.slice(0, 10),
                  findings: r.manifiesto.verificacion.hallazgos,
                })
              : cell('platform.backup.list.never_verified'),
          };
        }),
        ...exportaciones.map((x) => ({
          archivo: path.basename(x.archivo),
          creado: x.manifiesto?.creado ?? '',
          alcance: x.manifiesto
            ? `${x.manifiesto.alcance.tipo}: ${x.manifiesto.alcance.entityNombre ?? x.manifiesto.alcance.tenantNombre}`
            : cell('platform.backup.no_manifest'),
          esquema: x.manifiesto?.esquema.ultimaMigracion ?? cell('platform.backup.no_manifest'),
          mb: x.manifiesto ? megabytes(x.manifiesto.bytes) : '',
          integro: intact(x.integro),
          // Una exportación no tiene ensayo de restauración que anotar, y
          // escribir «nunca» aquí insinuaría que podría tenerlo.
          verificado: cell('platform.backup.list.export_not_verified'),
        })),
      ].sort((a, b) => b.creado.localeCompare(a.creado));
      const label = (v: string): string => labels.get(v) ?? v;
      render(filas, {
        ...opts,
        total: filas.length,
        idField: 'archivo',
        fields: opts.fields ?? 'archivo,creado,alcance,esquema,mb,integro,verificado',
        labelled: { alcance: label, esquema: label, integro: label, verificado: label },
      });
    })
  );

  // ---- backup verify ------------------------------------------------
  const verify = backup
    .command('verify')
    .alias('comprobar')
    .argument('<file>', 'backup file to verify')
    .description('Verify a backup against its manifest; with --restore, rehearse the restore and run the ledger checks');
  withOutput(withContext(verify));
  verify
    .option('--restore', 'RESTORE it into a throwaway database and run the ledger checks (the only real proof)')
    .option('--strict', 'exit 4 on warnings too');
  declareRisk(verify, { risk: 'lectura', agent: true });
  verify.action((archivo: string, opts: CommonOpts) =>
    run(async () => {
      const p = deps.palette;

      if (!opts.restore) {
        // Lo barato, y se DICE que es lo barato.
        const dir = path.dirname(archivo);
        const encontrado = (await listarRespaldos(dir)).find(
          (r) => path.basename(r.archivo) === path.basename(archivo)
        );
        if (!encontrado) throw usageError({ key: 'platform.backup.verify.not_found', params: { file: archivo } });
        const ok = encontrado.integro === true;
        if (opts.json) {
          render([{ archivo, integro: ok, esquema: encontrado.manifiesto?.esquema.ultimaMigracion ?? null, ensayo: false }], { json: true });
        } else {
          const schema = t('platform.backup.schema_of', {
            schema: encontrado.manifiesto?.esquema.ultimaMigracion ?? t('platform.backup.no_manifest'),
          });
          process.stdout.write(
            (ok
              ? `${p.green('✔')} ${t('platform.backup.verify.hash_ok')}`
              : `${p.red('✘')} ${t('platform.backup.verify.hash_mismatch')}`) + p.dim(` · ${schema}\n`)
          );
          process.stderr.write(
            p.yellow(`  ${t('platform.backup.verify.not_proof')}`) +
              p.dim(` ${t('platform.backup.verify.repeat_with_restore')}\n`)
          );
        }
        if (!ok) await deps.shutdown(4);
        return;
      }

      const r = await verificarRespaldo(archivo);
      const bloqueantes = r.hallazgos.filter((h) => h.severity === 'blocking').length;

      if (opts.json) {
        render([{ archivo, restauro: r.restauro, integro: r.integro, entidades: r.entidadesRevisadas, hallazgos: r.hallazgos.length, bloqueantes }], { json: true });
      } else {
        process.stdout.write(
          (r.restauro
            ? `${p.green('✔')} ${t('platform.backup.verify.restored')}`
            : `${p.red('✘')} ${t('platform.backup.verify.not_restored')}`) +
            p.dim(
              ` · ${t('platform.backup.verify.counts', { entities: r.entidadesRevisadas, findings: r.hallazgos.length })}\n`
            )
        );
        for (const h of r.hallazgos.slice(0, 10)) {
          process.stdout.write(`  ${p.red('✘')} ${h.entidad} · ${h.check} · ${h.referencia ?? ''} ${p.dim(h.detalle)}\n`);
        }
        if (r.integro === false) {
          process.stdout.write(p.red(`  ✘ ${t('platform.backup.verify.hash_mismatch')}\n`));
        }
        process.stdout.write(p.dim(`  ${r.detalle}\n`));
      }

      const code = checkExitCode(
        { blocking: r.restauro && r.integro !== false ? bloqueantes : 1, warning: r.hallazgos.length - bloqueantes },
        { strict: opts.strict === true }
      );
      if (code !== 0) await deps.shutdown(code);
    })
  );

  // ---- backup restore -----------------------------------------------
  const restore = backup
    .command('restore')
    .alias('restaurar')
    .argument('<file>', 'backup file to restore')
    .description('Restore a backup into a NEW database; never over an existing one');
  withContext(restore);
  restore
    .requiredOption('--target <database>', 'name of the NEW database to create and restore into')
    .option('--json', 'JSON output');
  declareRisk(restore, {
    risk: 'irreversible',
    llave: { sinLlave: { key: 'platform.backup.restore.retry_restores' } },
    agent: false,
    writes: 'creates a new database and fills it with the dump',
  });
  restore.action((archivo: string, opts: CommonOpts) =>
    run(async () => {
      const { dryRun } = gateMutation(restore, opts as unknown as Record<string, unknown>);
      const p = deps.palette;
      const destino = opts.target as string;

      if (dryRun) {
        process.stdout.write(
          `${p.bold(t('platform.backup.restore.would_restore', { file: path.basename(archivo), database: destino }))}\n` +
            p.dim(`  ${t('platform.backup.restore.nothing_written')}\n`)
        );
        return;
      }
      await confirmOrAbort(opts, {
        key: 'platform.backup.restore.confirm',
        params: { database: destino, file: path.basename(archivo) },
      });
      const r = await restaurarRespaldo(archivo, destino);
      if (opts.json) {
        render([{ archivo: r.archivo, destino: r.destino, creada: r.creada }], { json: true });
        return;
      }
      process.stdout.write(
        `${p.green('✔')} ${t('platform.backup.restore.done', { database: p.bold(r.destino) })}\n` +
          p.dim(`  ${t('platform.backup.restore.previous_intact')}\n`) +
          p.dim(`  ${t('platform.backup.restore.check_first', { file: path.basename(archivo) })}\n`)
      );
    })
  );
}
