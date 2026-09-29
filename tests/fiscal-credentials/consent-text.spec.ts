import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { CONSENT_TEXT, CONSENT_VERSION } from '../../src/services/fiscal-credentials/service.js';

// ============================================================
// MNE-001-076 (#313) · THE e.firma CONSENT SAYS WHAT THE SYSTEM DOES.
//
// The owner's scope decision MNE-001-140 (#312) put two uses of the e.firma
// inside the MVP: authenticating with the SAT to download CFDI and their
// metadata, and sealing the Anexo 24 files only under
// `efirma_sellado_contabilidad_electronica = sellar_con_custodia`. Filing
// stays manual in the SAT portal. The text a taxpayer accepts must say
// exactly that; version 2026-08-1 said «nothing else, we will not sign».
// ============================================================

const PREVIOUS_VERSION = '2026-08-1';

describe('CONSENT_TEXT v2', () => {
  it('bumps CONSENT_VERSION past the version whose text promised no signing', () => {
    expect(CONSENT_VERSION).not.toBe(PREVIOUS_VERSION);
    expect(CONSENT_VERSION > PREVIOUS_VERSION).toBe(true);
  });

  it('names the download of CFDI and their metadata as a use', () => {
    expect(CONSENT_TEXT).toMatch(/download/i);
    expect(CONSENT_TEXT).toMatch(/metadata/i);
  });

  it('names the Anexo 24 sealing and ties it to sellar_con_custodia', () => {
    expect(CONSENT_TEXT).toMatch(/Anexo 24/);
    expect(CONSENT_TEXT).toMatch(/sellar_con_custodia/);
  });

  it('says that filing with the SAT stays manual in the SAT portal', () => {
    expect(CONSENT_TEXT).toMatch(/SAT portal/);
    expect(CONSENT_TEXT).toMatch(/manual/i);
  });

  it('no longer promises that the e.firma is used for nothing else, or never signs', () => {
    expect(CONSENT_TEXT).not.toMatch(/Nothing else/i);
    expect(CONSENT_TEXT).not.toMatch(/We will not sign/i);
  });
});
