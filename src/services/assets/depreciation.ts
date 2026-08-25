import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, currentTenant } from '../../database/connection.js';
import { createJournalEntry, attestEntryAsync } from '../accounting/posting.js';
import type { FixedAsset, DepreciationMethod } from '../../types/index.js';
import { JournalEntryType } from '../../types/index.js';

interface DepreciationInput {
  asset_id: string;
  acquisition_cost: number;
  salvage_value: number;
  useful_life_months: number;
  depreciation_start_date: Date;
  method: DepreciationMethod;
  macrs_class?: string;
}

interface DepreciationResult {
  period_number: number;
  period_start_date: Date;
  period_end_date: Date;
  beginning_book_value: string;
  depreciation_expense: string;
  accumulated_depreciation: string;
  ending_book_value: string;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

// Straight-Line: (Cost - Salvage) / Useful Life
export function calculateStraightLine(input: DepreciationInput): DepreciationResult[] {
  const schedule: DepreciationResult[] = [];
  const depreciableBase = new Decimal(input.acquisition_cost).minus(input.salvage_value);
  const monthlyDepreciation = depreciableBase.dividedBy(input.useful_life_months);

  let accumulated = new Decimal(0);
  let bookValue = new Decimal(input.acquisition_cost);

  for (let month = 1; month <= input.useful_life_months; month++) {
    const periodStart = addMonths(input.depreciation_start_date, month - 1);
    const periodEnd = addMonths(periodStart, 1);

    let expense = monthlyDepreciation;
    if (month === input.useful_life_months) {
      expense = bookValue.minus(input.salvage_value);
    }

    accumulated = accumulated.plus(expense);
    bookValue = bookValue.minus(expense);

    schedule.push({
      period_number: month,
      period_start_date: periodStart,
      period_end_date: periodEnd,
      beginning_book_value: bookValue.plus(expense).toFixed(4),
      depreciation_expense: expense.toFixed(4),
      accumulated_depreciation: accumulated.toFixed(4),
      ending_book_value: bookValue.toFixed(4),
    });
  }

  return schedule;
}

// Declining Balance (150% or 200%)
export function calculateDecliningBalance(input: DepreciationInput, rate: number): DepreciationResult[] {
  const schedule: DepreciationResult[] = [];
  const annualRate = new Decimal(rate).dividedBy(input.useful_life_months / 12);
  const monthlyRate = annualRate.dividedBy(12);

  let accumulated = new Decimal(0);
  let bookValue = new Decimal(input.acquisition_cost);

  for (let month = 1; month <= input.useful_life_months; month++) {
    const periodStart = addMonths(input.depreciation_start_date, month - 1);
    const periodEnd = addMonths(periodStart, 1);

    let expense = bookValue.times(monthlyRate);

    if (bookValue.minus(expense).lessThan(input.salvage_value)) {
      expense = bookValue.minus(input.salvage_value);
    }

    // Switch to straight-line if higher
    const remainingMonths = input.useful_life_months - month + 1;
    const slExpense = bookValue.minus(input.salvage_value).dividedBy(remainingMonths);
    if (slExpense.greaterThan(expense)) {
      expense = slExpense;
    }

    accumulated = accumulated.plus(expense);
    bookValue = bookValue.minus(expense);

    schedule.push({
      period_number: month,
      period_start_date: periodStart,
      period_end_date: periodEnd,
      beginning_book_value: bookValue.plus(expense).toFixed(4),
      depreciation_expense: expense.toFixed(4),
      accumulated_depreciation: accumulated.toFixed(4),
      ending_book_value: bookValue.toFixed(4),
    });

    if (bookValue.lessThanOrEqualTo(input.salvage_value)) break;
  }

  return schedule;
}

// Sum-of-Years-Digits
export function calculateSumOfYearsDigits(input: DepreciationInput): DepreciationResult[] {
  const schedule: DepreciationResult[] = [];
  const depreciableBase = new Decimal(input.acquisition_cost).minus(input.salvage_value);
  const years = input.useful_life_months / 12;
  const sumOfYears = new Decimal(years).times(new Decimal(years).plus(1)).dividedBy(2);

  let accumulated = new Decimal(0);
  let bookValue = new Decimal(input.acquisition_cost);

  for (let month = 1; month <= input.useful_life_months; month++) {
    const periodStart = addMonths(input.depreciation_start_date, month - 1);
    const periodEnd = addMonths(periodStart, 1);

    const yearNumber = Math.ceil(month / 12);
    const remainingLifeForYear = years - yearNumber + 1;
    const annualDepreciation = depreciableBase.times(remainingLifeForYear).dividedBy(sumOfYears);
    const expense = annualDepreciation.dividedBy(12);

    accumulated = accumulated.plus(expense);
    bookValue = bookValue.minus(expense);

    schedule.push({
      period_number: month,
      period_start_date: periodStart,
      period_end_date: periodEnd,
      beginning_book_value: bookValue.plus(expense).toFixed(4),
      depreciation_expense: expense.toFixed(4),
      accumulated_depreciation: accumulated.toFixed(4),
      ending_book_value: bookValue.toFixed(4),
    });
  }

  return schedule;
}

// MACRS tables
const MACRS_TABLES: Record<string, number[]> = {
  '3-year': [33.33, 44.45, 14.81, 7.41],
  '5-year': [20.00, 32.00, 19.20, 11.52, 11.52, 5.76],
  '7-year': [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
  '10-year': [10.00, 18.00, 14.40, 11.52, 9.22, 7.37, 6.55, 6.55, 6.56, 6.55, 3.28],
  '15-year': [5.00, 9.50, 8.55, 7.70, 6.93, 6.23, 5.90, 5.90, 5.91, 5.90, 5.91, 5.90, 5.91, 5.90, 5.91, 2.95],
  '20-year': [3.750, 7.219, 6.677, 6.177, 5.713, 5.285, 4.888, 4.522, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 2.231],
};

export function calculateMACRS(input: DepreciationInput): DepreciationResult[] {
  const schedule: DepreciationResult[] = [];
  const macrsClass = input.macrs_class || '5-year';
  const table = MACRS_TABLES[macrsClass];
  if (!table) throw new Error(`Invalid MACRS class: ${macrsClass}`);

  const cost = new Decimal(input.acquisition_cost);
  let accumulated = new Decimal(0);
  let bookValue = cost;
  let periodNumber = 1;

  for (let year = 0; year < table.length; year++) {
    const annualPct = new Decimal(table[year]).dividedBy(100);
    const annualDepreciation = cost.times(annualPct);
    const months = year === 0 ? 6 : (year === table.length - 1 ? 6 : 12);
    const monthlyDepreciation = annualDepreciation.dividedBy(months);

    for (let m = 0; m < months; m++) {
      const periodStart = addMonths(input.depreciation_start_date, periodNumber - 1);
      const periodEnd = addMonths(periodStart, 1);

      accumulated = accumulated.plus(monthlyDepreciation);
      bookValue = bookValue.minus(monthlyDepreciation);

      schedule.push({
        period_number: periodNumber,
        period_start_date: periodStart,
        period_end_date: periodEnd,
        beginning_book_value: bookValue.plus(monthlyDepreciation).toFixed(4),
        depreciation_expense: monthlyDepreciation.toFixed(4),
        accumulated_depreciation: accumulated.toFixed(4),
        ending_book_value: bookValue.toFixed(4),
      });

      periodNumber++;
    }
  }

  return schedule;
}

// Units of Production
export function calculateUnitsOfProduction(
  input: DepreciationInput,
  totalCapacity: number,
  periodsUnits: Array<{ period: number; units: number }>
): DepreciationResult[] {
  const schedule: DepreciationResult[] = [];
  const depreciableBase = new Decimal(input.acquisition_cost).minus(input.salvage_value);

  let accumulated = new Decimal(0);
  let bookValue = new Decimal(input.acquisition_cost);

  for (const period of periodsUnits) {
    const periodStart = addMonths(input.depreciation_start_date, period.period - 1);
    const periodEnd = addMonths(periodStart, 1);

    let expense = depreciableBase.times(period.units).dividedBy(totalCapacity);

    // Cannot depreciate below salvage value
    if (bookValue.minus(expense).lessThan(input.salvage_value)) {
      expense = bookValue.minus(input.salvage_value);
    }

    if (expense.lessThanOrEqualTo(0)) break;

    accumulated = accumulated.plus(expense);
    bookValue = bookValue.minus(expense);

    schedule.push({
      period_number: period.period,
      period_start_date: periodStart,
      period_end_date: periodEnd,
      beginning_book_value: bookValue.plus(expense).toFixed(4),
      depreciation_expense: expense.toFixed(4),
      accumulated_depreciation: accumulated.toFixed(4),
      ending_book_value: bookValue.toFixed(4),
    });

    if (bookValue.lessThanOrEqualTo(input.salvage_value)) break;
  }

  return schedule;
}

// Master calculation function
export function calculateDepreciation(
  input: DepreciationInput,
  unitsOfProductionData?: { totalCapacity: number; periodsUnits: Array<{ period: number; units: number }> }
): DepreciationResult[] {
  switch (input.method) {
    case 'straight_line':
      return calculateStraightLine(input);
    case 'declining_balance_150':
      return calculateDecliningBalance(input, 1.5);
    case 'declining_balance_200':
      return calculateDecliningBalance(input, 2.0);
    case 'sum_of_years_digits':
      return calculateSumOfYearsDigits(input);
    case 'macrs':
      return calculateMACRS(input);
    case 'units_of_production':
      if (!unitsOfProductionData) throw new Error('Units of production requires totalCapacity and periodsUnits');
      return calculateUnitsOfProduction(input, unitsOfProductionData.totalCapacity, unitsOfProductionData.periodsUnits);
    default:
      return calculateStraightLine(input);
  }
}

// Monthly depreciation job
export async function runMonthlyDepreciation(
  entityId: string,
  fiscalPeriodId: string,
  userId: string
): Promise<{ processed: number; errors: string[] }> {
  let processed = 0;
  const errors: string[] = [];

  const assets = await query<FixedAsset>(
    `SELECT * FROM fixed_assets WHERE entity_id = $1 AND status = 'active'`,
    [entityId]
  );

  for (const asset of assets.rows) {
    try {
      // Check if already calculated for this period
      const existing = await query(
        `SELECT id FROM depreciation_schedules
         WHERE asset_id = $1 AND fiscal_period_id = $2`,
        [asset.id, fiscalPeriodId]
      );
      if (existing.rows.length > 0) continue;

      const schedule = calculateDepreciation({
        asset_id: asset.id,
        acquisition_cost: parseFloat(asset.acquisition_cost),
        salvage_value: parseFloat(asset.salvage_value),
        useful_life_months: asset.useful_life_months,
        depreciation_start_date: new Date(asset.depreciation_start_date),
        method: asset.depreciation_method,
        macrs_class: asset.macrs_class || undefined,
      });

      // Find the period's entry in the schedule
      const periodStart = await query<{ start_date: Date }>(
        'SELECT start_date FROM fiscal_periods WHERE id = $1',
        [fiscalPeriodId]
      );

      const monthsDiff = Math.floor(
        (periodStart.rows[0].start_date.getTime() - new Date(asset.depreciation_start_date).getTime()) /
        (30.44 * 24 * 60 * 60 * 1000)
      );

      const entry = schedule[monthsDiff];
      if (!entry) continue;

      await withTransaction(async (client) => {
        // Create depreciation schedule record
        await client.query(
          `INSERT INTO depreciation_schedules (
            id, asset_id, fiscal_period_id, depreciation_date,
            depreciation_expense, accumulated_depreciation, book_value,
            schedule_type, is_posted
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'book', true)`,
          [
            uuidv4(), asset.id, fiscalPeriodId, entry.period_start_date,
            entry.depreciation_expense, entry.accumulated_depreciation, entry.ending_book_value,
          ]
        );

        // Create journal entry
        const je = await createJournalEntry(
          entityId,
          entry.period_start_date,
          JournalEntryType.AUTO_DEPRECIATION,
          `Monthly depreciation - ${asset.asset_name}`,
          [
            {
              account_id: asset.depreciation_expense_account_id,
              debit_amount: entry.depreciation_expense,
              credit_amount: null,
              description: `Depreciation - ${asset.asset_name}`,
            },
            {
              account_id: asset.accumulated_depreciation_account_id,
              debit_amount: null,
              credit_amount: entry.depreciation_expense,
              description: `Accumulated Depreciation - ${asset.asset_name}`,
            },
          ],
          userId,
          // Same client: the schedule row, the JE and the asset update
          // commit (or abort) together instead of on separate connections.
          { sourceType: 'depreciation', sourceId: asset.id, autoPost: true, client }
        );

        // Update asset
        await client.query(
          `UPDATE fixed_assets SET
            current_book_value = $1, accumulated_depreciation = $2,
            last_depreciation_date = $3
           WHERE id = $4`,
          [entry.ending_book_value, entry.accumulated_depreciation, entry.period_start_date, asset.id]
        );

        return je.id;
      }).then((entryId) => {
        // Caller-owned client means caller-owned attestation, AFTER commit.
        const tenantId = currentTenant();
        if (tenantId) attestEntryAsync(tenantId, entityId, entryId);
      });

      processed++;
    } catch (err) {
      errors.push(`Asset ${asset.asset_number}: ${(err as Error).message}`);
    }
  }

  return { processed, errors };
}
