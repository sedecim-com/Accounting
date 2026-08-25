import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, currentTenant } from '../../database/connection.js';
import { createJournalEntry, attestEntryAsync } from '../accounting/posting.js';
import { AccountingError, ErrorCodes } from '../../utils/errors.js';
import type { InventoryItem, InventoryLayer, InventoryCostingMethod } from '../../types/index.js';
import { JournalEntryType } from '../../types/index.js';

interface COGSResult {
  total_cost: string;
  layers_consumed: Array<{
    layer_id: string;
    quantity_consumed: string;
    unit_cost: string;
    total_cost: string;
  }>;
}

// FIFO: consume oldest layers first
export async function calculateFIFO(itemId: string, quantity: number): Promise<COGSResult> {
  const layers = await query<InventoryLayer>(
    `SELECT * FROM inventory_layers
     WHERE item_id = $1 AND remaining_quantity > 0
     ORDER BY acquired_date ASC`,
    [itemId]
  );

  return consumeLayers(layers.rows, quantity);
}

// LIFO: consume newest layers first
export async function calculateLIFO(itemId: string, quantity: number): Promise<COGSResult> {
  const layers = await query<InventoryLayer>(
    `SELECT * FROM inventory_layers
     WHERE item_id = $1 AND remaining_quantity > 0
     ORDER BY acquired_date DESC`,
    [itemId]
  );

  return consumeLayers(layers.rows, quantity);
}

// Weighted Average
export async function calculateWeightedAverage(itemId: string, quantity: number): Promise<COGSResult> {
  const result = await query<{ total_quantity: string; total_value: string }>(
    `SELECT
      SUM(remaining_quantity) as total_quantity,
      SUM(remaining_quantity * unit_cost) as total_value
     FROM inventory_layers
     WHERE item_id = $1 AND remaining_quantity > 0`,
    [itemId]
  );

  const totalQty = new Decimal(result.rows[0].total_quantity || '0');
  const totalValue = new Decimal(result.rows[0].total_value || '0');

  if (totalQty.lessThan(quantity)) {
    throw new AccountingError(ErrorCodes.INSUFFICIENT_INVENTORY, 'Insufficient inventory');
  }

  const avgCost = totalValue.dividedBy(totalQty);
  const totalCost = avgCost.times(quantity);

  // Reduce all layers proportionally
  const layers = await query<InventoryLayer>(
    `SELECT * FROM inventory_layers WHERE item_id = $1 AND remaining_quantity > 0`,
    [itemId]
  );

  const reductionRatio = new Decimal(quantity).dividedBy(totalQty);
  const layersConsumed = layers.rows.map((layer) => {
    const consumed = new Decimal(layer.remaining_quantity).times(reductionRatio);
    return {
      layer_id: layer.id,
      quantity_consumed: consumed.toFixed(4),
      unit_cost: avgCost.toFixed(4),
      total_cost: consumed.times(avgCost).toFixed(4),
    };
  });

  return { total_cost: totalCost.toFixed(4), layers_consumed: layersConsumed };
}

// Specific Identification
export async function calculateSpecificId(
  layerIds: string[],
  quantities: number[]
): Promise<COGSResult> {
  const layers = await query<InventoryLayer>(
    `SELECT * FROM inventory_layers WHERE id = ANY($1)`,
    [layerIds]
  );

  let totalCost = new Decimal(0);
  const layersConsumed = [];

  for (let i = 0; i < layerIds.length; i++) {
    const layer = layers.rows.find((l) => l.id === layerIds[i]);
    if (!layer) throw new AccountingError('LAYER_NOT_FOUND', `Layer ${layerIds[i]} not found`);

    const qty = new Decimal(quantities[i]);
    const cost = qty.times(new Decimal(layer.unit_cost));
    totalCost = totalCost.plus(cost);

    layersConsumed.push({
      layer_id: layer.id,
      quantity_consumed: qty.toFixed(4),
      unit_cost: layer.unit_cost,
      total_cost: cost.toFixed(4),
    });
  }

  return { total_cost: totalCost.toFixed(4), layers_consumed: layersConsumed };
}

function consumeLayers(layers: InventoryLayer[], quantity: number): COGSResult {
  let remainingQty = new Decimal(quantity);
  let totalCost = new Decimal(0);
  const consumed: COGSResult['layers_consumed'] = [];

  for (const layer of layers) {
    if (remainingQty.lessThanOrEqualTo(0)) break;

    const available = new Decimal(layer.remaining_quantity);
    const toConsume = Decimal.min(available, remainingQty);
    const cost = toConsume.times(new Decimal(layer.unit_cost));

    totalCost = totalCost.plus(cost);
    remainingQty = remainingQty.minus(toConsume);

    consumed.push({
      layer_id: layer.id,
      quantity_consumed: toConsume.toFixed(4),
      unit_cost: layer.unit_cost,
      total_cost: cost.toFixed(4),
    });
  }

  if (remainingQty.greaterThan(0)) {
    throw new AccountingError(ErrorCodes.INSUFFICIENT_INVENTORY, 'Insufficient inventory');
  }

  return { total_cost: totalCost.toFixed(4), layers_consumed: consumed };
}

// Record inventory purchase
export async function recordInventoryPurchase(
  itemId: string,
  quantity: number,
  unitCost: number,
  referenceType?: string,
  referenceId?: string
): Promise<InventoryLayer> {
  const totalCost = new Decimal(quantity).times(unitCost);

  const result = await query<InventoryLayer>(
    `INSERT INTO inventory_layers (
      id, item_id, acquired_date, quantity, remaining_quantity,
      unit_cost, total_cost, reference_type, reference_id
    ) VALUES ($1, $2, NOW(), $3, $3, $4, $5, $6, $7) RETURNING *`,
    [uuidv4(), itemId, quantity, unitCost, totalCost.toFixed(4), referenceType || null, referenceId || null]
  );

  // Update item totals
  await query(
    `UPDATE inventory_items SET
      current_quantity = current_quantity + $1,
      current_value = current_value + $2,
      average_unit_cost = (current_value + $2) / NULLIF(current_quantity + $1, 0)
     WHERE id = $3`,
    [quantity, totalCost.toFixed(4), itemId]
  );

  return result.rows[0];
}

// Record inventory sale
export async function recordInventorySale(
  itemId: string,
  quantity: number,
  salePrice: number,
  entityId: string,
  userId: string,
  arAccountId: string
): Promise<COGSResult> {
  const item = await query<InventoryItem>(
    'SELECT * FROM inventory_items WHERE id = $1',
    [itemId]
  );

  if (item.rows.length === 0) throw new AccountingError('ITEM_NOT_FOUND', 'Inventory item not found');

  const inventoryItem = item.rows[0];
  let cogsResult: COGSResult;

  switch (inventoryItem.costing_method) {
    case 'fifo': cogsResult = await calculateFIFO(itemId, quantity); break;
    case 'lifo': cogsResult = await calculateLIFO(itemId, quantity); break;
    case 'weighted_average': cogsResult = await calculateWeightedAverage(itemId, quantity); break;
    default: cogsResult = await calculateFIFO(itemId, quantity);
  }

  // The JE is created with THIS transaction's client: before, it committed on
  // a separate pool connection, so an abort after creating it left a GL sale
  // the inventory subledger never recorded (plus pool self-deadlock risk).
  const createdEntryId = await withTransaction(async (client) => {
    // Update layers
    for (const consumed of cogsResult.layers_consumed) {
      await client.query(
        `UPDATE inventory_layers SET remaining_quantity = remaining_quantity - $1 WHERE id = $2`,
        [consumed.quantity_consumed, consumed.layer_id]
      );

      await client.query(
        `INSERT INTO inventory_layer_consumption (
          id, layer_id, item_id, quantity_consumed, unit_cost, total_cost, reference_type
        ) VALUES ($1, $2, $3, $4, $5, $6, 'sale')`,
        [uuidv4(), consumed.layer_id, itemId, consumed.quantity_consumed, consumed.unit_cost, consumed.total_cost]
      );
    }

    // Update item totals
    await client.query(
      `UPDATE inventory_items SET
        current_quantity = current_quantity - $1,
        current_value = current_value - $2
       WHERE id = $3`,
      [quantity, cogsResult.total_cost, itemId]
    );

    // Create journal entry: DR AR, CR Revenue, DR COGS, CR Inventory
    const revenue = new Decimal(quantity).times(salePrice);
    const je = await createJournalEntry(
      entityId,
      new Date(),
      JournalEntryType.AUTO_INVOICE,
      `Inventory sale - ${inventoryItem.item_name}`,
      [
        { account_id: arAccountId, debit_amount: revenue.toFixed(4), credit_amount: null, description: 'Accounts Receivable' },
        { account_id: inventoryItem.revenue_account_id, debit_amount: null, credit_amount: revenue.toFixed(4), description: 'Sales Revenue' },
        { account_id: inventoryItem.cogs_account_id, debit_amount: cogsResult.total_cost, credit_amount: null, description: 'Cost of Goods Sold' },
        { account_id: inventoryItem.inventory_account_id, debit_amount: null, credit_amount: cogsResult.total_cost, description: 'Inventory' },
      ],
      userId,
      { sourceType: 'inventory_sale', sourceId: itemId, autoPost: true, client }
    );
    return je.id;
  });

  // Caller-owned client means caller-owned attestation, AFTER commit.
  const tenantId = currentTenant();
  if (tenantId) attestEntryAsync(tenantId, entityId, createdEntryId);

  return cogsResult;
}
