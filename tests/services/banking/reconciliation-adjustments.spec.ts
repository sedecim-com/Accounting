import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/ai/draft-service.js', () => ({
  createDraft: vi.fn(),
}));
vi.mock('../../../src/ai/context.js', () => ({
  resolveEntity: vi.fn(),
}));

import { query } from '../../../src/database/connection.js';
import { createDraft } from '../../../src/ai/draft-service.js';
import { resolveEntity } from '../../../src/ai/context.js';
import {
  CONFIANZA_POR_OMISION,
  ROLES_QUE_FALTAN,
  ROL_DE_AJUSTE,
  TIPOS_DE_AJUSTE,
  crearAjuste,
  direccionDeAjuste,
  lineasDelAjuste,
  listarAjustes,
} from '../../../src/services/banking/reconciliation-adjustments.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const mockCrearBorrador = createDraft as unknown as Mock;
const mockResolverEntidad = resolveEntity as unknown as Mock;

const sesion = {
  id: 'ses-1',
  bank_account_id: 'cta-1',
  end_date: '2026-03-31',
  status: 'in_progress',
  closed_at: null,
  cuenta_de_banco: '1110',
  nombre_de_cuenta: 'BBVA 0102',
};

/** Despacha por SQL: la sesión, la partida, el rol y el INSERT son consultas distintas. */
function conBase(
  over: {
    sesion?: Record<string, unknown> | null;
    rol?: string | null;
    /** `null` = la partida no es de esta entidad/sesión, que es cero filas. */
    partida?: string | null;
  } = {}
) {
  mockQuery.mockImplementation((sql: string) => {
    // Antes que la sesión: esta consulta también NOMBRA reconciliation_sessions
    // (la une para exigir las dos entidades), así que el orden importa.
    if (sql.includes('FROM reconciling_items ri')) {
      const id = over.partida === undefined ? 'ri-9' : over.partida;
      return Promise.resolve({ rows: id === null ? [] : [{ id }], rowCount: id === null ? 0 : 1 });
    }
    if (sql.includes('FROM reconciliation_sessions')) {
      const fila = over.sesion === undefined ? sesion : over.sesion;
      return Promise.resolve({ rows: fila === null ? [] : [fila], rowCount: fila === null ? 0 : 1 });
    }
    if (sql.includes('FROM account_roles')) {
      const code = over.rol === undefined ? '1130' : over.rol;
      return Promise.resolve({ rows: code === null ? [] : [{ code }], rowCount: code === null ? 0 : 1 });
    }
    if (sql.includes('INSERT INTO reconciliation_adjustments')) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    throw new Error(`Consulta no esperada: ${sql}`);
  });
}

/** La llamada al mock que casa, YA TIPADA: `mock.calls` es `any[][]`. */
const llamada = (fragmento: string): [string, unknown[]] | undefined =>
  mockQuery.mock.calls.find((c: unknown[]) => (c[0] as string).includes(fragmento)) as
    | [string, unknown[]]
    | undefined;

const insertDelAjuste = (): [string, unknown[]] | undefined =>
  llamada('INSERT INTO reconciliation_adjustments');

beforeEach(() => {
  mockQuery.mockReset();
  mockCrearBorrador.mockReset();
  mockResolverEntidad.mockReset();
  mockCrearBorrador.mockResolvedValue({ id: 'draft-1', totalDebits: '0.00', totalCredits: '0.00' });
  mockResolverEntidad.mockResolvedValue({
    entityId: 'ent-1',
    entityName: 'Acme',
    tenantId: 'tnt-1',
    currency: 'MXN',
    country: 'MX',
    accountingStandard: 'NIF',
    taxId: 'AAA010101AAA',
  });
  conBase();
});

// ============================================================
// LA PROMESA DE LA FILA 1246, COMPROBADA CONTRA EL CÓDIGO
// ============================================================

describe('«nunca contabiliza por su cuenta»', () => {
  const fuente = readFileSync(
    resolve(__dirname, '../../../src/services/banking/reconciliation-adjustments.ts'),
    'utf8'
  );

  it('el archivo no nombra createJournalEntry ni postJournalEntry', () => {
    // Se comprueba contra el CÓDIGO y no contra la declaración: es la promesa
    // literal del catálogo, y una prueba que sólo mirara el resultado pasaría
    // igual el día que alguien añada la llamada detrás de una bandera.
    expect(fuente).not.toMatch(/\bcreateJournalEntry\b/);
    expect(fuente).not.toMatch(/\bpostJournalEntry\b/);
    expect(fuente).not.toMatch(/from '.*accounting\/posting\.js'/);
  });

  it('el INSERT no menciona journal_entry_id: queda NULL hasta F05d', async () => {
    await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8.00' }, 'usr-1');
    expect(insertDelAjuste()?.[0] as string).not.toContain('journal_entry_id');
  });

  it('lo que crea es un borrador pendiente, y lo devuelve con journalEntryId null', async () => {
    const a = await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8.00' }, 'usr-1');
    expect(mockCrearBorrador).toHaveBeenCalledTimes(1);
    expect(a.draftId).toBe('draft-1');
    expect(a.journalEntryId).toBeNull();
  });

  it('el borrador no nace con confianza 1.00: el importe es un hecho, la cuenta un juicio', async () => {
    await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8.00' }, 'usr-1');
    expect(CONFIANZA_POR_OMISION).toBeLessThan(1);
    expect((mockCrearBorrador.mock.calls[0][1] as { confidence: number }).confidence).toBe(
      CONFIANZA_POR_OMISION
    );
  });
});

// ============================================================
// EL SIGNO
// ============================================================

describe('direccionDeAjuste · el signo dice el sentido del asiento', () => {
  it('la comisión SALE de la cuenta: abona banco', () => {
    expect(direccionDeAjuste('comision', '-350.0000')).toEqual({
      bancoDebita: false,
      magnitud: '350.00',
    });
  });

  it('el IVA de la comisión SALE igual que la comisión', () => {
    expect(direccionDeAjuste('iva-comision', '-56.00').bancoDebita).toBe(false);
  });

  it('el interés ENTRA: carga banco', () => {
    expect(direccionDeAjuste('interes', '120.5000')).toEqual({
      bancoDebita: true,
      magnitud: '120.50',
    });
  });

  it('el ISR retenido SALE, aunque nazca de un interés que entra', () => {
    expect(direccionDeAjuste('isr-retenido', '-24.10').bancoDebita).toBe(false);
  });

  it('el error admite los dos sentidos, que es la razón de que sea un tipo aparte', () => {
    expect(direccionDeAjuste('error', '-10').bancoDebita).toBe(false);
    expect(direccionDeAjuste('error', '10').bancoDebita).toBe(true);
  });

  it('RECHAZA el signo que contradice al tipo en vez de voltearlo en silencio', () => {
    // Voltearlo es cómo un dato equivocado se convierte en un asiento correcto
    // de una cosa que no pasó.
    expect(() => direccionDeAjuste('comision', '350')).toThrow(/negativo/);
    expect(() => direccionDeAjuste('interes', '-120')).toThrow(/positivo/);
    expect(() => direccionDeAjuste('isr-retenido', '24')).toThrow(ValidationError);
  });

  it('rechaza el cero: un asiento de cero no corrige ninguna diferencia', () => {
    expect(() => direccionDeAjuste('error', '0')).toThrow(ValidationError);
  });

  it('rechaza un importe ilegible en vez de tratarlo como cero', () => {
    expect(() => direccionDeAjuste('comision', '')).toThrow(ValidationError);
  });

  it('rechaza un tipo que el CHECK de la 053 no admite', () => {
    expect(() => direccionDeAjuste('nsf' as never, '-1')).toThrow(/comision, iva-comision/);
  });
});

describe('lineasDelAjuste', () => {
  const salida = direccionDeAjuste('comision', '-350.00');
  const entrada = direccionDeAjuste('interes', '120.50');

  it('lo que sale de la cuenta: carga la contrapartida y abona banco', () => {
    expect(lineasDelAjuste(salida, '6100', '1110', 'comision', 'Comisión')).toEqual([
      { account_code: '6100', debit: 350, description: 'Comisión' },
      { account_code: '1110', credit: 350, description: 'Comisión' },
    ]);
  });

  it('lo que entra a la cuenta: carga banco y abona la contrapartida', () => {
    expect(lineasDelAjuste(entrada, '4200', '1110', 'interes', 'Interés')).toEqual([
      { account_code: '1110', debit: 120.5, description: 'Interés' },
      { account_code: '4200', credit: 120.5, description: 'Interés' },
    ]);
  });

  it('el asiento cuadra en los dos sentidos', () => {
    for (const lineas of [
      lineasDelAjuste(salida, '6100', '1110', 'comision', 'x'),
      lineasDelAjuste(entrada, '4200', '1110', 'interes', 'x'),
    ]) {
      const debe = lineas.reduce((s, l) => s + (l.debit ?? 0), 0);
      const haber = lineas.reduce((s, l) => s + (l.credit ?? 0), 0);
      expect(debe).toBe(haber);
    }
  });

  it('RECHAZA lo que no cabe en dos decimales en vez de redondearlo', () => {
    // La fila guarda 19,4 y el asiento postea 19,2. Redondear aquí haría que la
    // fila y su asiento afirmaran cantidades distintas sobre el mismo hecho:
    // es el defecto que F05a cazó tres veces.
    const d = direccionDeAjuste('iva-comision', '-19.7520');
    expect(() => lineasDelAjuste(d, '1130', '1110', 'iva-comision', 'IVA')).toThrow(/19.7520/);
    expect(() => lineasDelAjuste(d, '1130', '1110', 'iva-comision', 'IVA')).toThrow(/19.75/);
  });
});

// ============================================================
// LOS ROLES: LOS QUE HAY Y LOS QUE FALTAN
// ============================================================

describe('los roles contables de los cinco tipos', () => {
  it('cubre los cinco tipos sin huecos', () => {
    for (const t of TIPOS_DE_AJUSTE) {
      expect(Object.prototype.hasOwnProperty.call(ROL_DE_AJUSTE, t)).toBe(true);
    }
  });

  it('el IVA de la comisión va a `iva_acreditable`, no al pendiente de acreditar', () => {
    // El cargo del banco ES el pago: es el caso PUE, y su IVA es acreditable
    // ya. Dejarlo en 1135 pararía ahí un IVA que nada vendría a liberar.
    expect(ROL_DE_AJUSTE['iva-comision']).toBe('iva_acreditable');
  });

  it('el ISR retenido va a `isr_retenido_a_favor`: es un activo, no un pasivo', () => {
    expect(ROL_DE_AJUSTE['isr-retenido']).toBe('isr_retenido_a_favor');
  });

  it('comisión e interés NO tienen rol, y el hueco está nombrado', () => {
    expect(ROL_DE_AJUSTE.comision).toBeNull();
    expect(ROL_DE_AJUSTE.interes).toBeNull();
    expect(ROLES_QUE_FALTAN.map((r) => r.tipo).sort()).toEqual(['comision', 'interes']);
  });

  it('sin rol y sin cuenta, EXIGE la cuenta nombrando el rol que falta', async () => {
    await expect(
      crearAjuste('ent-1', 'ses-1', { tipo: 'comision', importe: '-350' }, 'usr-1')
    ).rejects.toThrow(/comision_bancaria/);
    await expect(
      crearAjuste('ent-1', 'ses-1', { tipo: 'interes', importe: '120' }, 'usr-1')
    ).rejects.toThrow(/interes_ganado/);
    expect(mockCrearBorrador).not.toHaveBeenCalled();
  });

  it('con la cuenta explícita, el tipo sin rol sí se propone', async () => {
    const a = await crearAjuste(
      'ent-1',
      'ses-1',
      { tipo: 'comision', cuenta: '6150', importe: '-350' },
      'usr-1'
    );
    expect(a.cuenta).toBe('6150');
    expect(a.lineas[0]).toEqual({
      account_code: '6150',
      debit: 350,
      description: expect.stringContaining('comision') as unknown as string,
    });
  });

  it('resuelve por rol cuando no se nombra la cuenta', async () => {
    const a = await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-56' }, 'usr-1');
    const rol = llamada('FROM account_roles');
    expect(rol?.[1]).toEqual(['ent-1', 'iva_acreditable']);
    expect(a.cuenta).toBe('1130');
  });

  it('un rol que la entidad no tiene mapeado se REPORTA, no se sustituye', async () => {
    conBase({ rol: null });
    await expect(
      crearAjuste('ent-1', 'ses-1', { tipo: 'isr-retenido', importe: '-24' }, 'usr-1')
    ).rejects.toThrow(/isr_retenido_a_favor/);
    expect(mockCrearBorrador).not.toHaveBeenCalled();
  });
});

// ============================================================
// LA SESIÓN Y LA FRONTERA
// ============================================================

describe('crearAjuste · lo que rechaza antes de escribir', () => {
  it('una sesión de otra entidad no existe', async () => {
    conBase({ sesion: null });
    await expect(
      crearAjuste('ent-1', 'ses-ajena', { tipo: 'iva-comision', importe: '-8' }, 'usr-1')
    ).rejects.toThrow(NotFoundError);
  });

  it('acota la sesión Y la cuenta bancaria por la entidad, dentro del SQL', async () => {
    await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8' }, 'usr-1');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('s.entity_id = $2');
    expect(sql).toContain('ba.entity_id = $2');
  });

  it('una sesión cerrada no admite ajustes nuevos', async () => {
    conBase({ sesion: { ...sesion, status: 'balanced' } });
    await expect(
      crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8' }, 'usr-1')
    ).rejects.toThrow(ConflictError);
    expect(mockCrearBorrador).not.toHaveBeenCalled();
  });

  it('una cuenta de mayor que no es de la entidad no se propone como contrapartida', async () => {
    conBase({ sesion: { ...sesion, cuenta_de_banco: null } });
    await expect(
      crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8' }, 'usr-1')
    ).rejects.toThrow(/no pertenece a esta entidad/);
  });

  it('no deja que la contrapartida sea la propia cuenta de banco', async () => {
    await expect(
      crearAjuste('ent-1', 'ses-1', { tipo: 'error', cuenta: '1110', importe: '-8' }, 'usr-1')
    ).rejects.toThrow(/a sí mismo/);
  });

  it('rechaza un contexto de otra entidad: el borrador acabaría en libros ajenos', async () => {
    await expect(
      crearAjuste(
        'ent-1',
        'ses-1',
        { tipo: 'iva-comision', importe: '-8' },
        'usr-1',
        { ctx: { entityId: 'ent-2', tenantId: 'tnt-1' } as never }
      )
    ).rejects.toThrow(/No se cruza/);
  });
});

describe('crearAjuste · lo que escribe', () => {
  it('guarda el importe FIRMADO, aunque el asiento lo exprese con debe y haber', async () => {
    await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-56.0000' }, 'usr-1');
    expect(insertDelAjuste()?.[1]?.[5]).toBe('-56.00');
  });

  it('conserva el cuarto decimal en la fila cuando el importe lo trae', async () => {
    // Y como no cabe en un asiento de dos decimales, ni siquiera llega a
    // escribirse: se rechaza antes. La fila nunca guarda algo que su borrador
    // no pueda postear.
    await expect(
      crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-19.7520' }, 'usr-1')
    ).rejects.toThrow(/dos decimales/);
    expect(insertDelAjuste()).toBeUndefined();
  });

  it('fecha el asiento en el cierre del periodo de la sesión', async () => {
    await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8' }, 'usr-1');
    const payload = (mockCrearBorrador.mock.calls[0][1] as { payload: { entry_date: string } }).payload;
    expect(payload.entry_date).toBe('2026-03-31');
  });

  it('ata el borrador a su sesión por la referencia, que es lo que `review` enseña', async () => {
    await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8' }, 'usr-1');
    const payload = (mockCrearBorrador.mock.calls[0][1] as { payload: { reference?: string } }).payload;
    expect(payload.reference).toBe('recon:ses-1');
  });

  it('ata el ajuste a la partida que lo explica cuando se le pasa', async () => {
    await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8' }, 'usr-1', {
      reconcilingItemId: 'ri-9',
    });
    expect(insertDelAjuste()?.[1]?.[3]).toBe('ri-9');
  });

  it('comprueba la partida con LAS DOS entidades y la sesión, dentro del SQL', async () => {
    // `reconciling_item_id` entraba tal cual al INSERT y la foránea de la 053
    // sólo prueba que la fila existe EN ALGUNA entidad: con el id de una
    // partida de la entidad hermana quedaba una fila de A apuntando a los
    // libros de B. Es la forma exacta de las dos fugas anteriores del módulo —
    // un vínculo que todavía nadie sigue.
    await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8' }, 'usr-1', {
      reconcilingItemId: 'ri-9',
    });
    const sonda = mockQuery.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('FROM reconciling_items ri')
    ) as [string, unknown[]] | undefined;
    expect(sonda?.[0]).toContain('ri.entity_id = $2');
    expect(sonda?.[0]).toContain('s.entity_id = $2');
    expect(sonda?.[0]).toContain('ri.reconciliation_session_id = $3');
    expect(sonda?.[1]).toEqual(['ri-9', 'ent-1', 'ses-1']);
  });

  it('una partida ajena no existe, y no se escribe nada', async () => {
    conBase({ partida: null });
    await expect(
      crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8' }, 'usr-1', {
        reconcilingItemId: 'ri-de-la-hermana',
      })
    ).rejects.toThrow(NotFoundError);
    // Ni la fila, ni el borrador: se rechaza ANTES de crearlo, así que no queda
    // un pendiente huérfano en `mnemosine review`.
    expect(insertDelAjuste()).toBeUndefined();
    expect(mockCrearBorrador).not.toHaveBeenCalled();
  });

  it('sin `--item` no pregunta por ninguna partida', async () => {
    await crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8' }, 'usr-1');
    expect(
      mockQuery.mock.calls.some((c: unknown[]) => (c[0] as string).includes('FROM reconciling_items ri'))
    ).toBe(false);
  });

  it('si la fila no se puede escribir, nombra el borrador huérfano para rechazarlo', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM reconciliation_sessions')) return Promise.resolve({ rows: [sesion], rowCount: 1 });
      if (sql.includes('FROM account_roles')) return Promise.resolve({ rows: [{ code: '1130' }], rowCount: 1 });
      return Promise.reject(new Error('violación de llave foránea'));
    });
    await expect(
      crearAjuste('ent-1', 'ses-1', { tipo: 'iva-comision', importe: '-8' }, 'usr-1')
    ).rejects.toThrow(/draft-1/);
  });
});

describe('listarAjustes', () => {
  it('trae el estado del borrador junto al asiento, para poder comprobar la promesa', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'ra-1',
          tipo: 'comision',
          importe: '-350.0000',
          reconciling_item_id: 'ri-1',
          draft_id: 'draft-1',
          estado_del_borrador: 'pending_review',
          journal_entry_id: null,
          creado_el: '2026-04-01T10:00:00+00',
          created_by: 'usr-1',
        },
      ],
      rowCount: 1,
    });
    const [a] = await listarAjustes('ent-1', 'ses-1');
    expect(a.estadoDelBorrador).toBe('pending_review');
    expect(a.journalEntryId).toBeNull();
    expect(a.importe).toBe('-350.00');
  });

  it('acota por la entidad del ajuste Y por la de su sesión', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await listarAjustes('ent-1', 'ses-1');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ra.entity_id = $1');
    expect(sql).toContain('s.entity_id = $1');
  });
});
