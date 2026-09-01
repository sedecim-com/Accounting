import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// EVAL DEL CLASIFICADOR — la vara de medir del agente (A1)
//
//   npx tsx scripts/eval-clasificador.ts [--provider anthropic] [--model m]
//                                        [--casos a,b] [--umbral 0.8]
//
// Corre el golden set (tests/golden/cfdi/) por el MISMO camino que
// `mnemosine ingest` — ingestCfdiFiles con sus compuertas intactas — contra
// un proveedor FIJADO: createLlmSession directo, sin cadena de failover
// (un eval que cambia de modelo a mitad de corrida no mide nada) y con el
// grounding apagado, como toda corrida desatendida. Nada se reimplementa:
// si el arnés reconstruyera las compuertas por su cuenta, divergiría del
// producto y mediría un clasificador que no existe.
//
// La base es EFÍMERA (el mismo global-setup de la suite de integración:
// se crea, se migra, se siembra un inquilino, se destruye) — el eval jamás
// ensucia una base real y el dedupe por UUID no acumula entre corridas.
//
// Necesita: TEST_ADMIN_DATABASE_URL (rol con CREATE DATABASE) y la
// credencial del proveedor elegido (p. ej. ANTHROPIC_API_KEY).
//
// El resultado se puntúa POR CLASE (src/ai/eval/puntuacion.ts) y se anexa
// a docs/evals/clasificador.jsonl; la corrida se compara contra la
// anterior del mismo proveedor+modelo — «mejoró/empeoró» es un dato, no
// una impresión. Con --umbral, un global por debajo sale con código 1.
// ============================================================

interface Args {
  provider?: string;
  model?: string;
  casos?: string[];
  umbral?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') args.provider = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--casos') args.casos = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--umbral') args.umbral = Number(argv[++i]);
    else {
      console.error(`Argumento desconocido: ${a}`);
      process.exit(2);
    }
  }
  if (args.umbral !== undefined && !(args.umbral >= 0 && args.umbral <= 1)) {
    console.error('--umbral debe estar entre 0 y 1');
    process.exit(2);
  }
  return args;
}

const GOLDEN_DIR = path.resolve('tests/golden/cfdi');
const BITACORA = path.resolve('docs/evals/clasificador.jsonl');

// ============================================================
// NINGUNA CREDENCIAL SALE POR AQUÍ — Y EL REDACTOR TAMPOCO LA LLEVA.
//
// El arnés corre con una llave de proveedor de verdad (resolveProfile la lee
// de api_key_env o la saca de api_key_cmd), y todo lo que el proveedor falla
// vuelve como texto: el mensaje de error viaja al `detalle` del caso, se
// imprime, y en una corrida de CI queda en el registro para siempre. Un SDK
// que eche la petición en el mensaje basta para publicarla.
//
// La primera versión de esto guardaba la llave para hacer `split(llave)` —
// y así el propio redactor pasaba a ser portador del secreto: cualquiera que
// siga el flujo de datos (CodeQL lo hizo) ve la credencial entrar al
// sanitizador y salir hacia un `console.error`. Que la salida no la contenga
// es cierto, pero no es demostrable desde el flujo.
//
// Ahora se compara por HUELLA: se guarda el sha256 de cada credencial, no la
// credencial. Un token del texto se tacha cuando su huella coincide. El valor
// sensible no entra nunca al camino de la salida, la comparación exacta se
// conserva, y de paso siguen tachándose las formas de llave más comunes por
// si el mensaje trae una que este proceso no resolvió.
// ============================================================
const HUELLAS = new Set<string>();
const OCULTO = '«credencial oculta»';

function huella(valor: string): string {
  return createHash('sha256').update(valor).digest('hex');
}

/** Registra una credencial por su huella. La credencial no se conserva. */
function recordarSecreto(valor: string | undefined): void {
  if (valor && valor.length >= 8) HUELLAS.add(huella(valor));
}

function sinSecretos(texto: string): string {
  const porPatron = texto
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, OCULTO)
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, `Bearer ${OCULTO}`);
  if (HUELLAS.size === 0) return porPatron;
  // Sólo los trozos con pinta de token se hashean: barrer cada palabra del
  // mensaje sería caro y no aportaría — una credencial no tiene 4 caracteres.
  return porPatron.replace(/[A-Za-z0-9._-]{12,}/g, (t) => (HUELLAS.has(huella(t)) ? OCULTO : t));
}

const tasa = (m: { aciertos: number; total: number }): string =>
  m.total === 0 ? '—' : (m.aciertos / m.total).toFixed(3);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // La base efímera PRIMERO: los módulos de src leen DATABASE_URL al armar
  // el pool, así que todo import de src es dinámico y posterior al setup.
  const { setup, teardown } = await import('../tests/integration/global-setup.js');
  await setup();

  try {
    const { cargarCasosGolden } = await import('../src/ai/eval/golden.js');
    const { puntuarCaso, agregarPuntuaciones } = await import('../src/ai/eval/puntuacion.js');
    const { crearInquilino } = await import('../tests/integration/helpers/tenant-fixture.js');
    const { resolveProfile, listProfiles, createLlmSession } = await import('../src/ai/providers/index.js');
    const { ingestCfdiFiles } = await import('../src/ai/ingest-service.js');
    const { query, closeDatabase } = await import('../src/database/connection.js');
    type ObservadoCaso = import('../src/ai/eval/puntuacion.js').ObservadoCaso;
    type LineaObservada = import('../src/ai/eval/puntuacion.js').LineaObservada;
    type DraftCapture = import('../src/ai/ingest-service.js').DraftCapture;
    type LlmSession = import('../src/ai/providers/types.js').LlmSession;

    const casos = cargarCasosGolden(GOLDEN_DIR, args.casos);
    console.log(`\neval-clasificador · ${casos.length} caso(s) del golden set`);

    const f = await crearInquilino('Eval clasificador');
    const ctx = {
      entityId: f.entityId,
      entityName: 'Eval clasificador',
      tenantId: f.tenantId,
      currency: 'MXN',
      country: 'MX',
      accountingStandard: 'mx_nif',
      taxId: 'XAXX010101000',
    };

    // Las cuentas que el esperado cita deben existir en el catálogo sembrado:
    // si el fixture cambia, que el eval lo diga aquí y no como fallo del modelo.
    const citadas = [...new Set(casos.flatMap((c) => c.esperado.asiento ?? []).flatMap((l) => l.cuenta))];
    if (citadas.length > 0) {
      const existentes = await query<{ code: string }>(
        `SELECT code FROM accounts WHERE entity_id = $1 AND code = ANY($2::text[])`,
        [f.entityId, citadas]
      );
      const faltan = citadas.filter((c) => !existentes.rows.some((r) => r.code === c));
      if (faltan.length > 0) {
        throw new Error(
          `El catálogo sembrado no tiene las cuentas que el golden espera: ${faltan.join(', ')}`
        );
      }
    }

    // Proveedor FIJADO: sesión directa, sin failover, grounding apagado.
    // LA IDENTIDAD DEL PERFIL NO SALE DEL OBJETO QUE LLEVA LA CREDENCIAL.
    //
    // `resolveProfile` hace `process.env[profile.api_key_env]` y devuelve la
    // llave en el MISMO objeto que el nombre y el modelo. Copiar `profile.name`
    // al registro metía en la bitácora un valor que el análisis considera
    // derivado de la credencial — y tiene razón sobre la forma: ese archivo se
    // relee y se imprime. Pasarlo por `sinSecretos()` no basta, porque es un
    // filtro propio que ningún analizador reconoce como saneador: el flujo
    // seguía ahí.
    //
    // `listProfiles` resuelve el mismo nombre y el mismo modelo SIN leer
    // ninguna credencial. No es una anotación para callar la alerta: es que el
    // registro deja de tocar el objeto que la lleva.
    const { profiles: perfilesDeclarados, defaultName } = listProfiles();
    const nombrePerfil = args.provider || defaultName;
    const modeloPerfil =
      args.model || perfilesDeclarados[nombrePerfil]?.model || '(sin modelo declarado)';
    const profile = resolveProfile(args.provider, args.model);
    // La llave de ESTA corrida, para tacharla si algún mensaje la trae.
    recordarSecreto(profile.apiKey);
    const capture: DraftCapture = { drafts: [] };
    let llamadasAlModelo = 0;
    const base = await createLlmSession(
      profile,
      ctx,
      { onDraftCreated: (info) => capture.drafts.push(info) },
      { grounding: { enabled: false } }
    );
    const session: LlmSession = {
      get label() {
        return base.label;
      },
      runTurn: (input, signal) => {
        llamadasAlModelo += 1;
        return base.runTurn(input, signal);
      },
      reset: () => base.reset(),
    };
    console.log(`proveedor fijado: ${session.label}\n`);

    const thresholds = { autoPost: false, minConfidence: 0.95, maxAmount: 10000 };
    const reviewer = { userId: f.userId, email: 'eval@mnemosine.local' };

    const puntuaciones = [];
    for (const caso of casos) {
      const llamadasAntes = llamadasAlModelo;
      const report = await ingestCfdiFiles({
        ctx, reviewer, files: [caso.xmlPath], thresholds, session, capture,
      });
      const r = report.results[0];
      const clasificoElModelo = llamadasAlModelo > llamadasAntes;

      let observado: ObservadoCaso;
      if (!clasificoElModelo) {
        observado = { resultado: 'determinista', detalle: r.detail };
      } else if (r.status === 'draft' && r.draftId) {
        const fila = await query<{ payload: unknown; ai_confidence: string }>(
          `SELECT payload, ai_confidence FROM ai_drafts WHERE id = $1`,
          [r.draftId]
        );
        const payload = fila.rows[0].payload as {
          lines: { account_code: string; debit?: string | null; credit?: string | null }[];
        };
        const lineas: LineaObservada[] = payload.lines.map((l) => ({
          cuenta: l.account_code,
          lado: l.debit != null && Number(l.debit) > 0 ? 'cargo' : 'abono',
          monto: String(l.debit != null && Number(l.debit) > 0 ? l.debit : l.credit),
        }));
        observado = {
          resultado: 'draft',
          lineas,
          confianza: Number(fila.rows[0].ai_confidence),
          sospecha: (r.sospechas?.length ?? 0) > 0,
          detalle: r.detail,
        };
      } else if (r.status === 'blocked') {
        observado = { resultado: 'pregunta', sospecha: (r.sospechas?.length ?? 0) > 0, detalle: r.detail };
      } else {
        observado = { resultado: 'error', detalle: `${r.status}: ${r.detail ?? ''}` };
      }

      const p = puntuarCaso(caso.esperado, observado);
      puntuaciones.push(p);
      const icono = p.fallas.length === 0 ? '✓' : '✗';
      console.log(sinSecretos(`${icono} ${caso.nombre} → ${observado.resultado}` +
        (observado.confianza !== undefined ? ` (confianza ${observado.confianza.toFixed(2)})` : '')));
      for (const falla of p.fallas) console.log(sinSecretos(`    · ${falla}`));
    }

    const agregado = agregarPuntuaciones(puntuaciones);
    console.log('\nExactitud por clase:');
    for (const [clase, m] of Object.entries(agregado.clases)) {
      console.log(`  ${clase.padEnd(12)} ${tasa(m)}  (${m.aciertos}/${m.total})`);
    }
    console.log(`  ${'global'.padEnd(12)} ${tasa(agregado.global)}  (${agregado.global.aciertos}/${agregado.global.total})`);
    if (agregado.confianzaEnAciertos !== null || agregado.confianzaEnFallas !== null) {
      console.log(
        `  calibración: confianza media ${agregado.confianzaEnAciertos?.toFixed(2) ?? '—'} en casos ` +
          `limpios vs ${agregado.confianzaEnFallas?.toFixed(2) ?? '—'} en casos con fallas`
      );
    }

    // Bitácora y comparación contra la corrida anterior del mismo proveedor+modelo.
    const registro = {
      fecha: new Date().toISOString(),
      provider: nombrePerfil,
      model: modeloPerfil,
      casos: casos.length,
      clases: agregado.clases,
      global: agregado.global,
    };
    let anterior: typeof registro | undefined;
    if (fs.existsSync(BITACORA)) {
      const lineas = fs.readFileSync(BITACORA, 'utf-8').trim().split('\n').filter(Boolean);
      for (let i = lineas.length - 1; i >= 0; i--) {
        const l = JSON.parse(lineas[i]) as typeof registro;
        if (l.provider === registro.provider && l.model === registro.model) {
          anterior = l;
          break;
        }
      }
    }
    fs.mkdirSync(path.dirname(BITACORA), { recursive: true });
    // La bitácora pasa por el mismo filtro que la salida por pantalla.
    //
    // Hoy `registro` sólo copia el nombre y el modelo del perfil, así que no
    // hay clave que ocultar — pero eso es INCIDENTAL: depende de que nadie
    // añada un campo más adelante, y el perfil del que se copia sí lleva la
    // credencial. Un archivo que se relee y se imprime no puede depender de
    // la disciplina de quien edite el objeto.
    fs.appendFileSync(BITACORA, sinSecretos(JSON.stringify(registro)) + '\n');

    if (anterior) {
      console.log(`\nContra la corrida anterior (${anterior.fecha}):`);
      for (const [clase, m] of Object.entries(agregado.clases)) {
        const prev = anterior.clases[clase as keyof typeof anterior.clases];
        if (!prev || prev.total === 0 || m.total === 0) continue;
        const delta = m.aciertos / m.total - prev.aciertos / prev.total;
        const signo = delta > 0.0005 ? '▲' : delta < -0.0005 ? '▼' : '=';
        console.log(`  ${clase.padEnd(12)} ${signo} ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`);
      }
    } else {
      console.log('\n(primera corrida registrada para este proveedor+modelo)');
    }

    await closeDatabase();

    if (args.umbral !== undefined && agregado.global.total > 0) {
      const global = agregado.global.aciertos / agregado.global.total;
      if (global < args.umbral) {
        console.error(`\nGlobal ${global.toFixed(3)} < umbral ${args.umbral}: el clasificador no da la talla.`);
        process.exitCode = 1;
      }
    }
  } finally {
    await teardown();
  }
}

main().catch((err) => {
  console.error(sinSecretos(`\neval-clasificador: ${(err as Error).message}`));
  process.exit(1);
});
