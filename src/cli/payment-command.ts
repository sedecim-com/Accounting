import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import { BillStatus } from '../types/index.js';
import { query } from '../database/connection.js';
import { NotFoundError } from '../utils/errors.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { attestEntryAsync } from '../services/accounting/posting.js';
import { resolveBill } from '../services/ap/bill-service.js';
import {
  recordVendorPayment,
  applyVendorPayment,
  type EntradaPago,
  type ResultadoPago,
  type ResultadoAplicacionProveedor,
} from '../services/payments/payment-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  withContext,
  requireExplicitEntity,
  blockedByState,
  abortedByUser,
  usageError,
  exitCodeFor,
  dateOnly,
} from './kernel/index.js';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';

// ============================================================
// mnemosine payment
//
// El dinero que sale (`payment`, a proveedores), sobre
// services/payments/payment-service.ts — el mismo camino que toma la API.
// El que entra vive en receipt-command.ts (F03): el cobro dejó de ser una
// sola hoja y se llevó su familia entera.
//
// POR QUÉ EXISTEN. Registrar el cobro o el pago no es papeleo: es el acto que
// RECONOCE EL IVA de un CFDI a crédito. Bajo PPD el IVA acreditable espera en
// la 1135 hasta que se paga, y el trasladado espera en la 2125 hasta que se
// cobra. Hasta ahora esas dos funciones sólo se invocaban desde dos rutas
// REST, así que quien operaba por terminal —que es la tesis del producto—
// dejaba ambos impuestos aparcados para siempre.
//
// LOS NOMBRES SALEN DEL CATÁLOGO, no de la comodidad: `payment create` y
// `receipt record` son las filas que docs/cli-command-catalog.md ya tenía
// reservadas, y sus verbos están en la lista cerrada del núcleo. Se evitó a
// propósito llamarlo `pay` o `collect`: mnemosine no paga ni cobra nada —no
// tiene conexión con ningún banco—, registra que alguien lo hizo. El endpoint
// que decía programar pagos se retiró justamente por prometer un acto que no
// ejecutaba.
// ============================================================

export interface PaymentCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Costura de prueba para la confirmación. */
  confirm?: (question: string) => Promise<boolean>;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  json?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

interface MontoOpts extends CommonOpts {
  amount: string;
  date?: string;
  method: string;
  bank?: string;
  reference?: string;
  memo?: string;
  discount?: string;
}

interface AplicarOpts extends CommonOpts {
  bill?: string[];
  amount?: string[];
  discount?: string[];
  mode?: string;
  shortPayReason?: string;
  idempotencyKey?: string;
}

/** `--bill A --amount 100 --bill B --amount 50` se lee por posición. */
const acumular = (valor: string, previo: string[] = []): string[] => [...previo, valor];

/** Un gasto se paga cuando su pasivo ya está en el mayor. */
const PAGABLES = ['approved', 'posted', 'partially_paid'] as const;

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// Los dos folios de esta familia NO son el mismo: un gasto es BILL-AAAA-NNNNN
// y un pago a proveedor es VPMT-AAAA-NNNNN (`PMT-` es el cobro del cliente,
// otra familia). Confundirlos es el error que más cuesta aquí, así que cada
// ejemplo escribe el suyo entero.
//
// `--bill` y `--amount` de `payment apply` se leen POR POSICIÓN: el primer
// --amount es del primer --bill. Prosa en inglés (idioma del nodo), datos
// mexicanos.
// ============================================================
const EJEMPLOS = {
  create: `
Examples:
  # Record a transfer that already left the bank, against one approved bill.
  mnemosine payment create BILL-2026-00007 --amount 16820.00 --date 2026-07-31 --method spei
  # Pay early and take the discount the terms allow: 820.00 of liability that no cash extinguishes.
  mnemosine payment create BILL-2026-00007 --amount 16000.00 --discount 820.00 --memo "Pronto pago 2/10 Net 30"
  # See the effect on the bill and on the ledger, writing nothing.
  mnemosine payment create BILL-2026-00007 --amount 16820.00 --dry-run
`,
  apply: `
Examples:
  # Split one transfer across two open bills. --bill and --amount pair up IN ORDER.
  mnemosine payment apply VPMT-2026-00019 --bill BILL-2026-00007 --amount 12000.00 --bill BILL-2026-00011 --amount 8500.00
  # Apply less than the balance and leave the bill open for the rest.
  mnemosine payment apply VPMT-2026-00019 --bill BILL-2026-00007 --amount 9000.00 --mode partial
  # Close a bill short: what is unpaid stops being owed, so it needs a written reason.
  mnemosine payment apply VPMT-2026-00019 --bill BILL-2026-00007 --amount 15900.00 --mode residual --short-pay-reason "Nota de credito que el proveedor nunca emitio"
`,
} as const;

export function registerPaymentCommands(program: Command, deps: PaymentCommandDeps): void {
  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const writeEntityOf = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
  };

  const confirmOrAbort = async (opts: CommonOpts, question: string): Promise<void> => {
    if (opts.yes) return;
    if (deps.confirm) {
      if (await deps.confirm(question)) return;
      throw abortedByUser();
    }
    if (!process.stdin.isTTY) {
      throw abortedByUser(
        `${question} — there is no terminal to ask on. Re-run with --yes once you are sure, ` +
          'or with --dry-run to see the effect first.'
      );
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const veredicto = await confirmarConReintento(
        (p) => rl.question(p).catch(() => null),
        `${question} [y/N] `
      );
      if (veredicto.si) return;
      throw abortedByUser(
        veredicto.incomprendida !== undefined
          ? `Aborted — ${noEntendi(veredicto.incomprendida)}.`
          : undefined
      );
    } finally {
      rl.close();
    }
  };

  const montoFlags = (cmd: Command): Command =>
    cmd
      .requiredOption('--amount <amount>', 'amount, in the document currency')
      .option('--date <date>', 'value date (YYYY-MM-DD); defaults to today')
      .option('--method <method>', 'cash, check, ach, wire, spei, credit_card or other', 'spei')
      .option('--bank <account>', "bank account id; without it the entity's `banco` role is used")
      .option('--json', 'JSON output');

  // ============================================================
  // payment · lo que sale
  // ============================================================
  const payment = program
    .command('payment')
    .alias('pago')
    .description('Vendor payments: record cash that already left the bank and settle the bill it pays');

  const create = payment
    .command('create')
    .alias('crear')
    .argument('<bill>', 'bill number, vendor invoice number or id')
    .description('Record a payment made against a bill and recognize the IVA it was holding');
  montoFlags(create)
    .option('--discount <amount>', 'early-payment discount taken')
    .option('--memo <text>', 'note stored with the payment');
  withContext(create);
  // Mueve saldo y postea al mayor: el núcleo añade --dry-run, --yes e
  // --idempotency-key, y se niega a que la IA lo invoque.
  declareRisk(create, {
    risk: 'irreversible',
    agent: false,
    writes: 'vendor_payments, payment_applications, bills.amount_due, journal_entries',
  });
  create.addHelpText('after', EJEMPLOS.create);
  create.action((ref: string, opts: MontoOpts) =>
    run(async () => {
      const ctx = await writeEntityOf(opts);
      const target = await resolveBill(ctx.entityId, ref);

      if (!PAGABLES.includes(target.status as (typeof PAGABLES)[number])) {
        throw blockedByState(
          `Bill ${target.bill_number} is "${target.status}". ` +
            (target.status === BillStatus.PAID
              ? 'It is already settled.'
              : target.status === BillStatus.DRAFT || target.status === BillStatus.PENDING_APPROVAL
                ? 'Approve it first: the liability has to be in the ledger before it can be paid.'
                : `Only ${PAGABLES.join(', ')} bills can be paid.`)
        );
      }

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const entrada: EntradaPago = {
        entityId: ctx.entityId,
        paymentAmount: opts.amount,
        paymentDate: opts.date ?? hoy(),
        paymentMethod: opts.method,
        bankAccountId: opts.bank ?? null,
        memo: opts.memo ?? null,
        applications: [
          { documentId: target.id, amountApplied: opts.amount, discountAmount: opts.discount },
        ],
      };

      await ejecutar({
        opts, deps, entrada, reviewer: reviewer.userId, ctx,
        registrar: recordVendorPayment,
        etiqueta: target.bill_number,
        moneda: target.currency_code,
        pregunta: (d) =>
          `Record ${opts.amount} ${target.currency_code} paid on ${target.bill_number} ` +
          `(${d.saldoAnterior} → ${d.saldoNuevo}) in ${ctx.entityName}? This posts to the ledger.`,
        confirmOrAbort,
      });
    })
  );

  // ---- payment apply ------------------------------------------------
  //
  // La fila que faltaba, y por qué faltaba. Hasta hoy el único instante en que
  // un pago podía tocar un gasto era el de registrarlo: `payment create` nace
  // ya apuntando a una factura. Pero una tesorería real transfiere PRIMERO
  // —un importe global al proveedor, cerrando la semana— y decide DESPUÉS
  // contra cuáles de sus seis facturas abiertas iba. Ese dinero quedaba como
  // anticipo a proveedores (1150) sin forma de repartirlo nunca.
  //
  // Los tres repartos que el catálogo promete:
  //   · PARCIAL     — se aplica de menos y el gasto sigue abierto por el resto.
  //   · DESCUENTO   — el pronto pago extingue más pasivo que el efectivo.
  //   · PAGO CORTO  — `--mode residual`: el gasto se CIERRA pagando de menos y
  //                   lo que falta deja de deberse. Exige motivo escrito, y la
  //                   cuenta a la que va ese saldo la decide el panel
  //                   (`pago_corto_residual`), no este comando.
  const apply = payment
    .command('apply')
    .alias('aplicar')
    .argument('<payment>', 'payment number or id whose on-account balance is to be applied')
    .description('Apply an existing payment to specific bills: partial, with discount, or short-paid');
  apply
    .option('--bill <ref...>', 'bill to apply to; repeat it, paired in order with --amount', acumular)
    .option('--amount <amount...>', 'amount applied to the bill in the same position', acumular)
    .option('--discount <amount...>', 'early-payment discount for the bill in the same position', acumular)
    .option('--mode <mode>', 'partial (leave the rest open) or residual (close it short)', 'partial')
    .option('--short-pay-reason <text>', 'why the unpaid balance is being written off; required by --mode residual')
    .option('--json', 'JSON output');
  withContext(apply);
  declareRisk(apply, {
    risk: 'irreversible',
    agent: false,
    writes: 'payment_applications, bills.amount_due, journal_entries',
  });
  apply.addHelpText('after', EJEMPLOS.apply);
  apply.action((ref: string, opts: AplicarOpts) =>
    run(async () => {
      const { dryRun } = gateMutation(apply, opts as unknown as Record<string, unknown>);
      const p = deps.palette;
      const bills = opts.bill ?? [];
      const amounts = opts.amount ?? [];
      if (bills.length === 0) {
        throw usageError(
          'Indica a qué gasto se aplica: --bill <ref> --amount <importe>. Repítelos para repartir entre varios.'
        );
      }
      // El emparejamiento es POSICIONAL, así que un descuadre de longitudes no
      // se puede adivinar: aplicar 100 al gasto equivocado es peor que fallar.
      if (bills.length !== amounts.length) {
        throw usageError(
          `Hay ${bills.length} --bill y ${amounts.length} --amount: van emparejados por posición, ` +
            'así que tienen que ser tantos como aquéllos.'
        );
      }
      if (opts.discount && opts.discount.length > bills.length) {
        throw usageError(
          `Hay ${opts.discount.length} --discount para ${bills.length} --bill: sobra alguno.`
        );
      }
      if (opts.mode !== 'partial' && opts.mode !== 'residual') {
        throw usageError(`--mode admite "partial" o "residual"; llegó "${opts.mode}".`);
      }
      // Se traduce a la unión en vez de afirmarla con `as`.
      //
      // Commander entrega `string`, y descartar dos literales de `string`
      // sigue dejando `string`: el rechazo de arriba no estrecha nada que el
      // compilador pueda usar. Un `as 'partial' | 'residual'` habría callado
      // al compilador tapando justo eso — el día que alguien borrara el
      // guardia, la aserción seguiría compilando y el modo inválido llegaría
      // vivo al servicio. Esta línea no puede producir un valor que la unión
      // no admita, con guardia o sin él.
      const modo: 'partial' | 'residual' = opts.mode === 'residual' ? 'residual' : 'partial';

      const ctx = await writeEntityOf(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const pago = await resolveVendorPayment(ctx.entityId, ref);

      const aplicaciones = [];
      for (let i = 0; i < bills.length; i++) {
        const target = await resolveBill(ctx.entityId, bills[i]);
        if (!PAGABLES.includes(target.status as (typeof PAGABLES)[number])) {
          throw blockedByState(
            `Bill ${target.bill_number} is "${target.status}"; only ${PAGABLES.join(', ')} bills can be applied to.`
          );
        }
        aplicaciones.push({
          documentId: target.id,
          amountApplied: amounts[i],
          discountAmount: opts.discount?.[i],
        });
      }

      // Sin aserción de tipo: el rechazo de arriba ya estrechó `opts.mode` a
      // las dos grafías válidas, y el linter lo demuestra marcando el `as`
      // como innecesario. Un `as` aquí habría escondido el día en que alguien
      // borrara ese guardia.
      const opciones = { modo, shortPayReason: opts.shortPayReason };

      // La vista previa recorre EL MISMO código y revierte: lo que el motor
      // rechazaría se rechaza antes de preguntar nada.
      const previo = await applyVendorPayment(ctx.entityId, pago.id, aplicaciones, reviewer.userId, {
        ...opciones,
        dryRun: true,
      });
      if (dryRun) {
        imprimirAplicacion(previo, p, true, opts.json === true);
        process.stderr.write(p.dim('Dry run: nothing was written.\n'));
        return;
      }

      await confirmOrAbort(
        opts,
        `Apply ${previo.documentos.length} document(s) of ${pago.payment_number} in ${ctx.entityName}` +
          (previo.condonado !== '0.00'
            ? `, WRITING OFF ${previo.condonado} that will stop being owed`
            : '') +
          '? This posts to the ledger.'
      );

      const result = await applyVendorPayment(
        ctx.entityId, pago.id, aplicaciones, reviewer.userId, opciones
      );
      if (result.attestation) {
        attestEntryAsync(ctx.tenantId, result.attestation.entityId, result.attestation.entryId);
      }
      imprimirAplicacion(result, p, false, opts.json === true);
    })
  );

}

// El dia LOCAL del despacho, no el de Greenwich: de noche ya era "manana" en UTC.
const hoy = (): string => dateOnly(new Date());

/**
 * El camino común de los dos comandos: ensayo, confirmación, escritura.
 *
 * La vista previa recorre EL MISMO código y revierte, así que lo que el motor
 * rechazaría —un periodo cerrado, un rol sin cuenta, un importe mayor al
 * saldo— se rechaza antes de preguntarle nada a nadie.
 */
async function ejecutar(a: {
  opts: MontoOpts;
  deps: PaymentCommandDeps;
  entrada: EntradaPago;
  reviewer: string;
  ctx: { tenantId: string; entityName: string };
  registrar: (e: EntradaPago, u: string, o?: { dryRun?: boolean }) => Promise<ResultadoPago>;
  etiqueta: string;
  moneda: string;
  pregunta: (d: ResultadoPago['documentos'][number]) => string;
  confirmOrAbort: (opts: CommonOpts, question: string) => Promise<void>;
}): Promise<void> {
  const p = a.deps.palette;
  const previo = await a.registrar(a.entrada, a.reviewer, { dryRun: true });
  const doc = previo.documentos[0];

  if (a.opts.dryRun) {
    imprimir(previo, p, a.etiqueta, true, a.opts.json === true);
    process.stderr.write(p.dim('Dry run: nothing was written.\n'));
    return;
  }

  await a.confirmOrAbort(a.opts, a.pregunta(doc));

  const result = await a.registrar(a.entrada, a.reviewer);
  if (result.attestation) {
    attestEntryAsync(a.ctx.tenantId, result.attestation.entityId, result.attestation.entryId);
  }
  imprimir(result, p, a.etiqueta, false, a.opts.json === true);
}

function imprimir(
  result: ResultadoPago,
  p: Palette,
  etiqueta: string,
  ensayo: boolean,
  json: boolean
): void {
  const doc = result.documentos[0];
  if (json) {
    render(
      [
        {
          payment_number: result.paymentNumber,
          document: doc.numero,
          amount_due_before: doc.saldoAnterior,
          amount_due_after: doc.saldoNuevo,
          document_status: doc.estado,
          journal_entry: result.journalEntry?.entry_number ?? null,
          dry_run: ensayo,
        },
      ],
      { json: true }
    );
    return;
  }
  process.stdout.write(
    (ensayo
      ? `${p.bold(`Would record ${doc.saldoAnterior} → ${doc.saldoNuevo} on ${etiqueta}`)}`
      : `${p.green('✔')} ${p.bold(result.paymentNumber)} · ${p.bold(etiqueta)}` +
        p.dim(` ${doc.saldoAnterior} → ${doc.saldoNuevo} (${doc.estado})`)) +
      (result.journalEntry ? p.dim(` · entry ${result.journalEntry.entry_number}`) : '') +
      '\n'
  );
  // La descripción del asiento nombra los documentos cuyo IVA se liberó: es
  // la señal de que el reconocimiento ocurrió, no sólo el movimiento de caja.
  if (result.journalEntry?.description?.includes('IVA')) {
    process.stderr.write(p.dim(`${result.journalEntry.description}\n`));
  }
}

/**
 * El pago por número o por id, ACOTADO POR ENTIDAD.
 *
 * `resolveBill` hace lo propio para los gastos y vive en su servicio; aquí no
 * hay un `resolveVendorPayment` equivalente porque hasta F04 nadie necesitaba
 * referirse a un pago YA HECHO: `payment create` lo crea y lo aplica en el
 * mismo acto. La búsqueda por número va primero porque es lo que el operador
 * tiene a mano —lo imprimió `payment create`—, y el id sólo se intenta cuando
 * la cadena de verdad puede ser un UUID.
 */
async function resolveVendorPayment(
  entityId: string,
  ref: string
): Promise<{ id: string; payment_number: string; payment_amount: string; currency_code: string }> {
  type Fila = { id: string; payment_number: string; payment_amount: string; currency_code: string };
  const porNumero = await query<Fila>(
    `SELECT id, payment_number, payment_amount, currency_code
       FROM vendor_payments WHERE entity_id = $1 AND payment_number = $2`,
    [entityId, ref]
  );
  if (porNumero.rows.length > 0) return porNumero.rows[0];

  if (UUID_RE.test(ref)) {
    const porId = await query<Fila>(
      `SELECT id, payment_number, payment_amount, currency_code
         FROM vendor_payments WHERE entity_id = $1 AND id = $2`,
      [entityId, ref]
    );
    if (porId.rows.length > 0) return porId.rows[0];
  }
  throw new NotFoundError('Vendor payment', ref);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function imprimirAplicacion(
  result: ResultadoAplicacionProveedor,
  p: Palette,
  ensayo: boolean,
  json: boolean
): void {
  if (json) {
    render(
      [
        {
          payment_number: result.paymentNumber,
          documents: result.documentos.map((d) => ({
            document: d.numero,
            amount_due_before: d.saldoAnterior,
            amount_due_after: d.saldoNuevo,
            document_status: d.estado,
          })),
          on_account_before: result.remanenteAnterior,
          on_account_after: result.remanenteNuevo,
          written_off: result.condonado,
          discounts_outside_terms: result.descuentosFueraDeTerminos,
          write_off_account: result.cuentaCondonacion,
          non_creditable_iva: result.ivaNoAcreditable,
          journal_entry: result.journalEntry?.entry_number ?? null,
          dry_run: ensayo,
        },
      ],
      { json: true }
    );
    return;
  }

  process.stdout.write(
    (ensayo
      ? p.bold(`Would apply ${result.paymentNumber}`)
      : `${p.green('✔')} ${p.bold(result.paymentNumber)}`) +
      p.dim(
        ` · on account ${result.remanenteAnterior} → ${result.remanenteNuevo}` +
          (result.journalEntry ? ` · entry ${result.journalEntry.entry_number}` : '')
      ) +
      '\n'
  );
  for (const d of result.documentos) {
    process.stdout.write(
      `  ${d.numero} ${p.dim(`${d.saldoAnterior} → ${d.saldoNuevo} (${d.estado})`)}\n`
    );
  }

  // Un descuento que las condiciones no otorgaban es admisible, pero es OTRA
  // COSA que un 2/10 ejercido en plazo. Se nombra.
  if (result.descuentosFueraDeTerminos.length > 0) {
    process.stderr.write(
      p.yellow(
        `  Descuento tomado fuera de las condiciones en ` +
          `${result.descuentosFueraDeTerminos.join(', ')}`
      ) + p.dim(': es una deducción negociada, no un pronto pago pactado.\n')
    );
  }

  // EL PAGO CORTO SE DICE EN VOZ ALTA. Un pasivo que desaparece sin pagarse es
  // lo que un auditor persigue; enterrarlo en el JSON sería esconderlo.
  if (result.condonado !== '0.00') {
    process.stderr.write(
      p.yellow(`  ${result.condonado} dejó de deberse (pago corto)`) +
        p.dim(` → ${result.cuentaCondonacion}\n`) +
        (result.politicaDefinida
          ? ''
          : p.dim(
              '  Esa cuenta es el DEFECTO declarado, nadie la ha decidido todavía:\n' +
                '  `mnemosine pending show pago_corto_residual` para verla y resolverla.\n'
            ))
    );
    if (result.ivaNoAcreditable !== '0.00') {
      process.stderr.write(
        p.dim(
          `  ${result.ivaNoAcreditable} de IVA salió de 1135 SIN acreditarse: era el impuesto\n` +
            '  de la parte que no se pagó, y bajo flujo de efectivo no se acredita lo no pagado.\n'
        )
      );
    }
  }
}
