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

// ============================================================
// `mnemosine sat cred …` COMMANDS
// Capture, status, audit and revocation of the e.firma.
// The password is asked with echo off and is never printed.
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
  if (!fs.existsSync(file)) throw new Error(`The ${label} file does not exist: ${file}`);
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) {
    warn(
      `WARNING: ${file} is readable by other users of the system ` +
        `(mode ${(stat.mode & 0o777).toString(8)}). Consider: chmod 600 ${file}`
    );
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
  const sat = program.command('sat').description('SAT services (credentials and CFDI download)');
  const cred = sat.command('cred').description('Fiscal credentials (e.firma)');

  cred
    .command('add')
    .alias('agregar')
    .description('Registers the e.firma of an entity (validates locally before transmitting)')
    .requiredOption('--cer <file>', 'SAT .cer certificate (DER)')
    .requiredOption('--key <file>', 'SAT .key private key (DER)')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .option('-u, --user <email>', 'Who grants the consent')
    .option('--no-unattended', 'Forbid use without an operator present')
    .option('--max-diario <n>', 'Access limit per 24 h', (v) => parseInt(v, 10))
    .action(async (opts: {
      cer: string; key: string; entity?: string; user?: string;
      unattended: boolean; maxDiario?: number;
    }) => {
      let rl: readline.Interface | undefined;
      try {
        const ctx = await resolveEntity(opts.entity);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const cer = readSensitiveFile(opts.cer, '.cer', (s) => stderr.write(ce.red(`\n${s}\n`)));
        const key = readSensitiveFile(opts.key, '.key', (s) => stderr.write(ce.red(`\n${s}\n`)));

        // 1) Local validation: fail here before the secret leaves the machine.
        const info = parseCertificate(cer);
        console.log(
          `\n${c.bold('Certificate read')}\n` +
            `  type: ${info.type === 'efirma' ? c.bold('e.firma') : info.type}\n` +
            `  RFC: ${info.rfc}\n  serial: ${info.serial}\n` +
            `  validity: ${info.validFrom.toISOString().split('T')[0]} → ${info.validTo.toISOString().split('T')[0]}\n` +
            `  target entity: ${ctx.entityName} (${ctx.taxId})`
        );
        if (info.type === 'csd') {
          console.error(
            ce.red('\nThis is a CSD (digital seal), not an e.firma. The SAT bulk download rejects it.')
          );
          await shutdown(1);
        }
        // The RFC is validated BEFORE asking for the password: nobody should
        // type their e.firma passphrase only to find out afterwards that they
        // picked the wrong entity. (storeCredential revalidates it as a safety net.)
        if (info.rfc.toUpperCase() !== ctx.taxId.toUpperCase()) {
          console.error(
            ce.red(
              `\nThe certificate's RFC (${info.rfc}) does not match the entity ` +
                `"${ctx.entityName}" (${ctx.taxId}).`
            )
          );
          console.error(c.dim('Use --entity to pick the correct entity.'));
          await shutdown(1);
        }
        if (info.validTo <= new Date()) {
          console.error(
            ce.red(`\nThe certificate expired on ${info.validTo.toISOString().split('T')[0]}. Renew it at the SAT.`)
          );
          await shutdown(1);
        }

        const password = await askHidden(c.cyan('\nPrivate key password (not shown): '));
        if (!verifyKeyPair(cer, key, password)) {
          console.error(ce.red('\nThe key does not match the certificate, or the password is incorrect.'));
          await shutdown(1);
        }
        console.log(c.dim('Key pair verified locally.'));

        // 2) Explicit informed consent.
        console.log(`\n${CONSENT_TEXT}\n`);
        rl = readline.createInterface({ input: stdin, output: stdout });
        const ok = await ask(rl, c.cyan('Do you authorize storing this e.firma? type "accept" to continue: '));
        rl.close();
        if ((ok ?? '').trim().toLowerCase() !== 'accept') {
          console.log(c.dim('Cancelled. Nothing was saved.'));
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
        console.log(
          `\n✔ e.firma registered for ${c.bold(ctx.entityName)}\n` +
            c.dim(`  custody: ${vault.backend}\n`) +
            c.dim(`  unattended use: ${row.unattended_access ? 'allowed' : 'forbidden'} · ` +
                  `limit: ${row.max_daily_access}/24h\n`) +
            c.dim('  audit: mnemosine sat cred audit')
        );
        await shutdown(0);
      } catch (err) {
        rl?.close();
        reportError(err);
        await shutdown(1);
      }
    });

  cred
    .command('status')
    .alias('estado')
    .description('Shows the entity credentials and their validity')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .action(async (opts: { entity?: string }) => {
      try {
        const ctx = await resolveEntity(opts.entity);
        const rows = await getCredentialStatus(ctx.entityId, ctx.tenantId);
        if (rows.length === 0) {
          console.log('No credentials registered. Add one with: mnemosine sat cred add');
        } else {
          for (const r of rows) {
            const icon = r.status === 'active' ? '✔' : r.status === 'revoked' ? '✘' : '⚠';
            const expiry =
              r.days_to_expiry < 0 ? c.dim('(expired)')
              : r.days_to_expiry < 60 ? ce.red(`(expires in ${r.days_to_expiry} days — renew at the SAT)`)
              : c.dim(`(expires in ${r.days_to_expiry} days)`);
            console.log(
              `${icon} ${c.bold(r.credential_type)} ${r.rfc} · ${r.status} ${expiry}\n` +
                c.dim(`  serial ${r.cert_serial} · custody ${r.vault_backend}\n`) +
                c.dim(`  unattended: ${r.unattended_access ? 'yes' : 'no'} · limit ${r.max_daily_access}/24h · ` +
                      `last use: ${r.last_used_at ? new Date(r.last_used_at).toISOString() : 'never'}`)
            );
          }
        }
        const health = await getVault().healthCheck();
        console.log(c.dim(`\nVault: ${health.healthy ? 'OK' : 'ERROR'} — ${health.detail ?? ''}`));
        await shutdown(0);
      } catch (err) {
        reportError(err);
        await shutdown(1);
      }
    });

  cred
    .command('audit')
    .alias('auditoria')
    .description('Credential access history (who used it, when and what for)')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .option('-n, --limit <n>', 'How many events to show', (v) => parseInt(v, 10), 30)
    .action(async (opts: { entity?: string; limit: number }) => {
      try {
        const ctx = await resolveEntity(opts.entity);
        const log = (await getAccessLog(ctx.entityId, ctx.tenantId, opts.limit)) as Array<Record<string, unknown>>;
        if (log.length === 0) {
          console.log('No accesses recorded.');
        } else {
          console.log(c.bold(`Accesses to the credential of ${ctx.entityName}`));
          for (const l of log) {
            const icon = l.outcome === 'success' ? '·' : l.outcome === 'denied' ? '⊘' : '✘';
            const extra = l.denied_reason ? `/${l.denied_reason}` : l.error ? `: ${l.error}` : '';
            console.log(
              `${icon} ${new Date(l.accessed_at as string).toISOString()} · ${l.purpose} · ${l.actor}` +
                c.dim(` · ${l.unattended ? 'unattended' : 'with operator'} · ${l.outcome}${extra}`)
            );
          }
        }
        await shutdown(0);
      } catch (err) {
        reportError(err);
        await shutdown(1);
      }
    });

  cred
    .command('revoke')
    .alias('revocar')
    .description('Revokes the credential and deletes the material from the vault (irreversible)')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .option('-u, --user <email>', 'Who revokes')
    .action(async (opts: { entity?: string; user?: string }) => {
      let rl: readline.Interface | undefined;
      try {
        const ctx = await resolveEntity(opts.entity);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        console.log(
          ce.red(`\nYou are about to delete the e.firma of ${ctx.entityName} from custody.`) +
            c.dim('\nThe deletion is cryptographic and irreversible; it will have to be loaded again.\n')
        );
        rl = readline.createInterface({ input: stdin, output: stdout });
        const ok = await ask(rl, c.cyan('Type the RFC of the entity to confirm: '));
        rl.close();
        if ((ok ?? '').trim().toUpperCase() !== ctx.taxId.toUpperCase()) {
          console.log(c.dim('Cancelled.'));
          await shutdown(0);
        }
        await revokeCredential(ctx.entityId, ctx.tenantId, reviewer.email);
        console.log('✔ Credential revoked and material deleted from the vault.');
        await shutdown(0);
      } catch (err) {
        rl?.close();
        reportError(err);
        await shutdown(1);
      }
    });
}
