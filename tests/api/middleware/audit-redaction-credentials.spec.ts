import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { redactarSensibles } from '../../../src/api/rest/middleware/audit.js';
import { integrationRegistry } from '../../../src/services/integrations/index.js';

// ============================================================
// EVERY CREDENTIAL AN ADAPTER READS IS REDACTED FROM THE AUDIT TRAIL
//
// `PUT /v1/admin/integrations/:provider` hands its body to the adapter's
// configure(), and the audit middleware writes that same body to
// audit_log.new_values, which migration 033 made append-only. Redaction used
// to match a name only when its lowercase spelling was exactly one on its
// list, so the camelCase names the adapters read (`secretKey`, `privateKey`,
// `clientSecret`, `webhookSecret`) reached the table in clear.
//
// Each registered adapter's body is declared below with what the trail does
// with every field. The two coverage cases make the declaration exhaustive: a
// new adapter, or a new field in an adapter's credentials interface, fails
// here until someone decides whether the trail may keep it.
// ============================================================

const REDACTED = '[REDACTADO]';

interface Decision {
  /** Replaced before the row is written. Not all are secret: see audit.ts. */
  redacted: string[];
  /** Written as sent: they say which account and environment were attached. */
  kept: string[];
}

const CONFIGURE_BODIES: Record<string, Decision> = {
  stripe: { redacted: ['secretKey', 'publishableKey', 'webhookSecret'], kept: [] },
  conekta: { redacted: ['privateKey', 'publicKey', 'webhookSecret'], kept: ['environment'] },
  edicom: { redacted: ['clientSecret'], kept: ['clientId', 'environment'] },
  finkok: { redacted: ['password'], kept: ['username', 'environment'] },
  sovos_reachcore: { redacted: ['apiKey', 'apiKeyEnv'], kept: ['environment'] },
  sw_sapien: { redacted: ['token'], kept: ['environment'] },
};

/** The S3 stub retired in #370: rows written while it was registered still carry its body. */
const RETIRED_S3: Decision = { redacted: ['accessKeyId', 'secretAccessKey'], kept: ['region', 'bucket'] };

function expectDecision(provider: string, d: Decision): void {
  const body = Object.fromEntries([...d.redacted, ...d.kept].map((f) => [f, `synthetic-${f}`]));
  const written = redactarSensibles(body) as Record<string, unknown>;
  for (const f of d.redacted) {
    expect(written[f], `${provider}.${f} reaches audit_log in clear`).toBe(REDACTED);
  }
  for (const f of d.kept) {
    expect(written[f], `${provider}.${f} is redacted, and the trail needs it`).toBe(`synthetic-${f}`);
  }
}

const INTEGRATIONS = path.join(__dirname, '..', '..', '..', 'src', 'services', 'integrations');

/** The fields of the `…Credentials` interface in the file that declares this providerId. */
function credentialFields(providerId: string): string[] | undefined {
  for (const rel of readdirSync(INTEGRATIONS, { recursive: true, encoding: 'utf8' })) {
    if (!rel.endsWith('.ts')) continue;
    const source = readFileSync(path.join(INTEGRATIONS, rel), 'utf8');
    if (!source.includes(`providerId = '${providerId}'`)) continue;
    const members = /interface \w+Credentials \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const code = members.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    return [...code.matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1]!);
  }
  return undefined;
}

describe('the audit trail and the integration credentials', () => {
  it.each(Object.entries(CONFIGURE_BODIES))('%s: every secret its configure() reads is redacted', (provider, d) => {
    expectDecision(provider, d);
  });

  it('the retired S3 keys are redacted, and its region and bucket kept', () => {
    expectDecision('s3', RETIRED_S3);
  });

  it('declares a body for every adapter the registry exposes, and for no other', () => {
    const registered = integrationRegistry.list().map((a) => a.providerId).sort();
    expect(Object.keys(CONFIGURE_BODIES).sort(), 'declare the configure body of the new adapter above').toEqual(registered);
  });

  it.each(Object.keys(CONFIGURE_BODIES))('%s: the declaration covers every field of its credentials interface', (provider) => {
    const d = CONFIGURE_BODIES[provider]!;
    expect(
      [...d.redacted, ...d.kept].sort(),
      `${provider}'s credentials interface changed: decide above whether each field may reach audit_log`
    ).toEqual(credentialFields(provider)?.sort());
  });

  it('matches a secret whatever its spelling', () => {
    const names = [
      'secret_key', 'SECRET_KEY', 'Secret-Key', 'client_secret', 'private_key', 'PrivateKey',
      'aws_secret_access_key', 'aws_access_key_id', 'x-api-key', 'refresh_token', 'contraseña',
      'signingkey', 'keyFile', 'ssn_encrypted', 'employeeNss', 'bank_routing_number',
      'bankAccountNumber', 'vendorClabe',
    ];
    const written = redactarSensibles(Object.fromEntries(names.map((n) => [n, 'synthetic']))) as Record<string, unknown>;
    for (const n of names) expect(written[n], n).toBe(REDACTED);
  });

  it('keeps a name that holds a stem but names no secret', () => {
    // `ssn` sits inside business_name, `cer` inside no_certificado_sat (an
    // invoice field) and `key` inside keywords. bank_account_id is the account
    // a bill or invoice points at, not an account number.
    const body = {
      business_name: 'Synthetic SA de CV',
      no_certificado_sat: '00001000000000000000',
      keywords: ['synthetic'],
      bank_account_id: '00000000-0000-4000-8000-000000000000',
    };
    expect(redactarSensibles(body)).toEqual(body);
  });

  it('redacts at any depth, inside objects and inside arrays', () => {
    const body = {
      provider: 'stripe',
      settings: { credentials: { secretKey: 'fake-a', environment: 'sandbox' } },
      accounts: [
        { privateKey: 'fake-b', label: 'one' },
        { clientSecret: 'fake-c', label: 'two' },
      ],
    };
    expect(redactarSensibles(body)).toEqual({
      provider: 'stripe',
      settings: { credentials: { secretKey: REDACTED, environment: 'sandbox' } },
      accounts: [
        { privateKey: REDACTED, label: 'one' },
        { clientSecret: REDACTED, label: 'two' },
      ],
    });
  });
});
