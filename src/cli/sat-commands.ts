import fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import type { Command } from 'commander';
import { resolveEntity } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { getVault } from '../services/vault/index.js';
import { parseCertificate, verifyKeyPair } from '../services/fiscal-credentials/certificate.js';
import {
  storeCredential,
  getCredentialStatus,
  getAccessLog,
  revokeCredential,
  CONSENT_TEXT,
} from '../services/fiscal-credentials/service.js';
import { declareRisk, gateMutation } from './kernel/risk.js';
import { exitCodeFor, notFound, ExitCode, describeCommand, optionByKey } from './kernel/index.js';
import { registerSatDownloadCommands } from './sat-download-commands.js';
import { calendarDateIn } from '../utils/calendar-date.js';
import { zoneFor } from '../services/policy/today.js';
import { registerSatCensus } from './sat-census-command.js';
import { t } from '../i18n/index.js';

// ============================================================
// `mnemosine sat cred …` COMMANDS
// Capture, status, audit and revocation of the e.firma.
// The password is asked with echo off and is never printed.
// What they print comes from the I8.7 block of the catalogue (MNE-001-600)
// and goes straight to stdout or stderr: only the words change with the
// language, never what is read, stored or destroyed.
// ============================================================

export interface SatCommandDeps {
  color: { dim: (s: string) => string; bold: (s: string) => string; cyan: (s: string) => string };
  colorErr: { dim: (s: string) => string; red: (s: string) => string };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
  ask: (rl: readline.Interface, prompt: string) => Promise<string | null>;
}

/** Reads a file, warning if its permissions expose it to other users. */
function readSensitiveFile(file: string, label: string, warn: (s: string) => void): Buffer {
  if (!fs.existsSync(file)) throw notFound({ key: 'fiscal_mx.sat.cred.file_missing', params: { label, file } });
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) {
    warn(t('fiscal_mx.sat.cred.file_exposed', { file, mode: (stat.mode & 0o777).toString(8) }));
  }
  return fs.readFileSync(file);
}

/** Asks without echo: the password does not stay on screen or in history. */
async function askHidden(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const asHidden = rl as unknown as { _writeToOutput?: (s: string) => void; output?: { write: (s: string) => void } };
  const originalWrite = asHidden._writeToOutput?.bind(rl);
  asHidden._writeToOutput = (str: string) => {
    // Show the prompt but hide what is typed.
    if (str.includes(prompt)) originalWrite?.(str);
    else asHidden.output?.write('');
  };
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
    stdout.write('\n');
  }
}

export function registerSatCommands(program: Command, deps: SatCommandDeps): void {
  const { color: c, colorErr: ce, shutdown, reportError, ask } = deps;
  const sat = describeCommand(program.command('sat'), 'help.sat.description');
  const cred = describeCommand(sat.command('cred'), 'help.sat.cred.description');
  registerSatCensus(sat, { shutdown, reportError });

  const add = describeCommand(cred.command('add').alias('agregar'), 'help.sat.cred.add.description');
  optionByKey(add, '--cer <file>', 'help.sat.cred.add.option.cer', { mandatory: true });
  optionByKey(add, '--key <file>', 'help.sat.cred.add.option.key', { mandatory: true });
  optionByKey(add, '-e, --entity <idOrName>', 'help.sat.cred.add.option.entity');
  optionByKey(add, '-u, --user <email>', 'help.sat.cred.add.option.user');
  optionByKey(add, '--no-unattended', 'help.sat.cred.add.option.no_unattended');
  optionByKey(add, '--max-diario <n>', 'help.sat.cred.add.option.max_diario', { parser: (v) => parseInt(v, 10) });
  // Externo, declarado junto a su registro (S0.6): el material viaja a la
  // bóveda (AWS Secrets Manager) — un sistema fuera de éste. El kernel añade
  // --dry-run, --yes, --idempotency-key y --live, y aquí se honran: --dry-run
  // valida el certificado sin pedir la contraseña ni guardar nada, y el
  // depósito real exige --live. El consentimiento tecleado NO lo salta --yes:
  // la custodia de una e.firma se autoriza escribiendo "accept", siempre.
  add.addHelpText(
    'after',
    `
Examples:
  # Validate the e.firma locally, without asking for the passphrase or storing anything.
  mnemosine sat cred add --cer firma.cer --key firma.key --dry-run
  # Store it in the vault for the entity (asks for the passphrase and the typed consent).
  mnemosine sat cred add --cer firma.cer --key firma.key --entity "Demo Corp" --live
`
  );
  declareRisk(add, {
    risk: 'externo',
    llave: { innecesaria: t('fiscal_mx.sat.cred.add.key_unneeded') },
    agent: false,
    writes: 'fiscal_credentials + the material in the vault; validates the certificate locally first',
  });
  add.action(async (opts: {
      cer: string; key: string; entity?: string; user?: string;
      unattended: boolean; maxDiario?: number;
      dryRun?: boolean; live?: boolean; yes?: boolean; idempotencyKey?: string;
    }) => {
      let rl: readline.Interface | undefined;
      try {
        const ctx = await resolveEntity(opts.entity);
        const { dryRun, live } = gateMutation(add, opts);
        if (opts.idempotencyKey) {
          stderr.write(
            `  ${t('fiscal_mx.sat.cred.key_unneeded_note', { reason: t('fiscal_mx.sat.cred.add.key_unneeded') })}\n`
          );
        }
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const cer = readSensitiveFile(opts.cer, '.cer', (s) => stderr.write(ce.red(`\n${s}\n`)));
        const key = readSensitiveFile(opts.key, '.key', (s) => stderr.write(ce.red(`\n${s}\n`)));

        // 1) Local validation: fail here before the secret leaves the machine.
        const info = parseCertificate(cer);
        const zone = await zoneFor(ctx);
        stdout.write(
          `\n${c.bold(t('fiscal_mx.sat.cred.add.certificate_read'))}\n` +
            t('fiscal_mx.sat.cred.add.certificate', {
              type: info.type === 'efirma' ? c.bold('e.firma') : info.type,
              rfc: info.rfc,
              serial: info.serial,
              from: calendarDateIn(zone, info.validFrom),
              to: calendarDateIn(zone, info.validTo),
              entity: ctx.entityName,
              taxId: ctx.taxId,
            }) +
            '\n'
        );
        if (info.type === 'csd') {
          stderr.write(ce.red(`\n${t('fiscal_mx.sat.cred.add.csd')}`) + '\n');
          // El certificado se leyó bien y NO pasa la regla: eso es VALIDATION,
          // el mismo 4 que una póliza descuadrada. Con 1 el guion que deposita
          // credenciales en lote no puede distinguir «este .cer no sirve» de
          // «la bóveda no respondió», que sí es reintentable.
          await shutdown(ExitCode.VALIDATION);
        }
        // The RFC is validated BEFORE asking for the password: nobody should
        // type their e.firma passphrase only to find out afterwards that they
        // picked the wrong entity. (storeCredential revalidates it as a safety net.)
        if (info.rfc.toUpperCase() !== ctx.taxId.toUpperCase()) {
          stderr.write(
            ce.red(
              `\n${t('fiscal_mx.sat.cred.add.rfc_mismatch', { rfc: info.rfc, entity: ctx.entityName, taxId: ctx.taxId })}`
            ) + '\n'
          );
          stderr.write(c.dim(t('fiscal_mx.sat.cred.add.pick_entity')) + '\n');
          await shutdown(ExitCode.VALIDATION);
        }
        if (info.validTo <= new Date()) {
          stderr.write(
            ce.red(`\n${t('fiscal_mx.sat.cred.add.expired', { date: calendarDateIn(zone, info.validTo) })}`) + '\n'
          );
          // «credential expired» está NOMBRADO en la tabla de exit.ts como el
          // caso de BLOCKED. No es que el material sea inválido: era válido y
          // el calendario lo bloqueó.
          await shutdown(ExitCode.BLOCKED);
        }

        if (dryRun) {
          stdout.write(c.dim(`\n${t('fiscal_mx.sat.cred.add.dry_run')}`) + '\n');
          await shutdown(0);
        }
        if (!live) {
          stdout.write(
            c.bold(`\n${t('fiscal_mx.sat.cred.add.validation_passed')}`) +
              c.dim(` ${t('fiscal_mx.sat.cred.add.live_needed')}`) +
              '\n'
          );
          await shutdown(0);
        }

        const password = await askHidden(c.cyan(`\n${t('fiscal_mx.sat.cred.add.password_prompt')}: `));
        if (!verifyKeyPair(cer, key, password)) {
          stderr.write(ce.red(`\n${t('fiscal_mx.sat.cred.add.bad_pair')}`) + '\n');
          await shutdown(ExitCode.VALIDATION);
        }
        stdout.write(c.dim(t('fiscal_mx.sat.cred.add.pair_verified')) + '\n');

        // 2) Explicit informed consent. --yes does NOT skip it on purpose:
        // custody of an e.firma is authorized by typing the word, always.
        stdout.write(`\n${CONSENT_TEXT}\n\n`);
        rl = readline.createInterface({ input: stdin, output: stdout });
        const ok = await ask(rl, c.cyan(`${t('fiscal_mx.sat.cred.add.consent_prompt')}: `));
        rl.close();
        if ((ok ?? '').trim().toLowerCase() !== 'accept') {
          stdout.write(c.dim(t('fiscal_mx.sat.cred.add.cancelled')) + '\n');
          await shutdown(0);
        }

        const row = await storeCredential({
          tenantId: ctx.tenantId,
          entityId: ctx.entityId,
          material: { cer, key, password },
          consentBy: reviewer.email,
          unattendedAccess: opts.unattended,
          maxDailyAccess: opts.maxDiario,
        });
        const vault = getVault();
        stdout.write(
          `\n✔ ${t('fiscal_mx.sat.cred.add.registered', { entity: c.bold(ctx.entityName) })}\n` +
            c.dim(`  ${t('fiscal_mx.sat.cred.add.custody', { backend: vault.backend })}\n`) +
            c.dim(`  ${t('fiscal_mx.sat.cred.add.unattended', {
              unattended: row.unattended_access ? 'yes' : 'no',
              limit: String(row.max_daily_access),
            })}\n`) +
            c.dim(`  ${t('fiscal_mx.sat.cred.add.audit_hint', { command: 'mnemosine sat cred audit' })}`) +
            '\n'
        );
        await shutdown(0);
      } catch (err) {
        rl?.close();
        reportError(err);
        await shutdown(exitCodeFor(err));
      }
    });

  const status = describeCommand(cred.command('status').alias('estado'), 'help.sat.cred.status.description');
  optionByKey(status, '-e, --entity <idOrName>', 'help.sat.cred.status.option.entity');
  status
    .action(async (opts: { entity?: string }) => {
      try {
        const ctx = await resolveEntity(opts.entity);
        const rows = await getCredentialStatus(ctx.entityId, ctx.tenantId);
        if (rows.length === 0) {
          stdout.write(t('fiscal_mx.sat.cred.status.none', { command: 'mnemosine sat cred add' }) + '\n');
        } else {
          for (const r of rows) {
            const icon = r.status === 'active' ? '✔' : r.status === 'revoked' ? '✘' : '⚠';
            const days = { days: r.days_to_expiry };
            const expiry =
              r.days_to_expiry < 0 ? c.dim(t('fiscal_mx.sat.cred.status.expired'))
              : r.days_to_expiry < 60 ? ce.red(t('fiscal_mx.sat.cred.status.expires_soon', days))
              : c.dim(t('fiscal_mx.sat.cred.status.expires_in', days));
            stdout.write(
              `${icon} ${c.bold(r.credential_type)} ${r.rfc} · ${r.status} ${expiry}\n` +
                c.dim(`  ${t('fiscal_mx.sat.cred.status.custody', { serial: r.cert_serial, backend: r.vault_backend })}\n`) +
                c.dim(`  ${t('fiscal_mx.sat.cred.status.usage', {
                  unattended: r.unattended_access ? 'yes' : 'no',
                  limit: String(r.max_daily_access),
                  last: r.last_used_at
                    ? new Date(r.last_used_at).toISOString()
                    : t('fiscal_mx.sat.cred.status.never_used'),
                })}`) +
                '\n'
            );
          }
        }
        const health = await getVault().healthCheck();
        stdout.write(
          c.dim(`\n${t('fiscal_mx.sat.cred.status.vault', { health: health.healthy ? 'ok' : 'error', detail: health.detail ?? '' })}`) +
            '\n'
        );
        await shutdown(0);
      } catch (err) {
        reportError(err);
        await shutdown(exitCodeFor(err));
      }
    });

  const audit = describeCommand(cred.command('audit').alias('auditoria'), 'help.sat.cred.audit.description');
  optionByKey(audit, '-e, --entity <idOrName>', 'help.sat.cred.audit.option.entity');
  optionByKey(audit, '-n, --limit <n>', 'help.sat.cred.audit.option.limit', {
    parser: (v) => parseInt(v, 10),
    defaultValue: 30,
  });
  audit
    .action(async (opts: { entity?: string; limit: number }) => {
      try {
        const ctx = await resolveEntity(opts.entity);
        const log = (await getAccessLog(ctx.entityId, ctx.tenantId, opts.limit));
        if (log.length === 0) {
          stdout.write(t('fiscal_mx.sat.cred.audit.none') + '\n');
        } else {
          stdout.write(c.bold(t('fiscal_mx.sat.cred.audit.title', { entity: ctx.entityName })) + '\n');
          for (const l of log) {
            const icon = l.outcome === 'success' ? '·' : l.outcome === 'denied' ? '⊘' : '✘';
            const extra = l.denied_reason ? `/${l.denied_reason}` : l.error ? `: ${l.error}` : '';
            const mode = t('fiscal_mx.sat.cred.audit.mode', { mode: l.unattended ? 'unattended' : 'operator' });
            stdout.write(
              `${icon} ${new Date(l.accessed_at as string).toISOString()} · ${l.purpose} · ${l.actor}` +
                c.dim(` · ${mode} · ${l.outcome}${extra}`) +
                '\n'
            );
          }
        }
        await shutdown(0);
      } catch (err) {
        reportError(err);
        await shutdown(exitCodeFor(err));
      }
    });

  const revoke = describeCommand(cred.command('revoke').alias('revocar'), 'help.sat.cred.revoke.description');
  optionByKey(revoke, '-e, --entity <idOrName>', 'help.sat.cred.revoke.option.entity');
  optionByKey(revoke, '-u, --user <email>', 'help.sat.cred.revoke.option.user');
  // Irreversible, declarado junto a su registro (S0.6): la destrucción del
  // material en la bóveda es criptográfica. El kernel añade --dry-run, --yes,
  // --idempotency-key y —por ser un verbo que deshace— --reason obligatoria,
  // que aterriza en audit_log vía revokeCredential.
  revoke.addHelpText(
    'after',
    `
Examples:
  # See what a revocation would do, without touching the vault.
  mnemosine sat cred revoke --entity "Demo Corp" --reason "e.firma renewed" --dry-run
  # Revoke it and destroy the material (irreversible).
  mnemosine sat cred revoke --entity "Demo Corp" --reason "e.firma renewed" --yes
`
  );
  declareRisk(revoke, {
    risk: 'irreversible',
    llave: { innecesaria: t('fiscal_mx.sat.cred.revoke.key_unneeded') },
    agent: false,
    writes: 'fiscal_credentials + cryptographic destruction of the material in the vault',
  });
  revoke.action(async (opts: {
      entity?: string; user?: string;
      dryRun?: boolean; yes?: boolean; reason?: string; idempotencyKey?: string;
    }) => {
      let rl: readline.Interface | undefined;
      try {
        const ctx = await resolveEntity(opts.entity);
        const { dryRun, reason } = gateMutation(revoke, opts);
        if (opts.idempotencyKey) {
          stderr.write(
            `  ${t('fiscal_mx.sat.cred.key_unneeded_note', { reason: t('fiscal_mx.sat.cred.revoke.key_unneeded') })}\n`
          );
        }
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        if (dryRun) {
          const rows = await getCredentialStatus(ctx.entityId, ctx.tenantId);
          const activa = rows.find((r) => r.status === 'active');
          if (!activa) {
            stdout.write(t('fiscal_mx.sat.cred.revoke.nothing_active') + '\n');
            await shutdown(0);
          }
          stdout.write(
            t('fiscal_mx.sat.cred.revoke.would', {
              verb: c.bold(t('fiscal_mx.sat.cred.revoke.would_revoke')),
              type: activa!.credential_type,
              entity: ctx.entityName,
              serial: activa!.cert_serial,
              custody: c.dim(t('fiscal_mx.sat.cred.revoke.custody', { backend: activa!.vault_backend })),
            }) + '\n'
          );
          stdout.write(c.dim(t('fiscal_mx.sat.cred.revoke.dry_run')) + '\n');
          await shutdown(0);
        }

        stdout.write(
          ce.red(`\n${t('fiscal_mx.sat.cred.revoke.about_to', { entity: ctx.entityName })}`) +
            c.dim(`\n${t('fiscal_mx.sat.cred.revoke.irreversible')}\n`) +
            '\n'
        );
        if (!opts.yes) {
          rl = readline.createInterface({ input: stdin, output: stdout });
          const ok = await ask(rl, c.cyan(`${t('fiscal_mx.sat.cred.revoke.confirm_prompt')}: `));
          rl.close();
          if ((ok ?? '').trim().toUpperCase() !== ctx.taxId.toUpperCase()) {
            stdout.write(c.dim(t('fiscal_mx.sat.cred.revoke.cancelled')) + '\n');
            await shutdown(0);
          }
        }
        await revokeCredential(ctx.entityId, ctx.tenantId, reviewer.email, {
          userId: reviewer.userId,
          reason,
        });
        stdout.write(`✔ ${t('fiscal_mx.sat.cred.revoke.done')}\n`);
        await shutdown(0);
      } catch (err) {
        rl?.close();
        reportError(err);
        await shutdown(exitCodeFor(err));
      }
    });

  registerSatDownloadCommands(sat, deps);
}
