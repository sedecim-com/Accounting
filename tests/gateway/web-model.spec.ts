import { describe, expect, it } from 'vitest';
import { parseDraftList, parsePeriodList, parseQuestionList } from '../../src/gateway/app/entity-model.js';
import { pickLanguage, text, type WebMessageKey } from '../../src/gateway/app/messages.js';
import { ageInMinutes, parsePortfolioResponse, sortRows, type PortfolioRow } from '../../src/gateway/app/portfolio-model.js';
import { toneOfCount, toneOfPeriodStatus } from '../../src/gateway/app/tone.js';
import { EN } from '../../src/i18n/en.js';
import { ES } from '../../src/i18n/es.js';
import { messageParameters, t, type TranslationKey } from '../../src/i18n/index.js';

// ============================================================
// W1 · the browser program's DOM-free models: what it accepts from the API,
// how it sorts and tones, and how it speaks.
// ============================================================

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function portfolioBody(overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    data: [
      {
        entity_id: A,
        name: 'Abarrotes La Esperanza',
        is_active: true,
        current_period: { id: 'p1', name: 'September 2026', status: 'open', start_date: '2026-09-01', end_date: '2026-09-30' },
        ended_open_periods: 2,
        pending_drafts: 1,
        pending_questions: 0,
        ...overrides,
      },
    ],
    meta: { request_id: 'r', timestamp: 't', version: 'v1', as_of_date: '2026-09-15', omitted: { unresolved: 1 }, not_evaluated: ['close_readiness'], ...meta },
  };
}

describe('parsePortfolioResponse', () => {
  it('reads a well-formed body into the browser shape', () => {
    const portfolio = parsePortfolioResponse(portfolioBody());
    expect(portfolio).toEqual({
      rows: [
        {
          entityId: A,
          name: 'Abarrotes La Esperanza',
          isActive: true,
          currentPeriod: { id: 'p1', name: 'September 2026', status: 'open', startDate: '2026-09-01', endDate: '2026-09-30' },
          endedOpenPeriods: 2,
          pendingDrafts: 1,
          pendingQuestions: 0,
        },
      ],
      meta: { asOfDate: '2026-09-15', unresolved: 1, notEvaluated: ['close_readiness'] },
    });
    expect(parsePortfolioResponse(portfolioBody({ current_period: null }))?.rows[0].currentPeriod).toBeNull();
  });

  it('refuses a malformed body whole instead of rendering part of it', () => {
    const malformed: unknown[] = [
      null,
      [],
      'text',
      { data: {}, meta: portfolioBody().meta },
      { data: [] },
      portfolioBody({}, { as_of_date: '15/09/2026' }),
      portfolioBody({}, { omitted: { unresolved: -1 } }),
      portfolioBody({}, { omitted: {} }),
      portfolioBody({}, { not_evaluated: [1] }),
      portfolioBody({ entity_id: 7 }),
      portfolioBody({ name: null }),
      portfolioBody({ is_active: 'yes' }),
      portfolioBody({ pending_drafts: 1.5 }),
      portfolioBody({ pending_questions: -2 }),
      portfolioBody({ ended_open_periods: '3' }),
      portfolioBody({ current_period: { id: 'p1', name: 'September 2026', status: 'open' } }),
      portfolioBody({ current_period: 'open' }),
    ];
    for (const body of malformed) {
      expect(parsePortfolioResponse(body), JSON.stringify(body)).toBeUndefined();
    }
  });
});

describe('sortRows', () => {
  const row = (entityId: string, name: string, pendingDrafts: number, startDate?: string): PortfolioRow => ({
    entityId,
    name,
    isActive: true,
    currentPeriod: startDate ? { id: `p-${entityId}`, name: startDate, status: 'open', startDate, endDate: startDate } : null,
    endedOpenPeriods: 0,
    pendingDrafts,
    pendingQuestions: 0,
  });
  const rows = [row('1', 'Delta', 2), row('2', 'Alfa', 5), row('3', 'Charlie', 2), row('4', 'Bravo', 2)];

  it('is stable in both directions: ties keep the order the API gave', () => {
    expect(sortRows(rows, { column: 'pendingDrafts', direction: 'ascending' }).map((r) => r.entityId)).toEqual(['1', '3', '4', '2']);
    expect(sortRows(rows, { column: 'pendingDrafts', direction: 'descending' }).map((r) => r.entityId)).toEqual(['2', '1', '3', '4']);
  });

  it('sorts by name and by period start, and never mutates its input', () => {
    const before = rows.map((r) => r.entityId);
    expect(sortRows(rows, { column: 'name', direction: 'ascending' }).map((r) => r.name)).toEqual(['Alfa', 'Bravo', 'Charlie', 'Delta']);
    expect(sortRows(rows, { column: 'name', direction: 'descending' }).map((r) => r.name)).toEqual(['Delta', 'Charlie', 'Bravo', 'Alfa']);
    const dated = [row('x', 'X', 0, '2026-09-01'), row('y', 'Y', 0), row('z', 'Z', 0, '2026-08-01')];
    expect(sortRows(dated, { column: 'currentPeriod', direction: 'ascending' }).map((r) => r.entityId)).toEqual(['y', 'z', 'x']);
    expect(rows.map((r) => r.entityId)).toEqual(before);
  });

  it('ages a read in whole minutes, never negative', () => {
    expect(ageInMinutes(0, 59_999)).toBe(0);
    expect(ageInMinutes(0, 60_000)).toBe(1);
    expect(ageInMinutes(10_000, 0)).toBe(0);
  });
});

describe('the traffic light restates facts and never classifies', () => {
  it('counts: zero is neutral, never green; above zero is pending', () => {
    expect(toneOfCount(0)).toBe('neutral');
    expect(toneOfCount(1)).toBe('pending');
    expect(toneOfCount(40)).toBe('pending');
  });

  it('period status: open and soft_close info, hard_close and locked balanced, the rest neutral', () => {
    expect(toneOfPeriodStatus('open')).toBe('info');
    expect(toneOfPeriodStatus('soft_close')).toBe('info');
    expect(toneOfPeriodStatus('hard_close')).toBe('balanced');
    expect(toneOfPeriodStatus('locked')).toBe('balanced');
    expect(toneOfPeriodStatus('future')).toBe('neutral');
    expect(toneOfPeriodStatus(null)).toBe('neutral');
    expect(toneOfPeriodStatus('something-new')).toBe('neutral');
  });
});

describe('the board speaks the house catalog', () => {
  it('pickLanguage takes the first browser language it speaks, and falls back to Spanish', () => {
    expect(pickLanguage(['en-US'])).toBe('en');
    expect(pickLanguage(['fr', 'es-MX'])).toBe('es');
    expect(pickLanguage(['EN_gb', 'es'])).toBe('en');
    expect(pickLanguage(['de', 'pt-BR'])).toBe('es');
    expect(pickLanguage([])).toBe('es');
  });

  const webKeys = (Object.keys(EN) as TranslationKey[]).filter((key): key is WebMessageKey => key.startsWith('web.'));

  it('there are web.* keys to speak with', () => {
    expect(webKeys.length).toBeGreaterThan(40);
  });

  it('every web.* message is branch-free in both languages, so a {name} lookup is enough', () => {
    for (const key of webKeys) {
      for (const [language, catalog] of [['es', ES], ['en', EN]] as const) {
        const parameters = messageParameters(catalog[key], `${language}:${key}`);
        expect(
          parameters.every((p) => p.kind === 'value' && p.branches.length === 0),
          `${language}:${key} has a plural or a select`
        ).toBe(true);
      }
    }
  });

  it("the board's small runtime renders exactly what the CLI's t() renders for every web.* key", () => {
    for (const key of webKeys) {
      const params = Object.fromEntries(messageParameters(EN[key], key).map((p) => [p.name, `<${p.name}>`]));
      for (const language of ['es', 'en'] as const) {
        expect(text(language, key, params), `${language}:${key}`).toBe(t(key, params, language));
      }
    }
  });

  it('a missing hole throws and names the key, as t() does', () => {
    expect(() => text('es', 'web.portfolio.as_of')).toThrow(/web\.portfolio\.as_of needs \{date\}/);
    expect(text('es', 'web.portfolio.as_of', { date: '2026-09-15' })).toBe('Fecha del servidor 2026-09-15');
    expect(text('en', 'web.portfolio.as_of', { date: '2026-09-15' })).toBe('Server date 2026-09-15');
  });
});

describe("one entity's lists", () => {
  it('drafts: keeps entry date, description and confidence, and refuses a body of another shape', () => {
    const body = {
      data: [
        {
          id: 'd1',
          entity_id: A,
          status: 'pending_review',
          payload: { entry_date: '2026-09-10', description: 'Compra de mercancía', lines: [] },
          ai_confidence: '0.82',
          created_at: '2026-09-10T17:00:00.000Z',
        },
      ],
      meta: {},
    };
    expect(parseDraftList(body)).toEqual([{ id: 'd1', entryDate: '2026-09-10', description: 'Compra de mercancía', confidence: '0.82' }]);
    expect(parseDraftList({ data: [{ id: 'd1', payload: {} }] })).toBeUndefined();
    expect(parseDraftList({ data: 'x' })).toBeUndefined();
  });

  it('questions: an absent topic is empty text, and the date is the calendar part', () => {
    const body = { data: [{ id: 'q1', question: '¿Se capitaliza?', topic: null, created_at: '2026-09-11T08:00:00.000Z' }] };
    expect(parseQuestionList(body)).toEqual([{ id: 'q1', question: '¿Se capitaliza?', topic: '', createdAt: '2026-09-11' }]);
    expect(parseQuestionList({ data: [{ id: 'q1', question: 3 }] })).toBeUndefined();
  });

  it('periods: name, status and calendar dates as the API sent them', () => {
    const body = {
      data: [{ id: 'p1', entity_id: B, period_name: 'August 2026', status: 'hard_close', start_date: '2026-08-01T00:00:00.000Z', end_date: '2026-08-31T00:00:00.000Z' }],
    };
    expect(parsePeriodList(body)).toEqual([{ id: 'p1', name: 'August 2026', status: 'hard_close', startDate: '2026-08-01', endDate: '2026-08-31' }]);
    expect(parsePeriodList({ data: [{ id: 'p1', period_name: 'August 2026' }] })).toBeUndefined();
  });
});
