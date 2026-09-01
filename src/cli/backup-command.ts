import * as readline from 'node:readline/promises';
import * as path from 'node:path';
import type { Command } from 'commander';
import {
  crearRespaldo,
  listarRespaldos,
  verificarRespaldo,
  restaurarRespaldo,
} from '../services/backup/backup-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  withOutput,
  withSelection,
  withContext,
  usageError,
  abortedByUser,
  exitCodeFor,
  checkExitCode,
} from './kernel/index.js';

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
// `create` es IA ✗ por la regla (f) del catálogo: produce un volcado SIN
// REDACTAR del inquilino entero. `restore` es irreversible y crea una base
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

export function registerBackupCommand(program: Command, deps: BackupCommandDeps): void {
  const backup = program
    .command('backup')
    .alias('respaldo')
    .description('Logical backups: create, list, verify (optionally by rehearsing the restore) and restore');

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const confirmOrAbort = async (opts: CommonOpts, question: string): Promise<void> => {
    if (opts.yes) return;
    if (deps.confirm) {
      if (await deps.confirm(question)) return;
      throw abortedByUser();
    }
    if (!process.stdin.isTTY) {
      throw abortedByUser(
        `${question} — there is no terminal to ask on. Re-run with --yes once you are sure.`
      );
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') throw abortedByUser();
    } finally {
      rl.close();
    }
  };

  // ---- backup create ------------------------------------------------
  const create = backup
    .command('create')
    .alias('crear')
    .description('Take a logical dump of the database with its schema-version manifest');
  withContext(create);
  create
    .option('--target <dir>', `directory to write into (default: ${DESTINO_OMISION})`)
    .option('--json', 'JSON output');
  // Lectura para la base (no la modifica), pero IA ✗: produce un volcado SIN
  // REDACTAR del inquilino entero — la regla (f) del catálogo es sobre el
  // DATO, no sobre el verbo.
  declareRisk(create, { risk: 'lectura', agent: false });
  create.action((opts: CommonOpts) =>
    run(async () => {
      const destino = opts.target ?? DESTINO_OMISION;
      const r = await crearRespaldo({ destino });
      const p = deps.palette;

      if (opts.json) {
        render([{ archivo: r.archivo, manifiesto: r.manifiestoEn, bytes: r.manifiesto.bytes, sha256: r.manifiesto.sha256 }], { json: true });
        return;
      }
      process.stdout.write(
        `${p.green('✔')} ${p.bold(path.basename(r.archivo))} ` +
          p.dim(`(${(r.manifiesto.bytes / 1024 / 1024).toFixed(1)} MB · esquema ${r.manifiesto.esquema.ultimaMigracion})\n`) +
          p.dim(`  manifiesto: ${path.basename(r.manifiestoEn)}\n`)
      );
      // Lo que el volcado NO lleva se dice AQUÍ, no sólo en el manifiesto:
      // quien no lo lea creerá que tiene un respaldo completo.
      process.stderr.write(
        p.yellow('  Este volcado NO incluye el material criptográfico:\n') +
          p.dim(
            '  la llave del vault y ENCRYPTION_KEY viven fuera de la base. Sin ellas, al restaurar\n' +
              '  las credenciales fiscales y los datos bancarios quedan ilegibles. Respáldalas aparte.\n'
          ) +
          p.dim('  Y un respaldo no probado no es un respaldo: `mnemosine backup verify <archivo> --restore`.\n')
      );
    })
  );

  // ---- backup list --------------------------------------------------
  const list = backup
    .command('list')
    .alias('listar')
    .description('List known backups with their date, size, schema version and whether their hash still matches');
  withOutput(withSelection(withContext(list)));
  list.option('--target <dir>', `directory to read (default: ${DESTINO_OMISION})`);
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action((opts: CommonOpts) =>
    run(async () => {
      // El grupo de selección trae --status para toda lista; un archivo de
      // respaldo no tiene ciclo de vida, así que se rechaza en vez de
      // ignorarse (mismo trato que `invoice series list`).
      if (opts.status?.length) {
        throw usageError(
          '`backup list` no tiene estado que filtrar: un respaldo es un archivo, no un documento con ciclo.'
        );
      }
      const respaldos = await listarRespaldos(opts.target ?? DESTINO_OMISION);
      render(
        respaldos.map((r) => ({
          archivo: path.basename(r.archivo),
          creado: r.manifiesto?.creado ?? '',
          esquema: r.manifiesto?.esquema.ultimaMigracion ?? '(sin manifiesto)',
          mb: r.manifiesto ? (r.manifiesto.bytes / 1024 / 1024).toFixed(1) : '',
          integro: r.integro === null ? '?' : r.integro ? 'sí' : 'NO',
          verificado: r.manifiesto?.verificacion
            ? `${r.manifiesto.verificacion.fecha.slice(0, 10)} (${r.manifiesto.verificacion.hallazgos} hallazgos)`
            : 'nunca',
        })),
        {
          ...opts,
          total: respaldos.length,
          idField: 'archivo',
          fields: opts.fields ?? 'archivo,creado,esquema,mb,integro,verificado',
        }
      );
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
        if (!encontrado) throw usageError(`No se encontró el respaldo ${archivo}`);
        const ok = encontrado.integro === true;
        if (opts.json) {
          render([{ archivo, integro: ok, esquema: encontrado.manifiesto?.esquema.ultimaMigracion ?? null, ensayo: false }], { json: true });
        } else {
          process.stdout.write(
            (ok ? `${p.green('✔')} hash y manifiesto cuadran` : `${p.red('✘')} el hash NO cuadra con el manifiesto`) +
              p.dim(` · esquema ${encontrado.manifiesto?.esquema.ultimaMigracion ?? '(sin manifiesto)'}\n`)
          );
          process.stderr.write(
            p.yellow('  Esto NO prueba que el respaldo restaure.') +
              p.dim(' Un respaldo no probado no es un respaldo: repite con --restore.\n')
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
          (r.restauro ? `${p.green('✔')} restauró en una base de usar y tirar` : `${p.red('✘')} NO restauró`) +
            p.dim(` · ${r.entidadesRevisadas} entidad(es) revisadas · ${r.hallazgos.length} hallazgo(s)\n`)
        );
        for (const h of r.hallazgos.slice(0, 10)) {
          process.stdout.write(`  ${p.red('✘')} ${h.entidad} · ${h.check} · ${h.referencia ?? ''} ${p.dim(h.detalle)}\n`);
        }
        if (r.integro === false) {
          process.stdout.write(p.red('  ✘ el hash no cuadra con el manifiesto\n'));
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
    agent: false,
    writes: 'crea una base de datos nueva y la puebla con el volcado',
  });
  restore.action((archivo: string, opts: CommonOpts) =>
    run(async () => {
      const { dryRun } = gateMutation(restore, opts as unknown as Record<string, unknown>);
      const p = deps.palette;
      const destino = opts.target as string;

      if (dryRun) {
        process.stdout.write(
          `${p.bold(`Would restore ${path.basename(archivo)}`)} ${p.dim(`into a NEW database "${destino}"`)}\n` +
            p.dim('  Nothing is written, and no existing database is ever touched.\n')
        );
        return;
      }
      await confirmOrAbort(
        opts,
        `Create database "${destino}" and restore ${path.basename(archivo)} into it?`
      );
      const r = await restaurarRespaldo(archivo, destino);
      if (opts.json) {
        render([{ archivo: r.archivo, destino: r.destino, creada: r.creada }], { json: true });
        return;
      }
      process.stdout.write(
        `${p.green('✔')} restaurado en la base ${p.bold(r.destino)}\n` +
          p.dim('  La base anterior sigue intacta: apuntar la aplicación a la nueva es un acto aparte.\n') +
          p.dim(`  Compruébala antes: mnemosine backup verify ${path.basename(archivo)} --restore\n`)
      );
    })
  );
}
