import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import type {
  JournalEntry,
  JournalEntryLine,
  ValidationResult,
  ValidationRule,
  Account,
  FiscalPeriod,
} from '../../types/index.js';

const BALANCE_TOLERANCE = new Decimal('0.01');

// ============================================================
// LAS CUENTAS DE LAS LÍNEAS SE RESOLVÍAN GLOBALMENTE.
//
// Tres de las siete reglas leen las cuentas de las líneas, y las tres lo
// hacían con `WHERE id IN (...)` sin más. El account_id llega crudo del cuerpo
// de la petición (`POST /v1/journal-entries`, y también de GraphQL y de la
// terminal), y nadie comprobaba jamás que la cuenta perteneciera a la entidad
// del asiento.
//
// Lo que eso permitía: un asiento de MI entidad con una línea contra una
// cuenta de la TUYA. Las tres reglas encontraban la cuenta ajena y la
// validaban contra SUS banderas —is_active, is_header, allow_manual_entries—,
// así que el asiento pasaba la validación y posteaba. A partir de ahí el
// disparador de saldos mueve account_balances de una cuenta que no es de la
// entidad del asiento: la balanza de comprobación de la víctima se desplaza
// por un asiento que no aparece en su mayor. Es la clase de descuadre que un
// contador tarda semanas en explicar, porque el asiento que lo causa no está
// en sus libros.
//
// No es un `WHERE id = $1` sino un `WHERE id IN (...)`, que es justo por lo
// que no lo alcanza `findByIdInScope`: la frontera aquí es un filtro de
// conjunto, y va en el mismo SQL que ya se hacía —ni una consulta más—.
//
// El alcance sale de `entry.entity_id`, que las cuatro llamadas a
// validateJournalEntry ya traen puesto (posting.ts:176 y :274,
// journal-entry-service.ts:385 y :449). Por eso la firma pública no cambia y
// no hay llamador que actualizar.
// ============================================================

/** Las cuentas de las líneas, ACOTADAS a la entidad del asiento. */
async function cuentasDeLaEntidad<T extends { id: string }>(
  columnas: string,
  accountIds: string[],
  entityId: string
): Promise<Map<string, T>> {
  const placeholders = accountIds.map((_, i) => `$${i + 2}`).join(',');
  const result = await query<T>(
    `SELECT ${columnas} FROM accounts WHERE entity_id = $1 AND id IN (${placeholders})`,
    [entityId, ...accountIds]
  );
  return new Map(result.rows.map((a) => [a.id, a]));
}

// Rule 1: Debits must equal credits — EXACTLY.
// NIF A-2 (postulado de dualidad económica): every transaction affects at
// least two elements and the equation must hold. The DB CHECK on posting
// requires exact equality of the trigger-maintained totals, so a tolerance
// here would accept entries that can never post (they would die with a raw
// constraint error instead of this friendly message).
const balanceRule: ValidationRule = {
  name: 'balance',
  async validate(entry, lines): Promise<ValidationResult> {
    const totalDebits = lines.reduce(
      (sum, line) => sum.plus(new Decimal(line.debit_amount || '0')),
      new Decimal(0)
    );
    const totalCredits = lines.reduce(
      (sum, line) => sum.plus(new Decimal(line.credit_amount || '0')),
      new Decimal(0)
    );

    if (!totalDebits.equals(totalCredits)) {
      return {
        isValid: false,
        errors: [
          `Debits (${totalDebits.toFixed(4)}) must equal credits (${totalCredits.toFixed(4)}). ` +
          `Difference: ${totalDebits.minus(totalCredits).abs().toFixed(4)}. ` +
          `[NIF A-2, dualidad económica: todo asiento debe estar balanceado]`,
        ],
        warnings: [],
      };
    }

    return { isValid: true, errors: [], warnings: [] };
  },
};

// Rule 2: Each line must have exactly one of debit or credit
const lineAmountRule: ValidationRule = {
  name: 'lineAmount',
  async validate(_entry, lines): Promise<ValidationResult> {
    const errors: string[] = [];

    for (const line of lines) {
      const hasDebit = line.debit_amount !== null && line.debit_amount !== undefined;
      const hasCredit = line.credit_amount !== null && line.credit_amount !== undefined;

      if (hasDebit === hasCredit) {
        errors.push(
          `Line ${line.line_number}: Must have exactly one of debit_amount or credit_amount`
        );
      }

      if (hasDebit && new Decimal(line.debit_amount!).lessThanOrEqualTo(0)) {
        errors.push(`Line ${line.line_number}: debit_amount must be positive`);
      }

      if (hasCredit && new Decimal(line.credit_amount!).lessThanOrEqualTo(0)) {
        errors.push(`Line ${line.line_number}: credit_amount must be positive`);
      }
    }

    return { isValid: errors.length === 0, errors, warnings: [] };
  },
};

// Rule 3: Normal balance validation
const accountTypeRule: ValidationRule = {
  name: 'accountType',
  async validate(entry, lines): Promise<ValidationResult> {
    const warnings: string[] = [];

    const accountIds = lines.map((l) => l.account_id);
    if (accountIds.length === 0) return { isValid: true, errors: [], warnings: [] };

    const accountMap = await cuentasDeLaEntidad<Account>(
      'id, account_type, normal_balance',
      accountIds,
      entry.entity_id
    );

    for (const line of lines) {
      const account = accountMap.get(line.account_id);
      // Una cuenta ajena no está en el mapa. Aquí no se dice nada: esta regla
      // sólo emite advertencias, y quien RECHAZA la línea es accountPermission.
      if (!account) continue;

      const isDebit = line.debit_amount !== null;
      const normalIsDebit = account.normal_balance === 'debit';

      if (isDebit !== normalIsDebit) {
        warnings.push(
          `Line ${line.line_number}: Posting ${isDebit ? 'debit' : 'credit'} to ` +
          `account "${account.account_type}" which normally has ${account.normal_balance} balance ` +
          `[NIF A-5: un cargo contra-natural suele indicar cuenta equivocada o una corrección — ` +
          `las correcciones de errores se hacen por reversa, no editando (NIF B-1)]`
        );
      }
    }

    return { isValid: true, errors: [], warnings };
  },
};

// Rule 4: Period status validation
const periodStatusRule: ValidationRule = {
  name: 'periodStatus',
  async validate(entry, _lines): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const result = await query<FiscalPeriod>(
      'SELECT status FROM fiscal_periods WHERE id = $1',
      [entry.fiscal_period_id]
    );

    if (result.rows.length === 0) {
      errors.push('Fiscal period not found');
      return { isValid: false, errors, warnings };
    }

    const period = result.rows[0];

    if (period.status === 'hard_close' || period.status === 'locked') {
      errors.push(`Cannot post to ${period.status} period`);
    } else if (period.status === 'soft_close') {
      warnings.push('Period is in soft_close status. Only adjusting entries recommended.');
    } else if (period.status === 'future') {
      warnings.push(
        'Posting to a future period [NIF A-2, devengación: los efectos se reconocen ' +
        'en el periodo en que ocurren, no antes]'
      );
    }

    return { isValid: errors.length === 0, errors, warnings };
  },
};

// Entry types produced by automated flows (document posting, payroll,
// closing, depreciation, reversals). allow_manual_entries protects control
// accounts (AR/AP, IVA) from MANUAL postings; enforcing it on these types
// forced control accounts to allow manual entries or broke automated posts.
const AUTOMATED_ENTRY_TYPES = new Set([
  'auto_invoice', 'auto_bill', 'auto_payment', 'auto_depreciation',
  'auto_reconciliation', 'payroll', 'closing', 'reversing',
]);

// Rule 5: Account permission validation
const accountPermissionRule: ValidationRule = {
  name: 'accountPermission',
  async validate(entry, lines): Promise<ValidationResult> {
    const errors: string[] = [];
    const isAutomated = AUTOMATED_ENTRY_TYPES.has(entry.entry_type);

    const accountIds = lines.map((l) => l.account_id);
    if (accountIds.length === 0) return { isValid: true, errors: [], warnings: [] };

    const accountMap = await cuentasDeLaEntidad<Account>(
      'id, code, name, allow_manual_entries, is_header, is_active',
      accountIds,
      entry.entity_id
    );

    for (const line of lines) {
      const account = accountMap.get(line.account_id);
      if (!account) {
        // ÉSTE es el punto donde la frontera muerde. Una cuenta de otra
        // entidad sale del mapa igual que una inexistente, y cae en un error
        // que ya existía: no hubo que inventar una rama nueva, y por tanto
        // tampoco una por la que el programa pueda delatarse.
        //
        // TODO(decisión pendiente): ¿se queda «not found» a secas, o una
        // cuenta ajena merece un mensaje propio? Ver la conversación: es el
        // mismo pulso 404-vs-403 de scope.ts, pero aquí el que lo lee suele
        // ser un contable de un grupo con varias entidades que pegó el UUID
        // de la cuenta equivocada, no un atacante.
        errors.push(`Line ${line.line_number}: Account ${line.account_id} not found`);
        continue;
      }

      if (!account.is_active) {
        errors.push(`Line ${line.line_number}: Account "${account.code}" is inactive`);
      }

      if (account.is_header) {
        errors.push(`Line ${line.line_number}: Cannot post to header account "${account.code}"`);
      }

      if (!account.allow_manual_entries && !isAutomated) {
        errors.push(`Line ${line.line_number}: Account "${account.code}" does not allow manual entries`);
      }
    }

    return { isValid: errors.length === 0, errors, warnings: [] };
  },
};

// Rule 6: Currency validation
const currencyRule: ValidationRule = {
  name: 'currency',
  async validate(_entry, lines): Promise<ValidationResult> {
    const errors: string[] = [];

    for (const line of lines) {
      if (line.currency_code) {
        if (!line.exchange_rate) {
          errors.push(
            `Line ${line.line_number}: Foreign currency requires exchange_rate ` +
            `[NIF B-15: las operaciones en moneda extranjera se reconocen al tipo de ` +
            `cambio histórico de la fecha de la transacción]`
          );
        }

        const hasForeignAmount = line.foreign_debit !== null || line.foreign_credit !== null;
        if (!hasForeignAmount) {
          errors.push(
            `Line ${line.line_number}: Foreign currency requires foreign_debit or foreign_credit`
          );
        }

        // Validate conversion accuracy
        if (line.exchange_rate && hasForeignAmount) {
          const foreignAmount = new Decimal(line.foreign_debit || line.foreign_credit || '0');
          const expectedAmount = foreignAmount.times(new Decimal(line.exchange_rate));
          const actualAmount = new Decimal(line.debit_amount || line.credit_amount || '0');
          const conversionDiff = expectedAmount.minus(actualAmount).abs();

          if (conversionDiff.greaterThan(BALANCE_TOLERANCE)) {
            errors.push(
              `Line ${line.line_number}: Currency conversion mismatch. ` +
              `Expected ${expectedAmount.toFixed(4)}, got ${actualAmount.toFixed(4)}`
            );
          }
        }
      }
    }

    return { isValid: errors.length === 0, errors, warnings: [] };
  },
};

// Rule 7: NIF substance checks — patterns that are almost always a
// misclassification, flagged as warnings with the standard that explains why.
const nifSubstanceRule: ValidationRule = {
  name: 'nifSubstance',
  async validate(entry, lines): Promise<ValidationResult> {
    const warnings: string[] = [];
    const accountIds = lines.map((l) => l.account_id);
    if (accountIds.length === 0) return { isValid: true, errors: [], warnings: [] };

    const byId = await cuentasDeLaEntidad<Account>(
      'id, code, account_type',
      accountIds,
      entry.entity_id
    );
    const description = `${entry.description ?? ''}`.toLowerCase();

    for (const line of lines) {
      const account = byId.get(line.account_id);
      if (!account) continue;

      // NIF D-1: an advance from a customer is a LIABILITY until control of
      // the good/service transfers. Crediting revenue on an "anticipo" is
      // the most common revenue-recognition error in small firms.
      if (
        account.account_type === 'revenue' &&
        line.credit_amount !== null &&
        /\banticipo\b/.test(description)
      ) {
        warnings.push(
          `Line ${line.line_number}: crediting revenue "${account.code}" on an entry that ` +
          `mentions "anticipo" [NIF D-1: el anticipo de un cliente es PASIVO hasta que se ` +
          `transfiere el control del bien o servicio; el ingreso se reconoce entonces]`
        );
      }

      // NIF C-11: equity moves through formal acts (aportaciones, dividendos,
      // asambleas), not routine bookkeeping. A manual equity line deserves
      // a second look.
      if (account.account_type === 'equity' || account.account_type === 'contra_equity') {
        warnings.push(
          `Line ${line.line_number}: manual posting to equity account "${account.code}" ` +
          `[NIF C-11: los movimientos de capital contable derivan de actos formales ` +
          `(aportaciones, dividendos, acuerdos de asamblea) — verifica que exista el acta o acuerdo]`
        );
      }
    }

    return { isValid: true, errors: [], warnings };
  },
};

const ALL_RULES: ValidationRule[] = [
  balanceRule,
  lineAmountRule,
  accountTypeRule,
  periodStatusRule,
  accountPermissionRule,
  currencyRule,
  nifSubstanceRule,
];

export async function validateJournalEntry(
  entry: JournalEntry,
  lines: JournalEntryLine[]
): Promise<ValidationResult> {
  if (lines.length < 2) {
    return {
      isValid: false,
      errors: ['Journal entry must have at least 2 lines'],
      warnings: [],
    };
  }

  const results = await Promise.all(
    ALL_RULES.map((rule) => rule.validate(entry, lines))
  );

  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  for (const result of results) {
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  return {
    isValid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}
