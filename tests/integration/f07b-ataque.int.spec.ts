import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import Decimal from 'decimal.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { softClosePeriod } from '../../src/services/accounting/period-close.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import { checkExitCode, ExitCode } from '../../src/cli/kernel/exit.js';
import { generarCatalogoCuentas } from '../../src/services/sat/anexo24/index.js';
import {
  generarBalanza,
  verificarBalanza,
} from '../../src/services/sat/anexo24/balanza-service.js';
import {
  importesDeclarados,
  recalculoDelSat,
  type CuentaDeBalanza,
} from '../../src/services/sat/anexo24/balanza-invariantes.js';

// ============================================================
// F07b · EL ATAQUE. Lo que sale de aquí lo lee la autoridad fiscal, y un
// error no se descubre hasta que rechaza la declaración, con el plazo corrido.
//
// Este archivo NO repite lo que f07b-balanza-que-se-entrega ya mide. Ataca:
//
//   · EL XML     — el nombre con `&`, el salto de línea, el NumCta que ningún
//                  validador del SAT aceptaría, el orden y el espacio de
//                  nombres, y los importes con su signo y su cero.
//   · LA BALANZA — la trampa de Natur, la cuenta que el catálogo NO declara
//                  (cotejada contra el ARTEFACTO, no contra una lista de
//                  prueba), el descuadre inyectado y el cierre suave.
//   · EL PROCESO — que no haya NINGÚN camino que cargue una llave privada
//                  (se busca en el CÓDIGO, no en la salida), la política que
//                  bloquea, y la frontera de entidad de la serie TEN.
//
// Corre como superusuario, igual que el resto de la suite: RLS queda inerte a
// propósito, y lo que se mide es la frontera que el CÓDIGO defiende. Es la
// única forma de que una prueba de frontera diga lo que dice demostrar.
// ============================================================

let f: Fixture;
let hermana: Fixture;

const RAIZ = path.resolve(__dirname, '../..');

/** Un asiento posteado de dos líneas. */
async function asiento(
  fx: Fixture,
  mes: number,
  descripcion: string,
  cargo: string,
  abono: string,
  monto: string
): Promise<{ id: string }> {
  const je = await createJournalEntry(
    fx.entityId,
    fechaEnPeriodo(mes, 10),
    JournalEntryType.STANDARD,
    descripcion,
    [
      { account_id: cargo, debit_amount: monto, credit_amount: null, description: descripcion },
      { account_id: abono, debit_amount: null, credit_amount: monto, description: descripcion },
    ],
    fx.userId,
    { autoPost: true }
  );
  return je as unknown as { id: string };
}

/**
 * Un asiento POSTEADO cuya FECHA cae fuera del periodo fiscal al que
 * pertenece. Va por SQL directo porque el servicio deriva el periodo de la
 * fecha, y el trigger `journal_entries_posteado_inmutable` —bien puesto— no
 * deja separarlos después: sólo prohíbe UPDATE y DELETE, no el alta.
 *
 * No es un caso de laboratorio: es lo que deja una importación que trae el
 * periodo en una columna y la fecha en otra, y es el descuadre que la
 * autoridad encuentra al rehacer la resta sobre el archivo.
 */
async function asientoDesfasado(
  fx: Fixture,
  periodoId: string,
  fecha: string,
  cargo: string,
  abono: string,
  monto: string
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO journal_entries (id, entry_number, entry_type, entity_id, fiscal_period_id,
       entry_date, posted_date, status, total_debits, total_credits, description, created_by, posted_by)
     VALUES ($1, $2, 'standard', $3, $4, $5::date, $5::date, 'posted', $6, $6,
             'Asiento con la fecha fuera de su periodo', $7, $7)`,
    [id, `DESF-${id.slice(0, 8)}`, fx.entityId, periodoId, fecha, monto, fx.userId]
  );
  await query(
    `INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_amount, credit_amount)
     VALUES ($1, 1, $2, $3, NULL), ($1, 2, $4, NULL, $3)`,
    [id, cargo, monto, abono]
  );
  // El asiento se inyecta con UNA sola incoherencia —la fecha contra su
  // periodo—, y con TODO lo demás en su sitio: `account_balances` y el rastro
  // de `post` en `audit_log`. Si no, este archivo dejaría deriva de saldos y
  // asientos sin autor en una base que la suite comparte, y `doctor` los
  // denunciaría desde otro archivo de prueba: un ataque tiene que romper
  // exactamente lo que dice romper.
  for (const [cuenta, debe, haber] of [
    [cargo, monto, null],
    [abono, null, monto],
  ] as const) {
    await query(
      `INSERT INTO account_balances (account_id, fiscal_period_id, entity_id, debit_total, credit_total, ending_balance)
       VALUES ($1, $2, $3, COALESCE($4::NUMERIC, 0), COALESCE($5::NUMERIC, 0),
               COALESCE($4::NUMERIC, 0) - COALESCE($5::NUMERIC, 0))
       ON CONFLICT (account_id, fiscal_period_id) DO UPDATE SET
         debit_total = account_balances.debit_total + COALESCE($4::NUMERIC, 0),
         credit_total = account_balances.credit_total + COALESCE($5::NUMERIC, 0),
         ending_balance = account_balances.ending_balance + COALESCE($4::NUMERIC, 0) - COALESCE($5::NUMERIC, 0),
         updated_at = NOW()`,
      [cuenta, periodoId, fx.entityId, debe, haber]
    );
  }
  await query(
    `INSERT INTO audit_log (user_id, tenant_id, action, entity_type, entity_id, reason)
     VALUES ($1, $2, 'post', 'journal_entries', $3, 'asiento inyectado por la prueba de ataque')`,
    [fx.userId, fx.tenantId, id]
  );
  return id;
}

/** Alta directa de una cuenta: el ataque necesita códigos y nombres que el alta normal no deja escribir. */
async function crearCuenta(
  fx: Fixture,
  code: string,
  name: string,
  opts: {
    level?: number;
    parent?: string | null;
    normal?: 'debit' | 'credit';
    tipo?: string;
    agrupador?: string | null;
  } = {}
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO accounts (id, entity_id, code, name, account_type, account_level, parent_id,
       normal_balance, currency_code, codigo_agrupador_sat, is_active, is_header, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'MXN', $9, true, false, $10)`,
    [
      id,
      fx.entityId,
      code,
      name,
      opts.tipo ?? (opts.normal === 'credit' ? 'liability' : 'asset'),
      opts.level ?? 2,
      opts.parent ?? null,
      opts.normal ?? 'debit',
      opts.agrupador ?? null,
      fx.userId,
    ]
  );
  return id;
}

/** Los atributos del nodo Ctas de una cuenta, leídos DEL XML y no del modelo. */
function atributosDe(xml: string, numCta: string): Record<string, string> {
  const p = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseAttributeValue: false,
    parseTagValue: false,
    isArray: (n) => n === 'Ctas',
  });
  const doc = p.parse(xml) as Record<string, Record<string, unknown>>;
  const raiz = doc['Catalogo'] ?? doc['Balanza'];
  const filas = raiz?.['Ctas'];
  expect(Array.isArray(filas), 'el archivo no trae nodos Ctas').toBe(true);
  const fila = (filas as Record<string, string>[]).find((c) => c['@_NumCta'] === numCta);
  expect(fila, `el archivo no declara la cuenta ${numCta}`).toBeDefined();
  return Object.fromEntries(
    Object.entries(fila as Record<string, string>).map(([k, v]) => [k.replace('@_', ''), String(v)])
  );
}

/** Los NumCta que el archivo declara, en el orden en que salen. */
function numerosDe(xml: string): string[] {
  return [...xml.matchAll(/NumCta="([^"]*)"/g)].map((m) => m[1]);
}

/** Todas las cuentas activas de una entidad, para armar un catálogo de cotejo. */
async function codigosDe(entityId: string): Promise<string[]> {
  const r = await query<{ code: string }>(
    'SELECT code FROM accounts WHERE entity_id = $1 AND is_active = true ORDER BY code',
    [entityId]
  );
  return r.rows.map((x) => x.code);
}

/** Le pone agrupador a todas las cuentas de la entidad: sin él el defecto BLOQUEA. */
async function mapearTodoElPlan(entityId: string, codigo = '102.01'): Promise<void> {
  await query(`UPDATE accounts SET codigo_agrupador_sat = $2 WHERE entity_id = $1`, [
    entityId,
    codigo,
  ]);
}

/**
 * Un inquilino desechable, ANOTADO para poder darlo de baja al terminar.
 *
 * `doctor` tiene comprobaciones de INSTALACIÓN que leen `users` sin acotar por
 * inquilino y sí por `is_active`, y otro archivo de la suite las mide: cada
 * inquilino que éste deje vivo engorda un informe ajeno. Es la misma razón por
 * la que f07a-ataque da de baja los suyos.
 */
const desechables: Fixture[] = [];
async function inquilinoDesechable(nombre: string): Promise<Fixture> {
  const fx = await crearInquilino(nombre);
  desechables.push(fx);
  return fx;
}

beforeAll(async () => {
  f = await crearInquilino('F07b ataque');
  desechables.push(f);
  enterTenant(f.tenantId);
  await seedPolicies({ tenantId: f.tenantId });
  // ESTE ARCHIVO NO TOCA `sat_codigos_agrupadores`, Y ES DELIBERADO.
  //
  // La tabla es GLOBAL y la comparte toda la corrida, y hay dos archivos
  // atados a su estado: f01-catalogo-asiento-mayor comprueba que SU siembra
  // inserta más de mil filas —o sea, que es la primera— y f07a-ataque decide
  // si la vacía al terminar según cómo la encontró (`catalogoAlLlegar === 0`).
  // Sembrar aquí, aunque fuera UNA fila con otra vigencia, le cambia la
  // respuesta a los dos y los hace fallar por un motivo que no es suyo, según
  // el orden en que vitest tome los archivos —que no está garantizado—.
  // Se comprobó ejecutando la suite entera con y sin esa fila.
  //
  // El precio es que aquí no se sabe si hay c_CodAgrup sembrado, así que
  // ninguna aserción de este archivo puede depender de ello: el agrupador
  // '102.01' que se usa está en el catálogo oficial, de modo que salga
  // 'valido' (si otro archivo lo sembró) o 'sin_catalogo' (si no), nunca
  // 'fuera_de_catalogo', que es el único de los tres que bloquea.
  hermana = await crearEntidadHermana(f, 'Hermana del ataque');
  desechables.push(hermana);

  // ENERO y FEBRERO, como en el ejercicio de F07a.
  await asiento(f, 1, 'Venta de enero', f.cuentas['1120'], f.cuentas['4100'], '7000.0000');
  await asiento(f, 1, 'Costo de enero', f.cuentas['5100'], f.cuentas['1120'], '2500.0000');
  await asiento(f, 2, 'Venta de febrero', f.cuentas['1120'], f.cuentas['4100'], '1300.0000');
  await asiento(f, 2, 'Gasto de febrero', f.cuentas['5100'], f.cuentas['1120'], '400.0000');
  await softClosePeriod(f.periodos[1], f.entityId, f.userId, 'cierre suave de enero');
}, 120_000);

afterAll(async () => {
  await drainAttestations(3000);
  // Baja LÓGICA y no DELETE: `audit_log` es de sólo agregar y media base
  // referencia al autor.
  await query('UPDATE users SET is_active = false WHERE id = ANY($1::uuid[])', [
    desechables.map((d) => d.userId),
  ]);
  await closeDatabase();
});

// ============================================================
// 1 · CONTRA EL XML
// ============================================================

describe('el ataque más viejo del mundo: el nombre que rompe el archivo', () => {
  it('un nombre con &, <, comillas y acentos sale escapado y VUELVE idéntico', async () => {
    const sucio = `Aceros & Cía <S.A. de C.V.> "El Ñandú" 'apóstrofo' 5 > 3 — ÁÉÍÓÚ`;
    await query(`UPDATE accounts SET name = $2 WHERE entity_id = $1 AND code = '1120'`, [
      f.entityId,
      sucio,
    ]);
    await mapearTodoElPlan(f.entityId);

    const r = await generarCatalogoCuentas(
      { tenantId: f.tenantId, entityId: f.entityId },
      { entityId: f.entityId, anio: 2026, mes: 2, userId: f.userId, dryRun: true }
    );
    expect(r.xml).not.toBeNull();
    const xml = r.xml as string;

    // 1. Sigue siendo XML bien formado.
    expect(XMLValidator.validate(xml)).toBe(true);
    // 2. Está escapado de verdad: ni un `&` suelto, ni un `<` dentro del atributo.
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;S.A. de C.V.&gt;');
    // Ni un `&` que no abra una entidad conocida, ni un `<` dentro de un valor
    // de atributo: son las dos formas en que este archivo se rompe.
    expect(xml).not.toMatch(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/);
    expect(xml).not.toMatch(/="[^"]*<[^"]*"/);
    // 3. Y el dato VUELVE exactamente como entró: el SAT lee lo que se guardó.
    expect(atributosDe(xml, '1120').Desc).toBe(sucio);
    // Los acentos no se escapan ni se pierden: el archivo va en UTF-8.
    expect(xml).toContain('Ñandú');
  });

  it('un salto de línea NO viaja en silencio: se limpia y se DENUNCIA', async () => {
    await query(`UPDATE accounts SET name = $2 WHERE entity_id = $1 AND code = '1110'`, [
      f.entityId,
      'Caja\ny  bancos\t(matriz)',
    ]);
    const r = await generarCatalogoCuentas(
      { tenantId: f.tenantId, entityId: f.entityId },
      { entityId: f.entityId, anio: 2026, mes: 2, userId: f.userId, dryRun: true }
    );
    const xml = r.xml as string;
    expect(atributosDe(xml, '1110').Desc).toBe('Caja y bancos (matriz)');
    // La normalización de XML 1.0 §3.3.3 lo habría hecho igual; la diferencia
    // es que aquí se dice, con la cuenta nombrada.
    const aviso = r.hallazgos.find((h) => h.regla === 'CAT-DESC-NORMALIZADA');
    expect(aviso?.numCta).toBe('1110');
    expect(aviso?.severidad).toBe('aviso');

    await query(`UPDATE accounts SET name = 'Caja y bancos' WHERE entity_id = $1 AND code = '1110'`, [
      f.entityId,
    ]);
  });

  it('HALLAZGO · un NumCta que ningún validador del SAT aceptaría pasa SIN UN SOLO HALLAZGO', async () => {
    // Desc, CodAgrup, Nivel, Natur y SubCtaDe tienen todos su regla en
    // validador.ts. NumCta —la llave con la que la balanza y las pólizas
    // apuntan al catálogo— no tiene ninguna sobre su FORMA.
    const codigo = 'A B&C<D>';
    await crearCuenta(f, codigo, 'Cuenta con número imposible', {
      level: 1,
      agrupador: '102.01',
    });

    const r = await generarCatalogoCuentas(
      { tenantId: f.tenantId, entityId: f.entityId },
      { entityId: f.entityId, anio: 2026, mes: 2, userId: f.userId, dryRun: true }
    );
    const xml = r.xml as string;

    // El constructor hace su parte: el archivo es bien formado y el número
    // viaja escapado. Eso NO lo hace presentable.
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(atributosDe(xml, codigo).NumCta).toBe(codigo);

    // Y nadie dice nada sobre él. Lo único que puede aparecer es el aviso de
    // que no hay c_CodAgrup sembrado, que es de otra cosa y depende de qué
    // archivo de la suite corrió antes: se descuenta para que la aserción
    // mida SÓLO lo que dice medir.
    const sobreLaCuenta = r.hallazgos
      .filter((h) => h.numCta === codigo)
      .filter((h) => h.regla !== 'CAT-AGRUPADOR-SIN-CATALOGO');
    expect(
      sobreLaCuenta.map((h) => h.regla),
      'ninguna regla mira la FORMA de NumCta: el archivo sale con un número de cuenta con espacio y ampersand'
    ).toEqual([]);

    await query(`DELETE FROM accounts WHERE entity_id = $1 AND code = $2`, [f.entityId, codigo]);
  });

  it('el espacio de nombres, el prefijo y el orden de los atributos son los del Anexo 24', async () => {
    const r = await generarCatalogoCuentas(
      { tenantId: f.tenantId, entityId: f.entityId },
      { entityId: f.entityId, anio: 2026, mes: 2, userId: f.userId, dryRun: true }
    );
    const xml = r.xml as string;
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const raiz = xml.split('\n')[1];
    expect(raiz).toBe(
      '<catalogocuentas:Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
        'xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas ' +
        'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd" ' +
        'Version="1.3" RFC="XAXX010101000" Mes="02" Anio="2026">'
    );
    // El nodo hijo lleva los seis atributos del Anexo 24, y CodAgrup primero.
    const uno = xml.split('\n').find((l) => l.includes('<catalogocuentas:Ctas'));
    expect(uno).toMatch(/^\s*<catalogocuentas:Ctas CodAgrup="[^"]*" NumCta="[^"]*" Desc="/);

    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    const raizB = b.xml.split('\n')[1];
    expect(raizB).toContain(
      'xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion"'
    );
    expect(raizB).toContain('Version="1.3"');
    expect(raizB).toContain('TipoEnvio="N"');
    // Una normal NO declara FechaModBal: son dos cosas que se contradicen.
    expect(raizB).not.toContain('FechaModBal');
  });

  it('los importes van a DOS decimales, con signo, y un saldo cero nunca sale como -0.00', async () => {
    // Una acreedora con saldo cero es el caso que produce el «menos cero»:
    // el signo se invierte sobre un cero, y `-0.00` en un archivo fiscal es
    // una cifra que un validador puede rechazar y que un humano no entiende.
    const ceroA = await crearCuenta(f, '2199', 'Acreedora que quedó en cero', {
      level: 2,
      parent: f.cuentas['2100'],
      normal: 'credit',
      tipo: 'liability',
      agrupador: '102.01',
    });
    // Se mueve y se salda dentro de febrero: Debe y Haber != 0, saldos = 0.
    await asiento(f, 2, 'Alta del pasivo', f.cuentas['1120'], ceroA, '250.5550');
    await asiento(f, 2, 'Pago del pasivo', ceroA, f.cuentas['1120'], '250.5550');

    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    const c = atributosDe(b.xml, '2199');
    expect(c.SaldoIni).toBe('0.00');
    expect(c.SaldoFin).toBe('0.00');
    // Cuatro decimales del mayor → dos del archivo, redondeando: 250.5550 → 250.56.
    expect(c.Debe).toBe('250.56');
    expect(c.Haber).toBe('250.56');
    // Y en NINGUNA parte del archivo aparece un menos cero.
    expect(b.xml).not.toContain('"-0.00"');
    // Las cuatro columnas de todo el archivo llevan exactamente dos decimales.
    for (const m of b.xml.matchAll(/(SaldoIni|Debe|Haber|SaldoFin)="([^"]*)"/g)) {
      expect(m[2], `${m[1]}="${m[2]}" no tiene dos decimales`).toMatch(/^-?\d+\.\d{2}$/);
    }
  });
});

// ============================================================
// 2 · CONTRA LA BALANZA
// ============================================================

describe('la trampa del tramo: la misma cifra en una acreedora y en una deudora', () => {
  it('las mismas cuatro columnas se DECLARAN distinto según Natur, y el recálculo lo respeta', () => {
    // Mismos números en el mayor (deudor positivo) para las dos cuentas.
    const numeros = {
      saldo_ini_mayor: '4500.0000',
      debe: '1300.0000',
      haber: '400.0000',
      saldo_fin_mayor: '5400.0000',
    };
    const deudora: CuentaDeBalanza = {
      account_id: 'd',
      num_cta: 'D',
      natur: 'D',
      ...numeros,
      codigo_agrupador: null,
      natur_del_agrupador: null,
      tiene_hijas: false,
    };
    const acreedora: CuentaDeBalanza = { ...deudora, account_id: 'a', num_cta: 'A', natur: 'A' };

    const iD = importesDeclarados(deudora);
    const iA = importesDeclarados(acreedora);

    expect(iD).toEqual({
      SaldoIni: '4500.00',
      Debe: '1300.00',
      Haber: '400.00',
      SaldoFin: '5400.00',
    });
    // La acreedora se declara EN SU NATURALEZA: los saldos cambian de signo,
    // Debe y Haber no, porque son sumas de importes y no saldos.
    expect(iA).toEqual({
      SaldoIni: '-4500.00',
      Debe: '1300.00',
      Haber: '400.00',
      SaldoFin: '-5400.00',
    });

    // Cada una cuadra con SU resta…
    expect(recalculoDelSat(iD, 'D').toFixed(2)).toBe(iD.SaldoFin);
    expect(recalculoDelSat(iA, 'A').toFixed(2)).toBe(iA.SaldoFin);
    // …y NO con la de la otra. Si la comprobación fuera simétrica —un `abs()`,
    // una resta sola— estas dos líneas darían iguales y no probarían nada.
    expect(recalculoDelSat(iD, 'A').toFixed(2)).not.toBe(iD.SaldoFin);
    expect(recalculoDelSat(iA, 'D').toFixed(2)).not.toBe(iA.SaldoFin);
    expect(recalculoDelSat(iD, 'A').toFixed(2)).toBe('3600.00');
  });

  it('contra el mayor de verdad: la ACREEDORA no se publica con el signo del libro', async () => {
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    const ingreso = atributosDe(b.xml, '4100');
    // 7 000 de enero + 1 300 de febrero, todo al haber.
    expect(ingreso).toMatchObject({
      SaldoIni: '7000.00',
      Debe: '0.00',
      Haber: '1300.00',
      SaldoFin: '8300.00',
    });
    // El mayor dice −7 000 y −8 300. Publicarlos tal cual entrega un archivo
    // cuyo recálculo da 5 700 donde el declarado dice 8 300.
    expect(
      new Decimal(ingreso.SaldoIni).plus(ingreso.Debe).minus(ingreso.Haber).toFixed(2)
    ).not.toBe(ingreso.SaldoFin);
    expect(
      new Decimal(ingreso.SaldoIni).minus(ingreso.Debe).plus(ingreso.Haber).toFixed(2)
    ).toBe(ingreso.SaldoFin);
  });
});

describe('el error más caro entre dos entregas: la balanza que nombra lo que el catálogo calló', () => {
  it('se coteja contra el ARTEFACTO archivado, y la cuenta omitida BLOQUEA con código 4', async () => {
    const g = await inquilinoDesechable('F07b ataque · catálogo real');
    enterTenant(g.tenantId);
    await seedPolicies({ tenantId: g.tenantId });
    await mapearTodoElPlan(g.entityId);
    // UNA cuenta se queda sin agrupador, y el despacho eligió omitirla.
    await resolvePolicy(
      { tenantId: g.tenantId },
      'anexo24_cuenta_sin_agrupador',
      'omitir_y_avisar',
      g.userId
    );
    await query(
      `UPDATE accounts SET codigo_agrupador_sat = NULL WHERE entity_id = $1 AND code = '1140'`,
      [g.entityId]
    );
    await asiento(g, 2, 'Movimiento de febrero', g.cuentas['1140'], g.cuentas['4100'], '900.0000');

    // Se GENERA y se ARCHIVA el catálogo de verdad.
    const cat = await generarCatalogoCuentas(
      { tenantId: g.tenantId, entityId: g.entityId },
      { entityId: g.entityId, anio: 2026, mes: 2, userId: g.userId }
    );
    expect(cat.puedeEntregarse).toBe(true);
    expect(cat.artefacto).not.toBeNull();
    expect(numerosDe(cat.xml as string)).not.toContain('1140');
    expect(cat.omitidas.map((o) => o.code)).toContain('1140');

    // Y ahora la balanza, SIN decirle contra qué cotejar: tiene que ir a
    // buscar el artefacto que se acaba de archivar.
    const v = await verificarBalanza(g.entityId, { periodo: g.periodos[2] });
    expect(v.catalogo?.origen).toBe('artefacto_archivado');
    expect(v.catalogo?.referencia).toBe(cat.artefacto?.hash_sha256);

    const falta = v.hallazgos.filter((h) => h.check === 'cuentas-en-catalogo');
    expect(falta.map((h) => h.referencia)).toContain('1140');
    expect(falta.every((h) => h.severity === 'blocking')).toBe(true);
    expect(checkExitCode(v.conteo)).toBe(ExitCode.VALIDATION);

    // Y `generate` se NIEGA: no se entrega un archivo que la autoridad rechaza.
    await expect(generarBalanza(g.entityId, { periodo: g.periodos[2] })).rejects.toThrow(
      /1140/
    );

    enterTenant(f.tenantId);
  }, 120_000);
});

describe('el descuadre inyectado', () => {
  it('check lo publica con su cuenta y su diferencia, y sale 4', async () => {
    const g = await inquilinoDesechable('F07b ataque · descuadre');
    enterTenant(g.tenantId);
    await seedPolicies({ tenantId: g.tenantId });
    await mapearTodoElPlan(g.entityId);

    await asiento(g, 2, 'Venta de febrero', g.cuentas['1120'], g.cuentas['4100'], '5000.0000');

    // EL ATAQUE: el asiento pertenece al periodo de FEBRERO
    // (fiscal_period_id) y su FECHA está en marzo. El movimiento se filtra por
    // periodo y el acumulado por fecha: ahí las dos lecturas se separan, que
    // es exactamente el descuadre que la autoridad recalcula.
    await asientoDesfasado(
      g,
      g.periodos[2],
      '2026-03-05',
      g.cuentas['1120'],
      g.cuentas['4100'],
      '1234.5600'
    );

    const v = await verificarBalanza(g.entityId, { periodo: g.periodos[2] });
    const saldos = v.hallazgos.filter((h) => h.check === 'saldos');
    expect(saldos.length).toBeGreaterThan(0);

    // Nombra LA CUENTA y trae LA DIFERENCIA dentro del texto.
    const cuentas = saldos.map((h) => h.referencia);
    expect(cuentas).toContain('1120');
    expect(cuentas).toContain('4100');
    expect(saldos.every((h) => h.severity === 'blocking')).toBe(true);
    const deLa1120 = saldos.find((h) => h.referencia === '1120');
    expect(deLa1120?.detalle).toContain('1234.5600');
    expect(deLa1120?.detalle).toContain('deudora');
    // La acreedora publica su diferencia EN SU NATURALEZA, no en la del mayor.
    const deLa4100 = saldos.find((h) => h.referencia === '4100');
    expect(deLa4100?.detalle).toContain('acreedora');
    expect(deLa4100?.detalle).toContain('1234.5600');

    expect(checkExitCode(v.conteo)).toBe(ExitCode.VALIDATION);
    await expect(generarBalanza(g.entityId, { periodo: g.periodos[2] })).rejects.toThrow(
      /no se genera/
    );

    enterTenant(f.tenantId);
  }, 120_000);
});

describe('el redondeo, que rompe una resta que en el mayor cuadraba', () => {
  it('cuatro columnas exactas al mayor y descuadradas a dos decimales: BLOQUEA', async () => {
    // La autoridad rehace la resta sobre las cifras QUE SE PRESENTARON, no
    // sobre las del libro. El mayor es DECIMAL(19,4) y el archivo lleva dos:
    //   0.0050 + 0.0050 − 0 = 0.0100   cuadra en el libro
    //   0.01   + 0.01   − 0 = 0.02 ≠ 0.01   no cuadra ya presentado
    // Un importe bien calculado y mal presentado se rechaza igual.
    const g = await inquilinoDesechable('F07b ataque · redondeo');
    enterTenant(g.tenantId);
    await seedPolicies({ tenantId: g.tenantId });
    await mapearTodoElPlan(g.entityId);
    await asiento(g, 1, 'Medio centavo de enero', g.cuentas['1120'], g.cuentas['4100'], '0.0050');
    await asiento(g, 2, 'Medio centavo de febrero', g.cuentas['1120'], g.cuentas['4100'], '0.0050');

    const v = await verificarBalanza(g.entityId, { periodo: g.periodos[2] });
    // El mayor NO tiene descuadre: por eso `saldos` calla y `redondeo` habla.
    expect(v.inicial.descuadres).toEqual([]);
    const redondeo = v.hallazgos.filter((h) => h.check === 'redondeo');
    expect(redondeo.map((h) => h.referencia).sort()).toEqual(['1120', '4100']);
    expect(redondeo.every((h) => h.severity === 'blocking')).toBe(true);
    expect(redondeo.find((h) => h.referencia === '1120')?.detalle).toContain('0.02');
    expect(checkExitCode(v.conteo)).toBe(ExitCode.VALIDATION);

    // Y el archivo NO se llega a construir: se niega antes.
    await expect(generarBalanza(g.entityId, { periodo: g.periodos[2] })).rejects.toThrow(
      /redondeadas a 2 decimales|no se genera/
    );

    enterTenant(f.tenantId);
  }, 120_000);
});

describe("con 'las_que_se_mueven', las dos entregas tienen que decir lo mismo", () => {
  it('la balanza no suspende su propia comprobación cruzada contra el catálogo real', async () => {
    // El criterio decide QUÉ CUENTAS entran, y tiene que decidir lo mismo en
    // los dos archivos. Si no, el generador produce una balanza que declara
    // cuentas que el catálogo —hecho con el mismo criterio— no contiene.
    const g = await inquilinoDesechable('F07b ataque · las que se mueven');
    enterTenant(g.tenantId);
    await seedPolicies({ tenantId: g.tenantId });
    await mapearTodoElPlan(g.entityId);
    await resolvePolicy(
      { tenantId: g.tenantId },
      'anexo24_niveles_a_presentar',
      'las_que_se_mueven',
      g.userId
    );
    await asiento(g, 1, 'Venta de enero', g.cuentas['1120'], g.cuentas['4100'], '1000.0000');
    await asiento(g, 2, 'Gasto de febrero', g.cuentas['5100'], g.cuentas['1120'], '250.0000');

    const cat = await generarCatalogoCuentas(
      { tenantId: g.tenantId, entityId: g.entityId },
      { entityId: g.entityId, anio: 2026, mes: 2, userId: g.userId }
    );
    expect(cat.puedeEntregarse, JSON.stringify(cat.hallazgos)).toBe(true);
    const declaradas = numerosDe(cat.xml as string);
    // Las movidas y SUS PADRES: sin el padre, SubCtaDe apuntaría fuera.
    expect(declaradas).toEqual(expect.arrayContaining(['1120', '4100', '5100', '1000', '1100']));
    expect(declaradas).not.toContain('1230');

    const v = await verificarBalanza(g.entityId, { periodo: g.periodos[2] });
    expect(v.catalogo?.origen).toBe('artefacto_archivado');
    const cruzada = v.hallazgos.filter(
      (h) => h.check === 'cuentas-en-catalogo' && h.severity === 'blocking'
    );
    expect(
      cruzada.map((h) => h.referencia),
      'la balanza declara cuentas que su propio catálogo no contiene'
    ).toEqual([]);

    // Y la balanza sale, con exactamente las cuentas que llevan cifras.
    const b = await generarBalanza(g.entityId, { periodo: g.periodos[2] });
    for (const c of numerosDe(b.xml)) expect(declaradas).toContain(c);

    enterTenant(f.tenantId);
  }, 120_000);
});

describe('el cierre SUAVE, que es lo que F07a arregló', () => {
  it('el saldo inicial NO es cero, y el XML lo hereda', async () => {
    // Enero cerró en suave. La única fuente que existía antes de F07a
    // —`account_balances.beginning_balance`, que sólo siembra el cierre DURO—
    // habría declarado CEROS: la entidad habría firmado que abrió febrero en
    // nada. Se comprueba en el ARCHIVO, no en el informe.
    const previo = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM account_balances
        WHERE entity_id = $1 AND fiscal_period_id = $2 AND beginning_balance <> 0`,
      [f.entityId, f.periodos[2]]
    );
    expect(previo.rows[0].n, 'el cierre suave no sembró arrastre: es la premisa').toBe('0');

    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(b.inicial.origen).toBe('mayor');
    expect(b.inicial.firme).toBe(false);
    expect(atributosDe(b.xml, '1120').SaldoIni).toBe('4500.00');
    expect(atributosDe(b.xml, '4100').SaldoIni).toBe('7000.00');
    expect(atributosDe(b.xml, '5100').SaldoIni).toBe('2500.00');
  });
});

// ============================================================
// 3 · CONTRA EL PROCESO
// ============================================================

describe('la e.firma: construir el archivo y firmarlo son actos de manos distintas', () => {
  const FUENTES = [
    'src/services/sat/anexo24/xml.ts',
    'src/services/sat/anexo24/validador.ts',
    'src/services/sat/anexo24/catalogo-cuentas.ts',
    'src/services/sat/anexo24/balanza-xml.ts',
    'src/services/sat/anexo24/balanza-invariantes.ts',
    'src/services/sat/anexo24/balanza-service.ts',
    'src/services/sat/anexo24/artefactos.ts',
    'src/services/sat/anexo24/index.ts',
    'src/cli/e-accounting-command.ts',
  ];

  it('NINGÚN camino del código carga una llave privada', () => {
    // Se busca en el CÓDIGO y no en la salida: un XML sin `Sello=` sólo dice
    // que esta corrida no selló. Lo que hay que poder afirmar es que no existe
    // la rama, con cualquier bandera y con cualquier política.
    const prohibidos = [
      /createSign\b/,
      /createPrivateKey\b/,
      /privateKey/i,
      /\bpkcs8\b/i,
      /\bpkcs12\b/i,
      /\.pfx\b/,
      /\bfiscal-credentials\b/,
      /\bfiel\b/i,
      /\.key\b/,
    ];
    const culpables: string[] = [];
    for (const rel of FUENTES) {
      const texto = readFileSync(path.join(RAIZ, rel), 'utf8');
      for (const patron of prohibidos) {
        if (patron.test(texto)) culpables.push(`${rel} :: ${String(patron)}`);
      }
    }
    expect(culpables).toEqual([]);
  });

  it('con la política en el defecto el archivo sale SIN SELLAR y el comando lo dice', async () => {
    const cat = await generarCatalogoCuentas(
      { tenantId: f.tenantId, entityId: f.entityId },
      { entityId: f.entityId, anio: 2026, mes: 2, userId: f.userId, dryRun: true }
    );
    expect(cat.politicas.sellado).toBe('nunca_sellar_en_el_sistema');
    expect(cat.sellado).toBe(false);
    expect(cat.notaDeSellado).toMatch(/SIN SELLAR/);

    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(b.meta.sellada).toBe(false);
    for (const atributo of ['Sello=', 'Certificado=', 'noCertificado=']) {
      expect(cat.xml).not.toContain(atributo);
      expect(b.xml).not.toContain(atributo);
    }
    // Y el archivo archivado consta como NO sellado: es un hecho registrado,
    // no una suposición de quien lea la tabla.
    const filas = await query<{ sellado: boolean }>(
      `SELECT sellado FROM sat_anexo24_artefactos WHERE entity_id = $1`,
      [f.entityId]
    );
    expect(filas.rows.every((x) => x.sellado === false)).toBe(true);
  });

  it("con 'sellar_con_custodia' declarado, la balanza AVISA de que aun así no sella", async () => {
    const g = await inquilinoDesechable('F07b ataque · custodia');
    enterTenant(g.tenantId);
    await seedPolicies({ tenantId: g.tenantId });
    await mapearTodoElPlan(g.entityId);
    await resolvePolicy(
      { tenantId: g.tenantId },
      'efirma_sellado_contabilidad_electronica',
      'sellar_con_custodia',
      g.userId
    );
    await asiento(g, 2, 'Venta', g.cuentas['1120'], g.cuentas['4100'], '10.0000');

    const v = await verificarBalanza(g.entityId, { periodo: g.periodos[2] });
    const sello = v.hallazgos.find((h) => h.check === 'sin-sello');
    expect(sello?.severity).toBe('warning');
    expect(sello?.detalle).toMatch(/no carga ninguna llave privada/);

    const cat = await generarCatalogoCuentas(
      { tenantId: g.tenantId, entityId: g.entityId },
      { entityId: g.entityId, anio: 2026, mes: 2, userId: g.userId, dryRun: true }
    );
    expect(cat.notaDeSellado).toMatch(/NO SELLA/);
    expect(cat.xml).not.toContain('Sello=');

    enterTenant(f.tenantId);
  }, 120_000);
});

describe("anexo24_cuenta_sin_agrupador en 'bloquear'", () => {
  it('se niega a generar y NOMBRA las cuentas', async () => {
    const g = await inquilinoDesechable('F07b ataque · sin agrupador');
    enterTenant(g.tenantId);
    await seedPolicies({ tenantId: g.tenantId });
    await mapearTodoElPlan(g.entityId);
    await query(
      `UPDATE accounts SET codigo_agrupador_sat = NULL WHERE entity_id = $1 AND code IN ('1140','2110')`,
      [g.entityId]
    );

    const cat = await generarCatalogoCuentas(
      { tenantId: g.tenantId, entityId: g.entityId },
      { entityId: g.entityId, anio: 2026, mes: 2, userId: g.userId }
    );
    expect(cat.politicas.sinAgrupador).toBe('bloquear');
    expect(cat.puedeEntregarse).toBe(false);
    expect(cat.xml).toBeNull();
    expect(cat.hash).toBeNull();

    const bloqueo = cat.hallazgos.find((h) => h.regla === 'CAT-SIN-AGRUPADOR-BLOQUEA');
    expect(bloqueo?.severidad).toBe('bloquea');
    // Las NOMBRA: una cuenta con su código y su nombre, no un recuento.
    expect(bloqueo?.mensaje).toContain('1140');
    expect(bloqueo?.mensaje).toContain('2110');
    expect(cat.sinAgrupador.map((c) => c.code).sort()).toEqual(['1140', '2110']);

    // Y NO se archiva nada: un artefacto no entregable es el archivo que
    // alguien firma por equivocación dentro de tres semanas.
    const filas = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sat_anexo24_artefactos WHERE entity_id = $1`,
      [g.entityId]
    );
    expect(filas.rows[0].n).toBe('0');

    enterTenant(f.tenantId);
  }, 120_000);
});

describe('la frontera de entidad (serie TEN)', () => {
  it('ni el catálogo ni la balanza de A contienen UNA SOLA cuenta de B', async () => {
    const soloDeB = '9-SOLO-DE-LA-HERMANA';
    await crearCuenta(hermana, soloDeB, 'Cuenta que sólo existe en la hermana', {
      level: 1,
      agrupador: '102.01',
    });
    await mapearTodoElPlan(hermana.entityId);
    await mapearTodoElPlan(f.entityId);

    const catA = await generarCatalogoCuentas(
      { tenantId: f.tenantId, entityId: f.entityId },
      { entityId: f.entityId, anio: 2026, mes: 2, userId: f.userId, dryRun: true }
    );
    const balA = await generarBalanza(f.entityId, { periodo: f.periodos[2] });

    expect(numerosDe(catA.xml as string)).not.toContain(soloDeB);
    expect(numerosDe(balA.xml)).not.toContain(soloDeB);

    // Y al revés: el catálogo de A y el de B declaran conjuntos distintos, y
    // ninguno de los dos es un superconjunto del otro por accidente.
    const catB = await generarCatalogoCuentas(
      { tenantId: hermana.tenantId, entityId: hermana.entityId },
      { entityId: hermana.entityId, anio: 2026, mes: 2, userId: hermana.userId, dryRun: true }
    );
    expect(numerosDe(catB.xml as string)).toContain(soloDeB);

    const deA = new Set(await codigosDe(f.entityId));
    const enBQueNoEstanEnA = numerosDe(catB.xml as string).filter((c) => !deA.has(c));
    expect(enBQueNoEstanEnA).toEqual([soloDeB]);
  }, 120_000);

  it('el asiento de B no mete a B en la balanza de A', async () => {
    await asiento(
      hermana,
      2,
      'Movimiento sólo de la hermana',
      hermana.cuentas['1120'],
      hermana.cuentas['4100'],
      '99999.0000'
    );
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(b.xml).not.toContain('99999');
    expect(atributosDe(b.xml, '4100').Haber).toBe('1300.00');
  });

  it('el catálogo y la balanza declaran el MISMO RFC aunque esté guardado en minúsculas', async () => {
    // `legal_entities.tax_id` no tiene ni CHECK ni normalización de escritura:
    // se comprobó contra el esquema. Si una superficie lo normaliza y la otra
    // no, las dos entregas del mismo mes van con RFC distinto —o una de las
    // dos ni siquiera sale—, y el acuse se cotea contra el RFC del archivo.
    const g = await inquilinoDesechable('F07b ataque · RFC en minúsculas');
    enterTenant(g.tenantId);
    await seedPolicies({ tenantId: g.tenantId });
    await mapearTodoElPlan(g.entityId);
    await query(`UPDATE legal_entities SET tax_id = '  xaxx010101000 ' WHERE id = $1`, [
      g.entityId,
    ]);
    await asiento(g, 2, 'Venta', g.cuentas['1120'], g.cuentas['4100'], '10.0000');

    const cat = await generarCatalogoCuentas(
      { tenantId: g.tenantId, entityId: g.entityId },
      { entityId: g.entityId, anio: 2026, mes: 2, userId: g.userId, dryRun: true }
    );
    expect(cat.rfc).toBe('XAXX010101000');

    const b = await generarBalanza(g.entityId, { periodo: g.periodos[2] });
    expect(b.meta.rfc, 'la balanza tiene que declarar el mismo RFC que el catálogo').toBe(
      cat.rfc
    );
    expect(b.xml).toContain('RFC="XAXX010101000"');
    expect(b.nombre.startsWith('XAXX010101000')).toBe(true);

    enterTenant(f.tenantId);
  }, 120_000);

  it('la balanza NO resuelve una entidad de otro inquilino, igual que el catálogo', async () => {
    // El catálogo lleva la entidad Y el inquilino DENTRO del SQL
    // (catalogo-cuentas.ts:544). La balanza sólo la entidad
    // (balanza-service.ts:112). Como esta suite corre con RLS inerte —a
    // propósito, para medir la frontera del CÓDIGO—, la asimetría se ve.
    const otro = await inquilinoDesechable('F07b ataque · otro inquilino');
    enterTenant(otro.tenantId);
    await seedPolicies({ tenantId: otro.tenantId });
    await mapearTodoElPlan(otro.entityId);
    await asiento(otro, 2, 'Venta ajena', otro.cuentas['1120'], otro.cuentas['4100'], '777.0000');

    // Volvemos al inquilino de f: es SU sesión la que pide la entidad ajena.
    enterTenant(f.tenantId);

    await expect(
      generarCatalogoCuentas(
        { tenantId: f.tenantId, entityId: otro.entityId },
        { entityId: otro.entityId, anio: 2026, mes: 2, userId: f.userId, dryRun: true }
      ),
      'el catálogo sí acota por inquilino'
    ).rejects.toThrow(/no existe en este inquilino/);

    // La balanza tiene que negarse igual.
    await expect(
      verificarBalanza(otro.entityId, { periodo: otro.periodos[2] }),
      'la balanza de una entidad de otro inquilino no debería resolverse'
    ).rejects.toThrow();
  }, 120_000);
});
