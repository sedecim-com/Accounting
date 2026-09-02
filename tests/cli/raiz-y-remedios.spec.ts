import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ============================================================
// LA RAÍZ Y LOS REMEDIOS
// Tres promesas de la armonización de errores:
//   1. Un token desconocido en la raíz no se lo traga chat: sale
//      con USAGE (2) y la sugerencia más cercana — incluidos los
//      alias en español que viven un nivel abajo (report balanza).
//   2. «póliza» con acento ejecuta el alias `poliza`: el contador
//      teclea la palabra como se escribe, no como se registró.
//   3. reportError remite al remedio: la base caída imprime el
//      comando que la arregla, no solo el mensaje crudo de pg.
// Y una sola fuente de versión: package.json.
// mnemosine.ts guarda parseAsync tras require.main, así que
// importarlo aquí monta el árbol sin lanzar el CLI.
// ============================================================

import {
  CLI_VERSION,
  reportError,
  remedioParaMensaje,
  normalizarToken,
  distanciaDeEdicion,
  veredictoDeRaiz,
  comandosRegistrados,
  program,
} from '../../src/cli/mnemosine.js';

const RAIZ_REPO = path.join(__dirname, '..', '..');
const TSX = path.join(RAIZ_REPO, 'node_modules', '.bin', 'tsx');
const CLI = path.join(RAIZ_REPO, 'src', 'cli', 'mnemosine.ts');

/**
 * Lanza el CLI real con HOME vacío y base inalcanzable: lo que ve un usuario
 * el primer día. stdin cerrado para que nada interactivo pueda colgar.
 */
function corre(args: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-raiz-'));
  try {
    const env = { ...process.env };
    delete env.MNEMOSINE_TENANT;
    delete env.MNEMOSINE_ENTITY;
    return spawnSync(TSX, [CLI, ...args], {
      encoding: 'utf-8',
      cwd: RAIZ_REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: {
        ...env,
        HOME: home,
        DATABASE_URL: 'postgresql://127.0.0.1:1/inalcanzable',
        MNEMOSINE_NO_BANNER: '1',
        NO_COLOR: '1',
      },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const conocidos = comandosRegistrados(program);

describe('veredictoDeRaiz — el árbitro puro', () => {
  it('un alias real un nivel abajo se sugiere con su ruta: balanza → report balanza', () => {
    const v = veredictoDeRaiz('balanza', conocidos);
    expect(v).toEqual({ tipo: 'desconocido', sugerencia: 'report balanza' });
  });

  it('un dedazo en la raíz sugiere el comando raíz: reprot → report', () => {
    const v = veredictoDeRaiz('reprot', conocidos);
    expect(v).toEqual({ tipo: 'desconocido', sugerencia: 'report' });
  });

  it('«póliza» (NFC) encuentra el alias poliza y se reescribe al canónico', () => {
    expect(veredictoDeRaiz('póliza', conocidos)).toEqual({ tipo: 'canonico', nombre: 'poliza' });
  });

  it('«póliza» en NFD (como la emite macOS) también encuentra poliza', () => {
    expect(veredictoDeRaiz('póliza', conocidos)).toEqual({ tipo: 'canonico', nombre: 'poliza' });
  });

  it('sin token, con flag, con help o con un comando registrado: pasa intacto', () => {
    expect(veredictoDeRaiz(undefined, conocidos)).toEqual({ tipo: 'pasa' });
    expect(veredictoDeRaiz('--version', conocidos)).toEqual({ tipo: 'pasa' });
    expect(veredictoDeRaiz('-T', conocidos)).toEqual({ tipo: 'pasa' });
    expect(veredictoDeRaiz('help', conocidos)).toEqual({ tipo: 'pasa' });
    expect(veredictoDeRaiz('chat', conocidos)).toEqual({ tipo: 'pasa' });
    expect(veredictoDeRaiz('entry', conocidos)).toEqual({ tipo: 'pasa' });
    expect(veredictoDeRaiz('poliza', conocidos)).toEqual({ tipo: 'pasa' });
  });

  it('un token sin parecido razonable no inventa sugerencia', () => {
    const v = veredictoDeRaiz('zzxxqqww', conocidos);
    expect(v.tipo).toBe('desconocido');
    expect(v.tipo === 'desconocido' && v.sugerencia).toBeNull();
  });

  it('la distancia corta se comporta: identidad 0, sustitución 1, vacíos', () => {
    expect(distanciaDeEdicion('report', 'report')).toBe(0);
    expect(distanciaDeEdicion('reprot', 'report')).toBe(2);
    expect(distanciaDeEdicion('', 'abc')).toBe(3);
    expect(distanciaDeEdicion('abc', '')).toBe(3);
  });

  it('normalizarToken quita marcas en NFC y NFD por igual', () => {
    expect(normalizarToken('póliza')).toBe('poliza');
    expect(normalizarToken('póliza')).toBe('poliza');
    expect(normalizarToken('PÓLIZA')).toBe('poliza');
  });
});

describe('la raíz de verdad (proceso completo)', () => {
  it('balanza: código 2 (USAGE) y la sugerencia con su ruta', () => {
    const r = corre(['balanza']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown command 'balanza'");
    expect(r.stderr).toContain('report balanza');
  }, 90_000);

  it('reprot: código 2 y Did you mean report', () => {
    const r = corre(['reprot']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Did you mean report?');
  }, 90_000);

  it('«póliza» NO es desconocido: ejecuta el alias poliza (aquí, su ayuda)', () => {
    const r = corre(['póliza', '--help']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('unknown command');
    expect(r.stdout).toContain('entry|poliza');
  }, 90_000);

  it('sin argumentos, chat sigue siendo el default: nunca «unknown command» ni código 2', () => {
    const r = corre([]);
    expect(r.status).not.toBe(2);
    expect(String(r.stderr)).not.toContain('unknown command');
    // En una máquina virgen el default (chat) diagnostica y apunta a init.
    expect(r.stderr).toContain('mnemosine init');
  }, 90_000);
});

describe('reportError remite al remedio', () => {
  afterEach(() => vi.restoreAllMocks());

  function stderrDe(err: unknown): string {
    const lineas: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lineas.push(args.map(String).join(' '));
    });
    reportError(err);
    return lineas.join('\n');
  }

  it('la base caída imprime el comando que la arregla, no solo el mensaje de pg', () => {
    const salida = stderrDe(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    expect(salida).toContain('connect ECONNREFUSED');
    expect(salida).toContain('→ mnemosine doctor');
    expect(salida).toContain('DATABASE_URL');
  });

  it('el «role postgres does not exist» del primer día también lleva remedio', () => {
    const salida = stderrDe(new Error('role "postgres" does not exist'));
    expect(salida).toContain('→ mnemosine doctor');
  });

  it('un error de dominio cualquiera NO se remata con un doctor genérico', () => {
    const salida = stderrDe(new Error('The entry is unbalanced by 0.0100'));
    expect(salida).toContain('unbalanced');
    expect(salida).not.toContain('→');
  });

  it('un dedazo de entidad no aconseja reconfigurar la identidad', () => {
    // «No active entity matches» cae en la categoría de entidad, cuyo remedio
    // (init --section identity) solo vale en el arranque roto — aquí sería
    // un consejo equivocado, y por eso la categoría no entra a reportError.
    expect(remedioParaMensaje('No active entity matches "Demmo"')).toBeNull();
  });
});

describe('una sola fuente de versión', () => {
  it('CLI_VERSION es literalmente la versión de package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ_REPO, 'package.json'), 'utf-8')) as {
      version: string;
    };
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it('y el binario declarado apunta al CLI compilado', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ_REPO, 'package.json'), 'utf-8')) as {
      bin?: Record<string, string>;
    };
    expect(pkg.bin?.mnemosine).toBe('dist/cli/mnemosine.js');
  });
});
