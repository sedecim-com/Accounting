import { describe, it, expect } from 'vitest';
import { render, resolveFormat, fieldNames, SCHEMA_VERSION } from '../../../src/cli/kernel/output.js';
import { CliError, ExitCode } from '../../../src/cli/kernel/exit.js';

// ============================================================
// The two properties in here are correctness, not formatting:
//   money never becomes a JSON number, and truncation is never
//   silent. Both produce wrong financial statements when broken,
//   and both break invisibly.
// ============================================================

/** Collects what a command would have written, per stream. */
function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    stdout: { write: (s: string) => { out.push(s); return true; }, isTTY: false } as unknown as NodeJS.WriteStream,
    stderr: { write: (s: string) => { err.push(s); return true; }, isTTY: false } as unknown as NodeJS.WriteStream,
    get stdoutText() { return out.join(''); },
    get stderrText() { return err.join(''); },
  };
}

const ROWS = [
  { code: '1110', name: 'Bancos', balance: '1000.51', type: 'asset' },
  { code: '2110', name: 'Proveedores', balance: '-400.00', type: 'liability' },
];

describe('money survives as a decimal string', () => {
  it('JSON keeps amounts as strings, never as numbers', () => {
    const s = sink();
    render(ROWS, { json: true, stdout: s.stdout, stderr: s.stderr });
    const parsed = JSON.parse(s.stdoutText) as { rows: Array<Record<string, unknown>>; meta?: Record<string, unknown> };
    expect(typeof parsed.rows[0].balance).toBe('string');
    expect(parsed.rows[0].balance).toBe('1000.51');
    // The exact cent survives a parse round-trip, which is the whole point.
    expect(parsed.rows[1].balance).toBe('-400.00');
  });

  it('does not normalise trailing zeros away', () => {
    const s = sink();
    render([{ id: 'a', amount: '10.00' }], { json: true, stdout: s.stdout, stderr: s.stderr });
    expect(JSON.parse(s.stdoutText).rows[0].amount).toBe('10.00');
  });
});

describe('truncation is always reported', () => {
  it('tells a human on stderr, never on stdout', () => {
    const s = sink();
    render(ROWS, { total: 1200, stdout: s.stdout, stderr: s.stderr });
    expect(s.stderrText).toMatch(/Showing 2 of 1200 rows/);
    expect(s.stdoutText).not.toMatch(/Showing/);
  });

  it('carries truncation in the JSON envelope instead of a note', () => {
    const s = sink();
    render(ROWS, { json: true, total: 1200, stdout: s.stdout, stderr: s.stderr });
    const parsed = JSON.parse(s.stdoutText) as { rows: Array<Record<string, unknown>>; meta?: Record<string, unknown> };
    expect(parsed).toMatchObject({ schema: SCHEMA_VERSION, count: 2, total: 1200, truncated: true });
    expect(s.stderrText).toBe('');
  });

  it('says nothing when nothing was dropped', () => {
    const s = sink();
    render(ROWS, { total: 2, stdout: s.stdout, stderr: s.stderr });
    expect(s.stderrText).toBe('');
  });

  it('still warns for csv, so a pipeline does not inherit a partial extract', () => {
    const s = sink();
    render(ROWS, { format: 'csv', total: 99, stdout: s.stdout, stderr: s.stderr });
    expect(s.stderrText).toMatch(/Showing 2 of 99/);
  });
});

describe('formats', () => {
  it('--json is exactly --format json', () => {
    expect(resolveFormat({ json: true })).toBe('json');
    expect(resolveFormat({ format: 'json' })).toBe('json');
  });

  it('rejects an unknown format as a usage error, listing the real ones', () => {
    try {
      resolveFormat({ format: 'yaml' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(ExitCode.USAGE);
      expect((err as CliError).message).toMatch(/table, json, ndjson, csv, tsv, md/);
    }
  });

  it('ndjson emits bare objects, one per line', () => {
    const s = sink();
    render(ROWS, { format: 'ndjson', stdout: s.stdout, stderr: s.stderr });
    const lines = s.stdoutText.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).code).toBe('1110');
  });

  it('csv quotes separators, quotes and newlines', () => {
    const s = sink();
    render([{ name: 'Uno, dos', note: 'dijo "hola"' }], { format: 'csv', stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toContain('"Uno, dos"');
    expect(s.stdoutText).toContain('"dijo ""hola"""');
  });

  it('markdown escapes pipes so the table still renders', () => {
    const s = sink();
    render([{ flags: '--format <csv|json>' }], { format: 'md', stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toContain('--format <csv\\|json>');
  });

  it('markdown escapes backslashes before pipes, so `\\|` in a cell cannot smuggle a bare pipe', () => {
    // Con el orden invertido, `\|` se volvía `\\|`: barra literal + pipe SIN
    // escapar — la celda parte la fila de la tabla.
    const s = sink();
    render([{ ruta: 'C:\\temp', nota: 'ya venia \\| escapado' }], { format: 'md', stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toContain('C:\\\\temp');
    expect(s.stdoutText).toContain('ya venia \\\\\\| escapado');
  });

  it('table right-aligns numeric columns and left-aligns text', () => {
    const s = sink();
    render(ROWS, { stdout: s.stdout, stderr: s.stderr });
    const lines = s.stdoutText.trim().split('\n');
    // header, rule, two rows
    expect(lines).toHaveLength(4);
    // balance es columna de dinero: en la tabla (y solo ahi) va vestida
    // de presentacion es-MX, con separador de miles y dos decimales.
    expect(lines[2]).toMatch(/1,000\.51/);
    expect(lines[3]).toMatch(/-400\.00/);
    expect(lines[0]).toMatch(/^code\s+name\s+balance\s+type$/);
  });

  it('reports an empty result on stderr rather than printing an empty table', () => {
    const s = sink();
    render([], { stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toBe('');
    expect(s.stderrText).toMatch(/No rows/);
  });
});

describe('field selection', () => {
  it('bare --fields lists what is available (free schema discovery)', () => {
    const s = sink();
    render(ROWS, { fields: true, stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText.trim().split('\n')).toEqual(['code', 'name', 'balance', 'type']);
  });

  it('restricts the columns, in the order asked for', () => {
    const s = sink();
    render(ROWS, { json: true, fields: 'balance,code', stdout: s.stdout, stderr: s.stderr });
    expect(Object.keys(JSON.parse(s.stdoutText).rows[0])).toEqual(['balance', 'code']);
  });

  it('names the unknown field and the real ones instead of silently dropping it', () => {
    const s = sink();
    expect(() => render(ROWS, { fields: 'saldo', stdout: s.stdout, stderr: s.stderr })).toThrow(
      /Unknown field\(s\): saldo\. Available: code, name, balance, type/
    );
  });

  it('collects names across ragged rows', () => {
    expect(fieldNames([{ a: 1 }, { b: 2 }, { a: 3, c: 4 }])).toEqual(['a', 'b', 'c']);
  });
});

describe('--quiet', () => {
  it('prints identifiers only, one per line, for piping', () => {
    const s = sink();
    render([{ id: 'x1', name: 'a' }, { id: 'x2', name: 'b' }], { quiet: true, stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toBe('x1\nx2\n');
  });

  it('falls back to code when there is no id column', () => {
    const s = sink();
    render(ROWS, { quiet: true, stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toBe('1110\n2110\n');
  });

  it('still reports truncation, so a piped list is never silently short', () => {
    const s = sink();
    render(ROWS, { quiet: true, total: 50, stdout: s.stdout, stderr: s.stderr });
    expect(s.stderrText).toMatch(/Showing 2 of 50/);
  });
});
