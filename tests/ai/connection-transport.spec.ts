import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));

// La config se lee del entorno al importar, así que cada escenario carga
// el módulo de nuevo con su propio entorno.
async function checkWith(env: Record<string, string>) {
  vi.resetModules();
  const previo = { ...process.env };
  Object.assign(process.env, env);
  const { checkConnectionTransport } = await import('../../src/ai/doctor-service.js');
  const r = checkConnectionTransport();
  process.env = previo;
  return r;
}

const LOCAL = 'postgresql://u:p@localhost:5432/db';
const REMOTO = 'postgresql://u:p@db.ejemplo.mx:5432/x';

beforeEach(() => {
  vi.resetModules();
});

describe('checkConnectionTransport', () => {
  it('local sin TLS está bien y no alarma', async () => {
    const r = await checkWith({ DATABASE_URL: LOCAL, DATABASE_SSL_MODE: '', DATABASE_SSH_HOST: '' });
    expect(r.level).toBe('ok');
    expect(r.detail).toMatch(/local/);
  });

  it('FALLA si un host remoto va sin TLS: las credenciales viajan en claro', async () => {
    const r = await checkWith({ DATABASE_URL: REMOTO, DATABASE_SSL_MODE: 'disable', DATABASE_SSH_HOST: '' });
    expect(r.level).toBe('fail');
    expect(r.detail).toMatch(/in the clear/);
    expect(r.fix).toMatch(/verify-full/);
  });

  it('ADVIERTE con require: cifra pero no verifica, y eso se lee como protegido', async () => {
    const r = await checkWith({ DATABASE_URL: REMOTO, DATABASE_SSL_MODE: 'require', DATABASE_SSH_HOST: '' });
    expect(r.level).toBe('warn');
    expect(r.detail).toMatch(/does NOT verify/);
  });

  it('verify-full pasa y, con preset, muestra la trampa del proveedor', async () => {
    const r = await checkWith({
      DATABASE_URL: REMOTO, DATABASE_SSL_MODE: 'verify-full',
      DATABASE_PROVIDER: 'neon', DATABASE_SSH_HOST: '',
    });
    expect(r.level).toBe('ok');
    expect(r.detail).toMatch(/provider neon/);
    // El preset existe para esto: avisar de lo que rompe el aislamiento en silencio.
    expect(r.fix).toMatch(/BYPASSRLS/);
  });

  it('reporta el túnel SSH cuando está configurado', async () => {
    const r = await checkWith({
      DATABASE_URL: REMOTO, DATABASE_SSL_MODE: 'verify-ca',
      DATABASE_SSH_HOST: 'contador@vps.mx', DATABASE_PROVIDER: 'self-hosted',
    });
    expect(r.level).toBe('ok');
    expect(r.detail).toMatch(/SSH tunnel/);
    expect(r.detail).toMatch(/verify-ca/);
  });
});
