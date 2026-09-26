import { describe, expect, it } from 'vitest';
import { isAllowedAttribute, mount, RejectedAttribute, skipWithoutNavigating, type MountElement } from '../../src/gateway/app/dom.js';
import type { DraftItem, PeriodItem, QuestionItem } from '../../src/gateway/app/entity-model.js';
import { text } from '../../src/gateway/app/messages.js';
import type { Portfolio, PortfolioRow } from '../../src/gateway/app/portfolio-model.js';
import {
  AGE_ELEMENT_ID,
  parseRoute,
  renderScreen,
  signOutDestination,
  VERIFY_COMMANDS,
  type ElementSpec,
  type EntityScreen,
  type PortfolioScreen,
  type Screen,
  type ViewAction,
  type ViewTag,
} from '../../src/gateway/app/view.js';

// ============================================================
// W1 · the screens as a tree, read for structure and accessibility, and the
// one module that turns the tree into nodes, run against a fake document.
//
// No browser runs here (CI has none): what WCAG asks of the markup is read off
// the tree view.ts returns, and dom.ts is driven with a document that throws
// if anything touches innerHTML. The keyboard and screen-reader pass in real
// browsers is a recorded manual audit.
// ============================================================

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const NOW = Date.UTC(2026, 8, 15, 18, 30);
const XSS = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function row(entityId: string, name: string, overrides: Partial<PortfolioRow> = {}): PortfolioRow {
  return {
    entityId,
    name,
    isActive: true,
    currentPeriod: { id: `p-${entityId}`, name: 'September 2026', status: 'open', startDate: '2026-09-01', endDate: '2026-09-30' },
    endedOpenPeriods: 0,
    pendingDrafts: 0,
    pendingQuestions: 0,
    ...overrides,
  };
}

function portfolio(rows: PortfolioRow[], unresolved = 0): Portfolio {
  return { rows, meta: { asOfDate: '2026-09-15', unresolved, notEvaluated: ['close_readiness'] } };
}

function ready(rows: PortfolioRow[], extra: Partial<PortfolioScreen> = {}): PortfolioScreen {
  return {
    kind: 'portfolio',
    loading: false,
    loaded: { portfolio: portfolio(rows), fetchedAt: NOW - 5 * 60_000 },
    sort: { column: 'name', direction: 'ascending' },
    ...extra,
  };
}

const ROWS = [
  row(A, 'Abarrotes La Esperanza', { pendingDrafts: 3, endedOpenPeriods: 1 }),
  row(B, 'Birria Don Chuy', { currentPeriod: null, isActive: false }),
  row(C, 'Cerería del Bajío', { currentPeriod: { id: 'pc', name: 'August 2026', status: 'hard_close', startDate: '2026-08-01', endDate: '2026-08-31' } }),
];

/** Every element of a tree, depth first. */
function all(specs: readonly ElementSpec[]): ElementSpec[] {
  return specs.flatMap((spec) => [spec, ...(Array.isArray(spec.children) ? all(spec.children as ElementSpec[]) : [])]);
}

function textOf(spec: ElementSpec): string {
  return typeof spec.children === 'string' ? spec.children : (spec.children ?? []).map(textOf).join(' ');
}

function render(screen: Screen, language: 'es' | 'en' = 'es'): ElementSpec[] {
  return renderScreen(screen, language, NOW);
}

describe('the portfolio screen', () => {
  const tree = all(render(ready(ROWS)));

  it('is a native table with a caption, inside a focusable region labelled by it', () => {
    const tables = tree.filter((s) => s.tag === 'table');
    expect(tables).toHaveLength(1);
    const caption = all([tables[0]]).find((s) => s.tag === 'caption');
    expect(caption?.attributes?.id).toBeTruthy();
    expect(textOf(caption!)).toBe('Entidades que puedes leer, su periodo en curso y el trabajo que espera a una persona');
    const region = tree.find((s) => s.attributes?.role === 'region');
    expect(region?.attributes).toMatchObject({ 'aria-labelledby': caption!.attributes!.id, tabindex: '0' });
    expect(all([region!])).toContain(tables[0]);
  });

  it('column headers are th scope=col, each holding a button, with aria-sort only on the sorted column', () => {
    const headers = tree.filter((s) => s.tag === 'th' && s.attributes?.scope === 'col');
    expect(headers).toHaveLength(5);
    for (const header of headers) {
      const children = header.children as ElementSpec[];
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ tag: 'button', attributes: { type: 'button' } });
      expect(children[0].action?.kind).toBe('sort');
    }
    expect(headers.filter((h) => h.attributes?.['aria-sort'] !== undefined).map((h) => h.attributes?.['aria-sort'])).toEqual(['ascending']);
    expect(textOf(headers[0])).toBe('Entidad');

    const sortedByDrafts = all(render(ready(ROWS, { sort: { column: 'pendingDrafts', direction: 'descending' } })));
    const sortedHeaders = sortedByDrafts.filter((s) => s.tag === 'th' && s.attributes?.['aria-sort']);
    expect(sortedHeaders.map((h) => [textOf(h), h.attributes?.['aria-sort']])).toEqual([['Borradores por revisar', 'descending']]);
    const firstRowHeader = sortedByDrafts.find((s) => s.tag === 'th' && s.attributes?.scope === 'row');
    expect(textOf(firstRowHeader!)).toContain('Abarrotes La Esperanza');
  });

  it('each active row is headed by th scope=row holding a link to the entity view', () => {
    const rowHeaders = tree.filter((s) => s.tag === 'th' && s.attributes?.scope === 'row');
    expect(rowHeaders).toHaveLength(3);
    for (const i of [0, 2]) {
      expect(ROWS[i].isActive).toBe(true);
      expect(rowHeaders[i].children).toEqual([{ tag: 'a', attributes: { href: `#/entity/${ROWS[i].entityId}` }, children: ROWS[i].name }]);
    }
  });

  it('an inactive row is shown with its tag, and its name is text, not a link into a view that cannot load', () => {
    const rowHeaders = tree.filter((s) => s.tag === 'th' && s.attributes?.scope === 'row');
    expect(ROWS[1].isActive).toBe(false);
    const inactive = rowHeaders[1];
    expect(all([inactive]).filter((s) => s.tag === 'a')).toEqual([]);
    expect(tree.filter((s) => s.tag === 'a').map((s) => s.attributes?.href)).not.toContain(`#/entity/${B}`);
    expect(inactive.children).toEqual([
      { tag: 'span', attributes: {}, children: 'Birria Don Chuy' },
      { tag: 'span', attributes: { class: 'tag' }, children: 'inactiva' },
    ]);
  });

  it('nothing has a positive tabindex, and every button and link has text', () => {
    for (const spec of tree) {
      const tabindex = spec.attributes?.tabindex;
      if (tabindex !== undefined) expect(Number(tabindex)).toBeLessThanOrEqual(0);
      if (spec.tag === 'button' || spec.tag === 'a') expect(textOf(spec).trim()).not.toBe('');
    }
  });

  it('a tone never stands alone: every toned cell carries its number or status as text', () => {
    const toned = tree.filter((s) => /\btone-/.test(s.attributes?.class ?? '') && s.attributes?.['aria-hidden'] !== 'true');
    expect(toned.length).toBeGreaterThan(0);
    for (const cell of toned) expect(textOf(cell).trim(), JSON.stringify(cell)).not.toBe('');

    const cells = tree.filter((s) => s.tag === 'td');
    expect(cells.map((c) => [textOf(c), c.attributes?.class])).toEqual([
      ['September 2026 · abierto', 'tone tone-info'],
      ['1', 'count tone tone-pending'],
      ['3', 'count tone tone-pending'],
      ['0', 'count tone tone-neutral'],
      ['sin calendario', 'tone tone-neutral'],
      ['0', 'count tone tone-neutral'],
      ['0', 'count tone tone-neutral'],
      ['0', 'count tone tone-neutral'],
      ['August 2026 · cierre definitivo', 'tone tone-balanced'],
      ['0', 'count tone tone-neutral'],
      ['0', 'count tone tone-neutral'],
      ['0', 'count tone tone-neutral'],
    ]);
    // The legend's swatches are decoration beside their own sentence.
    for (const swatch of tree.filter((s) => /\bswatch\b/.test(s.attributes?.class ?? ''))) {
      expect(swatch.attributes?.['aria-hidden']).toBe('true');
    }
  });

  it('the header shows the server date, when the rows were read and how long ago, and the two actions', () => {
    const texts = tree.filter((s) => s.tag === 'p').map(textOf);
    expect(texts).toContain('Fecha del servidor 2026-09-15');
    const age = tree.find((s) => s.attributes?.id === AGE_ELEMENT_ID);
    expect(textOf(age!)).toMatch(/^Leído a las \d\d:\d\d, hace 5 min$/);
    expect(tree.filter((s) => s.action).map((s) => s.action?.kind)).toEqual(['refresh', 'sign-out', 'sort', 'sort', 'sort', 'sort', 'sort']);
    expect(texts).toContain('La preparación para el cierre no se evalúa en esta pantalla.');
  });

  it('speaks English when asked, with the same structure', () => {
    const english = all(render(ready(ROWS), 'en'));
    expect(english.map((s) => s.tag)).toEqual(tree.map((s) => s.tag));
    expect(textOf(english.find((s) => s.tag === 'caption')!)).toBe('Entities you can read, their current period and the work waiting on a person');
  });
});

describe('the portfolio notices', () => {
  const roleOf = (screen: Screen, needle: string): string | undefined =>
    all(render(screen)).find((s) => s.attributes?.role && textOf(s).includes(needle))?.attributes?.role;

  it('loading, signed out and no access are status; errors, stale rows and an empty portfolio are alerts', () => {
    const sort = { column: 'name', direction: 'ascending' } as const;
    expect(roleOf({ kind: 'portfolio', loading: true, sort }, 'Leyendo la cartera')).toBe('status');
    expect(roleOf({ kind: 'portfolio', loading: false, sort, failure: { reason: 'signed-out', at: NOW } }, 'No has iniciado sesión')).toBe('status');
    expect(roleOf({ kind: 'portfolio', loading: false, sort, failure: { reason: 'no-access', at: NOW } }, 'accounts:read')).toBe('status');
    expect(roleOf({ kind: 'portfolio', loading: false, sort, failure: { reason: 'unavailable', at: NOW } }, 'La API no responde')).toBe('alert');
    expect(roleOf({ kind: 'portfolio', loading: false, sort, failure: { reason: 'session-expired', at: NOW } }, 'Tu sesión terminó')).toBe('alert');
    expect(roleOf(ready([]), 'no concede ninguna entidad')).toBe('alert');
  });

  it('signed out offers the sign-in link and no action that needs a session', () => {
    const tree = all(render({ kind: 'portfolio', loading: false, sort: { column: 'name', direction: 'ascending' }, failure: { reason: 'signed-out', at: NOW } }));
    expect(tree.find((s) => s.tag === 'a')?.attributes?.href).toBe('/auth/login');
    expect(tree.filter((s) => s.action)).toEqual([]);
    expect(tree.some((s) => s.tag === 'table')).toBe(false);
  });

  it('a failed refresh keeps the last good rows and says when they went stale', () => {
    const at = NOW - 60_000;
    const tree = all(render(ready(ROWS, { failure: { reason: 'unavailable', at } })));
    expect(tree.filter((s) => s.tag === 'th' && s.attributes?.scope === 'row')).toHaveLength(3);
    const stale = tree.find((s) => s.attributes?.role === 'alert');
    expect(textOf(stale!)).toMatch(/^La actualización de las \d\d:\d\d falló: estas cifras son de la última lectura buena\. La API no responde en este momento\.$/);
  });

  it('a signed-out refresh does not keep showing figures', () => {
    const tree = all(render(ready(ROWS, { failure: { reason: 'session-expired', at: NOW } })));
    expect(tree.some((s) => s.tag === 'table')).toBe(false);
  });

  it('token ids that produced no row are counted', () => {
    const screen = ready(ROWS);
    screen.loaded!.portfolio.meta.unresolved = 2;
    expect(all(render(screen)).map(textOf)).toContain('Ids de entidad de tu token que no dieron fila: 2');
  });
});

describe('signing out', () => {
  const ORIGIN = 'https://board.example';

  it('follows only a sign-out the gateway confirmed, and only to an http(s) destination', () => {
    expect(signOutDestination('https://idp.example/logout?client_id=board', ORIGIN)).toBe('https://idp.example/logout?client_id=board');
    expect(signOutDestination('/', ORIGIN)).toBe('https://board.example/');
    expect(signOutDestination('javascript:alert(1)', ORIGIN)).toBe('/');
    // No confirmation (a refused CSRF check, a network failure, a 5xx): the
    // session may still be open, so the page must not go anywhere.
    expect(signOutDestination(undefined, ORIGIN)).toBeUndefined();
  });

  it('an unconfirmed sign-out says the session may still be open, and keeps the button to try again', () => {
    const screens: Screen[] = [ready(ROWS), { kind: 'not-found' }];
    for (const screen of screens) {
      const tree = all(renderScreen(screen, 'es', NOW, { signOutFailed: true }));
      const alerts = tree.filter((s) => s.attributes?.role === 'alert').map(textOf);
      expect(alerts).toContain(text('es', 'web.session.sign_out_failed'));
      expect(tree.find((s) => s.attributes?.id === 'sign-out')?.action).toEqual({ kind: 'sign-out' });
    }
    expect(text('es', 'web.session.sign_out_failed')).toMatch(/sesión/);
    expect(all(render(ready(ROWS))).map(textOf)).not.toContain(text('es', 'web.session.sign_out_failed'));
  });
});

describe('third-party strings stay text', () => {
  it('an XSS payload in an entity name is a string child, never structure', () => {
    const tree = all(render(ready([row(A, XSS)])));
    const link = tree.find((s) => s.tag === 'a' && s.attributes?.href === `#/entity/${A}`);
    expect(link?.children).toBe(XSS);
    expect(tree.some((s) => (s.tag as string) === 'img' || (s.tag as string) === 'script')).toBe(false);
  });
});

describe('the entity view', () => {
  const drafts: DraftItem[] = [{ id: 'd1', entryDate: '2026-09-10', description: XSS, confidence: '0.82' }];
  const questions: QuestionItem[] = [{ id: 'q1', question: '¿Se capitaliza la laptop?', topic: 'activo fijo', createdAt: '2026-09-11' }];
  const periods: PeriodItem[] = [{ id: 'p1', name: 'September 2026', status: 'soft_close', startDate: '2026-09-01', endDate: '2026-09-30' }];
  const screen: EntityScreen = { kind: 'entity', entityId: A, entityName: 'Abarrotes La Esperanza', loading: false, loaded: { drafts, questions, periods } };
  const tree = all(render(screen));

  it('shows the three lists as captioned tables, a way back, and what it does not evaluate', () => {
    expect(tree.filter((s) => s.tag === 'caption').map(textOf)).toEqual(['Borradores por revisar', 'Preguntas pendientes', 'Periodos fiscales']);
    expect(tree.find((s) => s.tag === 'a')?.attributes?.href).toBe('#/');
    expect(tree.find((s) => s.tag === 'h2') && textOf(tree.find((s) => s.tag === 'h2')!)).toBe('Abarrotes La Esperanza');
    expect(tree.map(textOf)).toContain('La preparación para el cierre no se evalúa en esta pantalla.');
    expect(tree.filter((s) => s.tag === 'td').map(textOf)).toContain('cierre blando');
    expect(tree.filter((s) => s.tag === 'td').map((s) => s.children)).toContain(XSS);
  });

  it('prints the read-only CLI commands that list the same things, with the entity id and untranslated', () => {
    const commands = tree.filter((s) => s.tag === 'code').map(textOf);
    expect(commands).toEqual(VERIFY_COMMANDS.map((c) => c.replace('{entity}', A)));
    expect(commands).toEqual([
      `mnemosine drafts -e ${A} --status pending_review`,
      `mnemosine question list -e ${A}`,
      `mnemosine period list -e ${A}`,
    ]);
    const english = all(render(screen, 'en')).filter((s) => s.tag === 'code').map(textOf);
    expect(english).toEqual(commands);
  });

  it('an empty list says so instead of drawing an empty table', () => {
    const empty = all(render({ ...screen, loaded: { drafts: [], questions, periods } }));
    expect(empty.filter((s) => s.tag === 'table')).toHaveLength(2);
    expect(empty.map(textOf)).toContain('Ninguno.');
  });

  it('while loading, and after a failure, it says which', () => {
    expect(all(render({ kind: 'entity', entityId: A, loading: true })).find((s) => s.attributes?.role === 'status')).toBeDefined();
    const denied = all(render({ kind: 'entity', entityId: A, loading: false, failure: 'no-access' }));
    expect(denied.find((s) => s.attributes?.role === 'status') && textOf(denied.find((s) => s.attributes?.role === 'status')!)).toContain('accounts:read');
    expect(denied.find((s) => s.tag === 'h2')?.children).toBe(A);
  });

  it('an entity the token does not grant is told apart from missing permissions', () => {
    const notGranted = all(render({ kind: 'entity', entityId: A, loading: false, failure: 'entity-not-granted' }));
    const notice = notGranted.find((s) => s.attributes?.role === 'status');
    expect(textOf(notice!)).toBe('Tu token no concede esta entidad: sus listas no se pueden leer aquí.');
    expect(notGranted.map(textOf)).not.toContain(text('es', 'web.session.no_access'));
    expect(notGranted.some((s) => s.tag === 'table')).toBe(false);
    // Still signed in: the way back and the sign-out button stay.
    expect(notGranted.find((s) => s.tag === 'a')?.attributes?.href).toBe('#/');
    expect(notGranted.find((s) => s.attributes?.id === 'sign-out')?.action).toEqual({ kind: 'sign-out' });

    const english = all(render({ kind: 'entity', entityId: A, loading: false, failure: 'entity-not-granted' }, 'en'));
    expect(textOf(english.find((s) => s.attributes?.role === 'status')!)).toBe(
      'Your token does not grant this entity, so its lists cannot be read here.'
    );
    expect(text('es', 'web.entity.not_granted')).not.toBe(text('en', 'web.entity.not_granted'));
  });
});

describe('routes', () => {
  it('reads the hash, and ignores a hash that is not a route', () => {
    expect(parseRoute('')).toEqual({ kind: 'portfolio' });
    expect(parseRoute('#/')).toEqual({ kind: 'portfolio' });
    expect(parseRoute(`#/entity/${A}`)).toEqual({ kind: 'entity', entityId: A });
    expect(parseRoute('#/entity/not-a-uuid')).toEqual({ kind: 'not-found' });
    expect(parseRoute(`#/entity/${A}/extra`)).toEqual({ kind: 'not-found' });
    expect(parseRoute('#/signin-failed')).toEqual({ kind: 'signin-failed' });
    expect(parseRoute('#/nope')).toEqual({ kind: 'not-found' });
    expect(parseRoute('#app')).toBeUndefined();
  });

  it('the sign-in failure and an unknown route render alerts', () => {
    expect(all(render({ kind: 'signin-failed' })).find((s) => s.attributes?.role === 'alert')).toBeDefined();
    expect(all(render({ kind: 'not-found' })).find((s) => s.attributes?.role === 'alert')).toBeDefined();
  });
});

// ---- dom.ts, against a fake document ------------------------------------

class FakeElement implements MountElement<FakeElement> {
  textContent: string | null = null;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners: Array<() => void> = [];
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }
  addEventListener(_type: 'click', listener: () => void): void {
    this.listeners.push(listener);
  }
  set innerHTML(_value: string) {
    throw new Error('dom.ts touched innerHTML');
  }
  set outerHTML(_value: string) {
    throw new Error('dom.ts touched outerHTML');
  }
}

function fakeDocument() {
  const created: FakeElement[] = [];
  return {
    created,
    createElement(tagName: string): FakeElement {
      const element = new FakeElement(tagName);
      created.push(element);
      return element;
    },
  };
}

function flatten(node: FakeElement): FakeElement[] {
  return [node, ...node.children.flatMap(flatten)];
}

describe('dom.ts', () => {
  it('builds the screen with elements, attributes and text nodes only', () => {
    const doc = fakeDocument();
    const root = new FakeElement('main');
    mount(render(ready([row(A, XSS)])), root, doc, () => undefined);
    const nodes = flatten(root).slice(1);
    expect(nodes.length).toBe(doc.created.length);
    expect(doc.created.map((n) => n.tagName)).not.toContain('img');
    expect(doc.created.map((n) => n.tagName)).not.toContain('script');
    const link = nodes.find((n) => n.attributes.get('href') === `#/entity/${A}`);
    expect(link?.textContent).toBe(XSS);
    expect(link?.children).toEqual([]);
  });

  it('replaces what the root held, and a click on a button reports its action', () => {
    const doc = fakeDocument();
    const root = new FakeElement('main');
    root.appendChild(new FakeElement('p'));
    const actions: ViewAction[] = [];
    mount(render(ready(ROWS)), root, doc, (action) => actions.push(action));
    expect(root.children.map((n) => n.tagName)).toEqual(['header', 'div']);
    const refresh = flatten(root).find((n) => n.attributes.get('id') === 'refresh');
    refresh?.listeners.forEach((listener) => listener());
    const sortByDrafts = flatten(root).find((n) => n.attributes.get('id') === 'sort-pendingDrafts');
    sortByDrafts?.listeners.forEach((listener) => listener());
    expect(actions).toEqual([{ kind: 'refresh' }, { kind: 'sort', column: 'pendingDrafts' }]);
  });

  it('refuses a javascript: or external href, an event handler, a style, and an element it does not build', () => {
    const doc = fakeDocument();
    const root = new FakeElement('main');
    const attempt = (spec: ElementSpec) => () => mount([spec], root, doc, () => undefined);
    expect(attempt({ tag: 'a', attributes: { href: 'javascript:alert(1)' }, children: 'x' })).toThrow(RejectedAttribute);
    expect(attempt({ tag: 'a', attributes: { href: 'https://evil.example/' }, children: 'x' })).toThrow(RejectedAttribute);
    expect(attempt({ tag: 'a', attributes: { href: '//evil.example/' }, children: 'x' })).toThrow(RejectedAttribute);
    expect(attempt({ tag: 'a', attributes: { href: '/v1/accounts' }, children: 'x' })).toThrow(RejectedAttribute);
    expect(attempt({ tag: 'button', attributes: { onclick: 'alert(1)' }, children: 'x' })).toThrow(RejectedAttribute);
    expect(attempt({ tag: 'div', attributes: { style: 'background:url(x)' } })).toThrow(RejectedAttribute);
    expect(attempt({ tag: 'button', attributes: { type: 'submit' }, children: 'x' })).toThrow(RejectedAttribute);
    expect(attempt({ tag: 'div', attributes: { tabindex: '3' } })).toThrow(RejectedAttribute);
    expect(attempt({ tag: 'script' as ViewTag, children: 'alert(1)' })).toThrow(/not allowed/);
    expect(attempt({ tag: 'div', children: 'x', action: { kind: 'refresh' } })).toThrow(/only a button/);
  });

  it('the skip link moves focus to the content without navigating, so it leaves no history entry the router ignores', () => {
    const listeners: Array<(event: { preventDefault(): void }) => void> = [];
    const link = {
      addEventListener(_type: 'click', listener: (event: { preventDefault(): void }) => void): void {
        listeners.push(listener);
      },
    };
    let focused = 0;
    skipWithoutNavigating(link, { focus: () => (focused += 1) });
    expect(listeners).toHaveLength(1);
    let prevented = false;
    listeners[0]({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(focused).toBe(1);
  });

  it('allows the attributes the view uses', () => {
    expect(isAllowedAttribute('href', '#/')).toBe(true);
    expect(isAllowedAttribute('href', `#/entity/${A}`)).toBe(true);
    expect(isAllowedAttribute('href', '/auth/login')).toBe(true);
    expect(isAllowedAttribute('aria-sort', 'ascending')).toBe(true);
    expect(isAllowedAttribute('tabindex', '0')).toBe(true);
    expect(isAllowedAttribute('srcdoc', 'x')).toBe(false);
    expect(isAllowedAttribute('formaction', '/v1/x')).toBe(false);
  });
});
