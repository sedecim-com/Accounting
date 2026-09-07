import { describe, it, expect } from 'vitest';
import {
  bancoEnCatalogo,
  contarHallazgos,
  correrVerificaciones,
  estadoDeBanco,
  textoNormalizado,
  polizaConDineroSinRastro,
  polizaCuadra,
  renglonConUnSoloLado,
  totalesDePolizas,
  uuidDeComprobante,
  type CatalogoDeBancos,
} from '../../../src/services/sat/anexo24/polizas-invariantes.js';
import type { Poliza, Transaccion } from '../../../src/services/sat/anexo24/polizas-xml.js';

// ============================================================
// F07d · LAS INVARIANTES DE LAS PÓLIZAS, SIN BASE.
//
// El modelo es el de `balanza-invariantes.spec.ts`: funciones de datos a
// hallazgos, así que el caso raro cuesta cuatro líneas en vez de una entidad
// sembrada. Las dos trampas que este archivo existe para cazar:
//
//   1. UNA PÓLIZA PUEDE CUADRAR EN EL MAYOR Y NO EN EL ARCHIVO. El libro son
//      cuatro decimales y el Anexo 24 dos; el redondeo va por renglón y la
//      autoridad suma lo que se le entregó.
//   2. SIN CATÁLOGO DE BANCOS NO SE PUEDE AFIRMAR NADA. Ni aprobar ni
//      rechazar: decirlo. Es la lección de F07a con el c_CodAgrup.
// ============================================================

const t = (over: Partial<Transaccion> = {}): Transaccion => ({
  numCta: '1120',
  desCta: 'Bancos',
  concepto: 'x',
  debe: '0.00',
  haber: '100.00',
  ...over,
});

const p = (over: Partial<Poliza> = {}): Poliza => ({
  numUnIdenPol: 'JE-1',
  fecha: '2026-02-10',
  concepto: 'x',
  transacciones: [t({ debe: '100.00', haber: '0.00', numCta: '5100' }), t()],
  ...over,
});

const SIN_CATALOGO: CatalogoDeBancos = { sembrado: false, claves: new Set() };
const CON_CATALOGO: CatalogoDeBancos = { sembrado: true, claves: new Set(['002', '012']) };

describe('la póliza cuadra EN LAS CIFRAS DEL ARCHIVO', () => {
  it('una póliza equilibrada no produce hallazgo', () => {
    expect(polizaCuadra([p()])).toEqual([]);
  });

  it('EL REDONDEO POR RENGLÓN puede romper lo que el mayor tenía cuadrado', () => {
    // En el libro: 0.005 + 0.005 al debe = 0.01 al haber. Cuadra exacto.
    // En el archivo, redondeando CADA renglón a dos decimales: 0.01 + 0.01
    // frente a 0.01. La autoridad rehace la suma sobre estas cifras.
    const rota = p({
      transacciones: [
        t({ numCta: '5100', debe: '0.01', haber: '0.00' }),
        t({ numCta: '5200', debe: '0.01', haber: '0.00' }),
        t({ numCta: '1120', debe: '0.00', haber: '0.01' }),
      ],
    });
    const hs = polizaCuadra([rota]);
    expect(hs).toHaveLength(1);
    expect(hs[0].severity).toBe('blocking');
    expect(hs[0].referencia).toBe('JE-1');
    // El hallazgo trae la diferencia DENTRO, no sólo el veredicto.
    expect(hs[0].detalle).toContain('0.01');
  });
});

describe('la póliza que mueve dinero y no dice por dónde', () => {
  it('nombra la póliza POR SU NÚMERO, que es lo que el contador busca', () => {
    const hs = polizaConDineroSinRastro([
      { numUnIdenPol: 'JE-2026-0007', motivo: 'el pago VPMT-3 no tiene cuenta destino capturada' },
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0].referencia).toBe('JE-2026-0007');
    expect(hs[0].detalle).toContain('VPMT-3');
  });

  it('BLOQUEA, y el porqué está escrito en la cabecera del módulo', () => {
    // No hay política en el panel para esto y este tramo no la añade: el
    // defecto elegido es bloquear, porque las pólizas se entregan a
    // requerimiento con el plazo corriendo y el rechazo lo gasta entero.
    const hs = polizaConDineroSinRastro([{ numUnIdenPol: 'JE-1', motivo: 'x' }]);
    expect(hs[0].severity).toBe('blocking');
  });

  it('sin nada que denunciar, no denuncia', () => {
    expect(polizaConDineroSinRastro([])).toEqual([]);
  });
});

describe('la clave de banco contra el c_Banco', () => {
  const conPago = (clave: string): Poliza =>
    p({
      transacciones: [
        t({
          pagos: [
            {
              clase: 'transferencia',
              ctaDest: '002180009876543210',
              bancoDestNal: clave,
              fecha: '2026-02-10',
              benef: 'X',
              rfc: 'AAA010101AAA',
              monto: '100.00',
            },
          ],
        }),
      ],
    });

  it('los tres estados están separados, y `sin_clave` no es `fuera_de_catalogo`', () => {
    expect(estadoDeBanco('012', CON_CATALOGO)).toBe('valido');
    expect(estadoDeBanco('999', CON_CATALOGO)).toBe('fuera_de_catalogo');
    expect(estadoDeBanco('012', SIN_CATALOGO)).toBe('sin_catalogo');
    expect(estadoDeBanco('', CON_CATALOGO)).toBe('sin_clave');
    expect(estadoDeBanco(undefined, CON_CATALOGO)).toBe('sin_clave');
  });

  it('con catálogo sembrado, una clave que no está BLOQUEA', () => {
    const hs = bancoEnCatalogo([conPago('999')], CON_CATALOGO);
    expect(hs).toHaveLength(1);
    expect(hs[0].severity).toBe('blocking');
    expect(hs[0].detalle).toContain('999');
  });

  it('SIN CATÁLOGO NO APRUEBA EN SILENCIO: avisa de que no miró nada', () => {
    // Éste es el caso real hoy: la 064 creó `sat_bancos` VACÍA. Aprobar
    // cualquier cadena de tres caracteres porque la tabla está vacía es
    // inventarse una respuesta, igual que rechazarla.
    const hs = bancoEnCatalogo([conPago('012')], SIN_CATALOGO);
    expect(hs).toHaveLength(1);
    expect(hs[0].severity).toBe('warning');
    expect(hs[0].detalle).toContain('sat_bancos');
    expect(hs[0].detalle).toContain('no se miraron');
  });

  it('el aviso de «no hay catálogo» sale UNA vez, no una por póliza', () => {
    const hs = bancoEnCatalogo([conPago('012'), conPago('002'), conPago('072')], SIN_CATALOGO);
    expect(hs).toHaveLength(1);
  });

  it('con catálogo sembrado y clave válida, no dice nada', () => {
    expect(bancoEnCatalogo([conPago('012')], CON_CATALOGO)).toEqual([]);
  });
});

describe('el UUID del comprobante', () => {
  const conUuid = (uuid: string): Poliza =>
    p({
      transacciones: [
        t({ comprobantes: [{ clase: 'nacional', uuid, rfc: 'AAA010101AAA', montoTotal: '100.00' }] }),
      ],
    });

  it('sólo comprueba cuando se le pide: es `--validate-uuids`', () => {
    expect(uuidDeComprobante([conUuid('A-100')], false)).toEqual([]);
  });

  it('caza el folio tecleado a mano', () => {
    const hs = uuidDeComprobante([conUuid('A-100')], true);
    expect(hs).toHaveLength(1);
    expect(hs[0].severity).toBe('blocking');
  });

  it('acepta un folio fiscal bien formado', () => {
    expect(uuidDeComprobante([conUuid('A1B2C3D4-1111-2222-3333-444455556666')], true)).toEqual([]);
  });
});

describe('el renglón carga o abona', () => {
  it('un renglón con las dos cifras BLOQUEA: el signo queda ambiguo', () => {
    const hs = renglonConUnSoloLado([
      p({ transacciones: [t({ debe: '100.00', haber: '100.00' })] }),
    ]);
    expect(hs[0].severity).toBe('blocking');
  });

  it('un renglón en cero por los dos lados AVISA: suele ser el redondeo', () => {
    const hs = renglonConUnSoloLado([p({ transacciones: [t({ debe: '0.00', haber: '0.00' })] })]);
    expect(hs[0].severity).toBe('warning');
    expect(hs[0].detalle).toContain('redondear');
  });
});

describe('el texto que hubo que limpiar', () => {
  it('se DENUNCIA, con el texto que de verdad salió al archivo', () => {
    // El constructor rechaza el salto de línea dentro de un atributo, así que
    // limpiarlo es lo que permite que el archivo salga; callarlo entregaría un
    // texto que el contribuyente nunca escribió.
    const hs = textoNormalizado([
      { numUnIdenPol: 'JE-4', campo: 'Concepto de la póliza', texto: 'Pago de renta' },
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0].severity).toBe('warning');
    expect(hs[0].referencia).toBe('JE-4');
    expect(hs[0].detalle).toContain('Pago de renta');
  });
});

describe('el orquestador', () => {
  it('corre sólo las verificaciones pedidas', () => {
    const ctx = {
      polizas: [p({ transacciones: [t({ debe: '5.00', haber: '1.00' })] })],
      sinRastro: [{ numUnIdenPol: 'JE-9', motivo: 'x' }],
      sinComprobante: [],
      bancos: CON_CATALOGO,
      validarUuids: false,
      normalizados: [],
    };
    const soloRastro = correrVerificaciones(ctx, ['poliza-con-dinero-sin-rastro']);
    expect(soloRastro).toHaveLength(1);
    expect(soloRastro[0].check).toBe('poliza-con-dinero-sin-rastro');
  });

  it('no se detiene en el primer hallazgo: la lista entera es el producto', () => {
    const ctx = {
      polizas: [p({ transacciones: [t({ debe: '5.00', haber: '1.00' })] })],
      sinRastro: [{ numUnIdenPol: 'JE-9', motivo: 'x' }],
      sinComprobante: [],
      bancos: CON_CATALOGO,
      validarUuids: false,
      normalizados: [],
    };
    const hs = correrVerificaciones(ctx);
    expect(contarHallazgos(hs).blocking).toBeGreaterThanOrEqual(3);
  });

  it('los totales suman las dos columnas del archivo', () => {
    expect(totalesDePolizas([p()])).toEqual({ debe: '100.00', haber: '100.00' });
  });
});
