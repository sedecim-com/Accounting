import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import winston from 'winston';

// ============================================================
// THE LOGGER ON A TERMINAL (#327, MNE-001-089)
//
// The end-to-end walk of 2026-09-25 found winston warnings such as
// "CFDI MetodoPago missing" printed with ANSI codes although NO_COLOR was
// set, and the same warning two or three times per command: posting and
// checking both resolve the MetodoPago of the same document, and each
// resolution warned again.
//
// The logger is built at import time, so every case imports a fresh copy
// after setting the environment it wants to observe.
// ============================================================

const ANSI = /\x1b\[/;

type LoggerModule = typeof import('../../src/utils/logger.js');

async function freshLogger(): Promise<{ mod: LoggerModule; lines: string[] }> {
  vi.resetModules();
  const mod = await import('../../src/utils/logger.js');
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(...chunk.toString('utf-8').split('\n').filter(Boolean));
      done();
    },
  });
  mod.logger.clear();
  mod.logger.add(new winston.transports.Stream({ stream: sink }));
  return { mod, lines };
}

/** Winston writes to the stream asynchronously; one macrotask drains it. */
const drained = () => new Promise((resolve) => setImmediate(resolve));

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function stdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe('logger colour follows the same gate as the CLI palette', () => {
  it('NO_COLOR on a terminal: the warning carries no ANSI code', async () => {
    stdoutIsTTY(true);
    vi.stubEnv('NO_COLOR', '1');
    const { mod, lines } = await freshLogger();
    mod.logger.warn('CFDI MetodoPago missing: conservative IVA treatment applied');
    await drained();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('warn');
    expect(lines[0]).not.toMatch(ANSI);
  });

  it('a terminal without NO_COLOR still gets colour: the gate is not simply off', async () => {
    stdoutIsTTY(true);
    vi.stubEnv('NO_COLOR', '');
    const { mod, lines } = await freshLogger();
    mod.logger.warn('coloured');
    await drained();
    expect(lines[0]).toMatch(ANSI);
  });

  it('piped output (not a TTY) carries no ANSI code even without NO_COLOR', async () => {
    stdoutIsTTY(false);
    vi.stubEnv('NO_COLOR', '');
    const { mod, lines } = await freshLogger();
    mod.logger.warn('piped');
    await drained();
    expect(lines[0]).not.toMatch(ANSI);
  });

  it('colorEnabled reads NO_COLOR as the spec does: present and non-empty', async () => {
    const { mod } = await freshLogger();
    expect(mod.colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(mod.colorEnabled({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
    expect(mod.colorEnabled({ isTTY: true }, { NO_COLOR: '0' })).toBe(false);
    expect(mod.colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(mod.colorEnabled({}, {})).toBe(false);
  });
});

describe('each warning once per CLI command', () => {
  const warnThrice = (mod: LoggerModule) => {
    for (let i = 0; i < 3; i++) {
      mod.logger.warn('CFDI MetodoPago missing: conservative IVA treatment applied', {
        document: 'invoice',
        reference: 'INV-2026-00042',
      });
    }
  };

  it('the CLI mode prints an identical warning once', async () => {
    stdoutIsTTY(false);
    const { mod, lines } = await freshLogger();
    mod.logEachWarningOnce();
    warnThrice(mod);
    await drained();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('INV-2026-00042');
  });

  it('a warning about another document is a different warning, and is printed', async () => {
    stdoutIsTTY(false);
    const { mod, lines } = await freshLogger();
    mod.logEachWarningOnce();
    warnThrice(mod);
    mod.logger.warn('CFDI MetodoPago missing: conservative IVA treatment applied', {
      document: 'invoice',
      reference: 'INV-2026-00043',
    });
    await drained();
    expect(lines).toHaveLength(2);
  });

  it('only warnings are collapsed: a repeated error is still printed each time', async () => {
    stdoutIsTTY(false);
    const { mod, lines } = await freshLogger();
    mod.logEachWarningOnce();
    mod.logger.error('same failure');
    mod.logger.error('same failure');
    await drained();
    expect(lines).toHaveLength(2);
  });

  it('outside the CLI (the long-lived server) every occurrence is still logged', async () => {
    stdoutIsTTY(false);
    const { mod, lines } = await freshLogger();
    warnThrice(mod);
    await drained();
    expect(lines).toHaveLength(3);
  });
});
