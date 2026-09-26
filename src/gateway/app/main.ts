import { apiGet, signOut } from './api.js';
import { createBoard } from './board.js';
import { mount, skipWithoutNavigating } from './dom.js';
import { pickLanguage, text } from './messages.js';
import { AGE_ELEMENT_ID, ageText, parseRoute, renderScreen, type ViewAction } from './view.js';

// ============================================================
// THE BOARD'S BOOT (W1 · issue #117)
//
// Picks the language, runs the hash router and wires the page to board.ts,
// which holds the state and decides what each click and each answer does.
// This file only touches the document:
//
//   · Refresh is manual. A 30-second ticker only rewrites the "read N min
//     ago" line in place, so focus and the screen reader's position survive.
//   · After a re-render, focus goes back to the control that had it (a sort
//     button keeps focus after sorting), and a route change moves focus to the
//     main element, so a screen reader starts at the new screen.
//   · The skip link focuses the main element without touching the URL.
// ============================================================

const language = pickLanguage(navigator.languages.length > 0 ? navigator.languages : [navigator.language]);
document.documentElement.lang = language;
document.title = text(language, 'web.app.title');

const skipLink = document.getElementById('skip-link');
if (skipLink) skipLink.textContent = text(language, 'web.app.skip_to_content');

const root = document.getElementById('app');
if (skipLink && root) skipWithoutNavigating(skipLink, root);

function onAction(action: ViewAction): void {
  void board.act(action);
}

const board = createBoard({
  read: apiGet,
  signOut,
  leave: (destination) => window.location.assign(destination),
  origin: window.location.origin,
  now: () => Date.now(),
  render: (screen, page, moveFocus) => {
    if (!root) return;
    const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
    mount(renderScreen(screen, language, Date.now(), page), root, document, onAction);
    if (moveFocus) {
      root.focus();
      return;
    }
    if (focusedId !== '') document.getElementById(focusedId)?.focus();
  },
});

window.addEventListener('hashchange', () => {
  const route = parseRoute(window.location.hash);
  if (route) void board.show(route);
});

setInterval(() => {
  const screen = board.current();
  if (screen.kind !== 'portfolio' || !screen.loaded) return;
  const age = document.getElementById(AGE_ELEMENT_ID);
  if (age) age.textContent = ageText(language, screen.loaded.fetchedAt, Date.now());
}, 30_000);

void board.show(parseRoute(window.location.hash) ?? { kind: 'portfolio' }, false);
