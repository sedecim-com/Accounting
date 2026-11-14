import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import xmlIngestionRouter from '../../src/api/rest/routes/xml-ingestion.js';

// ============================================================
// #588 · GET /v1/xml-documents/:id CROSSED THE ENTITY BOUNDARY
//
// RLS bounds by tenant, and the two legal entities of a firm share the tenant,
// so the route read a sibling's CFDI (and its lines) by id. The session below
// grants the first entity only. Same three checks as the TEN-10 spec: the
// sibling's id answers 404, that 404 is indistinguishable from a nonexistent
// id, and the caller's own document still answers 200 with its lines (without
// that counterweight, a route that always 404s would pass).
// ============================================================

let f: Fixture;
let sibling: Fixture;
let s: Servidor;

beforeAll(async () => {
  f = await crearInquilino('588 xml by id');
  sibling = await crearEntidadHermana(f, '588 the sibling');
  s = await levantar([['/v1', xmlIngestionRouter]], sesionDe(f));
}, 120_000);

afterAll(async () => {
  await s.cerrar();
  await closeDatabase();
});

/** A synthetic CFDI of the given entity with one line. */
async function documentOf(fx: Fixture): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO xml_documents (id, entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
       emisor_rfc, receptor_rfc, subtotal, total, xml_content, xml_hash, import_source)
     VALUES ($1, $2, 'cfdi_ingreso', $3, '4.0', NOW(), 'AAA010101AAA', 'XAXX010101000',
       100, 116, '<cfdi:Comprobante/>', $4, 'manual_upload')`,
    [id, fx.entityId, randomUUID(), randomUUID().replace(/-/g, '')]
  );
  await query(
    `INSERT INTO xml_document_lines (xml_document_id, line_number, clave_prod_serv, clave_unidad,
       descripcion, cantidad, valor_unitario, importe)
     VALUES ($1, 1, '01010101', 'H87', 'synthetic line', 1, 100, 100)`,
    [id]
  );
  return id;
}

describe('#588 · an XML document read by id stays inside the caller entity', () => {
  it("answers 404 for the sibling entity's document, the same 404 as a nonexistent id", async () => {
    const foreign = await documentOf(sibling);

    const r = await pedir(s, 'GET', `/v1/xml-documents/${foreign}`);
    expect(r.status, JSON.stringify(r.body)).toBe(404);

    // The message carries the id the caller sent, which it already knows;
    // nothing else may differ, or the 404 still says "exists, not yours".
    const ghostId = randomUUID();
    const ghost = await pedir(s, 'GET', `/v1/xml-documents/${ghostId}`);
    expect(ghost.status).toBe(404);
    const withoutId = (b: unknown, id: string): string => JSON.stringify(b).split(id).join('<id>');
    expect(withoutId(r.body.errors, foreign)).toBe(withoutId(ghost.body.errors, ghostId));
  });

  it("answers 404 for another tenant's document, the same 404 as a nonexistent id", async () => {
    const other = await crearInquilino('588 another tenant');
    const foreign = await documentOf(other);

    const r = await pedir(s, 'GET', `/v1/xml-documents/${foreign}`);
    expect(r.status, JSON.stringify(r.body)).toBe(404);

    const ghostId = randomUUID();
    const ghost = await pedir(s, 'GET', `/v1/xml-documents/${ghostId}`);
    const withoutId = (b: unknown, id: string): string => JSON.stringify(b).split(id).join('<id>');
    expect(withoutId(r.body.errors, foreign)).toBe(withoutId(ghost.body.errors, ghostId));
  });

  it('COUNTERWEIGHT: the own document answers 200 with its lines', async () => {
    const own = await documentOf(f);

    const r = await pedir(s, 'GET', `/v1/xml-documents/${own}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const data = r.body.data as { id: string; lines: Array<{ line_number: number }> };
    expect(data.id).toBe(own);
    expect(data.lines.map((l) => l.line_number)).toEqual([1]);
  });
});
