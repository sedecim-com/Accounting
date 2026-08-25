import { describe, it, expect } from 'vitest';
import { buildDocsTools, readDoc, docsIndex, DOC_TOPICS, type DocTopic } from '../../../src/ai/tools/docs-tools.js';

const TOPICS = Object.keys(DOC_TOPICS) as DocTopic[];

describe('system docs', () => {
  it('every indexed topic has a real, non-trivial doc file', () => {
    for (const topic of TOPICS) {
      const content = readDoc(topic);
      expect(content.length, `doc ${topic}`).toBeGreaterThan(400);
      expect(content).toMatch(/^# /);
    }
  });

  it('docsIndex lists every topic with its summary (system-prompt block)', () => {
    const index = docsIndex();
    for (const topic of TOPICS) expect(index).toContain(`- ${topic}:`);
    expect(index.split('\n')).toHaveLength(TOPICS.length);
  });

  it('read_docs tool returns the doc and validates the topic via enum', async () => {
    const tool = buildDocsTools({ model: 'x' })[0];
    expect(tool.name).toBe('read_docs');
    const out = await tool.run({ topic: 'payroll' });
    expect(out).toMatch(/SUTA PER STATE/);
    // zod enum rejects unknown topics at parse time (the runner calls parse)
    expect(() => tool.parse({ topic: 'made-up' })).toThrow();
  });

  it('docs separate what the AI does from what the human does', () => {
    // The editorial contract: every operational doc directs the human to their channel.
    for (const topic of ['accounting', 'receivables', 'payables', 'mexico-cfdi', 'payroll'] as DocTopic[]) {
      expect(readDoc(topic)).toMatch(/human/i);
    }
    expect(readDoc('mnemosine')).toMatch(/cannot EXECUTE — but you GUIDE/);
  });
});
