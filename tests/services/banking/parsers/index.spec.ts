import { describe, it, expect } from 'vitest';
import {
  FORMATOS_DEL_CATALOGO,
  leerExtracto,
  olfatear,
} from '../../../../src/services/banking/parsers/index.js';
import { decodificar } from '../../../../src/services/banking/parsers/texto.js';
import { ValidationError } from '../../../../src/utils/errors.js';

const CSV = 'fecha,descripcion,importe\n2026-01-05,PAGO,-100.00';
const CAMT = `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
  <Id>S</Id>
  <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="MXN">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-01</Dt></Dt></Bal>
  <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="MXN">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-31</Dt></Dt></Bal>
</Stmt></BkToCstmrStmt></Document>`;
const MT940 = ':20:X\n:60F:C260101MXN0,00\n:61:260105C10,00NTRFR1\n:86:UNO\n:62F:C260131MXN10,00';

describe('olfatear', () => {
  it('reconoce el formato por lo que el archivo es, no por su extensión', () => {
    expect(olfatear(CAMT)).toBe('camt053');
    expect(olfatear(MT940)).toBe('mt940');
    expect(olfatear(CSV)).toBe('csv');
    expect(olfatear('')).toBeNull();
  });

  it('reconoce un camt con prefijo de espacio de nombres', () => {
    expect(olfatear('<?xml version="1.0"?>\n<ns:Document xmlns:ns="x"/>')).toBe('camt053');
  });
});

describe('leerExtracto', () => {
  it('despacha a cada lector por el formato pedido', () => {
    expect(leerExtracto(CSV, { formato: 'csv' }).formato).toBe('csv');
    expect(leerExtracto(CAMT, { formato: 'camt053' }).formato).toBe('camt053');
    expect(leerExtracto(MT940, { formato: 'mt940' }).formato).toBe('mt940');
  });

  it('acepta los alias con punto y guion que escribe la gente', () => {
    expect(leerExtracto(CAMT, { formato: 'CAMT.053' }).formato).toBe('camt053');
    expect(leerExtracto(MT940, { formato: 'MT-940' }).formato).toBe('mt940');
  });

  it('olfatea cuando no se declara el formato', () => {
    expect(leerExtracto(CAMT).formato).toBe('camt053');
    expect(leerExtracto(MT940).formato).toBe('mt940');
  });

  it('distingue el formato PENDIENTE del formato inexistente', () => {
    // Ésta es la diferencia entre «espera» y «corrige», y sólo la sabe decir
    // quien conoce la lista del catálogo.
    let pendiente: unknown;
    try {
      leerExtracto(CSV, { formato: 'ofx' });
    } catch (e) {
      pendiente = e;
    }
    expect(pendiente).toBeInstanceOf(ValidationError);
    expect((pendiente as ValidationError).message).toMatch(/está en el catálogo pero todavía no tiene lector/);

    expect(() => leerExtracto(CSV, { formato: 'zip' })).toThrow(/no es un formato de estado de cuenta/);
  });

  it('explica por qué mt942 y camt054 no pueden ser un estado de cuenta', () => {
    expect(() => leerExtracto(CSV, { formato: 'mt942' })).toThrow(/NO trae saldo de cierre/);
    expect(() => leerExtracto(CSV, { formato: 'camt054' })).toThrow(/no trae saldos/);
  });
});

describe('FORMATOS_DEL_CATALOGO', () => {
  it('enumera los nueve del catálogo y marca cuáles se leen hoy', () => {
    expect(FORMATOS_DEL_CATALOGO.map((f) => f.nombre)).toEqual([
      'csv', 'camt053', 'mt940', 'ofx', 'qfx', 'mt942', 'camt054', 'bai2', 'xlsx',
    ]);
    const disponibles = FORMATOS_DEL_CATALOGO.filter((f) => f.estado === 'disponible');
    expect(disponibles.map((f) => f.nombre)).toEqual(['csv', 'camt053', 'mt940']);
    // Ningún formato se queda sin explicación de por qué está o por qué falta.
    expect(FORMATOS_DEL_CATALOGO.every((f) => f.nota.length > 20)).toBe(true);
  });
});

describe('decodificar', () => {
  it('quita el BOM de UTF-8', () => {
    const conBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hola', 'utf8')]);
    expect(decodificar(conBom)).toMatchObject({ texto: 'hola', codificacion: 'utf8' });
  });

  it('cae a Latin-1 cuando los bytes no son UTF-8 válido, y lo dice', () => {
    const bytes = Buffer.from('DEPÓSITO', 'latin1');
    const leido = decodificar(bytes);
    expect(leido.texto).toBe('DEPÓSITO');
    expect(leido.codificacion).toBe('latin1');
    expect(leido.avisos.join(' ')).toMatch(/no es UTF-8 válido/);
  });

  it('no toca lo que sí es UTF-8 válido', () => {
    const leido = decodificar(Buffer.from('DEPÓSITO', 'utf8'));
    expect(leido).toMatchObject({ texto: 'DEPÓSITO', codificacion: 'utf8', avisos: [] });
  });

  it('avisa de la pérdida cuando el perfil fuerza UTF-8 sobre bytes que no lo son', () => {
    const leido = decodificar(Buffer.from('DEPÓSITO', 'latin1'), 'utf8');
    expect(leido.codificacion).toBe('utf8');
    expect(leido.avisos.join(' ')).toMatch(/caracteres perdidos/);
  });

  it('reconoce UTF-16 por su BOM, en los dos órdenes de bytes', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hola', 'utf16le')]);
    expect(decodificar(le).texto).toBe('hola');

    const beCuerpo = Buffer.from('hola', 'utf16le');
    beCuerpo.swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beCuerpo]);
    expect(decodificar(be).texto).toBe('hola');
  });
});
