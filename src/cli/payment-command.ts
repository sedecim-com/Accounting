import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import { BillStatus, InvoiceStatus } from '../types/index.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { attestEntryAsync } from '../services/accounting/posting.js';
import { resolveBill } from '../services/ap/bill-service.js';
import {
  recordVendorPayment,
  type EntradaPago,
  type ResultadoPago,
} from '../services/payments/payment-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  requireExplicitEntity,
  blockedByState,
  abortedByUser,
  exitCodeFor,
} from './kernel/index.js';

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

/** Un gasto se paga cuando su pasivo ya está en el mayor. */
const PAGABLES = ['approved', 'posted', 'partially_paid'] as const;
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
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') throw abortedByUser();
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

}

const hoy = (): string => new Date().toISOString().slice(0, 10);

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
