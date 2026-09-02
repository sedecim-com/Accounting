import { describe, it, expect, vi, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  currentTenant: vi.fn(() => null),
}));

vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
}));

import {
  construirInstantanea,
  criteriosDeCierre,
  hashDeInstantanea,
  serializacionCanonica,
  type EntradaDeInstantanea,
  type MiembroCotejo,
} from '../../../src/services/banking/reconciliation-service.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import {
  FLOOR_MAX_TOLERANCIA_CONCILIACION,
  floorTolerancia,
} from '../../../src/ai/floor.js';
import type { Aritmetica } from '../../../src/services/banking/reconciliation-math.js';
import type { PartidaConciliatoria } from '../../../src/services/banking/reconciling-items.js';
import type { AjusteDeSesion } from '../../../src/services/banking/reconciliation-adjustments.js';
import { ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// LA FIRMA (F05d · 055)
//
// El hash es lo único que permite contestar «¿esto es lo que se aprobó?» con un
// sí o un no. Si el mismo contenido puede dar dos dígitos distintos según en
// qué orden lo ensamblaron, la pregunta no tiene respuesta — y el orden CAMBIA
// de verdad: `approval_snapshot` es JSONB y Postgres no conserva el orden de
// las claves.
// ============================================================

const partida = (over: Partial<PartidaConciliatoria> = {}): PartidaConciliatoria => ({
  id: 'ri-1',
  tipo: 'cheque-en-circulacion',
  lado: 'banco',
  importe: '-15400.0000',
  fecha: '2026-03-01',
  antiguedadDias: 92,
  responsable: 'tesorería',
  fechaEsperada: '2026-04-30',
  escalamiento: 'ninguno',
  escalamientoRegistrado: 'ninguno',
  bankTransactionId: null,
  journalEntryLineId: 'jel-1',
  notas: null,
  resuelta: false,
  resueltaEl: null,
  ...over,
});

const ajuste = (over: Partial<AjusteDeSesion> = {}): AjusteDeSesion => ({
  id: 'adj-1',
  tipo: 'comision',
  importe: '-350.00',
  reconcilingItemId: 'ri-2',
  draftId: 'draft-1',
  estadoDelBorrador: 'pending_review',
  journalEntryId: null,
  creadoEl: '2026-04-01T10:00:00-06',
  creadoPor: 'user-1',
  ...over,
});

const cotejo = (over: Partial<MiembroCotejo> = {}): MiembroCotejo => ({
  id: 'rm-1',
  grupoId: 'grp-1',
  bankTransactionId: 'bt-1',
  tipo: 'journal_entry_line',
  entidadId: 'jel-9',
  importe: '4200.00',
  parcial: false,
  ...over,
});

const aritmetica = (over: Partial<Aritmetica> = {}): Aritmetica => ({
  banco: {
    saldo: '100000.00',
    partidas: [
      { tipo: 'cheque-en-circulacion', importe: '-15400.0000' },
      { tipo: 'deposito-en-transito', importe: '0.00' },
    ],
    ajustado: '84600.0000',
  },
  libros: {
    saldo: '84950.00',
    partidas: [{ tipo: 'cargo-del-banco', importe: '-350.00' }],
    ajustado: '84600.00',
  },
  variacion: '0.0000',
  cuadra: true,
  sinClasificar: 0,
  sinFechar: 0,
  tolerancia: '0',
  resueltas: 0,
  reparos: [],
  ...over,
});

const entrada = (over: Partial<EntradaDeInstantanea> = {}): EntradaDeInstantanea => ({
  sesion: {
    id: 'ses-1',
    entityId: 'ent-1',
    bankAccountId: 'cta-1',
    statementId: 'stm-1',
    desde: '2026-03-01',
    hasta: '2026-03-31',
    moneda: 'MXN',
  },
  aritmetica: aritmetica(),
  congelado: {
    variance: '0.0000',
    saldoLibros: '84950.00',
    chequesEnCirculacion: '-15400.0000',
    depositosEnTransito: '0.00',
    cargosDelBanco: '-350.00',
    abonosDelBanco: '0.00',
    otrosAjustes: '0.00',
    aritmeticaCalculadaEl: '2026-04-01T12:00:00+00:00',
  },
  partidas: [partida(), partida({ id: 'ri-2', tipo: 'cargo-del-banco', lado: 'libros', importe: '-350.00' })],
  cotejos: [cotejo(), cotejo({ id: 'rm-2', bankTransactionId: 'bt-2', entidadId: 'jel-8' })],
  ajustes: [ajuste()],
  ...over,
});

/** El mismo documento con TODAS las claves en orden inverso, en todos los niveles. */
function conClavesAlReves(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map((v) => conClavesAlReves(v));
  if (valor !== null && typeof valor === 'object') {
    const salida: Record<string, unknown> = {};
    for (const k of Object.keys(valor as Record<string, unknown>).reverse()) {
      salida[k] = conClavesAlReves((valor as Record<string, unknown>)[k]);
    }
    return salida;
  }
  return valor;
}

// ============================================================
// LA SERIALIZACIÓN DETERMINISTA
// ============================================================

describe('serializacionCanonica', () => {
  it('ordena las claves: el mismo objeto escrito al revés da la misma cadena', () => {
    // Éste es el caso REAL y no uno de laboratorio: `approval_snapshot` es
    // JSONB, y el documento que se relee para verificar la firma vuelve con las
    // claves en el orden de Postgres, no en el que se escribieron.
    const a = { beta: '2', alfa: '1', gamma: { z: true, a: null } };
    const b = { gamma: { a: null, z: true }, alfa: '1', beta: '2' };

    expect(serializacionCanonica(a)).toBe(serializacionCanonica(b));
    expect(serializacionCanonica(a)).toBe('{"alfa":"1","beta":"2","gamma":{"a":null,"z":true}}');
  });

  it('ordena las filas de una lista: en este documento toda lista es un conjunto', () => {
    const a = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
    const b = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];

    expect(serializacionCanonica(a)).toBe(serializacionCanonica(b));
  });

  it('distingue el nulo observado del dato ausente', () => {
    // Medio F05c es esta distinción: un saldo que nadie observó no es cero, y
    // un hash que los confunde firmaría los dos documentos como si fueran uno.
    expect(serializacionCanonica({ saldo: null })).not.toBe(serializacionCanonica({}));
  });

  it('falla cerrado ante un número no finito', () => {
    expect(() => serializacionCanonica({ x: Number.NaN })).toThrow(ValidationError);
    expect(() => serializacionCanonica({ x: Number.POSITIVE_INFINITY })).toThrow(/no admite el número/);
  });

  it('falla cerrado ante lo que no sabe volver a serializar igual', () => {
    expect(() => serializacionCanonica({ f: () => 1 })).toThrow(ValidationError);
  });
});

// ============================================================
// EL HASH
// ============================================================

describe('hashDeInstantanea', () => {
  it('el MISMO contenido en distinto orden da el MISMO hash', () => {
    const derecho = construirInstantanea(entrada());
    const alReves = construirInstantanea(
      entrada({
        partidas: [...entrada().partidas].reverse(),
        cotejos: [...entrada().cotejos].reverse(),
      })
    );

    expect(hashDeInstantanea(alReves)).toBe(hashDeInstantanea(derecho));
  });

  it('sobrevive al viaje por JSONB, que devuelve las claves en otro orden', () => {
    // Postgres NO conserva el orden de las claves de un jsonb. `conClavesAlReves`
    // imita el peor caso de esa relectura: mismo documento, todas las claves
    // invertidas, en todos los niveles. Sin la ordenación del serializador,
    // verificar una firma intacta habría contestado «no coincide».
    const original = construirInstantanea(entrada());
    const releido = conClavesAlReves(original) as typeof original;

    expect(JSON.stringify(Object.keys(releido))).not.toBe(JSON.stringify(Object.keys(original)));
    expect(hashDeInstantanea(releido)).toBe(hashDeInstantanea(original));
  });

  it('un importe distinto en una partida da un hash distinto', () => {
    const base = construirInstantanea(entrada());
    const tocada = construirInstantanea(
      entrada({ partidas: [partida({ importe: '-15400.0001' }), entrada().partidas[1]] })
    );

    expect(hashDeInstantanea(tocada)).not.toBe(hashDeInstantanea(base));
  });

  it('una partida de más da un hash distinto', () => {
    const base = construirInstantanea(entrada());
    const conMas = construirInstantanea(
      entrada({ partidas: [...entrada().partidas, partida({ id: 'ri-3' })] })
    );

    expect(hashDeInstantanea(conMas)).not.toBe(hashDeInstantanea(base));
  });

  it('un cotejo retirado da un hash distinto', () => {
    const base = construirInstantanea(entrada());
    const sinUno = construirInstantanea(entrada({ cotejos: [cotejo()] }));

    expect(hashDeInstantanea(sinUno)).not.toBe(hashDeInstantanea(base));
  });

  it('un ajuste de otro importe da un hash distinto', () => {
    const base = construirInstantanea(entrada());
    const otro = construirInstantanea(entrada({ ajustes: [ajuste({ importe: '-351.00' })] }));

    expect(hashDeInstantanea(otro)).not.toBe(hashDeInstantanea(base));
  });

  it('una variación distinta da un hash distinto, aunque los miembros sean los mismos', () => {
    const base = construirInstantanea(entrada());
    const movida = construirInstantanea(
      entrada({ aritmetica: aritmetica({ variacion: '0.0100', cuadra: false }) })
    );

    expect(hashDeInstantanea(movida)).not.toBe(hashDeInstantanea(base));
  });

  it('una tolerancia distinta da un hash distinto: bajo qué regla cuadró es parte de lo que se firma', () => {
    const base = construirInstantanea(entrada());
    const conTolerancia = construirInstantanea(
      entrada({ aritmetica: aritmetica({ tolerancia: '5.0000' }) })
    );

    expect(hashDeInstantanea(conTolerancia)).not.toBe(hashDeInstantanea(base));
  });

  it('un saldo NO OBSERVADO no hashea como un saldo de cero', () => {
    const cero = construirInstantanea(
      entrada({ aritmetica: aritmetica({ libros: { saldo: '0.00', partidas: [], ajustado: '0.00' } }) })
    );
    const sinObservar = construirInstantanea(
      entrada({ aritmetica: aritmetica({ libros: { saldo: null, partidas: [], ajustado: null } }) })
    );

    expect(hashDeInstantanea(sinObservar)).not.toBe(hashDeInstantanea(cero));
  });

  it('lo que sólo depende del reloj NO entra en la firma', () => {
    // La antigüedad en días y el escalamiento vivo se derivan de la fecha de
    // hoy. Firmarlos haría que el mismo contenido diera otro hash mañana, y
    // «¿esto es lo que se aprobó?» contestaría «no» sobre una sesión intacta.
    const hoy = construirInstantanea(entrada());
    const manana = construirInstantanea(
      entrada({
        partidas: [
          partida({ antiguedadDias: 93, escalamiento: 'vencido' }),
          entrada().partidas[1],
        ],
      })
    );

    expect(hashDeInstantanea(manana)).toBe(hashDeInstantanea(hoy));
  });

  it('es un sha256 hexadecimal de 64 caracteres, que es lo que la columna guarda', () => {
    // `approval_hash` es CHAR(64) en la 055: un hash más corto no cabría y uno
    // más largo se truncaría en silencio.
    expect(hashDeInstantanea(construirInstantanea(entrada()))).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================
// EL TECHO DE LA TOLERANCIA
// ============================================================

describe('floorTolerancia', () => {
  it('deja pasar lo que cabe debajo del techo', () => {
    expect(floorTolerancia('0.5000')).toBe('0.5000');
    expect(floorTolerancia('499.9999')).toBe('499.9999');
  });

  it('acota por el MÍNIMO lo que lo pasa: ninguna bandera sube el piso', () => {
    expect(floorTolerancia('5000.0000')).toBe(FLOOR_MAX_TOLERANCIA_CONCILIACION);
    expect(floorTolerancia('999999999.9999')).toBe(FLOOR_MAX_TOLERANCIA_CONCILIACION);
  });

  it('falla CERRADO ante lo ilegible, lo no finito y lo negativo', () => {
    // Un `Number('')` daría 0 y un `parseFloat('1e400')` daría Infinity: las
    // dos formas son cómo un campo mal capturado se vuelve un cuadre falso.
    expect(floorTolerancia('')).toBe('0.0000');
    expect(floorTolerancia('mucho')).toBe('0.0000');
    expect(floorTolerancia('Infinity')).toBe('0.0000');
    expect(floorTolerancia('-10.0000')).toBe('0.0000');
  });

  it('no recorta a dos decimales lo que la columna guarda con cuatro', () => {
    expect(floorTolerancia('0.1234')).toBe('0.1234');
  });
});

describe('criteriosDeCierre · el techo de `--tolerance`', () => {
  const conPolitica = (tolerancia: string): void => {
    (getPolicy as unknown as Mock).mockImplementation((_ctx: unknown, key: string) =>
      Promise.resolve({
        key,
        value: key === 'conciliacion_tolerancia' ? tolerancia : 'bloquear_cierre',
        defined: true,
        question: '',
        rationale: null,
      })
    );
  };

  it('rechaza NOMBRANDO los dos números la tolerancia que pasa del techo', async () => {
    // Sin este tope se podía cerrar cualquier descuadre llamándolo tolerancia,
    // y `period-close.ts` lee la sesión cerrada como la evidencia de que el
    // efectivo se verificó contra el banco.
    conPolitica('tolerancia_con_residual');

    await expect(criteriosDeCierre('t-1', 'ent-1', '5000')).rejects.toThrow(ValidationError);
    await expect(criteriosDeCierre('t-1', 'ent-1', '5000')).rejects.toThrow(
      new RegExp(`5000\\.0000.*${FLOOR_MAX_TOLERANCIA_CONCILIACION.replace('.', '\\.')}`, 's')
    );
  });

  it('deja pasar la que cabe, con sus cuatro decimales intactos', async () => {
    conPolitica('tolerancia_con_residual');

    const c = await criteriosDeCierre('t-1', 'ent-1', '12.3456');
    expect(c.tolerancia.tolerancia).toBe('12.3456');
  });

  it('sigue rechazando `--tolerance` cuando la política es cero_exacto, antes de mirar el techo', async () => {
    // El techo no reemplaza al criterio del panel: una bandera no afloja lo que
    // el despacho ya fijó, y el mensaje tiene que seguir mandando al panel.
    conPolitica('cero_exacto');

    await expect(criteriosDeCierre('t-1', 'ent-1', '1')).rejects.toThrow(/pending resolve/);
  });

  it('sin bandera la tolerancia es cero, y no el techo', async () => {
    conPolitica('tolerancia_con_residual');

    const c = await criteriosDeCierre('t-1', 'ent-1');
    expect(c.tolerancia.tolerancia).toBe('0');
  });
});
