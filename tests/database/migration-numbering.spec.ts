import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertNumeracionUnica } from '../../src/database/migrate.js';

const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');

describe('numeración de migraciones', () => {
  it('el árbol actual pasa la guarda (los cuatro duplicados históricos se toleran)', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(() => assertNumeracionUnica(files)).not.toThrow();
  });

  it('rechaza un duplicado nuevo y dice cuál es el siguiente número libre', () => {
    const files = ['001_a.sql', '030_b.sql', '031_c.sql', '031_d.sql'];
    expect(() => assertNumeracionUnica(files)).toThrow(/031: 031_c\.sql, 031_d\.sql/);
    expect(() => assertNumeracionUnica(files)).toThrow(/siguiente libre es 032/);
  });

  it('tolera exactamente los cuatro duplicados históricos', () => {
    const files = ['012_a.sql', '012_b.sql', '014_a.sql', '014_b.sql',
                   '015_a.sql', '015_b.sql', '018_a.sql', '018_b.sql'];
    expect(() => assertNumeracionUnica(files)).not.toThrow();
  });

  it('rechaza un archivo sin prefijo numérico', () => {
    expect(() => assertNumeracionUnica(['fix_algo.sql'])).toThrow(/sin prefijo numérico/);
  });
});
