import { describe, it, expect } from 'vitest';
import { leerCamt053 } from '../../../../src/services/banking/parsers/camt053.js';
import { ValidationError } from '../../../../src/utils/errors.js';

const ESPACIO = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.02';

/** Envuelve un <Stmt> con la cáscara mínima que exige el formato. */
const documento = (stmt: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="${ESPACIO}">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>MSG-1</MsgId><CreDtTm>2026-02-01T03:00:00</CreDtTm></GrpHdr>
    ${stmt}
  </BkToCstmrStmt>
</Document>`;

const saldo = (codigo: string, monto: string, sentido: string, fecha: string): string =>
  `<Bal>
     <Tp><CdOrPrtry><Cd>${codigo}</Cd></CdOrPrtry></Tp>
     <Amt Ccy="MXN">${monto}</Amt>
     <CdtDbtInd>${sentido}</CdtDbtInd>
     <Dt><Dt>${fecha}</Dt></Dt>
   </Bal>`;

const ESTADO = documento(`<Stmt>
      <Id>STMT-2026-01</Id>
      <ElctrncSeqNb>42</ElctrncSeqNb>
      <FrToDt><FrDtTm>2026-01-01T00:00:00</FrDtTm><ToDtTm>2026-01-31T23:59:59</ToDtTm></FrToDt>
      <Acct><Id><Othr><Id>014180000123456789</Id></Othr></Id><Ccy>MXN</Ccy></Acct>
      ${saldo('OPBD', '100000.00', 'CRDT', '2026-01-01')}
      ${saldo('CLBD', '100865.44', 'CRDT', '2026-01-31')}
      <Ntry>
        <NtryRef>MOV-001</NtryRef>
        <Amt Ccy="MXN">1234.56</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-01-05</Dt></BookgDt>
        <ValDt><Dt>2026-01-06</Dt></ValDt>
        <BkTxCd><Prtry><Cd>SPEI-ENV</Cd></Prtry></BkTxCd>
        <AddtlNtryInf>PAGO PROVEEDOR ACME</AddtlNtryInf>
      </Ntry>
      <Ntry>
        <NtryRef>MOV-002</NtryRef>
        <Amt Ccy="MXN">2100.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-01-09</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>E2E-77</EndToEndId></Refs>
          <RmtInf><Ustrd>COBRO CLIENTE</Ustrd><Ustrd>FACTURA A-100</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
    </Stmt>`);

describe('leerCamt053', () => {
  it('trae los saldos de apertura y cierre de verdad, que es para lo que sirve', () => {
    const extracto = leerCamt053(ESTADO);
    expect(extracto.saldoInicial).toBe('100000.00');
    expect(extracto.saldoFinal).toBe('100865.44');
    expect(extracto.avisos).toEqual([]);
  });

  it('lee periodo, cuenta, moneda y secuencia electrónica', () => {
    const extracto = leerCamt053(ESTADO);
    expect(extracto).toMatchObject({
      formato: 'camt053',
      periodoInicio: '2026-01-01',
      periodoFin: '2026-01-31',
      cuentaDeclarada: '014180000123456789',
      moneda: 'MXN',
      numeroDeEstado: '42',
    });
  });

  it('pone el signo donde camt lo esconde: DBIT sale negativo', () => {
    const extracto = leerCamt053(ESTADO);
    expect(extracto.lineas.map((l) => l.importe)).toEqual(['-1234.56', '2100.00']);
  });

  it('distingue fecha de operación y fecha valor', () => {
    const [primera] = leerCamt053(ESTADO).lineas;
    expect(primera.fecha).toBe('2026-01-05');
    expect(primera.fechaValor).toBe('2026-01-06');
  });

  it('busca la descripción donde el banco la haya puesto', () => {
    const extracto = leerCamt053(ESTADO);
    expect(extracto.lineas[0].descripcion).toBe('PAGO PROVEEDOR ACME');
    expect(extracto.lineas[1].descripcion).toBe('COBRO CLIENTE FACTURA A-100');
    expect(extracto.lineas[1].referencia).toBe('MOV-002');
    expect(extracto.lineas[0].tipo).toBe('SPEI-ENV');
  });

  it('no deja que el dinero pase por un número: los montos llegan como texto', () => {
    // «100000.00» leído como número volvería «100000» y perdería los centavos
    // de «100865.44» en cuanto alguien sumara.
    const extracto = leerCamt053(ESTADO);
    expect(typeof extracto.lineas[0].importe).toBe('string');
    expect(extracto.saldoInicial).toBe('100000.00');
  });

  it('lee un saldo DBIT como cuenta sobregirada', () => {
    const xml = documento(`<Stmt>
      <Id>S</Id>
      ${saldo('OPBD', '500.00', 'DBIT', '2026-01-01')}
      ${saldo('CLBD', '100.00', 'CRDT', '2026-01-31')}
    </Stmt>`);
    expect(leerCamt053(xml).saldoInicial).toBe('-500.00');
  });

  it('acepta PRCD como apertura, avisando de que no era OPBD', () => {
    const xml = documento(`<Stmt>
      <Id>S</Id>
      ${saldo('PRCD', '900.00', 'CRDT', '2026-01-01')}
      ${saldo('CLBD', '900.00', 'CRDT', '2026-01-31')}
    </Stmt>`);
    const extracto = leerCamt053(xml);
    expect(extracto.saldoInicial).toBe('900.00');
    expect(extracto.avisos.join(' ')).toMatch(/se usó PRCD/);
  });

  it('EXCLUYE lo no contabilizado: un PDNG rompería la cadena de saldos', () => {
    const xml = documento(`<Stmt>
      <Id>S</Id>
      ${saldo('OPBD', '0.00', 'CRDT', '2026-01-01')}
      ${saldo('CLBD', '0.00', 'CRDT', '2026-01-31')}
      <Ntry>
        <NtryRef>PEND-1</NtryRef>
        <Amt Ccy="MXN">50.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>PDNG</Sts>
        <BookgDt><Dt>2026-01-10</Dt></BookgDt>
      </Ntry>
    </Stmt>`);
    const extracto = leerCamt053(xml);
    expect(extracto.lineas).toHaveLength(0);
    expect(extracto.avisos.join(' ')).toMatch(/PEND-1.*Sts=PDNG/);
    expect(extracto.avisos.join(' ')).toMatch(/camt\.052/);
  });

  it('avisa del asiento por lote, cuyo detalle se colapsa en una sola línea', () => {
    const xml = documento(`<Stmt>
      <Id>S</Id>
      ${saldo('OPBD', '0.00', 'CRDT', '2026-01-01')}
      ${saldo('CLBD', '0.00', 'CRDT', '2026-01-31')}
      <Ntry>
        <NtryRef>NOMINA-1</NtryRef>
        <Amt Ccy="MXN">30000.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-01-15</Dt></BookgDt>
        <AddtlNtryInf>DISPERSION NOMINA</AddtlNtryInf>
        <NtryDtls>
          <TxDtls><Refs><EndToEndId>E1</EndToEndId></Refs></TxDtls>
          <TxDtls><Refs><EndToEndId>E2</EndToEndId></Refs></TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>`);
    const extracto = leerCamt053(xml);
    expect(extracto.lineas).toHaveLength(1);
    expect(extracto.avisos.join(' ')).toMatch(/asiento por lote con 2 transacciones/);
  });

  it('lee el primero de varios estados y dice cuántos ignoró', () => {
    const uno = `<Stmt><Id>A</Id>${saldo('OPBD', '1.00', 'CRDT', '2026-01-01')}${saldo('CLBD', '1.00', 'CRDT', '2026-01-31')}</Stmt>`;
    const dos = `<Stmt><Id>B</Id>${saldo('OPBD', '2.00', 'CRDT', '2026-01-01')}${saldo('CLBD', '2.00', 'CRDT', '2026-01-31')}</Stmt>`;
    const extracto = leerCamt053(documento(uno + dos));
    expect(extracto.numeroDeEstado).toBe('A');
    expect(extracto.avisos.join(' ')).toMatch(/2 estados .*se ignoraron 1/);
  });

  it('se niega con un camt.054, que no trae saldos y no es un estado', () => {
    const xml = ESTADO.replace(ESPACIO, 'urn:iso:std:iso:20022:tech:xsd:camt.054.001.02');
    expect(() => leerCamt053(xml)).toThrow(ValidationError);
    expect(() => leerCamt053(xml)).toThrow(/no es camt\.053/);
  });

  it('se niega con XML que no tiene <Stmt>, y con el archivo vacío', () => {
    expect(() => leerCamt053('<Document><Otro/></Document>')).toThrow(/no es un camt\.053/);
    expect(() => leerCamt053('')).toThrow(/vacío/);
  });

  it('se niega con XML mal formado en vez de devolver un extracto de cero líneas', () => {
    expect(() => leerCamt053('<Document><BkToCstmrStmt><Stmt>')).toThrow(ValidationError);
  });

  it('cuando no hay periodo declarado, lo toma de los movimientos y lo dice', () => {
    const xml = documento(`<Stmt>
      <Id>S</Id>
      <Ntry>
        <Amt Ccy="MXN">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-03-04</Dt></BookgDt>
        <AddtlNtryInf>UNO</AddtlNtryInf>
      </Ntry>
    </Stmt>`);
    const extracto = leerCamt053(xml);
    expect(extracto.periodoInicio).toBe('2026-03-04');
    expect(extracto.periodoFin).toBe('2026-03-04');
    expect(extracto.avisos.join(' ')).toMatch(/no declara periodo/);
    expect(extracto.avisos.join(' ')).toMatch(/no trae saldo de apertura/);
  });
});
