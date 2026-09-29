import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';

// #299 (MNE-001-031): what the pre-registration STORES, not only what the
// parser returns. A Mexico City postal code saved as 1000 matches neither the
// SAT catalog nor the customer's address; a folio saved as 123 is not the
// folio the issuer printed. The receiver's name is written with numeric
// character references (#218): `&amp;` would pass even without the fix.

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf8');
const FIXTURE_UUID = 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80';

let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('MNE-001-031 CFDI keys');
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a CFDI key that starts with zero is stored as the issuer wrote it', () => {
  it('stores postal code 01000, folio 000123 and «Crédito SA», and the amounts as numbers', async () => {
    const uuid = uuidv4().toUpperCase();
    const xml = FIXTURE.replace(FIXTURE_UUID, uuid)
      .replace('Folio="2001"', 'Folio="000123"')
      .replace('DomicilioFiscalReceptor="06600"', 'DomicilioFiscalReceptor="01000"')
      .replace('Nombre="Demo Corp MX"', 'Nombre="Cr&#233;dito&#10;SA"');

    await new PreRegistrationService().processXMLUpload(f.entityId, xml, 'api', f.userId);

    const { rows } = await query<Record<string, unknown>>(
      `SELECT receptor_domicilio_fiscal, cfdi_folio, receptor_nombre, forma_pago, total::text AS total
         FROM xml_documents WHERE entity_id = $1 AND cfdi_uuid = $2`,
      [f.entityId, uuid]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      receptor_domicilio_fiscal: '01000',
      cfdi_folio: '000123',
      receptor_nombre: 'Crédito SA',
      forma_pago: '03',
      total: expect.stringMatching(/^9280(\.0+)?$/) as unknown,
    });
  });
});
