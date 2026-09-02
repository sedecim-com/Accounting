import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  crearRespaldo,
  listarRespaldos,
  verificarRespaldo,
  restaurarRespaldo,
  puedeRespaldar,
} from '../../src/services/backup/backup-service.js';

/**
 * S3 · EL RESPALDO, PROBADO RESTAURÁNDOLO.
 *
 * No se afirma que el archivo exista: se restaura en una base de usar y tirar
 * y se le corren los chequeos del mayor. Un volcado que no restaura no es un
 * respaldo, y uno que restaura un mayor descuadrado es peor — promete lo que
 * no tiene.
 */

let f: Fixture;
let directorio: string;

beforeAll(async () => {
  f = await crearInquilino('S3 respaldo');
  directorio = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-respaldo-'));
  // Un dato reconocible: si la restauración lo trae, el ciclo cerró de verdad.
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES (gen_random_uuid(), $1, 'C-S3-TESTIGO', 'Testigo del respaldo', 'MXN', $2)`,
    [f.entityId, f.userId]
  );
}, 120_000);

afterAll(async () => {
  fs.rmSync(directorio, { recursive: true, force: true });
  await closeDatabase();
});

describe('quién puede respaldar', () => {
  it('lo decide el catálogo de Postgres, no una lista escrita a mano', async () => {
    const url = process.env.DATABASE_URL as string;
    const c = await puedeRespaldar(url);
    // La suite corre como administrador de la base efímera, así que puede.
    // Lo que importa aquí es que la respuesta venga con su MOTIVO: el día que
    // el rol no pueda, el operador tiene que saber por qué y qué hacer.
    expect(c.motivo.length).toBeGreaterThan(0);
    expect(typeof c.puede).toBe('boolean');
    expect(c.rol.length).toBeGreaterThan(0);
  });
});

describe('el ciclo completo: crear, listar, verificar restaurando', () => {
  let archivo: string;

  it('crear deja el volcado, su manifiesto con versión de esquema, y declara lo que NO lleva', async () => {
    const r = await crearRespaldo({ destino: directorio, nombre: 'prueba' });
    archivo = r.archivo;
    expect(fs.existsSync(r.archivo)).toBe(true);
    expect(fs.existsSync(r.manifiestoEn)).toBe(true);
    expect(r.manifiesto.esquema.ultimaMigracion).toMatch(/^\d{3}_/);
    expect(r.manifiesto.esquema.migracionesAplicadas).toBeGreaterThan(40);
    expect(r.manifiesto.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Lo que el volcado no lleva se declara SIEMPRE: callarlo prometería un
    // respaldo completo que no lo es.
    expect(r.manifiesto.noIncluye.join(' ')).toMatch(/ENCRYPTION_KEY/);
    expect(r.manifiesto.noIncluye.join(' ')).toMatch(/vault/);
  }, 180_000);

  it('listar reporta integridad contra el hash y cuándo se verificó', async () => {
    const lista = await listarRespaldos(directorio);
    expect(lista.length).toBe(1);
    expect(lista[0].integro, 'el sha256 del manifiesto casa con el archivo').toBe(true);
    expect(lista[0].manifiesto?.verificacion, 'aún no se ha verificado').toBeUndefined();
  });

  it('una corrupción de un solo byte se detecta por el hash', async () => {
    const copia = path.join(directorio, 'corrupto.dump');
    const bytes = fs.readFileSync(archivo);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(copia, bytes);
    fs.copyFileSync(`${archivo}.manifiesto.json`, `${copia}.manifiesto.json`);

    const lista = await listarRespaldos(directorio);
    const corrupto = lista.find((x) => x.archivo.endsWith('corrupto.dump'));
    expect(corrupto?.integro, 'un byte cambiado y el hash ya no cuadra').toBe(false);
    fs.rmSync(copia);
    fs.rmSync(`${copia}.manifiesto.json`);
  });

  it('VERIFICAR RESTAURA de verdad y corre los chequeos del mayor', async () => {
    const r = await verificarRespaldo(archivo);
    expect(r.restauro, 'el volcado se restauró de punta a punta en una base nueva').toBe(true);
    expect(r.integro).toBe(true);
    expect(r.entidadesRevisadas, 'la entidad del fixture viajó en el volcado').toBeGreaterThan(0);
    expect(
      r.hallazgos.filter((h) => h.severity === 'blocking'),
      `el mayor restaurado debe cuadrar: ${r.hallazgos.map((h) => h.detalle).join(' | ')}`
    ).toEqual([]);
  }, 180_000);

  it('y anota la verificación en el manifiesto, con su fecha', async () => {
    const lista = await listarRespaldos(directorio);
    const v = lista.find((x) => x.archivo === archivo)?.manifiesto?.verificacion;
    expect(v, 'un respaldo verificado hace meses y uno de hoy no valen lo mismo').toBeDefined();
    expect(v?.restauro).toBe(true);
    expect(v?.fecha).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('restaurar crea una base NUEVA, siempre', () => {
  it('se niega sobre una base existente, porque sobrescribir destruye lo que se quiere salvar', async () => {
    const archivo = (await listarRespaldos(directorio))[0].archivo;
    const actual = new URL(process.env.DATABASE_URL as string).pathname.replace(/^\//, '');
    await expect(restaurarRespaldo(archivo, actual)).rejects.toThrow(/ya existe/);
  }, 60_000);

  it('rechaza un nombre de base que no lo es', async () => {
    const archivo = (await listarRespaldos(directorio))[0].archivo;
    await expect(restaurarRespaldo(archivo, 'no; válido')).rejects.toThrow(/inválido/);
  });
});
