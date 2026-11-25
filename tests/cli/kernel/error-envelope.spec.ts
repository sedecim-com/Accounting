import { describe, it, expect, afterEach } from 'vitest';
import {
  errorEnvelope,
  writeErrorEnvelope,
  setErrorOutput,
  machineErrorOutput,
  resetErrorOutput,
} from '../../../src/cli/kernel/error-envelope.js';
import { ERROR_SCHEMA_NAME, ERROR_SCHEMA_VERSION, SCHEMA_VERSION } from '../../../src/cli/kernel/output.js';
import { CliError } from '../../../src/cli/kernel/cli-error.js';
import { ExitCode } from '../../../src/cli/kernel/exit.js';
import { AppError, NotFoundError } from '../../../src/utils/errors.js';
import { resetLanguage, setLanguage } from '../../../src/i18n/index.js';

// MNE-001-698 · the kernel's single renderer of the machine error, on each
// kind of failure. The binary end to end is in tests/cli/json-error-envelope
// and tests/integration/mne-001-698-json-error-envelope.

afterEach(() => {
  resetLanguage();
  resetErrorOutput();
});

describe('MNE-001-698 · the schema sits next to SCHEMA_VERSION', () => {
  it('is mnemosine.error/1, a name and a version of its own', () => {
    expect(ERROR_SCHEMA_NAME).toBe('mnemosine.error');
    expect(ERROR_SCHEMA_VERSION).toBe(1);
    expect(SCHEMA_VERSION).toBe(1);
    expect(errorEnvelope(new Error('x'), 1).schema).toBe('mnemosine.error/1');
  });
});

describe('MNE-001-698 · what each kind of error carries', () => {
  it('a keyed CliError: its key and English params; the message localized; the «→» line as remedy', () => {
    const err = new CliError(
      {
        key: 'cli.entity.database_unreachable',
        params: { entity: 'Molinos del Bajio', detail: 'timeout' },
        lines: [{ key: 'cli.entity.database_unreachable_remedy', prefix: '  → ' }, { key: 'cli.entity.pin_was_kept' }],
      },
      ExitCode.FAILURE
    );
    setLanguage('es');
    expect(errorEnvelope(err, 1)).toEqual({
      schema: 'mnemosine.error/1',
      exit_code: 1,
      key: 'cli.entity.database_unreachable',
      params: { entity: 'Molinos del Bajio', detail: 'timeout' },
      message:
        'No se pudo llegar a la base al resolver la entidad activa (Molinos del Bajio): timeout\n' +
        'La entidad fijada se conservó.',
      remedy: 'mnemosine doctor   (y revisa DATABASE_URL en .env)',
    });
    setLanguage('en');
    const en = errorEnvelope(err, 1);
    expect(en.key).toBe('cli.entity.database_unreachable');
    expect(en.params).toEqual({ entity: 'Molinos del Bajio', detail: 'timeout' });
    expect(en.remedy).toBe('mnemosine doctor   (and check DATABASE_URL in .env)');
  });

  it('a prose CliError: no key, its text, and the remedy it embeds with «→»', () => {
    const err = new CliError('The tenant must be a UUID.\n  → mnemosine entity list --tenant <uuid>', ExitCode.USAGE);
    expect(errorEnvelope(err, 2)).toEqual({
      schema: 'mnemosine.error/1',
      exit_code: 2,
      key: null,
      params: {},
      message: 'The tenant must be a UUID.',
      remedy: 'mnemosine entity list --tenant <uuid>',
    });
  });

  it('a keyed AppError: its messageKey and params, localized message', () => {
    const err = new AppError(404, 'ROUTE_NOT_FOUND', { key: 'error.ROUTE_NOT_FOUND', params: { method: 'GET', path: '/v1/x' } });
    setLanguage('es');
    expect(errorEnvelope(err, 3)).toEqual({
      schema: 'mnemosine.error/1',
      exit_code: 3,
      key: 'error.ROUTE_NOT_FOUND',
      params: { method: 'GET', path: '/v1/x' },
      message: 'No hay ninguna ruta para GET /v1/x.',
      remedy: null,
    });
  });

  it('a prose AppError: no key, its message, and the remedy reportError adds', () => {
    expect(errorEnvelope(new NotFoundError('Account', '9999'), 3, { remedy: 'mnemosine account list' })).toEqual({
      schema: 'mnemosine.error/1',
      exit_code: 3,
      key: null,
      params: {},
      message: 'Account with id 9999 not found',
      remedy: 'mnemosine account list',
    });
  });

  it('a pg error is internal: a fixed key and sentence, never its SQL nor its constraint', () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "accounts_entity_code_key"'), {
      severity: 'ERROR',
      code: '23505',
      detail: 'Key (entity_id, code)=(5d0c…, 1110) already exists.',
    });
    setLanguage('en');
    const e = errorEnvelope(pg, 1);
    expect(e).toEqual({
      schema: 'mnemosine.error/1',
      exit_code: 1,
      key: 'cli.error.internal',
      params: {},
      message:
        'The command failed on an internal error (database, network or system); ' +
        'its details are not part of a machine error.',
      remedy: 'Run the same command without --json to read the details.',
    });
    expect(JSON.stringify(e)).not.toMatch(/accounts_entity_code_key|23505|1110/);
  });

  it('a system error is internal, and the remedy reportError found wins over the fixed one', () => {
    const sys = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432'), { code: 'ECONNREFUSED', syscall: 'connect' });
    setLanguage('en');
    const e = errorEnvelope(sys, 1, { remedy: 'mnemosine doctor   (and check DATABASE_URL in .env)' });
    expect(e.key).toBe('cli.error.internal');
    expect(e.remedy).toBe('mnemosine doctor   (and check DATABASE_URL in .env)');
    expect(JSON.stringify(e)).not.toContain('10.0.0.7');
  });

  it('an AppError whose code starts with E is not mistaken for a system error', () => {
    const err = new AppError(502, 'EXTERNAL_SERVICE_FAILED', 'contalink: HTTP 503 at /balanza');
    expect(errorEnvelope(err, 8)).toMatchObject({ key: null, message: 'contalink: HTTP 503 at /balanza' });
  });

  it('any other exception keeps its message; a thrown string too; never a stack', () => {
    const plain = new Error('The SAT refused to verify request r-1 (404)');
    const e = errorEnvelope(plain, 8);
    expect(e).toMatchObject({ exit_code: 8, key: null, params: {}, message: 'The SAT refused to verify request r-1 (404)' });
    expect(JSON.stringify(e)).not.toContain('at ');
    expect(errorEnvelope('boom', 1)).toMatchObject({ key: null, message: 'boom', remedy: null });
  });

  it('what the caller words itself (a provider) is what it says', () => {
    expect(
      errorEnvelope(new Error('401'), 1, { message: 'The provider rejected the credential (401).', remedy: 'Check api_key_env.' })
    ).toEqual({
      schema: 'mnemosine.error/1',
      exit_code: 1,
      key: null,
      params: {},
      message: 'The provider rejected the credential (401).',
      remedy: 'Check api_key_env.',
    });
  });

  it('writes ONE line: a message with line breaks stays inside the JSON', () => {
    const lines: string[] = [];
    writeErrorEnvelope(new CliError('one\ntwo', ExitCode.VALIDATION), 4, {}, { write: (s: string) => lines.push(s) > 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(lines[0].slice(0, -1)).not.toContain('\n');
    expect((JSON.parse(lines[0]) as { message: string }).message).toBe('one\ntwo');
  });
});

describe('MNE-001-698 · which invocations asked for JSON', () => {
  it.each([
    [{ json: true }, true],
    [{ format: 'json' }, true],
    [{ format: ' JSON ' }, true],
    [{ format: 'ndjson' }, true],
    [{ format: 'csv' }, false],
    [{ format: 'table' }, false],
    [{ format: 'md' }, false],
    [{ format: 'xml' }, false],
    [{}, false],
    [{ json: 'yes' }, false],
  ])('%j → %s', (opts, expected) => {
    setErrorOutput(opts);
    expect(machineErrorOutput()).toBe(expected);
  });
});
