import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import Decimal from 'decimal.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { attestEntryAsync } from '../services/accounting/posting.js';
import { resolveInvoice } from '../services/ar/invoice-service.js';
import { resolveCustomer, customerLabel } from '../services/ar/customer-service.js';
import {
  createCreditNote,
  getCreditNote,
  listCreditNotes,
  issueCreditNote,
  applyCreditNote,
  resolveCreditNote,
} from '../services/ar/credit-note-service.js';
import { CREDIT_NOTE_TYPES, CREDIT_NOTE_STATUSES } from '../database/enums.js';
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
  dateOnly as day,
} from './kernel/index.js';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';

// ============================================================
// mnemosine credit-note · nota-credito
//
// Devolver, descontar y corregir: la mitad del ciclo de cobro que faltaba.
// La nota nace en borrador con folio propio (CN), se POSTEA AL EMITIR
// (DR devoluciones + DR IVA / CR CxC — el plan de póliza del tipo E) y se
// APLICA a facturas sin asiento adicional. Emitida y sin aplicar ES el
// saldo a favor del cliente.
//
// NO TIMBRA: el CFDI de egreso es del timbrado (§5), igual que en la
// factura. Y la liga fiscal manda: una nota ligada sólo se aplica a su
// factura, y una suelta no se aplica a una PPD — el servicio lo explica
// cuando se intenta.
// ============================================================

export interface CreditNoteCommandDeps {
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

const MONEY = ['total_amount', 'subtotal', 'tax_amount', 'amount_applied', 'amount_available'];


// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// `--amount` es el SUBTOTAL del crédito y `--tax` su IVA: son dos importes,
// no uno con impuesto incluido. Ligar la nota a su factura con `--invoice` es
// lo que decide el lado fiscal; `--relates-to` es para cuando la factura
// original no vive en el sistema y sólo se tiene el UUID del CFDI.
// Prosa en inglés (idioma del nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = {
  create: `
Examples:
  # A return tied to its invoice: the link is what drives the IVA side.
  mnemosine credit-note create --type devolucion --invoice INV-2026-00042 --amount 5000.00 --tax 800.00 --memo "Devolucion de 4 piezas"
  # A discount when the original invoice is not in the system, only its CFDI.
  mnemosine credit-note create --type descuento --customer "Grupo Alameda" --amount 2500.00 --tax 400.00 --relates-to 3F2504E0-4F89-11D3-9A0C-0305E82C3301
`,
  show: `
Examples:
  # One note with its applications, its available balance and its ledger entry.
  mnemosine credit-note show CN-2026-00007
  # As JSON, for a script that reads the balance left to apply.
  mnemosine credit-note show CN-2026-00007 --json
`,
  list: `
Examples:
  # Issued notes with credit left to apply — the live customer credit.
  mnemosine credit-note list --open
  # Returns only, for one customer.
  mnemosine credit-note list --type devolucion --customer "Grupo Alameda"
`,
  issue: `
Examples:
  # Post DR returns + DR IVA / CR receivable. It does not stamp.
  mnemosine credit-note issue CN-2026-00007
  # See the entry it would post, writing nothing.
  mnemosine credit-note issue CN-2026-00007 --dry-run
`,
  apply: `
Examples:
  # Apply an issued note to one invoice; what is left stays as customer credit.
  mnemosine credit-note apply CN-2026-00007 --invoice "INV-2026-00042:5800.00"
  # Two invoices at once, run for real and rolled back, to check the arithmetic.
  mnemosine credit-note apply CN-2026-00007 --invoice "INV-2026-00042:3000.00" --invoice "INV-2026-00051:2800.00" --dry-run
`,
} as const;

export function registerCreditNoteCommand(program: Command, deps: CreditNoteCommandDeps): void {
  const creditNote = program
    .command('credit-note')
    .alias('nota-credito')
    .description('Credit notes: returns, discounts and corrections against the receivable (never stamped here)');

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

  // ---- credit-note create ------------------------------------------
  const create = creditNote
    .command('create')
    .alias('crear')
    .description('Create a DRAFT credit note, linked to its invoice (fiscal tie) or standalone with an explicit customer');
  withContext(create);
  create
    .requiredOption('--type <type>', `one of: ${CREDIT_NOTE_TYPES.join(', ')}`)
    .requiredOption('--amount <amount>', 'subtotal of the credit, before tax')
    .option('--tax <amount>', 'tax (IVA) portion of the credit', '0')
    .option('--invoice <ref>', 'the invoice this note credits (recommended: it drives the IVA side)')
    .option('--customer <ref>', 'customer, when there is no linked invoice')
    .option('--relates-to <uuid>', 'UUID of the original CFDI, when the invoice is not in the system')
    .option('--date <date>', 'credit date (YYYY-MM-DD); defaults to today')
    .option('--memo <text>', 'memo')
    .option('--json', 'JSON output');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'credit_notes (draft)' });
  create.addHelpText('after', EJEMPLOS.create);
  create.action(
    (
      opts: CommonOpts & {
        type: string; amount: string; tax?: string; invoice?: string;
        customer?: string; relatesTo?: string; date?: string; memo?: string;
      }
    ) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        if (!opts.invoice && !opts.customer) {
          throw usageError(
            'A credit note needs its target: --invoice <ref> (recommended: the fiscal tie drives the IVA) ' +
              'or --customer <ref> for a standalone note.'
          );
        }
        const factura = opts.invoice ? await resolveInvoice(ctx.entityId, opts.invoice) : null;
        const cliente = opts.customer ? await resolveCustomer(ctx.entityId, opts.customer) : null;

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const nota = await createCreditNote(
          {
            entity_id: ctx.entityId,
            customer_id: cliente ? String(cliente.id) : undefined,
            invoice_id: factura?.id ?? null,
            relates_to_uuid: opts.relatesTo ?? null,
            type: opts.type,
            credit_date: opts.date,
            subtotal: opts.amount,
            tax_amount: opts.tax,
            reason: opts.reason ?? null,
            memo: opts.memo ?? null,
          },
          reviewer.userId
        );

        if (opts.json) {
          render([nota as unknown as Record<string, unknown>], { json: true });
          return;
        }
        const p = deps.palette;
        process.stdout.write(
          `${p.green('✔')} ${p.bold(nota.credit_note_number)} drafted ` +
            `${p.dim(`(${nota.type}, ${nota.total_amount} ${nota.currency_code}` +
              (factura ? `, credits ${factura.invoice_number}` : cliente ? `, ${customerLabel(cliente)}` : '') + ')')}\n` +
            p.dim('  Nothing was posted. Post it with `credit-note issue`, then `credit-note apply`.\n')
        );
      })
  );

  // ---- credit-note show --------------------------------------------
  const show = creditNote
    .command('show')
    .alias('ver')
    .argument('<ref>', 'credit note number (CN-2026-00042) or id')
    .description('Show one credit note with its applications, available balance and ledger entry');
  withOutput(withContext(show));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.show);
  show.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const nota = await getCreditNote(ctx.entityId, ref);
      const p = deps.palette;

      if (opts.json || opts.output || opts.format) {
        render([nota as unknown as Record<string, unknown>], {
          ...opts, idField: 'credit_note_number', numeric: MONEY,
        });
        return;
      }
      const out = process.stdout;
      out.write(`\n${p.bold(nota.credit_note_number)} ${p.dim(nota.status)}  ${nota.customer_name ?? ''}\n`);
      const fact = (label: string, value: string | number | null | undefined) => {
        if (value === null || value === undefined || value === '') return;
        out.write(`  ${p.dim(label.padEnd(18))}${String(value)}\n`);
      };
      fact('Type', nota.type);
      fact('Date', day(nota.credit_date));
      fact('Credits invoice', nota.invoice_number);
      fact('Relates to CFDI', nota.relates_to_uuid);
      fact('Subtotal', nota.subtotal);
      fact('Tax', nota.tax_amount);
      fact('Total', `${nota.total_amount} ${nota.currency_code}`);
      fact('Applied', nota.amount_applied);
      fact('Available', nota.amount_available);
      fact('Reason', nota.reason);
      fact(
        'Ledger entry',
        nota.journal_entry_number ?? p.dim('not posted — run `credit-note issue`')
      );
      out.write(`\n${p.bold('Applications')} ${p.dim(`(${nota.aplicaciones.length})`)}\n`);
      if (nota.aplicaciones.length) {
        render(
          nota.aplicaciones.map((a) => ({
            invoice: a.invoice_number,
            applied: a.amount_applied,
            date: day(a.created_at),
          })),
          { format: 'table', numeric: ['applied'] }
        );
      }
      out.write('\n');
    })
  );

  // ---- credit-note list --------------------------------------------
  const list = creditNote
    .command('list')
    .alias('listar')
    .description('List credit notes by customer, type, state or unapplied balance');
  withOutput(withSelection(withTime(withContext(list))));
  list
    .option('--customer <ref>', 'only this customer (number, name or id)')
    .option('--type <type>', `only this type: ${CREDIT_NOTE_TYPES.join(', ')}`)
    .option('--open', 'only issued notes with balance left to apply (the live customer credit)');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.list);
  list.action(
    (opts: CommonOpts & { customer?: string; type?: string; open?: boolean }) =>
      run(async () => {
        const ctx = await entityOf(opts);
        for (const state of opts.status ?? []) {
          if (!(CREDIT_NOTE_STATUSES as readonly string[]).includes(state)) {
            throw usageError(`Unknown --status "${state}". Use one of: ${CREDIT_NOTE_STATUSES.join(', ')}.`);
          }
        }
        const customerId = opts.customer
          ? String((await resolveCustomer(ctx.entityId, opts.customer)).id)
          : undefined;
        const { rows, total } = await listCreditNotes(ctx.entityId, {
          customerId,
          status: opts.status?.[0],
          type: opts.type,
          open: opts.open,
          limit: opts.all ? 500 : (opts.limit ?? 50),
          offset: opts.offset,
        });
        render(
          rows.map((r) => ({
            credit_note_number: r.credit_note_number,
            credit_date: day(r.credit_date),
            customer_name: r.customer_name ?? '',
            invoice_number: r.invoice_number ?? '',
            type: r.type,
            total_amount: r.total_amount,
            amount_available: r.amount_available,
            currency_code: r.currency_code,
            status: r.status,
            id: r.id,
          })),
          {
            ...opts,
            total,
            idField: 'credit_note_number',
            numeric: MONEY,
            fields:
              opts.fields ??
              'credit_note_number,credit_date,customer_name,invoice_number,type,total_amount,amount_available,status',
          }
        );
      })
  );

  // ---- credit-note issue -------------------------------------------
  const issue = creditNote
    .command('issue')
    .alias('emitir')
    .argument('<ref>', 'credit note number or id')
    .description('Issue the note: post DR returns + DR VAT / CR receivable. Does not stamp');
  withContext(issue);
  issue.option('--json', 'JSON output');
  declareRisk(issue, {
    risk: 'irreversible',
    writes: 'journal_entries + account_balances + credit_notes.status',
  });
  issue.addHelpText('after', EJEMPLOS.issue);
  issue.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await writeEntityOf(opts);
      const nota = await resolveCreditNote(ctx.entityId, ref);
      const { dryRun } = gateMutation(issue, opts as Record<string, unknown>);
      const p = deps.palette;

      if (nota.status !== 'draft') {
        throw blockedByState(
          `${nota.credit_note_number} is "${nota.status}"` +
            (nota.journal_entry_id ? ' and already in the ledger.' : ' and can no longer be issued.')
        );
      }

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      if (!dryRun) {
        await confirmOrAbort(
          opts,
          `Post ${nota.credit_note_number} (${new Decimal(nota.total_amount).toFixed(2)} ${nota.currency_code} ` +
            `against the receivable) to the ledger? This cannot be undone.`
        );
      }

      const result = await issueCreditNote(ctx.entityId, nota.id, reviewer.userId, { dryRun });
      if (result.attestation && !dryRun) {
        attestEntryAsync(ctx.tenantId, result.attestation.entityId, result.attestation.entryId);
      }

      if (opts.json) {
        render([{
          credit_note_number: result.creditNoteNumber,
          entry_number: result.journalEntry?.entry_number ?? null,
          already_posted: result.alreadyPosted,
          dry_run: result.dryRun,
        }], { json: true });
        return;
      }
      process.stdout.write(
        (dryRun
          ? `${p.bold(`Would post ${result.creditNoteNumber}`)} ${p.dim(`as ${result.journalEntry?.entry_number ?? 'no entry'}`)}`
          : `${p.green('✔')} ${p.bold(result.creditNoteNumber)} issued as ${result.journalEntry?.entry_number ?? '(no entry)'}`) +
          p.dim(
            dryRun
              ? ' · nothing was written.\n'
              : ' · the note is now the customer\'s credit; apply it with `credit-note apply`.\n'
          )
      );
    })
  );

  // ---- credit-note apply -------------------------------------------
  const apply = creditNote
    .command('apply')
    .alias('aplicar')
    .argument('<ref>', 'credit note number or id')
    .description('Apply an issued note to invoices; what is not applied stays as customer credit');
  withContext(apply);
  apply
    .option('--invoice <spec...>', 'invoice with amount: "INV-2026-00042:2500" (repeatable), or a bare ref with --amount')
    .option('--amount <amount>', 'amount for a single --invoice without an inline amount')
    .option('--dry-run', 'run the real path and roll back')
    .option('--json', 'JSON output');
  declareRisk(apply, {
    risk: 'escritura',
    agent: false,
    writes: 'credit_note_applications + invoices.amount_due (no new ledger entry: it posted at issue)',
  });
  apply.addHelpText('after', EJEMPLOS.apply);
  apply.action(
    (ref: string, opts: CommonOpts & { invoice?: string[]; amount?: string }) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const p = deps.palette;
        const specs = opts.invoice ?? [];
        if (specs.length === 0) {
          throw usageError(
            'Say which invoice(s): --invoice "INV-2026-00042:2500" (repeatable), or --invoice <ref> --amount <n>. ' +
              'An issued note with nothing applied already IS the customer\'s credit — no command needed for that.'
          );
        }
        const pares = specs.map((spec) => {
          const i = spec.lastIndexOf(':');
          if (i > 0 && /^[\d.]+$/.test(spec.slice(i + 1))) {
            return { ref: spec.slice(0, i), amount: spec.slice(i + 1) };
          }
          if (specs.length > 1 || !opts.amount) {
            throw usageError(
              `The invoice "${spec}" has no amount. With several invoices each carries its own ` +
                '("folio:amount"); with one it can go in --amount.'
            );
          }
          return { ref: spec, amount: opts.amount };
        });

        const nota = await resolveCreditNote(ctx.entityId, ref);
        const aplicaciones = [];
        for (const par of pares) {
          const factura = await resolveInvoice(ctx.entityId, par.ref);
          aplicaciones.push({ invoiceId: factura.id, amount: new Decimal(par.amount).toFixed(2) });
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const previo = await applyCreditNote(ctx.entityId, nota.id, aplicaciones, reviewer.userId, { dryRun: true });

        if (opts.dryRun) {
          process.stdout.write(
            `${p.bold(`Would apply ${nota.credit_note_number}`)}: ` +
              previo.documentos.map((d) => `${d.numero} ${d.saldoAnterior} → ${d.saldoNuevo}`).join(', ') +
              p.dim(` · available ${previo.disponibleAnterior} → ${previo.disponibleNuevo}\n`)
          );
          process.stderr.write(p.dim('Dry run: nothing was written.\n'));
          return;
        }

        await confirmOrAbort(
          opts,
          `Apply ${nota.credit_note_number} to ${previo.documentos
            .map((d) => `${d.numero} (${d.saldoAnterior} → ${d.saldoNuevo})`)
            .join(', ')} in ${ctx.entityName}?`
        );

        const result = await applyCreditNote(ctx.entityId, nota.id, aplicaciones, reviewer.userId);

        if (opts.json) {
          render(
            result.documentos.map((d) => ({
              credit_note_number: result.creditNoteNumber,
              invoice: d.numero,
              amount_due_before: d.saldoAnterior,
              amount_due_after: d.saldoNuevo,
              invoice_status: d.estado,
              available_after: result.disponibleNuevo,
              note_status: result.notaStatus,
            })),
            { json: true }
          );
          return;
        }
        process.stdout.write(
          `${p.green('✔')} ${p.bold(result.creditNoteNumber)} applied: ` +
            result.documentos.map((d) => `${d.numero} ${d.saldoAnterior} → ${d.saldoNuevo} (${d.estado})`).join(', ') +
            p.dim(` · available ${result.disponibleNuevo} · note ${result.notaStatus}\n`)
        );
      })
  );
}
