import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { classifyBankLine } from '../../../src/services/banking/transaction-classifier.js';
import { tipoDeMovimiento } from '../../../src/services/banking/bank-statement-service.js';
import { leerExtracto } from '../../../src/services/banking/parsers/index.js';

// ============================================================
// MNE-001-040 (#95): no native bank format could produce 'fee' or 'interest',
// so `bank fee post` and `bank interest post` ran over zero rows. These tests
// pin the classification per format, end to end from the file text to the
// `transaction_type` the importer writes.
// ============================================================

/** The type the importer would write for every line of a statement. */
function typesOf(text: string, format: string): string[] {
  const statement = leerExtracto(text, { formato: format });
  return statement.lineas.map((l) => tipoDeMovimiento(new Decimal(l.importe), l.tipo, l.descripcion));
}

const BBVA = [
  'BBVA MEXICO - MOVIMIENTOS DE LA CUENTA',
  '',
  'FECHA,DESCRIPCIÓN,REFERENCIA,CARGO,ABONO,SALDO',
  '05/01/2026,PAGO PROVEEDOR ACME,REF-001,"1,000.00",,"9,000.00"',
  '31/01/2026,COMISION MANEJO DE CUENTA,REF-002,348.00,,"8,652.00"',
  '31/01/2026,IVA COMISION MANEJO DE CUENTA,REF-003,55.68,,"8,596.32"',
  '31/01/2026,INTERESES GANADOS,REF-004,,12.34,"8,608.66"',
].join('\n');

const BANORTE = [
  'FECHA,DESCRIPCION,REFERENCIA,MONTO,SALDO',
  '05/01/2026,TRANSFERENCIA SPEI ENVIADA,REF-001,"-1,500.00","48,500.00"',
  '31/01/2026,COMISIÓN POR SPEI,REF-002,-6.00,"48,494.00"',
  '31/01/2026,INTERÉS A FAVOR,REF-003,4.10,"48,498.10"',
  '31/01/2026,DEVOLUCION COMISION,REF-004,6.00,"48,504.10"',
].join('\n');

const SANTANDER = [
  'SANTANDER MEXICO - ESTADO DE CUENTA',
  'CUENTA: 014180000123456789',
  'ESTADO: 2026-0001',
  'FECHA,FOLIO,DESCRIPCION,RETIRO,DEPOSITO,SALDO',
  '15-ENE-2026,000123,COMISIONES COBRADAS,250.00,,"48,500.00"',
  '31-ENE-2026,000124,INTERESES,,7.25,"48,507.25"',
  '31-ENE-2026,000125,RETENCION ISR INTERESES,1.05,,"48,506.20"',
].join('\n');

const MT940 = [
  ':20:STMT260131',
  ':25:014180000123456789',
  ':60F:C260101MXN1000,00',
  ':61:2601310131D348,00NCHGREF-1',
  ':86:ACCOUNT MAINTENANCE',
  ':61:2601310131C12,34NINTREF-2',
  ':86:CREDIT BALANCE',
  ':61:2601310131D10,00NTRFREF-3',
  ':86:COMISION SPEI',
  ':62F:C260131MXN654,34',
  '-',
].join('\r\n');

function camtEntry(amount: string, side: 'DBIT' | 'CRDT', code: string, info: string): string {
  const [domain, family, subFamily] = code.split('/');
  return `<Ntry>
        <Amt Ccy="MXN">${amount}</Amt>
        <CdtDbtInd>${side}</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-01-31</Dt></BookgDt>
        <BkTxCd><Domn><Cd>${domain}</Cd><Fmly><Cd>${family}</Cd><SubFmlyCd>${subFamily}</SubFmlyCd></Fmly></Domn></BkTxCd>
        <AddtlNtryInf>${info}</AddtlNtryInf>
      </Ntry>`;
}

const CAMT = `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
  <Id>S-1</Id>
  <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="MXN">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-01</Dt></Dt></Bal>
  <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="MXN">654.34</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-31</Dt></Dt></Bal>
  ${camtEntry('348.00', 'DBIT', 'ACMT/MDOP/CHRG', 'ACCOUNT MAINTENANCE')}
  ${camtEntry('12.34', 'CRDT', 'ACMT/MCOP/INTR', 'CREDIT BALANCE')}
  ${camtEntry('10.00', 'DBIT', 'PMNT/ICDT/ESCT', 'SPEI ENVIADO')}
</Stmt></BkToCstmrStmt></Document>`;

describe('fee and interest classification per format', () => {
  it('BBVA CSV: «COMISION MANEJO DE CUENTA -348.00» comes in as fee', () => {
    // The VAT of the fee is its own line and stays a debit: posting it as a
    // fee would split VAT out of VAT (its release is MNE-001-041).
    expect(typesOf(BBVA, 'csv')).toEqual(['debit', 'fee', 'debit', 'interest']);
  });

  it('Banorte CSV: accented words classify, and a fee refund stays a credit', () => {
    expect(typesOf(BANORTE, 'csv')).toEqual(['debit', 'fee', 'interest', 'credit']);
  });

  it('Santander CSV: an ISR withholding on interest takes money out and stays a debit', () => {
    expect(typesOf(SANTANDER, 'csv')).toEqual(['fee', 'interest', 'debit']);
  });

  it('MT940: CHG and INT type codes classify; a transfer code falls back to the description', () => {
    expect(typesOf(MT940, 'mt940')).toEqual(['fee', 'interest', 'fee']);
  });

  it('camt.053: the ISO sub-family (CHRG, INTR) classifies, and the full code is kept', () => {
    expect(typesOf(CAMT, 'camt053')).toEqual(['fee', 'interest', 'debit']);
    expect(leerExtracto(CAMT, { formato: 'camt053' }).lineas.map((l) => l.tipo)).toEqual([
      'ACMT/MDOP/CHRG',
      'ACMT/MCOP/INTR',
      'PMNT/ICDT/ESCT',
    ]);
  });
});

describe('classifyBankLine', () => {
  const out = new Decimal('-10');
  const inn = new Decimal('10');

  it('reads MT940 and camt.053 codes, the most specific part last', () => {
    expect(classifyBankLine(out, 'NCHG')).toBe('fee');
    expect(classifyBankLine(out, 'FCOM')).toBe('fee');
    expect(classifyBankLine(inn, 'SINT')).toBe('interest');
    expect(classifyBankLine(out, 'PMNT/CCRD/FEES')).toBe('fee');
    expect(classifyBankLine(out, 'ACMT/MDOP/COMM')).toBe('fee');
    expect(classifyBankLine(out, 'NTRF')).toBeNull();
  });

  it('lets the bank code win over the description', () => {
    expect(classifyBankLine(inn, 'NINT', 'COMISION')).toBe('interest');
  });

  it('refuses a kind whose sign contradicts the amount', () => {
    expect(classifyBankLine(inn, 'NCHG')).toBeNull();
    expect(classifyBankLine(out, 'NINT')).toBeNull();
    expect(classifyBankLine(new Decimal(0), undefined, 'INTERESES')).toBeNull();
    expect(classifyBankLine(new Decimal(0), undefined, 'COMISION')).toBeNull();
  });

  it('does not take a word inside another word, nor a VAT line', () => {
    expect(classifyBankLine(out, undefined, 'COMISIONISTA ACME')).toBeNull();
    expect(classifyBankLine(out, undefined, 'I.V.A. COMISION')).toBeNull();
    expect(classifyBankLine(out, undefined, '')).toBeNull();
    expect(classifyBankLine(out)).toBeNull();
  });

  it('keeps a type the bank declared in our own vocabulary', () => {
    expect(tipoDeMovimiento(inn, 'credit', 'INTERESES')).toBe('credit');
  });
});
