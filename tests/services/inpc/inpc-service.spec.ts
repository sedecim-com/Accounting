import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  exigirFuenteInpc,
  factorEntrePeriodos,
  importarSerie,
  listarSerie,
  resolverIndice,
  verificarSerie,
  type RenglonInpc,
} from '../../../src/services/fiscal/inpc/inpc-service.js';
import { parsearSerieInpc } from '../../../src/services/fiscal/inpc/parseo.js';
import { query } from '../../../src/database/connection.js';
import { AccountingError, ConflictError, ValidationError } from '../../../src/utils/errors.js';

/**
 * LA RESOLUCIÓN FALLA CERRADO — SIN POSTGRES DETRÁS.
 *
 * El molde es R4: si el mes pedido no está, se lanza NOMBRÁNDOLO en vez de
 * arrastrar el anterior. Aquí importa más que en el tipo de cambio, porque
 * arrastrar el INPC no produce un número raro: produce 1.0000, que es
 * indistinguible de «no hubo inflación» y que el catálogo prohibió por escrito.
 *
 * El pool se sustituye por un despachador que responde según el SQL. Sembrar
 * una serie real para preguntar «¿y si falta marzo?» habría garantizado que
 * el caso no se escribiera.
 */

const mockQuery = query as unknown as Mock;

const B2018 = '2018-Jul2=100';
const B2010 = '2010=100';
const AUTOR = '4f1a2b3c-0000-4000-8000-000000000001';

const fila = (
  anio: number,
  mes: number,
  valor: string,
  base = B2018,
  over: Partial<RenglonInpc> = {}
): RenglonInpc => ({
  anio,
  mes,
  valor,
  base,
  fuente: 'dof',
  publicado_el: null,
  capturado_el: '2025-01-10T00:00:00.000Z',
  capturado_por: AUTOR,
  ...over,
});

interface Guion {
  /** Filas que la serie contiene, para resolverIndice y listarSerie. */
  serie?: RenglonInpc[];
  /** Filas ya guardadas que la importación encontrará. */
  existentes?: Array<{ anio: number; mes: number; base: string; valor: string }>;
  /** Cuántas filas dice haber insertado el INSERT. */
  insertadas?: number;
}

/** Registra los INSERT ejecutados, para probar que un dry-run no escribe. */
let inserts: Array<{ sql: string; params: unknown[] }> = [];

function montar(guion: Guion = {}): void {
  const serie = guion.serie ?? [];
  inserts = [];
  mockQuery.mockImplementation((sql?: unknown, params?: unknown) => {
    const q = typeof sql === 'string' ? sql : '';
    const p = (params ?? []) as unknown[];

    if (q.includes('INSERT INTO inpc_serie')) {
      inserts.push({ sql: q, params: p });
      return Promise.resolve({ rows: [], rowCount: guion.insertadas ?? (p[0] as number[]).length });
    }
    if (q.includes('(anio, mes, base) IN')) {
      return Promise.resolve({ rows: guion.existentes ?? [] });
    }
    if (q.startsWith('SELECT base FROM inpc_serie')) {
      const [anio, mes] = p as [number, number];
      return Promise.resolve({
        rows: serie.filter((f) => f.anio === anio && f.mes === mes).map((f) => ({ base: f.base })),
      });
    }
    if (q.includes('WHERE anio = $1 AND mes = $2')) {
      const [anio, mes, base] = p as [number, number, string | null];
      return Promise.resolve({
        rows: serie.filter(
          (f) => f.anio === anio && f.mes === mes && (base === null || f.base === base)
        ),
      });
    }
    // listarSerie
    return Promise.resolve({ rows: serie });
  });
}

beforeEach(() => mockQuery.mockReset());

describe('exigirFuenteInpc', () => {
  it('acepta las tres del CHECK de la 065 y rechaza el resto', () => {
    expect(exigirFuenteInpc('dof')).toBe('dof');
    expect(exigirFuenteInpc('inegi')).toBe('inegi');
    expect(exigirFuenteInpc('manual')).toBe('manual');
    expect(() => exigirFuenteInpc('banxico')).toThrow(ValidationError);
  });
});

describe('resolverIndice — falla cerrado', () => {
  it('devuelve el índice cuando el mes está una sola vez', async () => {
    montar({ serie: [fila(2024, 3, '132.373000')] });
    const i = await resolverIndice({ anio: 2024, mes: 3 });
    expect(i.valor).toBe('132.373000');
    expect(i.base).toBe(B2018);
    expect(i.fuente).toBe('dof');
  });

  it('SE NIEGA ante un mes ausente en vez de arrastrar el anterior', async () => {
    montar({ serie: [fila(2024, 2, '133.681')] });
    const err = await resolverIndice({ anio: 2024, mes: 3 }).catch((e: unknown) => e as AccountingError);
    expect(err).toBeInstanceOf(AccountingError);
    expect((err as AccountingError).code).toBe('INPC_SIN_INDICE');
    // El mensaje nombra el mes que falta: es lo único que permite arreglarlo.
    expect((err as AccountingError).message).toContain('marzo de 2024');
    expect((err as AccountingError).message).toContain('1.0000');
  });

  it('cuando falta en la base pedida, dice en cuáles SÍ está', async () => {
    montar({ serie: [fila(2018, 1, '128.832', B2010)] });
    const err = (await resolverIndice({ anio: 2018, mes: 1 }, { base: B2018 }).catch(
      (e: unknown) => e
    )) as AccountingError;
    expect(err.code).toBe('INPC_SIN_INDICE');
    expect(err.message).toContain(B2010);
  });

  it('SE NIEGA a elegir base cuando el mes está cargado en dos', async () => {
    montar({ serie: [fila(2018, 1, '128.832', B2010), fila(2018, 1, '98.795', B2018)] });
    const err = (await resolverIndice({ anio: 2018, mes: 1 }).catch((e: unknown) => e)) as AccountingError;
    expect(err.code).toBe('INPC_BASE_AMBIGUA');
    expect(err.details).toMatchObject({ bases: [B2010, B2018] });
  });

  it('con la base declarada, el mes ambiguo se resuelve', async () => {
    montar({ serie: [fila(2018, 1, '128.832', B2010), fila(2018, 1, '98.795', B2018)] });
    const i = await resolverIndice({ anio: 2018, mes: 1 }, { base: B2018 });
    expect(i.valor).toBe('98.795');
  });
});

describe('factorEntrePeriodos — la guarda sobrevive al viaje por la base', () => {
  it('calcula el factor cuando las dos puntas comparten base', async () => {
    montar({ serie: [fila(2022, 12, '126.478'), fila(2023, 12, '132.373')] });
    const r = await factorEntrePeriodos({ anio: 2022, mes: 12 }, { anio: 2023, mes: 12 });
    expect(r.factor).toBe('1.0466');
    expect(r.fuentes).toEqual({ antiguo: 'dof', reciente: 'dof' });
  });

  it('SE NIEGA cuando cada punta vive en una base distinta', async () => {
    montar({ serie: [fila(2018, 1, '128.832', B2010), fila(2024, 3, '133.555', B2018)] });
    const err = (await factorEntrePeriodos({ anio: 2018, mes: 1 }, { anio: 2024, mes: 3 }).catch(
      (e: unknown) => e
    )) as AccountingError;
    expect(err.code).toBe('INPC_BASES_DISTINTAS');
  });

  it('nombra la punta que falta, no «el periodo»', async () => {
    montar({ serie: [fila(2022, 12, '126.478')] });
    const err = (await factorEntrePeriodos({ anio: 2022, mes: 12 }, { anio: 2023, mes: 12 }).catch(
      (e: unknown) => e
    )) as AccountingError;
    expect(err.code).toBe('INPC_SIN_INDICE');
    expect(err.message).toContain('diciembre de 2023');
  });
});

describe('importarSerie', () => {
  const filas = () => parsearSerieInpc('2024,1,132.373\n2024,2,133.681\n', { base: B2018 });

  it('exige autor aunque la columna admita NULL', async () => {
    montar();
    await expect(
      importarSerie({ filas: filas(), fuente: 'dof', capturadoPor: '  ' })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(inserts).toHaveLength(0);
  });

  it('rechaza una fuente que el CHECK no admite', async () => {
    montar();
    await expect(
      importarSerie({ filas: filas(), fuente: 'banxico' as 'dof', capturadoPor: AUTOR })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('inserta lo nuevo y firma con el autor', async () => {
    montar({ existentes: [] });
    const r = await importarSerie({ filas: filas(), fuente: 'dof', capturadoPor: AUTOR });
    expect(r).toMatchObject({ ofrecidas: 2, insertadas: 2, yaEstaban: 0, dryRun: false });
    expect(r.primero).toBe('2024-01');
    expect(r.ultimo).toBe('2024-02');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[5]).toBe('dof');
    expect(inserts[0].params[6]).toBe(AUTOR);
  });

  it('es idempotente por mes y base: repetir el archivo no reinserta', async () => {
    // El valor guardado vuelve como DECIMAL(12,6) —«132.373000»— y el archivo
    // trae «132.373». La comparación es numérica, no de texto, o cada segunda
    // carga parecería una contradicción.
    montar({
      existentes: [
        { anio: 2024, mes: 1, base: B2018, valor: '132.373000' },
        { anio: 2024, mes: 2, base: B2018, valor: '133.681000' },
      ],
    });
    const r = await importarSerie({ filas: filas(), fuente: 'dof', capturadoPor: AUTOR });
    expect(r).toMatchObject({ insertadas: 0, yaEstaban: 2 });
    expect(inserts).toHaveLength(0);
  });

  it('ACUSA el mes que ya está con otro valor en vez de ignorarlo', async () => {
    montar({ existentes: [{ anio: 2024, mes: 1, base: B2018, valor: '132.300000' }] });
    const err = (await importarSerie({
      filas: filas(),
      fuente: 'dof',
      capturadoPor: AUTOR,
    }).catch((e: unknown) => e)) as ConflictError;
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toContain('2024-01');
    expect(err.message).toContain('132.300000');
    expect(err.message).toContain('132.373');
    expect(inserts).toHaveLength(0);
  });

  it('el dry-run cuenta y no escribe', async () => {
    montar({ existentes: [] });
    const r = await importarSerie({
      filas: filas(),
      fuente: 'inegi',
      capturadoPor: AUTOR,
      dryRun: true,
    });
    expect(r).toMatchObject({ insertadas: 2, dryRun: true });
    expect(inserts).toHaveLength(0);
  });

  it('rechaza una carga sin filas', async () => {
    montar();
    await expect(
      importarSerie({ filas: [], fuente: 'dof', capturadoPor: AUTOR })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('verificarSerie', () => {
  it('la serie vacía es hallazgo BLOQUEANTE', async () => {
    montar({ serie: [] });
    const r = await verificarSerie({ hasta: { anio: 2024, mes: 12 } });
    expect(r.peor).toBe('fail');
    expect(r.checks[0]).toMatchObject({ name: 'inpc-serie', level: 'fail' });
    expect(r.checks[0].fix).toContain('inpc import');
  });

  it('nombra los meses que faltan hasta el periodo pedido', async () => {
    montar({ serie: [fila(2024, 1, '132.373'), fila(2024, 4, '134.336')] });
    const r = await verificarSerie({ hasta: { anio: 2024, mes: 4 } });
    const huecos = r.checks.find((c) => c.name === 'inpc-huecos');
    expect(huecos?.level).toBe('fail');
    expect(huecos?.detail).toContain('2024-02');
    expect(huecos?.detail).toContain('2024-03');
    expect(r.peor).toBe('fail');
  });

  it('el mes que falta AL FINAL también es hueco: la serie tiene que llegar', async () => {
    montar({ serie: [fila(2024, 1, '132.373'), fila(2024, 2, '133.681')] });
    const r = await verificarSerie({ hasta: { anio: 2024, mes: 4 } });
    expect(r.checks.find((c) => c.name === 'inpc-huecos')?.detail).toContain('2024-04');
  });

  it('una serie continua sale limpia', async () => {
    montar({ serie: [fila(2024, 1, '132.373'), fila(2024, 2, '133.681')] });
    const r = await verificarSerie({ hasta: { anio: 2024, mes: 2 } });
    expect(r.peor).toBe('ok');
  });

  it('avisa —sin bloquear— del mes cargado en dos bases', async () => {
    montar({ serie: [fila(2018, 1, '128.832', B2010), fila(2018, 1, '98.795', B2018)] });
    const r = await verificarSerie({ hasta: { anio: 2018, mes: 1 } });
    const bases = r.checks.find((c) => c.name === 'inpc-bases');
    expect(bases?.level).toBe('warn');
    expect(r.peor).toBe('warn');
  });

  it('un mes en dos bases no cuenta como dos meses al buscar huecos', async () => {
    montar({ serie: [fila(2018, 1, '128.832', B2010), fila(2018, 1, '98.795', B2018)] });
    const r = await verificarSerie({ hasta: { anio: 2018, mes: 1 } });
    expect(r.checks.find((c) => c.name === 'inpc-huecos')?.level).toBe('ok');
  });
});

describe('listarSerie', () => {
  it('compara (anio, mes) como par ordenado, no por separado', async () => {
    montar({ serie: [fila(2023, 7, '130.0'), fila(2024, 3, '133.555')] });
    await listarSerie({ desde: { anio: 2023, mes: 7 }, hasta: { anio: 2024, mes: 3 } });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('(anio, mes) >= ($1::smallint, $2::smallint)');
    expect(sql).toContain('(anio, mes) <= ($3::smallint, $4::smallint)');
    expect(params).toEqual([2023, 7, 2024, 3]);
  });
});
