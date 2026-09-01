import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

// ============================================================
// TÚNEL SSH HACIA UNA BASE AUTOALOJADA
//
// Se usa el binario `ssh` del sistema en lugar de una librería, y
// es deliberado: así se heredan gratis ~/.ssh/config, el agente de
// llaves, los alias de host, los jump hosts y las llaves con
// passphrase. Reimplementarlo en proceso obligaría a reconfigurar
// todo eso dentro de la aplicación.
//
// Es el patrón recomendado para el acceso directo del operador: el
// 5432 no queda expuesto a internet y la identidad que autentica
// es la llave SSH, revocable y auditable por persona.
// ============================================================

export interface TunnelConfig {
  /** Destino ssh: "usuario@host", o un alias de ~/.ssh/config. */
  target: string;
  /** Host de la base VISTO DESDE el servidor remoto. */
  remoteHost?: string;
  remotePort?: number;
  /** Puerto ssh del salto, si no es el 22. */
  sshPort?: number;
  /** Llave concreta, si no la del agente. */
  identity?: string;
  timeoutMs?: number;
}

export interface OpenTunnel {
  localPort: number;
  close: () => Promise<void>;
}

/** Puerto libre efímero: se abre, se lee y se cierra antes de dárselo a ssh. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Espera a que el extremo local acepte conexiones, con tope de tiempo. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'sin detalle';
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', (e) => { lastError = e.message; resolve(false); });
      sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 150).unref?.());
  }
  throw new Error(`El túnel SSH no quedó escuchando en ${timeoutMs} ms (${lastError})`);
}

export function buildSshArgs(cfg: TunnelConfig, localPort: number): string[] {
  const remoteHost = cfg.remoteHost ?? 'localhost';
  const remotePort = cfg.remotePort ?? 5432;
  const args = [
    '-N', // sin comando remoto: solo el reenvío
    '-T', // sin pseudo-terminal
    // Si el reenvío falla, ssh debe morir en vez de quedarse conectado
    // fingiendo que todo está bien.
    '-o', 'ExitOnForwardFailure=yes',
    // Nada de pedir contraseña: si la llave no sirve, falla y se dice.
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
  ];
  if (cfg.sshPort) args.push('-p', String(cfg.sshPort));
  if (cfg.identity) args.push('-i', cfg.identity);
  args.push(cfg.target);
  return args;
}

/** El spawn se inyecta para poder probar el túnel sin un sshd de verdad. */
export type SpawnFn = (cmd: string, args: string[], opts: { stdio: ['ignore', 'ignore', 'pipe'] }) => ChildProcess;

export async function openTunnel(
  cfg: TunnelConfig,
  deps: { spawnFn?: SpawnFn } = {}
): Promise<OpenTunnel> {
  const localPort = await freePort();
  const args = buildSshArgs(cfg, localPort);

  const spawnFn = deps.spawnFn ?? (spawn);
  const child: ChildProcess = spawnFn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

  const died = new Promise<never>((_, reject) => {
    child.once('exit', (code) => {
      reject(new Error(
        `El túnel SSH terminó con código ${code}. ${stderr.trim() || 'Revisa el destino y la llave.'}`
      ));
    });
    child.once('error', (err) => reject(new Error(`No se pudo ejecutar ssh: ${err.message}`)));
  });

  try {
    await Promise.race([waitForPort(localPort, cfg.timeoutMs ?? 15_000), died]);
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  }

  return {
    localPort,
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        // Si no muere por las buenas, no se bloquea el apagado.
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref();
      }),
  };
}

/** Reescribe la cadena de conexión para apuntar al extremo local del túnel. */
export function rewriteForTunnel(connectionString: string, localPort: number): string {
  const url = new URL(connectionString);
  url.hostname = '127.0.0.1';
  url.port = String(localPort);
  return url.toString();
}
