import { parse, Kind } from 'graphql';
import { typeDefs } from './schemas/schema.js';
import { assertPermissions } from '../rest/middleware/auth.js';
import type { Permission } from '../../auth/roles.js';

// ============================================================
// LA PUERTA DE PERMISOS DE GRAPHQL, Y LA COMPUERTA QUE LA MANTIENE CERRADA.
//
// El defecto: `resolvers/index.ts` declaraba `permissions: string[]` en su
// contexto y NO LO LEÍA NUNCA. Sus cinco mutaciones comprobaban sólo
// PERTENENCIA de entidad (assertEntityAccess / requireByIdInScope) y ninguna
// comprobaba PERMISO, mientras sus equivalentes REST lo exigen con
// requirePermission: journal_entries:create · :post · :void y periods:close.
// Con GRAPHQL_ENABLED=true, un `viewer` —cinco permisos de lectura y ninguno
// de escritura— posteaba al mayor, anulaba asientos y cerraba el ejercicio en
// duro.
//
// Aquí no se arregla mutación por mutación, y esa es la parte que importa.
// Cinco comprobaciones repartidas se cierran hoy y se olvidan mañana: el
// esquema declara QUINCE mutaciones y sólo cinco existen, y entre las diez
// ausentes están TIMBRAR y CANCELAR un CFDI ante el SAT. La que se implemente
// mañana sin acordarse del permiso nos devuelve al punto de partida.
//
// Así que la puerta es una sola —`blindar`— y viene con una compuerta que se
// alimenta del ESQUEMA, no de una lista escrita a mano:
//
//   · toda mutación (o consulta) DECLARADA en el esquema tiene que estar o
//     bien implementada Y con permiso declarado aquí, o bien listada en
//     SIN_RESOLUTOR con su motivo;
//   · todo resolutor implementado tiene que tener permiso declarado, y tiene
//     que estar declarado en el esquema (lo segundo lo enseñó la prueba de
//     esta misma compuerta: recorrer sólo el esquema dejaba fuera al resolutor
//     que nadie declaró);
//   · una entrada del catálogo que el esquema no declare también es un hueco:
//     un permiso sobre un campo fantasma es un permiso que nadie aplica, y
//     suele ser la errata que dejó al campo REAL sin puerta.
//
// Y la compuerta no es sólo una prueba: `blindar` la corre al CARGARSE el
// módulo de resolutores y LANZA. Un campo nuevo sin declarar no arranca el
// servidor ni pasa una sola prueba que importe los resolutores. Fallar cerrado
// es lo que hace que el olvido de mañana se note hoy.
// ============================================================

export type RaizGraphQL = 'Query' | 'Mutation' | 'Subscription';

/**
 * Los permisos de cada campo implementado, con los MISMOS nombres que exige
 * REST — la equivalencia va anotada campo a campo, porque el día que las dos
 * puertas contesten distinto sobre el mismo acto, esta tabla es donde se ve.
 *
 * El tipo es `Permission`: un permiso inventado no compila, y `roles.ts` sigue
 * siendo el único catálogo.
 */
export const PERMISOS = {
  Query: {
    // GET /v1/accounts y /v1/accounts/:id → accounts:read
    account: ['accounts:read'],
    accounts: ['accounts:read'],
    // GET /v1/journal-entries y /:id → journal_entries:read
    journalEntry: ['journal_entries:read'],
    journalEntries: ['journal_entries:read'],
    // GET /v1/invoices y /:id → invoices:read
    invoice: ['invoices:read'],
    invoices: ['invoices:read'],
    // GET /v1/reports/trial-balance → reports:read
    trialBalance: ['reports:read'],
    // GET /v1/fiscal-periods → accounts:read (lo que exige hoy la ruta REST)
    fiscalPeriods: ['accounts:read'],
  },
  Mutation: {
    // POST /v1/journal-entries → journal_entries:create
    createJournalEntry: ['journal_entries:create'],
    // POST /v1/journal-entries/:id/post → journal_entries:post
    postJournalEntry: ['journal_entries:post'],
    // POST /v1/journal-entries/:id/void → journal_entries:void
    voidJournalEntry: ['journal_entries:void'],
    // POST /v1/fiscal-periods/:id/soft-close y /hard-close → periods:close
    softClosePeriod: ['periods:close'],
    hardClosePeriod: ['periods:close'],
  },
  // El esquema declara cuatro suscripciones y no hay resolutor de ninguna, ni
  // transporte que las sirva. Se listan abajo, no aquí: la raíz entra en el
  // catálogo para que el día que alguien escriba `Subscription: { ... }` tenga
  // que pasar por la puerta como las otras dos — una suscripción es una
  // lectura continua, y una lectura continua sin permiso es la peor de todas.
  Subscription: {},
} satisfies Record<RaizGraphQL, Record<string, readonly Permission[]>>;

/**
 * LO QUE EL ESQUEMA PROMETE Y NADIE SIRVE.
 *
 * No se implementa nada: se hace EXPLÍCITA la ausencia. Cada entrada dice qué
 * acto sería y con qué permiso lo sirve REST hoy, para que implementarla
 * mañana sea mover una línea de este objeto al de arriba en vez de inventar un
 * permiso desde cero.
 *
 * Mientras estén aquí, el campo revienta al invocarse —Apollo no tiene
 * resolutor para un campo no nulo—. Eso ya pasaba; lo que no había era
 * constancia de que pasa a propósito.
 */
export const SIN_RESOLUTOR = {
  Query: {
    balanceSheet:
      'Declarada y sin resolutor. El informe lo sirve GET /v1/reports/balance-sheet con reports:read.',
    incomeStatement:
      'Declarada y sin resolutor. El informe lo sirve GET /v1/reports/income-statement con reports:read.',
  },
  Mutation: {
    createAccount:
      'Declarada y sin resolutor. El alta de cuenta la sirve POST /v1/accounts con accounts:create.',
    updateAccount:
      'Declarada y sin resolutor. La edición la sirve PUT /v1/accounts/:id con accounts:update.',
    deleteAccount:
      'Declarada y sin resolutor. La baja la sirve DELETE /v1/accounts/:id con accounts:delete.',
    reverseJournalEntry:
      'Declarada y sin resolutor. La reversión la sirve POST /v1/journal-entries/:id/reverse con journal_entries:create.',
    createInvoice:
      'Declarada y sin resolutor. La emisión la sirve POST /v1/invoices con invoices:create.',
    sendInvoice:
      'Declarada y sin resolutor. El envío lo sirve POST /v1/invoices/:id/send con invoices:send.',
    voidInvoice:
      'Declarada y sin resolutor. La anulación la sirve POST /v1/invoices/:id/void con invoices:void.',
    recordInvoicePayment:
      'Declarada y sin resolutor. El cobro lo sirve POST /v1/invoices/:id/payments con invoices:create.',
    stampCfdi:
      'Declarada y sin resolutor. TIMBRA ANTE EL SAT: lo sirve POST /v1/invoices/:id/cfdi/stamp con ' +
      'invoices:create. Es el acto externo e irreversible de esta lista; si vuelve, vuelve por la puerta.',
    cancelCfdi:
      'Declarada y sin resolutor. CANCELA ANTE EL SAT: lo sirve POST /v1/invoices/:id/cfdi/cancel con invoices:void.',
  },
  Subscription: {
    journalEntryPosted:
      'Declarada y sin resolutor ni transporte. Sería lectura continua del mayor: pediría journal_entries:read.',
    invoicePaid:
      'Declarada y sin resolutor ni transporte. Sería lectura continua de cobros: pediría invoices:read.',
    periodClosed:
      'Declarada y sin resolutor ni transporte. Sería lectura continua del calendario fiscal: pediría accounts:read.',
    bankTransactionImported:
      'Declarada y sin resolutor ni transporte. Sería lectura continua del banco: pediría reports:read.',
  },
} satisfies Record<RaizGraphQL, Record<string, string>>;

/** Un campo que no cumple la compuerta, con el motivo dicho en qué falta. */
export interface HuecoDeCompuerta {
  /**
   * La raíz —Query/Mutation/Subscription— o, para los huecos que acusa
   * `blindarCampos`, el TIPO cuyos resolutores de campo quedaron sin permiso.
   * Es carga diagnóstica, no una llave: por eso admite las dos cosas.
   */
  raiz: string;
  campo: string;
  motivo: string;
}

/** El catálogo contra el que se juzga una raíz; parametrizado para poder probarlo. */
export interface CatalogoDeCompuerta {
  permisos: Readonly<Record<string, readonly string[]>>;
  sinResolutor: Readonly<Record<string, string>>;
}

const CATALOGO: Record<RaizGraphQL, CatalogoDeCompuerta> = {
  Query: { permisos: PERMISOS.Query, sinResolutor: SIN_RESOLUTOR.Query },
  Mutation: { permisos: PERMISOS.Mutation, sinResolutor: SIN_RESOLUTOR.Mutation },
  Subscription: { permisos: PERMISOS.Subscription, sinResolutor: SIN_RESOLUTOR.Subscription },
};

/** Las raíces que un resolutor puede servir. Se recorren enteras, nunca a mano. */
export const RAICES: readonly RaizGraphQL[] = ['Query', 'Mutation', 'Subscription'];

/**
 * Los campos que el esquema declara bajo una raíz.
 *
 * Se PARSEA con el mismo `graphql` que sirve el esquema, no con una expresión
 * regular: el esquema es el contrato, y un contrato leído a ojo es cómo se
 * cuela el campo que la compuerta no ve. La auditoría III contó 17 mutaciones
 * donde el esquema declara 15 — contarlas a mano es justo el error que esto no
 * puede cometer.
 */
export function camposDeclarados(esquema: string, raiz: RaizGraphQL): string[] {
  const doc = parse(esquema);
  const campos: string[] = [];
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OBJECT_TYPE_DEFINITION || def.name.value !== raiz) continue;
    for (const f of def.fields ?? []) campos.push(f.name.value);
  }
  return campos;
}

/**
 * LA COMPUERTA. Devuelve los huecos; vacío significa que la raíz está cerrada.
 *
 * Es una función pura de (esquema, implementadas, catálogo) para que una prueba
 * pueda FABRICAR una mutación nueva y comprobar que la acusa: una compuerta que
 * sólo se ejercita cambiando el repositorio de verdad no se ejercita nunca.
 */
export function auditarRaiz(
  esquema: string,
  raiz: RaizGraphQL,
  implementadas: readonly string[],
  catalogo: CatalogoDeCompuerta = CATALOGO[raiz]
): HuecoDeCompuerta[] {
  const declarados = camposDeclarados(esquema, raiz);
  const conPermiso = new Set(Object.keys(catalogo.permisos));
  const sinResolutor = new Set(Object.keys(catalogo.sinResolutor));
  const implementados = new Set(implementadas);
  const huecos: HuecoDeCompuerta[] = [];

  for (const campo of declarados) {
    const tienePermiso = conPermiso.has(campo);
    const seDeclaraAusente = sinResolutor.has(campo);
    const existe = implementados.has(campo);

    if (existe && seDeclaraAusente) {
      // Se juzga ANTES que la falta de permiso: si el catálogo se contradice,
      // decir «declara su permiso» manda a arreglar la mitad equivocada.
      huecos.push({
        raiz,
        campo,
        motivo: 'está implementado y a la vez declarado como no implementado: el catálogo se contradice.',
      });
      continue;
    }
    if (existe && !tienePermiso) {
      huecos.push({
        raiz,
        campo,
        motivo:
          'tiene resolutor y ningún permiso declarado: entraría por la puerta sin que la puerta pregunte nada. ' +
          `Declara su permiso en PERMISOS.${raiz}, el mismo que exige su ruta REST.`,
      });
      continue;
    }
    if (!existe && tienePermiso) {
      huecos.push({
        raiz,
        campo,
        motivo:
          'declara permiso y no tiene resolutor: o falta la implementación, o sobra la entrada. ' +
          'Un permiso sobre un campo que nadie sirve es un permiso que nadie aplica.',
      });
      continue;
    }
    if (!existe && !seDeclaraAusente) {
      huecos.push({
        raiz,
        campo,
        motivo:
          'el esquema lo declara y no está ni implementado ni listado como ausente. ' +
          `Impleméntalo con su permiso en PERMISOS.${raiz}, o dilo en SIN_RESOLUTOR.${raiz} con el motivo.`,
      });
    }
  }

  const enElEsquema = new Set(declarados);

  // EL RESOLUTOR QUE EL ESQUEMA NO DECLARA.
  //
  // Lo encontró la propia prueba de esta compuerta: al fabricar una mutación
  // nueva SÓLO en los resolutores, el recorrido de arriba —que va campo a
  // campo del esquema— no la veía, y `blindar` la habría envuelto sin permiso
  // que exigir. Apollo lo rechazaría al construir el esquema, sí; pero una
  // compuerta que depende de que otro la salve no es una compuerta.
  for (const campo of implementadas) {
    if (!enElEsquema.has(campo)) {
      huecos.push({
        raiz,
        campo,
        motivo:
          'tiene resolutor y el esquema no lo declara: nadie puede invocarlo y nada dice con qué permiso ' +
          'debería entrar el día que se declare. Decláralo en el esquema o retira el resolutor.',
      });
    }
  }

  for (const campo of [...conPermiso, ...sinResolutor]) {
    if (!enElEsquema.has(campo)) {
      huecos.push({
        raiz,
        campo,
        motivo:
          'el catálogo lo nombra y el esquema no lo declara. O es una errata —y entonces el campo REAL se ' +
          'quedó sin puerta— o es el resto de un campo retirado.',
      });
    }
  }

  // Un motivo telegráfico es una casilla marcada, no una razón: quien llegue
  // dentro de un año tiene que poder actuar con lo que diga.
  for (const [campo, motivo] of Object.entries(catalogo.sinResolutor)) {
    if (motivo.trim().length < 40) {
      huecos.push({
        raiz,
        campo,
        motivo: 'se declara no implementado sin decir por qué ni qué sirve ese acto hoy.',
      });
    }
  }

  return huecos;
}

/** El fallo de la compuerta al cargar: se lanza, no se registra. */
export class CompuertaAbiertaError extends Error {
  constructor(public readonly huecos: HuecoDeCompuerta[]) {
    super(
      'GraphQL: la compuerta de permisos encontró campos sin cerrar.\n' +
        huecos.map((h) => `  · ${h.raiz}.${h.campo}: ${h.motivo}`).join('\n') +
        '\nMientras esto no cuadre, los resolutores no se cargan: una puerta a medio cerrar es una puerta abierta.'
    );
    this.name = 'CompuertaAbiertaError';
  }
}

/** Cualquier resolutor de Apollo. `never[]` acepta toda firma sin recurrir a `any`. */
type Resolutor = (...args: never[]) => unknown;

/** Del contexto que arma src/index.ts sólo interesa aquí quién pregunta. */
interface CtxConPrincipal {
  user?: { permissions: string[] };
}

/**
 * EL ÚNICO PUNTO DE PASO.
 *
 * Envuelve TODOS los campos de una raíz con la comprobación de permisos —el
 * mismo `assertPermissions` que usa `requirePermission` en REST, no una copia—
 * y antes de envolver nada corre la compuerta contra el esquema. Si algo no
 * cuadra, lanza y el módulo de resolutores no llega a existir.
 *
 * El permiso se pregunta ANTES que la pertenencia, igual que en REST, donde
 * `requirePermission` es middleware y el alcance se comprueba dentro del
 * manejador. No filtra nada: la respuesta depende sólo de la lista de permisos
 * del propio llamador, y es la misma para un id que existe y para uno inventado.
 *
 * La envoltura es `async` a propósito: los resolutores de estas dos raíces ya
 * lo son, y así el rechazo por permiso llega como promesa rechazada igual que
 * cualquier otro fallo, en vez de como excepción síncrona que cada llamador
 * tendría que tratar aparte.
 */
export function blindar<T extends Record<string, Resolutor>>(raiz: RaizGraphQL, impl: T): T {
  const huecos = auditarRaiz(typeDefs, raiz, Object.keys(impl));
  if (huecos.length > 0) throw new CompuertaAbiertaError(huecos);

  const permisosDe = CATALOGO[raiz].permisos;
  const blindados: Record<string, Resolutor> = {};
  for (const [campo, resolutor] of Object.entries(impl)) {
    const exigidos = permisosDe[campo];
    const llamar = resolutor as (...args: unknown[]) => unknown;
    blindados[campo] = async (...args: unknown[]) => {
      // El contexto es el tercer argumento de todo resolutor de Apollo.
      assertPermissions((args[2] as CtxConPrincipal | undefined)?.user, exigidos);
      return llamar(...args);
    };
  }
  return blindados as T;
}

// ============================================================
// LOS RESOLUTORES DE CAMPO TAMBIÉN SON PUERTAS.
//
// `blindar` cubre las raíces —Query y Mutation—, y con eso solo la puerta se
// rodea por el grafo, que es lo que GraphQL es. Medido: con `permissions:
// ['invoices:read']` y nada más, la raíz `journalEntries` contesta «Insufficient
// permissions» y en la MISMA corrida
//
//   invoices(entityId){ journalEntry { lines { account { code name } } } }
//
// devuelve el asiento, sus renglones y filas del catálogo de cuentas, porque
// `Invoice.journalEntry`, `JournalEntry.lines` y `JournalEntryLine.account` van
// a `query()` por su cuenta. REST no da eso: `GET /v1/invoices/:id` con
// `invoices:read` devuelve la factura y nada del mayor, que vive en otro router
// con su propio `journal_entries:read`.
//
// El argumento de que «sólo se llega desde una fila raíz que ya pasó» es cierto
// y no basta: haber pasado la puerta de FACTURAS no es haber pasado la del
// MAYOR. Y no es una configuración exótica — `users.permissions` es una columna
// jsonb libre que se copia literal, así que un principal con sólo
// `invoices:read` es lo ordinario.
//
// CÓMO SE CIERRA, y por qué así. Cada tipo declara el permiso BASE de su propio
// dominio, y TODO resolutor de campo suyo se envuelve con él aunque sólo
// renombre una columna: un campo nuevo hereda protección en vez de nacer
// abierto. Los únicos que se declaran uno por uno son los que CRUZAN a otro
// dominio, que son tres y son exactamente los que la lente usó para entrar.
// Enumerar los noventa y cinco campos a mano habría sido una lista que nadie
// mantiene. El cruce sin declarar lo caza `permisos.spec.ts`, que lee el fuente
// de los resolutores y exige declaración explícita para todo campo que nombre
// una tabla cuyo permiso no sea el base de su tipo.
// ============================================================

/** El permiso que guarda cada tabla, tal como lo exige REST hoy. */
export const PERMISO_DE_TABLA: Record<string, string> = {
  accounts: 'accounts:read',
  journal_entries: 'journal_entries:read',
  journal_entry_lines: 'journal_entries:read',
  invoices: 'invoices:read',
  invoice_lines: 'invoices:read',
  // customers y vendors no tienen permiso propio: sus routers REST los sirven
  // bajo el del documento que los usa (customers.ts → invoices:read,
  // vendors.ts → bills:read). Se copia esa decisión, no se inventa otra.
  customers: 'invoices:read',
  customer_payments: 'invoices:read',
  bills: 'bills:read',
  bill_lines: 'bills:read',
  vendors: 'bills:read',
};

interface CamposDeTipo {
  /** Se aplica a TODO campo del tipo que no aparezca en `cruces`. */
  base: string[];
  /** Campos que leen otro dominio y por eso piden su permiso, no el base. */
  cruces?: Record<string, string[]>;
}

export const PERMISOS_DE_CAMPO: Record<string, CamposDeTipo> = {
  Account: { base: ['accounts:read'] },
  JournalEntry: { base: ['journal_entries:read'] },
  JournalEntryLine: {
    base: ['journal_entries:read'],
    cruces: { account: ['accounts:read'] },
  },
  Invoice: {
    base: ['invoices:read'],
    cruces: { journalEntry: ['journal_entries:read'] },
  },
  InvoiceLine: {
    base: ['invoices:read'],
    cruces: { revenueAccount: ['accounts:read'] },
  },
  Customer: { base: ['invoices:read'] },
  CustomerPayment: { base: ['invoices:read'] },
  Bill: { base: ['bills:read'] },
  Vendor: { base: ['bills:read'] },
  // GET /v1/fiscal-periods exige accounts:read; se copia, no se elige.
  FiscalPeriod: { base: ['accounts:read'] },
};

/**
 * Envuelve los resolutores de CAMPO de todo tipo que no sea una raíz.
 *
 * Falla CERRADO: un tipo con resolutores que no esté en `PERMISOS_DE_CAMPO`
 * lanza al cargar el módulo, igual que hace `blindar` con una raíz sin catálogo.
 * Así, añadir un tipo nuevo obliga a decidir su permiso antes de que arranque el
 * servidor, en vez de descubrirlo cuando alguien lo aproveche.
 */
export function blindarCampos<T extends Record<string, unknown>>(raices: T): T {
  const salida: Record<string, unknown> = {};
  const sinCatalogo: string[] = [];

  for (const [tipo, impl] of Object.entries(raices)) {
    if ((RAICES as readonly string[]).includes(tipo)) {
      salida[tipo] = impl; // Query/Mutation/Subscription ya pasaron por blindar().
      continue;
    }
    const catalogo = PERMISOS_DE_CAMPO[tipo];
    if (!catalogo) {
      sinCatalogo.push(tipo);
      continue;
    }
    const campos: Record<string, unknown> = {};
    for (const [campo, resolutor] of Object.entries(impl as Record<string, unknown>)) {
      if (typeof resolutor !== 'function') {
        campos[campo] = resolutor;
        continue;
      }
      const exigidos = catalogo.cruces?.[campo] ?? catalogo.base;
      const llamar = resolutor as (...args: unknown[]) => unknown;
      campos[campo] = async (...args: unknown[]) => {
        assertPermissions((args[2] as CtxConPrincipal | undefined)?.user, exigidos);
        return llamar(...args);
      };
    }
    salida[tipo] = campos;
  }

  if (sinCatalogo.length > 0) {
    throw new CompuertaAbiertaError(
      sinCatalogo.map((t) => ({
        raiz: t,
        campo: '*',
        motivo:
          'sirve resolutores de campo y no declara permiso en PERMISOS_DE_CAMPO: ' +
          'un resolutor de campo llega a la base por su cuenta, así que nace abierto',
      }))
    );
  }
  return salida as T;
}
