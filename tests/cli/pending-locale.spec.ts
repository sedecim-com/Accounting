import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// ============================================================
// `mnemosine pending --locale es-MX` COMES OUT ENTIRELY IN SPANISH
// (I10 · #152, MNE-001-091)
//
// Part 1/2 put the six fields and every option label of the 58 policies in
// `es` and `en`. This part makes the readers PAINT them: the listing, the
// explanation layer, the work board and `policy-preview.ts` ask the catalog
// by key, in the active language, and the figures go through the formatter.
//
// Every check runs the same walk in both languages, so a screen that still
// paints the spec's English prose (or a message that exists in one language
// only) fails here instead of in front of an accountant.
// ============================================================

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

vi.mock('../../src/ai/shadow-verdicts.js', () => ({ concordanciaSombra: vi.fn() }));

import { query } from '../../src/database/connection.js';
import { concordanciaSombra } from '../../src/ai/shadow-verdicts.js';
import { FLOOR_SOMBRA_ACUERDO, FLOOR_SOMBRA_DIAS, FLOOR_SOMBRA_VEREDICTOS } from '../../src/ai/floor.js';
import { renderBoard, renderExplanation, renderPolicies } from '../../src/cli/pending-command.js';
import { ambiguityQuestion } from '../../src/cli/policy-answer.js';
import { panelTranslator, previewText } from '../../src/i18n/panel-text.js';
import { PREVIEWS } from '../../src/services/policy/policy-preview.js';
import { POLICY_CATALOG } from '../../src/services/policy/pending-catalog.js';
import { policyWording, type PolicyRow } from '../../src/services/policy/policy-service.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';

const mockQuery = query as unknown as Mock;
const mockShadow = concordanciaSombra as unknown as Mock;
const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

/** A seeded row built from the spec, the way `seedPolicies` writes it. */
function rowOf(spec: (typeof POLICY_CATALOG)[number]): PolicyRow {
  return {
    key: spec.key,
    category: spec.category,
    question: spec.question,
    impact: spec.impact,
    options: spec.options,
    default_value: spec.defaultValue,
    default_rationale: spec.defaultRationale,
    status: 'pending',
  } as unknown as PolicyRow;
}

beforeEach(() => mockQuery.mockReset());
afterEach(() => resetLanguage());

describe('the listing paints the catalog in the active language', () => {
  it('every policy: question, impact, rationale and options come out in Spanish under es', () => {
    for (const spec of POLICY_CATALOG) {
      const es = policyWording(rowOf(spec), panelTranslator('es'));
      const en = policyWording(rowOf(spec), panelTranslator('en'));
      expect(en.question, spec.key).toBe(spec.question);
      expect(es.question, spec.key).not.toBe(spec.question);
      expect(es.impact, spec.key).not.toBe(spec.impact);
      expect(es.defaultRationale, spec.key).not.toBe(spec.defaultRationale);
      // The VALUES never move: they are what `policy_decisions` stores.
      expect(es.options.map((o) => o.value)).toEqual(spec.options.map((o) => o.value));
    }
  });

  it('renderPolicies -v under es prints Spanish labels and none of the English prose', () => {
    setLanguage('es');
    const spec = POLICY_CATALOG[0];
    const text = renderPolicies([rowOf(spec)], plain, { verbose: true }).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain('impacto:');
    expect(text).toContain('operando con:');
    expect(text).toContain('por qué lo pregunto:');
    expect(text).not.toContain('operating with');
    expect(text).not.toContain(spec.question.replace(/\s+/g, ' '));
  });

  it('the same screen under en is unchanged English', () => {
    setLanguage('en');
    const spec = POLICY_CATALOG[0];
    const text = renderPolicies([rowOf(spec)], plain, { verbose: true }).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain('operating with');
    expect(text).toContain('impact:');
    expect(text).toContain(spec.question.replace(/\s+/g, ' ').slice(0, 40));
  });

  it('the explanation layer and the preview header follow the language', () => {
    setLanguage('es');
    const key = POLICY_CATALOG.find((s) => s.whyAsking && s.whatIDo && s.ifSkipped)!.key;
    const text = renderExplanation(key, plain, ['  · una línea']).join('\n');
    expect(text).toContain('por qué lo pregunto:');
    expect(text).toContain('qué hago con tu respuesta:');
    expect(text).toContain('si lo omites:');
    expect(text).toContain('en tus datos:');
  });

  it('reading the wording never touches the row: the state is byte-identical', () => {
    const row = rowOf(POLICY_CATALOG[0]);
    const before = JSON.stringify(row);
    Object.freeze(row);
    policyWording(row, panelTranslator('es'));
    renderPolicies([row], plain, { verbose: true });
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe('the work board and the prompts follow the language', () => {
  const board = {
    totalWork: 2,
    items: [{ kind: 'draft' as const, count: 2, summary: t('pending.board.draft', { count: 2 }, 'es'), command: 'mnemosine review' }],
  };

  it('es: header, plural and empty board', () => {
    setLanguage('es');
    expect(renderBoard(board, 'Acme', plain)[0]).toBe('Acme: 2 cosas por resolver');
    expect(renderBoard({ items: [], totalWork: 0 }, 'Acme', plain)[0]).toBe('Acme: Nada pendiente. Estás al corriente.');
    expect(t('pending.define.remaining', { count: 1 })).toBe('1 definición sigue pendiente.');
    expect(t('pending.define.remaining', { count: 3 })).toBe('3 definiciones siguen pendientes.');
  });

  it('en: the same board reads as before', () => {
    setLanguage('en');
    expect(renderBoard(board, 'Acme', plain)[0]).toBe('Acme: 2 things to resolve');
    expect(t('pending.define.remaining', { count: 1 })).toBe('1 definition still pending.');
  });

  it('the ambiguity question is asked in the active language', () => {
    const a = { kind: 'ambiguous', typed: '1', byPosition: '0.25', byValue: '1' } as never;
    setLanguage('es');
    expect(ambiguityQuestion(a)).toContain('Escribe p para la opción 1');
    setLanguage('en');
    expect(ambiguityQuestion(a)).toContain('Type p for option 1');
  });
});

describe('policy-preview.ts: wording by key, figures by the formatter', () => {
  // Built per call: the edge binds the text to the language active right then.
  const ctx = () => ({ entityId: 'e', tenantId: 't', currency: 'MXN', text: previewText() });
  const invoices = (subtotals: number[]) => ({
    rows: subtotals.map((s) => ({ subtotal: String(s), total: String(s) })),
  });

  it('threshold preview: plural, percentage and money in es and en', async () => {
    mockQuery.mockResolvedValue(invoices([100, 6000, 30000, 60000]));
    setLanguage('es');
    const es = await PREVIEWS.umbral_capitalizacion_mxn(ctx());
    expect(es[0]).toBe('De tus 4 facturas recibidas:');
    expect(es[1]).toContain('con MXN 5,000 → te preguntaría 3 veces (75 %)');
    mockQuery.mockResolvedValue(invoices([60000]));
    const one = await PREVIEWS.umbral_capitalizacion_mxn(ctx());
    expect(one[0]).toBe('De tu 1 factura recibida:');
    expect(one[3]).toContain('te preguntaría 1 vez (100 %)');

    mockQuery.mockResolvedValue(invoices([100, 6000, 30000, 60000]));
    setLanguage('en');
    const en = await PREVIEWS.umbral_capitalizacion_mxn(ctx());
    expect(en[0]).toBe('Of your 4 received invoices:');
    expect(en[1]).toContain('I would ask you 3 times (75%)');
  });

  it('restaurants preview uses the formatter for every amount, in both languages', async () => {
    mockQuery.mockResolvedValue({ rows: [{ n: '1', total: '2000' }] });
    setLanguage('es');
    const es = await PREVIEWS.politica_restaurantes(ctx());
    expect(es).toEqual([
      '1 factura de restaurante por MXN 2,000:',
      '  · deducible (8.5 %): MXN 170',
      '  · no deducible: MXN 1,830',
    ]);
    setLanguage('en');
    expect((await PREVIEWS.politica_restaurantes(ctx()))[0]).toBe('1 restaurant invoice for MXN 2,000:');
  });

  it('the shadow line reads the floors from the code constants, in both languages', async () => {
    mockQuery.mockResolvedValue({ rows: [{ status: 'approved', n: '12' }] });
    mockShadow.mockResolvedValue({
      veredictos: 5, dias_con_veredictos: 1, decididos: 3, tasa_acuerdo: '0.900',
    });
    setLanguage('en');
    const en = await PREVIEWS.ingest_auto_post(ctx());
    expect(en[0]).toBe('Of the 12 drafts I have proposed so far:');
    expect(en.at(-1)).toContain(
      `requires at least ${FLOOR_SOMBRA_DIAS} days, ${FLOOR_SOMBRA_VEREDICTOS} decided and ${FLOOR_SOMBRA_ACUERDO.toFixed(2)} agreement`
    );
    setLanguage('es');
    const es = await PREVIEWS.ingest_auto_post(ctx());
    expect(es[0]).toBe('De los 12 borradores que he propuesto hasta ahora:');
    expect(es.at(-1)).toContain('sombra: 5 veredictos en 1 día');
  });
});
