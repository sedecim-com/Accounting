import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { columnasCalificadas, escanearArchivo } from '../integration/helpers/sql-scan.js';

// ============================================================
// El escáner es la guarda que impide que una consulta nombre una columna que
// el esquema no tiene. Tenía un punto ciego declarado: sólo miraba SELECTs de
// UNA tabla sin alias ni JOIN. Dentro de ese punto ciego vivía
// `p.futa_employer` en el generador de la forma 940 — cinco referencias a una
// columna inexistente, con el contrato de esquema en verde, y la forma
// reventando en su primera invocación.
//
// La generalización que lo cierra: un alias ATA la columna a su tabla, así que
// `p.futa` es resoluble aunque la consulta tenga cuatro JOINs. Estas pruebas
// corren sin base de datos porque prueban la resolución, no el esquema.
// ============================================================

const sinCtes = new Set<string>();

/** Lo que devuelve el extractor, como mapa tabla → columnas, para aserciones. */
function mapa(sql: string, ctes = sinCtes): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of columnasCalificadas(sql, ctes)) out[r.tabla] = r.columnas.sort();
  return out;
}

describe('columnasCalificadas — el caso que dejó pasar la forma 940', () => {
  it('resuelve una columna por su alias AUNQUE la consulta tenga JOIN', () => {
    const sql = `SELECT COALESCE(SUM(p.futa), 0) AS futa_tax
                 FROM paychecks p
                 JOIN pay_periods pp ON pp.id = p.pay_period_id
                 WHERE pp.entity_id = $1`;
    expect(mapa(sql)).toEqual({
      paychecks: ['futa', 'pay_period_id'],
      pay_periods: ['entity_id', 'id'],
    });
  });

  it('habría delatado futa_employer, que no existe en paychecks', () => {
    const sql = `SELECT SUM(p.futa_employer) FROM paychecks p JOIN pay_periods pp ON pp.id = p.pay_period_id`;
    expect(mapa(sql).paychecks).toContain('futa_employer');
  });

  it('acepta el alias con AS explícito', () => {
    expect(mapa('SELECT a.code FROM accounts AS a')).toEqual({ accounts: ['code'] });
  });

  it('resuelve también una calificación por el nombre de la tabla', () => {
    expect(mapa('SELECT accounts.code FROM accounts')).toEqual({ accounts: ['code'] });
  });

  it('acumula las columnas de una misma tabla en un solo registro', () => {
    const sql = `SELECT p.futa, p.suta, p.net_pay FROM paychecks p`;
    expect(mapa(sql).paychecks).toEqual(['futa', 'net_pay', 'suta']);
  });
});

describe('lo que NO debe afirmar', () => {
  it('ignora el esquema: public no es un alias', () => {
    expect(mapa('SELECT public.users.email FROM public.users')).not.toHaveProperty('public');
  });

  it('descarta un CTE, cuya forma la define la consulta y no el esquema', () => {
    const sql = `WITH reciente AS (SELECT id FROM invoices)
                 SELECT reciente.columna_inventada FROM reciente`;
    expect(mapa(sql, new Set(['reciente']))).not.toHaveProperty('reciente');
  });

  it('ignora un calificador que no corresponde a ninguna fuente declarada', () => {
    // Sin FROM que lo declare, `x.y` no se puede atribuir a nada.
    expect(mapa('SELECT x.y FROM accounts a')).not.toHaveProperty('x');
  });

  it('no confunde una palabra reservada tras el punto con una columna', () => {
    const sql = `SELECT a.code FROM accounts a ORDER BY a.code`;
    expect(mapa(sql).accounts).toEqual(['code']);
  });

  it('devuelve vacío cuando la consulta no declara ninguna fuente', () => {
    expect(mapa('SELECT 1')).toEqual({});
  });
});

describe('las formas que aparecen en el repositorio', () => {
  it('resuelve el UPDATE con alias', () => {
    expect(mapa('UPDATE invoices i SET i.status = $1')).toEqual({ invoices: ['status'] });
  });

  it('resuelve varias fuentes en la misma consulta, cada una a su tabla', () => {
    const sql = `SELECT jel.debit_amount, je.status, a.normal_balance
                 FROM journal_entry_lines jel
                 JOIN journal_entries je ON je.id = jel.journal_entry_id
                 JOIN accounts a ON a.id = jel.account_id`;
    const m = mapa(sql);
    expect(m.journal_entry_lines).toContain('debit_amount');
    expect(m.journal_entries).toContain('status');
    expect(m.accounts).toContain('normal_balance');
    // Y no mezcla: `status` pertenece al asiento, no a la cuenta.
    expect(m.accounts).not.toContain('status');
  });
});

// MNE-001-659: `FOR NO KEY UPDATE OF pay_periods` was read as an UPDATE of a
// table named «of». The scanner already knew `FOR UPDATE OF`; the other lock
// strength that carries the word is the same clause, not a statement.
describe('a row lock clause is not an UPDATE statement', () => {
  const locked = (clause: string) =>
    `SELECT pp.tax_year FROM pay_periods pp WHERE pp.id = $1 AND pp.tenant_id = $2\n          ${clause} OF pp`;

  /** The tables the scanner reports for a source file holding one SQL literal. */
  function tablesOf(sql: string): string[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-scan-'));
    const file = path.join(dir, 'source.ts');
    fs.writeFileSync(file, `export const sql = \`${sql}\`;\n`);
    try {
      return escanearArchivo(file).tablas.map((t) => t.tabla);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each(['FOR UPDATE', 'FOR NO KEY UPDATE', 'FOR NO  KEY\n UPDATE'])('%s OF <alias> names no table', (clause) => {
    expect(tablesOf(locked(clause))).toEqual(['pay_periods']);
    expect(mapa(locked(clause))).toEqual({ pay_periods: ['id', 'tax_year', 'tenant_id'] });
  });

  it('FOR NO KEY UPDATE OF <table>, with no alias, leaves the table to be checked', () => {
    const sql = 'SELECT tax_year FROM pay_periods WHERE id = $1\n FOR NO KEY UPDATE OF pay_periods';
    expect(tablesOf(sql)).toEqual(['pay_periods']);
  });

  it('an UPDATE statement is still read, also after a lock clause in the same literal', () => {
    expect(tablesOf('UPDATE no_such_table SET a = 1')).toEqual(['no_such_table']);
    expect(mapa('UPDATE invoices i SET i.status = $1')).toEqual({ invoices: ['status'] });
  });
});
