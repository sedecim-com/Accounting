import { describe, it, expect } from 'vitest';
import { resolveSsl, defaultSslMode, isLocalHost } from '../../src/database/ssl.js';
import { buildSshArgs, rewriteForTunnel } from '../../src/database/tunnel.js';
import { DB_PROVIDERS, describeProvider } from '../../src/database/providers.js';

const LOCAL = 'postgresql://u:p@localhost:5432/db';
const CLOUD = 'postgresql://u:p@ep-abc.neon.tech:5432/db';

describe('modo TLS por defecto', () => {
  it('desactiva en local y verifica del todo fuera', () => {
    expect(defaultSslMode(LOCAL)).toBe('disable');
    expect(defaultSslMode('postgresql://u:p@127.0.0.1:5432/db')).toBe('disable');
    expect(defaultSslMode(CLOUD)).toBe('verify-full');
  });

  it('reconoce el host local en sus tres formas', () => {
    expect(isLocalHost(LOCAL)).toBe(true);
    expect(isLocalHost('postgresql://u@[::1]:5432/db')).toBe(true);
    expect(isLocalHost(CLOUD)).toBe(false);
  });
});

describe('resolveSsl', () => {
  it('local sin TLS y sin ruido', () => {
    const r = resolveSsl({ connectionString: LOCAL });
    expect(r.ssl).toBe(false);
    expect(r.warning).toBeUndefined();
  });

  it('advierte si se desactiva TLS hacia un host remoto', () => {
    const r = resolveSsl({ connectionString: CLOUD, mode: 'disable' });
    expect(r.ssl).toBe(false);
    expect(r.warning).toMatch(/en claro/);
  });

  it('require cifra pero NO verifica, y lo dice', () => {
    const r = resolveSsl({ connectionString: CLOUD, mode: 'require' });
    expect(r.ssl).toEqual({ rejectUnauthorized: false });
    // El punto entero: que nadie lo confunda con estar protegido.
    expect(r.warning).toMatch(/NO verifica/);
  });

  it('verify-full verifica cadena y nombre, sin CA usa el del sistema', () => {
    const r = resolveSsl({ connectionString: CLOUD });
    expect(r.ssl).toEqual({ rejectUnauthorized: true });
    expect(r.warning).toBeUndefined();
  });

  it('verify-full acepta un CA en línea', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const r = resolveSsl({ connectionString: CLOUD, caSource: pem });
    expect((r.ssl as { ca?: string }).ca).toBe(pem);
  });

  it('verify-ca valida la cadena pero no el nombre (caso del túnel)', () => {
    const r = resolveSsl({ connectionString: CLOUD, mode: 'verify-ca' });
    const ssl = r.ssl as { rejectUnauthorized: boolean; checkServerIdentity?: unknown };
    expect(ssl.rejectUnauthorized).toBe(true);
    // A través de un túnel el host local jamás coincide con el del certificado.
    expect(typeof ssl.checkServerIdentity).toBe('function');
  });

  it('rechaza un modo inventado en vez de degradar en silencio', () => {
    expect(() => resolveSsl({ connectionString: CLOUD, mode: 'casi' })).toThrow(/inválido/);
  });

  it('falla claro si el archivo de CA no existe', () => {
    expect(() => resolveSsl({ connectionString: CLOUD, caSource: '/no/existe.pem' })).toThrow(/No existe/);
  });
});

describe('túnel SSH', () => {
  it('arma los argumentos con las banderas que importan', () => {
    const args = buildSshArgs({ target: 'contador@vps.mx', remoteHost: 'db.interna', remotePort: 5432 }, 54321);
    expect(args).toContain('-N');
    // Sin esto ssh se queda conectado aunque el reenvío falle, y la app
    // esperaría un puerto que nunca abre.
    expect(args.join(' ')).toContain('ExitOnForwardFailure=yes');
    // Sin esto pediría contraseña por teclado en vez de fallar.
    expect(args.join(' ')).toContain('BatchMode=yes');
    expect(args).toContain('-L');
    expect(args).toContain('127.0.0.1:54321:db.interna:5432');
    expect(args[args.length - 1]).toBe('contador@vps.mx');
  });

  it('usa localhost:5432 del lado remoto por defecto', () => {
    const args = buildSshArgs({ target: 'vps' }, 5000);
    expect(args).toContain('127.0.0.1:5000:localhost:5432');
  });

  it('acepta puerto ssh y llave explícitos', () => {
    const args = buildSshArgs({ target: 'vps', sshPort: 2222, identity: '/k/id_ed25519' }, 5000);
    expect(args).toContain('-p'); expect(args).toContain('2222');
    expect(args).toContain('-i'); expect(args).toContain('/k/id_ed25519');
  });

  it('el extremo local sustituye host y puerto conservando credenciales', () => {
    const url = rewriteForTunnel('postgresql://user:pass@db.interna:5432/conta', 54321);
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(parsed.port).toBe('54321');
    expect(parsed.username).toBe('user');
    expect(parsed.pathname).toBe('/conta');
  });
});

describe('presets de proveedor', () => {
  it('cubre local, autoalojado y los gestionados', () => {
    expect(Object.keys(DB_PROVIDERS)).toEqual(
      expect.arrayContaining(['local', 'self-hosted', 'neon', 'supabase', 'rds', 'cloudsql', 'crunchy'])
    );
  });

  it('cada preset trae al menos una advertencia real', () => {
    for (const [name, p] of Object.entries(DB_PROVIDERS)) {
      expect(p.caveats.length, `${name} sin advertencias`).toBeGreaterThan(0);
    }
  });

  it('Neon avisa del rol que ignora RLS: es la trampa que rompe el aislamiento', () => {
    expect(DB_PROVIDERS.neon.caveats.join(' ')).toMatch(/BYPASSRLS/);
  });

  it('el autoalojado usa verify-ca, no verify-full', () => {
    expect(DB_PROVIDERS['self-hosted'].sslMode).toBe('verify-ca');
  });

  it('RDS y Cloud SQL exigen CA propio; Neon y Supabase no', () => {
    expect(DB_PROVIDERS.rds.ca).toBe('propio');
    expect(DB_PROVIDERS.cloudsql.ca).toBe('propio');
    expect(DB_PROVIDERS.neon.ca).toBe('sistema');
    expect(DB_PROVIDERS.supabase.ca).toBe('sistema');
  });

  it('un proveedor desconocido falla listando los válidos', () => {
    expect(() => describeProvider('inventado')).toThrow(/neon/);
  });
});

// ── Comportamiento real del túnel, con el spawn inyectado ──
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { openTunnel } from '../../src/database/tunnel.js';

/** Proceso ssh falso: opcionalmente abre el puerto que ssh abriría. */
function fakeSsh(opts: { listenOn?: number; exitWith?: number; stderr?: string }) {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter; kill: (s?: string) => void; exitCode: number | null;
  };
  child.stderr = new EventEmitter();
  child.exitCode = null;
  let server: net.Server | undefined;

  child.kill = () => {
    server?.close();
    child.exitCode = 0;
    setImmediate(() => child.emit('exit', 0));
  };

  if (opts.exitWith !== undefined) {
    setImmediate(() => {
      if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
      child.exitCode = opts.exitWith!;
      child.emit('exit', opts.exitWith);
    });
  } else if (opts.listenOn !== undefined) {
    server = net.createServer();
    server.listen(opts.listenOn, '127.0.0.1');
  }
  return { child, close: () => server?.close() };
}

describe('openTunnel', () => {
  it('resuelve cuando el puerto local queda escuchando', async () => {
    let captured: string[] = [];
    let fake: ReturnType<typeof fakeSsh> | undefined;
    const t = await openTunnel(
      { target: 'vps', timeoutMs: 4000 },
      {
        spawnFn: (_cmd, args) => {
          captured = args;
          // ssh abriría el puerto que le pedimos con -L
          const port = Number(args[args.indexOf('-L') + 1].split(':')[1]);
          fake = fakeSsh({ listenOn: port });
          return fake.child as never;
        },
      }
    );
    expect(t.localPort).toBeGreaterThan(0);
    expect(captured.join(' ')).toContain(`127.0.0.1:${t.localPort}:localhost:5432`);
    await t.close();
  });

  it('si ssh muere, falla con el motivo en vez de esperar el timeout', async () => {
    const inicio = Date.now();
    await expect(
      openTunnel(
        { target: 'vps-inexistente', timeoutMs: 30_000 },
        { spawnFn: () => fakeSsh({ exitWith: 255, stderr: 'Permission denied (publickey).' }).child as never }
      )
    ).rejects.toThrow(/Permission denied/);
    // Lo importante: no se quedó los 30 s esperando.
    expect(Date.now() - inicio).toBeLessThan(3000);
  });

  it('corta si el puerto nunca abre, aunque ssh siga vivo', async () => {
    await expect(
      openTunnel(
        { target: 'vps', timeoutMs: 600 },
        { spawnFn: () => fakeSsh({}).child as never }
      )
    ).rejects.toThrow(/no quedó escuchando/);
  });
});
