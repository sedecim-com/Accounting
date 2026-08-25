# Accounting Core - Technical Specification Document (Part 3)
## Depreciation, Inventory, Security & Implementation Guide

---

## 6.2 Fixed Assets & Depreciation Module

### 6.2.1 Depreciation Calculation Algorithms

```typescript
/**
 * Depreciation Calculation Engine
 */

interface DepreciationInput {
  asset_id: string;
  acquisition_cost: number;
  salvage_value: number;
  useful_life_months: number;
  acquisition_date: Date;
  depreciation_start_date: Date;
  method: DepreciationMethod;
  macrs_class?: string; // For MACRS (USA tax)
}

enum DepreciationMethod {
  STRAIGHT_LINE = 'straight_line',
  DECLINING_BALANCE_150 = 'declining_balance_150',
  DECLINING_BALANCE_200 = 'declining_balance_200',
  SUM_OF_YEARS_DIGITS = 'sum_of_years_digits',
  UNITS_OF_PRODUCTION = 'units_of_production',
  MACRS = 'macrs'
}

interface DepreciationScheduleEntry {
  period_number: number;
  period_start_date: Date;
  period_end_date: Date;
  beginning_book_value: number;
  depreciation_expense: number;
  accumulated_depreciation: number;
  ending_book_value: number;
}

/**
 * Straight-Line Depreciation
 * Formula: (Cost - Salvage) / Useful Life
 */
function calculateStraightLine(
  input: DepreciationInput
): DepreciationScheduleEntry[] {
  const schedule: DepreciationScheduleEntry[] = [];
  const depreciableBase = input.acquisition_cost - input.salvage_value;
  const monthlyDepreciation = depreciableBase / input.useful_life_months;
  
  let accumulatedDepreciation = 0;
  let bookValue = input.acquisition_cost;
  
  for (let month = 1; month <= input.useful_life_months; month++) {
    const periodStart = addMonths(input.depreciation_start_date, month - 1);
    const periodEnd = addMonths(periodStart, 1);
    
    // Last period adjustment to handle rounding
    let expense = monthlyDepreciation;
    if (month === input.useful_life_months) {
      expense = bookValue - input.salvage_value;
    }
    
    accumulatedDepreciation += expense;
    bookValue -= expense;
    
    schedule.push({
      period_number: month,
      period_start_date: periodStart,
      period_end_date: periodEnd,
      beginning_book_value: bookValue + expense,
      depreciation_expense: expense,
      accumulated_depreciation: accumulatedDepreciation,
      ending_book_value: bookValue
    });
  }
  
  return schedule;
}

/**
 * Declining Balance Depreciation (150% or 200%)
 * Formula: Book Value * (Rate / Useful Life)
 * Rate: 1.5 for 150%, 2.0 for 200% (double-declining)
 */
function calculateDecliningBalance(
  input: DepreciationInput,
  rate: number // 1.5 or 2.0
): DepreciationScheduleEntry[] {
  const schedule: DepreciationScheduleEntry[] = [];
  const annualRate = rate / (input.useful_life_months / 12);
  const monthlyRate = annualRate / 12;
  
  let accumulatedDepreciation = 0;
  let bookValue = input.acquisition_cost;
  
  for (let month = 1; month <= input.useful_life_months; month++) {
    const periodStart = addMonths(input.depreciation_start_date, month - 1);
    const periodEnd = addMonths(periodStart, 1);
    
    let expense = bookValue * monthlyRate;
    
    // Cannot depreciate below salvage value
    if (bookValue - expense < input.salvage_value) {
      expense = bookValue - input.salvage_value;
    }
    
    // Switch to straight-line if it yields higher depreciation
    const remainingMonths = input.useful_life_months - month + 1;
    const straightLineExpense = 
      (bookValue - input.salvage_value) / remainingMonths;
    
    if (straightLineExpense > expense) {
      expense = straightLineExpense;
    }
    
    accumulatedDepreciation += expense;
    bookValue -= expense;
    
    schedule.push({
      period_number: month,
      period_start_date: periodStart,
      period_end_date: periodEnd,
      beginning_book_value: bookValue + expense,
      depreciation_expense: expense,
      accumulated_depreciation: accumulatedDepreciation,
      ending_book_value: bookValue
    });
    
    // Stop if fully depreciated
    if (bookValue <= input.salvage_value) {
      break;
    }
  }
  
  return schedule;
}

/**
 * Sum-of-Years-Digits (SYD) Depreciation
 * Formula: (Cost - Salvage) * (Remaining Life / Sum of Years)
 * Sum of Years = n(n+1)/2 where n = useful life in years
 */
function calculateSumOfYearsDigits(
  input: DepreciationInput
): DepreciationScheduleEntry[] {
  const schedule: DepreciationScheduleEntry[] = [];
  const depreciableBase = input.acquisition_cost - input.salvage_value;
  const years = input.useful_life_months / 12;
  const sumOfYears = (years * (years + 1)) / 2;
  
  let accumulatedDepreciation = 0;
  let bookValue = input.acquisition_cost;
  
  for (let month = 1; month <= input.useful_life_months; month++) {
    const periodStart = addMonths(input.depreciation_start_date, month - 1);
    const periodEnd = addMonths(periodStart, 1);
    
    const remainingMonths = input.useful_life_months - month + 1;
    const remainingYears = remainingMonths / 12;
    
    // Annual depreciation for this year
    const yearNumber = Math.ceil(month / 12);
    const remainingLifeForYear = years - yearNumber + 1;
    const annualDepreciation = 
      depreciableBase * (remainingLifeForYear / sumOfYears);
    
    // Monthly portion
    const expense = annualDepreciation / 12;
    
    accumulatedDepreciation += expense;
    bookValue -= expense;
    
    schedule.push({
      period_number: month,
      period_start_date: periodStart,
      period_end_date: periodEnd,
      beginning_book_value: bookValue + expense,
      depreciation_expense: expense,
      accumulated_depreciation: accumulatedDepreciation,
      ending_book_value: bookValue
    });
  }
  
  return schedule;
}

/**
 * MACRS Depreciation (USA Tax)
 * Modified Accelerated Cost Recovery System
 */
const MACRS_TABLES = {
  '3-year': [33.33, 44.45, 14.81, 7.41],
  '5-year': [20.00, 32.00, 19.20, 11.52, 11.52, 5.76],
  '7-year': [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
  '10-year': [10.00, 18.00, 14.40, 11.52, 9.22, 7.37, 6.55, 6.55, 6.56, 6.55, 3.28],
  '15-year': [5.00, 9.50, 8.55, 7.70, 6.93, 6.23, 5.90, 5.90, 5.91, 5.90, 5.91, 5.90, 5.91, 5.90, 5.91, 2.95],
  '20-year': [3.750, 7.219, 6.677, 6.177, 5.713, 5.285, 4.888, 4.522, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 2.231]
};

function calculateMACRS(
  input: DepreciationInput
): DepreciationScheduleEntry[] {
  const schedule: DepreciationScheduleEntry[] = [];
  const percentages = MACRS_TABLES[input.macrs_class!];
  
  if (!percentages) {
    throw new Error(`Invalid MACRS class: ${input.macrs_class}`);
  }
  
  let accumulatedDepreciation = 0;
  let bookValue = input.acquisition_cost;
  
  // MACRS uses half-year convention (first year gets 6 months)
  const firstYearStart = input.depreciation_start_date;
  
  for (let year = 0; year < percentages.length; year++) {
    const annualExpense = input.acquisition_cost * (percentages[year] / 100);
    const monthlyExpense = annualExpense / 12;
    
    // Distribute annual depreciation across 12 months
    for (let month = 1; month <= 12; month++) {
      const periodStart = addMonths(firstYearStart, year * 12 + month - 1);
      const periodEnd = addMonths(periodStart, 1);
      
      accumulatedDepreciation += monthlyExpense;
      bookValue -= monthlyExpense;
      
      schedule.push({
        period_number: year * 12 + month,
        period_start_date: periodStart,
        period_end_date: periodEnd,
        beginning_book_value: bookValue + monthlyExpense,
        depreciation_expense: monthlyExpense,
        accumulated_depreciation: accumulatedDepreciation,
        ending_book_value: Math.max(bookValue, 0)
      });
    }
  }
  
  return schedule;
}

/**
 * Units of Production Depreciation
 * Formula: (Cost - Salvage) * (Units Produced / Total Units Capacity)
 */
interface UnitsOfProductionInput extends DepreciationInput {
  total_units_capacity: number;
  units_produced_per_period: number[];
}

function calculateUnitsOfProduction(
  input: UnitsOfProductionInput
): DepreciationScheduleEntry[] {
  const schedule: DepreciationScheduleEntry[] = [];
  const depreciableBase = input.acquisition_cost - input.salvage_value;
  const ratePerUnit = depreciableBase / input.total_units_capacity;
  
  let accumulatedDepreciation = 0;
  let bookValue = input.acquisition_cost;
  
  for (let period = 0; period < input.units_produced_per_period.length; period++) {
    const periodStart = addMonths(input.depreciation_start_date, period);
    const periodEnd = addMonths(periodStart, 1);
    
    const unitsProduced = input.units_produced_per_period[period];
    const expense = unitsProduced * ratePerUnit;
    
    accumulatedDepreciation += expense;
    bookValue -= expense;
    
    schedule.push({
      period_number: period + 1,
      period_start_date: periodStart,
      period_end_date: periodEnd,
      beginning_book_value: bookValue + expense,
      depreciation_expense: expense,
      accumulated_depreciation: accumulatedDepreciation,
      ending_book_value: bookValue
    });
  }
  
  return schedule;
}

/**
 * Master Depreciation Calculator
 */
export function calculateDepreciation(
  input: DepreciationInput
): DepreciationScheduleEntry[] {
  switch (input.method) {
    case DepreciationMethod.STRAIGHT_LINE:
      return calculateStraightLine(input);
    
    case DepreciationMethod.DECLINING_BALANCE_150:
      return calculateDecliningBalance(input, 1.5);
    
    case DepreciationMethod.DECLINING_BALANCE_200:
      return calculateDecliningBalance(input, 2.0);
    
    case DepreciationMethod.SUM_OF_YEARS_DIGITS:
      return calculateSumOfYearsDigits(input);
    
    case DepreciationMethod.MACRS:
      return calculateMACRS(input);
    
    case DepreciationMethod.UNITS_OF_PRODUCTION:
      return calculateUnitsOfProduction(input as UnitsOfProductionInput);
    
    default:
      throw new Error(`Unknown depreciation method: ${input.method}`);
  }
}

/**
 * Automatic Depreciation Posting (Monthly Job)
 */
export async function runMonthlyDepreciation(
  entityId: string,
  periodId: string
): Promise<void> {
  const period = await getFiscalPeriod(periodId);
  const assets = await getActiveAssets(entityId);
  
  for (const asset of assets) {
    // Check if already calculated for this period
    const existing = await getDepreciationSchedule(asset.id, periodId);
    if (existing && existing.is_posted) {
      continue; // Already done
    }
    
    // Calculate depreciation for this month
    const schedule = calculateDepreciation({
      asset_id: asset.id,
      acquisition_cost: asset.acquisition_cost,
      salvage_value: asset.salvage_value,
      useful_life_months: asset.useful_life_months,
      acquisition_date: asset.acquisition_date,
      depreciation_start_date: asset.depreciation_start_date,
      method: asset.depreciation_method,
      macrs_class: asset.macrs_class
    });
    
    // Find this month's entry
    const monthEntry = schedule.find(e => 
      e.period_start_date >= period.start_date &&
      e.period_start_date <= period.end_date
    );
    
    if (!monthEntry) {
      continue; // Asset not yet in service or fully depreciated
    }
    
    // Save schedule entry
    await saveDepreciationSchedule({
      asset_id: asset.id,
      fiscal_period_id: periodId,
      depreciation_date: period.end_date,
      depreciation_expense: monthEntry.depreciation_expense,
      accumulated_depreciation: monthEntry.accumulated_depreciation,
      book_value: monthEntry.ending_book_value,
      schedule_type: 'book',
      is_posted: false
    });
    
    // Create journal entry
    const entry = await createJournalEntry({
      entity_id: entityId,
      fiscal_period_id: periodId,
      entry_date: period.end_date,
      entry_type: 'auto_depreciation',
      description: `Depreciation - ${asset.asset_name}`,
      source_type: 'depreciation',
      source_id: asset.id,
      lines: [
        {
          line_number: 1,
          account_id: asset.depreciation_expense_account_id,
          debit_amount: monthEntry.depreciation_expense,
          description: `Monthly depreciation`,
          cost_center_id: asset.cost_center_id,
          department_id: asset.department_id
        },
        {
          line_number: 2,
          account_id: asset.accumulated_depreciation_account_id,
          credit_amount: monthEntry.depreciation_expense,
          description: `Accumulated depreciation`
        }
      ]
    });
    
    // Auto-post
    await postJournalEntry(entry.id);
    
    // Mark schedule as posted
    await updateDepreciationSchedule(monthEntry.id, {
      is_posted: true,
      journal_entry_id: entry.id
    });
    
    // Update asset current values
    await updateAsset(asset.id, {
      current_book_value: monthEntry.ending_book_value,
      accumulated_depreciation: monthEntry.accumulated_depreciation,
      last_depreciation_date: period.end_date
    });
  }
}
```

---

## 6.3 Inventory Accounting Module

### 6.3.1 Inventory Costing Methods

```typescript
/**
 * Inventory Costing Engine
 */

interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  costing_method: CostingMethod;
  current_quantity: number;
  current_value: number;
}

enum CostingMethod {
  FIFO = 'fifo',
  LIFO = 'lifo',
  WEIGHTED_AVERAGE = 'weighted_average',
  SPECIFIC_IDENTIFICATION = 'specific_identification'
}

interface InventoryLayer {
  id: string;
  item_id: string;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  acquired_date: Date;
  remaining_quantity: number;
}

interface InventoryTransaction {
  id: string;
  item_id: string;
  transaction_type: 'purchase' | 'sale' | 'adjustment' | 'transfer';
  quantity: number;
  unit_cost?: number; // For purchases
  date: Date;
}

interface COGSCalculation {
  cogs_amount: number;
  inventory_reduction: number;
  layers_consumed: {
    layer_id: string;
    quantity_consumed: number;
    cost: number;
  }[];
}

/**
 * FIFO (First-In, First-Out)
 * Consume oldest layers first
 */
async function calculateFIFO(
  itemId: string,
  quantitySold: number,
  saleDate: Date
): Promise<COGSCalculation> {
  // Get layers ordered by acquisition date (oldest first)
  const layers = await db.query(`
    SELECT *
    FROM inventory_layers
    WHERE item_id = $1
      AND remaining_quantity > 0
      AND acquired_date <= $2
    ORDER BY acquired_date ASC
  `, [itemId, saleDate]);
  
  let remainingToConsume = quantitySold;
  let totalCOGS = 0;
  const layersConsumed = [];
  
  for (const layer of layers.rows) {
    if (remainingToConsume <= 0) break;
    
    const quantityFromThisLayer = Math.min(
      layer.remaining_quantity,
      remainingToConsume
    );
    
    const costFromThisLayer = quantityFromThisLayer * layer.unit_cost;
    
    layersConsumed.push({
      layer_id: layer.id,
      quantity_consumed: quantityFromThisLayer,
      cost: costFromThisLayer
    });
    
    totalCOGS += costFromThisLayer;
    remainingToConsume -= quantityFromThisLayer;
    
    // Update layer
    await db.query(`
      UPDATE inventory_layers
      SET remaining_quantity = remaining_quantity - $1
      WHERE id = $2
    `, [quantityFromThisLayer, layer.id]);
  }
  
  if (remainingToConsume > 0) {
    throw new Error(
      `Insufficient inventory: tried to sell ${quantitySold}, ` +
      `only ${quantitySold - remainingToConsume} available`
    );
  }
  
  return {
    cogs_amount: totalCOGS,
    inventory_reduction: totalCOGS,
    layers_consumed: layersConsumed
  };
}

/**
 * LIFO (Last-In, First-Out)
 * Consume newest layers first
 */
async function calculateLIFO(
  itemId: string,
  quantitySold: number,
  saleDate: Date
): Promise<COGSCalculation> {
  // Get layers ordered by acquisition date (newest first)
  const layers = await db.query(`
    SELECT *
    FROM inventory_layers
    WHERE item_id = $1
      AND remaining_quantity > 0
      AND acquired_date <= $2
    ORDER BY acquired_date DESC
  `, [itemId, saleDate]);
  
  // Same logic as FIFO but with reversed order
  let remainingToConsume = quantitySold;
  let totalCOGS = 0;
  const layersConsumed = [];
  
  for (const layer of layers.rows) {
    if (remainingToConsume <= 0) break;
    
    const quantityFromThisLayer = Math.min(
      layer.remaining_quantity,
      remainingToConsume
    );
    
    const costFromThisLayer = quantityFromThisLayer * layer.unit_cost;
    
    layersConsumed.push({
      layer_id: layer.id,
      quantity_consumed: quantityFromThisLayer,
      cost: costFromThisLayer
    });
    
    totalCOGS += costFromThisLayer;
    remainingToConsume -= quantityFromThisLayer;
    
    await db.query(`
      UPDATE inventory_layers
      SET remaining_quantity = remaining_quantity - $1
      WHERE id = $2
    `, [quantityFromThisLayer, layer.id]);
  }
  
  if (remainingToConsume > 0) {
    throw new Error(`Insufficient inventory`);
  }
  
  return {
    cogs_amount: totalCOGS,
    inventory_reduction: totalCOGS,
    layers_consumed: layersConsumed
  };
}

/**
 * Weighted Average Cost
 * COGS = (Total Inventory Value / Total Quantity) * Quantity Sold
 */
async function calculateWeightedAverage(
  itemId: string,
  quantitySold: number,
  saleDate: Date
): Promise<COGSCalculation> {
  // Get current inventory state
  const inventory = await db.query(`
    SELECT 
      SUM(remaining_quantity) as total_quantity,
      SUM(remaining_quantity * unit_cost) as total_value
    FROM inventory_layers
    WHERE item_id = $1
      AND remaining_quantity > 0
      AND acquired_date <= $2
  `, [itemId, saleDate]);
  
  const totalQuantity = inventory.rows[0].total_quantity || 0;
  const totalValue = inventory.rows[0].total_value || 0;
  
  if (totalQuantity < quantitySold) {
    throw new Error(`Insufficient inventory`);
  }
  
  const averageUnitCost = totalValue / totalQuantity;
  const totalCOGS = averageUnitCost * quantitySold;
  
  // Reduce layers proportionally
  const reductionRatio = quantitySold / totalQuantity;
  
  const layers = await db.query(`
    SELECT *
    FROM inventory_layers
    WHERE item_id = $1
      AND remaining_quantity > 0
      AND acquired_date <= $2
  `, [itemId, saleDate]);
  
  const layersConsumed = [];
  
  for (const layer of layers.rows) {
    const quantityFromThisLayer = layer.remaining_quantity * reductionRatio;
    const costFromThisLayer = quantityFromThisLayer * averageUnitCost;
    
    layersConsumed.push({
      layer_id: layer.id,
      quantity_consumed: quantityFromThisLayer,
      cost: costFromThisLayer
    });
    
    await db.query(`
      UPDATE inventory_layers
      SET remaining_quantity = remaining_quantity - $1
      WHERE id = $2
    `, [quantityFromThisLayer, layer.id]);
  }
  
  return {
    cogs_amount: totalCOGS,
    inventory_reduction: totalCOGS,
    layers_consumed: layersConsumed
  };
}

/**
 * Specific Identification
 * Track and consume specific units
 */
async function calculateSpecificIdentification(
  itemId: string,
  specificLayerIds: string[]
): Promise<COGSCalculation> {
  const layers = await db.query(`
    SELECT *
    FROM inventory_layers
    WHERE id = ANY($1)
      AND item_id = $2
      AND remaining_quantity > 0
  `, [specificLayerIds, itemId]);
  
  let totalCOGS = 0;
  const layersConsumed = [];
  
  for (const layer of layers.rows) {
    const cost = layer.remaining_quantity * layer.unit_cost;
    
    layersConsumed.push({
      layer_id: layer.id,
      quantity_consumed: layer.remaining_quantity,
      cost: cost
    });
    
    totalCOGS += cost;
    
    // Fully consume this layer
    await db.query(`
      UPDATE inventory_layers
      SET remaining_quantity = 0
      WHERE id = $1
    `, [layer.id]);
  }
  
  return {
    cogs_amount: totalCOGS,
    inventory_reduction: totalCOGS,
    layers_consumed: layersConsumed
  };
}

/**
 * Purchase - Add Inventory Layer
 */
async function recordInventoryPurchase(
  itemId: string,
  quantity: number,
  unitCost: number,
  purchaseDate: Date
): Promise<void> {
  const item = await getInventoryItem(itemId);
  
  // Create new inventory layer
  await db.query(`
    INSERT INTO inventory_layers (
      item_id, quantity, unit_cost, total_cost,
      acquired_date, remaining_quantity
    ) VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    itemId,
    quantity,
    unitCost,
    quantity * unitCost,
    purchaseDate,
    quantity
  ]);
  
  // Update item totals
  await db.query(`
    UPDATE inventory_items
    SET 
      current_quantity = current_quantity + $1,
      current_value = current_value + $2
    WHERE id = $3
  `, [quantity, quantity * unitCost, itemId]);
  
  // Create journal entry (if not using perpetual)
  // Debit: Inventory
  // Credit: Cash or AP
}

/**
 * Sale - Calculate and Record COGS
 */
async function recordInventorySale(
  itemId: string,
  quantitySold: number,
  salePrice: number,
  saleDate: Date,
  specificLayers?: string[]
): Promise<void> {
  const item = await getInventoryItem(itemId);
  
  let cogsCalculation: COGSCalculation;
  
  // Calculate COGS based on costing method
  switch (item.costing_method) {
    case CostingMethod.FIFO:
      cogsCalculation = await calculateFIFO(itemId, quantitySold, saleDate);
      break;
    
    case CostingMethod.LIFO:
      cogsCalculation = await calculateLIFO(itemId, quantitySold, saleDate);
      break;
    
    case CostingMethod.WEIGHTED_AVERAGE:
      cogsCalculation = await calculateWeightedAverage(itemId, quantitySold, saleDate);
      break;
    
    case CostingMethod.SPECIFIC_IDENTIFICATION:
      if (!specificLayers) {
        throw new Error('Specific layers required for specific identification method');
      }
      cogsCalculation = await calculateSpecificIdentification(itemId, specificLayers);
      break;
    
    default:
      throw new Error(`Unknown costing method: ${item.costing_method}`);
  }
  
  // Update item totals
  await db.query(`
    UPDATE inventory_items
    SET 
      current_quantity = current_quantity - $1,
      current_value = current_value - $2
    WHERE id = $3
  `, [quantitySold, cogsCalculation.inventory_reduction, itemId]);
  
  // Create journal entry (perpetual system)
  await createJournalEntry({
    entry_type: 'auto_inventory',
    entry_date: saleDate,
    description: `Sale of ${quantitySold} units of ${item.name}`,
    lines: [
      // Revenue recognition
      {
        line_number: 1,
        account_id: ACCOUNTS_RECEIVABLE_ID,
        debit_amount: quantitySold * salePrice,
        description: 'Revenue from sale'
      },
      {
        line_number: 2,
        account_id: SALES_REVENUE_ID,
        credit_amount: quantitySold * salePrice,
        description: 'Sales revenue'
      },
      // COGS recognition
      {
        line_number: 3,
        account_id: COGS_ACCOUNT_ID,
        debit_amount: cogsCalculation.cogs_amount,
        description: 'Cost of goods sold'
      },
      {
        line_number: 4,
        account_id: INVENTORY_ACCOUNT_ID,
        credit_amount: cogsCalculation.cogs_amount,
        description: 'Inventory reduction'
      }
    ]
  });
  
  // Log layer consumption for audit trail
  for (const layer of cogsCalculation.layers_consumed) {
    await db.query(`
      INSERT INTO inventory_layer_consumption (
        layer_id, transaction_id, quantity_consumed, cost
      ) VALUES ($1, $2, $3, $4)
    `, [layer.layer_id, transactionId, layer.quantity_consumed, layer.cost]);
  }
}
```

---

## 7. Security & Compliance

### 7.1 Authentication & Authorization

```typescript
/**
 * JWT-based Authentication
 */

interface JWTPayload {
  user_id: string;
  tenant_id: string;
  email: string;
  roles: string[];
  permissions: string[];
  entities: string[]; // Accessible entity IDs
  session_id: string;
  iat: number; // Issued at
  exp: number; // Expiration
}

function generateAccessToken(user: User, session: Session): string {
  const payload: JWTPayload = {
    user_id: user.id,
    tenant_id: user.tenant_id,
    email: user.email,
    roles: user.roles.map(r => r.name),
    permissions: getPermissionsFromRoles(user.roles),
    entities: user.entity_access.map(e => e.entity_id),
    session_id: session.id,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60) // 1 hour
  };
  
  return jwt.sign(payload, process.env.JWT_SECRET!, {
    algorithm: 'HS256'
  });
}

function generateRefreshToken(user: User, session: Session): string {
  const payload = {
    user_id: user.id,
    session_id: session.id,
    type: 'refresh',
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30) // 30 days
  };
  
  return jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET!, {
    algorithm: 'HS256'
  });
}

/**
 * Permission Checking Middleware
 */

interface Permission {
  resource: string; // 'accounts', 'journal_entries', 'invoices', etc.
  action: string;   // 'read', 'create', 'update', 'delete', 'post', etc.
  scope?: string;   // 'own', 'entity', 'all'
}

const PERMISSIONS = {
  // Accounts
  'accounts:read': { resource: 'accounts', action: 'read' },
  'accounts:create': { resource: 'accounts', action: 'create' },
  'accounts:update': { resource: 'accounts', action: 'update' },
  'accounts:delete': { resource: 'accounts', action: 'delete' },
  
  // Journal Entries
  'journal_entries:read': { resource: 'journal_entries', action: 'read' },
  'journal_entries:create': { resource: 'journal_entries', action: 'create' },
  'journal_entries:post': { resource: 'journal_entries', action: 'post' },
  'journal_entries:void': { resource: 'journal_entries', action: 'void' },
  
  // Invoices
  'invoices:read': { resource: 'invoices', action: 'read' },
  'invoices:create': { resource: 'invoices', action: 'create' },
  'invoices:send': { resource: 'invoices', action: 'send' },
  'invoices:void': { resource: 'invoices', action: 'void' },
  
  // Periods
  'periods:close': { resource: 'periods', action: 'close' },
  'periods:reopen': { resource: 'periods', action: 'reopen' },
  
  // Reports
  'reports:read': { resource: 'reports', action: 'read' },
  'reports:export': { resource: 'reports', action: 'export' },
  
  // Admin
  'users:manage': { resource: 'users', action: 'manage' },
  'settings:manage': { resource: 'settings', action: 'manage' }
};

function requirePermission(...requiredPerms: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user; // Set by auth middleware
    
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const hasPermission = requiredPerms.every(perm =>
      user.permissions.includes(perm)
    );
    
    if (!hasPermission) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: requiredPerms,
        current: user.permissions
      });
    }
    
    next();
  };
}

// Usage
app.post('/v1/journal-entries/:id/post',
  authenticate,
  requirePermission('journal_entries:post'),
  async (req, res) => {
    // Post journal entry
  }
);

/**
 * Entity-Level Access Control
 */

function requireEntityAccess(getEntityIdFromRequest: (req: Request) => string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    const entityId = getEntityIdFromRequest(req);
    
    if (!user.entities.includes(entityId)) {
      return res.status(403).json({
        error: 'No access to this entity',
        entity_id: entityId
      });
    }
    
    next();
  };
}

// Usage
app.get('/v1/entities/:entity_id/accounts',
  authenticate,
  requireEntityAccess(req => req.params.entity_id),
  requirePermission('accounts:read'),
  async (req, res) => {
    // Get accounts
  }
);

/**
 * Role-Based Access Control (RBAC)
 */

interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
}

const PREDEFINED_ROLES: Role[] = [
  {
    id: 'owner',
    name: 'Owner',
    description: 'Full access to everything',
    permissions: ['*'] // All permissions
  },
  {
    id: 'admin',
    name: 'Administrator',
    description: 'Manage everything except billing',
    permissions: [
      'accounts:*',
      'journal_entries:*',
      'invoices:*',
      'bills:*',
      'reports:*',
      'users:manage'
    ]
  },
  {
    id: 'controller',
    name: 'Controller',
    description: 'Accounting operations and period close',
    permissions: [
      'accounts:read',
      'accounts:create',
      'journal_entries:*',
      'periods:close',
      'reports:*'
    ]
  },
  {
    id: 'accountant',
    name: 'Accountant',
    description: 'Day-to-day accounting',
    permissions: [
      'accounts:read',
      'journal_entries:read',
      'journal_entries:create',
      'invoices:*',
      'bills:*',
      'reports:read'
    ]
  },
  {
    id: 'viewer',
    name: 'Viewer',
    description: 'Read-only access',
    permissions: [
      'accounts:read',
      'journal_entries:read',
      'invoices:read',
      'bills:read',
      'reports:read'
    ]
  },
  {
    id: 'auditor',
    name: 'Auditor',
    description: 'Read-only with audit trail access',
    permissions: [
      'accounts:read',
      'journal_entries:read',
      'invoices:read',
      'bills:read',
      'reports:read',
      'reports:export',
      'audit_logs:read'
    ]
  }
];

/**
 * Segregation of Duties (SoD)
 */

interface SoDRule {
  name: string;
  conflicting_permissions: string[][];
  description: string;
  severity: 'high' | 'medium' | 'low';
}

const SOD_RULES: SoDRule[] = [
  {
    name: 'vendor_setup_and_payment',
    conflicting_permissions: [
      ['vendors:create', 'vendors:update'],
      ['bills:pay']
    ],
    description: 'User who creates vendors should not approve payments',
    severity: 'high'
  },
  {
    name: 'journal_entry_creation_and_posting',
    conflicting_permissions: [
      ['journal_entries:create'],
      ['journal_entries:post']
    ],
    description: 'User who creates entries should not post them',
    severity: 'medium'
  },
  {
    name: 'period_close_and_reopen',
    conflicting_permissions: [
      ['periods:close'],
      ['periods:reopen']
    ],
    description: 'User who closes periods should not reopen them',
    severity: 'high'
  }
];

async function checkSoDViolations(userId: string): Promise<SoDRule[]> {
  const user = await getUser(userId);
  const violations: SoDRule[] = [];
  
  for (const rule of SOD_RULES) {
    const hasAllConflictingPerms = rule.conflicting_permissions.every(group =>
      group.some(perm => user.permissions.includes(perm))
    );
    
    if (hasAllConflictingPerms) {
      violations.push(rule);
    }
  }
  
  return violations;
}
```

### 7.2 Data Encryption

```typescript
/**
 * Encryption at Rest
 */

import * as crypto from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!; // 32-byte key
const ALGORITHM = 'aes-256-gcm';

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    iv
  );
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Return: iv + authTag + encrypted data (all hex)
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedData: string): string {
  const parts = encryptedData.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    iv
  );
  
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// Usage: Encrypt sensitive fields
async function saveVendor(vendor: Vendor): Promise<void> {
  await db.query(`
    INSERT INTO vendors (
      id, company_name,
      bank_account_number_encrypted,
      bank_routing_number_encrypted,
      clabe_encrypted
    ) VALUES ($1, $2, $3, $4, $5)
  `, [
    vendor.id,
    vendor.company_name,
    encrypt(vendor.bank_account_number),
    encrypt(vendor.bank_routing_number),
    encrypt(vendor.clabe)
  ]);
}

async function getVendor(vendorId: string): Promise<Vendor> {
  const result = await db.query(`
    SELECT *
    FROM vendors
    WHERE id = $1
  `, [vendorId]);
  
  const row = result.rows[0];
  
  return {
    id: row.id,
    company_name: row.company_name,
    bank_account_number: decrypt(row.bank_account_number_encrypted),
    bank_routing_number: decrypt(row.bank_routing_number_encrypted),
    clabe: decrypt(row.clabe_encrypted)
  };
}
```

### 7.3 Audit Logging

```typescript
/**
 * Comprehensive Audit Trail
 */

interface AuditLogEntry {
  id: string;
  timestamp: Date;
  user_id: string;
  tenant_id: string;
  
  // Action
  action: string; // 'create', 'update', 'delete', 'post', 'void', etc.
  entity_type: string; // 'journal_entry', 'invoice', 'account', etc.
  entity_id: string;
  
  // Changes
  old_values: any;
  new_values: any;
  
  // Context
  ip_address: string;
  user_agent: string;
  request_id: string;
  
  // Metadata
  reason?: string; // For manual overrides
  approver_id?: string; // If action required approval
}

async function auditLog(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void> {
  await db.query(`
    INSERT INTO audit_log (
      id, timestamp, user_id, tenant_id,
      action, entity_type, entity_id,
      old_values, new_values,
      ip_address, user_agent, request_id,
      reason, approver_id
    ) VALUES (
      gen_random_uuid(), NOW(), $1, $2,
      $3, $4, $5,
      $6, $7,
      $8, $9, $10,
      $11, $12
    )
  `, [
    entry.user_id,
    entry.tenant_id,
    entry.action,
    entry.entity_type,
    entry.entity_id,
    JSON.stringify(entry.old_values),
    JSON.stringify(entry.new_values),
    entry.ip_address,
    entry.user_agent,
    entry.request_id,
    entry.reason,
    entry.approver_id
  ]);
}

// Middleware to auto-log all mutations
function auditLogMiddleware(req: Request, res: Response, next: NextFunction) {
  // Capture original send function
  const originalSend = res.send;
  
  res.send = function(body) {
    // Log successful mutations (POST, PUT, PATCH, DELETE)
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
        res.statusCode >= 200 && res.statusCode < 300) {
      
      auditLog({
        user_id: req.user.id,
        tenant_id: req.user.tenant_id,
        action: req.method.toLowerCase(),
        entity_type: extractEntityType(req.path),
        entity_id: extractEntityId(req.path, body),
        old_values: req.body, // Captured by earlier middleware
        new_values: body,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'] || '',
        request_id: req.id
      }).catch(err => {
        console.error('Audit log error:', err);
      });
    }
    
    return originalSend.call(this, body);
  };
  
  next();
}
```

---

## 8. Performance & Scalability

### 8.1 Database Optimization

```sql
-- Partitioning Strategy for Large Tables

-- Partition journal_entry_lines by fiscal_period
CREATE TABLE journal_entry_lines (
    -- columns...
) PARTITION BY RANGE (fiscal_period_id);

CREATE TABLE journal_entry_lines_2024_01 
    PARTITION OF journal_entry_lines
    FOR VALUES FROM ('period_2024_01') TO ('period_2024_02');

CREATE TABLE journal_entry_lines_2024_02 
    PARTITION OF journal_entry_lines
    FOR VALUES FROM ('period_2024_02') TO ('period_2024_03');
-- etc.

-- Materialized View for Trial Balance (fast reporting)
CREATE MATERIALIZED VIEW mv_trial_balance AS
SELECT 
    a.id as account_id,
    a.code,
    a.name,
    a.account_type,
    fp.id as fiscal_period_id,
    fp.period_name,
    SUM(CASE WHEN jel.debit_amount IS NOT NULL 
        THEN jel.debit_amount ELSE 0 END) as debit_total,
    SUM(CASE WHEN jel.credit_amount IS NOT NULL 
        THEN jel.credit_amount ELSE 0 END) as credit_total
FROM accounts a
CROSS JOIN fiscal_periods fp
LEFT JOIN journal_entries je ON je.fiscal_period_id = fp.id AND je.status = 'posted'
LEFT JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id AND jel.account_id = a.id
WHERE a.is_active = true
GROUP BY a.id, a.code, a.name, a.account_type, fp.id, fp.period_name;

CREATE UNIQUE INDEX idx_mv_trial_balance 
    ON mv_trial_balance(account_id, fiscal_period_id);

-- Refresh strategy (after each posting)
CREATE OR REPLACE FUNCTION refresh_trial_balance()
RETURNS TRIGGER AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_trial_balance;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refresh_trial_balance
AFTER INSERT OR UPDATE ON journal_entries
FOR EACH ROW
WHEN (NEW.status = 'posted')
EXECUTE FUNCTION refresh_trial_balance();

-- Denormalized account balances table (very fast balance lookups)
CREATE TABLE account_balances (
    account_id UUID NOT NULL,
    fiscal_period_id UUID NOT NULL,
    entity_id UUID NOT NULL,
    
    beginning_balance DECIMAL(19,4) DEFAULT 0,
    debit_total DECIMAL(19,4) DEFAULT 0,
    credit_total DECIMAL(19,4) DEFAULT 0,
    ending_balance DECIMAL(19,4) DEFAULT 0,
    
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    PRIMARY KEY (account_id, fiscal_period_id)
);

CREATE INDEX idx_account_balances_entity 
    ON account_balances(entity_id);
CREATE INDEX idx_account_balances_period 
    ON account_balances(fiscal_period_id);
```

### 8.2 Caching Strategy

```typescript
/**
 * Multi-Layer Caching
 */

import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

// Layer 1: Chart of Accounts (rarely changes)
async function getAccount(accountId: string): Promise<Account> {
  const cacheKey = `account:${accountId}`;
  
  // Check cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }
  
  // Fetch from DB
  const account = await db.query(
    'SELECT * FROM accounts WHERE id = $1',
    [accountId]
  );
  
  // Cache for 1 hour
  await redis.setex(cacheKey, 3600, JSON.stringify(account.rows[0]));
  
  return account.rows[0];
}

// Layer 2: Exchange Rates (daily updates)
async function getExchangeRate(
  fromCurrency: string,
  toCurrency: string,
  date: Date
): Promise<number> {
  const cacheKey = `exrate:${fromCurrency}:${toCurrency}:${formatDate(date)}`;
  
  const cached = await redis.get(cacheKey);
  if (cached) {
    return parseFloat(cached);
  }
  
  const rate = await fetchExchangeRateFromDB(fromCurrency, toCurrency, date);
  
  // Cache for 24 hours
  await redis.setex(cacheKey, 86400, rate.toString());
  
  return rate;
}

// Layer 3: Report Results (cache until data changes)
async function getTrialBalance(
  entityId: string,
  periodId: string
): Promise<TrialBalance> {
  const cacheKey = `report:trial_balance:${entityId}:${periodId}`;
  
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }
  
  const report = await generateTrialBalance(entityId, periodId);
  
  // Cache until next journal entry posted
  await redis.set(cacheKey, JSON.stringify(report));
  
  return report;
}

// Invalidation on journal entry posting
async function postJournalEntry(entryId: string): Promise<void> {
  const entry = await getJournalEntry(entryId);
  
  // ... posting logic ...
  
  // Invalidate relevant caches
  await redis.del(`report:trial_balance:${entry.entity_id}:${entry.fiscal_period_id}`);
  await redis.del(`report:balance_sheet:${entry.entity_id}:*`);
  await redis.del(`report:income_statement:${entry.entity_id}:*`);
  
  // Invalidate account balances
  for (const line of entry.lines) {
    await redis.del(`account:balance:${line.account_id}:${entry.fiscal_period_id}`);
  }
}
```

---

## 9. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-4)

**Week 1: Infrastructure Setup**
- [ ] Set up development environment (Docker, Kubernetes)
- [ ] Configure PostgreSQL with multi-tenancy (schemas)
- [ ] Set up Redis for caching
- [ ] Configure AWS S3 for document storage
- [ ] Implement base authentication (JWT)
- [ ] Create database migration framework

**Week 2: Core Data Models**
- [ ] Implement accounts table + CRUD
- [ ] Implement journal_entries + journal_entry_lines tables
- [ ] Create fiscal_periods and fiscal_years tables
- [ ] Implement exchange_rates table
- [ ] Create audit_log table
- [ ] Write database seeders for testing

**Week 3: Accounting Engine**
- [ ] Build double-entry validation engine
- [ ] Implement posting engine
- [ ] Create automatic journal entry generation
- [ ] Build account balance calculation
- [ ] Implement period close logic (basic)

**Week 4: REST API Foundation**
- [ ] Set up Express/Fastify server
- [ ] Implement accounts API endpoints
- [ ] Implement journal entries API endpoints
- [ ] Create error handling middleware
- [ ] Build rate limiting
- [ ] Write API documentation (OpenAPI)

### Phase 2: Transactions (Weeks 5-8)

**Week 5: Invoicing**
- [ ] Create invoices + invoice_lines tables
- [ ] Implement customers table
- [ ] Build invoice API endpoints
- [ ] Create automatic posting for invoices
- [ ] Implement invoice PDF generation

**Week 6: Accounts Payable**
- [ ] Create bills + bill_lines tables
- [ ] Implement vendors table
- [ ] Build bill API endpoints
- [ ] Create automatic posting for bills
- [ ] Implement three-way matching (basic)

**Week 7: Payments**
- [ ] Create payment tables (customer + vendor)
- [ ] Implement payment application logic
- [ ] Build payment API endpoints
- [ ] Create automatic posting for payments
- [ ] Implement payment reconciliation

**Week 8: Bank Integration**
- [ ] Create bank_accounts table
- [ ] Implement bank_transactions import (CSV, OFX)
- [ ] Build reconciliation matching algorithm
- [ ] Create reconciliation API
- [ ] Integrate with Plaid (or similar) for live feeds

### Phase 3: Reporting & Advanced Features (Weeks 9-12)

**Week 9: Financial Reports**
- [ ] Build trial balance generation
- [ ] Implement balance sheet
- [ ] Create income statement (P&L)
- [ ] Build general ledger detail report
- [ ] Implement report export (PDF, Excel)

**Week 10: Multi-Currency**
- [ ] Implement currency conversion in journal entries
- [ ] Build exchange rate management
- [ ] Create currency revaluation process
- [ ] Implement forex gain/loss calculation

**Week 11: Fixed Assets**
- [ ] Create fixed_assets table
- [ ] Implement depreciation algorithms
- [ ] Build depreciation schedule generation
- [ ] Create automatic depreciation posting job
- [ ] Build asset disposal workflow

**Week 12: Advanced Features**
- [ ] Implement GraphQL API
- [ ] Build webhook system
- [ ] Create bulk operations API
- [ ] Implement data export/import
- [ ] Build custom report builder (basic)

### Phase 4: Mexico Compliance (Weeks 13-16)

**Week 13: CFDI Integration**
- [ ] Integrate with PAC provider (Finkok/DICOM)
- [ ] Implement CFDI generation (XML)
- [ ] Build certificate management
- [ ] Create timbrado workflow
- [ ] Implement CFDI cancellation

**Week 14: Contabilidad Electrónica**
- [ ] Build SAT catalog mapping
- [ ] Implement XML generation (catálogo, balanza, pólizas)
- [ ] Create DIOT report generation
- [ ] Build validation against SAT schemas

**Week 15: Mexico Tax Reports**
- [ ] Implement declaración mensual data prep
- [ ] Build tax calculation helpers
- [ ] Create IVA reports
- [ ] Implement ISR calculations

**Week 16: Testing & Refinement**
- [ ] End-to-end testing with real Mexican scenarios
- [ ] Performance testing
- [ ] Security audit
- [ ] Documentation completion

### Phase 5: Production Readiness (Weeks 17-20)

**Week 17: Security Hardening**
- [ ] Implement SOC 2 controls
- [ ] Conduct penetration testing
- [ ] Enable encryption at rest
- [ ] Implement comprehensive audit logging
- [ ] Set up intrusion detection

**Week 18: Performance Optimization**
- [ ] Database query optimization
- [ ] Implement caching strategy
- [ ] Set up CDN for assets
- [ ] Load testing
- [ ] Auto-scaling configuration

**Week 19: Monitoring & Operations**
- [ ] Set up Datadog/New Relic
- [ ] Create dashboards for key metrics
- [ ] Implement alerting
- [ ] Build runbooks for common issues
- [ ] Set up log aggregation

**Week 20: Launch Preparation**
- [ ] Beta testing with pilot customers
- [ ] Bug fixes from beta feedback
- [ ] Final security review
- [ ] Launch preparation
- [ ] Go-live!

---

## 10. Appendices

### Appendix A: Glossary

**Accounting Terms:**
- **Chart of Accounts (COA)**: Organized list of all accounts
- **Journal Entry**: Record of a financial transaction
- **Posting**: Finalizing a journal entry
- **Trial Balance**: Report showing all account balances
- **Fiscal Period**: Accounting time period (usually monthly)
- **COGS**: Cost of Goods Sold
- **GAAP**: Generally Accepted Accounting Principles (USA)
- **NIF**: Normas de Información Financiera (Mexico)

**Mexico-Specific:**
- **CFDI**: Comprobante Fiscal Digital por Internet (digital invoice)
- **SAT**: Servicio de Administración Tributaria (Mexican IRS)
- **PAC**: Proveedor Autorizado de Certificación (authorized timestamping provider)
- **RFC**: Registro Federal de Contribuyentes (Mexican tax ID)
- **IVA**: Impuesto al Valor Agregado (VAT)
- **ISR**: Impuesto Sobre la Renta (income tax)

### Appendix B: API Rate Limits

| Plan | Requests/Hour | Burst | Webhook Deliveries/Hour |
|------|---------------|-------|-------------------------|
| Free | 100 | 10 | N/A |
| Starter | 1,000 | 50 | 500 |
| Professional | 10,000 | 100 | 5,000 |
| Business | 50,000 | 500 | 25,000 |
| Enterprise | Unlimited | Custom | Unlimited |

### Appendix C: Data Retention Policy

| Data Type | Retention Period | Storage Tier |
|-----------|-----------------|--------------|
| Journal Entries | Permanent | Hot → Warm after 2 years |
| Invoices/Bills | 7 years minimum | Hot → Warm after 1 year |
| Bank Transactions | 7 years | Hot → Cold after 1 year |
| Audit Logs | 7 years | Hot → Cold after 6 months |
| User Sessions | 90 days | Hot |
| Webhook Deliveries | 30 days | Hot |
| Report Cache | Until invalidated | Redis |

---

## Document End

**Total Pages**: 150+ (estimated)
**Version**: 1.0
**Last Updated**: 2026-04-11

For questions or clarifications, contact the engineering team.

