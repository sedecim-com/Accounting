import { query } from '../../../database/connection.js';
import { assertEntityAccess } from '../../rest/middleware/auth.js';
import { findByIdInScope, requireByIdInScope, entityScope } from '../../../database/scope.js';
import {
  ForbiddenError,
  ValidationError,
} from '../../../utils/errors.js';
import { blindar, blindarCampos } from '../permisos.js';
import {
  attestEntryAsync,
  createJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  voidJournalEntry,
  softClosePeriod,
  hardClosePeriod,
} from '../../../services/accounting/index.js';
// LOS MISMOS SERVICIOS QUE LLAMA REST, no una segunda implementación.
//
// Una mutación de GraphQL es otra puerta al mismo motor: aquí no se decide
// cuándo una cuenta puede darse de baja, ni cómo se contra-asienta una factura
// anulada, ni qué asiento arma un cobro. Todo eso vive en services/ y lo llaman
// también los routers REST, la terminal y las herramientas del agente. Lo único
// que añade este archivo es traducir el vocabulario del esquema (camelCase,
// enums en MAYÚSCULAS) al de los servicios, y acotar por entidad.
import {
  createAccount,
  updateAccount,
  deactivateAccount,
  type AccountPatch,
  type AccountType as TipoDeCuenta,
  type NormalBalance as SaldoNormal,
} from '../../../services/accounting/account-service.js';
import { createInvoice, voidInvoice } from '../../../services/ar/invoice-service.js';
import { recordCustomerPayment } from '../../../services/payments/payment-service.js';
import type { Account, JournalEntry, JournalEntryLine, Invoice, FiscalPeriod } from '../../../types/index.js';
import { JournalEntryType } from '../../../types/index.js';

/**
 * GraphQL context user: the full JWT payload (see src/index.ts context).
 *
 * `permissions` estaba declarado aquí desde el principio y NO SE LEÍA NUNCA.
 * Las cinco mutaciones comprobaban pertenencia de entidad y nada más, de modo
 * que con GRAPHQL_ENABLED=true cualquier principal con acceso a la entidad
 * posteaba al mayor y cerraba periodos sin el permiso que REST le habría
 * exigido. Ahora lo lee UNA sola cosa —`blindar`, en ../permisos.ts— por la
 * que entran todos los campos de Query y Mutation; ningún resolutor de este
 * archivo vuelve a preguntar por su cuenta, que es como se olvida la sexta.
 */
interface CtxUser {
  user_id: string;
  entities: string[];
  permissions: string[];
}

/**
 * El contexto que arma src/index.ts. tenantId y entityId salen de
 * `authenticate`, que ya contrasta la cabecera x-entity-id contra las
 * entidades del token: por eso se pueden usar como alcance sin volver a
 * comprobarlos.
 */
interface Ctx {
  user: CtxUser;
  tenantId?: string;
  entityId?: string;
  /** La cabecera x-entity-id tal cual vino, o undefined si no vino. */
  entidadDeCabecera?: string;
}

/**
 * EL ALCANCE DE UNA PETICIÓN DE GRAPHQL.
 *
 * GraphQL es la segunda puerta al mismo motor, y era la peor guardada. Su
 * único control de pertenencia sobre `postJournalEntry` y `voidJournalEntry`
 * era leer `SELECT entity_id FROM journal_entries WHERE id = $1` sin acotar y
 * comparar después. Ese patrón falla de las tres maneras que documenta
 * database/scope.ts: deja ventana entre la comprobación y la escritura,
 * depende de que cada resolutor se acuerde, y ramifica —404 si no existe, 403
 * si es de otro—, con lo que la respuesta delata la existencia de asientos
 * ajenos aunque no deje tocarlos.
 *
 * Un token sin inquilino o sin entidad no puede acotarse; no se sigue.
 *
 * Son dos funciones y no una porque `Scope` es una UNIÓN: un alcance de
 * inquilino no tiene entidad, así que leerle `entityId` a lo que devuelve
 * `alcanceDe` no compila —y hace bien—. Varios servicios exigen la entidad
 * suelta en su firma (`voidInvoice`, `recordCustomerPayment`) y la atestación
 * exige el inquilino, así que `inquilinoYEntidad` los entrega ya comprobados
 * en vez de repartir `ctx.entityId!` por los resolutores.
 */
function inquilinoYEntidad(ctx: Ctx): { tenantId: string; entityId: string } {
  if (!ctx.tenantId || !ctx.entityId) {
    throw new ForbiddenError(
      'La petición no identifica inquilino y entidad: no puede acotarse y se rechaza.'
    );
  }
  return { tenantId: ctx.tenantId, entityId: ctx.entityId };
}

/**
 * LAS CLAVES FORÁNEAS DEL INPUT TAMBIÉN SE ACOTAN.
 *
 * Acotar la entidad SOBRE la que se crea y dejar sueltos los ids que el cliente
 * mete DENTRO deja abierto el eje que RLS no defiende: RLS acota por INQUILINO,
 * así que dentro de un despacho con dos sociedades un token de la entidad A
 * podía crear en A una factura con el `customerId` y el `revenueAccountId` de la
 * hermana B — y a partir de ahí el grafo se los devolvía: la ficha fiscal de B
 * (RFC, correo, razón social) y la LISTA de facturas de B con folios e importes.
 * `createAccount` era peor: colgaba una cuenta de A del catálogo de B y el
 * `full_code` salía con el código de B dentro.
 *
 * El contraste lo decide: al MISMO usuario, el camino sancionado
 * —`GET /v1/customers/:id`, que va por `findByIdInScope`— le devuelve null. REST
 * cierra esa lectura; esta puerta la abría por escritura.
 */
async function exigirEnAlcance(
  ctx: Ctx,
  entityId: string,
  refs: Array<{ tabla: string; id: string | null | undefined }>
): Promise<void> {
  const { tenantId } = inquilinoYEntidad(ctx);
  const alcance = entityScope(tenantId, entityId);
  for (const { tabla, id } of refs) {
    if (typeof id === 'string' && id !== '') {
      await requireByIdInScope(tabla, id, alcance, { columns: 'id' });
    }
  }
}

function alcanceDe(ctx: Ctx) {
  const { tenantId, entityId } = inquilinoYEntidad(ctx);
  return entityScope(tenantId, entityId);
}

/**
 * LA PERTENENCIA EN LAS CONSULTAS QUE RECIBEN LA ENTIDAD DEL CLIENTE.
 *
 * Cinco consultas —accounts, journalEntries, invoices, trialBalance y
 * fiscalPeriods— metían `args.entityId` en el WHERE sin `ctx` siquiera en la
 * firma. RLS acota por INQUILINO, así que en un despacho con dos clientes en
 * el mismo inquilino bastaba pedir la otra entidad:
 * `trialBalance(entityId: "<B>")` devolvía el balance completo de B a un
 * usuario con acceso sólo a A. La auditoría III lo midió y lo dejó por
 * escrito; esto lo cierra.
 *
 * Se comprueba PERTENENCIA (lo que el token concede), igual que `assertEntityAccess`
 * en REST, y no igualdad con la entidad activa: un token con dos entidades
 * legítimas tiene que poder consultar la segunda sin cambiar de cabecera, que
 * es exactamente lo que hace `requireEntityAccess` cuando la petición NOMBRA
 * una entidad. Las consultas por id no pasan por aquí: ésas se acotan dentro
 * del SQL con `alcanceDe`, que además no distingue «no existe» de «no es tuyo».
 */
function entidadPedida(ctx: Ctx, entityId: unknown): string {
  if (typeof entityId !== 'string' || entityId === '') {
    throw new ForbiddenError(
      'La consulta no nombra la entidad sobre la que actúa: no puede acotarse y se rechaza.'
    );
  }
  assertEntityAccess(ctx.user, entityId);

  // UNA PETICIÓN NOMBRA UNA SOLA ENTIDAD, también aquí.
  //
  // `requireEntityAccess` rechaza en REST la combinación cabecera A + argumento
  // B AUNQUE LAS DOS SEAN SUYAS, y no por acceso: el contexto de la bitácora se
  // arma siempre con la cabecera, así que el trabajo ocurre sobre B y todo lo
  // registrado dice A. Es atribución falsa, y no se repara después porque el
  // rastro ya se escribió así. La razón vale igual para esta puerta.
  //
  // Se compara contra la cabecera CRUDA y no contra `ctx.entityId`, que
  // `authenticate` rellena con la primera entidad del token cuando no hay
  // cabecera: mezclarlos haría chocar un `entityId:` legítimo contra un relleno
  // que el cliente nunca pidió.
  const cabecera = ctx.entidadDeCabecera;
  if (cabecera && cabecera !== entityId) {
    throw new ValidationError(
      `La petición nombra 2 entidades distintas (la cabecera x-entity-id: ${cabecera}; ` +
        `el argumento entityId: ${entityId}). La bitácora registra la de la cabecera, así que ` +
        'con dos no se puede saber sobre cuál se trabajó. Manda una sola.',
      'entityId'
    );
  }
  return entityId;
}

// ============================================================
// LAS ENTRADAS DEL ESQUEMA, ESCRITAS.
//
// Se declaran en vez de recibir `Record<string, unknown>` y castear campo a
// campo: los servicios que hay debajo tienen firmas estrictas —`account_type`
// es una unión cerrada, `lines` no admite un renglón sin cuenta de ingreso— y
// escribir la entrada aquí es lo que hace que una traducción mal hecha la cace
// el compilador y no Postgres. Los nombres son los del ESQUEMA (camelCase); la
// traducción a los de la base va en cada resolutor.
// ============================================================

/** input CreateAccountInput. Los enums llegan en MAYÚSCULAS. */
interface EntradaCrearCuenta {
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
  parentId?: string | null;
  entityId: string;
  currencyCode?: string | null;
  allowManualEntries?: boolean | null;
  description?: string | null;
  fsCategory?: string | null;
}

/** input UpdateAccountInput. Todos opcionales: es un parche. */
interface EntradaEditarCuenta {
  name?: string | null;
  description?: string | null;
  isActive?: boolean | null;
  fsCategory?: string | null;
  tags?: unknown;
}

/** input InvoiceLineInput. */
interface EntradaRenglonFactura {
  itemId?: string | null;
  description?: string | null;
  quantity?: string | number | null;
  unitPrice: string | number;
  revenueAccountId: string;
  taxCode?: string | null;
  taxRate?: string | number | null;
  projectId?: string | null;
  cfdiProductCode?: string | null;
  cfdiUnitCode?: string | null;
}

/** input CreateInvoiceInput. */
interface EntradaCrearFactura {
  entityId: string;
  customerId: string;
  invoiceDate: string;
  dueDate: string;
  currencyCode?: string | null;
  lines: EntradaRenglonFactura[];
  terms?: string | null;
  memo?: string | null;
  poNumber?: string | null;
}

// `blindarCampos` envuelve además los resolutores de CAMPO. Sin él la puerta
// cubre sólo las raíces y se rodea por el grafo: se entra por una factura que
// sí se tiene y se sale a su asiento, sus renglones y el catálogo de cuentas.
export const resolvers = blindarCampos({
  Query: blindar('Query', {
    async account(_: unknown, { id }: { id: string }, ctx: Ctx) {
      // Cerrar la mutación y dejar la lectura suelta sería cerrar media puerta.
      return findByIdInScope<Account>('accounts', id, alcanceDe(ctx));
    },

    async accounts(_: unknown, args: { entityId: string; accountType?: string; isActive?: boolean; search?: string; first?: number }, ctx: Ctx) {
      let where = 'WHERE entity_id = $1';
      const params: unknown[] = [entidadPedida(ctx, args.entityId)];
      let idx = 2;

      if (args.accountType) { where += ` AND account_type = $${idx++}`; params.push(args.accountType.toLowerCase()); }
      if (args.isActive !== undefined) { where += ` AND is_active = $${idx++}`; params.push(args.isActive); }
      if (args.search) { where += ` AND (code ILIKE $${idx} OR name ILIKE $${idx})`; params.push(`%${args.search}%`); idx++; }

      const countResult = await query<{ count: string }>(`SELECT COUNT(*) as count FROM accounts ${where}`, params);
      const result = await query<Account>(
        `SELECT * FROM accounts ${where} ORDER BY code LIMIT $${idx}`,
        [...params, args.first || 50]
      );

      return {
        edges: result.rows.map((node) => ({ node, cursor: node.id })),
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: parseInt(countResult.rows[0].count, 10),
      };
    },

    async journalEntry(_: unknown, { id }: { id: string }, ctx: Ctx) {
      return findByIdInScope<JournalEntry>('journal_entries', id, alcanceDe(ctx));
    },

    async journalEntries(_: unknown, args: Record<string, unknown>, ctx: Ctx) {
      let where = 'WHERE entity_id = $1';
      const params: unknown[] = [entidadPedida(ctx, args.entityId)];
      let idx = 2;

      if (args.fiscalPeriodId) { where += ` AND fiscal_period_id = $${idx++}`; params.push(args.fiscalPeriodId); }
      if (args.status) { where += ` AND status = $${idx++}`; params.push((args.status as string).toLowerCase()); }
      if (args.startDate) { where += ` AND entry_date >= $${idx++}`; params.push(args.startDate); }
      if (args.endDate) { where += ` AND entry_date <= $${idx++}`; params.push(args.endDate); }

      const result = await query<JournalEntry>(
        `SELECT * FROM journal_entries ${where} ORDER BY entry_date DESC LIMIT $${idx}`,
        [...params, args.first || 50]
      );
      return result.rows;
    },

    async invoice(_: unknown, { id }: { id: string }, ctx: Ctx) {
      // Era `SELECT * FROM invoices WHERE id = $1` a secas: con el UUID a la
      // vista —y aquí los identificadores circulan— se leía la factura de otra
      // entidad del mismo inquilino, con su cliente, su total y su UUID fiscal.
      // El filtro va dentro del SQL, como en journalEntry y account.
      return findByIdInScope<Invoice>('invoices', id, alcanceDe(ctx));
    },

    async invoices(_: unknown, args: Record<string, unknown>, ctx: Ctx) {
      let where = 'WHERE entity_id = $1';
      const params: unknown[] = [entidadPedida(ctx, args.entityId)];
      let idx = 2;

      if (args.customerId) { where += ` AND customer_id = $${idx++}`; params.push(args.customerId); }
      if (args.status) { where += ` AND status = $${idx++}`; params.push((args.status as string).toLowerCase()); }

      const result = await query<Invoice>(
        `SELECT * FROM invoices ${where} ORDER BY invoice_date DESC LIMIT $${idx}`,
        [...params, args.first || 50]
      );
      return result.rows;
    },

    async trialBalance(_: unknown, args: Record<string, unknown>, ctx: Ctx) {
      const entityId = entidadPedida(ctx, args.entityId);
      // Delegate to report service logic
      const result = await query(
        `SELECT a.id as account_id, a.code as account_code, a.name as account_name, a.account_type,
          COALESCE(SUM(jel.debit_amount), 0) as debit_total,
          COALESCE(SUM(jel.credit_amount), 0) as credit_total,
          COALESCE(SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)), 0) as ending_balance
         FROM accounts a
         LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
         LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
         WHERE a.entity_id = $1 AND a.is_active = true
         GROUP BY a.id, a.code, a.name, a.account_type ORDER BY a.code`,
        [entityId]
      );

      return {
        entityId,
        accounts: result.rows,
        totals: {
          totalDebits: result.rows.reduce((s: number, r: Record<string, unknown>) => s + parseFloat(r.debit_total as string), 0),
          totalCredits: result.rows.reduce((s: number, r: Record<string, unknown>) => s + parseFloat(r.credit_total as string), 0),
          isBalanced: true,
        },
      };
    },

    async fiscalPeriods(_: unknown, args: { entityId: string; status?: string }, ctx: Ctx) {
      let where = 'WHERE entity_id = $1';
      const params: unknown[] = [entidadPedida(ctx, args.entityId)];
      if (args.status) { where += ' AND status = $2'; params.push(args.status.toLowerCase()); }

      const result = await query<FiscalPeriod>(
        `SELECT * FROM fiscal_periods ${where} ORDER BY start_date`,
        params
      );
      return result.rows;
    },
  }),

  Mutation: blindar('Mutation', {
    // POST /v1/accounts, el mismo `createAccount` del servicio. Lo único que
    // hace de más esta puerta es traducir vocabulario: los enums del esquema
    // viajan en MAYÚSCULAS (ASSET, DEBIT, CURRENT_ASSETS) y las columnas los
    // guardan en minúsculas — es la misma traducción que hacen ya al revés los
    // resolutores de campo (`accountType: (a) => a.account_type?.toUpperCase()`).
    // La regla de la cuenta de agrupación, el choque de códigos y el resto de
    // reglas del catálogo se quedan donde estaban.
    async createAccount(_: unknown, { input }: { input: EntradaCrearCuenta }, ctx: Ctx) {
      const entityId = entidadPedida(ctx, input.entityId);
      await exigirEnAlcance(ctx, entityId, [{ tabla: 'accounts', id: input.parentId }]);
      return createAccount({
        code: input.code,
        name: input.name,
        account_type: input.accountType.toLowerCase() as TipoDeCuenta,
        normal_balance: input.normalBalance.toLowerCase() as SaldoNormal,
        fs_category: input.fsCategory ? input.fsCategory.toLowerCase() : null,
        parent_id: input.parentId ?? null,
        entity_id: entityId,
        currency_code: input.currencyCode ?? null,
        allow_manual_entries: input.allowManualEntries ?? undefined,
        description: input.description ?? null,
        created_by: ctx.user.user_id,
      });
    },

    async updateAccount(
      _: unknown,
      { id, input }: { id: string; input: EntradaEditarCuenta },
      ctx: Ctx
    ) {
      // PATCH /v1/accounts/:id NO acota por entidad: pide accounts:update y
      // luego hace `UPDATE accounts ... WHERE id = $n` a secas, así que
      // conocer un UUID basta para renombrar o desactivar la cuenta de otra
      // sociedad del mismo inquilino. Ese hueco de REST no se copia: el filtro
      // va dentro del SQL, como en `account(id)`, y por eso «no existe» y «no
      // es de tu entidad» salen los dos por NotFoundError.
      await requireByIdInScope('accounts', id, alcanceDe(ctx), { columns: 'id' });

      // Sólo los cinco campos que el esquema declara. `updateAccount` vuelve a
      // filtrar por UPDATABLE_FIELDS y exige al menos uno: si no llega
      // ninguno, la negativa la da el servicio con su mensaje, no una copia.
      const patch: AccountPatch = {};
      if (input.name != null) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.isActive != null) patch.is_active = input.isActive;
      if (input.fsCategory != null) patch.fs_category = input.fsCategory.toLowerCase();
      if (input.tags !== undefined) patch.tags = input.tags;

      return updateAccount(id, patch, ctx.user.user_id);
    },

    // `deleteAccount` NO BORRA, y el nombre viene del esquema.
    //
    // DELETE /v1/accounts/:id llama a `deactivateAccount`: pone is_active =
    // false y SE NIEGA si la cuenta tiene un solo renglón en el mayor. No
    // podría ser otra cosa — borrar una cuenta con historia rompe la partida
    // doble de los asientos que la nombran—, y la convención R9 de esta casa
    // llama ARCHIVAR a ese acto (`mnemosine account archive`).
    //
    // Aquí se hace EXACTAMENTE eso y nada más: las opciones se pasan por
    // omisión, igual que la ruta, así que sigue sin permitirse la baja de una
    // cuenta con movimientos. Ni se borra de verdad para que el nombre encaje,
    // ni se renombra la mutación: el nombre de un campo del esquema es
    // contrato público y cambiarlo no es decisión de quien lo implementa.
    // Queda dicho aquí porque un lector del esquema no puede saberlo.
    //
    // Devuelve `true` porque el esquema declara `Boolean!`, y llegar a esa
    // línea significa que la baja lógica ocurrió: toda negativa sale antes por
    // excepción (ValidationError si hay historia, NotFoundError si no alcanza).
    async deleteAccount(_: unknown, { id }: { id: string }, ctx: Ctx) {
      await requireByIdInScope('accounts', id, alcanceDe(ctx), { columns: 'id' });
      await deactivateAccount(id, ctx.user.user_id);
      return true;
    },

    async createJournalEntry(_: unknown, { input }: { input: Record<string, unknown> }, ctx: Ctx) {
      assertEntityAccess(ctx.user, input.entityId as string);
      const lines = (input.lines as Array<Record<string, unknown>>).map((l) => ({
        account_id: l.accountId as string,
        debit_amount: l.debitAmount ? String(l.debitAmount) : null,
        credit_amount: l.creditAmount ? String(l.creditAmount) : null,
        description: (l.description as string) || '',
        cost_center_id: l.costCenterId as string,
        project_id: l.projectId as string,
      }));

      return createJournalEntry(
        input.entityId as string,
        new Date(input.entryDate as string),
        ((input.entryType as string) || 'standard').toLowerCase() as JournalEntryType,
        input.description as string || '',
        lines,
        ctx.user.user_id,
        { autoPost: input.autoPost as boolean }
      );
    },

    async postJournalEntry(_: unknown, { id }: { id: string }, ctx: Ctx) {
      // El filtro va dentro del SQL: cero filas significa a la vez «no existe»
      // y «no es de tu entidad», y las dos salen por NotFoundError.
      await requireByIdInScope('journal_entries', id, alcanceDe(ctx), { columns: 'id' });
      return postJournalEntry(id, ctx.user.user_id);
    },

    async voidJournalEntry(_: unknown, { id, reason }: { id: string; reason: string }, ctx: Ctx) {
      await requireByIdInScope('journal_entries', id, alcanceDe(ctx), { columns: 'id' });
      return voidJournalEntry(id, ctx.user.user_id, reason);
    },

    async reverseJournalEntry(
      _: unknown,
      { id, reversalDate }: { id: string; reversalDate?: string | null },
      ctx: Ctx
    ) {
      await requireByIdInScope('journal_entries', id, alcanceDe(ctx), { columns: 'id' });
      // Las guardas —sólo asientos posteados, una sola reversión por asiento,
      // enlace y espejo en la misma transacción— viven en el servicio, que es
      // el que llama también POST /v1/journal-entries/:id/reverse. Reversar
      // CREA un asiento, y por eso el permiso es journal_entries:create.
      return reverseJournalEntry(id, ctx.user.user_id, {
        reversalDate: reversalDate ? new Date(reversalDate) : undefined,
      });
    },

    async createInvoice(_: unknown, { input }: { input: EntradaCrearFactura }, ctx: Ctx) {
      const entityId = entidadPedida(ctx, input.entityId);
      // Sólo `customerId` y `revenueAccountId`: `itemId` y `projectId` son
      // columnas UUID SIN `REFERENCES` en 002_ap_ar_schema.sql —y `projects` no
      // existe como tabla en ninguna migración—, así que acotarlas sería
      // inventar una restricción que el esquema no tiene.
      await exigirEnAlcance(ctx, entityId, [
        { tabla: 'customers', id: input.customerId },
        ...input.lines.map((l) => ({ tabla: 'accounts', id: l.revenueAccountId })),
      ]);
      // `lineNumber` llega en el esquema y NO se reenvía: `createInvoice`
      // numera los renglones por su posición, igual que cuando la llama REST.
      // Reenviarlo daría a entender que el cliente elige la numeración.
      return createInvoice({
        entity_id: entityId,
        customer_id: input.customerId,
        invoice_date: String(input.invoiceDate),
        due_date: String(input.dueDate),
        currency_code: input.currencyCode ?? null,
        terms: input.terms ?? null,
        memo: input.memo ?? null,
        po_number: input.poNumber ?? null,
        lines: input.lines.map((l) => ({
          item_id: l.itemId ?? null,
          description: l.description ?? null,
          quantity: l.quantity ?? null,
          unit_price: l.unitPrice,
          revenue_account_id: l.revenueAccountId,
          tax_code: l.taxCode ?? null,
          tax_rate: l.taxRate ?? null,
          project_id: l.projectId ?? null,
          cfdi_product_code: l.cfdiProductCode ?? null,
          cfdi_unit_code: l.cfdiUnitCode ?? null,
        })),
        created_by: ctx.user.user_id,
      });
    },

    async voidInvoice(_: unknown, { id }: { id: string }, ctx: Ctx) {
      const { tenantId, entityId } = inquilinoYEntidad(ctx);
      await requireByIdInScope('invoices', id, entityScope(tenantId, entityId), { columns: 'id' });

      // LA RAZÓN QUE ESTA PUERTA NO PUEDE RECIBIR.
      //
      // POST /v1/invoices/:id/void EXIGE `reason` y no es cosmética:
      // `voidInvoice` la persiste en la descripción de la reversión, en las
      // notas del asiento original y en la bitácora, así que es el único
      // relato de POR QUÉ se anuló un ingreso. El esquema declara
      // `voidInvoice(id: ID!): Invoice!` y no tiene dónde recibirla, de modo
      // que por aquí un ingreso se anula sin que quede escrito el motivo.
      //
      // No se inventa una razón de relleno —«anulada vía GraphQL» sería una
      // explicación falsa metida en el rastro de auditoría, que es peor que la
      // ausencia— y no se toca el esquema: añadirle un argumento obligatorio
      // es un cambio de contrato público. Queda dicho aquí y en los riesgos.
      //
      // `allowStamped` y `allowApplied` en true es lo que pasa la ruta, cuyo
      // contrato no ha cambiado nunca; se copia esa decisión, no se elige otra.
      const { invoice, attest } = await voidInvoice(id, ctx.user.user_id, {
        entityId,
        allowStamped: true,
        allowApplied: true,
      });
      if (attest) attestEntryAsync(tenantId, attest.entityId, attest.entryId);
      return invoice;
    },

    async recordInvoicePayment(
      _: unknown,
      args: {
        invoiceId: string;
        paymentDate: string;
        paymentAmount: string | number;
        paymentMethod: string;
      },
      ctx: Ctx
    ) {
      const { tenantId, entityId } = inquilinoYEntidad(ctx);
      const alcance = entityScope(tenantId, entityId);
      await requireByIdInScope('invoices', args.invoiceId, alcance, { columns: 'id' });

      const monto = String(args.paymentAmount);
      const resultado = await recordCustomerPayment(
        {
          entityId,
          paymentAmount: monto,
          paymentDate: String(args.paymentDate),
          paymentMethod: args.paymentMethod,
          referenceNumber: null,
          bankAccountId: null,
          // Un solo documento, con el importe entero aplicado a él: es lo que
          // arma POST /v1/invoices/:id/payments, y el esquema no declara ni
          // varias facturas ni remanente a cuenta.
          applications: [{ documentId: args.invoiceId, amountApplied: monto }],
        },
        ctx.user.user_id
      );
      if (resultado.attestation) {
        attestEntryAsync(tenantId, resultado.attestation.entityId, resultado.attestation.entryId);
      }

      // El esquema devuelve `Invoice!` donde la ruta devuelve el recibo del
      // cobro —número de pago, asiento generado, aplicaciones—. Se relee la
      // factura ACOTADA, que es la misma fila ya con el cobro aplicado; el
      // número de pago no cabe en `Invoice` y por esta puerta no sale.
      return requireByIdInScope<Invoice>('invoices', args.invoiceId, alcance);
    },

    async softClosePeriod(_: unknown, args: { periodId: string; entityId: string }, ctx: Ctx) {
      assertEntityAccess(ctx.user, args.entityId);
      return softClosePeriod(args.periodId, args.entityId, ctx.user.user_id);
    },

    async hardClosePeriod(_: unknown, args: { periodId: string; entityId: string }, ctx: Ctx) {
      assertEntityAccess(ctx.user, args.entityId);
      return hardClosePeriod(args.periodId, args.entityId, ctx.user.user_id);
    },
  }),

  // Field resolvers
  Account: {
    async parent(account: Account) {
      if (!account.parent_id) return null;
      const result = await query<Account>('SELECT * FROM accounts WHERE id = $1', [account.parent_id]);
      return result.rows[0] || null;
    },
    async children(account: Account) {
      const result = await query<Account>('SELECT * FROM accounts WHERE parent_id = $1 ORDER BY code', [account.id]);
      return result.rows;
    },
    level: (account: Account) => account.account_level,
    fullCode: (account: Account) => account.full_code,
    accountType: (account: Account) => account.account_type?.toUpperCase(),
    normalBalance: (account: Account) => account.normal_balance?.toUpperCase(),
    fsCategory: (account: Account) => account.fs_category?.toUpperCase(),
    isHeader: (account: Account) => account.is_header,
    allowManualEntries: (account: Account) => account.allow_manual_entries,
    currencyCode: (account: Account) => account.currency_code,
  },

  JournalEntry: {
    async lines(entry: JournalEntry) {
      const result = await query<JournalEntryLine>(
        'SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number',
        [entry.id]
      );
      return result.rows;
    },
    entryNumber: (e: JournalEntry) => e.entry_number,
    entryType: (e: JournalEntry) => e.entry_type?.toUpperCase(),
    entryDate: (e: JournalEntry) => e.entry_date,
    postedDate: (e: JournalEntry) => e.posted_date,
    totalDebits: (e: JournalEntry) => e.total_debits,
    totalCredits: (e: JournalEntry) => e.total_credits,
    isReversal: (e: JournalEntry) => e.is_reversal,
    sourceType: (e: JournalEntry) => e.source_type,
    sourceId: (e: JournalEntry) => e.source_id,
  },

  JournalEntryLine: {
    async account(line: JournalEntryLine) {
      const result = await query<Account>('SELECT * FROM accounts WHERE id = $1', [line.account_id]);
      return result.rows[0];
    },
    lineNumber: (l: JournalEntryLine) => l.line_number,
    debitAmount: (l: JournalEntryLine) => l.debit_amount,
    creditAmount: (l: JournalEntryLine) => l.credit_amount,
    currencyCode: (l: JournalEntryLine) => l.currency_code,
    foreignDebit: (l: JournalEntryLine) => l.foreign_debit,
    foreignCredit: (l: JournalEntryLine) => l.foreign_credit,
    exchangeRate: (l: JournalEntryLine) => l.exchange_rate,
    isReconciled: (l: JournalEntryLine) => l.is_reconciled,
  },

  Invoice: {
    async lines(invoice: Invoice) {
      const result = await query('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number', [invoice.id]);
      return result.rows;
    },
    async customer(invoice: Invoice) {
      const result = await query('SELECT * FROM customers WHERE id = $1', [invoice.customer_id]);
      return result.rows[0];
    },
    async payments(invoice: Invoice) {
      const result = await query(
        `SELECT cp.* FROM customer_payments cp
         JOIN payment_allocations pa ON pa.payment_id = cp.id
         WHERE pa.invoice_id = $1 ORDER BY cp.payment_date`,
        [invoice.id]
      );
      return result.rows;
    },
    async journalEntry(invoice: Invoice) {
      if (!invoice.journal_entry_id) return null;
      const result = await query('SELECT * FROM journal_entries WHERE id = $1', [invoice.journal_entry_id]);
      return result.rows[0] || null;
    },
    invoiceNumber: (i: Invoice) => i.invoice_number,
    totalAmount: (i: Invoice) => i.total_amount,
    taxAmount: (i: Invoice) => i.tax_amount,
    amountPaid: (i: Invoice) => i.amount_paid,
    amountDue: (i: Invoice) => i.amount_due,
    currencyCode: (i: Invoice) => i.currency_code,
    invoiceDate: (i: Invoice) => i.invoice_date,
    dueDate: (i: Invoice) => i.due_date,
    deliveryDate: (i: Invoice) => i.delivery_date,
    cfdiUuid: (i: Invoice) => i.cfdi_uuid,
    cfdiStatus: (i: Invoice) => i.cfdi_status?.toUpperCase(),
    cfdiXmlUrl: (i: Invoice) => i.cfdi_xml_url,
    poNumber: (i: Invoice) => i.po_number,
    sentAt: (i: Invoice) => i.sent_at,
    sentTo: (i: Invoice) => i.sent_to,
    pdfUrl: (i: Invoice) => i.pdf_url,
  },

  Bill: {
    async vendor(bill: Record<string, unknown>) {
      const result = await query('SELECT * FROM vendors WHERE id = $1', [bill.vendor_id as string]);
      return result.rows[0];
    },
    async lines(bill: Record<string, unknown>) {
      const result = await query('SELECT * FROM bill_lines WHERE bill_id = $1 ORDER BY line_number', [bill.id as string]);
      return result.rows;
    },
    billNumber: (b: Record<string, unknown>) => b.bill_number,
    totalAmount: (b: Record<string, unknown>) => b.total_amount,
    taxAmount: (b: Record<string, unknown>) => b.tax_amount,
    amountPaid: (b: Record<string, unknown>) => b.amount_paid,
    amountDue: (b: Record<string, unknown>) => b.amount_due,
    billDate: (b: Record<string, unknown>) => b.bill_date,
    dueDate: (b: Record<string, unknown>) => b.due_date,
  },

  Customer: {
    customerNumber: (c: Record<string, unknown>) => c.customer_number,
    companyName: (c: Record<string, unknown>) => c.company_name,
    firstName: (c: Record<string, unknown>) => c.first_name,
    lastName: (c: Record<string, unknown>) => c.last_name,
    taxId: (c: Record<string, unknown>) => c.tax_id,
    isActive: (c: Record<string, unknown>) => c.is_active,
    creditStatus: (c: Record<string, unknown>) => c.credit_status,
    async invoices(customer: Record<string, unknown>, args: { status?: string; limit?: number }) {
      let where = 'WHERE customer_id = $1';
      const params: unknown[] = [customer.id];
      if (args.status) { where += ' AND status = $2'; params.push(args.status.toLowerCase()); }
      const result = await query(
        `SELECT * FROM invoices ${where} ORDER BY invoice_date DESC LIMIT $${params.length + 1}`,
        [...params, args.limit || 20]
      );
      return result.rows;
    },
  },

  Vendor: {
    vendorNumber: (v: Record<string, unknown>) => v.vendor_number,
    companyName: (v: Record<string, unknown>) => v.company_name,
    taxId: (v: Record<string, unknown>) => v.tax_id,
    isActive: (v: Record<string, unknown>) => v.is_active,
    async bills(vendor: Record<string, unknown>, args: { status?: string; limit?: number }) {
      let where = 'WHERE vendor_id = $1';
      const params: unknown[] = [vendor.id];
      if (args.status) { where += ' AND status = $2'; params.push(args.status); }
      const result = await query(
        `SELECT * FROM bills ${where} ORDER BY bill_date DESC LIMIT $${params.length + 1}`,
        [...params, args.limit || 20]
      );
      return result.rows;
    },
  },

  CustomerPayment: {
    paymentNumber: (p: Record<string, unknown>) => p.payment_number,
    paymentAmount: (p: Record<string, unknown>) => p.payment_amount,
    paymentMethod: (p: Record<string, unknown>) => p.payment_method,
    paymentDate: (p: Record<string, unknown>) => p.payment_date,
  },

  FiscalPeriod: {
    periodNumber: (p: FiscalPeriod) => p.period_number,
    periodName: (p: FiscalPeriod) => p.period_name,
    startDate: (p: FiscalPeriod) => p.start_date,
    endDate: (p: FiscalPeriod) => p.end_date,
  },

  InvoiceLine: {
    lineNumber: (l: Record<string, unknown>) => l.line_number,
    unitPrice: (l: Record<string, unknown>) => l.unit_price,
    async revenueAccount(line: Record<string, unknown>) {
      const result = await query('SELECT * FROM accounts WHERE id = $1', [line.revenue_account_id as string]);
      return result.rows[0];
    },
    taxCode: (l: Record<string, unknown>) => l.tax_code,
    taxRate: (l: Record<string, unknown>) => l.tax_rate,
    taxAmount: (l: Record<string, unknown>) => l.tax_amount,
    lineAmount: (l: Record<string, unknown>) => l.line_amount,
    totalAmount: (l: Record<string, unknown>) => l.total_amount,
    cfdiProductCode: (l: Record<string, unknown>) => l.cfdi_product_code,
    cfdiUnitCode: (l: Record<string, unknown>) => l.cfdi_unit_code,
    itemId: (l: Record<string, unknown>) => l.item_id,
  },
});
