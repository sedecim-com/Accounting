import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import Decimal from 'decimal.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { attestEntryAsync } from '../services/accounting/posting.js';
import { resolveInvoice } from '../services/ar/invoice-service.js';
import { resolveCustomer } from '../services/ar/customer-service.js';
import { resolverCuentaBancaria } from '../services/banking/bank-statement-service.js';
import {
  recordCustomerPayment,
  applyCustomerPayment,
  unapplyCustomerPayment,
  reverseCustomerPayment,
  stateReversalCause,
  closeOrphanAllocation,
  transferCustomerCredit,
  type CustomerCreditTransfer,
  getCustomerPayment,
  REVERSAL_CAUSES,
  type ResultadoReversa,
  listCustomerPayments,
  type EntradaPago,
  type ResultadoPago,
} from '../services/payments/payment-service.js';
import { InvoiceStatus } from '../types/index.js';
import { t } from '../i18n/index.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  withContext,
  withOutput,
  withSelection,
  withTime,
  resolveActiveEntity,
  requireExplicitEntity,
  usageError,
  blockedByState,
  abortedByUser,
  exitCodeFor,
  dateOnly,
  optionByKey,
  argumentByKey,
  describeCommand,
} from './kernel/index.js';
import { confirmarConReintento, yesNoPrompt } from './kernel/confirmacion.js';
import { conLlave, mirarLlave, hashDeCarga, cargaDelOperador } from '../services/idempotency/idempotency-store.js';
import { todayFor } from '../services/policy/today.js';
import { ADVANCE_TREATMENTS_AS_TYPED, readAdvanceTreatment, type AdvanceSplit } from '../services/payments/customer-advance.js';
import { keepsMexicanBooks } from '../services/jurisdiction/jurisdiction.js';
import { completePaymentTrace } from '../services/payments/payment-trace-service.js';
import { listedTraceFields, warnUntracedPayment, writeTraceCompletion } from './trace-completion-output.js';

// ============================================================
// mnemosine receipt · cobro
//
// El dinero que entra, como HISTORIA y no como instantánea: registrar
// (con o sin remanente a cuenta), ver, listar, aplicar el saldo a cuenta,
// desaplicar (evento nuevo, jamás un DELETE) y reversar diciendo la causa.
// Sobre services/payments/payment-service.ts — el mismo camino que el REST
// y la ligadura del REP.
//
// POR QUÉ IMPORTA: el cobro es lo que CAUSA el IVA de un CFDI PPD (la 2125
// se vacía al cobrar), así que aplicar, desaplicar y reversar mueven
// impuestos, no solo saldos. Cada evento postea su propio asiento y las
// reversas son espejos NIF B-1 — nada se edita en sitio.
//
// Todos los que tocan el mayor son irreversibles para el núcleo: dry-run
// de camino real, confirmación con los saldos enfrente, y jamás el agente.
// ============================================================

export interface ReceiptCommandDeps {
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
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
  status?: string[];
  since?: string;
  until?: string;
  yes?: boolean;
  dryRun?: boolean;
  reason?: string;
  idempotencyKey?: string;
}

/** Una factura se cobra cuando ya salió al cliente y su ingreso está contabilizado. */
/**
 * El ámbito bajo el que `receipt record` consuma la llave: su identidad en
 * `idempotency_keys`. En UN solo sitio a propósito — lo usan la consulta
 * temprana y el consumo, y dos literales que puedan divergir son dos
 * deduplicaciones distintas con el mismo nombre.
 */
const AMBITO_DE_COBRO = 'receipt record';
/** MNE-001-498 · the scope under which `receipt transfer record` spends its key. */
const TRANSFER_KEY_SCOPE = 'receipt transfer record';

const COBRABLES = ['sent', 'viewed', 'partially_paid', 'overdue'] as const;

const MONEY = ['payment_amount', 'applied_amount', 'unapplied_amount', 'amount_applied'];

// Today in the entity's zona_horaria, never the process clock (a UTC server reads tomorrow at night).
const hoy = (ctx: { tenantId: string; entityId: string }): Promise<string> =>
  todayFor({ tenantId: ctx.tenantId, entityId: ctx.entityId });

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// El folio del cobro es PMT-AAAA-NNNNN (el pago a proveedor es VPMT-, otra
// familia) y el de la factura INV-AAAA-NNNNN. Registrar el cobro no es
// papeleo: es el acto que libera el IVA trasladado que un CFDI PPD dejó
// aparcado, así que cada ejemplo dice qué mueve.
//
// En `--invoice` el importe puede ir pegado tras dos puntos
// ("INV-2026-00042:2500.00") o suelto en `--amount` cuando es una sola.
// Prosa en inglés (idioma del nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = {
  record: `
Examples:
  # Cash received against one invoice; this releases the PPD IVA it was holding.
  mnemosine receipt record INV-2026-00042 --amount 98600.00 --date 2026-07-31 --method spei --reference "SPEI 0123456789"
  # Take more than the invoice owes; the excess stays on account as an advance and causes its IVA today, at the invoice's rate.
  mnemosine receipt record INV-2026-00042 --amount 120000.00 --on-account
  # See the entry it would post, writing nothing.
  mnemosine receipt record INV-2026-00042 --amount 98600.00 --dry-run
  # An advance with no invoice yet: 1,000.00 stays in customer advances and its 160.00 of IVA is caused today.
  mnemosine receipt record --customer "Grupo Alameda" --amount 1160.00 --tax-rate 16
`,
  show: `
Examples:
  # One collection: its applications, live and historic, its REP and its entry.
  mnemosine receipt show PMT-2026-00042
  # As JSON, for a script that reads the unapplied remainder.
  mnemosine receipt show PMT-2026-00042 --json
`,
  list: `
Examples:
  # Collections from one customer during July 2026.
  mnemosine receipt list --customer "Grupo Alameda" --since 2026-07-01 --until 2026-07-31
  # Cash still sitting on account, and completed collections with no REP linked.
  mnemosine receipt list --unapplied --needs-rep
`,
  apply: `
Examples:
  # Apply an on-account balance to two invoices, each amount after the colon.
  mnemosine receipt apply PMT-2026-00042 --invoice "INV-2026-00042:2500.00" --invoice "INV-2026-00051:1800.00"
  # A single invoice, with the amount as its own flag.
  mnemosine receipt apply PMT-2026-00042 --invoice INV-2026-00042 --amount 2500.00
  # The customer paid 9533.33 on fees of 10000 + VAT: it withheld 10 % ISR and 2/3 of the VAT.
  mnemosine receipt apply PMT-2026-00042 --invoice INV-2026-00042:9533.33 --withholding isr:1000 --withholding iva:1066.67
  # Dated: the entry, the allocation and the invoice's last payment carry May 20, and so does the IVA it causes.
  mnemosine receipt apply PMT-2026-00042 --invoice INV-2026-00042:2500.00 --date 2026-05-20
`,
  unapply: `
Examples:
  # A NEW event, not an erasure: it reopens the invoice, and the cash goes back on account with the PPD IVA it caused.
  mnemosine receipt unapply PMT-2026-00042 --invoice INV-2026-00042 --reason "Aplicada a la factura equivocada"
  # See what would be reopened before doing it.
  mnemosine receipt unapply PMT-2026-00042 --invoice INV-2026-00042 --reason "Revision del cobro de julio" --dry-run
  # Dated: the mirror and the closed allocation carry May 25.
  mnemosine receipt unapply PMT-2026-00042 --invoice INV-2026-00042 --reason "Aplicada a la factura equivocada" --date 2026-05-25
`,
  reverse: `
Examples:
  # A chargeback: the money arrived and the bank took it back.
  mnemosine receipt reverse PMT-2026-00042 --cause taken_back --reason "Contracargo 4853"
  # A cheque returned unpaid: with no --cause a cheque takes not_collected.
  mnemosine receipt reverse PMT-2026-00042 --reason "Devuelto por fondos insuficientes"
  # See the mirror it would post, writing nothing.
  mnemosine receipt reverse PMT-2026-00042 --dry-run
`,
  causeRecord: `
Examples:
  # A direct debit reversed with no cause turned out to be a dispute after it was paid.
  mnemosine receipt cause record PMT-2026-00042 --cause taken_back --reason "Disputed by the payer on June 9"
  # See what would be written, writing nothing.
  mnemosine receipt cause record PMT-2026-00042 --cause not_collected --dry-run
`,
  traceRecord: `
Examples:
  # A SPEI recorded without --bank or the customer's bank: complete it from the CEP.
  mnemosine receipt trace record PMT-2026-00001 --bank "Operativa BBVA" --payer-bank 002 --payer-account 002180009876543210 --reason "CEP of the transfer"
  # A customer cheque recorded without its number: look first, then complete it from the deposit slip.
  mnemosine receipt trace record PMT-2026-00002 --check-number 4501 --payer-bank 072 --payer-account 1234567890 --dry-run
`,
  transferRecord: `
Examples:
  # The two customers and the entity agreed that PMT-2026-00042's cash on account is now Grupo Alameda's: look first.
  mnemosine receipt transfer record PMT-2026-00042 --customer "Grupo Alameda" --amount 1160.00 --date 2026-06-15 --reason "Convenio del 15 de junio" --dry-run
  # Then record it: DR/CR customer advances on June 15, no bank, revenue or IVA.
  mnemosine receipt transfer record PMT-2026-00042 --customer "Grupo Alameda" --amount 1160.00 --date 2026-06-15 --reason "Convenio del 15 de junio" --yes
`,
} as const;

/**
 * The three figures of an advance (MNE-001-421), as the dry run, the
 * confirmation and `receipt show` print them. The rate is the treatment
 * the accountant stated: a percent, or `exempt` / `not-subject`.
 */
function advanceFigures(a: { base: string; treatment: string; iva: string }): string {
  const rate = /^\d/.test(a.treatment) ? `${a.treatment} %` : a.treatment;
  return t('receipt.advance.figures', { base: a.base, iva: a.iva, rate });
}

/**
 * MNE-001-462 · The figures of the excess a collection leaves on account,
 * and where its rate came from when nobody stated it: the invoice's, or the
 * one assumed among several.
 */
function excessFigures(a: AdvanceSplit): string {
  if (!a.from) return advanceFigures(a);
  const key = a.from.assumed === 'highest'
    ? 'receipt.excess.from_highest'
    : a.from.assumed === 'exempt' ? 'receipt.excess.from_exempt' : 'receipt.excess.from';
  return `${advanceFigures(a)}; ${t(key, { invoices: a.from.invoices })}`;
}

/**
 * `--withholding isr:1000` for the only invoice, or `INV-2026-00042:iva:1066.67`
 * to name one of several (MNE-001-113). Repeated specs for the same invoice
 * and tax add up.
 */
export function parseWithholding(
  specs: string[] | undefined,
  refs: string[]
): Map<string, { isr: Decimal; iva: Decimal }> {
  const out = new Map<string, { isr: Decimal; iva: Decimal }>();
  for (const spec of specs ?? []) {
    const m = /^(?:(.+):)?(isr|iva):(\d+(?:\.\d+)?)$/i.exec(spec.trim());
    if (!m) throw usageError(t('receipt.withholding.unreadable', { spec }));
    const invoiceRef = m[1] ?? (refs.length === 1 ? refs[0] : undefined);
    if (invoiceRef === undefined || !refs.includes(invoiceRef)) {
      throw usageError(
        m[1] === undefined
          ? t('receipt.withholding.which_invoice', { spec })
          : t('receipt.withholding.not_applied', { spec, invoice: m[1] })
      );
    }
    const tax = m[2].toLowerCase() as 'isr' | 'iva';
    const current = out.get(invoiceRef) ?? { isr: new Decimal(0), iva: new Decimal(0) };
    current[tax] = current[tax].plus(m[3]);
    out.set(invoiceRef, current);
  }
  return out;
}

/**
 * The note `receipt record` writes when its idempotency key was already spent
 * (MNE-001-220): the result shown is the recorded one. In the user language.
 */
export function idempotencyHitNote(key: string, paymentNumber: string): string {
  return t('ar.receipt.idempotency_hit', { key, number: paymentNumber });
}

export function registerReceiptCommand(program: Command, deps: ReceiptCommandDeps): void {
  const receipt = describeCommand(program.command('receipt').alias('cobro'), 'help.receipt.description');

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const entityOf = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
    return ctx;
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
      throw abortedByUser({ key: 'ap.payment.confirm.no_terminal', params: { question } });
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const veredicto = await confirmarConReintento(
        (p) => rl.question(p).catch(() => null),
        yesNoPrompt(question)
      );
      if (veredicto.si) return;
      throw abortedByUser(
        veredicto.incomprendida !== undefined
          ? { key: 'ar.confirm.aborted', params: { reason: { key: 'confirm_answer_not_understood', params: { answer: veredicto.incomprendida } } } }
          : undefined
      );
    } finally {
      rl.close();
    }
  };

  /** `--invoice INV-2026-00042:2500` (repetible) o `--invoice <ref>` + --amount. */
  const parseAplicaciones = (
    invoiceSpecs: string[] | undefined,
    amount: string | undefined
  ): { ref: string; amount: string | null }[] => {
    const specs = invoiceSpecs ?? [];
    if (specs.length === 0) {
      throw usageError({ key: 'ar.receipt.invoice_missing' });
    }
    return specs.map((spec) => {
      const i = spec.lastIndexOf(':');
      if (i > 0 && /^[\d.]+$/.test(spec.slice(i + 1))) {
        return { ref: spec.slice(0, i), amount: spec.slice(i + 1) };
      }
      if (specs.length > 1 || !amount) {
        throw usageError({ key: 'ar.receipt.invoice_without_amount', params: { spec } });
      }
      return { ref: spec, amount };
    });
  };

  // ---- receipt record ----------------------------------------------
  const record = receipt
    .command('record')
    .alias('registrar');
  argumentByKey(record, '[invoice]', 'help.receipt.record.argument.invoice');
  describeCommand(record, 'help.receipt.record.description');
  optionByKey(record, '--customer <ref>', 'help.receipt.record.option.customer');
  optionByKey(record, '--tax-rate <rate>', 'help.receipt.record.option.tax_rate');
  optionByKey(record, '--on-account', 'help.receipt.record.option.on_account');
  // #611 · the payer's side of the Anexo 24 payment node, captured with the receipt.
  optionByKey(record, '--check-number <number>', 'help.receipt.record.option.check_number');
  optionByKey(record, '--payer-bank <code>', 'help.receipt.record.option.payer_bank');
  optionByKey(record, '--payer-account <number>', 'help.receipt.record.option.payer_account');
  optionByKey(record, '--payer-foreign-bank <name>', 'help.receipt.record.option.payer_foreign_bank');
  optionByKey(record, '--amount <amount>', 'help.receipt.record.option.amount', { mandatory: true });
  optionByKey(record, '--date <date>', 'help.receipt.record.option.date');
  optionByKey(record, '--method <method>', 'help.receipt.record.option.method', { defaultValue: 'spei' });
  optionByKey(record, '--bank <account>', 'help.receipt.record.option.bank');
  optionByKey(record, '--reference <text>', 'help.receipt.record.option.reference');
  optionByKey(record, '--json', 'help.receipt.record.option.json');
  withContext(record);
  declareRisk(record, {
    risk: 'irreversible',
    llave: { scope: 'receipt record' },
    agent: false,
    writes: 'customer_payments, payment_allocations, invoices.amount_due, journal_entries',
  });
  record.addHelpText('after', EJEMPLOS.record);
  record.action(
    (
      ref: string | undefined,
      opts: CommonOpts & {
        amount: string; date?: string; method: string; bank?: string;
        reference?: string; onAccount?: boolean; customer?: string; taxRate?: string;
        checkNumber?: string; payerBank?: string; payerAccount?: string; payerForeignBank?: string;
      }
    ) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const p = deps.palette;

        // MNE-001-421 (#623) · WITH NO INVOICE THE CASH IS AN ADVANCE, and what
        // cannot be one is refused here, before any service is asked. Its IVA
        // rate is a fact only the accountant states (there is no default) on
        // an entity that keeps Mexican books; the service refuses a rate on
        // one that does not.
        if (ref === undefined && !opts.customer) throw usageError(t('receipt.advance.needs_customer'));
        // MNE-001-462: with an invoice, a rate is the excess's, which only --on-account leaves.
        if (ref !== undefined && opts.taxRate !== undefined && !opts.onAccount) {
          throw usageError(t('receipt.advance.tax_rate_needs_on_account'));
        }
        const treatment = opts.taxRate === undefined ? null : readAdvanceTreatment(opts.taxRate);
        if (opts.taxRate !== undefined && treatment === null) {
          const params = { value: opts.taxRate, allowed: ADVANCE_TREATMENTS_AS_TYPED };
          throw usageError(t('receipt.advance.treatment_unknown', params));
        }
        if (ref === undefined && treatment === null && keepsMexicanBooks(ctx.country, ctx.accountingStandard)) {
          throw usageError(t('receipt.advance.rate_required'));
        }
        const target = ref === undefined ? null : await resolveInvoice(ctx.entityId, ref);
        const customer = opts.customer ? await resolveCustomer(ctx.entityId, opts.customer) : null;
        const label = target?.invoice_number ?? customer?.company_name ?? opts.customer ?? '';

        // ============================================================
        // LA LLAVE SE MIRA ANTES DE TRABAJAR.
        //
        // `conLlave` envuelve el acto, allá abajo, y para llegar hasta él hay
        // que pasar antes por la compuerta de estado y por un ensayo — y los
        // dos dependen del SALDO. Como el primer cobro ya lo bajó, el reintento
        // idéntico moría ahí sin llegar nunca al almacén: la promesa que esta
        // misma bandera publica —«a retry with the same key and payload returns
        // the recorded result»— sólo se cumplía en la ventana en que una
        // segunda aplicación seguiría siendo válida, y era FALSA justo en el
        // caso más frecuente que hay: cobrar la factura entera.
        //
        // Mirar es una lectura: no consuma la llave, no arbitra carreras —de
        // eso sigue encargándose `conLlave` con su restricción única— y no
        // sustituye a nadie. Sólo permite contestar sin tocar el dominio.
        //
        // Y LA RECETA DE LA CARGA ES UNA SOLA, calculada aquí y reutilizada
        // abajo. Dos recetas del mismo hash es cómo se rompe una idempotencia
        // sin que nadie lo note.
        // ============================================================
        const fechaDelCobro = opts.date ?? (await hoy(ctx));
        // Todo lo que tecleó el operador, no una lista a mano: enumerar campos
        // deja fuera el que nadie recuerde, y un campo persistido fuera del
        // hash hace que dos actos distintos compartan llave. La fecha se pasa
        // ya resuelta para que dos lecturas de `hoy()` no puedan discrepar de
        // madrugada.
        const cargaDeLaLlave = hashDeCarga(
          // An advance has no invoice to hash: its customer stands in for it.
          target?.id ?? String(customer?.id),
          fechaDelCobro,
          cargaDelOperador(opts as unknown as Record<string, unknown>)
        );
        if (opts.idempotencyKey && !opts.dryRun) {
          const grabado = await mirarLlave<{ pago: ResultadoPago }>(
            { tenantId: ctx.tenantId },
            { scope: AMBITO_DE_COBRO, clave: opts.idempotencyKey, payloadHash: cargaDeLaLlave }
          );
          if (grabado) {
            const previoDoc = grabado.pago.documentos[0];
            // El remanente se reconstruye de lo GRABADO, no del saldo de ahora:
            // el saldo ya cambió, y es lo que hacía imposible contestar tarde.
            const yaAplicado = previoDoc
              ? new Decimal(previoDoc.saldoAnterior).minus(previoDoc.saldoNuevo)
              : new Decimal(0);
            process.stderr.write(p.yellow(`${idempotencyHitNote(opts.idempotencyKey, grabado.pago.paymentNumber)}\n`));
            imprimirRegistro(
              grabado.pago,
              p,
              label,
              new Decimal(opts.amount).minus(yaAplicado),
              false,
              opts.json === true
            );
            return;
          }
        }

        if (target && !COBRABLES.includes(target.status as (typeof COBRABLES)[number])) {
          const reason = target.status === InvoiceStatus.PAID ? 'paid' : target.status === InvoiceStatus.DRAFT ? 'draft' : 'other';
          const params = { number: target.invoice_number, status: target.status, reason, collectable: COBRABLES.join(', ') };
          throw blockedByState({ key: 'ar.receipt.record.not_collectable', params });
        }

        // Con --on-account el excedente sobre el saldo queda como anticipo;
        // sin la bandera, el servicio rechaza aplicar más de lo debido.
        const monto = new Decimal(opts.amount);
        const saldo = new Decimal(target?.amount_due ?? '0');
        const aplicar = !target ? new Decimal(0) : opts.onAccount ? Decimal.min(monto, saldo) : monto;

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        // By name or id, scoped to the entity in the SQL (#327): a raw name used to
        // reach the INSERT and surface Postgres' uuid syntax error. The name is
        // echoed because a fragment may match an account the operator did not mean.
        const bank = opts.bank ? await resolverCuentaBancaria(ctx.entityId, opts.bank) : null;
        if (bank) process.stderr.write(p.dim(`${t('ap.payment.bank_account', { name: bank.account_name })}\n`));
        const entrada: EntradaPago = {
          entityId: ctx.entityId,
          // With both, the customer named is what the service checks the invoice against.
          counterpartyId: customer ? String(customer.id) : (target as NonNullable<typeof target>).customer_id,
          paymentAmount: opts.amount,
          paymentDate: fechaDelCobro,
          paymentMethod: opts.method,
          bankAccountId: bank?.id ?? null,
          referenceNumber: opts.reference ?? null,
          checkNumber: opts.checkNumber ?? null,
          payerAccount: opts.payerAccount ?? null,
          payerBankCode: opts.payerBank ?? null,
          payerForeignBank: opts.payerForeignBank ?? null,
          applications: target && aplicar.greaterThan(0)
            ? [{ documentId: target.id, amountApplied: aplicar.toFixed(2) }]
            : [],
          onAccount: !target || opts.onAccount === true,
          ...(treatment ? { advanceTreatment: treatment } : {}),
          // MNE-001-462: the excess of a collection is an advance (LIVA art. 1-B); unstated, it takes the invoice's rate.
          ...(target && opts.onAccount && !treatment ? { advanceTreatmentFromInvoice: true } : {}),
        };

        const previo = await recordCustomerPayment(entrada, reviewer.userId, { dryRun: true });
        const doc = previo.documentos[0];
        const remanente = monto.minus(aplicar);
        // A warning, not a refusal: a second advance for another sale is legitimate.
        if (previo.advanceInvoices?.length) {
          const params = { customer: label, invoices: previo.advanceInvoices.join(', '), invoice: previo.advanceInvoices[0] };
          process.stderr.write(p.yellow(`${t('receipt.advance.invoice_already_booked', params)}\n`));
        }
        // MNE-001-558 · by cheque, the IVA the figures name waits in 2150 for the bank.
        if (opts.method === 'check' && previo.advance && new Decimal(previo.advance.iva).greaterThan(0)) {
          process.stderr.write(p.dim(`${t('receipt.advance.cheque_held', { iva: previo.advance.iva })}\n`));
        }

        if (opts.dryRun) {
          imprimirRegistro(previo, p, label, remanente, true, opts.json === true);
          process.stderr.write(p.dim(`${t('ap.payment.dry_run')}\n`));
          return;
        }

        await confirmOrAbort(
          opts,
          target
            ? t('ar.receipt.record.confirm', { amount: opts.amount, currency: target.currency_code, invoice: target.invoice_number, entity: ctx.entityName,
                balances: doc ? ` (${doc.saldoAnterior} → ${doc.saldoNuevo})` : '', left: remanente.greaterThan(0) ? 'yes' : 'none', leftAmount: remanente.toFixed(2),
                advance: previo.advance ? ` (${t('receipt.advance.label')}: ${excessFigures(previo.advance)})` : '', bank: bank ? 'yes' : 'none', bankName: bank?.account_name ?? '',
              })
            : t('receipt.advance.confirm', {
                amount: opts.amount, customer: label, entity: ctx.entityName,
                figures: previo.advance ? ` (${advanceFigures(previo.advance)})` : '',
              })
        );

        // ============================================================
        // LA LLAVE, HONRADA. (T3)
        //
        // `declareRisk` inyecta --idempotency-key en toda hoja irreversible y
        // su ayuda promete que «a retry with the same key and payload returns
        // the recorded result». Aquí se aceptaba y se TIRABA: medido contra
        // Postgres, `receipt record INV-2026-00001 --amount 5000
        // --idempotency-key k` repetido dejaba DOS customer_payments, DOS
        // payment_allocations, DOS asientos posteados y el saldo de la
        // factura en 1,600 en vez de 6,600 — con `idempotency_keys` vacía.
        //
        // El patrón es el de entry-command.ts (`conLlave` + `hashDeCarga` +
        // aviso de repetido), no uno nuevo. Dos detalles que sí son de aquí:
        //
        //   · LA CARGA ES EL COBRO ENTERO, no sólo el importe. Cobrar 5,000
        //     por SPEI y cobrar 5,000 en efectivo con otra referencia son
        //     actos distintos, y devolverle al segundo el resultado del
        //     primero escondería un cobro tras una llave reutilizada. Con la
        //     carga completa, `conLlave` acusa el reuso (salida 6) en vez de
        //     callar.
        //   · Y LA CARGA ES LA ENTRADA, NUNCA UN DERIVADO. Aquí estuvo
        //     `aplicar.toFixed(2)`, que no es lo que teclea el operador sino
        //     `Decimal.min(monto, saldo)` — o sea, se deriva del saldo VIVO de
        //     la factura. Tras el primer cobro el saldo bajó, así que el
        //     reintento idéntico calculaba otro `aplicar`, otro hash, y la
        //     llave se leía como «usada con una carga DISTINTA»: el mismo
        //     comando con la misma llave se acusaba de reuso (salida 6) en vez
        //     de devolver el resultado grabado, rompiendo justo la promesa que
        //     este tramo vino a hacer verdadera. `entrada.onAccount` ya
        //     distingue los dos actos que había que distinguir.
        //   · SE CONSUMA DESPUÉS DE LA CONFIRMACIÓN Y NUNCA EN --dry-run: el
        //     ensayo sale por su `return` de más arriba sin tocar el almacén,
        //     porque una llave consumada por un acto que no escribió haría
        //     que el reintento de verdad contestara con el informe del ensayo.
        // ============================================================
        const acto = await conLlave(
          { tenantId: ctx.tenantId, entityId: ctx.entityId },
          {
            scope: AMBITO_DE_COBRO,
            clave: opts.idempotencyKey,
            payloadHash: cargaDeLaLlave,
          },
          async () => ({ pago: await recordCustomerPayment(entrada, reviewer.userId) })
        );
        const result = acto.resultado.pago;
        if (acto.repetido) {
          process.stderr.write(p.yellow(`${idempotencyHitNote(opts.idempotencyKey ?? '', result.paymentNumber)}\n`));
        } else if (result.attestation) {
          attestEntryAsync(ctx.tenantId, result.attestation.entityId, result.attestation.entryId);
        }
        imprimirRegistro(result, p, label, remanente, false, opts.json === true);
        // MNE-001-571 · what its voucher will lack, in the generator's own words.
        await warnUntracedPayment('customer', ctx.entityId, result.paymentId, { json: opts.json === true, palette: p });
      })
  );

  // ---- receipt show ------------------------------------------------
  const show = describeCommand(receipt.command('show').alias('ver'), 'help.receipt.show.description');
  argumentByKey(show, '<ref>', 'help.receipt.show.argument.ref');
  withOutput(withContext(show));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.show);
  show.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const cobro = await getCustomerPayment(ctx.entityId, ref);
      const p = deps.palette;

      // NOTE: --format defaults to 'table', so testing its mere presence left the
      // detail view below unreachable; it is compared, as `bill show` does.
      // --fields and --quiet still pick from the row.
      if (opts.json || opts.output || opts.fields || opts.quiet || (opts.format && opts.format !== 'table')) {
        render([cobro as unknown as Record<string, unknown>], {
          ...opts, idField: 'payment_number', numeric: MONEY,
        });
        return;
      }

      const out = process.stdout;
      out.write(
        `\n${p.bold(cobro.payment_number)} ${p.dim(cobro.status)}  ${cobro.customer_name ?? ''}\n`
      );
      // The labels pad to the longest one (18 at least, the English width); REP reads the same in Spanish.
      const labels = ['date', 'amount', 'method', 'reference', 'on_account', 'reversed', 'reversal_cause', 'cause_stated'] as const;
      const others = [t('receipt.cheque.cashed_label'), t('receipt.advance.label'), t('ar.invoice.show.ledger_entry')];
      const width = Math.max(18, ...[...labels.map((l) => t(`ar.receipt.show.${l}`)), ...others].map((label) => label.length + 1));
      const fact = (label: string, value: string | number | null | undefined) => {
        if (value === null || value === undefined || value === '') return;
        out.write(`  ${p.dim(label.padEnd(width))}${String(value)}\n`);
      };
      fact(t('ar.receipt.show.date'), dateOnly(cobro.payment_date));
      fact(t('ar.receipt.show.amount'), `${cobro.payment_amount} ${cobro.currency_code}`);
      fact(t('ar.receipt.show.method'), cobro.payment_method);
      // MNE-001-556: a cheque's VAT is caused the day the bank cashes it, so the receipt says whether it has.
      if (cobro.payment_method === 'check' && (cobro.check_cashed_tx_id || cobro.status === 'completed')) {
        fact(
          t('receipt.cheque.cashed_label'),
          cobro.check_cashed_tx_id
            ? t('receipt.cheque.cashed', { date: cobro.check_cashed_date ?? '', transaction: cobro.check_cashed_tx_id })
            : t('receipt.cheque.not_cashed')
        );
      }
      fact(t('ar.receipt.show.reference'), cobro.reference_number);
      fact(t('ar.receipt.show.on_account'), cobro.unapplied_amount !== '0.00' ? cobro.unapplied_amount : null);
      const { advance_base: base, advance_tax_rate: treatment, advance_iva: iva } = cobro;
      const isAdvance = base !== null && treatment !== null && iva !== null;
      if (isAdvance) fact(t('receipt.advance.label'), advanceFigures({ base, treatment, iva }));
      fact(t('ar.invoice.show.ledger_entry'), cobro.journal_entry_number);
      // A receipt that is all advance owes the advance CFDI the client issues, not a REP.
      const allAdvance = isAdvance && new Decimal(base).plus(iva).equals(cobro.payment_amount);
      fact(
        'REP',
        cobro.cfdi_uuid
          ? `${cobro.cfdi_uuid} (pago ${cobro.cfdi_pago_indice ?? '—'})`
          : allAdvance
            ? t('receipt.advance.cfdi_owed')
            : p.yellow(t('ar.receipt.no_rep'))
      );
      if (cobro.reversed_at) {
        fact(t('ar.receipt.show.reversed'), p.yellow(new Date(cobro.reversed_at).toISOString()));
        // MNE-001-499: a transfer moved no money, so it has no cause to state.
        fact(t('ar.receipt.show.reversal_cause'), cobro.payment_method === 'balance_transfer'
          ? t('receipt.cause.none_for_transfer') : (cobro.reversal_cause ?? t('ar.receipt.show.cause_not_stated')));
        // Later than the reversal when the cause was stated afterwards (MNE-001-511).
        if (cobro.reversal_cause_stated_at) fact(t('ar.receipt.show.cause_stated'), new Date(cobro.reversal_cause_stated_at).toISOString());
      }

      out.write(`\n${p.bold(t('ar.receipt.show.applications'))} ${p.dim(`(${cobro.aplicaciones.length})`)}\n`);
      if (cobro.aplicaciones.length) {
        render(
          cobro.aplicaciones.map((a) => ({
            invoice: a.invoice_number,
            applied_on: a.applied_on,
            applied: a.amount_applied,
            isr_withheld: a.withholding_isr_amount,
            vat_withheld: a.withholding_iva_amount,
            iva_released: a.iva_reclass_amount ?? '',
            advance_iva: a.advance_iva_amount,
            live: a.viva ? 'yes' : 'no',
            unapplied_reason: a.unapply_reason ?? '',
          })),
          { format: 'table', numeric: ['applied', 'isr_withheld', 'vat_withheld', 'iva_released', 'advance_iva'] }
        );
      }
      out.write('\n');
    })
  );

  // ---- receipt list ------------------------------------------------
  const list = describeCommand(receipt.command('list').alias('listar'), 'help.receipt.list.description');
  withOutput(withSelection(withTime(withContext(list))));
  optionByKey(list, '--customer <ref>', 'help.receipt.list.option.customer');
  optionByKey(list, '--unapplied', 'help.receipt.list.option.unapplied');
  optionByKey(list, '--needs-rep', 'help.receipt.list.option.needs_rep');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.list);
  list.action(
    (opts: CommonOpts & { customer?: string; unapplied?: boolean; needsRep?: boolean }) =>
      run(async () => {
        const ctx = await entityOf(opts);
        if (opts.status?.length) {
          throw usageError({ key: 'ar.receipt.list.status_filter' });
        }
        const customerId = opts.customer
          ? String((await resolveCustomer(ctx.entityId, opts.customer)).id)
          : undefined;
        const { rows, total } = await listCustomerPayments(ctx.entityId, {
          customerId,
          since: opts.since,
          until: opts.until,
          unapplied: opts.unapplied,
          needsRep: opts.needsRep,
          limit: opts.all ? 500 : (opts.limit ?? 50),
          offset: opts.offset,
        });
        render(
          rows.map((r) => ({
            payment_number: r.payment_number,
            payment_date: dateOnly(r.payment_date),
            customer_name: r.customer_name ?? '',
            payment_amount: r.payment_amount,
            applied_amount: r.applied_amount,
            unapplied_amount: r.unapplied_amount,
            currency_code: r.currency_code,
            status: r.status,
            rep: r.has_rep ? '✓' : '—',
            id: r.id,
          })),
          {
            ...opts,
            total,
            idField: 'payment_number',
            numeric: MONEY,
            fields:
              opts.fields ??
              'payment_number,payment_date,customer_name,payment_amount,applied_amount,unapplied_amount,status,rep',
          }
        );
      })
  );

  // ---- receipt apply -----------------------------------------------
  const apply = receipt
    .command('apply')
    .alias('aplicar');
  argumentByKey(apply, '<ref>', 'help.receipt.apply.argument.ref');
  describeCommand(apply, 'help.receipt.apply.description');
  withContext(apply);
  optionByKey(apply, '--invoice <spec...>', 'help.receipt.apply.option.invoice');
  optionByKey(apply, '--amount <amount>', 'help.receipt.apply.option.amount');
  optionByKey(apply, '--json', 'help.receipt.apply.option.json');
  optionByKey(apply, '--withholding <spec...>', 'help.receipt.apply.option.withholding');
  optionByKey(apply, '--date <date>', 'help.receipt.apply.option.date');
  declareRisk(apply, {
    risk: 'irreversible',
    llave: { sinLlave: { key: 'ar.receipt.retry_reallocates' } },
    agent: false,
    writes: 'payment_allocations, invoices.amount_due, journal_entries',
  });
  apply.addHelpText('after', EJEMPLOS.apply);
  apply.action(
    (ref: string, opts: CommonOpts & { invoice?: string[]; amount?: string; withholding?: string[]; date?: string }) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const { dryRun } = gateMutation(apply, opts as Record<string, unknown>);
        // MNE-001-460: resolved once, so the preview and the write cannot disagree at midnight.
        const date = opts.date ?? (await hoy(ctx));
        const p = deps.palette;
        const pares = parseAplicaciones(opts.invoice, opts.amount);
        const withheld = parseWithholding(opts.withholding, pares.map((x) => x.ref));

        const cobro = await getCustomerPayment(ctx.entityId, ref);
        const aplicaciones = [];
        for (const par of pares) {
          const factura = await resolveInvoice(ctx.entityId, par.ref);
          const w = withheld.get(par.ref);
          aplicaciones.push({
            documentId: factura.id,
            amountApplied: new Decimal(par.amount as string).toFixed(2),
            ...(w ? { withholdingIsr: w.isr.toFixed(2), withholdingIva: w.iva.toFixed(2) } : {}),
          });
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const previo = await applyCustomerPayment(ctx.entityId, cobro.id, aplicaciones, reviewer.userId, { dryRun: true, date });

        // MNE-001-422: an advance's IVA declared twice in an earlier month is said before anything posts.
        const twice = previo.documentos.map((d) => advanceWarning(d.numero, d, previo.date)).filter((w): w is string => w !== null);
        if (dryRun) {
          imprimirAplicacion(previo.documentos, previo.remanenteAnterior, previo.remanenteNuevo, cobro.payment_number, p, true, opts.json === true, previo.journalEntry?.entry_number ?? null, previo.date);
          for (const w of twice) process.stderr.write(p.yellow(`${w}\n`));
          process.stderr.write(p.dim(`${t('ap.payment.dry_run')}\n`));
          return;
        }

        await confirmOrAbort(
          opts,
          t('ar.receipt.apply.confirm', {
            documents: previo.documentos.map((d) => `${d.numero} (${d.saldoAnterior} → ${d.saldoNuevo}${withheldText(d)}${advanceText(d, 'receipt.advance.iva_cancelled')})`).join(', '),
            payment: cobro.payment_number, before: previo.remanenteAnterior, after: previo.remanenteNuevo, date: previo.date, entity: ctx.entityName }) +
            twice.map((w) => `\n${w}`).join('')
        );

        const result = await applyCustomerPayment(ctx.entityId, cobro.id, aplicaciones, reviewer.userId, { date });
        if (result.attestation) {
          attestEntryAsync(ctx.tenantId, result.attestation.entityId, result.attestation.entryId);
        }
        imprimirAplicacion(result.documentos, result.remanenteAnterior, result.remanenteNuevo, cobro.payment_number, p, false, opts.json === true, result.journalEntry?.entry_number ?? null, result.date);
        if (!opts.json) for (const w of twice) process.stderr.write(p.yellow(`${w}\n`));
      })
  );

  // ---- receipt unapply ---------------------------------------------
  const unapply = describeCommand(receipt.command('unapply').alias('desaplicar'), 'help.receipt.unapply.description');
  argumentByKey(unapply, '<ref>', 'help.receipt.unapply.argument.ref');
  withContext(unapply);
  optionByKey(unapply, '--invoice <ref>', 'help.receipt.unapply.option.invoice', { mandatory: true });
  optionByKey(unapply, '--reason <text>', 'help.receipt.unapply.option.reason', { mandatory: true });
  optionByKey(unapply, '--json', 'help.receipt.unapply.option.json');
  optionByKey(unapply, '--date <date>', 'help.receipt.unapply.option.date');
  declareRisk(unapply, {
    risk: 'irreversible',
    llave: { sinLlave: { key: 'ar.receipt.retry_unapplies' } },
    agent: false,
    writes: 'payment_allocations (closure), invoices.amount_due, journal_entries',
  });
  unapply.addHelpText('after', EJEMPLOS.unapply);
  unapply.action(
    (ref: string, opts: CommonOpts & { invoice: string; reason: string; date?: string }) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const { dryRun } = gateMutation(unapply, opts as unknown as Record<string, unknown>);
        const p = deps.palette;
        // MNE-001-460: resolved once, so the preview and the write cannot disagree at midnight.
        const date = opts.date ?? (await hoy(ctx));

        const cobro = await getCustomerPayment(ctx.entityId, ref);
        const factura = await resolveInvoice(ctx.entityId, opts.invoice);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const previo = await unapplyCustomerPayment(
          ctx.entityId, cobro.id,
          { invoiceId: factura.id, reason: opts.reason, date },
          reviewer.userId, { dryRun: true }
        );
        // MNE-001-572 · a held cheque's cash goes back untaxed; its cashing causes that IVA.
        const atCashing = (iva: string): void => {
          if (new Decimal(iva).greaterThan(0)) process.stderr.write(p.dim(`${t('receipt.unapply.iva_at_cashing', { iva })}\n`));
        };
        // MNE-001-574 · the IVA a plain receipt's cash keeps caused while it waits on account.
        // MNE-001-585 · under repark_same_month, a row released in an earlier month says why it keeps it.
        const keptText = (r: typeof previo): string =>
          !new Decimal(r.ivaKeptCaused).greaterThan(0)
            ? ''
            : r.keptBecause === 'later_month'
              ? ` · ${t('receipt.unapply.iva_kept_later_month', { iva: r.ivaKeptCaused, key: 'plain_receipt_unapply_iva', month: r.date.slice(0, 7) })}`
              : ` · ${t('receipt.unapply.iva_kept', { iva: r.ivaKeptCaused })}`;

        // The IVA parked again, as a suffix; empty when none.
        const reparked = (r: typeof previo): string => !new Decimal(r.ivaReAparcado).greaterThan(0) ? ''
          : p.dim(` · ${t('ar.receipt.unapply.reparked', { iva: r.ivaReAparcado, estimate: r.ivaEstimado ? 'yes' : 'no' })}`);
        const doc = previo.documento;
        const said = { before: doc.saldoAnterior, after: doc.saldoNuevo, withheld: withheldText(doc), advance: advanceText(doc, 'receipt.advance.iva_restored'), invoice: doc.numero };

        if (dryRun) {
          atCashing(previo.ivaAtCashing);
          process.stdout.write(
            `${p.bold(t('ar.receipt.unapply.would', { amount: previo.desaplicado, invoice: doc.numero }))} ` +
              p.dim(t('ar.receipt.unapply.would_detail', { ...said, date: previo.date })) + reparked(previo) + p.dim(keptText(previo)) + '\n'
          );
          process.stderr.write(p.dim(`${t('ap.payment.dry_run')}\n`));
          return;
        }

        await confirmOrAbort(
          opts,
          t('ar.receipt.unapply.confirm', { ...said, amount: previo.desaplicado, payment: cobro.payment_number, date: previo.date, kept: keptText(previo) })
        );

        const result = await unapplyCustomerPayment(
          ctx.entityId, cobro.id,
          { invoiceId: factura.id, reason: opts.reason, date },
          reviewer.userId
        );
        attestEntryAsync(ctx.tenantId, result.attestation.entityId, result.attestation.entryId);

        if (opts.json) {
          render([{
            payment_number: result.paymentNumber,
            invoice: result.documento.numero,
            unapplied: result.desaplicado,
            withholding_isr: result.documento.withholdingIsr ?? '0.00',
            withholding_iva: result.documento.withholdingIva ?? '0.00',
            iva_reparked: result.ivaReAparcado,
            iva_kept_caused: result.ivaKeptCaused,
            advance_iva_restored: result.documento.advanceIva ?? '0.00',
            iva_at_cashing: result.ivaAtCashing,
            date: result.date,
            entry_number: result.journalEntry.entry_number,
          }], { json: true });
          atCashing(result.ivaAtCashing);
          return;
        }
        process.stdout.write(
          `${p.green('✔')} ${t('ar.receipt.unapply.done', { payment: p.bold(result.paymentNumber), invoice: p.bold(result.documento.numero) })} ` +
            p.dim(`${result.documento.saldoAnterior} → ${result.documento.saldoNuevo}${withheldText(result.documento)}${advanceText(result.documento, 'receipt.advance.iva_restored')} · ${result.date} · ${t('ap.payment.entry', { entry: result.journalEntry.entry_number })}`) +
            reparked(result) + p.dim(keptText(result)) + '\n'
        );
        atCashing(result.ivaAtCashing);
      })
  );

  // ---- receipt reverse ---------------------------------------------
  const reverse = receipt
    .command('reverse')
    .alias('reversar');
  argumentByKey(reverse, '<ref>', 'help.receipt.reverse.argument.ref');
  describeCommand(reverse, 'help.receipt.reverse.description');
  withContext(reverse);
  optionByKey(reverse, '--cause <cause>', 'help.receipt.reverse.option.cause');
  optionByKey(reverse, '--fee <amount>', 'help.receipt.reverse.option.fee');
  optionByKey(reverse, '--json', 'help.receipt.reverse.option.json');
  declareRisk(reverse, {
    risk: 'irreversible',
    llave: { sinLlave: { key: 'ar.receipt.retry_reverses' } },
    agent: false,
    writes: 'customer_payments.status, payment_allocations (closure), invoices, reversing journal_entries',
  });
  reverse.addHelpText('after', EJEMPLOS.reverse);
  reverse.action(
    (ref: string, opts: CommonOpts & { fee?: string; cause?: string }) =>
      run(async () => {
        // A cause outside the two is refused before the receipt is read.
        if (opts.cause !== undefined && !(REVERSAL_CAUSES as readonly string[]).includes(opts.cause)) {
          throw usageError(t('receipt.reverse.cause_unknown', { value: opts.cause }));
        }
        const ctx = await writeEntityOf(opts);
        const { dryRun, reason } = gateMutation(reverse, opts as Record<string, unknown>);
        const p = deps.palette;

        const cobro = await getCustomerPayment(ctx.entityId, ref);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const previo = await reverseCustomerPayment(
          ctx.entityId, cobro.id,
          { reason: reason as string, cause: opts.cause, feeAmount: opts.fee },
          reviewer.userId, { dryRun: true }
        );
        // What the service decided, repeated: the cause, and what to read before confirming.
        const warnings = previo.warnings.map((key) => t(key));

        if (dryRun) {
          process.stdout.write(
            `${p.bold(t('ar.receipt.reverse.would', { payment: cobro.payment_number }))} ${p.dim(
              `· ${t('ar.receipt.reverse.would_detail', { entries: previo.reversals.length, invoices: previo.documentosReabiertos.length })}`
            )}\n`
          );
          for (const d of previo.documentosReabiertos) {
            process.stdout.write(p.dim(`  ${d.numero} ${d.saldoAnterior} → ${d.saldoNuevo} (${d.estado})\n`));
          }
          process.stdout.write(`  ${causeText(previo)}\n`);
          for (const w of warnings) process.stderr.write(p.yellow(`${w}\n`));
          process.stderr.write(p.dim(`${t('ap.payment.dry_run')}\n`));
          return;
        }

        await confirmOrAbort(
          opts,
          t('ar.receipt.reverse.confirm', { payment: cobro.payment_number, amount: cobro.payment_amount, currency: cobro.currency_code, cause: causeText(previo),
            entries: previo.reversals.length, invoices: previo.documentosReabiertos.length }) + warnings.map((w) => `\n${w}`).join('')
        );

        const result = await reverseCustomerPayment(
          ctx.entityId, cobro.id,
          { reason: reason as string, cause: opts.cause, feeAmount: opts.fee },
          reviewer.userId
        );
        for (const a of result.attestations) {
          attestEntryAsync(ctx.tenantId, a.entityId, a.entryId);
        }

        if (opts.json) {
          render([{
            payment_number: result.paymentNumber,
            status: 'reversed',
            reversals: result.reversals.map((r) => r.entryNumber).join(', '),
            invoices_reopened: result.documentosReabiertos.length,
            cause: result.cause,
            cause_defaulted: result.causeDefaulted,
            warnings: result.warnings.map((key) => t(key)).join(' '),
          }], { json: true });
          return;
        }
        process.stdout.write(
          `${p.green('✔')} ${t('ar.receipt.reverse.done', { payment: p.bold(result.paymentNumber) })} ` +
            p.dim(
              `· ${result.reversals.map((r) => `${r.of}→${r.entryNumber}`).join(', ')} · ` +
                `${t('ar.receipt.reverse.reopened', { count: result.documentosReabiertos.length })} · ${causeText(result)}\n`
            )
        );
        for (const key of result.warnings) process.stderr.write(p.yellow(`${t(key)}\n`));
      })
  );

  // ---- receipt cause record (MNE-001-511) ---------------------------
  // The cause of a receipt that was reversed with none, stated afterwards.
  // `cause` qualifies `receipt`, as `tax` qualifies `customer`.
  const cause = describeCommand(receipt.command('cause').alias('causa'), 'help.receipt.cause.description');
  const causeRecord = describeCommand(cause.command('record').alias('registrar'), 'help.receipt.cause.record.description');
  argumentByKey(causeRecord, '<ref>', 'help.receipt.cause.record.argument.ref');
  withContext(causeRecord);
  optionByKey(causeRecord, '--cause <cause>', 'help.receipt.cause.record.option.cause', { mandatory: true });
  // `record` is not an undo verb, so the kernel does not inject --reason: the leaf declares it.
  optionByKey(causeRecord, '--reason <text>', 'cli.flag.reason');
  optionByKey(causeRecord, '--json', 'help.receipt.cause.record.option.json');
  declareRisk(causeRecord, {
    risk: 'irreversible',
    llave: { innecesaria: t('ar.receipt.cause.key_unneeded') },
    agent: false,
    writes: 'customer_payments.reversal_cause, customer_payments.reversal_cause_stated_at',
  });
  causeRecord.addHelpText('after', EJEMPLOS.causeRecord);
  causeRecord.action(
    (ref: string, opts: CommonOpts & { cause?: string; reason?: string }) =>
      run(async () => {
        // A cause outside the two is refused before the receipt is read.
        const stated = opts.cause ?? '';
        if (!(REVERSAL_CAUSES as readonly string[]).includes(stated)) {
          throw usageError(t('receipt.reverse.cause_unknown', { value: stated }));
        }
        const { dryRun, reason } = gateMutation(causeRecord, opts as Record<string, unknown>);
        if (!reason?.trim() && !dryRun) throw usageError({ key: 'receipt.cause.reason_required' });
        const ctx = await writeEntityOf(opts);
        const p = deps.palette;

        const payment = await getCustomerPayment(ctx.entityId, ref);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const args = { cause: stated, reason: reason?.trim() ?? '' };

        const preview = await stateReversalCause(ctx.entityId, payment.id, args, reviewer.userId, { dryRun: true });
        const warnings = preview.warnings.map((key) => t(key));
        if (dryRun) {
          process.stdout.write(`${t('receipt.cause.would_state', { number: preview.paymentNumber, cause: preview.cause })}\n`);
          for (const w of warnings) process.stderr.write(p.yellow(`${w}\n`));
          process.stderr.write(p.dim(`${t('ap.payment.dry_run')}\n`));
          return;
        }

        await confirmOrAbort(
          opts,
          t('receipt.cause.confirm', { number: preview.paymentNumber, cause: preview.cause }) +
            warnings.map((w) => `\n${w}`).join('')
        );

        const result = await stateReversalCause(ctx.entityId, payment.id, args, reviewer.userId);
        if (opts.json) {
          render([{
            payment_number: result.paymentNumber,
            cause: result.cause,
            stated_at: result.statedAt.toISOString(),
            warnings: result.warnings.map((key) => t(key)).join(' '),
          }], { json: true });
          return;
        }
        process.stdout.write(
          `${p.green('✔')} ${t('receipt.cause.stated', {
            number: result.paymentNumber, cause: result.cause, stated_at: result.statedAt.toISOString(),
          })}\n`
        );
        for (const key of result.warnings) process.stderr.write(p.yellow(`${t(key)}\n`));
      })
  );

  // ---- receipt allocation close (MNE-001-605, #809) ----------------
  // The live allocation a reversed receipt still has on an invoice, the row
  // `ar check` names in orphan-application, closed by a person. It posts
  // nothing: the reversal already mirrored the entries and reopened the invoice.
  const allocation = describeCommand(receipt.command('allocation').alias('aplicacion'), 'help.receipt.allocation.description');
  const allocationClose = describeCommand(
    allocation.command('close').alias('cerrar'), 'help.receipt.allocation.close.description'
  );
  argumentByKey(allocationClose, '<ref>', 'help.receipt.allocation.close.argument.ref');
  withContext(allocationClose);
  optionByKey(allocationClose, '--invoice <ref>', 'help.receipt.allocation.close.option.invoice', { mandatory: true });
  // `close` is not an undo verb, so the kernel does not inject --reason: the leaf declares it, mandatory.
  optionByKey(allocationClose, '--reason <text>', 'help.receipt.allocation.close.option.reason', { mandatory: true });
  optionByKey(allocationClose, '--json', 'help.receipt.allocation.close.option.json');
  declareRisk(allocationClose, {
    risk: 'irreversible',
    llave: { innecesaria: t('receipt.allocation.close.key_unneeded') },
    agent: false,
    writes: 'payment_allocations (closure)',
  });
  allocationClose.addHelpText('after', () => t('help.receipt.allocation.close.examples'));
  allocationClose.action(
    (ref: string, opts: CommonOpts & { invoice: string; reason: string }) =>
      run(async () => {
        const { dryRun } = gateMutation(allocationClose, opts as unknown as Record<string, unknown>);
        const ctx = await writeEntityOf(opts);
        const p = deps.palette;

        const payment = await getCustomerPayment(ctx.entityId, ref);
        const invoice = await resolveInvoice(ctx.entityId, opts.invoice);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const args = { invoiceId: invoice.id, reason: opts.reason };
        const said = (r: Awaited<ReturnType<typeof closeOrphanAllocation>>) => ({
          count: r.closed, number: r.paymentNumber, invoice: r.invoiceNumber, amount: r.amount,
          closed_at: r.closedAt.toISOString(),
        });

        const preview = await closeOrphanAllocation(ctx.entityId, payment.id, args, reviewer.userId, { dryRun: true });
        if (dryRun) {
          process.stdout.write(`${t('receipt.allocation.close.would_close', said(preview))}\n`);
          process.stderr.write(p.dim(`${t('receipt.allocation.close.dry_run')}\n`));
          return;
        }

        await confirmOrAbort(opts, t('receipt.allocation.close.confirm', said(preview)));

        const result = await closeOrphanAllocation(ctx.entityId, payment.id, args, reviewer.userId);
        if (opts.json) {
          render([{
            payment_number: result.paymentNumber,
            invoice: result.invoiceNumber,
            closed: result.closed,
            amount: result.amount,
            unapplied_at: result.closedAt.toISOString(),
          }], { json: true });
          return;
        }
        process.stdout.write(`${p.green('✔')} ${t('receipt.allocation.close.closed', said(result))}\n`);
      })
  );

  // ---- receipt trace record (MNE-001-570, #612) ---------------------
  // The trace of a receipt already registered, completed from its evidence,
  // on the service and rules of `payment trace record`: only empty fields,
  // with a reason, posting nothing. The flags are `receipt record`'s own.
  const trace = describeCommand(receipt.command('trace').alias('rastro'), 'help.receipt.trace.description');
  const traceRecord = describeCommand(trace.command('record').alias('registrar'), 'help.receipt.trace.record.description');
  argumentByKey(traceRecord, '<receipt>', 'help.receipt.trace.record.argument.receipt');
  withContext(traceRecord);
  optionByKey(traceRecord, '--check-number <number>', 'help.receipt.trace.record.option.check_number');
  optionByKey(traceRecord, '--payer-bank <code>', 'help.receipt.trace.record.option.payer_bank');
  optionByKey(traceRecord, '--payer-account <number>', 'help.receipt.trace.record.option.payer_account');
  optionByKey(traceRecord, '--payer-foreign-bank <name>', 'help.receipt.trace.record.option.payer_foreign_bank');
  optionByKey(traceRecord, '--bank <account>', 'help.receipt.trace.record.option.bank');
  // `record` is not an undo verb, so the kernel does not inject --reason: the leaf declares it.
  optionByKey(traceRecord, '--reason <text>', 'cli.flag.reason');
  optionByKey(traceRecord, '--json', 'help.receipt.trace.record.option.json');
  declareRisk(traceRecord, {
    risk: 'irreversible',
    llave: { innecesaria: t('ar.receipt.trace.key_unneeded') },
    agent: false,
    writes: "customer_payments: its empty trace columns (the cheque number, the customer's bank and account, the bank account)",
  });
  traceRecord.addHelpText('after', EJEMPLOS.traceRecord);
  traceRecord.action(
    (ref: string, opts: CommonOpts & {
      checkNumber?: string; payerBank?: string; payerAccount?: string; payerForeignBank?: string; bank?: string; reason?: string;
    }) =>
      run(async () => {
        const given = [opts.checkNumber, opts.payerBank, opts.payerAccount, opts.payerForeignBank, opts.bank];
        if (given.every((v) => (v ?? '').trim() === '')) throw usageError({ key: 'receipt.trace.nothing_given' });
        const { dryRun, reason } = gateMutation(traceRecord, opts as Record<string, unknown>);
        if (!reason?.trim() && !dryRun) throw usageError({ key: 'payment.trace.reason_required' });
        const ctx = await writeEntityOf(opts);
        const p = deps.palette;
        const registered = await getCustomerPayment(ctx.entityId, ref);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const bank = (opts.bank ?? '').trim() === '' ? null : await resolverCuentaBancaria(ctx.entityId, (opts.bank as string).trim());
        const fields = {
          checkNumber: opts.checkNumber, payerBank: opts.payerBank, payerAccount: opts.payerAccount,
          payerForeignBank: opts.payerForeignBank, bankAccountId: bank?.id ?? null,
        };
        const why = reason?.trim() ?? '';

        const preview = await completePaymentTrace(ctx.entityId, 'customer', registered.id, fields, why, reviewer.userId, { dryRun: true });
        let result = preview;
        if (!dryRun && preview.filled.length > 0) {
          await confirmOrAbort(opts, t('payment.trace.confirm', { number: preview.paymentNumber, fields: listedTraceFields(preview.filled) }));
          result = await completePaymentTrace(ctx.entityId, 'customer', registered.id, fields, why, reviewer.userId);
        }
        writeTraceCompletion(result, { dryRun, json: opts.json, palette: p });
        // MNE-001-571 · a finding names one gap at a time: say the next one now.
        if (!dryRun && result.filled.length > 0) {
          await warnUntracedPayment('customer', ctx.entityId, registered.id, { json: opts.json === true, palette: p });
        }
      })
  );

  // ---- receipt transfer record (MNE-001-498, #695 part 1/2) ---------
  // A customer's cash on account moves to another customer, as agreed: a
  // credit row for B linked to A's receipt, and its own entry. `transfer`
  // qualifies `receipt`, as `cause` and `trace` do.
  const transferNoun = describeCommand(receipt.command('transfer').alias('traspaso'), 'help.receipt.transfer.description');
  const transferRecord = describeCommand(
    transferNoun.command('record').alias('registrar'), 'help.receipt.transfer.record.description'
  );
  argumentByKey(transferRecord, '<ref>', 'help.receipt.transfer.record.argument.ref');
  withContext(transferRecord);
  optionByKey(transferRecord, '--customer <customer>', 'help.receipt.transfer.record.option.customer', { mandatory: true });
  optionByKey(transferRecord, '--amount <amount>', 'help.receipt.transfer.record.option.amount', { mandatory: true });
  optionByKey(transferRecord, '--date <date>', 'help.receipt.transfer.record.option.date');
  // `record` is not an undo verb, so the kernel does not inject --reason: the leaf declares it.
  optionByKey(transferRecord, '--reason <text>', 'cli.flag.reason');
  optionByKey(transferRecord, '--json', 'help.receipt.transfer.record.option.json');
  declareRisk(transferRecord, {
    risk: 'irreversible',
    llave: { scope: 'receipt transfer record' },
    agent: false,
    writes: 'customer_payments (the receiving row), journal_entries, audit_log',
  });
  transferRecord.addHelpText('after', EJEMPLOS.transferRecord);
  transferRecord.action(
    (ref: string, opts: CommonOpts & { customer: string; amount: string; date?: string; reason?: string }) =>
      run(async () => {
        const { dryRun, reason } = gateMutation(transferRecord, opts as unknown as Record<string, unknown>);
        if (!reason?.trim() && !dryRun) throw usageError({ key: 'receipt.transfer.reason_required' });
        const ctx = await writeEntityOf(opts);
        const p = deps.palette;
        // Resolved once, so the preview and the write cannot disagree at midnight.
        const date = opts.date ?? (await hoy(ctx));
        const source = await getCustomerPayment(ctx.entityId, ref);
        const target = await resolveCustomer(ctx.entityId, opts.customer);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const args = { customerId: String(target.id), amount: opts.amount, date, reason: reason?.trim() ?? '' };
        // The key is the input, never the balance it changes: a retry after the transfer finds 0.00 on account.
        const payloadHash = hashDeCarga(source.id, args.customerId, date, cargaDelOperador(opts as unknown as Record<string, unknown>));
        const key = { scope: TRANSFER_KEY_SCOPE, clave: opts.idempotencyKey, payloadHash };
        if (opts.idempotencyKey && !dryRun) {
          const recorded = await mirarLlave<{ transfer: CustomerCreditTransfer }>({ tenantId: ctx.tenantId }, key);
          if (recorded) {
            process.stderr.write(p.yellow(`${idempotencyHitNote(opts.idempotencyKey, recorded.transfer.transferNumber)}\n`));
            printTransfer(recorded.transfer, p, false, opts.json === true);
            return;
          }
        }

        const preview = await transferCustomerCredit(ctx.entityId, source.id, args, reviewer.userId, { dryRun: true });
        if (dryRun) {
          printTransfer(preview, p, true, opts.json === true);
          process.stderr.write(p.dim(`${t('ap.payment.dry_run')}\n`));
          return;
        }
        await confirmOrAbort(opts, t('receipt.transfer.confirm', {
          amount: preview.amount, source: preview.sourceNumber, from: preview.fromCustomer, to: preview.toCustomer,
          date: preview.date, entity: ctx.entityName,
        }));

        const act = await conLlave(
          { tenantId: ctx.tenantId, entityId: ctx.entityId }, key,
          async () => ({ transfer: await transferCustomerCredit(ctx.entityId, source.id, args, reviewer.userId) })
        );
        const result = act.resultado.transfer;
        if (act.repetido) {
          process.stderr.write(p.yellow(`${idempotencyHitNote(opts.idempotencyKey ?? '', result.transferNumber)}\n`));
        } else {
          attestEntryAsync(ctx.tenantId, result.attestation.entityId, result.attestation.entryId);
        }
        printTransfer(result, p, false, opts.json === true);
      })
  );
}

/** MNE-001-498 · A transfer as the dry run, the result and --json say it: the entry's lines and both balances. */
function printTransfer(r: CustomerCreditTransfer, p: Palette, rehearsal: boolean, json: boolean): void {
  if (json) {
    render([{
      transfer_number: rehearsal ? null : r.transferNumber,
      source: r.sourceNumber,
      from_customer: r.fromCustomer,
      to_customer: r.toCustomer,
      amount: r.amount,
      date: r.date,
      entry_number: rehearsal ? null : r.journalEntry.entry_number,
      source_on_account_before: r.sourceOnAccount.before,
      source_on_account_after: r.sourceOnAccount.after,
      customer_on_account_before: r.customerOnAccount.before,
      customer_on_account_after: r.customerOnAccount.after,
      advance_base: r.advance?.base ?? null,
      advance_iva: r.advance?.iva ?? null,
    }], { json: true });
    return;
  }
  const what = { amount: r.amount, source: r.sourceNumber, from: r.fromCustomer, to: r.toCustomer, date: r.date };
  process.stdout.write(
    rehearsal
      ? `${p.bold(t('receipt.transfer.would_transfer', what))}\n`
      : `${p.green('✔')} ${t('receipt.transfer.recorded', { ...what, number: r.transferNumber, entry: r.journalEntry.entry_number })}\n`
  );
  for (const l of r.lines) {
    process.stdout.write(p.dim(`  ${l.account.padEnd(8)} ${l.debit.padStart(14)} ${l.credit.padStart(14)}  ${l.description}\n`));
  }
  process.stdout.write(`  ${t('receipt.transfer.on_account', { party: r.sourceNumber, before: r.sourceOnAccount.before, after: r.sourceOnAccount.after })}\n`);
  process.stdout.write(`  ${t('receipt.transfer.on_account', { party: r.toCustomer, before: r.customerOnAccount.before, after: r.customerOnAccount.after })}\n`);
  if (r.advance) process.stdout.write(`  ${t('receipt.transfer.carries', r.advance)}\n`);
}

/** The cause a reversed receipt keeps, as the dry run, the confirmation and the result say it (MNE-001-509). */
function causeText(r: Pick<ResultadoReversa, 'cause' | 'causeDefaulted'>): string {
  if (r.cause === null) return t('receipt.reverse.cause.none');
  return r.causeDefaulted ? t('receipt.reverse.cause.defaulted') : t('receipt.reverse.cause.stated', { cause: r.cause });
}

function imprimirRegistro(
  result: ResultadoPago,
  p: Palette,
  etiqueta: string,
  remanente: Decimal,
  ensayo: boolean,
  json: boolean
): void {
  const doc = result.documentos[0];
  if (json) {
    render(
      [
        {
          payment_number: result.paymentNumber,
          document: doc?.numero ?? null,
          amount_due_before: doc?.saldoAnterior ?? null,
          amount_due_after: doc?.saldoNuevo ?? null,
          document_status: doc?.estado ?? null,
          on_account: remanente.greaterThan(0) ? remanente.toFixed(2) : null,
          advance_base: result.advance?.base ?? null,
          advance_tax_rate: result.advance?.treatment ?? null,
          advance_iva: result.advance?.iva ?? null,
          advance_tax_rate_from: result.advance?.from?.invoices ?? null,
          advance_tax_rate_assumed: result.advance?.from?.assumed ?? null,
          open_advance_invoices: result.advanceInvoices ?? null,
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
      ? p.bold(doc ? t('ap.payment.create.would_record', { before: doc.saldoAnterior, after: doc.saldoNuevo, bill: etiqueta }) : t('ar.receipt.record.would_record_advance'))
      : `${p.green('✔')} ${p.bold(result.paymentNumber)} · ${p.bold(etiqueta)}` +
        (doc ? p.dim(` ${doc.saldoAnterior} → ${doc.saldoNuevo} (${doc.estado})`) : '')) +
      (remanente.greaterThan(0) ? p.dim(` · ${t('ar.receipt.on_account', { amount: remanente.toFixed(2) })}`) : '') +
      (result.advance ? p.dim(` · ${t('receipt.advance.label')}: ${excessFigures(result.advance)}`) : '') +
      (result.journalEntry ? p.dim(` · ${t('ap.payment.entry', { entry: result.journalEntry.entry_number })}`) : '') +
      '\n'
  );
  if (result.journalEntry?.description?.includes('IVA')) {
    process.stderr.write(p.dim(`${result.journalEntry.description}\n`));
  }
}

/**
 * The customer's withholding a document carries (MNE-001-113), as a suffix:
 * it lands on 1145/1146 with the post, so it is shown before and after it.
 */
function withheldText(d: { withholdingIsr?: string; withholdingIva?: string }): string {
  const parts = [
    ['ISR', d.withholdingIsr],
    [t('ar.receipt.withheld.vat'), d.withholdingIva],
  ].filter(([, v]) => v !== undefined && new Decimal(v).greaterThan(0));
  return parts.length === 0 ? '' : `; ${t('ar.receipt.withheld', { parts: parts.map(([k, v]) => `${k} ${v}`).join(' + ') })}`;
}

/** MNE-001-422 · The advance's IVA a document's event cancels or restores, as a suffix; empty when none. */
function advanceText(d: { advanceIva?: string }, key: 'receipt.advance.iva_cancelled' | 'receipt.advance.iva_restored'): string {
  return d.advanceIva !== undefined && new Decimal(d.advanceIva).greaterThan(0) ? `; ${t(key, { iva: d.advanceIva })}` : '';
}

/**
 * MNE-001-422 · The warning for an advance's IVA that an earlier month's 2120 carried twice; null when none.
 * MNE-001-573 · With a cheque's cashing day, the earlier month is the PUE invoice's, which caused the IVA
 * that LIVA art. 1-B, second paragraph, puts on the cashing day.
 */
function advanceWarning(
  invoice: string, d: { advanceIva?: string; advanceIvaTwiceIn?: string | null; advanceIvaCashedOn?: string | null }, date: string
): string | null {
  if (!d.advanceIvaTwiceIn) return null;
  const iva = d.advanceIva ?? '0.00';
  if (d.advanceIvaCashedOn) {
    return t('receipt.advance.iva_before_cashing', { iva, invoice, month: d.advanceIvaTwiceIn, cashed: d.advanceIvaCashedOn });
  }
  return t('receipt.advance.iva_caused_twice', { iva, invoice, month: d.advanceIvaTwiceIn, date });
}

function imprimirAplicacion(
  documentos: {
    numero: string; saldoAnterior: string; saldoNuevo: string; estado: string;
    withholdingIsr?: string; withholdingIva?: string;
    advanceIva?: string; advanceIvaTwiceIn?: string | null; advanceIvaDeferred?: string; advanceIvaCashedOn?: string | null;
  }[],
  remanenteAnterior: string,
  remanenteNuevo: string,
  paymentNumber: string,
  p: Palette,
  ensayo: boolean,
  json: boolean,
  entryNumber: string | null,
  date: string
): void {
  if (json) {
    render(
      documentos.map((d) => ({
        payment_number: paymentNumber,
        date,
        invoice: d.numero,
        amount_due_before: d.saldoAnterior,
        amount_due_after: d.saldoNuevo,
        withholding_isr: d.withholdingIsr ?? '0.00',
        withholding_iva: d.withholdingIva ?? '0.00',
        advance_iva_cancelled: d.advanceIva ?? '0.00',
        advance_iva_deferred: d.advanceIvaDeferred ?? '0.00',
        warning: advanceWarning(d.numero, d, date),
        invoice_status: d.estado,
        on_account_before: remanenteAnterior,
        on_account_after: remanenteNuevo,
        journal_entry: entryNumber,
        dry_run: ensayo,
      })),
      { json: true }
    );
    return;
  }
  const prefijo = ensayo ? p.bold(t('ar.receipt.apply.would')) : `${p.green('✔')} ${t('ar.receipt.apply.applied', { payment: p.bold(paymentNumber) })}`;
  process.stdout.write(
    `${prefijo} ${documentos.map((d) => `${d.numero} ${d.saldoAnterior} → ${d.saldoNuevo} (${d.estado}${withheldText(d)}${advanceText(d, 'receipt.advance.iva_cancelled')})`).join(', ')} ` +
      p.dim(`· ${t('ap.payment.apply.on_account', { before: remanenteAnterior, after: remanenteNuevo, date })}`) +
      (entryNumber ? p.dim(` · ${t('ap.payment.entry', { entry: entryNumber })}`) : '') +
      '\n'
  );
}
