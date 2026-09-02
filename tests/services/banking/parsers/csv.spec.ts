import { describe, it, expect } from 'vitest';
import { leerCsv, detectarPerfilCsv } from '../../../../src/services/banking/parsers/csv.js';
import { PERFILES_CSV } from '../../../../src/services/banking/parsers/perfiles-csv.js';
import type { PerfilCsv } from '../../../../src/services/banking/parsers/tipos.js';
import { ValidationError } from '../../../../src/utils/errors.js';

// ============================================================
// Los ficheros de ejemplo van EN LÍNEA. Un extracto de banco en un archivo
// suelto del repositorio es un dato de cliente esperando a que alguien lo
// commitee de verdad, y además obliga a abrir dos ventanas para entender una
// prueba: aquí el archivo y su lectura esperada se ven juntos.
// ============================================================

/** BBVA: membrete variable, dos columnas de importe, miles con coma, Latin-1. */
const BBVA = [
  'BBVA MEXICO - MOVIMIENTOS DE LA CUENTA',
  'Cuenta: ****1234',
  '',
  'FECHA,DESCRIPCIÓN,REFERENCIA,CARGO,ABONO,SALDO',
  '05/01/2026,PAGO PROVEEDOR ACME,REF-001,"1,234.56",,"98,765.44"',
  '07/01/2026,DEPÓSITO EN EFECTIVO,REF-002,,"2,000.00","100,765.44"',
  '09/01/2026,"COMISIÓN, MANEJO DE CUENTA",REF-003,150.00,,"100,615.44"',
].join('\n');

/** Banorte: una sola columna de importe, ya firmada. */
const BANORTE = [
  'FECHA,DESCRIPCION,REFERENCIA,MONTO,SALDO',
  '05/01/2026,TRANSFERENCIA SPEI ENVIADA,REF-001,"-1,500.00","48,500.00"',
  '06/01/2026,ABONO NOMINA,REF-002,"3,200.00","51,700.00"',
].join('\n');

/** Santander: membrete con la cuenta, mes en letras, columnas RETIRO/DEPÓSITO. */
const SANTANDER = [
  'SANTANDER MEXICO - ESTADO DE CUENTA',
  'CUENTA: 014180000123456789',
  'ESTADO: 2026-0001',
  'FECHA,FOLIO,DESCRIPCION,RETIRO,DEPOSITO,SALDO',
  '15-ENE-2026,000123,PAGO DE SERVICIOS,"1,500.00",,"48,500.00"',
  '20-ENE-2026,000124,DEPOSITO SUCURSAL,,"5,000.00","53,500.00"',
].join('\n');

describe('detectarPerfilCsv', () => {
  it('reconoce a cada banco por su encabezado', () => {
    expect(detectarPerfilCsv(BBVA).perfil.nombre).toBe('bbva-mx');
    expect(detectarPerfilCsv(BANORTE).perfil.nombre).toBe('banorte-mx');
    expect(detectarPerfilCsv(SANTANDER).perfil.nombre).toBe('santander-mx');
  });

  it('cae en el perfil genérico sólo cuando ningún banco reconoce el archivo', () => {
    const detectado = detectarPerfilCsv('fecha,descripcion,importe\n2026-01-05,PAGO,-100.00');
    expect(detectado.perfil.nombre).toBe('generico');
  });

  it('FALLA EN VOZ ALTA con un encabezado que nadie reconoce', () => {
    let error: unknown;
    try {
      detectarPerfilCsv('COL_A,COL_B,COL_C\n1,2,3');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    const mensaje = (error as ValidationError).message;
    // El mensaje tiene que servir para actuar: qué vio y qué perfiles hay.
    expect(mensaje).toMatch(/COL_A,COL_B,COL_C/);
    expect(mensaje).toMatch(/bbva-mx/);
    expect(mensaje).toMatch(/bank format create/);
  });

  it('se niega a elegir cuando dos perfiles casan igual de bien', () => {
    const base: PerfilCsv = {
      nombre: 'gemelo-a',
      version: '1.0.0',
      confianza: 'conjetura',
      delimitador: ',',
      codificacion: 'auto',
      filaEncabezado: 1,
      maxDesplazamientoEncabezado: 2,
      columnas: { fecha: 'fecha', descripcion: 'descripcion', importe: 'importe' },
      formatoFecha: 'auto',
      importe: { modo: 'firmado', separadorDecimal: 'auto' },
    };
    const gemelos = [base, { ...base, nombre: 'gemelo-b' }];

    let error: unknown;
    try {
      detectarPerfilCsv('fecha,descripcion,importe\n2026-01-05,X,1.00', gemelos);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toMatch(/gemelo-a, gemelo-b/);
  });
});

describe('leerCsv · perfil bbva-mx', () => {
  it('convierte cargo y abono en un solo importe firmado', () => {
    const extracto = leerCsv(BBVA);

    expect(extracto.formato).toBe('csv');
    expect(extracto.perfil).toBe('bbva-mx');
    expect(extracto.lineas.map((l) => [l.fecha, l.importe])).toEqual([
      ['2026-01-05', '-1234.56'],
      ['2026-01-07', '2000.00'],
      ['2026-01-09', '-150.00'],
    ]);
  });

  it('respeta la coma dentro de una descripción entrecomillada', () => {
    const extracto = leerCsv(BBVA);
    expect(extracto.lineas[2].descripcion).toBe('COMISIÓN, MANEJO DE CUENTA');
  });

  it('lee Latin-1 y deja la descripción con sus acentos intactos', () => {
    const bytes = Buffer.from(BBVA, 'latin1');
    const extracto = leerCsv(bytes);
    expect(extracto.lineas[1].descripcion).toBe('DEPÓSITO EN EFECTIVO');
    expect(extracto.lineas[2].descripcion).toBe('COMISIÓN, MANEJO DE CUENTA');
  });

  it('deriva los dos saldos del saldo corrido y lo confiesa', () => {
    const extracto = leerCsv(BBVA);
    // 98 765.44 es el saldo DESPUÉS del primer movimiento (−1 234.56).
    expect(extracto.saldoInicial).toBe('100000.00');
    expect(extracto.saldoFinal).toBe('100615.44');
    expect(extracto.avisos.join(' ')).toMatch(/se DERIVARON del saldo corrido/);
  });

  it('acota el periodo con las fechas de las líneas', () => {
    const extracto = leerCsv(BBVA);
    expect(extracto.periodoInicio).toBe('2026-01-05');
    expect(extracto.periodoFin).toBe('2026-01-09');
  });

  it('avisa de que la moneda es una suposición del perfil, no un dato del archivo', () => {
    const extracto = leerCsv(BBVA);
    expect(extracto.moneda).toBe('MXN');
    expect(extracto.avisos.join(' ')).toMatch(/se asumió MXN/);
  });

  it('guarda la fila original completa en `crudo`, para raw_data', () => {
    const extracto = leerCsv(BBVA);
    expect(extracto.lineas[0].crudo).toMatchObject({
      __linea: 5,
      FECHA: '05/01/2026',
      CARGO: '1,234.56',
      SALDO: '98,765.44',
    });
  });
});

describe('leerCsv · perfil banorte-mx', () => {
  it('lee la columna firmada tal cual viene', () => {
    const extracto = leerCsv(BANORTE);
    expect(extracto.perfil).toBe('banorte-mx');
    expect(extracto.lineas.map((l) => l.importe)).toEqual(['-1500.00', '3200.00']);
    expect(extracto.lineas[0].referencia).toBe('REF-001');
  });
});

describe('leerCsv · perfil santander-mx', () => {
  it('saca la cuenta declarada del membrete, que es lo que prueba la identidad', () => {
    const extracto = leerCsv(SANTANDER);
    expect(extracto.perfil).toBe('santander-mx');
    expect(extracto.cuentaDeclarada).toBe('014180000123456789');
    expect(extracto.numeroDeEstado).toBe('2026-0001');
  });

  it('lee el mes en letras y el sentido de RETIRO/DEPÓSITO', () => {
    const extracto = leerCsv(SANTANDER);
    expect(extracto.lineas.map((l) => [l.fecha, l.importe])).toEqual([
      ['2026-01-15', '-1500.00'],
      ['2026-01-20', '5000.00'],
    ]);
  });

  it('avisa cuando el membrete no trae la cuenta: sin ella no hay prueba de identidad', () => {
    const sinCuenta = SANTANDER.replace('CUENTA: 014180000123456789', 'SUCURSAL: CENTRO');
    const extracto = leerCsv(sinCuenta);
    expect(extracto.cuentaDeclarada).toBeUndefined();
    expect(extracto.avisos.join(' ')).toMatch(/prueba de identidad/);
  });
});

describe('leerCsv · perfil generico', () => {
  const generico = (filas: string[]): string =>
    ['fecha,descripcion,importe,saldo', ...filas].join('\n');

  it('acumula la fila corrupta en avisos con su número de línea y su contenido', () => {
    const extracto = leerCsv(
      generico([
        '2026-01-05,PAGO,-100.00,900.00',
        'no-es-fecha,BASURA,-50.00,850.00',
        '2026-01-07,COBRO,200.00,1050.00',
      ])
    );

    expect(extracto.lineas).toHaveLength(2);
    const aviso = extracto.avisos.find((a) => a.startsWith('Línea 3'));
    expect(aviso).toBeDefined();
    expect(aviso).toMatch(/no se reconoce como fecha/);
    expect(aviso).toMatch(/no-es-fecha,BASURA,-50.00,850.00/);
  });

  it('rechaza la fila cuyo importe no se puede leer, sin ponerla en cero', () => {
    const extracto = leerCsv(generico(['2026-01-05,PAGO,PENDIENTE,900.00']));
    expect(extracto.lineas).toHaveLength(0);
    expect(extracto.avisos.join(' ')).toMatch(/no se lee como importe/);
  });

  it('confiesa la fecha ambigua en el aviso de la línea', () => {
    const extracto = leerCsv(generico(['03/04/2026,PAGO,-100.00,900.00']));
    expect(extracto.lineas[0].fecha).toBe('2026-04-03');
    expect(extracto.avisos.join(' ')).toMatch(/Línea 2: «03\/04\/2026» es ambigua/);
  });

  it('confiesa el separador de miles adivinado', () => {
    const extracto = leerCsv(generico(['2026-01-05,PAGO,-1.234,900.00']));
    expect(extracto.lineas[0].importe).toBe('-1234.00');
    expect(extracto.avisos.join(' ')).toMatch(/ambiguo/);
  });

  it('deriva los saldos por FECHA cuando el archivo viene del más nuevo al más viejo', () => {
    const extracto = leerCsv(
      generico(['2026-01-07,COBRO,200.00,1050.00', '2026-01-05,PAGO,-100.00,850.00'])
    );
    expect(extracto.saldoInicial).toBe('950.00');
    expect(extracto.saldoFinal).toBe('1050.00');
    expect(extracto.avisos.join(' ')).toMatch(/más reciente al más antiguo/);
  });

  it('ignora el pie de página del banco sin llamarlo fila corrupta', () => {
    const extracto = leerCsv(
      generico(['2026-01-05,PAGO,-100.00,900.00', 'TOTAL DE MOVIMIENTOS: 1'])
    );
    expect(extracto.lineas).toHaveLength(1);
    expect(extracto.avisos.filter((a) => a.startsWith('Línea'))).toHaveLength(0);
  });

  it('lee un archivo con encabezado y sin movimientos, y lo dice', () => {
    const extracto = leerCsv('fecha,descripcion,importe');
    expect(extracto.lineas).toHaveLength(0);
    expect(extracto.avisos.join(' ')).toMatch(/ninguna fila de movimiento legible/);
    expect(extracto.periodoInicio).toBeUndefined();
  });

  it('quita el BOM para que la primera columna no deje de reconocerse', () => {
    const conBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('fecha,descripcion,importe\n2026-01-05,PAGO,-100.00', 'utf8'),
    ]);
    const extracto = leerCsv(conBom);
    expect(extracto.lineas).toHaveLength(1);
  });
});

describe('leerCsv · el archivo que no se puede leer', () => {
  it('se niega con el archivo vacío', () => {
    expect(() => leerCsv('')).toThrow(ValidationError);
    expect(() => leerCsv('   \n\n  ')).toThrow(/vacío/);
    expect(() => leerCsv(Buffer.alloc(0))).toThrow(/vacío/);
  });

  it('se niega con un encabezado desconocido en vez de importar cero líneas', () => {
    expect(() => leerCsv('COL_A,COL_B,COL_C\n1,2,3')).toThrow(ValidationError);
  });

  it('se niega cuando el perfil pedido no existe, enumerando los que sí', () => {
    expect(() => leerCsv(BANORTE, { perfil: 'inventado' })).toThrow(/No existe el perfil/);
    expect(() => leerCsv(BANORTE, { perfil: 'inventado' })).toThrow(/generico/);
  });

  it('se niega cuando el perfil forzado no reconoce el archivo', () => {
    let error: unknown;
    try {
      leerCsv(BANORTE, { perfil: 'santander-mx' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toMatch(/no reconoce este archivo/);
    expect((error as ValidationError).message).toMatch(/cargo=retiro\|retiros/);
  });
});

describe('el registro de perfiles', () => {
  it('declara la confianza de cada perfil, y ningún perfil de banco se dice verificado', () => {
    for (const perfil of PERFILES_CSV) {
      expect(['verificado', 'derivado', 'conjetura']).toContain(perfil.confianza);
      if (perfil.banco) expect(perfil.confianza).toBe('conjetura');
    }
  });

  it('sólo el perfil genérico es de último recurso', () => {
    const ultimos = PERFILES_CSV.filter((p) => p.ultimoRecurso).map((p) => p.nombre);
    expect(ultimos).toEqual(['generico']);
  });
});
