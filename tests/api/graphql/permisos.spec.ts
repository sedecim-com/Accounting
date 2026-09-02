import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError } from '../../../src/utils/errors.js';
import { permissionsOf } from '../../../src/auth/roles.js';

// ============================================================
// LA PUERTA DE PERMISOS DE GRAPHQL, PROBADA POR LOS DOS LADOS.
//
// El defecto que estas pruebas fijan: los resolutores declaraban
// `permissions` en su contexto y no lo leían jamás. Con GRAPHQL_ENABLED=true,
// un `viewer` —cinco permisos, todos de lectura— podía crear, postear y anular
// asientos y cerrar el ejercicio en duro; su equivalente REST le habría dado
// 403 en las cinco.
//
// Para cada campo se prueban las TRES respuestas que definen la semántica de
// `requirePermission`: con el permiso pasa, sin él da ForbiddenError con
// required/missing/current, y el comodín pasa. Y se prueba lo que un test de
// permisos suele olvidar: que al faltar el permiso el motor NO SE LLAMA. Un
// 403 después de postear no es un 403.
//
// Los servicios y la base van simulados: lo que se mide aquí es la puerta, y
// una puerta que necesita Postgres para probarse se prueba una vez al año.
// ============================================================

// Los dobles se declaran devolviendo `Promise<unknown>` y no el `any` que
// `vi.fn()` da por omisión: con `any`, cada reenvío del factory es un
// `no-unsafe-return` — ocho advertencias nuevas contra un tope que no se sube.
type Doble = (...args: unknown[]) => Promise<unknown>;

const { motor, alcance, consulta } = vi.hoisted(() => ({
  motor: {
    createJournalEntry: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    postJournalEntry: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    voidJournalEntry: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    softClosePeriod: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    hardClosePeriod: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  },
  alcance: {
    findByIdInScope: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    requireByIdInScope: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  },
  consulta: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('../../../src/services/accounting/index.js', () => ({
  createJournalEntry: ((...a) => motor.createJournalEntry(...a)) as Doble,
  postJournalEntry: ((...a) => motor.postJournalEntry(...a)) as Doble,
  voidJournalEntry: ((...a) => motor.voidJournalEntry(...a)) as Doble,
  softClosePeriod: ((...a) => motor.softClosePeriod(...a)) as Doble,
  hardClosePeriod: ((...a) => motor.hardClosePeriod(...a)) as Doble,
}));

vi.mock('../../../src/database/scope.js', () => ({
  findByIdInScope: ((...a) => alcance.findByIdInScope(...a)) as Doble,
  requireByIdInScope: ((...a) => alcance.requireByIdInScope(...a)) as Doble,
  entityScope: (tenantId: string, entityId: string) => ({ kind: 'entity', tenantId, entityId }),
}));

vi.mock('../../../src/database/connection.js', () => ({
  query: ((...a) => consulta(...a)) as Doble,
}));

// `auth.js` NO se simula: la gracia de la puerta es que pregunta con el MISMO
// código que REST. Simularlo probaría el simulacro.
import { resolvers } from '../../../src/api/graphql/resolvers/index.js';
import {
  auditarRaiz,
  blindar,
  camposDeclarados,
  CompuertaAbiertaError,
  PERMISOS,
  RAICES,
  SIN_RESOLUTOR,
} from '../../../src/api/graphql/permisos.js';
import { typeDefs } from '../../../src/api/graphql/schemas/schema.js';

const ENTIDAD = '11111111-1111-1111-1111-111111111111';
const INQUILINO = '99999999-9999-9999-9999-999999999999';
const PERIODO = '33333333-3333-3333-3333-333333333333';
const ASIENTO = '44444444-4444-4444-4444-444444444444';

const ctx = (permissions: readonly string[]) => ({
  user: { user_id: 'u-1', entities: [ENTIDAD], permissions: [...permissions] },
  tenantId: INQUILINO,
  entityId: ENTIDAD,
});

type Ctx = ReturnType<typeof ctx>;

interface Caso {
  raiz: 'Query' | 'Mutation';
  campo: string;
  permiso: string;
  /** El doble que sólo se llama si la puerta dejó pasar. */
  espia: { mock: { calls: unknown[][] } };
  invocar: (c: Ctx) => Promise<unknown>;
}

const M = resolvers.Mutation;
const Q = resolvers.Query;

const CASOS: Caso[] = [
  {
    raiz: 'Mutation',
    campo: 'createJournalEntry',
    permiso: 'journal_entries:create',
    espia: motor.createJournalEntry,
    invocar: (c) =>
      M.createJournalEntry(
        null,
        { input: { entityId: ENTIDAD, entryDate: '2026-01-15', description: 'x', lines: [] } },
        c
      ) as Promise<unknown>,
  },
  {
    raiz: 'Mutation',
    campo: 'postJournalEntry',
    permiso: 'journal_entries:post',
    espia: motor.postJournalEntry,
    invocar: (c) => M.postJournalEntry(null, { id: ASIENTO }, c) as Promise<unknown>,
  },
  {
    raiz: 'Mutation',
    campo: 'voidJournalEntry',
    permiso: 'journal_entries:void',
    espia: motor.voidJournalEntry,
    invocar: (c) => M.voidJournalEntry(null, { id: ASIENTO, reason: 'error' }, c) as Promise<unknown>,
  },
  {
    raiz: 'Mutation',
    campo: 'softClosePeriod',
    permiso: 'periods:close',
    espia: motor.softClosePeriod,
    invocar: (c) =>
      M.softClosePeriod(null, { periodId: PERIODO, entityId: ENTIDAD }, c) as Promise<unknown>,
  },
  {
    raiz: 'Mutation',
    campo: 'hardClosePeriod',
    permiso: 'periods:close',
    espia: motor.hardClosePeriod,
    invocar: (c) =>
      M.hardClosePeriod(null, { periodId: PERIODO, entityId: ENTIDAD }, c) as Promise<unknown>,
  },
  {
    raiz: 'Query',
    campo: 'account',
    permiso: 'accounts:read',
    espia: alcance.findByIdInScope,
    invocar: (c) => Q.account(null, { id: ASIENTO }, c) as Promise<unknown>,
  },
  {
    raiz: 'Query',
    campo: 'journalEntry',
    permiso: 'journal_entries:read',
    espia: alcance.findByIdInScope,
    invocar: (c) => Q.journalEntry(null, { id: ASIENTO }, c) as Promise<unknown>,
  },
  {
    raiz: 'Query',
    campo: 'invoice',
    permiso: 'invoices:read',
    espia: alcance.findByIdInScope,
    invocar: (c) => Q.invoice(null, { id: ASIENTO }, c) as Promise<unknown>,
  },
  {
    raiz: 'Query',
    campo: 'accounts',
    permiso: 'accounts:read',
    espia: consulta,
    invocar: (c) => Q.accounts(null, { entityId: ENTIDAD }, c) as Promise<unknown>,
  },
  {
    raiz: 'Query',
    campo: 'journalEntries',
    permiso: 'journal_entries:read',
    espia: consulta,
    invocar: (c) => Q.journalEntries(null, { entityId: ENTIDAD }, c) as Promise<unknown>,
  },
  {
    raiz: 'Query',
    campo: 'invoices',
    permiso: 'invoices:read',
    espia: consulta,
    invocar: (c) => Q.invoices(null, { entityId: ENTIDAD }, c) as Promise<unknown>,
  },
  {
    raiz: 'Query',
    campo: 'trialBalance',
    permiso: 'reports:read',
    espia: consulta,
    invocar: (c) => Q.trialBalance(null, { entityId: ENTIDAD }, c) as Promise<unknown>,
  },
  {
    raiz: 'Query',
    campo: 'fiscalPeriods',
    permiso: 'accounts:read',
    espia: consulta,
    invocar: (c) => Q.fiscalPeriods(null, { entityId: ENTIDAD }, c) as Promise<unknown>,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  // Una fila con `count` sirve a la vez al COUNT(*) de `accounts` y a las
  // listas: lo que se mide es si el resolutor llegó a consultar, no el SQL.
  consulta.mockResolvedValue({ rows: [{ count: '0' }] });
  alcance.findByIdInScope.mockResolvedValue(null);
  alcance.requireByIdInScope.mockResolvedValue({ id: ASIENTO });
  for (const fn of Object.values(motor)) fn.mockResolvedValue({ id: ASIENTO });
});

describe('cada campo exige su permiso, y el mismo que su ruta REST', () => {
  it.each(CASOS)('$raiz.$campo con $permiso pasa', async ({ permiso, espia, invocar }) => {
    await invocar(ctx([permiso]));
    expect(espia.mock.calls.length).toBeGreaterThan(0);
  });

  it.each(CASOS)('$raiz.$campo sin $permiso da ForbiddenError', async ({ permiso, espia, invocar }) => {
    // Un principal con TODOS los demás permisos menos el suyo: así el rechazo
    // no puede venir de estar vacío, sino de faltar exactamente ése.
    const otros = ['accounts:read', 'journal_entries:read', 'invoices:read', 'reports:read',
      'journal_entries:create', 'journal_entries:post', 'journal_entries:void', 'periods:close']
      .filter((p) => p !== permiso);

    await expect(invocar(ctx(otros))).rejects.toBeInstanceOf(ForbiddenError);
    expect(espia.mock.calls.length, 'el motor se llamó pese al 403').toBe(0);
  });

  it.each(CASOS)('$raiz.$campo con el comodín pasa', async ({ espia, invocar }) => {
    await invocar(ctx(['*']));
    expect(espia.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('el error tiene la misma forma que el de REST', () => {
  it('dice required, missing y current', async () => {
    const err = await M.postJournalEntry(null, { id: ASIENTO }, ctx(['journal_entries:read'])).then(
      () => null,
      (e: unknown) => e as ForbiddenError
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err!.statusCode).toBe(403);
    expect(err!.message).toBe('Insufficient permissions');
    expect(err!.details).toEqual({
      required: ['journal_entries:post'],
      missing: ['journal_entries:post'],
      current: ['journal_entries:read'],
    });
  });

  it('sin principal en el contexto es 401 y no 403', async () => {
    // Un contexto sin `user` no es «no autorizado a esto»: es que no hay quien
    // pregunte. GraphQL puede recibirlo si alguien monta el endpoint sin
    // `authenticate` delante, y ahí fallar cerrado importa más que en REST.
    await expect(
      M.postJournalEntry(null, { id: ASIENTO }, { user: undefined } as never)
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('el escenario que la auditoría midió: un viewer contra el mayor', () => {
  const viewer = permissionsOf('viewer');

  it('el rol de sólo lectura no postea, no anula y no cierra', async () => {
    for (const invocar of [
      () => M.createJournalEntry(null, { input: { entityId: ENTIDAD, entryDate: '2026-01-15', lines: [] } }, ctx(viewer)),
      () => M.postJournalEntry(null, { id: ASIENTO }, ctx(viewer)),
      () => M.voidJournalEntry(null, { id: ASIENTO, reason: 'x' }, ctx(viewer)),
      () => M.softClosePeriod(null, { periodId: PERIODO, entityId: ENTIDAD }, ctx(viewer)),
      () => M.hardClosePeriod(null, { periodId: PERIODO, entityId: ENTIDAD }, ctx(viewer)),
    ]) {
      await expect(invocar()).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const fn of Object.values(motor)) expect(fn).not.toHaveBeenCalled();
  });

  it('y sí lee lo que su rol concede', async () => {
    await Q.journalEntries(null, { entityId: ENTIDAD }, ctx(viewer));
    expect(consulta).toHaveBeenCalled();
  });
});

// ============================================================
// LA COMPUERTA. Lo anterior prueba las trece puertas de hoy; esto prueba que
// la catorce no puede nacer abierta.
// ============================================================

describe('la compuerta lee el esquema, no una lista escrita a mano', () => {
  it('hoy no hay ningún hueco en las dos raíces', () => {
    expect(auditarRaiz(typeDefs, 'Mutation', Object.keys(resolvers.Mutation))).toEqual([]);
    expect(auditarRaiz(typeDefs, 'Query', Object.keys(resolvers.Query))).toEqual([]);
  });

  it('el esquema declara quince mutaciones: cinco servidas y diez declaradas ausentes', () => {
    // Si este reparto cambia sin que nadie toque el catálogo, los casos de
    // abajo pierden su sujeto — y la auditoría III llegó a contar 17.
    const declaradas = camposDeclarados(typeDefs, 'Mutation');
    expect(declaradas).toHaveLength(15);
    expect(Object.keys(PERMISOS.Mutation)).toHaveLength(5);
    expect(Object.keys(SIN_RESOLUTOR.Mutation)).toHaveLength(10);
    // Las dos que llegan hasta el SAT están nombradas, no olvidadas.
    expect(SIN_RESOLUTOR.Mutation).toHaveProperty('stampCfdi');
    expect(SIN_RESOLUTOR.Mutation).toHaveProperty('cancelCfdi');
  });

  const ESQUEMA_CON_UNA_NUEVA = `
    type Query { account(id: ID!): String }
    type Mutation {
      postJournalEntry(id: ID!): String!
      approveBill(id: ID!): String!
    }
  `;

  it('acusa la mutación nueva que alguien implementa sin declarar su permiso', () => {
    const huecos = auditarRaiz(
      ESQUEMA_CON_UNA_NUEVA,
      'Mutation',
      ['postJournalEntry', 'approveBill'],
      { permisos: { postJournalEntry: ['journal_entries:post'] }, sinResolutor: {} }
    );
    expect(huecos).toHaveLength(1);
    expect(huecos[0].campo).toBe('approveBill');
    expect(huecos[0].motivo).toMatch(/sin que la puerta pregunte nada/);
  });

  it('acusa la mutación nueva que se declara en el esquema y nadie inventaría', () => {
    // El otro orden: primero el esquema, la implementación luego. Si la
    // compuerta sólo mirara los resolutores, ésta pasaría inadvertida hasta
    // que alguien la escribiera — y ese día nadie estaría mirando.
    const huecos = auditarRaiz(
      ESQUEMA_CON_UNA_NUEVA,
      'Mutation',
      ['postJournalEntry'],
      { permisos: { postJournalEntry: ['journal_entries:post'] }, sinResolutor: {} }
    );
    expect(huecos.map((h) => h.campo)).toEqual(['approveBill']);
    expect(huecos[0].motivo).toMatch(/ni implementado ni listado como ausente/);
  });

  it('una mutación declarada ausente CON motivo no es un hueco', () => {
    const huecos = auditarRaiz(ESQUEMA_CON_UNA_NUEVA, 'Mutation', ['postJournalEntry'], {
      permisos: { postJournalEntry: ['journal_entries:post'] },
      sinResolutor: {
        approveBill:
          'Declarada y sin resolutor. La aprobación la sirve POST /v1/bills/:id/approve con bills:approve.',
      },
    });
    expect(huecos).toEqual([]);
  });

  it('un motivo telegráfico no cuenta como motivo', () => {
    const huecos = auditarRaiz(ESQUEMA_CON_UNA_NUEVA, 'Mutation', ['postJournalEntry'], {
      permisos: { postJournalEntry: ['journal_entries:post'] },
      sinResolutor: { approveBill: 'luego' },
    });
    expect(huecos.map((h) => h.campo)).toContain('approveBill');
  });

  it('acusa el permiso declarado sobre un campo que el esquema no tiene', () => {
    // La errata que deja al campo REAL sin puerta: se declara
    // `postJournalEntryy` y el de verdad se queda fuera del catálogo.
    const huecos = auditarRaiz(ESQUEMA_CON_UNA_NUEVA, 'Mutation', ['postJournalEntry'], {
      permisos: { postJournalEntryy: ['journal_entries:post'] },
      sinResolutor: { approveBill: 'Declarada y sin resolutor; la sirve POST /v1/bills/:id/approve con bills:approve.' },
    });
    const campos = huecos.map((h) => h.campo);
    expect(campos).toContain('postJournalEntry');
    expect(campos).toContain('postJournalEntryy');
  });

  it('acusa la contradicción: implementada y a la vez declarada ausente', () => {
    const huecos = auditarRaiz(ESQUEMA_CON_UNA_NUEVA, 'Mutation', ['postJournalEntry', 'approveBill'], {
      permisos: { postJournalEntry: ['journal_entries:post'] },
      sinResolutor: { approveBill: 'Declarada y sin resolutor; la sirve POST /v1/bills/:id/approve con bills:approve.' },
    });
    expect(huecos.map((h) => h.motivo).join()).toMatch(/el catálogo se contradice/);
  });

  it('blindar LANZA en vez de dejar pasar: la compuerta corre al cargar, no en la prueba', () => {
    // Esto es lo que hace que el olvido de mañana no llegue a producción: el
    // módulo de resolutores no se carga, así que no arranca el servidor ni
    // pasa ninguna prueba que lo importe.
    const nueva = () => Promise.resolve('postearía sin permiso');
    expect(() => blindar('Mutation', { ...resolvers.Mutation, approveBill: nueva })).toThrow(
      CompuertaAbiertaError
    );
    expect(() => blindar('Mutation', { ...resolvers.Mutation, approveBill: nueva })).toThrow(
      /approveBill/
    );
  });

  it('y con las de hoy no lanza', () => {
    expect(() => blindar('Mutation', { ...resolvers.Mutation })).not.toThrow();
    expect(() => blindar('Query', { ...resolvers.Query })).not.toThrow();
  });

  it('las suscripciones también están en el catálogo, y hoy son cuatro ausencias', () => {
    // El esquema declara cuatro suscripciones y no hay resolutor ni transporte
    // de ninguna. Entran igual en el catálogo: una suscripción es una lectura
    // CONTINUA, y la que alguien escriba mañana tiene que pasar por la puerta.
    expect(camposDeclarados(typeDefs, 'Subscription')).toHaveLength(4);
    expect(auditarRaiz(typeDefs, 'Subscription', [])).toEqual([]);
    expect(
      auditarRaiz(typeDefs, 'Subscription', ['journalEntryPosted'])
        .map((h) => h.motivo)
        .join()
    ).toMatch(/el catálogo se contradice/);
  });

  it('ninguna raíz se sirve por fuera de la puerta', () => {
    // Lo que este archivo no puede ver por su cuenta: que `resolvers` no
    // exponga una raíz SIN blindar. Se comprueba por la forma del objeto —las
    // raíces blindadas sólo contienen funciones envueltas— y sobre todo en el
    // criterio E2.1, que lee el fuente. Aquí se fija lo que sí es observable:
    // hoy hay dos raíces servidas y ninguna suscripción.
    const servidas = RAICES.filter((r) => r in resolvers);
    expect(servidas).toEqual(['Query', 'Mutation']);
  });
});
