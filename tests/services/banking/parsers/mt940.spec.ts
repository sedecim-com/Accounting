import { describe, it, expect } from 'vitest';
import { leerMt940 } from '../../../../src/services/banking/parsers/mt940.js';
import { ValidationError } from '../../../../src/utils/errors.js';

const EXTRACTO = [
  ':20:STMT260131',
  ':25:014180000123456789',
  ':28C:00042/001',
  ':60F:C260101MXN100000,00',
  ':61:2601050106D1234,56NTRFREF-001//BANCO-9911',
  ':86:PAGO PROVEEDOR ACME',
  'FACTURA A-100',
  ':61:2601090109C2100,00NTRFREF-002',
  ':86:COBRO CLIENTE',
  ':62F:C260131MXN100865,44',
  '-',
].join('\r\n');

describe('leerMt940', () => {
  it('trae los dos saldos con su fecha y su moneda', () => {
    const extracto = leerMt940(EXTRACTO);
    expect(extracto).toMatchObject({
      formato: 'mt940',
      saldoInicial: '100000.00',
      saldoFinal: '100865.44',
      periodoInicio: '2026-01-01',
      periodoFin: '2026-01-31',
      moneda: 'MXN',
    });
    expect(extracto.avisos).toEqual([]);
  });

  it('lee la cuenta declarada y el número de estado', () => {
    const extracto = leerMt940(EXTRACTO);
    expect(extracto.cuentaDeclarada).toBe('014180000123456789');
    expect(extracto.numeroDeEstado).toBe('00042/001');
  });

  it('firma los movimientos: D sale, C entra', () => {
    const extracto = leerMt940(EXTRACTO);
    expect(extracto.lineas.map((l) => l.importe)).toEqual(['-1234.56', '2100.00']);
  });

  it('lee la coma como separador decimal, que es lo que manda SWIFT', () => {
    const extracto = leerMt940(':20:X\n:60F:C260101MXN0,00\n:61:260105C1.234,56NTRFR1\n:86:X\n:62F:C260131MXN1234,56');
    expect(extracto.lineas[0].importe).toBe('1234.56');
  });

  it('distingue fecha de operación (MMDD) de fecha valor (YYMMDD)', () => {
    const [primera] = leerMt940(EXTRACTO).lineas;
    expect(primera.fechaValor).toBe('2026-01-05');
    expect(primera.fecha).toBe('2026-01-06');
  });

  it('resuelve el salto de año del MMDD sin año', () => {
    // Fecha valor 2 de enero, operación del 31 de diciembre: es del año anterior.
    const extracto = leerMt940(
      [':20:X', ':60F:C260101MXN0,00', ':61:2601021231D100,00NTRFR1', ':86:AJUSTE', ':62F:C260131MXN-100,00'].join('\n')
    );
    expect(extracto.lineas[0].fecha).toBe('2025-12-31');
    expect(extracto.lineas[0].fechaValor).toBe('2026-01-02');
  });

  it('INVIERTE el sentido en los reversos RC y RD, que no son C y D', () => {
    const extracto = leerMt940(
      [
        ':20:X',
        ':60F:C260101MXN0,00',
        ':61:260105RC500,00NTRFREV-1',
        ':86:REVERSO DE ABONO',
        ':61:260106RD700,00NTRFREV-2',
        ':86:REVERSO DE CARGO',
        ':62F:C260131MXN200,00',
      ].join('\n')
    );
    // RC reversa un crédito: sale dinero. RD reversa un débito: entra.
    expect(extracto.lineas.map((l) => l.importe)).toEqual(['-500.00', '700.00']);
    expect(extracto.lineas[0].crudo).toMatchObject({ marca: 'RC', esReverso: true });
  });

  it('une las continuaciones del :86: en una sola descripción', () => {
    const extracto = leerMt940(EXTRACTO);
    expect(extracto.lineas[0].descripcion).toBe('PAGO PROVEEDOR ACME FACTURA A-100');
    expect(extracto.lineas[1].descripcion).toBe('COBRO CLIENTE');
  });

  it('separa la referencia del cliente de la del banco', () => {
    const [primera] = leerMt940(EXTRACTO).lineas;
    expect(primera.referencia).toBe('REF-001');
    expect(primera.crudo).toMatchObject({ referenciaBanco: 'BANCO-9911' });
    expect(primera.tipo).toBe('NTRF');
  });

  it('lee un saldo D como cuenta sobregirada', () => {
    const extracto = leerMt940(
      [':20:X', ':60F:D260101MXN500,00', ':61:260105C100,00NTRFR1', ':86:X', ':62F:D260131MXN400,00'].join('\n')
    );
    expect(extracto.saldoInicial).toBe('-500.00');
    expect(extracto.saldoFinal).toBe('-400.00');
  });

  it('acumula la línea :61: corrupta en avisos con su número de línea', () => {
    const extracto = leerMt940(
      [
        ':20:X',
        ':60F:C260101MXN0,00',
        ':61:BASURA-SIN-FORMA',
        ':86:X',
        ':61:260109C10,00NTRFR2',
        ':86:BUENO',
        ':62F:C260131MXN10,00',
      ].join('\n')
    );
    expect(extracto.lineas).toHaveLength(1);
    const aviso = extracto.avisos.find((a) => a.startsWith('Línea 3'));
    expect(aviso).toMatch(/no tiene la forma esperada/);
    expect(aviso).toMatch(/BASURA-SIN-FORMA/);
  });

  it('avisa una sola vez por etiqueta desconocida, no una vez por línea', () => {
    const extracto = leerMt940(
      [
        ':20:X',
        ':60F:C260101MXN0,00',
        ':61:260105C10,00NTRFR1',
        ':86:X',
        ':64:C260131MXN10,00',
        ':65:C260228MXN10,00',
        ':65:C260331MXN10,00',
        ':62F:C260131MXN10,00',
      ].join('\n')
    );
    const desconocidas = extracto.avisos.filter((a) => a.includes('no interpreta'));
    expect(desconocidas).toHaveLength(2);
    expect(desconocidas.join(' ')).toMatch(/:64:/);
    expect(desconocidas.join(' ')).toMatch(/:65:/);
  });

  it('avisa de que un :60M: es una página, no el estado completo', () => {
    const extracto = leerMt940(
      [':20:X', ':60M:C260101MXN10,00', ':61:260105C10,00NTRFR1', ':86:X', ':62M:C260115MXN20,00'].join('\n')
    );
    expect(extracto.saldoInicial).toBe('10.00');
    expect(extracto.avisos.join(' ')).toMatch(/intermedio/);
  });

  it('lee el primero de varios extractos y dice cuántos ignoró', () => {
    const extracto = leerMt940(
      [
        ':20:UNO',
        ':60F:C260101MXN0,00',
        ':61:260105C10,00NTRFR1',
        ':86:PRIMERO',
        ':62F:C260131MXN10,00',
        '-',
        ':20:DOS',
        ':60F:C260201MXN10,00',
        ':61:260205C20,00NTRFR2',
        ':86:SEGUNDO',
        ':62F:C260228MXN30,00',
      ].join('\n')
    );
    expect(extracto.lineas.map((l) => l.descripcion)).toEqual(['PRIMERO']);
    expect(extracto.numeroDeEstado).toBe('UNO');
    expect(extracto.avisos.join(' ')).toMatch(/2 extractos .*se ignoraron 1/);
  });

  it('avisa cuando falta un saldo y toma el periodo de los movimientos', () => {
    const extracto = leerMt940([':20:X', ':61:260105C10,00NTRFR1', ':86:UNO'].join('\n'));
    expect(extracto.saldoFinal).toBeUndefined();
    expect(extracto.periodoInicio).toBe('2026-01-05');
    expect(extracto.avisos.join(' ')).toMatch(/no trae el saldo de cierre/);
  });

  it('se niega con lo que no es un MT940, y con el archivo vacío', () => {
    expect(() => leerMt940('hola\nmundo')).toThrow(ValidationError);
    expect(() => leerMt940('hola\nmundo')).toThrow(/no parece un MT940/);
    expect(() => leerMt940('')).toThrow(/vacío/);
  });
});
