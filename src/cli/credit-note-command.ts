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
  optionByKey,
  argumentByKey,
  describeCommand,
} from './kernel/index.js';
import { confirmarConReintento, yesNoPrompt } from './kernel/confirmacion.js';
import { t } from '../i18n/index.js';

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
  const creditNote = describeCommand(program.command('credit-note').alias('nota-credito'), 'help.credit_note.description');
  // `create --type` and `list --type` name the types as a message parameter.
  const types = CREDIT_NOTE_TYPES.join(', ');

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

  // ---- credit-note create ------------------------------------------
  const create = describeCommand(creditNote.command('create').alias('crear'), 'help.credit_note.create.description');
  withContext(create);
  optionByKey(create, '--type <type>', 'help.credit_note.create.option.type', { params: { types }, mandatory: true });
  optionByKey(create, '--amount <amount>', 'help.credit_note.create.option.amount', { mandatory: true });
  optionByKey(create, '--tax <amount>', 'help.credit_note.create.option.tax', { defaultValue: '0' });
  optionByKey(create, '--invoice <ref>', 'help.credit_note.create.option.invoice');
  optionByKey(create, '--customer <ref>', 'help.credit_note.create.option.customer');
  optionByKey(create, '--relates-to <uuid>', 'help.credit_note.create.option.relates_to');
  optionByKey(create, '--date <date>', 'help.credit_note.create.option.date');
  optionByKey(create, '--memo <text>', 'help.credit_note.create.option.memo');
  optionByKey(create, '--json', 'help.credit_note.create.option.json');
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
          throw usageError({ key: 'ar.credit_note.create.target_missing' });
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
          `${p.green('✔')} ${t('ar.credit_note.create.drafted', { number: p.bold(nota.credit_note_number) })} ` +
            `${p.dim(t('ar.credit_note.create.drafted_detail', { type: nota.type, amount: nota.total_amount, currency: nota.currency_code,
              target: factura ? 'invoice' : cliente ? 'customer' : 'none', invoice: factura?.invoice_number ?? '', customer: cliente ? customerLabel(cliente) : '' }))}\n` +
            p.dim(`  ${t('ar.credit_note.create.not_posted', { issue: 'credit-note issue', apply: 'credit-note apply' })}\n`)
        );
      })
  );

  // ---- credit-note show --------------------------------------------
  const show = describeCommand(creditNote.command('show').alias('ver'), 'help.credit_note.show.description');
  argumentByKey(show, '<ref>', 'help.credit_note.show.argument.ref');
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
      // Subtotal and Total read the same in Spanish; the labels pad to the longest (18 at least, the English width).
      const facts: Array<[string, string | number | null | undefined]> = [
        [t('ar.credit_note.show.type'), nota.type], [t('ar.receipt.show.date'), day(nota.credit_date)],
        [t('ar.credit_note.show.credits_invoice'), nota.invoice_number], [t('ar.credit_note.show.relates_to'), nota.relates_to_uuid],
        ['Subtotal', nota.subtotal], [t('ar.invoice.show.tax'), nota.tax_amount], ['Total', `${nota.total_amount} ${nota.currency_code}`],
        [t('ar.credit_note.show.applied'), nota.amount_applied], [t('ar.credit_note.show.available'), nota.amount_available], [t('ar.credit_note.show.reason'), nota.reason],
        [t('ar.invoice.show.ledger_entry'), nota.journal_entry_number ?? p.dim(t('ar.invoice.show.not_posted', { command: 'credit-note issue' }))],
      ];
      const width = Math.max(18, ...facts.map(([label]) => label.length + 1));
      for (const [label, value] of facts) {
        if (value === null || value === undefined || value === '') continue;
        out.write(`  ${p.dim(label.padEnd(width))}${String(value)}\n`);
      }
      out.write(`\n${p.bold(t('ar.receipt.show.applications'))} ${p.dim(`(${nota.aplicaciones.length})`)}\n`);
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
  const list = describeCommand(creditNote.command('list').alias('listar'), 'help.credit_note.list.description');
  withOutput(withSelection(withTime(withContext(list))));
  optionByKey(list, '--customer <ref>', 'help.credit_note.list.option.customer');
  optionByKey(list, '--type <type>', 'help.credit_note.list.option.type', { params: { types } });
  optionByKey(list, '--open', 'help.credit_note.list.option.open');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.list);
  list.action(
    (opts: CommonOpts & { customer?: string; type?: string; open?: boolean }) =>
      run(async () => {
        const ctx = await entityOf(opts);
        for (const state of opts.status ?? []) {
          if (!(CREDIT_NOTE_STATUSES as readonly string[]).includes(state)) {
            throw usageError({ key: 'ledger.period.status_unknown', params: { value: state, statuses: CREDIT_NOTE_STATUSES.join(', ') } });
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
  const issue = describeCommand(creditNote.command('issue').alias('emitir'), 'help.credit_note.issue.description');
  argumentByKey(issue, '<ref>', 'help.credit_note.issue.argument.ref');
  withContext(issue);
  optionByKey(issue, '--json', 'help.credit_note.issue.option.json');
  declareRisk(issue, {
    risk: 'irreversible',
    llave: { sinLlave: { key: 'ar.credit_note.retry_reissues' } },
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
        const params = { number: nota.credit_note_number, status: nota.status, posted: nota.journal_entry_id ? 'yes' : 'no' };
        throw blockedByState({ key: 'ar.credit_note.issue.not_draft', params });
      }

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      if (!dryRun) {
        await confirmOrAbort(
          opts,
          t('ar.credit_note.issue.confirm', { number: nota.credit_note_number, amount: new Decimal(nota.total_amount).toFixed(2), currency: nota.currency_code })
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
      const entryNumber = result.journalEntry?.entry_number;
      process.stdout.write(
        (dryRun
          ? `${p.bold(t('ar.invoice.issue.would_post', { number: result.creditNoteNumber }))} ` +
            p.dim(t('ar.invoice.issue.as_entry', { entry: entryNumber ?? t('ar.invoice.issue.no_entry') }))
          : `${p.green('✔')} ${t('ar.invoice.issue.issued', { number: p.bold(result.creditNoteNumber), entry: entryNumber ?? `(${t('ar.invoice.issue.no_entry')})` })}`) +
          p.dim(
            dryRun
              ? ` · ${t('ar.credit_note.issue.nothing_written')}\n`
              : ` · ${t('ar.credit_note.issue.now_credit', { command: 'credit-note apply' })}\n`
          )
      );
    })
  );

  // ---- credit-note apply -------------------------------------------
  const apply = describeCommand(creditNote.command('apply').alias('aplicar'), 'help.credit_note.apply.description');
  argumentByKey(apply, '<ref>', 'help.credit_note.apply.argument.ref');
  withContext(apply);
  optionByKey(apply, '--invoice <spec...>', 'help.credit_note.apply.option.invoice');
  optionByKey(apply, '--amount <amount>', 'help.credit_note.apply.option.amount');
  optionByKey(apply, '--dry-run', 'help.credit_note.apply.option.dry_run');
  optionByKey(apply, '--json', 'help.credit_note.apply.option.json');
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
          throw usageError({ key: 'ar.credit_note.apply.invoice_missing' });
        }
        const pares = specs.map((spec) => {
          const i = spec.lastIndexOf(':');
          if (i > 0 && /^[\d.]+$/.test(spec.slice(i + 1))) {
            return { ref: spec.slice(0, i), amount: spec.slice(i + 1) };
          }
          if (specs.length > 1 || !opts.amount) {
            throw usageError({ key: 'ar.credit_note.apply.no_amount', params: { spec } });
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
            `${p.bold(t('ap.payment.apply.would', { payment: nota.credit_note_number }))}: ` +
              previo.documentos.map((d) => `${d.numero} ${d.saldoAnterior} → ${d.saldoNuevo}`).join(', ') +
              p.dim(` · ${t('ar.credit_note.apply.available', { before: previo.disponibleAnterior, after: previo.disponibleNuevo })}\n`)
          );
          process.stderr.write(p.dim(`${t('ap.payment.dry_run')}\n`));
          return;
        }

        await confirmOrAbort(
          opts,
          t('ar.credit_note.apply.confirm', {
            number: nota.credit_note_number, documents: previo.documentos.map((d) => `${d.numero} (${d.saldoAnterior} → ${d.saldoNuevo})`).join(', '), entity: ctx.entityName,
          })
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
          `${p.green('✔')} ${t('ar.credit_note.apply.applied', { number: p.bold(result.creditNoteNumber) })}: ` +
            result.documentos.map((d) => `${d.numero} ${d.saldoAnterior} → ${d.saldoNuevo} (${d.estado})`).join(', ') +
            p.dim(` · ${t('ar.credit_note.apply.applied_detail', { available: result.disponibleNuevo, status: result.notaStatus })}\n`)
        );
      })
  );
}
