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
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';

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
      const veredicto = await confirmarConReintento(
        (p) => rl.question(p).catch(() => null),
        `${question} [y/N] `
      );
      if (veredicto.si) return;
      throw abortedByUser(
        veredicto.incomprendida !== undefined
          ? `Aborted — ${noEntendi(veredicto.incomprendida)}.`
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
        throw usageError(
          '`backup create` vuelca la instalación ENTERA con pg_dump, que no filtra filas: acotarlo ' +
            'a un inquilino o a una entidad es imposible por construcción, y hasta hoy la bandera ' +
            'se aceptaba y se ignoraba en silencio.\n' +
            'Para el archivo de UN despacho: `mnemosine backup export --tenant <id>` ' +
            '(con `--entity <id|nombre>` para una sola sociedad).\n' +
            'Para la recuperación ante desastre de la instalación completa: `backup create` sin banderas.'
        );
      }
      const destino = opts.target ?? DESTINO_OMISION;
      const r = await crearRespaldo({ destino });
      const p = deps.palette;

      if (opts.json) {
        render([{ archivo: r.archivo, manifiesto: r.manifiestoEn, bytes: r.manifiesto.bytes, sha256: r.manifiesto.sha256, alcance: r.manifiesto.alcance.tipo, inquilinos: r.manifiesto.alcance.inquilinos }], { json: true });
        return;
      }
      process.stdout.write(
        `${p.green('✔')} ${p.bold(path.basename(r.archivo))} ` +
          p.dim(`(${(r.manifiesto.bytes / 1024 / 1024).toFixed(1)} MB · esquema ${r.manifiesto.esquema.ultimaMigracion})\n`) +
          p.dim(`  manifiesto: ${path.basename(r.manifiestoEn)}\n`)
      );
      // DE QUIÉN ES ESTE ARCHIVO, en voz alta y antes que nada. El manifiesto
      // declaraba con cuidado lo que el volcado NO lleva y callaba a quién
      // pertenece lo que sí lleva; un respaldo que no dice de quién es no se
      // puede custodiar.
      process.stderr.write(
        p.yellow(
          `  Contiene los datos SIN REDACTAR de ${r.manifiesto.alcance.inquilinos} inquilino(s): es la instalación entera, no un despacho.\n`
        ) +
          p.dim('  Para el archivo de uno solo: `mnemosine backup export --tenant <id>`.\n') +
          p.yellow('  Y NO incluye el material criptográfico:\n') +
          p.dim(
            '  la llave del vault y ENCRYPTION_KEY viven fuera de la base. Sin ellas, al restaurar\n' +
              '  las credenciales fiscales y los datos bancarios quedan ilegibles. Respáldalas aparte.\n'
          ) +
          p.dim('  Y un respaldo no probado no es un respaldo: `mnemosine backup verify <archivo> --restore`.\n')
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
        throw usageError(
          'No hay inquilino que exportar. Nómbralo con `--tenant <uuid>` o fija MNEMOSINE_TENANT.\n' +
            'Un archivo que no dice de quién es no se puede custodiar, así que esto no se adivina.'
        );
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

      const de =
        m.alcance.tipo === 'entidad'
          ? `${m.alcance.entityNombre ?? ''} (entidad de ${m.alcance.tenantNombre})`
          : m.alcance.tenantNombre;
      process.stdout.write(
        `${p.green('✔')} ${p.bold(path.basename(r.archivo))} ` +
          p.dim(`(${(m.bytes / 1024 / 1024).toFixed(1)} MB · ${m.totalFilas} filas · ${m.tablas.length} tablas)\n`) +
          p.dim(`  alcance: ${m.alcance.tipo} — ${de}\n`) +
          p.dim(`  leído como ${m.leidoComo.rol}, sujeto a RLS, en una sola instantánea REPEATABLE READ\n`) +
          p.dim(`  manifiesto: ${path.basename(r.manifiestoEn)}\n`)
      );
      process.stderr.write(
        p.yellow('  Esto es una EXPORTACIÓN, no un respaldo: no hay camino de vuelta probado.\n') +
          p.dim('  Para recuperación ante desastre: `mnemosine backup create` + `backup restore`.\n') +
          (m.fueraDeAlcance.length > 0
            ? p.dim(
                `  ${m.fueraDeAlcance.length} tabla(s) acotada(s) quedan fuera de este alcance; el manifiesto las nombra una por una.\n`
              )
            : '') +
          p.dim('  Lleva datos sin redactar del despacho, RFC de terceros incluidos: trátalo como tal.\n')
      );
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
        throw usageError(
          '`backup list` no tiene estado que filtrar: un respaldo es un archivo, no un documento con ciclo.'
        );
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
        throw usageError(
          '`backup list` inventaría un DIRECTORIO, y todavía no filtra por alcance: la bandera se ' +
            'aceptaba y se ignoraba.\n' +
            'La columna «alcance» de la salida ya dice de quién es cada archivo — inquilino, entidad ' +
            'o instalación completa —, así que por ahora el filtro se hace leyéndola.'
        );
      }
      const directorio = opts.target ?? DESTINO_OMISION;
      const respaldos = await listarRespaldos(directorio);
      // La columna «alcance» era una promesa escrita del catálogo —«fecha,
      // alcance (tenant o entidad), tamaño…»— que no se podía cumplir mientras
      // el único artefacto fuese el volcado entero: todos habrían dicho lo
      // mismo. Con la exportación por inquilino la columna distingue de verdad,
      // así que el inventario mira los dos tipos de archivo del directorio.
      const exportaciones = await listarExportaciones(directorio);
      const filas = [
        ...respaldos.map((r) => ({
          archivo: path.basename(r.archivo),
          creado: r.manifiesto?.creado ?? '',
          alcance: r.manifiesto
            ? `instalación (${r.manifiesto.alcance?.inquilinos ?? '?'} inquilinos)`
            : '(sin manifiesto)',
          esquema: r.manifiesto?.esquema.ultimaMigracion ?? '(sin manifiesto)',
          mb: r.manifiesto ? (r.manifiesto.bytes / 1024 / 1024).toFixed(1) : '',
          integro: r.integro === null ? '?' : r.integro ? 'sí' : 'NO',
          verificado: r.manifiesto?.verificacion
            ? `${r.manifiesto.verificacion.fecha.slice(0, 10)} (${r.manifiesto.verificacion.hallazgos} hallazgos)`
            : 'nunca',
        })),
        ...exportaciones.map((x) => ({
          archivo: path.basename(x.archivo),
          creado: x.manifiesto?.creado ?? '',
          alcance: x.manifiesto
            ? `${x.manifiesto.alcance.tipo}: ${x.manifiesto.alcance.entityNombre ?? x.manifiesto.alcance.tenantNombre}`
            : '(sin manifiesto)',
          esquema: x.manifiesto?.esquema.ultimaMigracion ?? '(sin manifiesto)',
          mb: x.manifiesto ? (x.manifiesto.bytes / 1024 / 1024).toFixed(1) : '',
          integro: x.integro === null ? '?' : x.integro ? 'sí' : 'NO',
          // Una exportación no tiene ensayo de restauración que anotar, y
          // escribir «nunca» aquí insinuaría que podría tenerlo.
          verificado: 'n/a (exportación, no restaurable)',
        })),
      ].sort((a, b) => b.creado.localeCompare(a.creado));
      render(filas, {
        ...opts,
        total: filas.length,
        idField: 'archivo',
        fields: opts.fields ?? 'archivo,creado,alcance,esquema,mb,integro,verificado',
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
