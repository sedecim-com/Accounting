import { describe, it, expect } from 'vitest';
import {
  DiotFormatoNoFundamentado,
  DiotNoEntregable,
  SERIALIZADOR_SAT,
} from '../../../src/services/sat/diot/serializador.js';
import {
  LAYOUT_ANSWERS,
  SAT_SOURCE,
  layoutForYear,
  toWholeUnits,
} from '../../../src/services/sat/diot/sat-batch.js';
import { desgloseCero, type Desglose } from '../../../src/services/sat/diot/desglose.js';
import type { DiotConstruida, RenglonDiot } from '../../../src/services/sat/diot/modelo.js';
import type { TerceroDiot } from '../../../src/services/sat/diot/tercero.js';
import { proportionFindings } from '../../../src/services/sat/diot/diot-service.js';

// ============================================================
// MNE-001-055 · #307 · The SAT batch file against a hand-built example
//
// EXPECTED was written BY HAND from the SAT instructivo (Enero 2025, §3.1–§3.5,
// cited in sat-batch.ts), not copied from the serializer's output. Field by
// field, 54 per record, 1-based:
//   1 third-party type · 2 operation · 3 RFC · 4 foreign tax id · 5 foreign
//   name · 6 country · 7 other jurisdiction · 8–17 value of acts (northern
//   border, southern border, 16 %, customs import, import of intangibles and
//   services; value + returns each) · 18–27 creditable IVA (same five, two
//   boxes each: exclusively taxed, proportion) · 28–47 non-creditable IVA ·
//   48 IVA withheld · 49 exempt imports · 50 exempt · 51 0 % · 52–53 not
//   subject · 54 tax effects given (01 yes).
//
// Row 1, national, several rates and an exempt purchase:
//   16 % 1000.50 → field 12 = 1000 (50 cents go down, CFF art. 20)
//   IVA 160.08 → field 22 = 160 · withheld 10.67 → 48 = 11
//   exempt 99.49 → 50 = 99 · 0 % 250.51 → 51 = 251
// Row 2, foreign, services at 16 % are an import: 2000 → 16, IVA 320 → 26,
//   exempt import 100 → 49.
// Row 3, global: operation 87 and XAXX010101000 whatever the vendor file says;
//   500.51 → 12 = 501, IVA 80.08 → 22 = 80.
// ============================================================

const EXPECTED =
  '04|85|ABC010101AA1|||||||||1000||||||||||160||||||||||||||||||||||||||11||99|251|||01\r\n' +
  '05|03||US123456789|Cloud Services Inc|USA||||||||||2000||||||||||320|||||||||||||||||||||||100|||||01\r\n' +
  '15|87|XAXX010101000|||||||||501||||||||||80||||||||||||||||||||||||||||||||01';

const row = (party: TerceroDiot, fill: (d: Desglose) => void, withheld = '0.0000'): RenglonDiot => {
  const breakdown = desgloseCero();
  fill(breakdown);
  return { tercero: party, desglose: breakdown, ivaRetenido: withheld, documentos: [] };
};

const origin = { tipoTercero: 'declarado', tipoOperacion: 'declarado' } as const;

const diot = (): DiotConstruida => ({
  periodo: { anio: 2026, mes: 4, desde: '2026-04-01', hasta: '2026-04-30' },
  rfc: 'AAA010101AA1',
  razonSocial: 'Contribuyente de prueba',
  renglones: [
    row(
      { vendorId: 'v1', nombre: 'Papelería del Centro', tipoTercero: '04', tipoOperacion: '85', rfc: 'ABC010101AA1', procedencia: origin },
      (d) => {
        d.tasa16 = { base: '1000.5000', iva: '160.0800' };
        d.tasa0 = { base: '250.5100', iva: '0.0000' };
        d.exento = { base: '99.4900', iva: '0.0000' };
      },
      '10.6700'
    ),
    row(
      {
        vendorId: 'v2',
        nombre: 'Cloud Services Inc',
        tipoTercero: '05',
        tipoOperacion: '03',
        idFiscalExtranjero: 'US123456789',
        paisResidencia: 'usa',
        nacionalidad: 'Estadounidense',
        procedencia: origin,
      },
      (d) => {
        d.tasa16 = { base: '2000.0000', iva: '320.0000' };
        d.exento = { base: '100.0000', iva: '0.0000' };
      }
    ),
    row(
      { vendorId: 'v3', nombre: 'Público en general', tipoTercero: '15', tipoOperacion: '85', rfc: 'XAXX010101000', procedencia: origin },
      (d) => {
        d.tasa16 = { base: '500.5100', iva: '80.0800' };
      }
    ),
  ],
  totales: { desglose: desgloseCero(), ivaRetenido: '10.6700', ivaAcreditablePagado: '560.1600', terceros: 3, documentos: 0 },
  politicas: [{ clave: 'diot_creditable_iva_proportion', valor: 'taxed_only', definida: false }],
  hallazgos: [],
});

const refusal = (d: DiotConstruida): string => {
  try {
    SERIALIZADOR_SAT.serializar(d);
  } catch (e) {
    expect(e).toBeInstanceOf(DiotNoEntregable);
    return (e as Error).message;
  }
  return expect.unreachable('the serializer had to refuse');
};

describe('the SAT batch file (2025 layout)', () => {
  it('matches the hand-built example byte for byte', () => {
    expect(SERIALIZADOR_SAT.serializar(diot())).toBe(EXPECTED);
    expect(SERIALIZADOR_SAT.esArchivoDeclarable).toBe(true);
  });

  it('rounds to whole pesos by CFF art. 20: 1–50 cents down, 51–99 up', () => {
    expect(toWholeUnits('10.5000')).toBe('10');
    expect(toWholeUnits('10.5100')).toBe('11');
    expect(toWholeUnits('10.5050')).toBe('11');
    expect(toWholeUnits('10.4999')).toBe('10');
    expect(toWholeUnits('0.0000')).toBe('0');
  });

  it('fills the IVA box with 0 when the value is declared and the IVA is nil', () => {
    const d = diot();
    d.renglones = [d.renglones[0]];
    d.renglones[0].desglose.tasa16.iva = '0.0000';
    expect(SERIALIZADOR_SAT.serializar(d).split('|')[21]).toBe('0');
  });

  it('refuses a period before the first grounded layout', () => {
    const d = diot();
    d.periodo = { anio: 2024, mes: 12, desde: '2024-12-01', hasta: '2024-12-31' };
    expect(layoutForYear(2024)).toBeNull();
    expect(() => SERIALIZADOR_SAT.serializar(d)).toThrow(DiotFormatoNoFundamentado);
  });

  it('refuses 8 % purchases: the layout splits northern and southern border and the vendor file does not say which', () => {
    const d = diot();
    d.renglones[0].desglose.tasa8 = { base: '100.0000', iva: '8.0000' };
    expect(refusal(d)).toContain('región fronteriza NORTE');
  });

  it('refuses rates the layout does not name, never folding them into 16 %', () => {
    const d = diot();
    d.renglones[0].desglose.otras = [{ etiqueta: '11.00', base: '100.0000', iva: '11.0000' }];
    expect(refusal(d)).toContain('11.00');
  });

  it('names every third party the layout cannot express, not only the first', () => {
    const d = diot();
    d.renglones[1].tercero.tipoOperacion = '85';
    d.renglones[1].tercero.paisResidencia = 'ZZZ';
    const msg = refusal(d);
    expect(msg).toContain('tipo de operación 85');
    expect(msg).toContain('ZZZ');
  });

  it('refuses when the entity applies the LIVA art. 5-V proportion', () => {
    const d = diot();
    d.politicas = [{ clave: 'diot_creditable_iva_proportion', valor: 'block', definida: true }];
    expect(refusal(d)).toContain('art. 5 frac. V');
  });

  it('refuses an amount wider than 14 digits', () => {
    const d = diot();
    d.renglones[0].desglose.tasa0.base = '123456789012345.0000';
    expect(refusal(d)).toContain('14 posiciones');
  });

  it('refuses a negative net naming the returns fields, not the field width', () => {
    const d = diot();
    d.renglones[0].desglose.tasa0.base = '-5.0000';
    const msg = refusal(d);
    expect(msg).toContain('devoluciones, descuentos y bonificaciones');
    expect(msg).not.toContain('14 posiciones');
  });

  it('answers the seven layout questions, each from the cited SAT source', () => {
    expect(LAYOUT_ANSWERS).toHaveLength(7);
    expect(SAT_SOURCE.url).toMatch(/^https:\/\/www\.sat\.gob\.mx\//);
    expect(SAT_SOURCE.consulted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const a of LAYOUT_ANSWERS) expect(a.section).toMatch(/§\d/);
  });

  it('writes one record per key: every global supplier and two records with one RFC add up before rounding', () => {
    const d = diot();
    const global2 = row(
      { vendorId: 'v4', nombre: 'Mostrador', tipoTercero: '15', tipoOperacion: '85', rfc: 'XAXX010101000', procedencia: origin },
      (b) => {
        b.tasa16 = { base: '0.5000', iva: '0.0800' };
      }
    );
    const sameRfc = row(
      { vendorId: 'v5', nombre: 'Papelería del Centro (sucursal)', tipoTercero: '04', tipoOperacion: '85', rfc: 'ABC010101AA1', procedencia: origin },
      (b) => {
        b.tasa16 = { base: '0.4000', iva: '0.0600' };
      },
      '0.4000'
    );
    d.renglones.push(global2, sameRfc);
    const lines = SERIALIZADOR_SAT.serializar(d).split('\r\n');
    expect(lines).toHaveLength(3);
    const national = lines[0].split('|');
    // 1000.50 + 0.40 = 1000.90 → 1001 (each part rounded alone would give 1000)
    expect([national[11], national[21], national[47]]).toEqual(['1001', '160', '11']);
    // 500.51 + 0.50 = 501.01 → 501; IVA 80.08 + 0.08 = 80.16 → 80
    expect(lines[2].split('|').slice(0, 3)).toEqual(['15', '87', 'XAXX010101000']);
    expect(lines[2].split('|')[11]).toBe('501');
  });

  it('refuses 0 % acts of a foreign supplier instead of writing them in the domestic 0 % field', () => {
    const d = diot();
    d.renglones[1].desglose.tasa0 = { base: '300.0000', iva: '0.0000' };
    expect(refusal(d)).toContain('proveedor extranjero');
  });

  it('leaves the IVA box empty when the value rounds to zero (§3.3: only when the value is above zero)', () => {
    const d = diot();
    d.renglones = [d.renglones[0]];
    d.renglones[0].desglose.tasa16 = { base: '0.4000', iva: '0.0000' };
    const fields = SERIALIZADOR_SAT.serializar(d).split('|');
    expect([fields[11], fields[21]]).toEqual(['0', '']);
  });

  it('refuses an IVA with no value of acts instead of dropping it', () => {
    const d = diot();
    d.renglones[0].desglose.tasa16 = { base: '0.0000', iva: '16.0000' };
    expect(refusal(d)).toContain('sin un valor de los actos');
  });

  it('refuses a country that is not a three-letter key of the §5 catalogue', () => {
    const d = diot();
    d.renglones[1].tercero.paisResidencia = 'US';
    expect(refusal(d)).toContain('"US"');
  });
});

describe('diot_creditable_iva_proportion findings', () => {
  it('blocks the default when the ledger has exempt revenue, whether answered or not', () => {
    for (const defined of [true, false]) {
      const codes = proportionFindings({ value: 'taxed_only', defined }, '500.0000').map((h) => h.codigo);
      expect(codes).toContain('DIOT-EXEMPT-REVENUE-WITHOUT-PROPORTION');
    }
  });

  it('names the default when it was not answered, and says nothing once answered', () => {
    expect(proportionFindings({ value: 'taxed_only', defined: false }, '0').map((h) => h.severidad)).toEqual(['aviso']);
    expect(proportionFindings({ value: 'taxed_only', defined: true }, '0')).toEqual([]);
    expect(proportionFindings({ value: 'block', defined: true }, '500')).toEqual([]);
  });
});
