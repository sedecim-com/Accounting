import { SIGN_IN_PATH } from './contract.js';
import type { ElementSpec, ViewAction, ViewTag } from './view.js';

// ============================================================
// FROM THE VIEW TREE TO NODES, WITH NO MARKUP ANYWHERE (W1 · issue #117)
//
// The one place the browser program builds the page. It creates elements by
// tag, writes text only through textContent, and sets attributes only from an
// allow-list, so a string that came from a third party (an entity name, a
// draft description, a question) becomes a text node and nothing else. There
// is no HTML parser on this path to trick: no innerHTML, no template, no
// event-handler attribute. Criterion web-client-cannot-inject-markup bans the
// sinks in every served module, the eslint browser block bans them at the
// keyboard, and the CSP's Trusted Types make them throw in browsers that
// enforce it.
//
// The document is a parameter, typed by the few members used here, and not
// the global: this module compiles without the DOM library, so the unit specs
// run it against a small fake document. Only main.ts passes the real one.
// ============================================================

/** The members of an element this module uses. `N` is the node type of the document at hand. */
export interface MountElement<N> {
  textContent: string | null;
  setAttribute(qualifiedName: string, value: string): void;
  appendChild(node: N): unknown;
  replaceChildren(...nodes: N[]): void;
  addEventListener(type: 'click', listener: () => void): void;
}

export interface MountDocument<N extends MountElement<N>> {
  createElement(tagName: string): N;
}

const ALLOWED_TAGS: ReadonlySet<string> = new Set<ViewTag>([
  'a',
  'button',
  'caption',
  'code',
  'div',
  'h1',
  'h2',
  'h3',
  'header',
  'li',
  'nav',
  'p',
  'section',
  'span',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Attributes whose value is free text. Nothing here can load, run or style anything. */
const TEXT_ATTRIBUTES: ReadonlySet<string> = new Set(['class', 'id', 'scope', 'lang', 'role']);

/** An in-page route, or the gateway's sign-in route: no scheme, no host, no other path. */
const SAFE_HREF = /^#\/[A-Za-z0-9/_-]*$/;

export class RejectedAttribute extends Error {
  constructor(name: string) {
    super(`attribute ${name} is not allowed by dom.ts`);
    this.name = 'RejectedAttribute';
  }
}

/** True when `name="value"` may be set on an element built here. */
export function isAllowedAttribute(name: string, value: string): boolean {
  if (TEXT_ATTRIBUTES.has(name)) return true;
  if (name === 'href') return SAFE_HREF.test(value) || value === SIGN_IN_PATH;
  if (name === 'type') return value === 'button';
  if (name === 'tabindex') return value === '0' || value === '-1';
  return /^aria-[a-z]+$/.test(name);
}

function build<N extends MountElement<N>>(spec: ElementSpec, doc: MountDocument<N>, onAction: (action: ViewAction) => void): N {
  if (!ALLOWED_TAGS.has(spec.tag)) throw new Error(`element ${spec.tag} is not allowed by dom.ts`);
  const node = doc.createElement(spec.tag);
  for (const [name, value] of Object.entries(spec.attributes ?? {})) {
    if (!isAllowedAttribute(name, value)) throw new RejectedAttribute(name);
    node.setAttribute(name, value);
  }
  const child = spec.children;
  if (typeof child === 'string') {
    node.textContent = child;
  } else if (child) {
    for (const nested of child) node.appendChild(build(nested, doc, onAction));
  }
  const { action } = spec;
  if (action) {
    if (spec.tag !== 'button') throw new Error('only a button carries an action');
    node.addEventListener('click', () => onAction(action));
  }
  return node;
}

/** The skip link and what it skips to, typed by the members used here. */
export interface SkipLink {
  addEventListener(type: 'click', listener: (event: { preventDefault(): void }) => void): void;
}

export interface FocusTarget {
  focus(): void;
}

/**
 * Makes the skip link move focus to `target` without navigating.
 *
 * The page routes on the location hash, so following href="#app" would push a
 * history entry the router does not treat as a screen, and the next Back
 * would seem to do nothing, to exactly the keyboard users the link is for.
 * The link keeps its href, so it is still announced as a link to the content;
 * a click, or Enter on it, focuses the target and leaves the URL alone.
 */
export function skipWithoutNavigating(link: SkipLink, target: FocusTarget): void {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    target.focus();
  });
}

/** Replaces the children of `root` with the nodes of `specs`. */
export function mount<N extends MountElement<N>>(
  specs: readonly ElementSpec[],
  root: N,
  doc: MountDocument<N>,
  onAction: (action: ViewAction) => void
): void {
  const nodes = specs.map((spec) => build(spec, doc, onAction));
  root.replaceChildren(...nodes);
}
