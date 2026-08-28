import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

// ============================================================
// IMPORTAR migrate.ts NO PUEDE MIGRAR NADA.
//
// El archivo exporta assertNumeracionUnica, que una prueba unitaria importa, y
// además llamaba a runMigrations() en el nivel superior. O sea: importar la
// función ejecutaba las migraciones.
//
// El síntoma dependía de quién mirara. En CI, donde el job unitario no tiene
// Postgres a propósito, reventaba con ECONNREFUSED y el job salía en ROJO con
// las 2007 pruebas en verde —vitest falla ante un error no manejado aunque
// ninguna aserción falle—. En la máquina de quien desarrolla no se veía nada:
// había un Postgres escuchando, así que `npm test` le migraba la base sin
// decírselo.
//
// Esto se prueba en un proceso aparte a propósito. Dentro de esta misma corrida
// el módulo puede estar ya en la caché de require por culpa de otra prueba, y
// entonces la comprobación pasaría sin comprobar nada.
// ============================================================

const RAIZ = path.join(__dirname, '..', '..');

/** Un Postgres que con toda seguridad no existe: el puerto 1 es privilegiado y nadie escucha. */
const MUERTO = 'postgresql://nadie:nada@127.0.0.1:1/inexistente';

function importarEnProcesoAparte(): { salida: string; codigo: number } {
  try {
    const salida = execFileSync(
      'npx',
      ['tsx', '-e', "require('./src/database/migrate.ts'); console.log('IMPORTADO');"],
      {
        cwd: RAIZ,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DATABASE_URL: MUERTO, MIGRATION_DATABASE_URL: MUERTO },
      }
    );
    return { salida, codigo: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { salida: `${e.stdout ?? ''}${e.stderr ?? ''}`, codigo: e.status ?? 1 };
  }
}

describe('importar src/database/migrate.ts', () => {
  it('no intenta conectar a la base, ni siquiera con una URL que no responde', () => {
    const { salida, codigo } = importarEnProcesoAparte();
    expect(salida).toContain('IMPORTADO');
    expect(salida).not.toContain('ECONNREFUSED');
    expect(codigo).toBe(0);
  }, 60_000);

  it('tampoco imprime nada de la corrida de migraciones', () => {
    // Si el import las ejecutara contra un Postgres que SÍ responde —el caso
    // de la máquina de quien desarrolla— el primer aviso sería esta salida.
    const { salida } = importarEnProcesoAparte();
    expect(salida).not.toMatch(/Running migrations|Applying isolation|migrations complete/i);
  }, 60_000);
});
