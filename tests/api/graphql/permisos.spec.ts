import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ForbiddenError,
  NotFoundError,
} from '../../../src/utils/errors.js';
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

const { motor, alcance, consulta, atestacion } = vi.hoisted(() => ({
  motor: {
    createJournalEntry: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    postJournalEntry: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    voidJournalEntry: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    reverseJournalEntry: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    softClosePeriod: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    hardClosePeriod: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    // Las nueve que faltaban delegan en los MISMOS servicios que REST; por eso
    // los dobles son de esos servicios y no de un motor paralelo. Si mañana
    // alguien escribe aquí lógica contable propia, deja de haber doble que
    // simular y la prueba se cae, que es lo que se quiere.
    createAccount: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    updateAccount: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    deactivateAccount: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    createInvoice: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    voidInvoice: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    recordCustomerPayment: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    timbrar: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  },
  alcance: {
    findByIdInScope: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    requireByIdInScope: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  },
  consulta: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  atestacion: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock('../../../src/services/accounting/index.js', () => ({
  createJournalEntry: ((...a) => motor.createJournalEntry(...a)) as Doble,
  postJournalEntry: ((...a) => motor.postJournalEntry(...a)) as Doble,
  voidJournalEntry: ((...a) => motor.voidJournalEntry(...a)) as Doble,
  reverseJournalEntry: ((...a) => motor.reverseJournalEntry(...a)) as Doble,
  softClosePeriod: ((...a) => motor.softClosePeriod(...a)) as Doble,
  hardClosePeriod: ((...a) => motor.hardClosePeriod(...a)) as Doble,
  attestEntryAsync: ((...a: unknown[]) => atestacion(...a)) as (...a: unknown[]) => void,
}));

vi.mock('../../../src/services/accounting/account-service.js', () => ({
  createAccount: ((...a) => motor.createAccount(...a)) as Doble,
  updateAccount: ((...a) => motor.updateAccount(...a)) as Doble,
  deactivateAccount: ((...a) => motor.deactivateAccount(...a)) as Doble,
}));

vi.mock('../../../src/services/ar/invoice-service.js', () => ({
  createInvoice: ((...a) => motor.createInvoice(...a)) as Doble,
  voidInvoice: ((...a) => motor.voidInvoice(...a)) as Doble,
}));

vi.mock('../../../src/services/payments/payment-service.js', () => ({
  recordCustomerPayment: ((...a) => motor.recordCustomerPayment(...a)) as Doble,
}));

// El PAC entra por importación diferida dentro del resolutor; el doble tiene
// que estar puesto igual. Timbrar es el acto EXTERNO E IRREVERSIBLE de esta
// lista: si la puerta se abriera de más, esto es lo que se dispararía.
vi.mock('../../../src/services/integrations/mexico/pac/pac-router.js', () => ({
  pacRouter: { stamp: ((...a: unknown[]) => motor.timbrar(...a)) as Doble },
}));

vi.mock('../../../src/services/integrations/mexico/pac/simulacion.js', () => ({
  estadoParaPersistir: () => ({ cfdi_status: 'stamped', nota: null }),
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
const CUENTA = '55555555-5555-5555-5555-555555555555';
const FACTURA = '66666666-6666-6666-6666-666666666666';
/** Otra sociedad DEL MISMO INQUILINO: el eje que RLS no defiende. */
const OTRA_ENTIDAD = '22222222-2222-2222-2222-222222222222';
const AJENO = '77777777-7777-7777-7777-777777777777';

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
  /**
   * Pasar la puerta no siempre es resolver. `cancelCfdi` la pasa —comprueba
   * permiso, acota la factura y valida la clave del SAT— y CONTESTA 501,
   * porque cancelar ante el SAT es un acto que este sistema no hace y su ruta
   * REST tampoco. Se nombra el error que se espera DESPUÉS de pasar en vez de
   * tragarse el rechazo: un `catch` mudo aquí dejaría pasar por bueno
   * cualquier fallo posterior en las otras trece.
   */
  pasaPeroLanza?: new (...args: never[]) => Error;
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
    campo: 'createAccount',
    permiso: 'accounts:create',
    espia: motor.createAccount,
    invocar: (c) =>
      M.createAccount(
        null,
        {
          input: {
            entityId: ENTIDAD,
            code: '1000',
            name: 'Caja',
            accountType: 'ASSET',
            normalBalance: 'DEBIT',
          },
        },
        c
      ) as Promise<unknown>,
  },
  {
    raiz: 'Mutation',
    campo: 'updateAccount',
    permiso: 'accounts:update',
    espia: motor.updateAccount,
    invocar: (c) =>
      M.updateAccount(null, { id: CUENTA, input: { name: 'Caja chica' } }, c) as Promise<unknown>,
  },
  {
    raiz: 'Mutation',
    campo: 'deleteAccount',
    permiso: 'accounts:delete',
    // El servicio se llama `deactivateAccount` y no borra: el espía lo dice.
    espia: motor.deactivateAccount,
    invocar: (c) => M.deleteAccount(null, { id: CUENTA }, c) as Promise<unknown>,
  },
  {
    raiz: 'Mutation',
    campo: 'reverseJournalEntry',
    permiso: 'journal_entries:create',
    espia: motor.reverseJournalEntry,
    invocar: (c) => M.reverseJournalEntry(null, { id: ASIENTO }, c) as Promise<unknown>,
  },
  {
    raiz: 'Mutation',
    campo: 'createInvoice',
    permiso: 'invoices:create',
    espia: motor.createInvoice,
    invocar: (c) =>
      M.createInvoice(
        null,
        {
          input: {
            entityId: ENTIDAD,
            customerId: 'c-1',
            invoiceDate: '2026-01-15',
            dueDate: '2026-02-15',
            lines: [],
          },
        },
        c
      ) as Promise<unknown>,
  },
  {
    raiz: 'Mutation',
    campo: 'voidInvoice',
    permiso: 'invoices:void',
    espia: motor.voidInvoice,
    invocar: (c) => M.voidInvoice(null, { id: FACTURA }, c) as Promise<unknown>,
  },
  {
    raiz: 'Mutation',
    campo: 'recordInvoicePayment',
    permiso: 'invoices:create',
    espia: motor.recordCustomerPayment,
    invocar: (c) =>
      M.recordInvoicePayment(
        null,
        {
          invoiceId: FACTURA,
          paymentDate: '2026-01-20',
          paymentAmount: '100.00',
          paymentMethod: 'transfer',
        },
        c
      ) as Promise<unknown>,
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
  // Timbrada: es lo que `cancelCfdi` exige antes de llegar a su 501, y para el
  // resto de casos da igual lo que devuelva.
  alcance.findByIdInScope.mockResolvedValue({ id: FACTURA, cfdi_status: 'stamped' });
  alcance.requireByIdInScope.mockResolvedValue({ id: ASIENTO });
  for (const fn of Object.values(motor)) fn.mockResolvedValue({ id: ASIENTO });
  // Formas que el resolutor DESESTRUCTURA: con `{ id }` a secas reventarían
  // después de la puerta y el fallo parecería de permisos.
  motor.voidInvoice.mockResolvedValue({ invoice: { id: FACTURA }, attest: null });
  motor.recordCustomerPayment.mockResolvedValue({ attestation: null });
  motor.timbrar.mockResolvedValue({ uuid: 'UUID-1', provider_used: 'finkok', simulado: false });
});

/**
 * El universo de permisos sale del CATÁLOGO, no de una lista a mano.
 *
 * La prueba de «sin el permiso» concede todos los demás, para que el rechazo no
 * pueda venir de estar vacío sino de faltar exactamente ése. Con la lista
 * escrita a mano, cada mutación nueva la dejaba desactualizada en silencio: se
 * concedían ocho permisos de los doce y el 403 podía venir de cualquiera.
 */
const TODOS_LOS_PERMISOS = [
  ...new Set([
    ...Object.values(PERMISOS.Query).flat(),
    ...Object.values(PERMISOS.Mutation).flat(),
  ]),
];

describe('cada campo exige su permiso, y el mismo que su ruta REST', () => {
  it.each(CASOS)('$raiz.$campo con $permiso pasa', async ({ permiso, espia, invocar, pasaPeroLanza }) => {
    const llamada = invocar(ctx([permiso]));
    if (pasaPeroLanza) await expect(llamada).rejects.toBeInstanceOf(pasaPeroLanza);
    else await llamada;
    expect(espia.mock.calls.length).toBeGreaterThan(0);
  });

  it.each(CASOS)('$raiz.$campo sin $permiso da ForbiddenError', async ({ permiso, espia, invocar }) => {
    // Un principal con TODOS los demás permisos menos el suyo: así el rechazo
    // no puede venir de estar vacío, sino de faltar exactamente ése.
    const otros = TODOS_LOS_PERMISOS.filter((p) => p !== permiso);

    await expect(invocar(ctx(otros))).rejects.toBeInstanceOf(ForbiddenError);
    expect(espia.mock.calls.length, 'el motor se llamó pese al 403').toBe(0);
  });

  it.each(CASOS)('$raiz.$campo con el comodín pasa', async ({ espia, invocar, pasaPeroLanza }) => {
    const llamada = invocar(ctx(['*']));
    if (pasaPeroLanza) await expect(llamada).rejects.toBeInstanceOf(pasaPeroLanza);
    else await llamada;
    expect(espia.mock.calls.length).toBeGreaterThan(0);
  });

  it('las doce mutaciones del catálogo tienen caso, y con el permiso que declara', () => {
    // Sin esto, añadir una mutación y olvidar su caso deja las tres pruebas de
    // arriba pasando sobre trece — verdes y ciegas a la catorce.
    const conCaso = CASOS.filter((c) => c.raiz === 'Mutation');
    expect(conCaso.map((c) => c.campo).sort()).toEqual(Object.keys(PERMISOS.Mutation).sort());
    for (const caso of conCaso) {
      expect(
        (PERMISOS.Mutation as Record<string, readonly string[]>)[caso.campo],
        `${caso.campo}: el caso prueba un permiso distinto del que declara el catálogo`
      ).toContain(caso.permiso);
    }
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

  it('el rol de sólo lectura no postea, no anula, no cierra y no timbra', async () => {
    for (const invocar of [
      () => M.createJournalEntry(null, { input: { entityId: ENTIDAD, entryDate: '2026-01-15', lines: [] } }, ctx(viewer)),
      () => M.postJournalEntry(null, { id: ASIENTO }, ctx(viewer)),
      () => M.voidJournalEntry(null, { id: ASIENTO, reason: 'x' }, ctx(viewer)),
      () => M.reverseJournalEntry(null, { id: ASIENTO }, ctx(viewer)),
      () => M.softClosePeriod(null, { periodId: PERIODO, entityId: ENTIDAD }, ctx(viewer)),
      () => M.hardClosePeriod(null, { periodId: PERIODO, entityId: ENTIDAD }, ctx(viewer)),
      () => M.createAccount(null, { input: { entityId: ENTIDAD, code: '1000', name: 'Caja', accountType: 'ASSET', normalBalance: 'DEBIT' } }, ctx(viewer)),
      () => M.updateAccount(null, { id: CUENTA, input: { name: 'x' } }, ctx(viewer)),
      () => M.deleteAccount(null, { id: CUENTA }, ctx(viewer)),
      () => M.createInvoice(null, { input: { entityId: ENTIDAD, customerId: 'c', invoiceDate: '2026-01-15', dueDate: '2026-02-15', lines: [] } }, ctx(viewer)),
      () => M.voidInvoice(null, { id: FACTURA }, ctx(viewer)),
      () => M.recordInvoicePayment(null, { invoiceId: FACTURA, paymentDate: '2026-01-20', paymentAmount: '1', paymentMethod: 'cash' }, ctx(viewer)),
      // Las dos que llegan al SAT. Timbrar es irreversible: es la razón de que
      // esta prueba mire el motor y no sólo el código de error.
    ]) {
      await expect(invocar()).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const fn of Object.values(motor)) expect(fn).not.toHaveBeenCalled();
    expect(alcance.requireByIdInScope, 'ni siquiera se leyó la fila').not.toHaveBeenCalled();
  });

  it('y sí lee lo que su rol concede', async () => {
    await Q.journalEntries(null, { entityId: ENTIDAD }, ctx(viewer));
    expect(consulta).toHaveBeenCalled();
  });
});

// ============================================================
// LA MUTACIÓN QUE RECIBE UN ID NO ALCANZA EL DE OTRA ENTIDAD.
//
// El permiso y el alcance son dos preguntas distintas, y las nueve mutaciones
// nuevas tienen que contestar las dos. RLS acota por INQUILINO: dentro de un
// despacho con dos sociedades no acota nada, y ése es justo el eje.
//
// La ruta REST que timbra lo demuestra por omisión: `POST
// /v1/invoices/:id/cfdi/stamp` hace `SELECT * FROM invoices WHERE id = $1` sin
// acotar, así que conocer un UUID basta para TIMBRAR ANTE EL SAT la factura de
// la otra sociedad — irreversible. Esta puerta no copia ese hueco: pasa por
// `requireByIdInScope`/`findByIdInScope`, que meten el filtro DENTRO del SQL, y
// por eso «no existe» y «no es tuyo» salen los dos por NotFoundError.
//
// El doble de alcance de aquí no es `mockResolvedValue`: IMITA el filtro, con
// una tabla de dos sociedades del mismo inquilino. Un doble que devuelve
// siempre la fila probaría que el resolutor llama a la función, no que la
// llamada acota.
// ============================================================
describe('las mutaciones por id se acotan dentro del SQL', () => {
  const FILAS = [
    { tabla: 'accounts', id: CUENTA, entityId: ENTIDAD },
    { tabla: 'journal_entries', id: ASIENTO, entityId: ENTIDAD },
    { tabla: 'invoices', id: FACTURA, entityId: ENTIDAD },
    // Las mismas tres tablas, de la OTRA sociedad. EXISTEN —por eso el id no
    // es inventado—; lo que no pueden es alcanzarse desde un contexto acotado
    // a ENTIDAD, y la respuesta no puede distinguirse de la de un id que no
    // existe.
    { tabla: 'accounts', id: AJENO, entityId: OTRA_ENTIDAD },
    { tabla: 'journal_entries', id: AJENO, entityId: OTRA_ENTIDAD },
    { tabla: 'invoices', id: AJENO, entityId: OTRA_ENTIDAD },
  ];

  const buscar = (tabla: unknown, id: unknown, scope: unknown) => {
    const { entityId } = scope as { entityId: string };
    const fila = FILAS.find((f) => f.tabla === tabla && f.id === id && f.entityId === entityId);
    // `cfdi_status` va en todas: es lo que `cancelCfdi` mira después de acotar.
    return fila ? { id: fila.id, cfdi_status: 'stamped' } : null;
  };

  beforeEach(() => {
    alcance.findByIdInScope.mockImplementation((...a: unknown[]) =>
      Promise.resolve(buscar(a[0], a[1], a[2]))
    );
    alcance.requireByIdInScope.mockImplementation((...a: unknown[]) => {
      const fila = buscar(a[0], a[1], a[2]);
      return fila ? Promise.resolve(fila) : Promise.reject(new NotFoundError('Recurso', String(a[1])));
    });
  });

  interface CasoAcotado {
    campo: string;
    /** El id que SÍ es de la entidad del contexto. */
    propio: string;
    /**
     * El servicio que no debe llegar a llamarse con un id ajeno. Vacío cuando
     * la mutación no llama a ninguno —`cancelCfdi` contesta 501—, y entonces
     * la clase del error es la aserción entera: NotImplementedError significa
     * que pasó el alcance, NotFoundError que no.
     */
    espia?: { mock: { calls: unknown[][] } };
    invocar: (id: string) => Promise<unknown>;
    pasaPeroLanza?: new (...args: never[]) => Error;
  }

  const c = () => ctx(['*']);

  const ACOTADOS: CasoAcotado[] = [
    {
      campo: 'updateAccount',
      propio: CUENTA,
      espia: motor.updateAccount,
      invocar: (id) => M.updateAccount(null, { id, input: { name: 'x' } }, c()) as Promise<unknown>,
    },
    {
      campo: 'deleteAccount',
      propio: CUENTA,
      espia: motor.deactivateAccount,
      invocar: (id) => M.deleteAccount(null, { id }, c()) as Promise<unknown>,
    },
    {
      campo: 'reverseJournalEntry',
      propio: ASIENTO,
      espia: motor.reverseJournalEntry,
      invocar: (id) => M.reverseJournalEntry(null, { id }, c()) as Promise<unknown>,
    },
    {
      campo: 'voidInvoice',
      propio: FACTURA,
      espia: motor.voidInvoice,
      invocar: (id) => M.voidInvoice(null, { id }, c()) as Promise<unknown>,
    },
    {
      campo: 'recordInvoicePayment',
      propio: FACTURA,
      espia: motor.recordCustomerPayment,
      invocar: (id) =>
        M.recordInvoicePayment(
          null,
          { invoiceId: id, paymentDate: '2026-01-20', paymentAmount: '100', paymentMethod: 'cash' },
          c()
        ) as Promise<unknown>,
    },
  ];

  it.each(ACOTADOS)('$campo alcanza el id de su propia entidad', async ({ propio, espia, invocar, pasaPeroLanza }) => {
    const llamada = invocar(propio);
    if (pasaPeroLanza) await expect(llamada).rejects.toBeInstanceOf(pasaPeroLanza);
    else await llamada;
    if (espia) expect(espia.mock.calls.length).toBeGreaterThan(0);
  });

  it.each(ACOTADOS)('$campo NO alcanza el de la otra sociedad del mismo inquilino', async ({ espia, invocar }) => {
    // NotFoundError, no ForbiddenError: un 403 diría «existe, y no es tuya»,
    // y aquí los identificadores circulan.
    await expect(invocar(AJENO)).rejects.toBeInstanceOf(NotFoundError);
    if (espia) expect(espia.mock.calls.length, 'el servicio se llamó sobre la fila ajena').toBe(0);
  });


  it('las dos que reciben la entidad por argumento comprueban PERTENENCIA', async () => {
    // createAccount y createInvoice no reciben un id existente sino la entidad
    // sobre la que crear, así que lo suyo no es acotar una fila: es lo mismo
    // que hace `requireEntityAccess` en REST — la entidad tiene que estar en el
    // token. Sin esto, el alta se haría en el catálogo de la otra sociedad.
    const ajeno = { ...c(), user: { ...c().user, entities: [OTRA_ENTIDAD] } };
    await expect(
      M.createAccount(
        null,
        { input: { entityId: ENTIDAD, code: '1000', name: 'Caja', accountType: 'ASSET', normalBalance: 'DEBIT' } },
        ajeno
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      M.createInvoice(
        null,
        { input: { entityId: ENTIDAD, customerId: 'c', invoiceDate: '2026-01-15', dueDate: '2026-02-15', lines: [] } },
        ajeno
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(motor.createAccount).not.toHaveBeenCalled();
    expect(motor.createInvoice).not.toHaveBeenCalled();
  });
});

// ============================================================
// LA COMPUERTA. Lo anterior prueba las veintidós puertas de hoy; esto prueba
// que la veintitrés no puede nacer abierta.
// ============================================================

describe('la compuerta lee el esquema, no una lista escrita a mano', () => {
  it('hoy no hay ningún hueco en las dos raíces', () => {
    expect(auditarRaiz(typeDefs, 'Mutation', Object.keys(resolvers.Mutation))).toEqual([]);
    expect(auditarRaiz(typeDefs, 'Query', Object.keys(resolvers.Query))).toEqual([]);
  });

  it('toda consulta declarada tiene resolutor: ya no queda ninguna que reviente al invocarse', () => {
    // `balanceSheet` e `incomeStatement` estaban declaradas y sin resolutor.
    // Campos NO NULOS: caían en el resolutor por omisión, devolvían `undefined`
    // y reventaban con «Cannot return null for non-nullable field». Estar
    // listadas en SIN_RESOLUTOR dejaba constancia de que reventaban a
    // propósito, pero la introspección las publicaba igual y `consolidate`
    // prometía además una consolidación que nadie calcula. Se retiraron del
    // esquema; los informes los sirve REST con reports:read.
    //
    // Lo que fija esta prueba es el invariante, no la retirada: en Query, todo
    // lo declarado se sirve. Si vuelven, vuelven con su resolutor.
    const declaradas = camposDeclarados(typeDefs, 'Query');
    expect(declaradas.sort()).toEqual(Object.keys(resolvers.Query).sort());
    expect(SIN_RESOLUTOR.Query).toEqual({});
    expect(declaradas).not.toContain('balanceSheet');
    expect(declaradas).not.toContain('incomeStatement');
    // Y sus siete tipos se fueron con ellas: un tipo al que ningún campo lleva
    // sigue saliendo por introspección como contrato que nadie puede ejercer.
    expect(typeDefs).not.toMatch(/type (BalanceSheet|IncomeStatement)\b/);
  });

  it('el esquema declara quince mutaciones: doce servidas y tres ausencias dichas', () => {
    // Si este reparto cambia sin que nadie toque el catálogo, los casos de
    // abajo pierden su sujeto — y la auditoría III llegó a contar 17.
    const declaradas = camposDeclarados(typeDefs, 'Mutation');
    expect(declaradas).toHaveLength(15);
    expect(Object.keys(PERMISOS.Mutation)).toHaveLength(12);
    expect(Object.keys(resolvers.Mutation)).toHaveLength(12);
    // Las dos que llegan hasta el SAT ya no son ausencias: entraron POR LA
    // PUERTA, con su permiso declarado y el mismo que exige su ruta REST.
    // Las dos del SAT NO se sirven: no hay servicio en el que delegar —la
    // lógica del comprobante vive dentro de la ruta REST— y por esta puerta el
    // acto irreversible quedaría además sin autor, porque auditLogMiddleware
    // sólo cuelga de /v1. Están declaradas ausentes, no olvidadas.
    expect(SIN_RESOLUTOR.Mutation).toHaveProperty('stampCfdi');
    expect(SIN_RESOLUTOR.Mutation).toHaveProperty('cancelCfdi');
  });

  it('las tres ausentes lo están a propósito, y su motivo dice POR QUÉ y no sólo dónde', () => {
    // Tres, no una. `stampCfdi` y `cancelCfdi` se retiraron después de
    // implementarse: no hay servicio en el que delegar —la lógica del
    // comprobante vive DENTRO de la ruta REST—, así que servirlas aquí obliga a
    // copiar una regla fiscal, y dos copias divergen. Y por esta puerta el acto
    // irreversible quedaría sin autor: auditLogMiddleware sólo cuelga de /v1 y
    // la ruta no llama a registrarAuditoria.
    expect(Object.keys(SIN_RESOLUTOR.Mutation).sort()).toEqual(
      ['cancelCfdi', 'sendInvoice', 'stampCfdi'].sort()
    );
    for (const campo of ['sendInvoice', 'stampCfdi', 'cancelCfdi'] as const) {
      expect(resolvers.Mutation).not.toHaveProperty(campo);
      // Un motivo telegráfico se lee como «pendiente»; el largo obliga a decir
      // la razón, que es lo único que impide que alguien la «complete» mañana.
      expect(SIN_RESOLUTOR.Mutation[campo].length).toBeGreaterThan(200);
    }
    expect(SIN_RESOLUTOR.Mutation.stampCfdi).toMatch(/irreversible/);
    expect(SIN_RESOLUTOR.Mutation.stampCfdi).toMatch(/sin autor|registrarAuditoria/);
    expect(SIN_RESOLUTOR.Mutation.cancelCfdi).toMatch(/RETIRADA|sin cancelar ante el SAT/);

    // El motivo que había —«la sirve POST /v1/invoices/:id/send»— se lee como
    // «está en otra puerta», y entonces implementarla parece trabajo pendiente.
    // Lo cierto es lo contrario: la ruta MARCA y NO TRANSMITE, y el esquema
    // pide asunto y mensaje y devuelve `Invoice!`, que no tiene dónde decir que
    // no se transmitió. Servirla tal como está declarada devuelve la mentira
    // que este repositorio purgó, así que el motivo tiene que decir eso.
    const motivo = SIN_RESOLUTOR.Mutation.sendInvoice;
    expect(motivo).toMatch(/NO TRANSMITE/);
    expect(motivo).toMatch(/transmitted:false/);
    expect(motivo).toMatch(/contrato público/);
    expect(motivo.length).toBeGreaterThan(200);
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
