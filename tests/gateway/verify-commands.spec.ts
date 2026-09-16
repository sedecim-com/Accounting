import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { program } from '../../src/cli/mnemosine.js';
import { VERIFY_COMMANDS } from '../../src/gateway/app/view.js';

// ============================================================
// W1 · the terminal commands the entity view prints are real, and only read.
//
// The entity view tells the operator which CLI commands list the same drafts,
// questions and periods for that entity. A command that does not parse sends
// them to a Commander error; a command that writes turns a check into an act
// (`pending -e` seeds policy_decisions, which is why it is not one of them).
// Each was chosen by reading its action: `drafts` is resolveEntity plus
// listDrafts, `question list` is resolveEntity plus listQuestions, and
// `period list` is resolveActiveEntity plus listFiscalPeriods, all SELECTs.
// This spec holds the part a machine can hold: every command lands on a leaf
// of the shipped program, every flag it passes is one that leaf accepts with
// no operand left over, -e carries the entity, and the leaf's declared risk is
// lectura.
// ============================================================

const ENTITY = '3f1c2b7a-9d4e-4c1b-8a2f-5e6d7c8b9a01';

function resolveLeaf(tokens: string[]): { leaf: Command; rest: string[] } {
  expect(tokens[0]).toBe('mnemosine');
  let node: Command = program;
  let i = 1;
  while (i < tokens.length && !tokens[i].startsWith('-')) {
    const next = (node.commands as Command[]).find((c) => c.name() === tokens[i] || c.aliases().includes(tokens[i]));
    if (!next) break;
    node = next;
    i += 1;
  }
  return { leaf: node, rest: tokens.slice(i) };
}

describe('the verify commands the entity view prints', () => {
  it('are the three read-only lists, one per list the view shows', () => {
    expect(VERIFY_COMMANDS).toHaveLength(3);
    for (const template of VERIFY_COMMANDS) expect(template).toContain('-e {entity}');
  });

  for (const template of VERIFY_COMMANDS) {
    it(`${template} lands on a lectura leaf, with -e accepted and nothing left over`, () => {
      const tokens = template.replace('{entity}', ENTITY).split(' ');
      const { leaf, rest } = resolveLeaf(tokens);
      expect(leaf.commands, `${template} stops at a command group, not a leaf`).toHaveLength(0);
      expect(leaf).not.toBe(program);
      expect(riskOf(leaf)?.risk, `${template} is not declared lectura`).toBe('lectura');

      const { operands, unknown } = leaf.parseOptions(rest);
      expect(unknown, `${template} passes flags its leaf does not know`).toEqual([]);
      expect(operands, `${template} leaves operands the leaf does not take`).toEqual([]);
      expect(leaf.opts<{ entity?: string }>().entity).toBe(ENTITY);
    });
  }
});
