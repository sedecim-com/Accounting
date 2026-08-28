import { describe, it, expect } from 'vitest';
import { clienteFalso } from '../helpers/fake-pg.js';
import { ID } from '../helpers/entidades.js';
import { nextEntityNumber, formatDocumentNumber, generateEntryNumber } from '../../src/utils/sequence.js';

describe('nextEntityNumber · numeración atómica', () => {
  it('consume el contador con un UPSERT que devuelve el nuevo valor', async () => {
    const cf = clienteFalso([
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '1' }] } },
    ]);
    const n = await nextEntityNumber(cf.client, ID.entidad, 'journal_entry', 'JE');

    const c = cf.coincidencias(/INSERT INTO entity_sequences/)[0];
    // ON CONFLICT ... DO UPDATE es lo que toma el candado de fila: sin él,
    // dos posteos simultáneos leerían el mismo valor.
    expect(c.sql).toMatch(/ON CONFLICT \(entity_id, name\)/);
    expect(c.sql).toMatch(/DO UPDATE SET value = entity_sequences\.value \+ 1/);
    expect(c.sql).toMatch(/RETURNING value/);
    expect(c.params).toEqual([ID.entidad, 'journal_entry']);
    expect(n).toMatch(/^JE-\d{4}-00001$/);
  });

  it('el contador es por entidad Y por nombre de secuencia', async () => {
    const cf = clienteFalso([
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '5' }] } },
    ]);
    await nextEntityNumber(cf.client, ID.entidad, 'invoice', 'INV');
    expect(cf.coincidencias(/INSERT INTO entity_sequences/)[0].params).toEqual([ID.entidad, 'invoice']);
  });

  it('corre sobre el cliente de la transacción del llamador, no abre otra', async () => {
    const cf = clienteFalso([
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '3' }] } },
    ]);
    await nextEntityNumber(cf.client, ID.entidad, 'bill', 'BILL');
    // Todo el tráfico pasó por el cliente recibido.
    expect(cf.consultas).toHaveLength(1);
  });

  it('rellena a cinco dígitos y no se desborda en valores grandes', async () => {
    const cf = clienteFalso([
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '123456' }] } },
    ]);
    const n = await nextEntityNumber(cf.client, ID.entidad, 'journal_entry', 'JE');
    expect(n).toMatch(/^JE-\d{4}-123456$/);
  });
});

describe('formatDocumentNumber', () => {
  it('rellena a cinco dígitos', () => {
    expect(formatDocumentNumber('JE', 7)).toMatch(/^JE-\d{4}-00007$/);
  });

  it('generateEntryNumber sigue partiendo de un conteo (uso no financiero)', () => {
    // Se conserva para clientes y proveedores; los documentos financieros
    // usan nextEntityNumber. Ver la nota de obsolescencia en sequence.ts.
    expect(generateEntryNumber('C', 0)).toMatch(/^C-\d{4}-00001$/);
  });
});
