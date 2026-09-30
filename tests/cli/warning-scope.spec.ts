import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import winston from 'winston';
import { prepareCliProcess, runChatTurn } from '../../src/cli/mnemosine.js';
import { logger } from '../../src/utils/logger.js';

// ============================================================
// THE CLI'S WARNING SCOPES (#327, MNE-001-089)
//
// A one-shot command prints each identical warning once: the entry block
// runs prepareCliProcess before parsing. The chat REPL lives for hours in
// the same process, so each turn is its own unit of work: a fallback that
// recurs in a later turn (an invalid policy value, a lost closing lock) is
// printed again instead of being swallowed for the rest of the session.
// ============================================================

const lines: string[] = [];
let sink: winston.transport;
let saved: winston.transport[] = [];

beforeEach(() => {
  lines.length = 0;
  sink = new winston.transports.Stream({
    stream: new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(...chunk.toString('utf-8').split('\n').filter(Boolean));
        done();
      },
    }),
  });
  saved = [...logger.transports];
  logger.clear();
  logger.add(sink);
});

afterEach(() => {
  logger.remove(sink);
  for (const t of saved) logger.add(t);
});

/** Winston writes to the stream asynchronously; one macrotask drains it. */
const drained = () => new Promise((resolve) => setImmediate(resolve));

const policyFallback = () =>
  logger.warn('Policy value is invalid; using <conservative>', { policy: 'closing.fx' });

describe('the CLI process prints each warning once per unit of work', () => {
  it('a one-shot command: the same warning twice prints once', async () => {
    prepareCliProcess();
    policyFallback();
    policyFallback();
    await drained();
    expect(lines).toHaveLength(1);
  });

  it('chat: two turns that each warn twice print the warning once per turn', async () => {
    prepareCliProcess();
    const session = {
      runTurn: async () => {
        policyFallback();
        policyFallback();
        return 'ok';
      },
    };
    await runChatTurn(session, 'close September');
    await runChatTurn(session, 'close September again');
    await drained();
    expect(lines).toHaveLength(2);
  });
});
