import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { softClosePeriod } from '../../src/services/accounting/period-close.js';
import {
  seedPolicies,
  resolvePolicy,
  reopenPolicy,
} from '../../src/services/policy/policy-service.js';
import { ValidationError } from '../../src/utils/errors.js';
import { JournalEntryType } from '../../src/types/index.js';
import { checkExitCode, ExitCode } from '../../src/cli/kernel/exit.js';
import {
  catalogoSegunElPlanDeCuentas,
  generarBalanza,
  resolverPeriodoDeBalanza,
  verificarBalanza,
} from '../../src/services/sat/anexo24/balanza-service.js';
import type { CatalogoDeReferencia } from '../../src/services/sat/anexo24/balanza-invariantes.js';
import { archivarArtefacto } from '../../src/services/sat/anexo24/artefactos.js';

// ============================================================
// F07b · LA BALANZA QUE SE ENTREGA, MEDIDA CONTRA POSTGRES.
//
// Las unitarias (tests/sat/anexo24/) prueban la aritmética y la forma del
// archivo con las cuatro columnas ya en la mano. Lo que NO pueden probar es
// que esas cuatro columnas sean las del mayor de verdad: un arnés que fabrica
// las filas sólo reproduce la resta que el código escribe. Que el SaldoIni de
// febrero sea el acumulado real de enero lo dice el mayor o no lo dice nadie,
// y de ahí este archivo, en la línea de f07a-balanza-de-cuatro-columnas.
//
// EL EJERCICIO ES EL DE F07a, a propósito: es el que ya tiene comprobado
// contra la base cuánto vale cada columna, así que aquí lo que se mide es la
// TRADUCCIÓN al archivo, y en particular el signo.
//
//   ENERO    venta   1120 debe 7 000 · 4100 haber 7 000
//            costo   5100 debe 2 500 · 1120 haber 2 500
//   FEBRERO  venta   1120 debe 1 300 · 4100 haber 1 300
//            gasto   5100 debe   400 · 1120 haber   400
//
//   Balanza de FEBRERO en el MAYOR (deudor positivo) y EN EL ARCHIVO:
//     1120  D   ini  4 500 → SaldoIni  4500.00 ... SaldoFin  5400.00
//     4100  A   ini −7 000 → SaldoIni  7000.00 ... SaldoFin  8300.00
//     5100  D   ini  2 500 → SaldoIni  2500.00 ... SaldoFin  2900.00
//
// La fila de 4100 es la prueba entera: publicar el −7 000 del mayor entrega un
// archivo cuyo recálculo da 5 700 donde el declarado dice 8 300.
//
// Corre como superusuario a propósito: RLS queda inerte y lo que se comprueba
// es la frontera del CÓDIGO (ver frontera-entidad-ten).
// ============================================================

let f: Fixture;

async function asiento(
  fx: Fixture,
  mes: number,
  descripcion: string,
  cargo: string,
  abono: string,
  monto: string
) {
  return createJournalEntry(
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
}

/** El nodo Ctas de una cuenta, tal cual sale en el XML. */
function nodo(xml: string, numCta: string): string {
  const linea = xml.split('\n').find((l) => l.includes(`NumCta="${numCta}"`));
  expect(linea, `el archivo no declara la cuenta ${numCta}`).toBeDefined();
  return linea!.trim();
}

/** Un catálogo de referencia que declara exactamente estas cuentas. */
const catalogoCon = (...cuentas: string[]): CatalogoDeReferencia => ({
  origen: 'artefacto_archivado',
  referencia: 'artefacto-de-prueba',
  cuentas,
});

beforeAll(async () => {
  f = await crearInquilino('F07b balanza que se entrega');
  enterTenant(f.tenantId);
  await asiento(f, 1, 'Venta de enero', f.cuentas['1120'], f.cuentas['4100'], '7000.0000');
  await asiento(f, 1, 'Costo de enero', f.cuentas['5100'], f.cuentas['1120'], '2500.0000');
  await asiento(f, 2, 'Venta de febrero', f.cuentas['1120'], f.cuentas['4100'], '1300.0000');
  await asiento(f, 2, 'Gasto de febrero', f.cuentas['5100'], f.cuentas['1120'], '400.0000');
  await softClosePeriod(f.periodos[1], f.entityId, f.userId, 'cierre suave de enero');
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

// ============================================================
// 1 · EL SIGNO, QUE ES LO QUE EL MAYOR NO SABE
// ============================================================

describe('la balanza de febrero, ya como archivo', () => {
  it('la ACREEDORA se declara en su naturaleza y el recálculo cuadra', async () => {
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    // 7 000 + 1 300 al haber = 8 300. El mayor dice −7 000 y −8 300.
    expect(nodo(b.xml, '4100')).toBe(
      '<BCE:Ctas NumCta="4100" SaldoIni="7000.00" Debe="0.00" Haber="1300.00" SaldoFin="8300.00"/>'
    );
  });

  it('las deudoras salen tal cual, y el saldo inicial viene DERIVADO del mayor', async () => {
    // Enero cerró en SUAVE: con la única fuente que había antes de F07a
    // —el arrastre del cierre duro— estas tres SaldoIni serían cero.
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(nodo(b.xml, '1120')).toBe(
      '<BCE:Ctas NumCta="1120" SaldoIni="4500.00" Debe="1300.00" Haber="400.00" SaldoFin="5400.00"/>'
    );
    expect(nodo(b.xml, '5100')).toBe(
      '<BCE:Ctas NumCta="5100" SaldoIni="2500.00" Debe="400.00" Haber="0.00" SaldoFin="2900.00"/>'
    );
    expect(b.inicial.origen).toBe('mayor');
    expect(b.inicial.desde).toBe('2026-02-01');
    expect(b.inicial.firme).toBe(false);
  });

  it('el archivo declara el periodo y NO lleva sello', async () => {
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(b.meta).toMatchObject({
      rfc: 'XAXX010101000',
      anio: 2026,
      mes: '02',
      tipo_envio: 'N',
      cierre: false,
      sellada: false,
      criterio_sellado: 'nunca_sellar_en_el_sistema',
    });
    expect(b.xml).not.toContain('Sello=');
    expect(b.nombre).toBe('XAXX010101000202602BN.XML');
  });

  it('se ARCHIVA con su hash, y --dry-run recorre el camino sin archivar', async () => {
    const ensayo = await generarBalanza(f.entityId, {
      periodo: f.periodos[2],
      generadoPor: f.userId,
      dryRun: true,
    });
    expect(ensayo.artefacto).toBeNull();
    expect(ensayo.xml.length).toBeGreaterThan(0);

    const guardada = await generarBalanza(f.entityId, {
      periodo: f.periodos[2],
      generadoPor: f.userId,
    });
    expect(guardada.artefacto?.yaExistia).toBe(false);
    expect(guardada.artefacto?.hash_sha256).toBe(ensayo.hash);

    // El ensayo y la real producen los MISMOS bytes: eso es lo que hace que un
    // ensayo signifique algo. Y regenerar no crea una versión nueva.
    const otraVez = await generarBalanza(f.entityId, {
      periodo: f.periodos[2],
      generadoPor: f.userId,
    });
    expect(otraVez.artefacto?.yaExistia).toBe(true);
    expect(otraVez.artefacto?.id).toBe(guardada.artefacto?.id);

    const filas = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sat_anexo24_artefactos
        WHERE entity_id = $1 AND tipo = 'balanza'`,
      [f.entityId]
    );
    expect(filas.rows[0].n).toBe('1');
  });

  it('dos generaciones del mismo periodo dan el MISMO hash', async () => {
    // El requisito literal del catálogo de comandos. Es también la
    // comprobación más barata de que el generador es determinista: si algo
    // fechado o aleatorio se colara en el archivo, aquí se ve.
    const a = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(a.hash).toBe(b.hash);
    expect(a.bytes).toBe(b.bytes);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('el periodo se puede pedir por id, por nombre o por mes de calendario', async () => {
    const porId = await resolverPeriodoDeBalanza(f.entityId, { periodo: f.periodos[2] });
    const porNombre = await resolverPeriodoDeBalanza(f.entityId, { periodo: 'Periodo 2/2026' });
    const porMes = await resolverPeriodoDeBalanza(f.entityId, { periodo: '2026-02' });
    for (const p of [porId, porNombre, porMes]) {
      expect(p.mes).toBe('02');
      expect(p.anio).toBe(2026);
      expect(p.fiscal_period_id).toBe(f.periodos[2]);
    }
  });

  it('un trimestre no tiene dónde ponerse en el archivo, y se niega', async () => {
    await expect(
      resolverPeriodoDeBalanza(f.entityId, { periodo: '2026-Q1' })
    ).rejects.toThrow(/no es un mes natural/);
  });
});

// ============================================================
// 2 · CHECK: LO QUE EL SAT REVISA, Y EL CÓDIGO 4
// ============================================================

describe('balance check', () => {
  it('una balanza sana no tiene hallazgos bloqueantes y sale 0', async () => {
    const r = await verificarBalanza(f.entityId, {
      periodo: f.periodos[2],
      catalogo: catalogoCon(...(await todasLasCuentas())),
    });
    expect(r.conteo.blocking).toBe(0);
    expect(checkExitCode(r.conteo)).toBe(ExitCode.OK);
  });

  it('una cuenta que el catálogo no declara BLOQUEA, y sale 4', async () => {
    // El error más caro del Anexo 24: la balanza referencia una cuenta que el
    // catálogo nunca declaró. No se puede ver mirando un solo archivo.
    const cuentas = (await todasLasCuentas()).filter((c) => c !== '4100');
    const r = await verificarBalanza(f.entityId, {
      periodo: f.periodos[2],
      catalogo: catalogoCon(...cuentas),
    });
    const falta = r.hallazgos.filter((h) => h.check === 'cuentas-en-catalogo');
    expect(falta.map((h) => h.referencia)).toContain('4100');
    expect(r.conteo.blocking).toBeGreaterThan(0);
    expect(checkExitCode(r.conteo)).toBe(ExitCode.VALIDATION);
  });

  it('SIN catálogo ninguno bloquea: no pasa en limpio por no haber mirado', async () => {
    const r = await verificarBalanza(f.entityId, { periodo: f.periodos[2], catalogo: null });
    expect(r.hallazgos.some((h) => h.check === 'cuentas-en-catalogo')).toBe(true);
    expect(checkExitCode(r.conteo)).toBe(ExitCode.VALIDATION);
  });

  it('cotejar contra el plan de cuentas de hoy es advertencia, y --strict la sube a 4', async () => {
    const r = await verificarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(r.catalogo?.origen).toBe('plan_de_cuentas');
    expect(r.conteo.blocking).toBe(0);
    expect(r.conteo.warning).toBeGreaterThan(0);
    expect(checkExitCode(r.conteo)).toBe(ExitCode.OK);
    expect(checkExitCode(r.conteo, { strict: true })).toBe(ExitCode.VALIDATION);
  });

  it('`--check` corre exactamente las que se nombran', async () => {
    const r = await verificarBalanza(f.entityId, {
      periodo: f.periodos[2],
      catalogo: null,
      checks: ['saldos'],
    });
    expect(r.checks).toEqual(['saldos']);
    expect(r.hallazgos).toEqual([]); // el catálogo ausente no se preguntó
  });

  it('el sobre de F07a viaja entero: procedencia, firmeza y descuadres', async () => {
    const r = await verificarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(r.inicial.criterio).toBe('derivar_del_mayor');
    expect(r.inicial.descuadres).toEqual([]);
    expect(r.inicial.periodo_anterior).toEqual({
      period_name: 'Periodo 1/2026',
      status: 'soft_close',
    });
  });
});

// ============================================================
// 3 · LA FRONTERA DE ENTIDAD
// ============================================================

describe('la frontera de entidad', () => {
  it('un periodo de la entidad HERMANA no fecha esta balanza', async () => {
    // Mismo inquilino, otra entidad: el eje que RLS no defiende. Sin el
    // `AND entity_id` dentro del SQL, el periodo de la hermana habría fechado
    // esta balanza y el archivo habría salido con el mes de otra sociedad.
    const hermana = await crearEntidadHermana(f, 'Hermana de F07b');
    await expect(
      generarBalanza(f.entityId, { periodo: hermana.periodos[2] })
    ).rejects.toThrow(ValidationError);
  });
});

// ============================================================
// 4 · LOS TRES TIPOS
// ============================================================

let ajustes: string;

describe('normal, complementaria y de cierre', () => {
  beforeAll(async () => {
    // El periodo de AJUSTES del ejercicio: es lo que distingue a la balanza de
    // cierre en los libros. En el archivo lo que la distingue es Mes 13.
    ajustes = uuidv4();
    await query(
      `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name,
         start_date, end_date, period_type, status)
       VALUES ($1, $2, $3, 13, 'Ajustes 2026', '2026-12-01', '2026-12-31', 'adjustment', 'open')`,
      [ajustes, f.fiscalYearId, f.entityId]
    );
  });

  it('la complementaria necesita FechaModBal', async () => {
    await expect(
      generarBalanza(f.entityId, { periodo: f.periodos[2], tipo: 'C' })
    ).rejects.toThrow(/FechaModBal/);
    const b = await generarBalanza(f.entityId, {
      periodo: f.periodos[2],
      tipo: 'C',
      fechaModBal: '2026-04-15',
    });
    expect(b.xml).toContain('TipoEnvio="C"');
    expect(b.xml).toContain('FechaModBal="2026-04-15"');
    expect(b.nombre).toBe('XAXX010101000202602BC.XML');
  });

  it('la de CIERRE sale con Mes 13 y del periodo de ajustes', async () => {
    const b = await generarBalanza(f.entityId, { cierre: true });
    expect(b.meta.mes).toBe('13');
    expect(b.meta.cierre).toBe(true);
    expect(b.meta.period_name).toBe('Ajustes 2026');
    expect(b.xml).toContain('Mes="13"');
    // Su SaldoIni es el acumulado hasta noviembre, o sea el de febrero: no se
    // posteó nada después. Y su movimiento es cero, porque los ajustes de
    // cierre todavía no se han hecho.
    expect(nodo(b.xml, '4100')).toBe(
      '<BCE:Ctas NumCta="4100" SaldoIni="8300.00" Debe="0.00" Haber="0.00" SaldoFin="8300.00"/>'
    );
  });

  it('sin periodo de ajustes, --closing se NIEGA en vez de presentar diciembre', async () => {
    // Presentar diciembre con Mes 13 entrega como balanza de cierre una que no
    // contiene el cierre. El archivo se acepta y nadie se entera.
    const hermana = await crearEntidadHermana(f, 'Hermana sin ajustes');
    await expect(generarBalanza(hermana.entityId, { cierre: true })).rejects.toThrow(
      /periodo de cierre/
    );
  });
});

// ============================================================
// 5 · LOS TRES CRITERIOS DEL PANEL, LEÍDOS DE LA BASE
// ============================================================

describe('el panel manda', () => {
  beforeAll(async () => {
    // Se siembra y se contesta en el MISMO alcance —el del inquilino—: una
    // decisión se resuelve donde se midió su evidencia.
    await seedPolicies({ tenantId: f.tenantId });
  });

  it('efirma_sellado_contabilidad_electronica: con custodia se AVISA, y nunca se sella', async () => {
    await fijarCriterio('efirma_sellado_contabilidad_electronica', 'sellar_con_custodia');
    const r = await verificarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(r.meta.criterio_sellado).toBe('sellar_con_custodia');
    const sello = r.hallazgos.find((h) => h.check === 'sin-sello');
    expect(sello?.severity).toBe('warning');

    // Y el archivo sigue saliendo sin sello: el criterio cambia lo que se
    // DICE, no abre ninguna llave privada.
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(b.meta.sellada).toBe(false);
    expect(b.xml).not.toContain('Sello=');
    expect(b.hallazgos.some((h) => h.check === 'sin-sello')).toBe(true);

    await fijarCriterio('efirma_sellado_contabilidad_electronica', 'nunca_sellar_en_el_sistema');
  });

  it('anexo24_niveles_a_presentar: «las que se mueven» recorta la población', async () => {
    const completa = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    await fijarCriterio('anexo24_niveles_a_presentar', 'las_que_se_mueven');
    const recortada = await generarBalanza(f.entityId, { periodo: f.periodos[2] });

    expect(recortada.meta.criterio_niveles).toBe('las_que_se_mueven');
    expect(recortada.meta.cuentas).toBeLessThan(completa.meta.cuentas);
    // Las tres del ejercicio siguen: llevan cifra.
    for (const c of ['1120', '4100', '5100']) expect(recortada.xml).toContain(`NumCta="${c}"`);
    // La cuenta de banco no se movió y no arrastra nada: no tiene qué declarar.
    expect(completa.xml).toContain('NumCta="1111"');
    expect(recortada.xml).not.toContain('NumCta="1111"');

    await fijarCriterio('anexo24_niveles_a_presentar', 'jerarquia_completa');
  });

  it('anexo24_cuenta_sin_agrupador: «omitir» deja la balanza sin catálogo que la respalde', async () => {
    // La coherencia entre las dos entregas es el punto: si el catálogo omite
    // las cuentas sin agrupador, la balanza que las declara referencia cuentas
    // que la autoridad no conoce. El cotejo lo dice, cuenta por cuenta.
    await query(`UPDATE accounts SET codigo_agrupador_sat = '105.01' WHERE id = $1`, [
      f.cuentas['1120'],
    ]);
    await fijarCriterio('anexo24_cuenta_sin_agrupador', 'omitir_y_avisar');

    const catalogo = await catalogoSegunElPlanDeCuentas(f.entityId);
    expect(catalogo.criterio_sin_agrupador).toBe('omitir_y_avisar');
    expect(catalogo.cuentas).toEqual(['1120']);
    expect(catalogo.sin_agrupador).toContain('4100');

    const r = await verificarBalanza(f.entityId, { periodo: f.periodos[2] });
    const senaladas = r.hallazgos
      .filter((h) => h.check === 'cuentas-en-catalogo' && h.referencia !== '')
      .map((h) => h.referencia);
    expect(senaladas).toContain('4100');
    expect(senaladas).not.toContain('1120');
    expect(r.hallazgos.find((h) => h.referencia === '4100')?.detalle).toContain('omitir_y_avisar');
    expect(checkExitCode(r.conteo)).toBe(ExitCode.VALIDATION);

    // Y el generador se NIEGA: entregar ese archivo cuesta un rechazo con el
    // plazo ya gastado.
    await expect(generarBalanza(f.entityId, { periodo: f.periodos[2] })).rejects.toThrow(
      /no se genera/
    );

    await fijarCriterio('anexo24_cuenta_sin_agrupador', 'bloquear');
  });
});

// ============================================================
// 6 · CUANDO LOS DOS EJES NO DICEN LO MISMO
// ============================================================

describe('el descuadre que F07a calcula, publicado por check', () => {
  beforeAll(async () => {
    // EL PERIODO DE AJUSTES SE REUBICA SOBRE FEBRERO. Es el device de F07a:
    // dos periodos que cubren las mismas fechas hacen que el eje de la FECHA y
    // el eje del PERIODO FISCAL dejen de coincidir —el movimiento se filtra por
    // fiscal_period_id y los acumulados por fecha—, que es lo que en la vida
    // real produce un asiento reasignado de periodo.
    //
    // Se hace así y no moviendo un asiento porque un asiento POSTEADO no se
    // edita: el trigger lo impide y tiene razón (NIF B-1, el hecho contable se
    // corrige por reversa). Que el arnés no pueda fabricar el defecto por la
    // puerta prohibida es una buena señal sobre la puerta.
    await query(
      `UPDATE fiscal_periods SET start_date = '2026-02-01', end_date = '2026-02-28'
        WHERE id = $1 AND entity_id = $2`,
      [ajustes, f.entityId]
    );
  });

  it('check NOMBRA cada cuenta y su diferencia, en el signo del archivo', async () => {
    const r = await verificarBalanza(f.entityId, {
      periodo: ajustes,
      catalogo: catalogoCon(...(await todasLasCuentas())),
    });
    const saldos = r.hallazgos.filter((h) => h.check === 'saldos');
    expect(saldos.map((h) => h.referencia).sort()).toEqual(['1120', '4100', '5100']);
    expect(saldos.every((h) => h.severity === 'blocking')).toBe(true);

    // 1120 es DEUDORA: la diferencia sale con el signo del mayor.
    expect(saldos.find((h) => h.referencia === '1120')?.detalle).toContain('-900.0000');
    // 4100 es ACREEDORA: el mayor la descuadra en +1 300 y el archivo la
    // declara al revés. Ésta es la traducción que hace legible el hallazgo —y
    // la que un `abs()` habría perdido.
    const acreedora = saldos.find((h) => h.referencia === '4100');
    expect(acreedora?.detalle).toContain('acreedora');
    expect(acreedora?.detalle).toContain('7000.0000');
    expect(acreedora?.detalle).toContain('8300.0000');
    expect(acreedora?.detalle).toContain('-1300.0000');

    expect(checkExitCode(r.conteo)).toBe(ExitCode.VALIDATION);
  });

  it('los descuadres NO se recalculan: son los que F07a ya trae', async () => {
    const r = await verificarBalanza(f.entityId, { periodo: ajustes });
    expect(r.inicial.descuadres.map((d) => d.account_code).sort()).toEqual([
      '1120',
      '4100',
      '5100',
    ]);
    expect(r.inicial.note).toMatch(/fail SaldoIni \+ Debe − Haber = SaldoFin/);
  });

  it('y el generador se niega a producir un archivo que la autoridad va a rechazar', async () => {
    await expect(generarBalanza(f.entityId, { periodo: ajustes })).rejects.toThrow(/no se genera/);
  });
});

// ============================================================
// 7 · CONTRA EL CATÁLOGO QUE DE VERDAD SE ENTREGÓ
//
// VA AL FINAL A PROPÓSITO: en cuanto hay un artefacto archivado, TODO cotejo
// posterior se hace contra él, y este catálogo de prueba declara dos cuentas.
// Ponerlo antes convertiría las secciones de arriba en pruebas de este
// artefacto y no de lo que dicen probar.
// ============================================================

describe('el cotejo prefiere el artefacto archivado', () => {
  it('lee los NumCta del CtaCatalogo guardado y coteja contra ÉSOS', async () => {
    // Mientras no hay artefacto, el cotejo reconstruye el catálogo del plan de
    // cuentas y lo advierte. En cuanto hay uno, se coteja contra el archivo que
    // se entregó, que es la única comparación que la autoridad va a rehacer.
    const antes = await verificarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(antes.catalogo?.origen).toBe('plan_de_cuentas');

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<catalogocuentas:Catalogo Version="1.3" RFC="XAXX010101000" Mes="02" Anio="2026">\n' +
      '  <catalogocuentas:Ctas CodAgrup="105.01" NumCta="1120" Desc="Cuentas por Cobrar" Nivel="1" Natur="D"/>\n' +
      '  <catalogocuentas:Ctas CodAgrup="501.01" NumCta="5100" Desc="Costo de Ventas" Nivel="1" Natur="D"/>\n' +
      '</catalogocuentas:Catalogo>\n';
    await archivarArtefacto({
      tenantId: f.tenantId,
      entityId: f.entityId,
      tipo: 'catalogo',
      version: '1.3',
      rfc: 'XAXX010101000',
      anio: 2026,
      mes: 2,
      tipoEnvio: 'N',
      xml,
      politicaSellado: 'nunca_sellar_en_el_sistema',
      hallazgos: [],
      generadoPor: f.userId,
    });

    const r = await verificarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(r.catalogo?.origen).toBe('artefacto_archivado');
    expect(r.catalogo?.cuentas).toEqual(['1120', '5100']);
    // Y ahora el cotejo acusa DE VERDAD: 4100 está en la balanza y no en el
    // catálogo entregado. Es el error más caro del Anexo 24, y no se puede ver
    // mirando un solo archivo.
    const senaladas = r.hallazgos
      .filter((h) => h.check === 'cuentas-en-catalogo')
      .map((h) => h.referencia);
    expect(senaladas).toContain('4100');
    expect(checkExitCode(r.conteo)).toBe(ExitCode.VALIDATION);
    // Ya no hay advertencia de «se cotejó contra el plan de hoy».
    expect(r.hallazgos.some((h) => h.detalle.includes('no contra un catálogo'))).toBe(false);

    // El artefacto es de ESTA entidad: la hermana no lo ve.
    const hermana = await crearEntidadHermana(f, 'Hermana sin catálogo');
    const suya = await verificarBalanza(hermana.entityId, { periodo: hermana.periodos[2] });
    expect(suya.catalogo?.origen).toBe('plan_de_cuentas');
  });
});


/**
 * Contesta un criterio del panel, reabriéndolo si ya estaba contestado.
 * `resolvePolicy` sólo toca filas 'pending' a propósito —una decisión no se
 * pisa sin reabrirla—, y una prueba que cambia de criterio dos veces tiene que
 * pasar por la misma puerta que un humano.
 */
async function fijarCriterio(key: string, valor: string): Promise<void> {
  const r = await query<{ status: string }>(
    `SELECT status FROM policy_decisions
      WHERE tenant_id = $1 AND key = $2 AND entity_id IS NULL`,
    [f.tenantId, key]
  );
  if (r.rows[0]?.status !== 'pending') await reopenPolicy({ tenantId: f.tenantId }, key);
  await resolvePolicy({ tenantId: f.tenantId }, key, valor, f.userId, 'prueba de integración F07b');
}

/** Los códigos de todas las cuentas activas de la entidad. */
async function todasLasCuentas(): Promise<string[]> {
  const r = await query<{ code: string }>(
    'SELECT code FROM accounts WHERE entity_id = $1 AND is_active = true ORDER BY code',
    [f.entityId]
  );
  return r.rows.map((x) => x.code);
}
