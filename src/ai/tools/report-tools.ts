import { z } from 'zod/v4';
import { envolverDatosDeTerceros } from '../untrusted.js';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import Decimal from 'decimal.js';
import type { AgentContext } from '../context.js';
import type { ToolObserver } from './observer.js';
import {
  queryTrialBalanceRows,
  totalTrialBalance,
  getBalanceSheet,
  type BalanceSheetReport,
  queryIncomeStatementRows,
  netMovement,
  queryAgedReceivableRows,
  queryAgedPayableRows,
  queryLedgerRows,
} from '../../services/reporting/report-service.js';
import { avisoDeCierreEnRango } from '../../services/reporting/criterio-cierre.js';

// ============================================================
// REPORT TOOLS (read-only)
//
// The SQL now lives in src/services/reporting/report-service.ts and is
// shared with /v1/reports/* and with `mnemosine report …`: one trial
// balance, one set of sign conventions, one place where the
// parenthesized (jel JOIN je) pair keeps draft and void entries out.
//
// What stays here is the AGENT's projection, and it stays on purpose.
// These tools round to 2 decimals (a model reading 18477.1200 is a model
// inventing precision it was not given), publish a flatter shape than the
// REST envelope, order the ageing by days_overdue rather than by customer,
// and cap the ledger at 100 movements. Those are properties of the agent's
// context window, not of the report — so they are expressed here, over
// shared rows, instead of being pushed into the service where the other
// two surfaces would inherit them.
//
// Sign convention: balances are debit-positive unless the tool output
// says otherwise.
// ============================================================

/** What the agent gets to see. More digits is not more truth. */
const AGENT_SCALE = 2;

/**
 * Un importe, a la escala que el agente lee.
 *
 * La cabecera de arriba prometía esto desde el principio y sólo se cumplía en
 * los TOTALES: las filas de detalle se copiaban tal cual desde la consulta, que
 * devuelve DECIMAL(19,4). Así que el mismo objeto publicaba `ending_balance`
 * con cuatro decimales y `total_debits` con dos — y el detalle a cuatro tapaba
 * que las dos cifras ya no cuadraban entre sí.
 */
const aEscala = (x: string | number | null | undefined): string =>
  new Decimal(x ?? 0).toFixed(AGENT_SCALE);

/**
 * El día que la columna guarda, no el instante en que el proceso lo lee.
 *
 * `node-postgres` convierte una columna DATE en un Date a medianoche LOCAL, y
 * JSON.stringify lo publica como marca de tiempo UTC: la base guarda
 * `2026-02-01` y el agente recibía `"2026-02-01T06:00:00.000Z"`. Se leen los
 * componentes LOCALES a propósito — recortar la cadena ISO daría el día
 * correcto en México y el día ANTERIOR en cualquier zona al este de Greenwich,
 * donde esa medianoche local cae la tarde del día previo en UTC.
 */
const soloFecha = (v: Date | string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const mes = String(v.getMonth() + 1).padStart(2, '0');
    const dia = String(v.getDate()).padStart(2, '0');
    return `${v.getFullYear()}-${mes}-${dia}`;
  }
  return v.slice(0, 10);
};

/**
 * Lo que le sobra a la suma de las filas publicadas frente al total publicado.
 *
 * El total se calcula sobre las filas CRUDAS —es el redondeo de la suma, la
 * verdad del mayor— y las filas se publican redondeadas. Las dos cosas son
 * correctas y no tienen por qué coincidir al céntimo. Antes la diferencia
 * existía igual y quedaba escondida detrás de los dos dígitos de más; ahora se
 * NOMBRA, que es la regla de la casa: un dato que no cuadra no se reparte.
 *
 * Se omite cuando es cero, que es casi siempre.
 */
function residuoDeRedondeo(filas: Array<string | null | undefined>, total: string): string | null {
  const suma = filas.reduce<Decimal>((s, x) => s.plus(new Decimal(x ?? 0)), new Decimal(0));
  const residuo = suma.minus(new Decimal(total));
  return residuo.isZero() ? null : residuo.toFixed(AGENT_SCALE);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateInput = (desc: string) => z.string().regex(DATE_RE).describe(desc);

export function buildReportTools(ctx: AgentContext, observe?: ToolObserver) {
  const trialBalance = betaZodTool({
    name: 'get_trial_balance',
    description:
      'Trial balance: per account, total debits, credits, and balance (positive = debit balance). ' +
      'Only journal entries with posted status. Includes totals and whether the trial balance balances.',
    inputSchema: z.object({
      as_of_date: dateInput('Cutoff YYYY-MM-DD; omit to include the full history').optional(),
      only_with_balance: z.boolean().optional().describe('true = omit zero-balance accounts'),
    }),
    run: async (input) => {
      observe?.('get_trial_balance', input);
      const all = await queryTrialBalanceRows(ctx.entityId, { asOfDate: input.as_of_date });

      const kept = input.only_with_balance
        ? all.filter((r) => !new Decimal(r.ending_balance).isZero())
        : all;
      const rows = kept.map((r) => ({
        account_code: r.account_code,
        account_name: r.account_name,
        account_type: r.account_type,
        debit_total: aEscala(r.debit_total),
        credit_total: aEscala(r.credit_total),
        ending_balance: aEscala(r.ending_balance),
      }));
      // Los totales siguen calculándose sobre `kept`, que son las filas CRUDAS:
      // el total es el del libro, no la suma de lo que se muestra.
      const totales = totalTrialBalance(kept, AGENT_SCALE);
      const residuoDebe = residuoDeRedondeo(rows.map((r) => r.debit_total), totales.total_debits);
      const residuoHaber = residuoDeRedondeo(rows.map((r) => r.credit_total), totales.total_credits);

      // El agente ve la misma nota que la CLI y el REST: sin ella explicaría
      // como discrepancia la diferencia normal entre una balanza que cuenta el
      // cierre del ejercicio y un estado de resultados que no lo cuenta.
      const closing = await avisoDeCierreEnRango(
        ctx.entityId,
        { asOfDate: input.as_of_date },
        'trial-balance'
      );

      return JSON.stringify({
        as_of_date: input.as_of_date ?? null,
        currency: ctx.currency,
        accounts: rows,
        totals: totales,
        ...(residuoDebe || residuoHaber
          ? { rounding_residual: { debit_total: residuoDebe, credit_total: residuoHaber } }
          : {}),
        ...(closing ? { closing_entries: closing } : {}),
      });
    },
  });

  const balanceSheet = betaZodTool({
    name: 'get_balance_sheet',
    description:
      'Balance sheet (statement of financial position) as of a cutoff date. It FOOTS: ' +
      'the result of the period not yet swept into equity is included there, as ' +
      '`equity.result_of_the_period`. Read `is_balanced` / `out_of_balance` to tell whether ' +
      'the books themselves are sound. ' +
      "Amounts in each section's natural sign: a negative amount is a contra " +
      'account that subtracts from its section (e.g. accumulated depreciation in assets).',
    inputSchema: z.object({
      as_of_date: dateInput('Cutoff date YYYY-MM-DD'),
    }),
    run: async (input) => {
      observe?.('get_balance_sheet', input);

      // AHORA PROYECTA, NO ENSAMBLA.
      //
      // Antes hacía su propia consulta y publicaba
      // `total_liabilities_and_equity = pasivo + capital`, sin llamar a
      // queryUnclosedEarnings: el resultado del ejercicio no barrido se quedaba
      // fuera y el estado no cuadraba. Medido sobre un mayor sano de activo
      // 100 000 con 6 000 de resultado sin barrer, publicaba 94 000.00 contra
      // 100 000.00 y NINGÚN campo con el que notar la diferencia — mientras la
      // CLI y el REST, que sí consumen getBalanceSheet, firmaban 100 000.00.
      //
      // Lo que esta herramienta aporta es la PROYECCIÓN —lista plana por código
      // y dos decimales—, no una aritmética propia. `getBalanceSheet` acepta la
      // escala, así que proyectar no cuesta una consulta de más.
      // A ESCALA DEL LIBRO, Y SE REDONDEA UNA SOLA VEZ AL PUBLICAR.
      //
      // `getBalanceSheet` acepta `scale`, y pasarle 2 sería lo cómodo — pero
      // suma los subtotales YA redondeados de cada subsección, así que el total
      // de sección sale de una suma de redondeos. Medido sobre un catálogo con
      // seis subsecciones: 18477.11 pasando escala 2, contra 18477.12 sumando en
      // crudo y redondeando al final. La aritmética se hace entera y el
      // redondeo es lo último que ocurre, que es la regla del resto del archivo.
      const bs = await getBalanceSheet(ctx.entityId, { asOfDate: input.as_of_date });

      // Plana por cuenta, no anidada en subsecciones: el agente lee una lista y
      // el anidamiento del sobre REST sólo cuesta tokens. `category` conserva el
      // valor crudo que esta herramienta ya publicaba (`current_assets`), que la
      // subsección embellece para imprimir.
      type Seccion = BalanceSheetReport['assets'];
      const aplanar = (sec: Seccion) => {
        const accounts = sec.subsections.flatMap((sub: Seccion['subsections'][number]) =>
          sub.accounts.map((a: Seccion['subsections'][number]['accounts'][number]) => ({
            code: a.code,
            name: a.name,
            category: sub.name.toLowerCase().replace(/ /g, '_'),
            balance: aEscala(a.balance),
          }))
        );
        const total = aEscala(sec.total);
        // El residuo compara el total contra TODO LO PUBLICADO, no sólo contra
        // las cuentas: «Result Of The Period» es una subsección sin cuentas —no
        // hay ninguna que la contenga hasta que alguien cierre— y sale como
        // campo propio. Medirlo contra las cuentas solas daría un residuo de
        // 6 000 en un balance perfectamente cuadrado, que es peor que no
        // publicarlo: nombraría como descuadre lo que es la cifra principal.
        const sinCuentas = sec.subsections
          .filter((sub: Seccion['subsections'][number]) => sub.accounts.length === 0)
          .map((sub: Seccion['subsections'][number]) => aEscala(sub.total));
        return {
          seccion: { total, accounts },
          residuo: residuoDeRedondeo([...accounts.map((a) => a.balance), ...sinCuentas], total),
        };
      };

      const activo = aplanar(bs.assets);
      const pasivo = aplanar(bs.liabilities);
      const capital = aplanar(bs.equity);

      // «Result Of The Period» es una subsección SIN cuentas —no hay ninguna que
      // la contenga hasta que alguien cierre el ejercicio—, así que al aplanar
      // se perdería. Se publica como campo propio: es la cifra con la que el
      // agente puede explicar por qué el capital no es el del catálogo.
      const resultado = bs.equity.subsections.find(
        (x: Seccion['subsections'][number]) => x.name === 'Result Of The Period'
      );

      const residuos = {
        ...(activo.residuo ? { assets: activo.residuo } : {}),
        ...(pasivo.residuo ? { liabilities: pasivo.residuo } : {}),
        ...(capital.residuo ? { equity: capital.residuo } : {}),
      };

      return JSON.stringify({
        as_of_date: bs.as_of_date,
        currency: ctx.currency,
        assets: activo.seccion,
        liabilities: pasivo.seccion,
        equity: {
          ...capital.seccion,
          ...(resultado ? { result_of_the_period: aEscala(resultado.total) } : {}),
        },
        total_liabilities_and_equity: aEscala(bs.total_liabilities_and_equity),
        out_of_balance: aEscala(bs.out_of_balance),
        // Se decide sobre la cifra ENTERA del libro, no sobre la redondeada: un
        // descuadre de menos de un centavo sale con out_of_balance «0.00» y
        // is_balanced en falso, y esa pareja es la señal, no una contradicción.
        is_balanced: bs.is_balanced,
        ...(Object.keys(residuos).length > 0 ? { rounding_residual: residuos } : {}),
      });
    },
  });

  const incomeStatement = betaZodTool({
    name: 'get_income_statement',
    description:
      'Income statement for a date range: revenue, expenses, and net income. ' +
      'Revenue in its natural credit sign; expenses in their natural debit sign (both positive).',
    inputSchema: z.object({
      start_date: dateInput('Period start YYYY-MM-DD'),
      end_date: dateInput('Period end YYYY-MM-DD'),
    }),
    run: async (input) => {
      observe?.('get_income_statement', input);
      // 'any-activity': an account that moved and netted to zero is still a
      // fact the agent may need to explain, unlike in the REST statement.
      const rows = await queryIncomeStatementRows(ctx.entityId, {
        startDate: input.start_date,
        endDate: input.end_date,
        include: 'any-activity',
      });

      // Revenue is credit-natural, expenses debit-natural — report both positive.
      // LOS TOTALES SE SUMAN EN CRUDO Y SE REDONDEAN AL FINAL.
      //
      // Antes el `reduce` corría sobre las cadenas YA redondeadas de las filas,
      // así que publicaba la suma de los redondeos en vez del redondeo de la
      // suma. No es una diferencia de presentación: medido sobre un gasto
      // posteado de 0.0400 repartido en dos cuentas, publicaba `expenses.total`
      // 0.06 y `net_income` 18477.06 donde el libro dice 0.04 y 18477.08 — y
      // contradecía a `get_trial_balance`, que sobre los mismos asientos los
      // contaba bien. Es el convenio del resto del archivo, y el único que no
      // miente hacia el mayor.
      const crudoIngresos = rows.filter((r) => r.account_type === 'revenue');
      const crudoGastos = rows.filter((r) => r.account_type === 'expense');

      const revenueRows = crudoIngresos.map((r) => ({
        code: r.code, name: r.name, amount: netMovement(r).negated().toFixed(AGENT_SCALE),
      }));
      const expenseRows = crudoGastos.map((r) => ({
        code: r.code, name: r.name, amount: netMovement(r).toFixed(AGENT_SCALE),
      }));

      const totalRevenue = crudoIngresos.reduce(
        (s, r) => s.plus(netMovement(r).negated()),
        new Decimal(0)
      );
      const totalExpenses = crudoGastos.reduce((s, r) => s.plus(netMovement(r)), new Decimal(0));
      const residuoIngresos = residuoDeRedondeo(
        revenueRows.map((r) => r.amount),
        totalRevenue.toFixed(AGENT_SCALE)
      );
      const residuoGastos = residuoDeRedondeo(
        expenseRows.map((r) => r.amount),
        totalExpenses.toFixed(AGENT_SCALE)
      );

      const closing = await avisoDeCierreEnRango(
        ctx.entityId,
        { sinceDate: input.start_date, untilDate: input.end_date },
        'income-statement'
      );

      return JSON.stringify({
        start_date: input.start_date,
        end_date: input.end_date,
        currency: ctx.currency,
        revenue: { total: totalRevenue.toFixed(AGENT_SCALE), accounts: revenueRows },
        expenses: { total: totalExpenses.toFixed(AGENT_SCALE), accounts: expenseRows },
        net_income: totalRevenue.minus(totalExpenses).toFixed(AGENT_SCALE),
        ...(residuoIngresos || residuoGastos
          ? { rounding_residual: { revenue: residuoIngresos, expenses: residuoGastos } }
          : {}),
        ...(closing ? { closing_entries: closing } : {}),
      });
    },
  });

  const agedReceivables = betaZodTool({
    name: 'get_aged_receivables',
    description:
      'Aged receivables: customer invoices with outstanding balance and days overdue ' +
      '(negative days_overdue = not yet due).',
    inputSchema: z.object({
      as_of_date: dateInput('Reference date YYYY-MM-DD; omit for today').optional(),
    }),
    run: async (input) => {
      observe?.('get_aged_receivables', input);
      const asOf = input.as_of_date ?? new Date().toISOString().split('T')[0];
      const all = await queryAgedReceivableRows(ctx.entityId, { asOfDate: asOf, order: 'overdue' });
      const invoices = all.map((r) => ({
        customer_name: r.customer_name,
        customer_number: r.customer_number,
        invoice_number: r.invoice_number,
        invoice_date: soloFecha(r.invoice_date),
        due_date: soloFecha(r.due_date),
        total_amount: aEscala(r.total_amount),
        amount_due: aEscala(r.amount_due),
        days_overdue: r.days_overdue,
      }));
      // El total, sobre las filas CRUDAS: es lo que se debe, no lo que se lee.
      const totalDue = all.reduce((s, r) => s.plus(new Decimal(r.amount_due)), new Decimal(0));
      const residuo = residuoDeRedondeo(invoices.map((i) => i.amount_due), totalDue.toFixed(AGENT_SCALE));
      return envolverDatosDeTerceros({
        as_of_date: asOf, currency: ctx.currency,
        total_due: totalDue.toFixed(AGENT_SCALE), count: invoices.length, invoices,
        ...(residuo ? { rounding_residual: { amount_due: residuo } } : {}),
      });
    },
  });

  const agedPayables = betaZodTool({
    name: 'get_aged_payables',
    description:
      'Aged payables: vendor bills with outstanding balance and days overdue ' +
      '(negative days_overdue = not yet due).',
    inputSchema: z.object({
      as_of_date: dateInput('Reference date YYYY-MM-DD; omit for today').optional(),
    }),
    run: async (input) => {
      observe?.('get_aged_payables', input);
      const asOf = input.as_of_date ?? new Date().toISOString().split('T')[0];
      const all = await queryAgedPayableRows(ctx.entityId, { asOfDate: asOf, order: 'overdue' });
      const bills = all.map((r) => ({
        vendor_name: r.vendor_name,
        vendor_number: r.vendor_number,
        bill_number: r.bill_number,
        bill_date: soloFecha(r.bill_date),
        due_date: soloFecha(r.due_date),
        total_amount: aEscala(r.total_amount),
        amount_due: aEscala(r.amount_due),
        days_overdue: r.days_overdue,
      }));
      const totalDue = all.reduce((s, r) => s.plus(new Decimal(r.amount_due)), new Decimal(0));
      const residuo = residuoDeRedondeo(bills.map((b) => b.amount_due), totalDue.toFixed(AGENT_SCALE));
      return envolverDatosDeTerceros({
        as_of_date: asOf, currency: ctx.currency,
        total_due: totalDue.toFixed(AGENT_SCALE), count: bills.length, bills,
        ...(residuo ? { rounding_residual: { amount_due: residuo } } : {}),
      });
    },
  });

  const generalLedger = betaZodTool({
    name: 'get_general_ledger',
    description:
      'General ledger detail: line-by-line movements of an account (posted journal entries) in a date range. ' +
      'Maximum 100 movements per query.',
    inputSchema: z.object({
      account_code: z.string().describe('Account code, e.g. 1101'),
      start_date: dateInput('Start YYYY-MM-DD').optional(),
      end_date: dateInput('End YYYY-MM-DD').optional(),
    }),
    run: async (input) => {
      observe?.('get_general_ledger', input);
      // 101 rows for a 100-row answer: the extra one is how truncation is
      // detected without paying for a COUNT the agent never shows.
      const fetched = await queryLedgerRows(ctx.entityId, {
        accountCode: input.account_code,
        startDate: input.start_date,
        endDate: input.end_date,
        limit: 101,
      });

      if (fetched.length === 0) {
        return `No posted movements for account ${input.account_code} in that range.`;
      }
      const truncated = fetched.length > 100;
      const rows = fetched.slice(0, 100);
      const movements = rows.map((r) => ({
        entry_number: r.entry_number,
        entry_date: soloFecha(r.entry_date),
        entry_description: r.entry_description,
        debit_amount: aEscala(r.debit_amount),
        credit_amount: aEscala(r.credit_amount),
        line_description: r.line_description,
      }));
      const debits = rows.reduce((s, r) => s.plus(new Decimal(r.debit_amount ?? 0)), new Decimal(0));
      const credits = rows.reduce((s, r) => s.plus(new Decimal(r.credit_amount ?? 0)), new Decimal(0));
      const residuoDebe = residuoDeRedondeo(
        movements.map((m) => m.debit_amount),
        debits.toFixed(AGENT_SCALE)
      );
      const residuoHaber = residuoDeRedondeo(
        movements.map((m) => m.credit_amount),
        credits.toFixed(AGENT_SCALE)
      );

      return envolverDatosDeTerceros({
        account_code: input.account_code, truncated, count: movements.length,
        period_debits: debits.toFixed(AGENT_SCALE), period_credits: credits.toFixed(AGENT_SCALE),
        movements,
        ...(residuoDebe || residuoHaber
          ? { rounding_residual: { period_debits: residuoDebe, period_credits: residuoHaber } }
          : {}),
      });
    },
  });

  return [trialBalance, balanceSheet, incomeStatement, agedReceivables, agedPayables, generalLedger];
}
