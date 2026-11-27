import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { answerHeldDecision } from '../../src/services/xml-ingestion/decision-answers.js';
import { codePreRegistration } from '../../src/services/xml-ingestion/pre-registration-coding.js';
import { getClassificationTrail } from '../../src/services/xml-ingestion/cfdi-query-service.js';
import xmlIngestionRouter from '../../src/api/rest/routes/xml-ingestion.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';

// ============================================================
// MNE-001-906 (#1075), part 1 of 2 · A PERSON ANSWERS A HELD CFDI, PER DOCUMENT.
//
// Measured before, on develop 3c45cb8d: a received CFDI paid in cash above the
// LISR 27-III limit (FormaPago 01, 5,000.00 + 800.00 = 5,800.00) is held by
// `bill inbox run` with «Requires a decision: efectivo_no_deducible», and no
// caller could hand the classifier the answer: the door passed four panel keys
// and nothing else. The CFDI could not enter by the inbox at all.
//
// Now `bill inbox answer <id> <decision> <value>` (and its REST twin) keeps the
// answer in the classification trail, with who gave it and when, and the next
// run uses it. Under `gasto` the CFDI posts as any other expense. Under
// `no_deducible` the answer is kept and the CFDI stays held: its entry (expense
// and IVA to the non-deductible account) is part 2. Synthetic data only.
// ============================================================

const service = new PreRegistrationService();
const GOLDEN = fs.readFileSync(path.resolve(__dirname, '../golden/cfdi/pue-recibido.xml'), 'utf-8');

/** The golden received cleaning service (3,500.00 + 560.00, FormaPago 03), scaled to `subtotal` + 16 %. */
function cfdi(subtotal: string, vat: string, total: string, paymentForm = '03'): string {
  return GOLDEN.replace('FormaPago="03"', `FormaPago="${paymentForm}"`)
    .replace('SubTotal="3500.00" Total="4060.00"', `SubTotal="${subtotal}" Total="${total}"`)
    .replace('ValorUnitario="3500.00" Importe="3500.00"', `ValorUnitario="${subtotal}" Importe="${subtotal}"`)
    .replace('TotalImpuestosTrasladados="560.00"', `TotalImpuestosTrasladados="${vat}"`)
    .replace('Base="3500.00"', `Base="${subtotal}"`)
    .replace('Importe="560.00"', `Importe="${vat}"`)
    .replace('UUID="11A1A1A1-0001-4A01-8A01-A1A1A1A1A001"', `UUID="${uuidv4().toUpperCase()}"`);
}
/** The same CFDI with another product key: 15101514 is fuel, 84111506 the advance-payment key. */
const keyed = (xml: string, productKey: string) => xml.replace('ClaveProdServ="76111501"', `ClaveProdServ="${productKey}"`);
/** Cash above the limit: held on `efectivo_no_deducible`. */
const cash = () => cfdi('5000.00', '800.00', '5800.00', '01');
/** Over the default capitalization threshold (20,000): held on `gasto_vs_activo`. */
const large = () => cfdi('25000.00', '4000.00', '29000.00');

let f: Fixture;
let other: Fixture;

/** Uploads the CFDI of a vendor already in the catalog, ready, with 6100 as its default account. */
async function upload(xml: string, fx: Fixture = f): Promise<{ id: string; uuid: string }> {
  const up = await service.processXMLUpload(fx.entityId, xml, 'api', fx.userId);
  const id = up.preRegistration.id as string;
  await query(
    `UPDATE pre_registrations SET status = 'ready', default_account_id = $3 WHERE id = $1 AND entity_id = $2`,
    [id, fx.entityId, fx.cuentas['6100']]
  );
  return { id, uuid: /UUID="([^"]+)"/.exec(xml)![1] };
}

/** `bill inbox run <id>`, as its service: the row read fresh and run to accounting. */
async function run(id: string, fx: Fixture = f): Promise<{ bill?: Record<string, unknown> }> {
  const row = await query<Record<string, unknown>>(
    `SELECT * FROM pre_registrations WHERE id = $1 AND entity_id = $2`, [id, fx.entityId]
  );
  return service.processToAccounting(row.rows[0], fx.userId, { permitirProveedorNuevo: false });
}

/** The entry of the bill a pre-registration became, as `code debit/credit`; [] while it has none. */
async function entryOf(id: string): Promise<string[]> {
  const { rows } = await query<{ line: string }>(
    `SELECT a.code || ' ' || COALESCE(l.debit_amount, 0)::numeric(19,2) || '/' || COALESCE(l.credit_amount, 0)::numeric(19,2) AS line
       FROM pre_registrations pr
       JOIN journal_entry_lines l ON l.journal_entry_id = pr.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE pr.id = $1 AND pr.entity_id = $2 ORDER BY a.code`,
    [id, f.entityId]
  );
  return rows.map((r) => r.line);
}

interface TrailDecision { id: string; answer?: string; answered_by?: string; answered_at?: string; options?: Array<{ value: string }> }
const decisionsOf = async (uuid: string) => (await getClassificationTrail(f.entityId, uuid)).decisions as TrailDecision[];

async function cli(...argv: string[]): Promise<{ exitCode?: number; out: string; err: string }> {
  const program = new Command('mnemosine').exitOverride();
  let exitCode: number | undefined;
  const same = (s: string) => s;
  const err: string[] = [];
  const deps = {
    palette: { dim: same, bold: same, cyan: same, red: same, green: same, yellow: same } as never,
    shutdown: (c: number) => { exitCode = c; },
    reportError: (e: unknown) => { err.push((e as Error).message); },
    confirm: () => Promise.resolve(true),
  };
  registerBillCommand(program, deps);
  const out: string[] = [];
  const [stdout, stderr] = [process.stdout.write.bind(process.stdout), process.stderr.write.bind(process.stderr)];
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    await program.parseAsync(['node', 'mnemosine', ...argv, '--entity', f.entityId, '--tenant', f.tenantId]);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return { exitCode, out: out.join(''), err: err.join('') };
}

async function vendorOf(fx: Fixture): Promise<void> {
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-906', 'Limpieza Corporativa del Centro SA de CV', 'LIM040404LM8', 'rfc', 'MXN', $3)`,
    [uuidv4(), fx.entityId, fx.userId]
  );
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-906 inbox answer');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await vendorOf(f);
  other = await crearInquilino('MNE-001-906 another tenant');
  await seedPolicies({ tenantId: other.tenantId, entityId: other.entityId });
  await vendorOf(other);
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('cash above the limit: the person answers efectivo_no_deducible for one CFDI', () => {
  it('held, the refusal names the command and the options; answered «gasto», the run posts it and the trail keeps the answer', async () => {
    const doc = await upload(cash());
    const held = await run(doc.id).catch((e: Error) => e);
    expect(held).toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    expect((held as Error).message).toContain('Requires a decision: efectivo_no_deducible');
    expect((held as Error).message).toContain(`mnemosine bill inbox answer ${doc.id} <decision> <value>`);
    expect((held as Error).message).toContain('efectivo_no_deducible = no_deducible | gasto');
    expect(await entryOf(doc.id)).toEqual([]);

    const answered = await answerHeldDecision(f.entityId, doc.id, { decision: 'efectivo_no_deducible', answer: 'gasto' }, f.userId);
    expect(answered).toMatchObject({ decision: 'efectivo_no_deducible', answer: 'gasto', answeredBy: f.userId, entryPending: false });

    expect((await run(doc.id)).bill).toBeDefined();
    // Today's entry of a PUE expense that is not cash: 5,000.00 + 800.00 parked until it is paid.
    expect(await entryOf(doc.id)).toEqual(['1135 800.00/0.00', '2110 0.00/5800.00', '6100 5000.00/0.00']);

    const trail = await getClassificationTrail(f.entityId, doc.uuid);
    expect(trail.status).toBe('posted');
    const kept = (trail.decisions as TrailDecision[]).filter((d) => d.id === 'efectivo_no_deducible');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ answer: 'gasto', answered_by: f.userId });
    expect(Date.parse(kept[0].answered_at!)).toBeGreaterThan(Date.parse('2026-01-01'));
    // Posted, the question is closed.
    await expect(
      answerHeldDecision(f.entityId, doc.id, { decision: 'efectivo_no_deducible', answer: 'no_deducible' }, f.userId)
    ).rejects.toMatchObject({ code: 'CFDI_ANSWER_NOT_OPEN' });
  }, 120_000);

  it('answered «no_deducible», the answer is kept and the CFDI stays held: nothing is posted until its entry exists', async () => {
    const doc = await upload(cash());
    await expect(run(doc.id)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    const answered = await answerHeldDecision(f.entityId, doc.id, { decision: 'efectivo_no_deducible', answer: 'no_deducible' }, f.userId);
    expect(answered.entryPending).toBe(true);

    await expect(run(doc.id)).rejects.toMatchObject({
      code: 'CFDI_REQUIERE_DECISION',
      messageKey: {
        key: 'error.CFDI_REQUIERE_DECISION.non_deductible_entry_pending',
        params: { decision: 'efectivo_no_deducible', answer: 'no_deducible' },
      },
    });
    expect(await entryOf(doc.id)).toEqual([]);
    expect((await query(`SELECT 1 FROM bills WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, doc.uuid])).rowCount).toBe(0);
    const trail = await getClassificationTrail(f.entityId, doc.uuid);
    expect(trail.status).toBe('blocked');
    expect((trail.decisions as TrailDecision[]).find((d) => d.id === 'efectivo_no_deducible')).toMatchObject({ answer: 'no_deducible' });

    // The person can still say the CFDI's payment form was wrong: the last answer stands.
    await answerHeldDecision(f.entityId, doc.id, { decision: 'efectivo_no_deducible', answer: 'gasto' }, f.userId);
    expect((await run(doc.id)).bill).toBeDefined();
    expect(await entryOf(doc.id)).toEqual(['1135 800.00/0.00', '2110 0.00/5800.00', '6100 5000.00/0.00']);
  }, 120_000);
});

describe('the same verb answers any blocking decision whose options say where they post', () => {
  it('gasto_vs_activo, by the CLI: answered and run, 25,000.00 + 4,000.00 posts as a period expense', async () => {
    const doc = await upload(large());
    const held = await cli('bill', 'inbox', 'run', doc.id, '--yes');
    expect(held.exitCode).toBe(11);
    expect(held.out).toContain('gasto_vs_activo = activo_fijo | gasto');

    const answered = await cli('bill', 'inbox', 'answer', doc.id, 'gasto_vs_activo', 'gasto');
    expect(answered.exitCode ?? 0, answered.err).toBe(0);
    expect(answered.out).toContain('gasto_vs_activo = gasto');
    expect(answered.err).toContain(`mnemosine bill inbox run ${doc.id}`);

    expect((await cli('bill', 'inbox', 'run', doc.id, '--yes')).exitCode ?? 0).toBe(0);
    expect(await entryOf(doc.id)).toEqual(['1135 4000.00/0.00', '2110 0.00/29000.00', '6100 25000.00/0.00']);
    expect((await decisionsOf(doc.uuid)).find((d) => d.id === 'gasto_vs_activo')).toMatchObject({ answer: 'gasto' });
  }, 120_000);

  it('a CFDI held on two decisions waits for both answers: fuel in cash above the limit', async () => {
    const doc = await upload(keyed(cash(), '15101514'));
    const held = await run(doc.id).catch((e: Error) => e);
    expect((held as Error).message).toContain('efectivo_no_deducible = no_deducible | gasto; combustible_efectivo = no_deducible | gasto');

    await answerHeldDecision(f.entityId, doc.id, { decision: 'efectivo_no_deducible', answer: 'gasto' }, f.userId);
    const still = await run(doc.id).catch((e: Error) => e);
    expect((still as Error).message).toContain('Requires a decision: combustible_efectivo');
    expect((still as Error).message).not.toContain('efectivo_no_deducible =');
    expect((await decisionsOf(doc.uuid)).map((d) => `${d.id}:${d.answer ?? '?'}`)).toEqual([
      'efectivo_no_deducible:gasto', 'combustible_efectivo:?',
    ]);

    // One «no_deducible» among the answers keeps it held, whichever decision carries it.
    await answerHeldDecision(f.entityId, doc.id, { decision: 'combustible_efectivo', answer: 'no_deducible' }, f.userId);
    await expect(run(doc.id)).rejects.toMatchObject({
      messageKey: { key: 'error.CFDI_REQUIERE_DECISION.non_deductible_entry_pending', params: { decision: 'combustible_efectivo' } },
    });
    await answerHeldDecision(f.entityId, doc.id, { decision: 'combustible_efectivo', answer: 'gasto' }, f.userId);
    expect((await run(doc.id)).bill).toBeDefined();
    expect(await entryOf(doc.id)).toEqual(['1135 800.00/0.00', '2110 0.00/5800.00', '6100 5000.00/0.00']);
  }, 120_000);

  it('an answer the proposed entry does not follow keeps the CFDI held: an advance answered «gasto»', async () => {
    const doc = await upload(keyed(cfdi('1000.00', '160.00', '1160.00'), '84111506'));
    await expect(run(doc.id)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    // Measured: the advance case has no expense line, so the classifier's entry is the advance's under either answer.
    await answerHeldDecision(f.entityId, doc.id, { decision: 'anticipo_o_gasto', answer: 'gasto' }, f.userId);
    await expect(run(doc.id)).rejects.toMatchObject({
      code: 'CFDI_REQUIERE_DECISION',
      messageKey: {
        key: 'error.CFDI_REQUIERE_DECISION.answer_not_followed',
        params: { decision: 'anticipo_o_gasto', answer: 'gasto', role: 'gasto' },
      },
    });
    expect(await entryOf(doc.id)).toEqual([]);

    await answerHeldDecision(f.entityId, doc.id, { decision: 'anticipo_o_gasto', answer: 'anticipo' }, f.userId);
    expect((await run(doc.id)).bill).toBeDefined();
    // 1,000.00 to advances to vendors (1150) and its 160.00 where the advance case posts it.
    expect(await entryOf(doc.id)).toEqual(['1130 160.00/0.00', '1150 1000.00/0.00', '2110 0.00/1160.00']);
  }, 120_000);

  it('«activo_fijo» is held while the lines are coded to another account, and posts once they are coded to the role\'s', async () => {
    const doc = await upload(large());
    await expect(run(doc.id)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    await answerHeldDecision(f.entityId, doc.id, { decision: 'gasto_vs_activo', answer: 'activo_fijo' }, f.userId);
    // The plan opens the expense line into the document's coded lines: 6100 here, not the role's 1210.
    await expect(run(doc.id)).rejects.toMatchObject({
      code: 'CFDI_REQUIERE_DECISION',
      messageKey: {
        key: 'error.CFDI_REQUIERE_DECISION.answer_entry_not_built',
        params: { decision: 'gasto_vs_activo', answer: 'activo_fijo', role: 'activo_fijo', account: '1210', id: doc.id },
      },
    });
    expect(await entryOf(doc.id)).toEqual([]);
    expect((await query(`SELECT 1 FROM bills WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, doc.uuid])).rowCount).toBe(0);
    const trail = await getClassificationTrail(f.entityId, doc.uuid);
    expect(trail.status).toBe('blocked');
    expect((trail.decisions as TrailDecision[]).find((d) => d.id === 'gasto_vs_activo')).toMatchObject({ answer: 'activo_fijo' });
    const waits = await query<{ error_message: string }>(
      `SELECT error_message FROM pre_registrations WHERE id = $1 AND entity_id = $2`, [doc.id, f.entityId]
    );
    expect(waits.rows[0].error_message).toContain('gasto_vs_activo = activo_fijo');

    // `bill inbox edit <id> --line 1 --account 1210`: the amount now lands on the account of the role.
    await codePreRegistration(f.entityId, doc.id, { line: { lineNumber: 1, accountId: f.cuentas['1210'] } });
    expect((await run(doc.id)).bill).toBeDefined();
    expect(await entryOf(doc.id)).toEqual(['1135 4000.00/0.00', '1210 25000.00/0.00', '2110 0.00/29000.00']);
  }, 120_000);

  it('through REST too: POST /v1/pre-registrations/:id/answer, then /process', async () => {
    const doc = await upload(cash());
    const s = await levantar([['/v1', xmlIngestionRouter]], sesionDe(f));
    try {
      expect((await pedir(s, 'POST', `/v1/pre-registrations/${doc.id}/process`, {})).status).toBe(422);
      const bad = await pedir(s, 'POST', `/v1/pre-registrations/${doc.id}/answer`, { decision: 'efectivo_no_deducible', answer: 'maybe' });
      expect(bad.status).toBe(422);
      expect(JSON.stringify(bad.body)).toContain('no_deducible, gasto');
      const ok = await pedir(s, 'POST', `/v1/pre-registrations/${doc.id}/answer`, { decision: 'efectivo_no_deducible', answer: 'gasto' });
      expect(ok.status).toBe(200);
      expect((ok.body as { data: Record<string, unknown> }).data).toMatchObject({
        pre_registration_id: doc.id, decision: 'efectivo_no_deducible', answer: 'gasto', answered_by: f.userId, entry_pending: false,
      });
      expect((await pedir(s, 'POST', `/v1/pre-registrations/${doc.id}/process`, {})).status).toBe(200);
    } finally {
      await s.cerrar();
    }
    expect(await entryOf(doc.id)).toEqual(['1135 800.00/0.00', '2110 0.00/5800.00', '6100 5000.00/0.00']);
  }, 120_000);
});

describe('what the verb refuses, by key', () => {
  let doc: { id: string; uuid: string };
  const answer = (decision: string, value: string, fx: Fixture = f, id = doc.id) =>
    answerHeldDecision(fx.entityId, id, { decision, answer: value }, fx.userId);

  beforeAll(async () => {
    doc = await upload(cash());
  });

  it('a CFDI no run has held yet has nothing to answer', async () => {
    await expect(answer('efectivo_no_deducible', 'gasto')).rejects.toMatchObject({
      code: 'CFDI_ANSWER_INVALID',
      messageKey: { key: 'error.CFDI_ANSWER_INVALID.not_asked', params: { decision: 'efectivo_no_deducible', held: 'none' } },
    });
    await expect(run(doc.id)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
  });

  it('a decision the CFDI is not held on, naming the ones it is', async () => {
    for (const decision of ['combustible_efectivo', 'no_such_decision']) {
      await expect(answer(decision, 'gasto')).rejects.toMatchObject({
        messageKey: { key: 'error.CFDI_ANSWER_INVALID.not_asked', params: { decision, held: 'efectivo_no_deducible' } },
      });
    }
  });

  it('an option that is not in the list the decision offered, naming the valid ones', async () => {
    await expect(answer('efectivo_no_deducible', 'deducible')).rejects.toMatchObject({
      code: 'CFDI_ANSWER_INVALID',
      messageKey: {
        key: 'error.CFDI_ANSWER_INVALID.unknown_option',
        params: { decision: 'efectivo_no_deducible', value: 'deducible', options: 'no_deducible, gasto' },
      },
    });
    // The valid ones are those the trail offered: inventory is not offered to a firm that keeps none.
    const asset = await upload(large());
    await expect(run(asset.id)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    await expect(answer('gasto_vs_activo', 'inventario', f, asset.id)).rejects.toMatchObject({
      messageKey: { params: { options: 'activo_fijo, gasto' } },
    });
    expect((await decisionsOf(doc.uuid)).every((d) => d.answer === undefined)).toBe(true);
  }, 60_000);

  it('a decision whose options post nowhere is not answered per document: «do not record» would release the CFDI', async () => {
    const cancelled = await upload(cfdi('1000.00', '160.00', '1160.00'));
    await query(
      `UPDATE xml_documents x SET sat_validation_status = 'cancelled'
         FROM pre_registrations pr WHERE pr.id = $1 AND pr.entity_id = $2 AND x.id = pr.xml_document_id`,
      [cancelled.id, f.entityId]
    );
    await expect(run(cancelled.id)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    for (const value of ['rechazar', 'registrar']) {
      await expect(answer('cfdi_cancelado', value, f, cancelled.id)).rejects.toMatchObject({
        code: 'CFDI_ANSWER_INVALID',
        messageKey: { key: 'error.CFDI_ANSWER_INVALID.not_per_document', params: { decision: 'cfdi_cancelado' } },
      });
    }
    await expect(run(cancelled.id)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    expect(await entryOf(cancelled.id)).toEqual([]);
  }, 60_000);

  it('the pre-registration of another tenant does not exist here, and its trail is never read', async () => {
    const theirs = await upload(cash(), other);
    await expect(run(theirs.id, other)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    await expect(answer('efectivo_no_deducible', 'gasto', f, theirs.id)).rejects.toMatchObject({ statusCode: 404 });
    const kept = await getClassificationTrail(other.entityId, theirs.uuid);
    expect((kept.decisions as TrailDecision[]).every((d) => d.answer === undefined)).toBe(true);
  }, 60_000);

  it('the CLI says each refusal and writes nothing', async () => {
    const bad = await cli('bill', 'inbox', 'answer', doc.id, 'efectivo_no_deducible', 'deducible');
    expect(bad.exitCode).not.toBe(0);
    expect(bad.err).toContain('no_deducible, gasto');
    expect((await cli('bill', 'inbox', 'answer', 'not-a-uuid', 'efectivo_no_deducible', 'gasto')).exitCode).not.toBe(0);
    expect((await decisionsOf(doc.uuid)).every((d) => d.answer === undefined)).toBe(true);
  });
});
