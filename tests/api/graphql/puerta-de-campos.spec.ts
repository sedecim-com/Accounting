import { describe, it, expect, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { ForbiddenError, ValidationError, NotFoundError } from '../../../src/utils/errors.js';
import { formatearError } from '../../../src/api/graphql/errores.js';
import { blindarCampos, PERMISO_DE_TABLA, PERMISOS_DE_CAMPO } from '../../../src/api/graphql/permisos.js';
import { resolvers as resolversReales } from '../../../src/api/graphql/resolvers/index.js';

// ============================================================
// LA PUERTA NO SE RODEA POR EL GRAFO.
//
// Blindar sólo las raíces —Query y Mutation— deja la puerta abierta por donde
// GraphQL es un grafo. Medido antes de este arreglo: con `invoices:read` y nada
// más, la raíz `journalEntries` contestaba «Insufficient permissions» y en la
// MISMA corrida
//     invoices(entityId){ journalEntry { lines { account { code name } } } }
// devolvía el asiento, sus renglones y filas del catálogo de cuentas, porque
// los resolutores de CAMPO van a la base por su cuenta. REST no da eso:
// `GET /v1/invoices/:id` con `invoices:read` devuelve la factura y nada del
// mayor, que vive en otro router con su propio `journal_entries:read`.
//
// Haber pasado la puerta de FACTURAS no es haber pasado la del MAYOR.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  withTransaction: vi.fn(),
  withTenant: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
  getClient: vi.fn(),
}));

const conPermisos = (...permissions: string[]) => ({
  user: { user_id: 'u', tenant_id: 't', entities: ['e'], permissions },
});

describe('los resolutores de campo también piden permiso', () => {
  it('un tipo con campos y sin catálogo no arranca: falla CERRADO', () => {
    expect(() =>
      blindarCampos({ TipoNuevo: { algo: async () => 'x' } })
    ).toThrow(/PERMISOS_DE_CAMPO/);
  });

  it('el campo que cruza de dominio exige el permiso del dominio al que va', async () => {
    const llamado = vi.fn(async () => 'dato');
    const { Invoice } = blindarCampos({
      Invoice: { journalEntry: llamado },
    }) as { Invoice: { journalEntry: (...a: unknown[]) => Promise<unknown> } };

    // Con invoices:read —el permiso de SU tipo— no basta para salir al mayor.
    await expect(
      Invoice.journalEntry({}, {}, conPermisos('invoices:read'), {})
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(llamado).not.toHaveBeenCalled();

    // Con el del destino, pasa.
    await expect(
      Invoice.journalEntry({}, {}, conPermisos('journal_entries:read'), {})
    ).resolves.toBe('dato');
  });

  it('el campo del mismo dominio hereda el permiso base sin declararse', async () => {
    // Un campo NUEVO que nadie listó nace protegido, no abierto: es la razón de
    // que el base se aplique a todo y sólo se declaren los cruces.
    const { Invoice } = blindarCampos({
      Invoice: { recienLlegado: async () => 'dato' },
    }) as { Invoice: { recienLlegado: (...a: unknown[]) => Promise<unknown> } };
    await expect(
      Invoice.recienLlegado({}, {}, conPermisos('accounts:read'), {})
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      Invoice.recienLlegado({}, {}, conPermisos('invoices:read'), {})
    ).resolves.toBe('dato');
  });

  it('el comodín pasa, como en REST', async () => {
    const { Invoice } = blindarCampos({
      Invoice: { journalEntry: async () => 'dato' },
    }) as { Invoice: { journalEntry: (...a: unknown[]) => Promise<unknown> } };
    await expect(Invoice.journalEntry({}, {}, conPermisos('*'), {})).resolves.toBe('dato');
  });

  it('lo que no es función se deja pasar tal cual', () => {
    const salida = blindarCampos({ Invoice: { __resolveType: 'Invoice' } }) as {
      Invoice: { __resolveType: string };
    };
    expect(salida.Invoice.__resolveType).toBe('Invoice');
  });

  it('cada cruce declarado apunta al permiso que guarda su tabla', () => {
    // Ata la declaración al vocabulario de REST: si mañana alguien cambia el
    // permiso de una tabla y no el del cruce, esto lo acusa.
    expect(PERMISOS_DE_CAMPO.Invoice.cruces?.journalEntry).toEqual([
      PERMISO_DE_TABLA.journal_entries,
    ]);
    expect(PERMISOS_DE_CAMPO.JournalEntryLine.cruces?.account).toEqual([PERMISO_DE_TABLA.accounts]);
    expect(PERMISOS_DE_CAMPO.InvoiceLine.cruces?.revenueAccount).toEqual([
      PERMISO_DE_TABLA.accounts,
    ]);
  });
});

// ============================================================
// UNA DENEGACIÓN NO PUEDE PARECER UNA CAÍDA.
// ============================================================
describe('la forma del error en el cable', () => {
  const envuelto = (e: Error) => new GraphQLError(e.message, { originalError: e });

  it('un ForbiddenError sale con su código y sus detalles, no como INTERNAL_SERVER_ERROR', () => {
    const err = new ForbiddenError('Insufficient permissions', {
      required: ['journal_entries:read'],
      missing: ['journal_entries:read'],
      current: ['invoices:read'],
    });
    const salida = formatearError({ message: 'x', extensions: { code: 'INTERNAL_SERVER_ERROR' } }, envuelto(err));
    expect(salida.extensions?.code).toBe(err.code);
    expect(salida.extensions?.status).toBe(err.statusCode);
    expect((salida.extensions?.details as Record<string, unknown>).missing).toEqual([
      'journal_entries:read',
    ]);
  });

  it('los otros errores de dominio viajan igual', () => {
    for (const err of [new ValidationError('mal', 'entityId'), new NotFoundError('Invoice', 'x')]) {
      const salida = formatearError({ message: 'x' }, envuelto(err));
      expect(salida.extensions?.code).toBe(err.code);
      expect(salida.extensions?.status).toBe(err.statusCode);
    }
  });

  it('a lo que no es de dominio se le quita el rastro de pila y no se le inventa código', () => {
    const salida = formatearError(
      { message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['/Users/x/y.ts:1'] } },
      new Error('boom')
    );
    expect(salida.extensions?.stacktrace).toBeUndefined();
    expect(salida.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
  });
});

// ============================================================
// UNA PETICIÓN NOMBRA UNA SOLA ENTIDAD, TAMBIÉN AQUÍ.
//
// `requireEntityAccess` rechaza en REST la combinación cabecera A + argumento B
// aunque las dos sean del mismo token, y no por acceso: el contexto de la
// bitácora se arma SIEMPRE con la cabecera, así que el trabajo ocurre sobre B y
// todo lo registrado dice A. Es atribución falsa y no se repara después, porque
// el rastro ya se escribió así. GraphQL comprobaba sólo pertenencia.
// ============================================================
describe('la regla de una sola entidad se traslada de REST', () => {
  const Query = (resolversReales as { Query: Record<string, (...a: unknown[]) => unknown> }).Query;
  const ctx = (entidadDeCabecera?: string) => ({
    user: { user_id: 'u', tenant_id: 't', entities: ['e1', 'e2'], permissions: ['*'] },
    entityId: 'e1',
    entidadDeCabecera,
  });

  it('cabecera e1 + argumento e2 se rechaza, aunque las DOS sean del token', async () => {
    await expect(
      Query.accounts({}, { entityId: 'e2' }, ctx('e1'), {})
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('sin cabecera, un argumento legítimo NO choca contra el relleno del token', async () => {
    // `authenticate` deja entityId = cabecera || entities[0]; comparar contra
    // eso haría chocar un entityId: 'e2' legítimo con un relleno nunca pedido.
    await expect(
      Query.accounts({}, { entityId: 'e2' }, ctx(undefined), {})
    ).rejects.not.toBeInstanceOf(ValidationError);
  });

  it('cabecera y argumento coincidentes pasan la guarda', async () => {
    await expect(
      Query.accounts({}, { entityId: 'e1' }, ctx('e1'), {})
    ).rejects.not.toBeInstanceOf(ValidationError);
  });
});
