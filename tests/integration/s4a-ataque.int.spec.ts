import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';
import { closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  SQL_POLITICAS_DIRECTAS,
  discrimina,
  type PoliticaDirecta,
} from './helpers/rls-censo.js';
import {
  CRITERIOS,
  conFuenteMutada,
  crudoDe,
  SUELO_COBERTURA_UNITARIA,
  type Criterio,
} from '../../src/plan/criterios.js';

// ============================================================
// S4a · EL ATAQUE AL INSTRUMENTO QUE SE MIDE A SÍ MISMO
//
// La pregunta de este archivo no es «¿el arreglo funciona?» sino «¿el arreglo
// se mide a sí mismo, o vuelve a medirse el texto?». Por eso NINGUNA rotura de
// aquí es de las que el implementador declaró como espejo: un espejo escrito
// por el autor demuestra que el criterio ve LO QUE EL AUTOR PENSÓ. Lo que hay
// que saber es si ve lo que el autor NO pensó.
//
// Seis frentes, todos con salida real:
//   1. roturas NO declaradas del dinero → ¿los criterios de conducta en rojo?
//   2. la clasificación del silencio: el escenario que SE MONTA y luego se cae;
//   3. el trinquete de cobertura contra trampas que no son «bajar el número»;
//   4. la sonda de RLS contra tres políticas inofensivas distintas;
//   5. el arnés de mutación: ¿acusa a un criterio muerto? ¿no es circular?
//   6. higiene: el árbol real queda byte a byte como estaba.
//
// SE ESCRIBE EN DISCO, igual que plan-conducta-mutacion.int.spec.ts y por la
// misma razón: lo que corre en el hijo no es lo que ningún regex lee. Se
// restaura en `finally`, en `afterEach` y se AFIRMA al final.
// ============================================================

const RAIZ = path.resolve(__dirname, '..', '..');

const ARCHIVOS_TOCADOS = [
  'src/services/reporting/report-service.ts',
  'src/services/accounting/period-close.ts',
  'src/database/scope.ts',
  'src/plan/criterios.ts',
];
const originales = new Map<string, string>();
for (const rel of ARCHIVOS_TOCADOS) {
  originales.set(rel, fs.readFileSync(path.join(RAIZ, rel), 'utf-8'));
}

function restaurarTodo(): void {
  for (const [rel, texto] of originales) {
    const abs = path.join(RAIZ, rel);
    if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf-8') !== texto) {
      fs.writeFileSync(abs, texto, 'utf-8');
    }
  }
}

afterEach(restaurarTodo);

/** Sustituye `de` por `a` en un archivo real y afirma que la mutación mordió. */
function mutarEnDisco(rel: string, de: string, a: string): void {
  const original = originales.get(rel);
  if (original === undefined) throw new Error(`${rel} no está en ARCHIVOS_TOCADOS`);
  expect(original.includes(de), `el ancla ya no existe en ${rel}: «${de.slice(0, 90)}»`).toBe(true);
  fs.writeFileSync(path.join(RAIZ, rel), original.replace(de, a), 'utf-8');
}

interface Veredicto {
  resultados?: Record<string, { estado: string; detalle: string }>;
  motivo?: string;
}

/** Corre el escenario de conducta en un hijo, como hace `plan:status`. */
function correrEscenario(): Veredicto {
  const salida = path.join(os.tmpdir(), `s4a-ataque-${crypto.randomBytes(6).toString('hex')}.json`);
  const r = spawnSync('npx', ['tsx', path.join(RAIZ, 'src', 'plan', 'conducta.ts'), `--salida=${salida}`], {
    cwd: RAIZ,
    encoding: 'utf-8',
    timeout: 240_000,
  });
  if (!fs.existsSync(salida)) {
    const cola = (r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' · ');
    return { motivo: `el hijo no dejó veredicto (código ${r.status ?? '?'}): ${cola}` };
  }
  const v = JSON.parse(fs.readFileSync(salida, 'utf-8')) as Veredicto;
  fs.unlinkSync(salida);
  return v;
}

// ============================================================
// 1 · ¿EJECUTAN DE VERDAD? ROTURAS QUE NADIE DECLARÓ
// ============================================================

describe('1 · el criterio que ejecuta, contra roturas que su autor NO declaró', () => {
  it('la balanza que pierde su frontera de entidad lo pone en rojo', () => {
    // El signo de la resta —el espejo declarado— se deja intacto. Lo que se
    // rompe es el ACOTE: la balanza deja de filtrar por entidad y publica las
    // cuentas de todos los inquilinos del servidor.
    mutarEnDisco(
      'src/services/reporting/report-service.ts',
      "let where = 'WHERE a.entity_id = $1 AND a.is_active = true';",
      "let where = 'WHERE a.is_active = true';"
    );
    const v = correrEscenario();
    expect(v.motivo, `el escenario no se montó: ${v.motivo ?? ''}`).toBeUndefined();
    expect(
      v.resultados?.['frontera-de-inquilino']?.estado,
      `siguió VERDE con la balanza sin acotar: ${v.resultados?.['frontera-de-inquilino']?.detalle ?? ''}`
    ).toBe('falla');
  }, 240_000);

  it('quitar el barrido de gastos del asiento de cierre lo pone en rojo', () => {
    // El espejo declarado invierte el SIGNO del neto (plus→minus). Éste quita
    // media línea del asiento: los gastos dejan de barrerse.
    mutarEnDisco(
      'src/services/accounting/period-close.ts',
      'const closingLines = [...barridoIngresos.lineas, ...barridoGastos.lineas];',
      'const closingLines = [...barridoIngresos.lineas];'
    );
    const v = correrEscenario();
    expect(v.motivo, `el escenario no se montó: ${v.motivo ?? ''}`).toBeUndefined();
    expect(
      v.resultados?.['barrido-del-cierre']?.estado,
      `siguió VERDE sin barrer los gastos: ${v.resultados?.['barrido-del-cierre']?.detalle ?? ''}`
    ).toBe('falla');
  }, 240_000);

  it('un alcance que conserva FORMA de frontera y no acota lo pone en rojo', () => {
    // Los tres espejos declarados sustituyen el predicado por `$2::text IS NOT
    // NULL`. Éste conserva la columna en el SQL —en una revisión de texto se ve
    // igual que el bueno— y aun así no acota nada.
    mutarEnDisco(
      'src/database/scope.ts',
      "return { predicado: 'entity_id = $2', valor: scope.entityId };",
      "return { predicado: '(entity_id = $2 OR entity_id IS NOT NULL)', valor: scope.entityId };"
    );
    const v = correrEscenario();
    expect(v.motivo, `el escenario no se montó: ${v.motivo ?? ''}`).toBeUndefined();
    expect(
      v.resultados?.['frontera-de-inquilino']?.estado,
      `siguió VERDE con el alcance de entidad anulado: ${v.resultados?.['frontera-de-inquilino']?.detalle ?? ''}`
    ).toBe('falla');
  }, 240_000);
});

// ============================================================
// 2 · LA CLASIFICACIÓN DEL SILENCIO
//
// El contrato que criterioDeConducta declara: escenario que NO SE PUDO MONTAR
// → `no-evaluable` (excusado de --exigir); escenario MONTADO y camino roto →
// `falla`. La base se monta ANTES de importar los módulos de la aplicación, así
// que un módulo que revienta al importarse cae, por ese contrato, del lado
// rojo. Esta prueba lo exige.
// ============================================================

describe('2 · el escenario que se monta y luego se cae', () => {
  it('una rotura al IMPORTAR es roja, no «aquí no había instrumento»', () => {
    // Cualquier fallo al cargar un módulo —una validación de arranque nueva, un
    // literal mal formado, un export que ya no existe— mata al hijo después de
    // que su base efímera está creada y migrada. Si eso se cuenta como
    // `no-evaluable`, `bloqueadoPorEntorno` lo excusa de --exigir y el paquete
    // que aloja los tres criterios que ejecutan sale VERDE con el motor de
    // cierre roto.
    mutarEnDisco(
      'src/services/accounting/period-close.ts',
      'export function barrerCuentasDeResultados(',
      "throw new Error('rotura al importar (simulada en el ataque de S4a)');\nexport function barrerCuentasDeResultados("
    );
    const v = correrEscenario();
    expect(
      v.motivo,
      'el ataque no reprodujo la condición: el hijo no murió al importar'
    ).toBeUndefined();
    for (const id of ['saldo-con-signo', 'barrido-del-cierre', 'frontera-de-inquilino']) {
      expect(
        v.resultados?.[id]?.estado,
        `«${id}» quedó fuera de --exigir con el motor roto: ${v.resultados?.[id]?.detalle ?? 'sin veredicto'}`
      ).toBe('falla');
    }
  }, 240_000);

  it('y el tablero completo sale con código 1 bajo --exigir=E0.1', () => {
    mutarEnDisco(
      'src/services/accounting/period-close.ts',
      'export function barrerCuentasDeResultados(',
      "throw new Error('rotura al importar (simulada en el ataque de S4a)');\nexport function barrerCuentasDeResultados("
    );
    // SIN `VITEST` EN EL ENTORNO, y hace falta decir por qué se borra a mano.
    // `correrConducta` se salta el escenario cuando ve `process.env.VITEST`
    // —para que `npm test` no migre una base sin avisar—, pero esa variable la
    // HEREDA cualquier proceso que nazca dentro de vitest, incluido este
    // `plan:status`. Medido: sin borrarla, el tablero contesta «y aquí no
    // corrió NINGUNO» y sale con 0 aunque el motor de cierre esté roto. Es un
    // hallazgo por derecho propio —la puerta mira una variable heredable en vez
    // de a quién la abre— y queda en el informe; aquí se borra porque lo que
    // esta prueba mide es la CLASIFICACIÓN, no la puerta.
    const entorno = { ...process.env };
    delete entorno.VITEST;
    const r = spawnSync('npx', ['tsx', path.join(RAIZ, 'src', 'plan', 'status.ts'), '--exigir=E0.1'], {
      cwd: RAIZ,
      encoding: 'utf-8',
      timeout: 300_000,
      env: entorno,
    });
    const salida = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    expect(salida, 'el tablero ni siquiera nombró el paquete').toContain('E0.1');
    expect(
      r.status,
      `--exigir=E0.1 pasó con el motor de cierre roto:\n${salida.split('\n').slice(-14).join('\n')}`
    ).toBe(1);
  }, 300_000);

  it('HALLAZGO · `VITEST` heredada apaga los tres criterios que ejecutan', () => {
    // El árbol está LIMPIO en esta prueba: no se rompe nada. Lo único que pasa
    // es que `plan:status` nace con `VITEST` en el entorno —como le pasa a
    // cualquier proceso lanzado desde una prueba, un runner o un script que
    // envuelva a vitest— y con eso los tres criterios de conducta se declaran
    // `no-evaluable` sin intentar montar nada. Como declaran `necesita`,
    // `bloqueadoPorEntorno` los excusa de --exigir.
    //
    // La salida lo CONFIESA (por eso esto no es un verde silencioso), pero la
    // puerta mira una variable HEREDABLE en vez de a quién la abre. Se afirma
    // el comportamiento observado para que el hueco viva en el código.
    const r = spawnSync('npx', ['tsx', path.join(RAIZ, 'src', 'plan', 'status.ts')], {
      cwd: RAIZ,
      encoding: 'utf-8',
      timeout: 300_000,
      env: { ...process.env, VITEST: 'true' },
    });
    const salida = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    expect(
      salida,
      'HUECO CONOCIDO (S4a, ataque 2c): con VITEST en el entorno los tres criterios que ejecutan ' +
        'no corren, y --exigir los excusa. Si la puerta pasa a mirar quién la abre en vez de una ' +
        'variable heredable, esta aserción se pone roja y hay que voltearla.'
    ).toContain('aquí no corrió NINGUNO');
  }, 300_000);

  it('sin base efímera: se dice, y NO se disfraza de verde de verdad', () => {
    // La otra mitad del contrato. Con el servidor inalcanzable el escenario no
    // se puede montar: eso SÍ es `no-evaluable`, queda fuera de --exigir (por
    // diseño) y la salida tiene que confesarlo — el motivo por criterio y la
    // línea de cierre diciendo que ninguno corrió.
    const muerta = 'postgresql://nadie:nadie@127.0.0.1:1/nada';
    const r = spawnSync('npx', ['tsx', path.join(RAIZ, 'src', 'plan', 'status.ts')], {
      cwd: RAIZ,
      encoding: 'utf-8',
      timeout: 300_000,
      env: {
        ...process.env,
        DATABASE_URL: muerta,
        MIGRATION_DATABASE_URL: muerta,
        TEST_ADMIN_DATABASE_URL: muerta,
        BACKUP_DATABASE_URL: muerta,
        DOTENV_CONFIG_PATH: path.join(RAIZ, 'no-existe-este-env'),
      },
    });
    const salida = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    expect(salida, 'no se dijo que hacía falta una base efímera').toContain('base-efimera');
    expect(salida, 'la línea de cierre no distingue lo que corrió de lo que no')
      .toMatch(/ejecutan el camino real|no corrió/i);
    // Y ningún criterio de conducta puede salir en VERDE aquí.
    expect(salida).not.toMatch(/✔[^\n]*balanza publica el saldo con el signo/);
  }, 300_000);
});

// ============================================================
// 3 · EL TRINQUETE DE COBERTURA
//
// En memoria, por el seam: no hace falta tocar vitest.config.ts en disco.
// ============================================================

const CRITERIO_COBERTURA = 'La cobertura del motor contable tiene trinquete por archivo';
function criterioPorEnunciado(e: string): Criterio {
  const c = CRITERIOS.find((x) => x.enunciado === e);
  if (!c) throw new Error(`no existe el criterio «${e}»: el ataque quedó desanclado`);
  return c;
}

const conConfig = async (texto: string): Promise<{ estado: string; detalle: string }> =>
  conFuenteMutada({ 'vitest.config.ts': texto }, () =>
    criterioPorEnunciado(CRITERIO_COBERTURA).evaluar()
  );

describe('3 · el trinquete de cobertura', () => {
  const config = crudoDe('vitest.config.ts');

  it('los umbrales a CERO lo ponen en rojo', async () => {
    const cero = config.replace(
      /(statements|branches|functions|lines):\s*\d+(\.\d+)?/g,
      (_m, k: string) => `${k}: 0`
    );
    const r = await conConfig(cero);
    expect(r.estado, `el trinquete no vio los ceros: ${r.detalle}`).toBe('falla');
  });

  it('UNA sola rebaja de un punto también lo pone en rojo', async () => {
    const piso = SUELO_COBERTURA_UNITARIA['src/services/accounting/posting.ts'];
    const ancla = `statements: ${piso.statements}, branches: ${piso.branches}, functions: ${piso.functions}, lines: ${piso.lines},`;
    const rebajado = config.replace(
      ancla,
      `statements: ${piso.statements}, branches: ${piso.branches - 1}, functions: ${piso.functions}, lines: ${piso.lines},`
    );
    expect(rebajado, 'la rebaja no encontró su ancla en vitest.config.ts').not.toBe(config);
    const r = await conConfig(rebajado);
    expect(r.estado, `una rebaja de un punto pasó inadvertida: ${r.detalle}`).toBe('falla');
  });

  it('borrar la entrada entera de un archivo también lo pone en rojo', async () => {
    const borrado = config.replace(/'src\/utils\/sequence\.ts':\s*\{[^}]*\},?/, '');
    expect(borrado).not.toBe(config);
    const r = await conConfig(borrado);
    expect(r.estado, `el trinquete se retiró por borrado sin decir nada: ${r.detalle}`).toBe('falla');
  });

  it('un señuelo dentro de un COMENTARIO no lo engaña', async () => {
    // `codigoDe` quita comentarios antes de leer números: los bloques de prosa
    // de vitest.config.ts citan cifras y leerlas como conducta sería el error
    // que este tramo persigue. Con los umbrales reales a cero y el suelo citado
    // en un comentario, tiene que quedar rojo.
    const ceros = config.replace(
      /(statements|branches|functions|lines):\s*\d+(\.\d+)?/g,
      (_m, k: string) => `${k}: 0`
    );
    const r = await conConfig(`${ceros}\n/*\n${citaDelSuelo()}\n*/\n`);
    expect(r.estado, `la prosa de un comentario pasó por umbral: ${r.detalle}`).toBe('falla');
  });

  // ---------- Lo que el trinquete NO compra (medido, no supuesto) ----------
  // Las tres pruebas que siguen afirman el comportamiento OBSERVADO, no el
  // deseable. Están aquí para que el hueco viva en el código en vez de en la
  // memoria de quien lo encontró: si alguien lo cierra, estas pruebas se ponen
  // rojas y el mensaje le dice que las voltee a 'falla'.

  it('HUECO · un umbral sobre un archivo que NO EXISTE pasa, y engorda la cifra', async () => {
    const inventado = config.replace(
      'thresholds: {',
      "thresholds: {\n        'src/servicios/que-no-existen/jamas.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },"
    );
    expect(inventado).not.toBe(config);
    const r = await conConfig(inventado);
    expect(
      r.estado,
      'HUECO CONOCIDO (S4a, ataque 3c): `contraSuelo` sólo exige que los archivos DEL SUELO no ' +
        'bajen; sobre los demás pide únicamente que ninguna métrica esté en cero. Un umbral de 100 ' +
        'sobre un archivo inexistente pasa, y suma a la cifra que el criterio publica («N archivos ' +
        'con umbral propio»). Si se cierra, voltea esta aserción a «falla».'
    ).toBe('ok');
    expect(r.detalle, 'el archivo inventado no llegó a contarse: revisa el ataque').toContain('7 archivos');
  });

  it('HUECO · los umbrales al 100 (inalcanzables) pasan igual que los reales', async () => {
    const cien = config.replace(
      /statements: \d+, branches: \d+, functions: \d+, lines: \d+,/g,
      'statements: 100, branches: 100, functions: 100, lines: 100,'
    );
    const r = await conConfig(cien);
    expect(
      r.estado,
      'HUECO CONOCIDO (S4a, ataque 3d): el suelo mide «no bajó», no «se puede cumplir». Un umbral ' +
        'inalcanzable deja el criterio en verde y la corrida de cobertura en rojo: el tablero y la ' +
        'suite dicen cosas distintas del mismo archivo.'
    ).toBe('ok');
  });

  it('HUECO · un señuelo en CÓDIGO MUERTO posterior sí lo engaña', async () => {
    // `umbralesDeclarados` recorre el archivo entero con un regex y se queda con
    // la ÚLTIMA aparición de cada llave; vitest sólo lee el objeto `thresholds`.
    // Si el descenso va dentro de `thresholds` y una copia con los números
    // viejos va DESPUÉS, en código que vitest jamás mira, las dos lecturas
    // discrepan: el trinquete ve el suelo respetado y la corrida aplica el cero.
    const ceros = config.replace(
      /(statements|branches|functions|lines):\s*\d+(\.\d+)?/g,
      (_m, k: string) => `${k}: 0`
    );
    const senuelo = `${ceros}\n\n// Objeto muerto: vitest no lo lee jamás.\nexport const NOTAS = {\n${citaDelSuelo()}\n};\n`;
    const r = await conConfig(senuelo);
    expect(
      r.estado,
      'HUECO CONOCIDO (S4a, ataque 3e): con TODOS los umbrales efectivos en cero, el criterio sigue ' +
        'verde porque lee la última aparición de cada llave en el archivo, no el objeto que vitest ' +
        'aplica. El remedio es acotar la lectura al bloque `thresholds` y acusar la llave repetida.'
    ).toBe('ok');
  });
});

/** El suelo unitario escrito como entradas de configuración, para los señuelos. */
function citaDelSuelo(): string {
  return Object.entries(SUELO_COBERTURA_UNITARIA)
    .map(
      ([f, u]) =>
        `  '${f}': { statements: ${u.statements}, branches: ${u.branches}, functions: ${u.functions}, lines: ${u.lines} },`
    )
    .join('\n');
}

// ============================================================
// 4 · LA SONDA DE RLS, CONTRA TRES POLÍTICAS INOFENSIVAS
//
// Las tres se crean como política REAL, con el MISMO nombre que usa
// rls-policies.sql, sobre una tabla REAL del esquema public — para que el censo
// de rls-por-su-predicado.int.spec.ts las vea exactamente como ve a las 78 de
// verdad. No se evalúa el texto que escribí aquí: se lee con pg_get_expr.
// ============================================================

let admin: pg.Client;
let inqA: Fixture;
let inqB: Fixture;

// El censo NO se copia: se importa el mismo SQL que corre en
// rls-por-su-predicado.int.spec.ts (tests/integration/helpers/rls-censo.ts).
// Una copia se queda atrás y el ataque acabaría midiendo su propio texto —
// que es exactamente el defecto que este tramo existe para matar.

beforeAll(async () => {
  inqA = await crearInquilino('Ataque S4a · A');
  inqB = await crearInquilino('Ataque S4a · B');
  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
}, 120_000);

afterAll(async () => {
  if (admin) {
    await admin.query('DROP TABLE IF EXISTS ataque_rls').catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
  await closeDatabase();
});

/** Evalúa el predicado ALMACENADO sobre una fila sintética, como la sonda real. */
async function evaluar(
  tabla: string,
  columna: string,
  predicado: string,
  valor: string,
  tenant: string
): Promise<boolean | null> {
  await admin.query('BEGIN');
  try {
    await admin.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenant]);
    const r = await admin.query<{ v: boolean | null }>(
      `WITH "${tabla}"("${columna}") AS (VALUES ($1::uuid)) SELECT (${predicado}) AS v FROM "${tabla}"`,
      [valor]
    );
    return r.rows[0]?.v ?? null;
  } finally {
    await admin.query('ROLLBACK');
  }
}

describe('4 · la sonda de RLS contra tres políticas inofensivas', () => {
  const FORMAS: Array<{ nombre: string; using: string }> = [
    // La primera es la que falta en la lista de catorce del implementador, y es
    // la que cualquiera escribe para «desactivar un rato» el aislamiento.
    { nombre: 'USING (true)', using: 'true' },
    { nombre: 'disyunción trivial: el filtro correcto OR 1 = 1', using: '(tenant_id = public.app_current_tenant()) OR 1 = 1' },
    { nombre: 'el inquilino comparado consigo mismo', using: 'tenant_id = tenant_id' },
  ];

  for (const forma of FORMAS) {
    it(`la caza: ${forma.nombre}`, async () => {
      await admin.query('DROP TABLE IF EXISTS ataque_rls');
      await admin.query(
        'CREATE TABLE ataque_rls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL)'
      );
      await admin.query('ALTER TABLE ataque_rls ENABLE ROW LEVEL SECURITY');
      try {
        await admin.query(`CREATE POLICY tenant_isolation ON ataque_rls FOR ALL USING (${forma.using})`);

        // PRIMER FILTRO, Y EL QUE IMPORTA: ¿la ve siquiera el censo? Una
        // política que no aparece en la lista no se evalúa nunca, y ninguna
        // aserción posterior la toca.
        const censo = (await admin.query<PoliticaDirecta>(SQL_POLITICAS_DIRECTAS)).rows;
        const mia = censo.find((r) => r.tabla === 'ataque_rls');
        expect(
          mia,
          `LA POLÍTICA «${forma.using}» NO APARECE EN EL CENSO. Un predicado que no depende de ` +
            'ninguna columna no tiene fila en pg_depend con refobjsubid > 0; con un JOIN interno ' +
            'desaparece de la lista antes de ser juzgada. Existe, no filtra, y nadie la mira.'
        ).toBeDefined();

        // Una política sin columna llega con `columna: null`, y eso ya es «no
        // discrimina» sin ejecutar nada: el mismo juicio que aplica el spec.
        if (mia === undefined || !discrimina(mia)) return;

        const propio = await evaluar('ataque_rls', mia.columna, mia.predicado, inqA.tenantId, inqA.tenantId);
        const ajeno = await evaluar('ataque_rls', mia.columna, mia.predicado, inqA.tenantId, inqB.tenantId);
        expect(
          !(propio === true && ajeno !== true),
          `LA SONDA NO CAZA «${forma.using}»: dueño=${propio} ajeno=${ajeno}`
        ).toBe(true);
      } finally {
        await admin.query('DROP TABLE IF EXISTS ataque_rls');
      }
    }, 60_000);
  }

  it('la política CORRECTA sí pasa: la sonda no lo rechaza todo', async () => {
    await admin.query('DROP TABLE IF EXISTS ataque_rls');
    await admin.query(
      'CREATE TABLE ataque_rls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL)'
    );
    await admin.query('ALTER TABLE ataque_rls ENABLE ROW LEVEL SECURITY');
    try {
      await admin.query(
        'CREATE POLICY tenant_isolation ON ataque_rls FOR ALL USING (tenant_id = public.app_current_tenant())'
      );
      const censo = (await admin.query<PoliticaDirecta>(SQL_POLITICAS_DIRECTAS)).rows;
      const mia = censo.find((r) => r.tabla === 'ataque_rls');
      expect(mia?.columna, 'el censo perdió una política legítima').toBe('tenant_id');
      if (mia === undefined || !discrimina(mia)) throw new Error('inalcanzable: ya se afirmó arriba');
      const propio = await evaluar('ataque_rls', mia.columna, mia.predicado, inqA.tenantId, inqA.tenantId);
      const ajeno = await evaluar('ataque_rls', mia.columna, mia.predicado, inqA.tenantId, inqB.tenantId);
      expect(propio).toBe(true);
      expect(ajeno).not.toBe(true);
    } finally {
      await admin.query('DROP TABLE IF EXISTS ataque_rls');
    }
  }, 60_000);

  it('la red de conducta no cubre lo que el censo pierde: cuántas tablas', async () => {
    // Si el censo no ve la política, la única red que queda es la prueba de
    // conjuntos disjuntos… que sólo dice algo de las tablas con filas de LOS
    // DOS inquilinos (NUCLEO_SEMBRADO). El resto pasaría por vacuidad. Este
    // número es el tamaño del punto ciego, y se afirma para que no crezca en
    // silencio.
    const aisladas = Number(
      (
        await admin.query<{ n: string }>(`
      SELECT count(*)::text AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
        AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                      AND p.polname LIKE 'tenant_isolation%')`)
      ).rows[0].n
    );
    const sembradas = (
      crudoDe('tests/integration/rls-por-su-predicado.int.spec.ts').match(
        /const NUCLEO_SEMBRADO = \[([\s\S]*?)\];/
      )?.[1] ?? ''
    )
      .split(',')
      .filter((s) => s.trim().length > 0).length;
    expect(aisladas, 'no hay tablas aisladas: el ataque quedó desanclado').toBeGreaterThan(50);
    expect(
      sembradas,
      `${aisladas} tablas aisladas y sólo ${sembradas} con filas de los dos inquilinos: ` +
        'el resto sólo está protegido por el juicio del PREDICADO, así que el censo tiene que verlas todas'
    ).toBeGreaterThan(20);
  }, 60_000);
});

// ============================================================
// 5 · EL ARNÉS DE MUTACIÓN, ¿ACUSA?
// ============================================================

function correrMutantes(): { status: number | null; salida: string } {
  const r = spawnSync('npx', ['tsx', path.join(RAIZ, 'scripts', 'mutantes.ts')], {
    cwd: RAIZ,
    encoding: 'utf-8',
    timeout: 300_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: r.status, salida: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('5 · npm run mutantes', () => {
  it('con el árbol limpio: todo mutante muere y sale 0', () => {
    const { status, salida } = correrMutantes();
    expect(status, `línea base rota:\n${salida.slice(-2000)}`).toBe(0);
    expect(salida).toContain('murieron');
  }, 300_000);

  it('un criterio MUERTO a propósito sale nombrado y con código 1', () => {
    // Se mata el criterio de cobertura de la forma más plausible: alguien lo
    // «simplifica» y deja de comparar contra el suelo.
    mutarEnDisco(
      'src/plan/criterios.ts',
      "      const problemas = contraSuelo(c, SUELO_COBERTURA_UNITARIA);\n      if (problemas.length > 0) return falla(problemas.join('; '));",
      "      const problemas: string[] = [];\n      if (problemas.length > 0) return falla(problemas.join('; '));"
    );
    const { status, salida } = correrMutantes();
    expect(status, `el arnés NO acusó al criterio muerto:\n${salida.slice(-3000)}`).toBe(1);
    expect(salida, 'no nombró el criterio muerto').toContain(CRITERIO_COBERTURA);
    expect(salida).toContain('sobrevivieron');
  }, 300_000);

  it('NO es circular: romper el seam de lectura hace ruido, no silencio', () => {
    // Si `conFuenteMutada` dejara de aplicar el overlay, todos los criterios se
    // evaluarían contra el árbol LIMPIO y ningún mutante mordería. Un arnés
    // circular —uno que se juzgara con el mismo código roto— saldría en verde.
    mutarEnDisco(
      'src/plan/criterios.ts',
      '  sobreescrituras = new Map(Object.entries(overlay));',
      '  sobreescrituras = null; void overlay;'
    );
    const { status, salida } = correrMutantes();
    expect(status, `el arnés se declaró sano con el seam roto:\n${salida.slice(-3000)}`).toBe(1);
    expect(salida).toContain('sobrevivieron');
  }, 300_000);
});

// ============================================================
// 6 · EL ÁRBOL QUEDA COMO ESTABA
// ============================================================

describe('6 · higiene', () => {
  it('ningún archivo mutado quedó escrito en disco', () => {
    for (const [rel, texto] of originales) {
      expect(fs.readFileSync(path.join(RAIZ, rel), 'utf-8'), `${rel} quedó mutado`).toBe(texto);
    }
  });
});
