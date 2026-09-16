import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { updateDraftEntry } from '../../src/services/accounting/journal-entry-service.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// X1a · EDITING A DRAFT MUST NOT SILENTLY DROP ITS DIMENSIONS
//
// `journal_entry_lines` carries `cost_center_id` and `project_id`, and three
// paths write them: REST `POST /journal-entries`, the AP/AR document posting,
// and the CFDI plan. The general ledger reads them back and hands them to the
// client, so they are not decoration: somebody typed them and somebody reads
// them.
//
// Editing a DRAFT replaces all of its lines — DELETE, then INSERT — and the
// INSERT of the edit names seven columns, none of them a dimension. So the
// round trip is: REST creates the draft WITH a cost centre (auto_post: false),
// the CLI edits any line of it, and the cost centre is gone. No error, no
// warning, and the ledger the auditor later reads simply does not have it.
//
// The assertion is deliberately narrow: the SAME line, untouched by the edit,
// must come back with the same dimensions. Asserting on the edited line would
// confuse two questions — whether an edit can CHANGE a dimension (it should be
// able to) with whether an edit DESTROYS one it was never asked to touch.
// ============================================================

let fx: Fixture;
const DRAFT = 3;

/** A cost centre and a project have no master table: any UUID is accepted. */
const COST_CENTRE = randomUUID();
const PROJECT = randomUUID();

async function linesOf(entryId: string) {
  const { rows } = await query<{
    line_number: number;
    account_id: string;
    cost_center_id: string | null;
    project_id: string | null;
    description: string;
  }>(
    `SELECT line_number, account_id, cost_center_id, project_id, description
       FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`,
    [entryId]
  );
  return rows;
}

/** A draft with the dimensions REST would have written on both of its lines. */
async function draftWithDimensions(label: string) {
  const bank = fx.roles.bank ?? fx.cuentas['1110'];
  const entry = await createJournalEntry(
    fx.entityId,
    fechaEnPeriodo(DRAFT),
    JournalEntryType.STANDARD,
    label,
    [
      {
        account_id: fx.cuentas['5100'],
        debit_amount: '1000.0000',
        credit_amount: null,
        description: 'gasto con centro de costo',
        cost_center_id: COST_CENTRE,
        project_id: PROJECT,
      },
      {
        account_id: bank!,
        debit_amount: null,
        credit_amount: '1000.0000',
        description: 'salida de bank',
        cost_center_id: COST_CENTRE,
        project_id: PROJECT,
      },
    ],
    fx.userId,
    { autoPost: false }
  );
  return entry;
}

beforeAll(async () => {
  fx = await crearInquilino('x1a-dimension');
});

afterAll(async () => {
  await closeDatabase();
});

describe('editing a draft does not carry off its dimensions', () => {
  it('the draft is born with the cost centre and project REST wrote', async () => {
    const entry = await draftWithDimensions('X1a alta');
    const lines = await linesOf(entry.id);

    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l.cost_center_id).toBe(COST_CENTRE);
      expect(l.project_id).toBe(PROJECT);
    }
  });

  it('after editing one line s DESCRIPTION, the other keeps its dimension', async () => {
    const entry = await draftWithDimensions('X1a edición');
    const before = await linesOf(entry.id);
    expect(before[1].cost_center_id).toBe(COST_CENTRE);

    // Se reenvían las dos líneas — el contrato del parche es reemplazar todas —
    // cambiando sólo el texto de la primera. La segunda va idéntica.
    await updateDraftEntry(
      fx.entityId,
      entry.id,
      {
        lines: [
          {
            account: '5100',
            debit: '1000.0000',
            description: 'texto corregido',
            cost_center_id: COST_CENTRE,
            project_id: PROJECT,
          },
          {
            account: before[1].account_id,
            credit: '1000.0000',
            description: 'salida de bank',
            cost_center_id: COST_CENTRE,
            project_id: PROJECT,
          },
        ],
      },
      fx.userId
    );

    const after = await linesOf(entry.id);
    expect(after).toHaveLength(2);
    expect(after[0].description).toBe('texto corregido');
    // EL DEFECTO: el INSERT de la edición no nombra las columnas de dimensión,
    // así que las dos líneas vuelven con NULL aunque nadie pidió quitarlas.
    for (const l of after) {
      expect(l.cost_center_id).toBe(COST_CENTRE);
      expect(l.project_id).toBe(PROJECT);
    }
  });

  it('an edit that sends NO dimensions leaves them null, and that is intended', async () => {
    // El parche reemplaza TODAS las líneas: omitir la dimensión es pedir que
    // no la haya. Lo que no puede pasar es que no exista forma de conservarla,
    // que es lo que ocurría before: el campo ni siquiera se podía expresar.
    const entry = await draftWithDimensions('X1a omisión');
    await updateDraftEntry(
      fx.entityId,
      entry.id,
      {
        lines: [
          { account: '5100', debit: '1000.0000', description: 'sin dimensión' },
          { account: fx.roles.bank ?? fx.cuentas['1110'], credit: '1000.0000', description: 'sin dimensión' },
        ],
      },
      fx.userId
    );

    const after = await linesOf(entry.id);
    for (const l of after) {
      expect(l.cost_center_id).toBeNull();
      expect(l.project_id).toBeNull();
    }
  });
});
