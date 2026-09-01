import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import Decimal from 'decimal.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { attestEntryAsync } from '../services/accounting/posting.js';
import { resolveInvoice } from '../services/ar/invoice-service.js';
import { resolveCustomer } from '../services/ar/customer-service.js';
import {
  recordCustomerPayment,
  applyCustomerPayment,
  unapplyCustomerPayment,
  reverseCustomerPayment,
  getCustomerPayment,
  listCustomerPayments,
  type EntradaPago,
  type ResultadoPago,
} from '../services/payments/payment-service.js';
import { InvoiceStatus } from '../types/index.js';
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
} from './kernel/index.js';

// ============================================================
// mnemosine receipt · cobro
//
// El dinero que entra, como HISTORIA y no como instantánea: registrar
// (con o sin remanente a cuenta), ver, listar, aplicar el saldo a cuenta,
// desaplicar (evento nuevo, jamás un DELETE) y reversar el cheque devuelto.
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
const COBRABLES = ['sent', 'viewed', 'partially_paid', 'overdue'] as const;

const MONEY = ['payment_amount', 'applied_amount', 'unapplied_amount', 'amount_applied'];

const hoy = (): string => new Date().toISOString().slice(0, 10);

export function registerReceiptCommand(program: Command, deps: ReceiptCommandDeps): void {
  const receipt = program
    .command('receipt')
    .alias('cobro')
    .description('Customer collections: record cash, apply on-account balance, unapply, and reverse bounced checks');

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

  /** `--invoice INV-2026-00042:2500` (repetible) o `--invoice <ref>` + --amount. */
  const parseAplicaciones = (
    invoiceSpecs: string[] | undefined,
    amount: string | undefined
  ): { ref: string; amount: string | null }[] => {
    const specs = invoiceSpecs ?? [];
    if (specs.length === 0) {
      throw usageError(
        'Indica la(s) factura(s): --invoice "INV-2026-00042:2500" (repetible), o --invoice <ref> --amount <n>.'
      );
    }
    return specs.map((spec) => {
      const i = spec.lastIndexOf(':');
      if (i > 0 && /^[\d.]+$/.test(spec.slice(i + 1))) {
        return { ref: spec.slice(0, i), amount: spec.slice(i + 1) };
      }
      if (specs.length > 1 || !amount) {
        throw usageError(
          `La factura "${spec}" no trae importe. Con varias facturas cada una lo lleva pegado ` +
            '("folio:importe"); con una sola puede ir en --amount.'
        );
      }
      return { ref: spec, amount };
    });
  };

  // ---- receipt record ----------------------------------------------
  const record = receipt
    .command('record')
    .alias('registrar')
    .argument('<invoice>', 'invoice number or id')
    .description('Record cash received against an invoice and recognize the IVA it was holding');
  record
    .requiredOption('--amount <amount>', 'amount, in the document currency')
    .option('--date <date>', 'value date (YYYY-MM-DD); defaults to today')
    .option('--method <method>', 'cash, check, ach, wire, spei, credit_card or other', 'spei')
    .option('--bank <account>', "bank account id; without it the entity's `banco` role is used")
    .option('--reference <text>', 'bank reference or transfer number')
    .option('--on-account', 'let the amount exceed the invoice due; the excess stays on account (anticipo)')
    .option('--json', 'JSON output');
  withContext(record);
  declareRisk(record, {
    risk: 'irreversible',
    agent: false,
    writes: 'customer_payments, payment_allocations, invoices.amount_due, journal_entries',
  });
  record.action(
    (
      ref: string,
      opts: CommonOpts & {
        amount: string; date?: string; method: string; bank?: string;
        reference?: string; onAccount?: boolean;
      }
    ) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const target = await resolveInvoice(ctx.entityId, ref);
        const p = deps.palette;

        if (!COBRABLES.includes(target.status as (typeof COBRABLES)[number])) {
          throw blockedByState(
            `${target.invoice_number} is "${target.status}". ` +
              (target.status === InvoiceStatus.PAID
                ? 'It is already settled.'
                : target.status === InvoiceStatus.DRAFT
                  ? 'Issue it first: an invoice has to be in the ledger before cash can be applied to it.'
                  : `Only ${COBRABLES.join(', ')} invoices can be collected.`)
          );
        }

        // Con --on-account el excedente sobre el saldo queda como anticipo;
        // sin la bandera, el servicio rechaza aplicar más de lo debido.
        const monto = new Decimal(opts.amount);
        const saldo = new Decimal(target.amount_due);
        const aplicar = opts.onAccount ? Decimal.min(monto, saldo) : monto;

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const entrada: EntradaPago = {
          entityId: ctx.entityId,
          counterpartyId: target.customer_id,
          paymentAmount: opts.amount,
          paymentDate: opts.date ?? hoy(),
          paymentMethod: opts.method,
          bankAccountId: opts.bank ?? null,
          referenceNumber: opts.reference ?? null,
          applications: aplicar.greaterThan(0)
            ? [{ documentId: target.id, amountApplied: aplicar.toFixed(2) }]
            : [],
          onAccount: opts.onAccount === true,
        };

        const previo = await recordCustomerPayment(entrada, reviewer.userId, { dryRun: true });
        const doc = previo.documentos[0];
        const remanente = monto.minus(aplicar);

        if (opts.dryRun) {
          imprimirRegistro(previo, p, target.invoice_number, remanente, true, opts.json === true);
          process.stderr.write(p.dim('Dry run: nothing was written.\n'));
          return;
        }

        await confirmOrAbort(
          opts,
          `Record ${opts.amount} ${target.currency_code} collected on ${target.invoice_number}` +
            (doc ? ` (${doc.saldoAnterior} → ${doc.saldoNuevo})` : '') +
            (remanente.greaterThan(0) ? ` with ${remanente.toFixed(2)} left on account` : '') +
            ` in ${ctx.entityName}? This posts to the ledger.`
        );

        const result = await recordCustomerPayment(entrada, reviewer.userId);
        if (result.attestation) {
          attestEntryAsync(ctx.tenantId, result.attestation.entityId, result.attestation.entryId);
        }
        imprimirRegistro(result, p, target.invoice_number, remanente, false, opts.json === true);
      })
  );

  // ---- receipt show ------------------------------------------------
  const show = receipt
    .command('show')
    .alias('ver')
    .argument('<ref>', 'payment number (PMT-2026-00042) or id')
    .description('Show one collection: its applications (live and history), REP status and ledger entry');
  withOutput(withContext(show));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const cobro = await getCustomerPayment(ctx.entityId, ref);
      const p = deps.palette;

      if (opts.json || opts.output || opts.format) {
        render([cobro as unknown as Record<string, unknown>], {
          ...opts, idField: 'payment_number', numeric: MONEY,
        });
        return;
      }

      const out = process.stdout;
      out.write(
        `\n${p.bold(cobro.payment_number)} ${p.dim(cobro.status)}  ${cobro.customer_name ?? ''}\n`
      );
      const fact = (label: string, value: string | number | null | undefined) => {
        if (value === null || value === undefined || value === '') return;
        out.write(`  ${p.dim(label.padEnd(18))}${String(value)}\n`);
      };
      fact('Date', cobro.payment_date instanceof Date ? cobro.payment_date.toISOString().slice(0, 10) : cobro.payment_date);
      fact('Amount', `${cobro.payment_amount} ${cobro.currency_code}`);
      fact('Method', cobro.payment_method);
      fact('Reference', cobro.reference_number);
      fact('On account', cobro.unapplied_amount !== '0.00' ? cobro.unapplied_amount : null);
      fact('Ledger entry', cobro.journal_entry_number);
      fact(
        'REP',
        cobro.cfdi_uuid
          ? `${cobro.cfdi_uuid} (pago ${cobro.cfdi_pago_indice ?? '—'})`
          : p.yellow('sin REP — obligación fiscal propia con plazo del SAT')
      );
      if (cobro.reversed_at) {
        fact('Reversed', p.yellow(new Date(cobro.reversed_at).toISOString()));
      }

      out.write(`\n${p.bold('Applications')} ${p.dim(`(${cobro.aplicaciones.length})`)}\n`);
      if (cobro.aplicaciones.length) {
        render(
          cobro.aplicaciones.map((a) => ({
            invoice: a.invoice_number,
            applied: a.amount_applied,
            iva_released: a.iva_reclass_amount ?? '',
            live: a.viva ? 'yes' : 'no',
            unapplied_reason: a.unapply_reason ?? '',
          })),
          { format: 'table', numeric: ['applied', 'iva_released'] }
        );
      }
      out.write('\n');
    })
  );

  // ---- receipt list ------------------------------------------------
  const list = receipt
    .command('list')
    .alias('listar')
    .description('List collections by customer, date, application state or missing REP');
  withOutput(withSelection(withTime(withContext(list))));
  list
    .option('--customer <ref>', 'only this customer (number, name or id)')
    .option('--unapplied', 'only collections with an on-account remainder')
    .option('--needs-rep', 'only completed collections with no REP linked');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action(
    (opts: CommonOpts & { customer?: string; unapplied?: boolean; needsRep?: boolean }) =>
      run(async () => {
        const ctx = await entityOf(opts);
        if (opts.status?.length) {
          throw usageError(
            'Filter collections with --unapplied or --needs-rep: the status column follows the money, not a workflow.'
          );
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
            payment_date: r.payment_date instanceof Date ? r.payment_date.toISOString().slice(0, 10) : r.payment_date,
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
    .alias('aplicar')
    .argument('<ref>', 'payment number or id')
    .description('Apply the on-account balance of a collection to one or more invoices (releases PPD IVA)');
  withContext(apply);
  apply
    .option('--invoice <spec...>', 'invoice with amount: "INV-2026-00042:2500" (repeatable), or a bare ref with --amount')
    .option('--amount <amount>', 'amount for a single --invoice without an inline amount')
    .option('--json', 'JSON output');
  declareRisk(apply, {
    risk: 'irreversible',
    agent: false,
    writes: 'payment_allocations, invoices.amount_due, journal_entries',
  });
  apply.action(
    (ref: string, opts: CommonOpts & { invoice?: string[]; amount?: string }) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const { dryRun } = gateMutation(apply, opts as Record<string, unknown>);
        const p = deps.palette;
        const pares = parseAplicaciones(opts.invoice, opts.amount);

        const cobro = await getCustomerPayment(ctx.entityId, ref);
        const aplicaciones = [];
        for (const par of pares) {
          const factura = await resolveInvoice(ctx.entityId, par.ref);
          aplicaciones.push({ documentId: factura.id, amountApplied: new Decimal(par.amount as string).toFixed(2) });
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const previo = await applyCustomerPayment(ctx.entityId, cobro.id, aplicaciones, reviewer.userId, { dryRun: true });

        if (dryRun) {
          imprimirAplicacion(previo.documentos, previo.remanenteAnterior, previo.remanenteNuevo, cobro.payment_number, p, true, opts.json === true, previo.journalEntry?.entry_number ?? null);
          process.stderr.write(p.dim('Dry run: nothing was written.\n'));
          return;
        }

        await confirmOrAbort(
          opts,
          `Apply ${previo.documentos.map((d) => `${d.numero} (${d.saldoAnterior} → ${d.saldoNuevo})`).join(', ')} ` +
            `from ${cobro.payment_number} (on account ${previo.remanenteAnterior} → ${previo.remanenteNuevo}) ` +
            `in ${ctx.entityName}? This posts to the ledger.`
        );

        const result = await applyCustomerPayment(ctx.entityId, cobro.id, aplicaciones, reviewer.userId);
        if (result.attestation) {
          attestEntryAsync(ctx.tenantId, result.attestation.entityId, result.attestation.entryId);
        }
        imprimirAplicacion(result.documentos, result.remanenteAnterior, result.remanenteNuevo, cobro.payment_number, p, false, opts.json === true, result.journalEntry?.entry_number ?? null);
      })
  );

  // ---- receipt unapply ---------------------------------------------
  const unapply = receipt
    .command('unapply')
    .alias('desaplicar')
    .argument('<ref>', 'payment number or id')
    .description('Unapply a collection from an invoice as a NEW event: reopens it and re-parks the PPD IVA');
  withContext(unapply);
  unapply
    .requiredOption('--invoice <ref>', 'the invoice to unapply from')
    .requiredOption('--reason <text>', 'why: it lands in the audit trail and the ledger description')
    .option('--json', 'JSON output');
  declareRisk(unapply, {
    risk: 'irreversible',
    agent: false,
    writes: 'payment_allocations (closure), invoices.amount_due, journal_entries',
  });
  unapply.action(
    (ref: string, opts: CommonOpts & { invoice: string; reason: string }) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const { dryRun } = gateMutation(unapply, opts as unknown as Record<string, unknown>);
        const p = deps.palette;

        const cobro = await getCustomerPayment(ctx.entityId, ref);
        const factura = await resolveInvoice(ctx.entityId, opts.invoice);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const previo = await unapplyCustomerPayment(
          ctx.entityId, cobro.id,
          { invoiceId: factura.id, reason: opts.reason },
          reviewer.userId, { dryRun: true }
        );

        if (dryRun) {
          process.stdout.write(
            `${p.bold(`Would unapply ${previo.desaplicado} from ${previo.documento.numero}`)} ` +
              p.dim(`(${previo.documento.saldoAnterior} → ${previo.documento.saldoNuevo}, back on account)`) +
              (new Decimal(previo.ivaReAparcado).greaterThan(0)
                ? p.dim(` · IVA re-parked ${previo.ivaReAparcado}${previo.ivaEstimado ? ' (pro-rata estimate)' : ''}`)
                : '') + '\n'
          );
          process.stderr.write(p.dim('Dry run: nothing was written.\n'));
          return;
        }

        await confirmOrAbort(
          opts,
          `Unapply ${previo.desaplicado} of ${cobro.payment_number} from ${previo.documento.numero} ` +
            `(${previo.documento.saldoAnterior} → ${previo.documento.saldoNuevo})? ` +
            'The cash stays on account; the invoice reopens.'
        );

        const result = await unapplyCustomerPayment(
          ctx.entityId, cobro.id,
          { invoiceId: factura.id, reason: opts.reason },
          reviewer.userId
        );
        attestEntryAsync(ctx.tenantId, result.attestation.entityId, result.attestation.entryId);

        if (opts.json) {
          render([{
            payment_number: result.paymentNumber,
            invoice: result.documento.numero,
            unapplied: result.desaplicado,
            iva_reparked: result.ivaReAparcado,
            entry_number: result.journalEntry.entry_number,
          }], { json: true });
          return;
        }
        process.stdout.write(
          `${p.green('✔')} ${p.bold(result.paymentNumber)} unapplied from ${p.bold(result.documento.numero)} ` +
            p.dim(`${result.documento.saldoAnterior} → ${result.documento.saldoNuevo} · entry ${result.journalEntry.entry_number}`) +
            (new Decimal(result.ivaReAparcado).greaterThan(0)
              ? p.dim(` · IVA re-parked ${result.ivaReAparcado}${result.ivaEstimado ? ' (pro-rata estimate)' : ''}`)
              : '') + '\n'
        );
      })
  );

  // ---- receipt reverse ---------------------------------------------
  const reverse = receipt
    .command('reverse')
    .alias('reversar')
    .argument('<ref>', 'payment number or id')
    .description('Reverse a bounced collection (NSF): mirrors every entry, reopens invoices, re-parks IVA');
  withContext(reverse);
  reverse
    .option('--fee <amount>', 'bank fee charged for the return (not yet supported: needs a fee role account)')
    .option('--json', 'JSON output');
  declareRisk(reverse, {
    risk: 'irreversible',
    agent: false,
    writes: 'customer_payments.status, payment_allocations (closure), invoices, reversing journal_entries',
  });
  reverse.action(
    (ref: string, opts: CommonOpts & { fee?: string }) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const { dryRun, reason } = gateMutation(reverse, opts as Record<string, unknown>);
        const p = deps.palette;

        const cobro = await getCustomerPayment(ctx.entityId, ref);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const previo = await reverseCustomerPayment(
          ctx.entityId, cobro.id,
          { reason: reason as string, feeAmount: opts.fee },
          reviewer.userId, { dryRun: true }
        );

        if (dryRun) {
          process.stdout.write(
            `${p.bold(`Would reverse ${cobro.payment_number}`)} ${p.dim(
              `· ${previo.reversals.length} entry(ies) mirrored, ${previo.documentosReabiertos.length} invoice(s) reopened`
            )}\n`
          );
          for (const d of previo.documentosReabiertos) {
            process.stdout.write(p.dim(`  ${d.numero} ${d.saldoAnterior} → ${d.saldoNuevo} (${d.estado})\n`));
          }
          process.stderr.write(p.dim('Dry run: nothing was written.\n'));
          return;
        }

        await confirmOrAbort(
          opts,
          `Reverse ${cobro.payment_number} (${cobro.payment_amount} ${cobro.currency_code}, NSF)? ` +
            `${previo.reversals.length} ledger entry(ies) get a mirror and ` +
            `${previo.documentosReabiertos.length} invoice(s) reopen.`
        );

        const result = await reverseCustomerPayment(
          ctx.entityId, cobro.id,
          { reason: reason as string, feeAmount: opts.fee },
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
          }], { json: true });
          return;
        }
        process.stdout.write(
          `${p.green('✔')} ${p.bold(result.paymentNumber)} reversed ` +
            p.dim(
              `· ${result.reversals.map((r) => `${r.of}→${r.entryNumber}`).join(', ')} · ` +
                `${result.documentosReabiertos.length} invoice(s) reopened\n`
            )
        );
      })
  );
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
      ? `${p.bold(`Would record ${doc ? `${doc.saldoAnterior} → ${doc.saldoNuevo} on ${etiqueta}` : `an advance on account`}`)}`
      : `${p.green('✔')} ${p.bold(result.paymentNumber)} · ${p.bold(etiqueta)}` +
        (doc ? p.dim(` ${doc.saldoAnterior} → ${doc.saldoNuevo} (${doc.estado})`) : '')) +
      (remanente.greaterThan(0) ? p.dim(` · ${remanente.toFixed(2)} on account`) : '') +
      (result.journalEntry ? p.dim(` · entry ${result.journalEntry.entry_number}`) : '') +
      '\n'
  );
  if (result.journalEntry?.description?.includes('IVA')) {
    process.stderr.write(p.dim(`${result.journalEntry.description}\n`));
  }
}

function imprimirAplicacion(
  documentos: { numero: string; saldoAnterior: string; saldoNuevo: string; estado: string }[],
  remanenteAnterior: string,
  remanenteNuevo: string,
  paymentNumber: string,
  p: Palette,
  ensayo: boolean,
  json: boolean,
  entryNumber: string | null
): void {
  if (json) {
    render(
      documentos.map((d) => ({
        payment_number: paymentNumber,
        invoice: d.numero,
        amount_due_before: d.saldoAnterior,
        amount_due_after: d.saldoNuevo,
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
  const prefijo = ensayo ? p.bold('Would apply') : `${p.green('✔')} ${p.bold(paymentNumber)} applied`;
  process.stdout.write(
    `${prefijo} ${documentos.map((d) => `${d.numero} ${d.saldoAnterior} → ${d.saldoNuevo} (${d.estado})`).join(', ')} ` +
      p.dim(`· on account ${remanenteAnterior} → ${remanenteNuevo}`) +
      (entryNumber ? p.dim(` · entry ${entryNumber}`) : '') +
      '\n'
  );
}
