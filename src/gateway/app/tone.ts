// ============================================================
// THE TRAFFIC LIGHT, AS PRESENTATION ONLY (W1 · issue #117)
//
// A tone restates a fact the row already carries; it never classifies. So:
//
//   · a count above zero is pending (amber), and zero is neutral. Zero is not
//     evidence that anything is balanced, so it is never green;
//   · a current period that is open or soft closed is info (blue), one that is
//     hard closed or locked is balanced (green), and no period, a future one
//     or a status this table does not know is neutral. An entity with no
//     calendar is never green.
//
// Red (--status-blocked) is minted in the house tokens and unused here: no
// column of the portfolio carries a blocked or unbalanced classification, and
// inventing one would be an accounting criterion made in CSS. Every toned cell
// also shows its number or status as text, so colour is never the only signal
// (WCAG 1.4.1); tests/gateway/web-view.spec.ts holds the view to that.
//
// DOM-free: the unit specs import it.
// ============================================================

export type Tone = 'info' | 'balanced' | 'pending' | 'neutral';

export function toneOfCount(count: number): Tone {
  return count > 0 ? 'pending' : 'neutral';
}

export function toneOfPeriodStatus(status: string | null): Tone {
  switch (status) {
    case 'open':
    case 'soft_close':
      return 'info';
    case 'hard_close':
    case 'locked':
      return 'balanced';
    default:
      return 'neutral';
  }
}
