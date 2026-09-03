import { describe, it, expect } from 'vitest';
import {
  exigirEntregable,
  DiotFormatoNoFundamentado,
  DiotNoEntregable,
  LO_QUE_FALTA_CONFIRMAR,
  PAPEL_DE_TRABAJO,
  SERIALIZADOR_SAT,
} from '../../../src/services/sat/diot/serializador.js';
import { desgloseCero } from '../../../src/services/sat/diot/desglose.js';
import type { DiotConstruida } from '../../../src/services/sat/diot/modelo.js';

// ============================================================
// F07c · EL SERIALIZADOR QUE SE NIEGA
//
// Este archivo prueba una decisión, no un algoritmo: que el módulo produzca
// los DATOS y no invente la FORMA. La prueba que lo sostiene es la última —el
// serializador del SAT se niega aunque la declaración esté impecable—, porque
// es la que se rompería el día que alguien «complete» el layout de memoria.
// ============================================================

const base = (): DiotConstruida => {
  const desglose = desgloseCero();
  desglose.tasa16 = { base: '1000.0000', iva: '160.0000' };
  return {
    periodo: { anio: 2026, mes: 4, desde: '2026-04-01', hasta: '2026-04-30' },
    rfc: 'AAA010101AA1',
    razonSocial: 'Contribuyente de prueba',
    renglones: [
      {
        tercero: {
          vendorId: 'v1',
          nombre: 'Papelería del Centro SA de CV',
          tipoTercero: '04',
          tipoOperacion: '85',
          rfc: 'ABC010101AA1',
          procedencia: { tipoTercero: 'inferido', tipoOperacion: 'politica' },
        },
        desglose,
        ivaRetenido: '0.0000',
        documentos: [
          {
            billId: 'b1',
            billNumber: 'BILL-001',
            metodo: 'PPD',
            origenDelMetodo: 'cfdi',
            ivaPagado: '160.0000',
            ivaRetenido: '0.0000',
            desglose,
          },
        ],
      },
    ],
    totales: {
      desglose,
      ivaRetenido: '0.0000',
      ivaAcreditablePagado: '160.0000',
      terceros: 1,
      documentos: 1,
    },
    politicas: [
      { clave: 'diot_tipo_operacion_por_omision', valor: '85', definida: false },
      { clave: 'diot_tercero_sin_rfc', valor: 'bloquear', definida: false },
      { clave: 'diot_iva_exento_y_base', valor: 'exigir_base', definida: false },
    ],
    hallazgos: [],
  };
};

describe('el papel de trabajo', () => {
  it('dice en su PRIMERA línea que no es la declaración', () => {
    const salida = PAPEL_DE_TRABAJO.serializar(base());
    expect(salida.split('\n')[0]).toContain('NO ES EL ARCHIVO DE LA DECLARACIÓN');
    expect(PAPEL_DE_TRABAJO.esArchivoDeclarable).toBe(false);
  });

  it('publica el total que tiene que cuadrar contra el mayor', () => {
    const salida = PAPEL_DE_TRABAJO.serializar(base());
    expect(salida).toContain('IVA acreditable pagado en el mes: 160.0000');
    expect(salida).toContain('iva_acreditable');
  });

  it('dice qué política decidió qué, y si la contestó alguien', () => {
    const salida = PAPEL_DE_TRABAJO.serializar(base());
    expect(salida).toContain('# Política diot_tercero_sin_rfc = bloquear (por omisión)');
  });

  it('una fila por tercero, con el tipo y la tasa en columnas separadas', () => {
    const filas = PAPEL_DE_TRABAJO.serializar(base())
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    expect(filas).toHaveLength(1);
    expect(filas[0].split('|').slice(0, 3)).toEqual(['04', '85', 'ABC010101AA1']);
  });

  it('un nombre con barra vertical no corre las columnas', () => {
    // `company_name` es texto libre. Sin saneado, «A|B» mete una columna de
    // más y produce un papel que cuadra en los totales y miente en la fila.
    const d = base();
    d.renglones[0].tercero.nombre = 'Servicios A|B, SA de CV';
    const fila = PAPEL_DE_TRABAJO.serializar(d)
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))[0];
    expect(fila.split('|')).toHaveLength(16);
    expect(fila).toContain('Servicios A B, SA de CV');
  });

  it('se imprime aunque haya bloqueantes, y los grita en la cabecera', () => {
    // Es el punto entero de separar armar de entregar: el contador necesita
    // ver el papel PARA arreglar lo que bloquea.
    const d = base();
    d.hallazgos = [
      { codigo: 'DIOT-SIN-RFC', severidad: 'bloqueante', mensaje: 'Proveedor X no tiene RFC' },
    ];
    const salida = PAPEL_DE_TRABAJO.serializar(d);
    expect(salida).toContain('LA DECLARACIÓN NO SE PUEDE ENTREGAR TAL CUAL');
    expect(salida).toContain('DIOT-SIN-RFC');
  });
});

describe('exigirEntregable', () => {
  it('deja pasar una declaración limpia', () => {
    expect(() => exigirEntregable(base())).not.toThrow();
  });

  it('los nombra a TODOS, no sólo al primero', () => {
    const d = base();
    d.hallazgos = [
      { codigo: 'DIOT-SIN-RFC', severidad: 'bloqueante', mensaje: 'Proveedor A' },
      { codigo: 'DIOT-SIN-RFC', severidad: 'bloqueante', mensaje: 'Proveedor B' },
      { codigo: 'DIOT-TASA-MEDIDA', severidad: 'aviso', mensaje: 'no bloquea' },
    ];
    try {
      exigirEntregable(d);
      expect.unreachable('tenía que negarse');
    } catch (e) {
      expect(e).toBeInstanceOf(DiotNoEntregable);
      const msg = (e as Error).message;
      expect(msg).toContain('Proveedor A');
      expect(msg).toContain('Proveedor B');
      expect(msg).not.toContain('no bloquea');
    }
  });
});

describe('el archivo del SAT', () => {
  it('SE NIEGA aunque la declaración esté impecable, y dice qué falta confirmar', () => {
    const d = base();
    expect(() => exigirEntregable(d)).not.toThrow();
    try {
      SERIALIZADOR_SAT.serializar(d);
      expect.unreachable('el layout no está fundamentado: no debe producir nada');
    } catch (e) {
      expect(e).toBeInstanceOf(DiotFormatoNoFundamentado);
      const msg = (e as Error).message;
      // Dice que los DATOS sí están, que es la mitad que sí se entrega.
      expect(msg).toContain('160.0000');
      for (const falta of LO_QUE_FALTA_CONFIRMAR) expect(msg).toContain(falta);
    }
  });

  it('la lista de lo que falta no está vacía mientras el layout no se confirme', () => {
    expect(LO_QUE_FALTA_CONFIRMAR.length).toBeGreaterThan(0);
    expect(LO_QUE_FALTA_CONFIRMAR.join(' ')).toContain('orden y el número exacto de campos');
  });

  it('mira los bloqueantes ANTES que el formato', () => {
    const d = base();
    d.hallazgos = [{ codigo: 'DIOT-SIN-RFC', severidad: 'bloqueante', mensaje: 'Proveedor A' }];
    expect(() => SERIALIZADOR_SAT.serializar(d)).toThrow(DiotNoEntregable);
  });
});
