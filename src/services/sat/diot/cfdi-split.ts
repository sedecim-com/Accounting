import Decimal from 'decimal.js';
import { satKey } from '../../xml-ingestion/cfdi-amounts.js';
import type { CFDIImpuesto, CFDIParsed } from '../../xml-ingestion/cfdi-parser.js';
import { vatColumnsOf } from '../../xml-ingestion/pre-registration-service.js';
import type { RenglonDeGasto } from './desglose.js';

// ============================================================
// THE SPLIT BY RATE A CFDI STATES (MNE-001-563)
//
// Which rate an act bears is what the CFDI says. A document born from one can
// hold lines that do not say it: the approval of an issued CFDI writes its
// invoice lines without tax, and under `lineas_factura_desde = poliza` a bill
// line is a debit of the approved entry, with no VAT of its own and, when the
// concepts mix regimes, no rate either. One debit of 1,300.00 cannot say
// "1,000.00 at 16 % and 300.00 exempt"; the CFDI's summary can, and it is what
// the header's VAT was computed from, so the split adds up to the header.
//
// Nothing is written: the stored lines keep what the approval gave them, and
// the split is read each time a declaration is built.
// ============================================================

/** The Comprobante/Impuestos summary stored at ingestion (`pre_registrations.tax_breakdown`). */
export type CfdiTaxSummary = Partial<CFDIParsed['impuestos']> | null | undefined;

const isVat = (t: CFDIImpuesto): boolean => satKey(t.impuesto) === '002';
const isZero = (amount: string | null | undefined): boolean => new Decimal(amount || '0').isZero();

/**
 * One line per VAT (002) transfer of the summary: its factor, rate, Base and
 * tax, through `vatColumnsOf`, the reading a bill line gets. No other tax is a
 * line. An exempt transfer with no Base is an exempt line with no value, and
 * `diot_iva_exento_y_base` decides about it as for any document.
 */
export function vatLinesOfCfdi(taxes: CfdiTaxSummary): RenglonDeGasto[] {
  return (taxes?.traslados ?? []).filter(isVat).map((t): RenglonDeGasto => {
    const c = vatColumnsOf([t]);
    return {
      tipoFactor: c.factor_type,
      tasa: c.tax_rate,
      valorActos: c.acts_value,
      importe: c.acts_value ?? '0',
      iva: new Decimal(c.tax).toFixed(4),
    };
  });
}

/**
 * The lines a bill is split by: its CFDI's when its own cannot say the split,
 * its stored lines otherwise.
 *
 * The CFDI is read only when no stored line carries VAT and either the header
 * does (the lines sum zero under a header that does not) or no line states a
 * regime at all (every line `tasa` with no rate, which `clasificarRenglon`
 * would send whole to 0 %, exempt concepts included). Lines that carry VAT are
 * never replaced, also when they differ from the header: that bill keeps
 * blocking. A taxed transfer with no Base leaves the stored lines in place
 * too: a base nobody declared is not derived here.
 */
export function linesToSplit(lines: RenglonDeGasto[], headerVat: string, taxes: CfdiTaxSummary): RenglonDeGasto[] {
  if (lines.length === 0 || lines.some((l) => !isZero(l.iva))) return lines;
  const noRegime = lines.every((l) => l.tipoFactor === 'tasa' && l.tasa === null);
  if (isZero(headerVat) && !noRegime) return lines;
  const vat = (taxes?.traslados ?? []).filter(isVat);
  if (vat.length === 0 || vat.some((t) => t.tipoFactor !== 'Exento' && t.base == null)) return lines;
  return vatLinesOfCfdi(taxes);
}
