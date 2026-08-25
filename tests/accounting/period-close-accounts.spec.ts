import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards the year-end sweep against the account it must NOT use.
 * In the seeded Mexican chart 3100 is "Capital Social" and 3200 is
 * "Resultado de Ejercicios Anteriores": closing the year's result into
 * 3100 would misstate equity and violate NIF C-11 (share capital only
 * moves by formal corporate acts). A static check is the right shape
 * here — the bug is a wrong constant, not wrong control flow.
 */
const SRC = path.join(__dirname, '..', '..', 'src');

describe('generateClosingEntries — cuentas del cierre anual', () => {
  const source = fs.readFileSync(path.join(SRC, 'services', 'accounting', 'period-close.ts'), 'utf-8');
  const query = source.slice(source.indexOf('const systemAccounts'), source.indexOf('const incomeSummaryId'));

  it('resolves retained earnings by code 3200, never 3100 (Capital Social)', () => {
    expect(query).toContain("'3200'");
    expect(query).not.toContain("'3100'");
    expect(source).toMatch(/retainedEarningsId = systemAccounts\.rows\.find\(\(a\) => a\.code === '3200'\)/);
  });

  it('resolves income summary by code 3900', () => {
    expect(source).toMatch(/incomeSummaryId = systemAccounts\.rows\.find\(\(a\) => a\.code === '3900'\)/);
  });

  it('the seeded chart of accounts still assigns those codes as expected', () => {
    const seed = fs.readFileSync(path.join(SRC, 'database', 'seed.ts'), 'utf-8');
    expect(seed).toMatch(/code: '3100', name: 'Capital Social'/);
    expect(seed).toMatch(/code: '3200', name: 'Resultado de Ejercicios Anteriores'/);
    expect(seed).toMatch(/code: '3900', name: 'Resumen de Ingresos y Gastos'/);
  });
});
