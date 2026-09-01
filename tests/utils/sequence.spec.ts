import { describe, it, expect } from 'vitest';
import { clienteFalso } from '../helpers/fake-pg.js';
import { ID } from '../helpers/entidades.js';
import {
  nextEntityNumber,
  formatDocumentNumber,
  generateEntryNumber,
  añoDeDocumento,
} from '../../src/utils/sequence.js';

describe('nextEntityNumber · numeración atómica por ejercicio (R3)', () => {
  it('consume el contador ANUAL con un UPSERT que devuelve el nuevo valor', async () => {
    const cf = clienteFalso([
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '1' }] } },
    ]);
    const n = await nextEntityNumber(cf.client, ID.entidad, 'journal_entry', 'JE', '2026-03-15');

    const c = cf.coincidencias(/INSERT INTO entity_sequences/)[0];
    // ON CONFLICT ... DO UPDATE es lo que toma el candado de fila: sin él,
    // dos posteos simultáneos leerían el mismo valor.
    expect(c.sql).toMatch(/ON CONFLICT \(entity_id, name\)/);
    expect(c.sql).toMatch(/DO UPDATE SET value = entity_sequences\.value \+ 1/);
    expect(c.sql).toMatch(/RETURNING value/);
    // R3: la llave lleva el AÑO DEL DOCUMENTO — el contador es por ejercicio.
    expect(c.params).toEqual([ID.entidad, 'journal_entry_2026']);
    expect(n).toBe('JE-2026-00001');
  });

  it('el año lo fija la fecha del documento, no el reloj', async () => {
    const cf = clienteFalso([
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '43' }] } },
    ]);
    // Capturado «hoy» (cualquier año del reloj) con fecha de diciembre 2026:
    // sale en la serie 2026 — el defecto que la auditoría señaló era JE-2027
    // continuando la cuenta de 2026.
    const n = await nextEntityNumber(cf.client, ID.entidad, 'journal_entry', 'JE', '2026-12-31');
    expect(n).toBe('JE-2026-00043');
    expect(cf.coincidencias(/entity_sequences/)[0].params).toEqual([ID.entidad, 'journal_entry_2026']);
  });

  it('años distintos son contadores distintos', async () => {
    const cf = clienteFalso([
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '1' }] } },
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '1' }] } },
    ]);
    const a = await nextEntityNumber(cf.client, ID.entidad, 'invoice', 'INV', '2026-12-31');
    const b = await nextEntityNumber(cf.client, ID.entidad, 'invoice', 'INV', new Date(2027, 0, 2));
    expect(a).toBe('INV-2026-00001');
    expect(b).toBe('INV-2027-00001');
    expect(cf.consultas.map((c) => c.params?.[1])).toEqual(['invoice_2026', 'invoice_2027']);
  });

  it('corre sobre el cliente de la transacción del llamador, no abre otra', async () => {
    const cf = clienteFalso([
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '3' }] } },
    ]);
    await nextEntityNumber(cf.client, ID.entidad, 'bill', 'BILL', '2026-05-01');
    expect(cf.consultas).toHaveLength(1);
  });

  it('rellena a cinco dígitos y no se desborda en valores grandes', async () => {
    const cf = clienteFalso([
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '123456' }] } },
    ]);
    const n = await nextEntityNumber(cf.client, ID.entidad, 'journal_entry', 'JE', '2026-01-01');
    expect(n).toBe('JE-2026-123456');
  });
});

describe('añoDeDocumento', () => {
  it('lee el año de una cadena YYYY-MM-DD sin pasar por Date (el 31-dic no retrocede)', () => {
    // new Date('2026-12-31') es medianoche UTC: al oeste de Greenwich, el 30.
    expect(añoDeDocumento('2026-12-31')).toBe(2026);
    expect(añoDeDocumento('2026-01-01')).toBe(2026);
  });

  it('usa el año local de un Date, que es como se capturó', () => {
    expect(añoDeDocumento(new Date(2026, 11, 31))).toBe(2026);
  });

  it('una fecha ilegible truena en vez de foliar en el año que sea', () => {
    expect(() => añoDeDocumento('31/12/2026')).toThrow(/ilegible/);
    expect(() => añoDeDocumento('')).toThrow(/ilegible/);
  });
});

describe('formatDocumentNumber', () => {
  it('rellena a cinco dígitos con el año recibido', () => {
    expect(formatDocumentNumber('JE', 2026, 7)).toBe('JE-2026-00007');
  });

  it('generateEntryNumber sigue partiendo de un conteo y del reloj (uso no financiero)', () => {
    // Se conserva para clientes y proveedores; los documentos financieros
    // usan nextEntityNumber. Ver la nota de obsolescencia en sequence.ts.
    expect(generateEntryNumber('C', 0)).toMatch(/^C-\d{4}-00001$/);
  });
});
