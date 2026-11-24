import { describe, it, expect } from 'vitest';
import { linesToSplit } from '../../../src/services/sat/diot/cfdi-split.js';
import {
  desglosarDocumento,
  type PoliticaBaseExenta,
  type RenglonDeGasto,
} from '../../../src/services/sat/diot/desglose.js';

// ============================================================
// MNE-001-563 · A BILL WHOSE LINES CANNOT SAY THE SPLIT IS SPLIT BY ITS CFDI
//
// Under `lineas_factura_desde = poliza` a bill line is a debit of the approved
// entry: it carries no VAT and, when the concepts mix regimes, no rate. Each
// case passes the stored lines through `linesToSplit` and then through the
// DIOT's own `desglosarDocumento`, with the header the approval wrote.
// ============================================================

const line = (o: Partial<RenglonDeGasto> = {}): RenglonDeGasto => ({
  tipoFactor: 'tasa', tasa: null, valorActos: null, importe: '1300.0000', iva: '0.0000', ...o,
});
const vat = (rate: number, base: number | undefined, tax: number) =>
  ({ impuesto: '002', tipoFactor: 'Tasa', tasaOCuota: rate, base, importe: tax });
const exempt = (base?: number) => ({ impuesto: '002', tipoFactor: 'Exento', base });
const taxes = (...transfers: object[]) => ({ traslados: transfers, retenciones: [] }) as Parameters<typeof linesToSplit>[2];

function split(
  lines: RenglonDeGasto[], headerVat: string, t: Parameters<typeof linesToSplit>[2],
  o: { rate?: string; policy?: PoliticaBaseExenta } = {}
) {
  const r = desglosarDocumento({
    documentId: 'b', documentNumber: 'BILL-1', renglones: linesToSplit(lines, headerVat, t),
    ivaCabecera: headerVat, ivaPagado: (Number(headerVat) * Number(o.rate ?? 1)).toFixed(4),
    porcion: { aplicadoPrevio: '0', aplicadoAhora: '100', totalDocumento: '100', tasaCambio: o.rate },
    politicaBaseExenta: o.policy ?? 'exigir_base',
  });
  return { ...r.desglose, codes: r.hallazgos.map((h) => h.codigo) };
}

describe('linesToSplit', () => {
  const acceptance = taxes(vat(0.16, 1000, 160), exempt(300));

  it('U1 · one debit of 1,300.00 under a header of 160.00 is split as its CFDI says, also in foreign currency', () => {
    const r = split([line()], '160.0000', acceptance);
    expect(r.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(r.exento).toEqual({ base: '300.0000', iva: '0.0000' });
    expect(r.codes).toEqual([]);
    const usd = split([line()], '160.0000', acceptance, { rate: '20' });
    expect(usd.tasa16).toEqual({ base: '20000.0000', iva: '3200.0000' });
  });

  it('U2 · 16 % and 8 % land in two boxes', () => {
    const r = split([line({ importe: '1500.0000' })], '200.0000', taxes(vat(0.16, 1000, 160), vat(0.08, 500, 40)));
    expect(r.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(r.tasa8).toEqual({ base: '500.0000', iva: '40.0000' });
    expect(r.codes).toEqual([]);
  });

  it('U3 · IEPS first, then VAT: the IEPS transfer is no line', () => {
    const ieps = { impuesto: '003', tipoFactor: 'Tasa', tasaOCuota: 0.08, base: 1000, importe: 80 };
    const stored = [line({ tasa: '16.00', valorActos: '1080.0000', importe: '1000.0000' })];
    expect(linesToSplit(stored, '172.8000', taxes(ieps, vat(0.16, 1080, 172.8)))).toHaveLength(1);
    expect(split(stored, '172.8000', taxes(ieps, vat(0.16, 1080, 172.8))).tasa16)
      .toEqual({ base: '1080.0000', iva: '172.8000' });
  });

  it('U4 · the stored lines stand when they carry VAT, or there is no CFDI split to read, or no line', () => {
    const withVat = [line({ tasa: '16.00', iva: '100.0000' })];
    expect(linesToSplit(withVat, '160.0000', acceptance)).toBe(withVat);
    expect(split(withVat, '160.0000', acceptance).codes).toEqual(['DIOT-IVA-CABECERA']);
    const stored = [line()];
    expect(linesToSplit(stored, '160.0000', null)).toBe(stored);
    expect(linesToSplit(stored, '160.0000', taxes({ impuesto: '003', tipoFactor: 'Tasa', base: 1000, importe: 80 }))).toBe(stored);
    expect(linesToSplit([], '160.0000', acceptance)).toEqual([]);
  });

  it('U5 · a taxed transfer with no Base derives nothing: the stored lines stand and the bill blocks', () => {
    const stored = [line()];
    const noBase = taxes(vat(0.16, undefined, 160), exempt(300));
    expect(linesToSplit(stored, '160.0000', noBase)).toBe(stored);
    expect(split(stored, '160.0000', noBase).codes).toEqual(['DIOT-IVA-CABECERA']);
  });

  it('U6 · an exempt transfer with no Base is an exempt line with no value, and the policy decides', () => {
    const r = split([line()], '160.0000', taxes(vat(0.16, 1000, 160), exempt()));
    expect(r.codes).toEqual(['DIOT-BASE-EXENTA-DESCONOCIDA']);
    expect(r.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
  });

  it('U7 · no VAT and mixed regimes: 0 % and exempt each get their base; an all-exempt bill keeps its lines', () => {
    const r = split([line({ importe: '1000.0000' })], '0.0000', taxes(vat(0, 700, 0), exempt(300)));
    expect(r.tasa0.base).toBe('700.0000');
    expect(r.exento.base).toBe('300.0000');
    expect(r.codes).toEqual([]);
    const allExempt = [line({ tipoFactor: 'exento', valorActos: '700.0000', importe: '700.0000' })];
    expect(linesToSplit(allExempt, '0.0000', taxes(exempt(400), exempt(300)))).toBe(allExempt);
  });
});
