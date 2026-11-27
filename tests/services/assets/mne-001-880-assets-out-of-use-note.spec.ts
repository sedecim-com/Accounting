import { describe, it, expect } from 'vitest';
import { assetsOutOfUseNote } from '../../../src/services/assets/depreciation.js';

/**
 * MNE-001-880 (#1069), part 2 · what the close box says of the assets that
 * are not in use. Texts written by hand.
 */
describe('assetsOutOfUseNote', () => {
  const asset = (n: number, status: string) => ({ asset_number: `AF-2026-0000${n}`, status });

  it('says nothing when every asset is in use', () => {
    expect(assetsOutOfUseNote([])).toBeNull();
  });

  it('names the assets by state: retired first, then fully depreciated, then disposed', () => {
    expect(assetsOutOfUseNote([asset(1, 'disposed'), asset(2, 'inactive'), asset(3, 'fully_depreciated'), asset(4, 'inactive')])).toBe(
      '2 asset(s) retired (inactive), not depreciated: AF-2026-00002, AF-2026-00004; ' +
        '1 asset(s) fully depreciated: AF-2026-00003; 1 asset(s) disposed: AF-2026-00001'
    );
  });

  it('names five and counts the rest', () => {
    expect(assetsOutOfUseNote([1, 2, 3, 4, 5, 6, 7].map((n) => asset(n, 'inactive')))).toBe(
      '7 asset(s) retired (inactive), not depreciated: AF-2026-00001, AF-2026-00002, AF-2026-00003, AF-2026-00004, ' +
        'AF-2026-00005 (+2 more)'
    );
  });
});
