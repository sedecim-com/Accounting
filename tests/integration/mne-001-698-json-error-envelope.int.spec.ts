import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { storeCredential } from '../../src/services/fiscal-credentials/service.js';
import { setVaultForTesting } from '../../src/services/vault/index.js';
import { clearSatTokenCache } from '../../src/services/sat-download/authentication.js';
import { requestDownload } from '../../src/services/sat-download/descarga-masiva.js';
import { startSatSimulator, type SatSimulator } from '../sat-download/sat-simulator.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-698 (#952, stage 1; PRD-003 RF-36) · WITH --json, AN ERROR IS
// ONE MACHINE ENVELOPE ON STDERR — the classes that need a database
//
// Real leaves, run as the binary a gateway will run (a child process),
// against the migrated database: not found, validation, blocked, conflict,
// permission and external. Usage and the internal failure, which need no
// rows, are in tests/cli/json-error-envelope.spec.ts.
//
// For each: the exit code is the one develop gives today, stdout is empty,
// and the LAST line of stderr is the envelope (the RLS warning and the
// `--user` notice still come before it). The messages are written by hand.
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(ROOT, 'src', 'cli', 'mnemosine.ts');
const CERT_DIR = path.join(ROOT, 'tests', 'fixtures', 'certs');
const RFC = 'AAA010101AAA';

interface Envelope {
  schema: string;
  exit_code: number;
  key: string | null;
  params: Record<string, string | number>;
  message: string;
  remedy: string | null;
}

let f: Fixture;
let email: string;
let sim: SatSimulator;
let vaultDir: string;
let home: string;
const savedVault = { backend: process.env.VAULT_BACKEND, dir: process.env.VAULT_DIR };

beforeAll(async () => {
  f = await crearInquilino('MNE-001-698 · machine error envelope');
  email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId])).rows[0].email;
  // March is hard-closed: an entry dated in it is refused by state (5).
  await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [f.periodos[3]]);

  // The external case: a stored e.firma the child process can read (the
  // development vault, in a folder of its own) and the SAT simulator.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mne-698-home-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mne-698-vault-'));
  process.env.VAULT_BACKEND = 'local-dev';
  process.env.VAULT_DIR = vaultDir;
  setVaultForTesting(null);
  await seedPolicies({ tenantId: f.tenantId });
  await resolvePolicy({ tenantId: f.tenantId }, 'efirma_max_accesos_diarios', '96', f.userId);
  await query(`UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3`, [RFC, f.entityId, f.tenantId]);
  await storeCredential({
    tenantId: f.tenantId,
    entityId: f.entityId,
    material: {
      cer: fs.readFileSync(path.join(CERT_DIR, 'fiel.cer')),
      key: fs.readFileSync(path.join(CERT_DIR, 'fiel.key')),
      password: 'test1234',
    },
    consentBy: 'owner@mne-698.test',
    maxDailyAccess: 1000,
  });
  sim = await startSatSimulator();
});

afterAll(async () => {
  await sim?.close();
  setVaultForTesting(null);
  if (savedVault.backend === undefined) delete process.env.VAULT_BACKEND;
  else process.env.VAULT_BACKEND = savedVault.backend;
  if (savedVault.dir === undefined) delete process.env.VAULT_DIR;
  else process.env.VAULT_DIR = savedVault.dir;
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  await drainAttestations(2000);
  await closeDatabase();
});

/**
 * The binary as a child process. Asynchronous and not `spawnSync`: the SAT
 * simulator lives in THIS process, and a blocked event loop would leave the
 * child's request unanswered until it timed out.
 */
function run(args: string[], locale = 'en-US'): Promise<{ status: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    NO_COLOR: '1',
    MNEMOSINE_NO_BANNER: '1',
    MNEMOSINE_LOCALE: locale,
    SAT_DESCARGA_AUTH_URL: sim.url,
    SAT_DESCARGA_SOLICITA_URL: `${sim.base}/Solicita`,
    SAT_DESCARGA_VERIFICA_URL: `${sim.base}/Verifica`,
    SAT_DESCARGA_DESCARGA_URL: `${sim.base}/Descarga`,
  };
  delete env.MNEMOSINE_TENANT;
  delete env.MNEMOSINE_ENTITY;
  delete env.MNEMOSINE_LANG;
  const child = spawn(TSX, [CLI, ...args, '--tenant', f.tenantId, '-e', f.entityId, '-u', email], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

function envelopeOf(stderr: string): Envelope {
  const lines = stderr.trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]) as Envelope;
}

const SEAL_PARAMS = {
  policy: 'efirma_sellado_contabilidad_electronica',
  value: 'nunca_sellar_en_el_sistema',
  optIn: 'sellar_con_custodia',
};

const BALANCED = ['--line', 'account=6120;debit=100.00', '--line', 'account=2110;credit=100.00'];

interface Case {
  name: string;
  args: string[];
  expected: Envelope;
}

const CASES: Case[] = [
  {
    name: 'not found: an account code that does not exist',
    args: ['account', 'show', '9999.99', '--json'],
    expected: {
      schema: 'mnemosine.error/1',
      exit_code: 3,
      key: null,
      params: {},
      message: 'Account with id 9999.99 not found',
      remedy: null,
    },
  },
  {
    name: 'validation: a date that is not a date',
    args: ['entry', 'create', '--date', 'nope', '--description', 'MNE-698', ...BALANCED, '--json', '-y'],
    expected: {
      schema: 'mnemosine.error/1',
      exit_code: 4,
      key: null,
      params: {},
      message: '"nope" is not a date as YYYY-MM-DD.',
      remedy: null,
    },
  },
  {
    name: 'blocked: an entry dated in a hard-closed month',
    args: ['entry', 'create', '--date', '2026-03-15', '--description', 'MNE-698', ...BALANCED, '--json', '-y'],
    expected: {
      schema: 'mnemosine.error/1',
      exit_code: 5,
      key: null,
      params: {},
      message: 'No open fiscal period found for the entry date',
      remedy: null,
    },
  },
  {
    name: 'conflict: an account code that already exists',
    args: ['account', 'create', '1110', 'Duplicada', '--type', 'asset', '--json', '-y'],
    expected: {
      schema: 'mnemosine.error/1',
      exit_code: 6,
      key: null,
      params: {},
      message: 'Account with code "1110" already exists',
      remedy: null,
    },
  },
  {
    name: 'permission: sealing under the default policy, written by key',
    args: ['e-accounting', 'catalog', 'seal', '--period', '2026-07', '--json'],
    expected: {
      schema: 'mnemosine.error/1',
      exit_code: 7,
      key: 'anexo24.seal.refused_by_policy',
      params: SEAL_PARAMS,
      message:
        'Sealing is refused: the policy efirma_sellado_contabilidad_electronica is "nunca_sellar_en_el_sistema", ' +
        'and the system seals with the e.firma only under "sellar_con_custodia". Nothing was decrypted and ' +
        'the access log has no row for this.',
      remedy: null,
    },
  },
];

describe('MNE-001-698 · with --json, each class of error is one envelope on stderr', () => {
  it.each(CASES)('$name', async ({ args, expected }) => {
    const r = await run(args);
    expect(r.status, r.stderr).toBe(expected.exit_code);
    expect(r.stdout).toBe('');
    expect(envelopeOf(r.stderr)).toEqual(expected);
  }, 180_000);

  it('external: the SAT answers a refusal, and the envelope carries the exit the leaf gives (8, not 1)', async () => {
    clearSatTokenCache();
    const ctx = { tenantId: f.tenantId, entityId: f.entityId, actor: 'owner@mne-698.test', unattended: false };
    const deps = {
      url: sim.url,
      requestUrl: `${sim.base}/Solicita`,
      verifyUrl: `${sim.base}/Verifica`,
      downloadUrl: `${sim.base}/Descarga`,
    };
    const req = await requestDownload(
      ctx,
      { direction: 'received', requestType: 'Metadata', start: '2026-02-01T00:00:00', end: '2026-02-01T23:59:59' },
      deps
    );
    // 404 is «error no controlado»: retryable, so the leaf exits EXTERNAL_FAILED.
    sim.script.verify = { code: '404', state: '1', requestCode: '5000', count: 0, packages: [] };

    const r = await run(['sat', 'download', 'check', req.id, '--live', '-y', '--json']);
    expect(r.status, r.stderr).toBe(8);
    expect(r.stdout).toBe('');
    expect(envelopeOf(r.stderr)).toEqual({
      schema: 'mnemosine.error/1',
      exit_code: 8,
      key: null,
      params: {},
      message: `The SAT refused to verify request ${req.id} (404)`,
      remedy: null,
    });
  }, 180_000);

  it('a keyed error in es-MX keeps its key and params, and its message is Spanish', async () => {
    const r = await run(['e-accounting', 'catalog', 'seal', '--period', '2026-07', '--json'], 'es-MX');
    expect(r.status, r.stderr).toBe(7);
    expect(envelopeOf(r.stderr)).toEqual({
      schema: 'mnemosine.error/1',
      exit_code: 7,
      key: 'anexo24.seal.refused_by_policy',
      params: SEAL_PARAMS,
      message:
        'No se sella: la política efirma_sellado_contabilidad_electronica está en "nunca_sellar_en_el_sistema" ' +
        'y el sistema sólo sella con la e.firma bajo "sellar_con_custodia". No se descifró nada y la bitácora ' +
        'de accesos no tiene fila por esto.',
      remedy: null,
    });
  }, 180_000);
});

describe('MNE-001-698 · the formats', () => {
  it('--format json and --format ndjson take the envelope; --format csv keeps the prose', async () => {
    for (const format of ['json', 'ndjson']) {
      const r = await run(['account', 'show', '9999.99', '--format', format]);
      expect(r.status, r.stderr).toBe(3);
      expect(r.stdout).toBe('');
      expect(envelopeOf(r.stderr)).toMatchObject({ exit_code: 3, message: 'Account with id 9999.99 not found' });
    }
    const csv = await run(['account', 'show', '9999.99', '--format', 'csv']);
    expect(csv.status).toBe(3);
    expect(csv.stdout).toBe('');
    expect(csv.stderr.endsWith('\nAccount with id 9999.99 not found\n')).toBe(true);
  }, 360_000);

  it('without --json the prose is the one of today, byte for byte', async () => {
    const r = await run(['account', 'show', '9999.99']);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('\nAccount with id 9999.99 not found\n');
  }, 180_000);
});
