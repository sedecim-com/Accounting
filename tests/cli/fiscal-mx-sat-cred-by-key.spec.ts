import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerSatCommands } from '../../src/cli/sat-commands.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';

// ============================================================
// I8.7 · sat cred speaks by key (MNE-001-600, #269)
//
// `sat cred add`, `status`, `audit` and `revoke` printed their English prose
// with console.* and no key. They write it through stdout and stderr now, from
// the I8.7 block, so es-MX reads Spanish and en-US reads the same bytes as
// before (save «1 day», an ICU plural). Every value here is invented: the
// certificate reader, the credential service and the vault are doubles, the
// RFCs are not anyone's, and the passphrase is a made-up string that must
// never reach the screen.
// ============================================================

const s = vi.hoisted(() => ({
  ctx: { tenantId: 'T1', entityId: 'E1', entityName: 'Demo Corp', taxId: 'TST010101AB1' },
  cert: {} as Record<string, unknown>,
  pairOk: true,
  status: [] as unknown[],
  log: [] as unknown[],
  healthy: { healthy: true, detail: 'invented vault' } as { healthy: boolean; detail?: string },
  answers: [] as string[],
  prompts: [] as string[],
}));
vi.mock('../../src/ai/context.js', async (original) => ({
  ...(await original<typeof import('../../src/ai/context.js')>()),
  resolveEntity: () => Promise.resolve(s.ctx),
}));
vi.mock('../../src/ai/draft-service.js', async (original) => ({
  ...(await original<typeof import('../../src/ai/draft-service.js')>()),
  resolveReviewer: () => Promise.resolve({ userId: 'U1', email: 'a@b.c' }),
}));
vi.mock('../../src/services/policy/today.js', async (original) => ({
  ...(await original<typeof import('../../src/services/policy/today.js')>()),
  zoneFor: () => Promise.resolve('America/Mexico_City'),
}));
vi.mock('../../src/services/fiscal-credentials/certificate.js', () => ({
  parseCertificate: () => s.cert,
  verifyKeyPair: () => s.pairOk,
}));
vi.mock('../../src/services/fiscal-credentials/service.js', () => ({
  CONSENT_TEXT: 'INVENTED CONSENT TEXT',
  storeCredential: (a: { unattendedAccess: boolean }) =>
    Promise.resolve({ unattended_access: a.unattendedAccess, max_daily_access: 12 }),
  getCredentialStatus: () => Promise.resolve(s.status),
  getAccessLog: () => Promise.resolve(s.log),
  revokeCredential: () => Promise.resolve(undefined),
}));
vi.mock('../../src/services/vault/index.js', () => ({
  getVault: () => ({ backend: 'invented-backend', healthCheck: () => Promise.resolve(s.healthy) }),
}));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: (prompt: string) => {
      s.prompts.push(prompt);
      return Promise.resolve(PASSPHRASE);
    },
    close: () => undefined,
  }),
}));

const PASSPHRASE = vi.hoisted(() => 'invented-passphrase-0000');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mne-600-'));
const cer = path.join(dir, 'a.cer');
const openKey = path.join(dir, 'open.key');
const key = path.join(dir, 'a.key');
for (const [file, mode] of [[cer, 0o600], [openKey, 0o644], [key, 0o600]] as const) {
  fs.writeFileSync(file, 'invented');
  fs.chmodSync(file, mode);
}
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const GOOD = {
  type: 'efirma', rfc: 'TST010101AB1', serial: '00001000000500000001',
  validFrom: new Date('2025-01-15T18:00:00Z'), validTo: new Date('2029-01-15T18:00:00Z'),
};
const credential = (over: Record<string, unknown>) => ({
  status: 'active', credential_type: 'efirma', rfc: 'TST010101AB1', days_to_expiry: 400, cert_serial: 'S1',
  vault_backend: 'vb', unattended_access: true, max_daily_access: 10, last_used_at: null, ...over,
});

let out = '';
let err = '';
beforeEach(() => {
  out = '';
  err = '';
  s.cert = GOOD;
  s.pairOk = true;
  s.answers = [];
  s.prompts = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetLanguage();
});

class Stop extends Error {}
const pass = (x: string) => x;

function program(): { cli: Command; state: { exitCode?: number; errs: Array<Error & { localized: (l?: 'es') => string }> } } {
  const state: { exitCode?: number; errs: Array<Error & { localized: (l?: 'es') => string }> } = { errs: [] };
  const cli = new Command('mnemosine').exitOverride();
  registerSatCommands(cli, {
    color: { dim: pass, bold: pass, cyan: pass },
    colorErr: { dim: pass, red: pass },
    shutdown: async (code: number) => {
      state.exitCode ??= code;
      throw new Stop();
    },
    reportError: (e: unknown) => {
      if (!(e instanceof Stop)) state.errs.push(e as Error & { localized: (l?: 'es') => string });
    },
    ask: async (_rl, prompt) => {
      s.prompts.push(prompt);
      return s.answers.shift() ?? '';
    },
  });
  return { cli, state };
}
async function run(...argv: string[]) {
  const { cli, state } = program();
  await cli.parseAsync(['node', 'mnemosine', 'sat', 'cred', ...argv]).catch((e: unknown) => {
    if (!(e instanceof Stop)) throw e;
  });
  return state;
}

const SUMMARY_EN =
  '\nCertificate read\n  type: e.firma\n  RFC: TST010101AB1\n  serial: 00001000000500000001\n' +
  '  validity: 2025-01-15 → 2029-01-15\n  target entity: Demo Corp (TST010101AB1)\n';
const SUMMARY_ES =
  '\nCertificado leído\n  tipo: e.firma\n  RFC: TST010101AB1\n  serie: 00001000000500000001\n' +
  '  vigencia: 2025-01-15 → 2029-01-15\n  entidad destino: Demo Corp (TST010101AB1)\n';

describe('I8.7 · sat cred add speaks by key (MNE-001-600)', () => {
  it('a missing file is a keyed not-found, in both languages', async () => {
    const missing = path.join(dir, 'nope.cer');
    const r = await run('add', '--cer', missing, '--key', key);
    expect(r.exitCode).toBe(3);
    expect(r.errs[0].message).toBe(`The .cer file does not exist: ${missing}`);
    expect(r.errs[0].localized('es')).toBe(`El archivo .cer no existe: ${missing}`);
  });

  it('a key readable by others is warned on stderr, and a CSD is refused', async () => {
    s.cert = { ...GOOD, type: 'csd' };
    const r = await run('add', '--cer', cer, '--key', openKey);
    expect(r.exitCode).toBe(4);
    expect(err).toBe(
      `\nWARNING: ${openKey} is readable by other users of the system (mode 644). Consider: chmod 600 ${openKey}\n` +
        '\nThis is a CSD (digital seal), not an e.firma. The SAT bulk download rejects it.\n'
    );
    expect(out).toBe(SUMMARY_EN.replace('type: e.firma', 'type: csd'));
    setLanguage('es');
    err = '';
    await run('add', '--cer', cer, '--key', openKey);
    expect(err).toBe(
      `\nAVISO: otros usuarios del sistema pueden leer ${openKey} (modo 644). Considera: chmod 600 ${openKey}\n` +
        '\nEs un CSD (sello digital), no una e.firma. La descarga masiva del SAT lo rechaza.\n'
    );
  });

  it('an RFC of another entity is refused before the passphrase is asked', async () => {
    s.cert = { ...GOOD, rfc: 'OTR020202CD2' };
    const r = await run('add', '--cer', cer, '--key', key);
    expect(r.exitCode).toBe(4);
    expect(err).toBe(
      '\nThe certificate\'s RFC (OTR020202CD2) does not match the entity "Demo Corp" (TST010101AB1).\n' +
        'Use --entity to pick the correct entity.\n'
    );
    expect(s.prompts).toEqual([]);
    setLanguage('es');
    err = '';
    await run('add', '--cer', cer, '--key', key);
    expect(err).toBe(
      '\nEl RFC del certificado (OTR020202CD2) no coincide con la entidad "Demo Corp" (TST010101AB1).\n' +
        'Usa --entity para elegir la entidad correcta.\n'
    );
  });

  it('an expired certificate is blocked', async () => {
    s.cert = { ...GOOD, validTo: new Date('2024-03-01T18:00:00Z') };
    const r = await run('add', '--cer', cer, '--key', key);
    expect(r.exitCode).toBe(5);
    expect(err).toBe('\nThe certificate expired on 2024-03-01. Renew it at the SAT.\n');
    setLanguage('es');
    err = '';
    await run('add', '--cer', cer, '--key', key);
    expect(err).toBe('\nEl certificado venció el 2024-03-01. Renuévalo en el SAT.\n');
  });

  it('--dry-run and --idempotency-key: what the real run would do, and why the key is not needed', async () => {
    await run('add', '--cer', cer, '--key', key, '--dry-run', '--idempotency-key', 'k1');
    expect(err).toBe(
      '  --idempotency-key does not apply here: custody is guarded by the typed consent and the credential status.\n'
    );
    expect(out).toBe(
      SUMMARY_EN +
        '\n(dry-run: certificate valid for this entity. The real run asks the key password, verifies the pair ' +
        'and stores the material in the vault. Nothing was stored.)\n'
    );
    setLanguage('es');
    out = '';
    err = '';
    await run('add', '--cer', cer, '--key', key, '--dry-run', '--idempotency-key', 'k1');
    expect(err).toBe(
      '  --idempotency-key no aplica aquí: la custodia la guardan el consentimiento tecleado y el estado de la credencial.\n'
    );
    expect(out).toBe(
      SUMMARY_ES +
        '\n(dry-run: certificado válido para esta entidad. La corrida real pide la contraseña de la llave, ' +
        'verifica el par y guarda el material en la bóveda. No se guardó nada.)\n'
    );
  });

  it('without --live, the deposit is opt-in', async () => {
    await run('add', '--cer', cer, '--key', key);
    expect(out).toBe(
      SUMMARY_EN +
        '\nValidation passed. Storing the e.firma in the vault is the real external effect and is opt-in: ' +
        're-run with --live to be asked the password and complete the deposit.\n'
    );
    setLanguage('es');
    out = '';
    await run('add', '--cer', cer, '--key', key);
    expect(out).toBe(
      SUMMARY_ES +
        '\nValidación aprobada. Guardar la e.firma en la bóveda es el efecto externo real y hay que pedirlo: ' +
        'vuelve a correr con --live para que se te pida la contraseña y se complete el depósito.\n'
    );
  });

  it('a pair that does not match is refused, and the passphrase is never printed', async () => {
    s.pairOk = false;
    const r = await run('add', '--cer', cer, '--key', key, '--live');
    expect(r.exitCode).toBe(4);
    expect(s.prompts).toEqual(['\nPrivate key password (not shown): ']);
    expect(err).toBe('\nThe key does not match the certificate, or the password is incorrect.\n');
    setLanguage('es');
    err = '';
    await run('add', '--cer', cer, '--key', key, '--live');
    expect(s.prompts[1]).toBe('\nContraseña de la llave privada (no se muestra): ');
    expect(err).toBe('\nLa llave no corresponde al certificado, o la contraseña es incorrecta.\n');
    expect(out + err).not.toContain(PASSPHRASE);
  });

  it('the typed consent: declined saves nothing', async () => {
    s.answers = ['no'];
    await run('add', '--cer', cer, '--key', key, '--live');
    expect(s.prompts[1]).toBe('Do you authorize storing this e.firma? type "accept" to continue (--yes does not skip this): ');
    expect(out).toBe(SUMMARY_EN + '\nKey pair verified locally.\n\nINVENTED CONSENT TEXT\n\nCancelled. Nothing was saved.\n');
    setLanguage('es');
    out = '';
    s.prompts = [];
    s.answers = ['no'];
    await run('add', '--cer', cer, '--key', key, '--live');
    expect(s.prompts[1]).toBe('¿Autorizas guardar esta e.firma? escribe "accept" para continuar (--yes no se salta esto): ');
    expect(out).toBe(SUMMARY_ES + '\nPar de llaves verificado localmente.\n\nINVENTED CONSENT TEXT\n\nCancelado. No se guardó nada.\n');
  });

  it('accepted: the receipt says where it is kept and how it may be used', async () => {
    s.answers = ['accept'];
    const r = await run('add', '--cer', cer, '--key', key, '--live');
    expect(r.exitCode).toBe(0);
    expect(out).toBe(
      SUMMARY_EN + '\nKey pair verified locally.\n\nINVENTED CONSENT TEXT\n\n' +
        '\n✔ e.firma registered for Demo Corp\n  custody: invented-backend\n' +
        '  unattended use: allowed · limit: 12/24h\n  audit: mnemosine sat cred audit\n'
    );
    setLanguage('es');
    out = '';
    s.answers = ['accept'];
    await run('add', '--cer', cer, '--key', key, '--live', '--no-unattended');
    expect(out).toContain(
      '\n✔ e.firma registrada para Demo Corp\n  custodia: invented-backend\n' +
        '  uso desatendido: prohibido · límite: 12/24h\n  auditoría: mnemosine sat cred audit\n'
    );
    expect(out + err).not.toContain(PASSPHRASE);
  });

  it('the family\'s idempotency reasons are keys, English for the audit and Spanish under es', () => {
    const { cli } = program();
    const sat = cli.commands.find((c) => c.name() === 'sat')!;
    const leaf = (...names: string[]) => names.reduce((cmd: Command, n) => cmd.commands.find((c) => c.name() === n)!, sat);
    expect(riskOf(leaf('download', 'check'))!.llave).toEqual({
      innecesaria: 'asking the state again is harmless and records the latest state',
    });
    expect(riskOf(leaf('package', 'download'))!.llave).toEqual({
      innecesaria: 'a package already archived is never downloaded again, and each CFDI deduplicates by UUID',
    });
    expect(t('fiscal_mx.sat.download.check.key_unneeded', {}, 'es')).toBe(
      'preguntar otra vez el estado no hace daño y registra el estado más reciente'
    );
    expect(t('fiscal_mx.sat.download.package.key_unneeded', {}, 'es')).toBe(
      'un paquete ya archivado no se vuelve a descargar, y cada CFDI se deduplica por su UUID'
    );
    expect(t('fiscal_mx.cfdi.sync.retry_reconsults')).toBe('a retry consults the SAT again and rewrites the cache');
    expect(t('fiscal_mx.cfdi.sync.retry_reconsults', {}, 'es')).toBe('un reintento vuelve a consultar al SAT y reescribe el caché');
    expect(t('fiscal_mx.cfdi.post.key_unneeded', {}, 'es')).toBe(
      'un CFDI da una sola factura: una repetición encuentra su prerregistro cerrado, o una factura con su UUID, y se rechaza'
    );
  });

  it('states why it needs no idempotency key, in English at registration', () => {
    const { cli } = program();
    const leaf = cli.commands.find((c) => c.name() === 'sat')!.commands.find((c) => c.name() === 'cred')!;
    expect(riskOf(leaf.commands.find((c) => c.name() === 'add')!)!.llave).toEqual({
      innecesaria: 'custody is guarded by the typed consent and the credential status',
    });
    expect(riskOf(leaf.commands.find((c) => c.name() === 'revoke')!)!.llave).toEqual({
      innecesaria: 'a second revoke is refused because no active credential remains',
    });
  });
});

describe('I8.7 · sat cred status and audit speak by key (MNE-001-600)', () => {
  it('status with no credential', async () => {
    await run('status');
    expect(out).toBe('No credentials registered. Add one with: mnemosine sat cred add\n\nVault: OK — invented vault\n');
    setLanguage('es');
    out = '';
    await run('status');
    expect(out).toBe('No hay credenciales registradas. Agrega una con: mnemosine sat cred add\n\nBóveda: OK — invented vault\n');
  });

  it('status rows: expiry with an ICU plural, usage and the vault health', async () => {
    s.status = [
      credential({ last_used_at: '2026-10-01T12:00:00Z' }),
      credential({ days_to_expiry: 1, cert_serial: 'S2', unattended_access: false, max_daily_access: 5 }),
      credential({ status: 'revoked', days_to_expiry: -3, cert_serial: 'S3' }),
    ];
    s.healthy = { healthy: false };
    await run('status');
    expect(out).toBe(
      '✔ efirma TST010101AB1 · active (expires in 400 days)\n  serial S1 · custody vb\n' +
        '  unattended: yes · limit 10/24h · last use: 2026-10-01T12:00:00.000Z\n' +
        '✔ efirma TST010101AB1 · active (expires in 1 day — renew at the SAT)\n  serial S2 · custody vb\n' +
        '  unattended: no · limit 5/24h · last use: never\n' +
        '✘ efirma TST010101AB1 · revoked (expired)\n  serial S3 · custody vb\n' +
        '  unattended: yes · limit 10/24h · last use: never\n' +
        '\nVault: ERROR — \n'
    );
    setLanguage('es');
    out = '';
    s.status = [credential({ days_to_expiry: 1 }), credential({ days_to_expiry: 30, unattended_access: false }), credential({ status: 'revoked', days_to_expiry: -3 })];
    await run('status');
    expect(out).toContain('· active (vence en 1 día — renuévala en el SAT)\n  serie S1 · custodia vb\n  desatendido: sí · límite 10/24h · último uso: nunca\n');
    expect(out).toContain('· active (vence en 30 días — renuévala en el SAT)\n');
    expect(out).toContain('  desatendido: no · límite 10/24h');
    expect(out).toContain('· revoked (vencida)\n');
    expect(out).toContain('\nBóveda: ERROR — \n');
    out = '';
    s.status = [credential({ days_to_expiry: 400 })];
    await run('status');
    expect(out).toContain('· active (vence en 400 días)\n');
  });

  it('audit: none, and the log with how each access was made', async () => {
    await run('audit');
    expect(out).toBe('No accesses recorded.\n');
    s.log = [
      { outcome: 'success', accessed_at: '2026-10-02T10:00:00Z', purpose: 'sat_download', actor: 'cli', unattended: false, denied_reason: null, error: null },
      { outcome: 'denied', accessed_at: '2026-10-03T10:00:00Z', purpose: 'sat_download', actor: 'job', unattended: true, denied_reason: 'daily_limit', error: null },
    ];
    out = '';
    await run('audit');
    expect(out).toBe(
      'Accesses to the credential of Demo Corp\n' +
        '· 2026-10-02T10:00:00.000Z · sat_download · cli · with operator · success\n' +
        '⊘ 2026-10-03T10:00:00.000Z · sat_download · job · unattended · denied/daily_limit\n'
    );
    setLanguage('es');
    out = '';
    await run('audit');
    expect(out).toBe(
      'Accesos a la credencial de Demo Corp\n' +
        '· 2026-10-02T10:00:00.000Z · sat_download · cli · con operador · success\n' +
        '⊘ 2026-10-03T10:00:00.000Z · sat_download · job · desatendido · denied/daily_limit\n'
    );
    s.log = [];
    out = '';
    await run('audit');
    expect(out).toBe('No hay accesos registrados.\n');
  });
});

describe('I8.7 · sat cred revoke speaks by key (MNE-001-600)', () => {
  it('--dry-run with nothing active, and with an active credential', async () => {
    s.status = [];
    await run('revoke', '--reason', 'renewed', '--dry-run');
    expect(out).toBe('There is no active credential to revoke; the real run would refuse too.\n');
    s.status = [credential({})];
    out = '';
    await run('revoke', '--reason', 'renewed', '--dry-run', '--idempotency-key', 'k2');
    expect(err).toBe('  --idempotency-key does not apply here: a second revoke is refused because no active credential remains.\n');
    expect(out).toBe(
      'Would revoke the efirma of Demo Corp (serial S1) and cryptographically destroy its vault material (custody: vb)\n' +
        '(dry-run: nothing was revoked or destroyed)\n'
    );
    setLanguage('es');
    out = '';
    err = '';
    await run('revoke', '--reason', 'renewed', '--dry-run', '--idempotency-key', 'k2');
    expect(err).toBe('  --idempotency-key no aplica aquí: una segunda revocación se rechaza porque ya no queda credencial activa.\n');
    expect(out).toBe(
      'Revocaría la efirma de Demo Corp (serie S1) y destruiría criptográficamente su material en la bóveda (custodia: vb)\n' +
        '(dry-run: no se revocó ni se destruyó nada)\n'
    );
    s.status = [];
    out = '';
    await run('revoke', '--reason', 'renewed', '--dry-run');
    expect(out).toBe('No hay credencial activa que revocar; la corrida real también se negaría.\n');
  });

  it('the typed RFC: a wrong one cancels, the right one revokes', async () => {
    const WARNING_EN =
      '\nYou are about to delete the e.firma of Demo Corp from custody.' +
      '\nThe deletion is cryptographic and irreversible; it will have to be loaded again.\n\n';
    s.answers = ['OTR020202CD2'];
    await run('revoke', '--reason', 'renewed');
    expect(s.prompts).toEqual(['Type the RFC of the entity to confirm: ']);
    expect(out).toBe(WARNING_EN + 'Cancelled.\n');
    out = '';
    s.answers = [' tst010101ab1 '];
    await run('revoke', '--reason', 'renewed');
    expect(out).toBe(WARNING_EN + '✔ Credential revoked and material deleted from the vault.\n');
    setLanguage('es');
    const WARNING_ES =
      '\nEstás por borrar de la custodia la e.firma de Demo Corp.' +
      '\nEl borrado es criptográfico e irreversible; habrá que volver a cargarla.\n\n';
    out = '';
    s.prompts = [];
    s.answers = ['OTR020202CD2'];
    await run('revoke', '--reason', 'renewed');
    expect(s.prompts).toEqual(['Escribe el RFC de la entidad para confirmar: ']);
    expect(out).toBe(WARNING_ES + 'Cancelado.\n');
    out = '';
    await run('revoke', '--reason', 'renewed', '--yes');
    expect(out).toBe(WARNING_ES + '✔ Credencial revocada y material borrado de la bóveda.\n');
  });
});
