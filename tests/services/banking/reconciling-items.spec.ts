import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query, withTransaction } from '../../../src/database/connection.js';
import {
  asignarPartida,
  clasificarPartidas,
  derivarEscalamiento,
  listarPartidas,
  paraAritmetica,
  proponerPartida,
  reclasificarPartida,
} from '../../../src/services/banking/reconciling-items.js';
import { calcularAritmetica } from '../../../src/services/banking/reconciliation-math.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../src/utils/errors.js';
import { clienteFalso, type ReglaConsulta } from '../../helpers/fake-pg.js';

const mockQuery = query as unknown as Mock;
const mockTx = withTransaction as unknown as Mock;

/**
 * LOS DOS ESCRITORES DE PARTIDAS CORREN BAJO TRANSACCIÓN, y su primera consulta
 * es el candado sobre la SESIÓN.
 *
 * No es un detalle de implementación que estas pruebas tengan que conocer por
 * casualidad: `cerrarSesion` lee las partidas y DESPUÉS firma, y lo único que
 * hace segura esa distancia es que estos dos escritores esperen al mismo
 * candado. Un arnés que dejara pasar la reclasificación sin ese SELECT estaría
 * probando un mundo en el que `close` puede firmar aritmética obsoleta.
 */
function bajoTransaccion(
  filas: Record<string, unknown>[],
  sesion: Record<string, unknown> = { status: 'in_progress', closed_at: null },
  filasDespues?: Record<string, unknown>[]
): ReturnType<typeof clienteFalso> {
  const f = clienteFalso([
    { cuando: /SELECT status, to_char\(closed_at/, responde: { rows: [sesion] } },
    { cuando: /FROM reconciling_items ri/, responde: { rows: filas }, unaVez: filasDespues !== undefined },
    ...(filasDespues === undefined
      ? []
      : [{ cuando: /FROM reconciling_items ri/, responde: { rows: filasDespues } }]),
    { cuando: /UPDATE reconciling_items/, responde: { rowCount: 1 } },
  ]);
  mockTx.mockImplementation((fn: (c: unknown) => unknown) => Promise.resolve(fn(f.client)));
  return f;
}

/** La consulta que casa, del cliente de la transacción. */
const enTx = (f: ReturnType<typeof clienteFalso>, fragmento: RegExp) =>
  f.consultas.find((c) => fragmento.test(c.sql));

const filaCruda = (over: Record<string, unknown> = {}) => ({
  id: 'ri-1',
  tipo: 'cheque-en-circulacion',
  importe: '-15400.0000',
  fecha: '2026-03-01',
  antiguedad_dias: 92,
  responsable: null,
  fecha_esperada: null,
  escalamiento: 'ninguno',
  bank_transaction_id: null,
  journal_entry_line_id: 'jel-1',
  notas: 'Cheque 1042 a proveedor',
  resuelta_at: null,
  hoy: '2026-06-01',
  ...over,
});

const sesionEnCurso = {
  id: 'ses-1',
  bank_account_id: 'cta-1',
  end_date: '2026-03-31',
  status: 'in_progress',
  closed_at: null,
};

/** Las tres lecturas y el INSERT de `clasificarPartidas`, en reglas. */
function reglas(
  banco: Record<string, unknown>[],
  libros: Record<string, unknown>[],
  sesion: Record<string, unknown> = sesionEnCurso
): ReglaConsulta[] {
  return [
    { cuando: /FROM reconciliation_sessions/, responde: { rows: [sesion] } },
    { cuando: /FROM bank_transactions bt/, responde: { rows: banco } },
    { cuando: /FROM journal_entry_lines jel/, responde: { rows: libros } },
    { cuando: /INSERT INTO reconciling_items/, responde: { rowCount: 1 } },
  ];
}

const movimiento = (id: string, importe: string, fecha = '2026-03-05') => ({
  id,
  importe,
  fecha,
  descripcion: 'Comisión mensual',
});

const lineaDeLibros = (id: string, importe: string, fecha = '2026-03-05') => ({
  line_id: id,
  importe,
  fecha,
  descripcion: 'Cheque 1042',
});

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockTx.mockReset();
});

// ============================================================
// EL SIGNO, QUE ES DONDE ESTE FRENTE SE JUEGA
//
// `reconciliation-math.ts` suma sin un solo `if` por tipo porque confía en que
// el importe llega firmado por su APORTACIÓN. Estas pruebas son el otro lado de
// esa confianza: si la escritura invierte un signo, allá llegará un número
// plausible y la sesión descuadrará sin que nada lo señale.
// ============================================================

describe('proponerPartida · los cuatro casos del signo', () => {
  it('el cargo del extracto (negativo) se levanta como cargo-del-banco y RESTA a libros', () => {
    const p = proponerPartida('extracto', '-50.0000');
    expect(p).toEqual({ tipo: 'cargo-del-banco', lado: 'libros', importe: '-50.00' });
  });

  it('el abono del extracto (positivo) se levanta como abono-del-banco y SUMA a libros', () => {
    const p = proponerPartida('extracto', '20.0000');
    expect(p).toEqual({ tipo: 'abono-del-banco', lado: 'libros', importe: '20.00' });
  });

  it('el crédito de libros (negativo) es cheque-en-circulacion y RESTA al banco', () => {
    const p = proponerPartida('libros', '-30.0000');
    expect(p).toEqual({ tipo: 'cheque-en-circulacion', lado: 'banco', importe: '-30.00' });
  });

  it('el débito de libros (positivo) es deposito-en-transito y SUMA al banco', () => {
    const p = proponerPartida('libros', '40.0000');
    expect(p).toEqual({ tipo: 'deposito-en-transito', lado: 'banco', importe: '40.00' });
  });

  it('no convierte el signo: la aportación es el importe del origen tal cual', () => {
    // Ni un abs() ni un negated() en ninguno de los cuatro. Es la propiedad de
    // la que depende que no haya aritmética por tipo en el otro archivo.
    for (const importe of ['-50.0000', '20.0000', '-30.0000', '40.0000']) {
      for (const origen of ['extracto', 'libros'] as const) {
        expect(proponerPartida(origen, importe)?.importe).toBe(
          Number(importe).toFixed(2)
        );
      }
    }
  });

  it('devuelve null con importe cero: no hay signo que mirar', () => {
    expect(proponerPartida('extracto', '0')).toBeNull();
    expect(proponerPartida('libros', '0.0000')).toBeNull();
  });

  it('rechaza un importe ilegible en vez de tratarlo como cero', () => {
    expect(() => proponerPartida('extracto', '')).toThrow(ValidationError);
    expect(() => proponerPartida('libros', 'x')).toThrow(ValidationError);
  });

  it('conserva el cuarto decimal que la columna guarda', () => {
    expect(proponerPartida('extracto', '-0.1250')?.importe).toBe('-0.1250');
  });
});

describe('el signo propuesto CIERRA la aritmética de los cuatro casos', () => {
  // La comprobación de extremo a extremo del comentario de cabecera: lo que
  // esta capa escribe, sumado por `calcularAritmetica`, tiene que dar cero.
  const cerrar = (
    saldoBanco: string,
    saldoLibros: string,
    origen: 'extracto' | 'libros',
    importe: string
  ) => {
    const p = proponerPartida(origen, importe);
    expect(p).not.toBeNull();
    return calcularAritmetica({
      saldoBanco,
      saldoLibros,
      partidas: [{ tipo: p!.tipo, importe: p!.importe }],
    });
  };

  it('cheque de 30 sin cobrar: banco 130 y libros 100 cuadran', () => {
    const a = cerrar('130', '100', 'libros', '-30');
    expect(a.banco.ajustado).toBe('100.00');
    expect(a.variacion).toBe('0.00');
    expect(a.cuadra).toBe(true);
  });

  it('depósito de 40 en tránsito: banco 100 y libros 140 cuadran', () => {
    const a = cerrar('100', '140', 'libros', '40');
    expect(a.banco.ajustado).toBe('140.00');
    expect(a.cuadra).toBe(true);
  });

  it('comisión de 50 sin registrar: banco 50 y libros 100 cuadran', () => {
    const a = cerrar('50', '100', 'extracto', '-50');
    expect(a.libros.ajustado).toBe('50.00');
    expect(a.cuadra).toBe(true);
  });

  it('interés de 20 sin registrar: banco 120 y libros 100 cuadran', () => {
    const a = cerrar('120', '100', 'extracto', '20');
    expect(a.libros.ajustado).toBe('120.00');
    expect(a.cuadra).toBe(true);
  });

  it('con el signo INVERTIDO la cuenta deja de cuadrar, que es lo que estas pruebas protegen', () => {
    // El caso del cheque, escrito con el signo del movimiento en vez del de su
    // aportación: 130 + 30 = 160 contra 100.
    const a = calcularAritmetica({
      saldoBanco: '130',
      saldoLibros: '100',
      partidas: [{ tipo: 'cheque-en-circulacion', importe: '30' }],
    });
    expect(a.cuadra).toBe(false);
    expect(a.variacion).toBe('60.00');
  });
});

// ============================================================
// LA ANTIGÜEDAD Y EL ESCALAMIENTO
// ============================================================

describe('derivarEscalamiento · sin umbrales inventados', () => {
  it('vence el día DESPUÉS de la fecha esperada, no el mismo día', () => {
    expect(derivarEscalamiento('2026-06-01', '2026-06-01')).toBe('ninguno');
    expect(derivarEscalamiento('2026-06-01', '2026-06-02')).toBe('vencido');
  });

  it('una fecha esperada futura no escala', () => {
    expect(derivarEscalamiento('2026-12-31', '2026-06-01')).toBe('ninguno');
  });

  it('"avisado" es un hecho humano y sobrevive mientras no venza', () => {
    expect(derivarEscalamiento('2026-12-31', '2026-06-01', 'avisado')).toBe('avisado');
  });

  it('vencido gana a avisado cuando la fecha ya pasó', () => {
    expect(derivarEscalamiento('2026-01-01', '2026-06-01', 'avisado')).toBe('vencido');
  });

  it('un "vencido" guardado que la fecha contradice NO se conserva', () => {
    // La tesis del tramo aplicada a un campo pequeño: lo vivo manda, lo
    // guardado es la aseveración que se hizo.
    expect(derivarEscalamiento('2026-12-31', '2026-06-01', 'vencido')).toBe('ninguno');
  });

  it('sin fecha esperada no hay contra qué medir y se respeta lo escrito', () => {
    expect(derivarEscalamiento(null, '2026-06-01')).toBe('ninguno');
    expect(derivarEscalamiento(null, '2026-06-01', 'avisado')).toBe('avisado');
    expect(derivarEscalamiento('', '2026-06-01', 'avisado')).toBe('avisado');
  });
});

describe('listarPartidas', () => {
  it('calcula la antigüedad en días desde `fecha`, con el reloj de Postgres', async () => {
    mockQuery.mockResolvedValue({ rows: [filaCruda({ antiguedad_dias: 92 })], rowCount: 1 });
    const partidas = await listarPartidas('ent-1', 'ses-1');

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('(CURRENT_DATE - ri.fecha)::int');
    // `hoy` viaja en la MISMA consulta que la antigüedad: el escalamiento y los
    // días no se pueden medir con dos relojes distintos.
    expect(sql).toContain("to_char(CURRENT_DATE, 'YYYY-MM-DD')");
    expect(partidas[0].antiguedadDias).toBe(92);
  });

  it('acota por la entidad de la partida Y por la de su sesión', async () => {
    await listarPartidas('ent-1', 'ses-1');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ri.entity_id = $1');
    expect(sql).toContain('s.entity_id = $1');
    expect(sql).toContain('s.id = $2');
    expect(mockQuery.mock.calls[0][1]).toEqual(['ent-1', 'ses-1']);
  });

  it('por omisión sólo trae las abiertas: una resuelta ya no se persigue', async () => {
    await listarPartidas('ent-1', 'ses-1');
    expect(mockQuery.mock.calls[0][0] as string).toContain('ri.resuelta_at IS NULL');
  });

  it('filtra por antigüedad con `overDays`, en días y dentro del SQL', async () => {
    await listarPartidas('ent-1', 'ses-1', { overDays: 90 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('(CURRENT_DATE - ri.fecha) > $3::int');
    expect(params).toEqual(['ent-1', 'ses-1', 90]);
  });

  it('rechaza un `overDays` que no es un entero de días', async () => {
    await expect(listarPartidas('ent-1', 'ses-1', { overDays: 1.5 })).rejects.toThrow(ValidationError);
    await expect(listarPartidas('ent-1', 'ses-1', { overDays: -1 })).rejects.toThrow(ValidationError);
  });

  it('rechaza un tipo que el CHECK de la 053 no admite, y dice cuáles hay', async () => {
    await expect(listarPartidas('ent-1', 'ses-1', { tipo: 'cheque' })).rejects.toThrow(
      /cheque-en-circulacion/
    );
  });

  it('deriva el escalamiento vivo y CONSERVA el registrado al lado', async () => {
    mockQuery.mockResolvedValue({
      rows: [filaCruda({ fecha_esperada: '2026-05-01', escalamiento: 'ninguno', hoy: '2026-06-01' })],
      rowCount: 1,
    });
    const [p] = await listarPartidas('ent-1', 'ses-1');
    expect(p.escalamiento).toBe('vencido');
    expect(p.escalamientoRegistrado).toBe('ninguno');
  });

  it('deriva el lado del tipo en vez de leerlo de una columna', async () => {
    mockQuery.mockResolvedValue({ rows: [filaCruda({ tipo: 'cargo-del-banco' })], rowCount: 1 });
    const [p] = await listarPartidas('ent-1', 'ses-1');
    expect(p.lado).toBe('libros');
  });

  it('NO recorta a dos decimales lo que la columna guarda con cuatro', async () => {
    mockQuery.mockResolvedValue({ rows: [filaCruda({ importe: '-0.1250' })], rowCount: 1 });
    const [p] = await listarPartidas('ent-1', 'ses-1');
    expect(p.importe).toBe('-0.1250');
  });
});

describe('paraAritmetica', () => {
  it('entrega las partidas con el importe y la resolución que la suma espera', async () => {
    mockQuery.mockResolvedValue({
      rows: [filaCruda({ importe: '-30.0000', resuelta_at: '2026-04-02T10:00:00+00' })],
      rowCount: 1,
    });
    const partidas = await listarPartidas('ent-1', 'ses-1', { incluirResueltas: true });
    expect(paraAritmetica(partidas)).toEqual([
      {
        id: 'ri-1',
        tipo: 'cheque-en-circulacion',
        importe: '-30.00',
        fechaEsperada: null,
        resuelta: true,
      },
    ]);
  });
});

// ============================================================
// DESCUBRIR: LA QUE ESCRIBE EL SIGNO
// ============================================================

describe('clasificarPartidas', () => {
  it('escribe el cargo del extracto como cargo-del-banco, con su importe NEGATIVO', async () => {
    const f = clienteFalso(reglas([movimiento('bt-1', '-50.0000')], []));
    const r = await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');

    const insert = f.coincidencias(/INSERT INTO reconciling_items/)[0];
    expect(insert.params[3]).toBe('cargo-del-banco');
    expect(insert.params[6]).toBe('-50.00');
    expect(r.levantadas[0].lado).toBe('libros');
  });

  it('escribe el abono del extracto como abono-del-banco, con su importe POSITIVO', async () => {
    const f = clienteFalso(reglas([movimiento('bt-1', '20.0000')], []));
    await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    const insert = f.coincidencias(/INSERT INTO reconciling_items/)[0];
    expect(insert.params[3]).toBe('abono-del-banco');
    expect(insert.params[6]).toBe('20.00');
  });

  it('escribe el crédito de libros como cheque-en-circulacion, con su importe NEGATIVO', async () => {
    const f = clienteFalso(reglas([], [lineaDeLibros('jel-1', '-30.0000')]));
    await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    const insert = f.coincidencias(/INSERT INTO reconciling_items/)[0];
    expect(insert.params[3]).toBe('cheque-en-circulacion');
    expect(insert.params[6]).toBe('-30.00');
  });

  it('escribe el débito de libros como deposito-en-transito, con su importe POSITIVO', async () => {
    const f = clienteFalso(reglas([], [lineaDeLibros('jel-1', '40.0000')]));
    await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    const insert = f.coincidencias(/INSERT INTO reconciling_items/)[0];
    expect(insert.params[3]).toBe('deposito-en-transito');
    expect(insert.params[6]).toBe('40.00');
  });

  it('cuelga cada partida de UNA sola referencia, nunca de las dos', async () => {
    const f = clienteFalso(reglas([movimiento('bt-1', '-50')], [lineaDeLibros('jel-1', '-30')]));
    await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    const [delBanco, deLibros] = f.coincidencias(/INSERT INTO reconciling_items/);
    expect([delBanco.params[4], delBanco.params[5]]).toEqual(['bt-1', null]);
    expect([deLibros.params[4], deLibros.params[5]]).toEqual([null, 'jel-1']);
  });

  it('omite EN VOZ ALTA el movimiento de importe cero en vez de tipificarlo a la fuerza', async () => {
    const f = clienteFalso(reglas([movimiento('bt-0', '0.0000')], []));
    const r = await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    expect(r.levantadas).toHaveLength(0);
    expect(r.omitidas).toEqual([
      { origen: 'extracto', origenId: 'bt-0', importe: '0.0000', motivo: 'importe-cero' },
    ]);
    expect(f.coincidencias(/INSERT INTO reconciling_items/)).toHaveLength(0);
  });

  it('cuenta las que nacen sin fecha esperada: son todas, y por eso se dice', async () => {
    const f = clienteFalso(reglas([movimiento('bt-1', '-50')], [lineaDeLibros('jel-1', '-30')]));
    const r = await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    expect(r.sinFechaEsperada).toBe(2);
    for (const insert of f.coincidencias(/INSERT INTO reconciling_items/)) {
      // Ni `fecha_esperada` ni `responsable` aparecen en la sentencia: no se
      // inventa la fecha contra la que después se mide el escalamiento.
      expect(insert.sql).not.toContain('fecha_esperada');
      expect(insert.sql).not.toContain('responsable');
    }
  });

  it('nunca propone un error: un error es un juicio, no un signo', async () => {
    const f = clienteFalso(
      reglas([movimiento('bt-1', '-50'), movimiento('bt-2', '20')], [lineaDeLibros('jel-1', '-30')])
    );
    const r = await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    expect(r.levantadas.map((p) => p.tipo)).not.toContain('error-del-banco');
    expect(r.levantadas.map((p) => p.tipo)).not.toContain('error-de-libros');
  });

  it('pregunta por el cotejo VIVO y no por la bandera `is_matched`', async () => {
    const f = clienteFalso(reglas([], []));
    await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    const [consulta] = f.coincidencias(/FROM bank_transactions bt/);
    expect(consulta.sql).toContain('rm.unapplied_at IS NULL');
    expect(consulta.sql).not.toContain('bt.is_matched');
  });

  it('acota `bank_transactions` por JOIN a la cuenta, que es quien tiene entidad', async () => {
    const f = clienteFalso(reglas([], []));
    await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    const [consulta] = f.coincidencias(/FROM bank_transactions bt/);
    expect(consulta.sql).toContain('JOIN bank_accounts ba ON ba.id = bt.bank_account_id');
    expect(consulta.sql).toContain('ba.entity_id = $1');
  });

  it('acota los DOS extremos del join de libros', async () => {
    const f = clienteFalso(reglas([], []));
    await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    const [consulta] = f.coincidencias(/FROM journal_entry_lines jel/);
    expect(consulta.sql).toContain('je.entity_id = $1');
    expect(consulta.sql).toContain('ba.entity_id = $1');
  });

  it('no pone límite inferior de fecha: el cheque de enero es partida de marzo', async () => {
    const f = clienteFalso(reglas([], []));
    await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    for (const c of [
      // `SELECT … FROM`, y no cualquier consulta que nombre la tabla: la
      // resolución de partidas ya cotejadas también la menciona y no busca
      // candidatos, así que no está sujeta a estas propiedades.
      ...f.coincidencias(/SELECT[\s\S]*FROM bank_transactions bt/),
      ...f.coincidencias(/SELECT[\s\S]*FROM journal_entry_lines jel\b(?![\s\S]*SET )/),
    ]) {
      if (c.sql.startsWith('UPDATE')) continue;
      expect(c.sql).not.toContain('start_date');
      expect(c.sql).toContain('<= $3::date');
    }
  });

  it('se salta lo que la sesión ya levantó, RESUELTO INCLUIDO', async () => {
    // Filtrar por `resuelta_at IS NULL` aquí reabriría en cada pasada lo que
    // una persona ya explicó: el cheque que se cobró volvería a la lista, y el
    // desglose acumularía duplicados indistinguibles de los buenos.
    const f = clienteFalso(reglas([], []));
    await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    for (const c of [
      ...f.coincidencias(/SELECT[\s\S]*FROM bank_transactions bt/),
      ...f.coincidencias(/SELECT[\s\S]*FROM journal_entry_lines jel/),
    ]) {
      if (c.sql.startsWith('UPDATE')) continue;
      expect(c.sql).toContain('NOT EXISTS (SELECT 1 FROM reconciling_items ri');
      expect(c.sql).toContain('ri.entity_id = $1');
      expect(c.sql).not.toContain('ri.resuelta_at IS NULL');
    }
  });

  it('avisa cuando el tope recorta, para que 1000 no se lea como "no quedaba más"', async () => {
    const muchos = Array.from({ length: 3 }, (_, i) => movimiento(`bt-${i}`, '-10'));
    const f = clienteFalso(reglas(muchos, []));
    const r = await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1', { limite: 2 });
    expect(r.topeAlcanzado).toBe(true);
    expect(r.levantadas).toHaveLength(2);
  });

  it('rechaza una sesión que no está en curso: sus cifras son el resumen congelado', async () => {
    const f = clienteFalso(reglas([], [], { ...sesionEnCurso, status: 'balanced' }));
    await expect(clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1')).rejects.toThrow(ConflictError);
    expect(f.coincidencias(/INSERT INTO reconciling_items/)).toHaveLength(0);
  });

  it('rechaza una sesión cerrada aunque su estado siga diciendo in_progress', async () => {
    const f = clienteFalso(reglas([], [], { ...sesionEnCurso, closed_at: '2026-04-01' }));
    await expect(clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1')).rejects.toThrow(ConflictError);
  });

  it('una sesión de otra entidad no existe', async () => {
    const f = clienteFalso([{ cuando: /FROM reconciliation_sessions/, responde: { rows: [] } }]);
    await expect(clasificarPartidas(f.client, 'ent-1', 'ses-ajena', 'usr-1')).rejects.toThrow(NotFoundError);
  });

  it('bloquea la sesión mientras clasifica', async () => {
    const f = clienteFalso(reglas([], []));
    await clasificarPartidas(f.client, 'ent-1', 'ses-1', 'usr-1');
    expect(f.coincidencias(/FROM reconciliation_sessions/)[0].sql).toContain('FOR UPDATE');
  });
});

// ============================================================
// RECLASIFICAR: DONDE UN SIGNO HEREDADO DESCUADRARÍA EN SILENCIO
// ============================================================

describe('reclasificarPartida', () => {
  it('toma el candado de la SESIÓN antes de tocar nada', async () => {
    const f = bajoTransaccion([filaCruda({ tipo: 'cargo-del-banco', importe: '-50.0000' })]);
    await reclasificarPartida('ent-1', 'ses-1', 'ri-1', { tipo: 'error-de-libros' });
    const candado = enTx(f, /SELECT status, to_char\(closed_at/);
    expect(candado?.sql, 'sin FOR UPDATE, close puede firmar aritmética obsoleta').toContain(
      'FOR UPDATE'
    );
    expect(candado?.params).toEqual(['ses-1', 'ent-1']);
    // Y el candado va PRIMERO: leer la partida antes de tenerlo la haría leer
    // un mundo que otro puede mover.
    expect(f.consultas[0]).toBe(candado);
  });

  it('no toca una sesión que ya está cerrada', async () => {
    bajoTransaccion([filaCruda()], { status: 'balanced', closed_at: '2026-04-30' });
    await expect(
      reclasificarPartida('ent-1', 'ses-1', 'ri-1', { tipo: 'error-de-libros' })
    ).rejects.toThrow(ConflictError);
  });

  it('dentro del mismo lado conserva la aportación', async () => {
    const f = bajoTransaccion([filaCruda({ tipo: 'cargo-del-banco', importe: '-50.0000' })]);
    await reclasificarPartida('ent-1', 'ses-1', 'ri-1', { tipo: 'error-de-libros' });
    expect(enTx(f, /UPDATE reconciling_items/)?.params).toEqual([
      'error-de-libros', '-50.00', 'ri-1', 'ent-1', 'ses-1',
    ]);
  });

  it('EXIGE el importe cuando el tipo cambia de lado', async () => {
    const f = bajoTransaccion([filaCruda({ tipo: 'cargo-del-banco', importe: '-50.0000' })]);
    await expect(
      reclasificarPartida('ent-1', 'ses-1', 'ri-1', { tipo: 'error-del-banco' })
    ).rejects.toThrow(/aportación/);
    expect(enTx(f, /UPDATE reconciling_items/)).toBeUndefined();
  });

  it('acepta el cambio de lado cuando se declara la aportación nueva', async () => {
    const f = bajoTransaccion([filaCruda({ tipo: 'cargo-del-banco', importe: '-50.0000' })]);
    await reclasificarPartida('ent-1', 'ses-1', 'ri-1', {
      tipo: 'error-del-banco', importe: '120.5000',
    });
    expect(enTx(f, /UPDATE reconciling_items/)?.params?.[1]).toBe('120.50');
  });

  it('rechaza una aportación de cero: no explicaría ninguna diferencia', async () => {
    bajoTransaccion([filaCruda({ tipo: 'cargo-del-banco' })]);
    await expect(
      reclasificarPartida('ent-1', 'ses-1', 'ri-1', { tipo: 'cargo-del-banco', importe: '0' })
    ).rejects.toThrow(ValidationError);
  });

  it('no reclasifica una partida ya resuelta', async () => {
    bajoTransaccion([filaCruda({ resuelta_at: '2026-04-02T10:00:00+00' })]);
    await expect(
      reclasificarPartida('ent-1', 'ses-1', 'ri-1', { tipo: 'error-de-libros', importe: '-1' })
    ).rejects.toThrow(ConflictError);
  });

  it('una partida que no es de esta sesión no existe', async () => {
    bajoTransaccion([]);
    await expect(
      reclasificarPartida('ent-1', 'ses-1', 'ri-ajena', { tipo: 'error-de-libros' })
    ).rejects.toThrow(NotFoundError);
  });
});

describe('asignarPartida', () => {
  it('escribe responsable y fecha esperada, que es lo que hace perseguible una partida', async () => {
    const f = bajoTransaccion([filaCruda()]);
    await asignarPartida('ent-1', 'ses-1', 'ri-1', {
      responsable: 'tesorería',
      fechaEsperada: '2026-07-01',
    });
    const update = enTx(f, /UPDATE reconciling_items/);
    expect(update?.sql).toContain('responsable = $1');
    expect(update?.sql).toContain('fecha_esperada = $2::date');
    expect(update?.params).toEqual(['tesorería', '2026-07-01', 'ri-1', 'ent-1', 'ses-1']);
  });

  it('toma el candado de la SESIÓN y exige que siga en curso', async () => {
    // Es la hoja que escribe `fecha_esperada`, que es una de las dos cosas que
    // `close` verifica antes de firmar. Sin candado se puede mover entre la
    // lectura de `close` y su UPDATE; sobre una sesión cerrada, el desglose
    // vivo se separa del resumen congelado sin que nadie haya reabierto nada.
    const f = bajoTransaccion([filaCruda()]);
    await asignarPartida('ent-1', 'ses-1', 'ri-1', { fechaEsperada: '2026-07-01' });
    expect(f.consultas[0].sql).toContain('FOR UPDATE');
    expect(enTx(f, /UPDATE reconciling_items/)?.sql).toContain("s.status = 'in_progress'");

    bajoTransaccion([filaCruda()], { status: 'balanced', closed_at: '2026-04-30' });
    await expect(
      asignarPartida('ent-1', 'ses-1', 'ri-1', { fechaEsperada: '2026-07-01' })
    ).rejects.toThrow(ConflictError);
  });

  it('NO deja marcar "vencido" a mano: lo dice el calendario', async () => {
    await expect(
      asignarPartida('ent-1', 'ses-1', 'ri-1', { escalamiento: 'vencido' })
    ).rejects.toThrow(/no se marca a mano/);
  });

  it('acepta "avisado", que es el hecho humano que ninguna fecha sabe', async () => {
    const f = bajoTransaccion([filaCruda()]);
    await asignarPartida('ent-1', 'ses-1', 'ri-1', { escalamiento: 'avisado' });
    expect(enTx(f, /UPDATE reconciling_items/)?.params?.[0]).toBe('avisado');
  });

  it('rechaza una fecha esperada que no es YYYY-MM-DD', async () => {
    await expect(
      asignarPartida('ent-1', 'ses-1', 'ri-1', { fechaEsperada: '01/07/2026' })
    ).rejects.toThrow(ValidationError);
  });

  it('rechaza una llamada que no asigna nada', async () => {
    await expect(asignarPartida('ent-1', 'ses-1', 'ri-1', {})).rejects.toThrow(ValidationError);
  });
});
