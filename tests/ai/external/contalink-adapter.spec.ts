import { describe, it, expect, vi, type Mock } from 'vitest';
import { ContalinkAdapter } from '../../../src/services/integrations/accounting/contalink-adapter.js';
import { ExternalRejectedError, ExternalServiceError } from '../../../src/utils/errors.js';
import { exitCodeFor } from '../../../src/cli/kernel/index.js';
import { ExitCode } from '../../../src/cli/kernel/exit.js';

function fakeFetch(payload: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, json: async () => payload })) as unknown as typeof fetch;
}

describe('ContalinkAdapter', () => {
  it('sends the RAW API key in Authorization (not Bearer) and respects the baseUrl', async () => {
    const f = fakeFetch({ status: 1, trial_balance: { items: [] } });
    const a = new ContalinkAdapter('mi-key', 'https://api.ejemplo/prod', f);
    await a.getTrialBalance('2026-08-01', '2026-08-31');
    const [url, init] = (f as unknown as Mock).mock.calls[0];
    expect(url).toBe('https://api.ejemplo/prod/accounting/trial-balance/?start_date=2026-08-01&end_date=2026-08-31&period=O');
    expect(init.headers.Authorization).toBe('mi-key');
  });

  it('treats status:0 as an ERROR even when the HTTP is 200 (Contalink inverted convention)', async () => {
    const f = fakeFetch({ status: 0, message: 'Invalid API key' });
    const a = new ContalinkAdapter('k', 'https://x', f);
    await expect(a.getTrialBalance('2026-01-01', '2026-01-31')).rejects.toThrow(/Invalid API key/);
  });

  it('normalizes the trial balance: Spanish fields and string amounts → numbers', async () => {
    const f = fakeFetch({
      status: 1,
      trial_balance: {
        items: [
          { cuenta: 'Bancos', cuenta_numero: '102-01', debe: '1,500.50', haber: '500.00', final_saldo: '1000.50' },
        ],
      },
    });
    const a = new ContalinkAdapter('k', 'https://x', f);
    const rows = await a.getTrialBalance('2026-08-01', '2026-08-31');
    expect(rows).toEqual([
      { account_code: '102-01', account_name: 'Bancos', period_debits: 1500.5, period_credits: 500, ending_balance: 1000.5 },
    ]);
  });

  it('creates a manual journal entry with the exact contract (accounting_records, record_date)', async () => {
    const f = fakeFetch({ status: 1, policy_data: {} });
    const a = new ContalinkAdapter('k', 'https://x', f);
    await a.createManualPolicy({
      record_date: '2026-08-24', description: 'Ajuste',
      records: [{ account_code: '601-01', debit: 100, credit: 0 }],
    });
    const [url, init] = (f as unknown as Mock).mock.calls[0];
    expect(url).toBe('https://x/accounting/manual-accounting-policy/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      record_date: '2026-08-24', description: 'Ajuste',
      accounting_records: [{ account_code: '601-01', debit: 100, credit: 0 }],
    });
  });

  it('reports HTTP errors with the status', async () => {
    const f = fakeFetch({}, false, 503);
    const a = new ContalinkAdapter('k', 'https://x', f);
    await expect(a.getAccountBalance('102-01', '2026-08-24')).rejects.toThrow(/HTTP 503/);
  });
});

// ============================================================
// LOS CUATRO DESENLACES, Y EL ENTERO CON QUE MUEREN
//
// El contrato publica 8 («falló, reintenta») y 9 («rechazó, no
// reintentes NUNCA a ciegas»). Los dos se leen igual para un humano y
// dicen lo contrario a un cron. Hasta aquí el adaptador tiraba un
// `Error` pelado en sus cuatro salidas, así que las cuatro salían por
// el 1 genérico y la distinción publicada era papel.
//
// La clasificación se hace UNA vez, donde está la prueba —quien hizo la
// llamada— y estas pruebas la fijan en las dos puntas: la CLASE que se
// lanza y el ENTERO al que la traduce el kernel. Comprobar sólo la
// clase dejaría vivo el mutante que borra la fila 424 del mapa.
// ============================================================
describe('ContalinkAdapter: cada desenlace externo lleva su veredicto hasta el código de salida', () => {
  const casos = [
    {
      nombre: 'la red nunca llegó (DNS, TLS, conexión rechazada)',
      fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
      clase: ExternalServiceError,
      codigo: ExitCode.EXTERNAL_FAILED,
      dice: /unreachable at/,
    },
    {
      nombre: 'el servidor cayó (503)',
      fetch: fakeFetch({}, false, 503),
      clase: ExternalServiceError,
      codigo: ExitCode.EXTERNAL_FAILED,
      dice: /HTTP 503/,
    },
    {
      nombre: 'nos frenó el ritmo (429): «vuelve luego», no «no»',
      fetch: fakeFetch({}, false, 429),
      clase: ExternalServiceError,
      codigo: ExitCode.EXTERNAL_FAILED,
      dice: /HTTP 429/,
    },
    {
      nombre: 'agotó el plazo de la petición (408)',
      fetch: fakeFetch({}, false, 408),
      clase: ExternalServiceError,
      codigo: ExitCode.EXTERNAL_FAILED,
      dice: /HTTP 408/,
    },
    {
      nombre: 'la credencial no vale (401): reenviar los mismos bytes da lo mismo',
      fetch: fakeFetch({}, false, 401),
      clase: ExternalRejectedError,
      codigo: ExitCode.EXTERNAL_REJECTED,
      dice: /HTTP 401/,
    },
    {
      nombre: 'el payload no lo acepta jamás (422)',
      fetch: fakeFetch({}, false, 422),
      clase: ExternalRejectedError,
      codigo: ExitCode.EXTERNAL_REJECTED,
      dice: /HTTP 422/,
    },
    {
      nombre: 'el sobre de Contalink dice que no (status 0 con HTTP 200)',
      fetch: fakeFetch({ status: 0, message: 'RFC no autorizado' }),
      clase: ExternalRejectedError,
      codigo: ExitCode.EXTERNAL_REJECTED,
      dice: /rejected the operation/,
    },
  ];

  it.each(casos)('$nombre', async ({ fetch: f, clase, codigo, dice }) => {
    const a = new ContalinkAdapter('k', 'https://x', f);
    const err = await a.getTrialBalance('2026-01-01', '2026-01-31').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(clase);
    expect((err as Error).message).toMatch(dice);
    // Nombrar al proveedor no es adorno: el operador tiene varias
    // integraciones y el mensaje es lo único que le dice cuál se cayó.
    expect((err as Error).message).toMatch(/^contalink: /);
    expect(exitCodeFor(err)).toBe(codigo);
  });

  // EL CUARTO DESENLACE, el que no estaba ni en el issue: `response.json()`
  // vivía FUERA de toda guarda. Un proxy, un CDN o un portal cautivo que
  // conteste 200 con HTML producía un `SyntaxError` pelado —«Unexpected
  // token '<'»— que salía por el 1 y NO NOMBRABA AL PROVEEDOR.
  it('un 200 con un cuerpo que no es JSON es transitorio, y nombra al proveedor', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token \'<\', "<html><bod"... is not valid JSON'); },
    })) as unknown as typeof fetch;
    const a = new ContalinkAdapter('k', 'https://x', f);
    const err = await a.getTrialBalance('2026-01-01', '2026-01-31').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect((err as Error).message).toMatch(/^contalink: answered 200 .* is not JSON/s);
    expect(exitCodeFor(err)).toBe(ExitCode.EXTERNAL_FAILED);
  });
});
