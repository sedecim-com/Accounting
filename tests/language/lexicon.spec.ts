import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  classify,
  tokenize,
  isFlagged,
  DOMAIN_TERMS,
  SPANISH_ROOTS,
  NEUTRAL_TOKENS,
} from '../../scripts/language/lexicon.js';

// ============================================================
// LA PRUEBA DEL LÉXICO (I1 · issue #143)
//
// El léxico va a decidir qué identificadores se señalan para renombrar, y de
// eso viven el metro (I2) y el lint (I3). Un instrumento así se juzga por dos
// números y no por uno: cuántos españoles caza, y cuántos ingleses acusa en
// falso. El segundo es el que decide si alguien lo sigue mirando.
// ============================================================

const RAIZ = path.join(__dirname, '..', '..');

/** Las declaraciones de un archivo, con el mismo recorrido que usó la curación. */
function declaracionesDe(archivo: string): string[] {
  const bruto = fs.readFileSync(archivo, 'utf8');
  const sinComentarios = bruto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
  const nombres: string[] = [];
  for (const m of sinComentarios.matchAll(/\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    nombres.push(m[1]);
  }
  return nombres;
}

function tsDe(dir: string): string[] {
  const raiz = path.join(RAIZ, dir);
  if (!fs.existsSync(raiz)) return [];
  const out: string[] = [];
  const caminar = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) caminar(full);
      else if (e.name.endsWith('.ts')) out.push(full);
    }
  };
  caminar(raiz);
  return out;
}

describe('tokenize — el nombre se parte donde el idioma cambia', () => {
  it('camelCase, PascalCase, snake_case, SCREAMING y los dígitos', () => {
    expect(tokenize('saldoInicial')).toEqual(['saldo', 'inicial']);
    expect(tokenize('CuentaPorCobrar')).toEqual(['cuenta', 'por', 'cobrar']);
    expect(tokenize('amount_due')).toEqual(['amount', 'due']);
    expect(tokenize('MAX_DECIMALES_FACTOR')).toEqual(['max', 'decimales', 'factor']);
    expect(tokenize('tasa8')).toEqual(['tasa8']);
  });

  it('una sigla pegada a una palabra no la esconde', () => {
    // Sin la regla de `([A-Z]+)([A-Z][a-z])`, `RFCValido` da un solo token
    // que no está en ninguna lista y el `valido` español viaja invisible.
    expect(tokenize('RFCValido')).toEqual(['rfc', 'valido']);
    expect(tokenize('CFDIRecibido')).toEqual(['cfdi', 'recibido']);
  });
});

describe('classify — español entero, a medias, o ninguno', () => {
  it('el español se señala, y el que está a medias también', () => {
    expect(classify('saldoInicial')).toBe('es');
    expect(classify('amountDue')).toBe('en');
    // Un nombre a medio traducir es peor que uno entero en un idioma: el que
    // lo lea después no sabrá cuál de las dos mitades es la convención.
    expect(classify('calcularBalanceSheet')).toBe('mixed');
    expect(isFlagged('calcularBalanceSheet')).toBe(true);
    expect(isFlagged('amountDue')).toBe(false);
  });

  it('el español gana al diccionario inglés: ahí es donde se escondía', () => {
    // Todas están en web2 y por eso el clasificador automático las daba por
    // inglesas. Son las que dejaban pasar el español sin que nadie lo viera.
    for (const t of ['mayor', 'banco', 'asiento', 'cargo', 'folio', 'norma', 'lote', 'clave']) {
      expect(SPANISH_ROOTS.has(t), `${t} tendría que estar en las raíces españolas`).toBe(true);
    }
  });

  it('lo que se escribe igual en los dos idiomas NO señala', () => {
    for (const t of ['error', 'total', 'base', 'fiscal', 'control', 'final', 'legal', 'decimal']) {
      expect(NEUTRAL_TOKENS.has(t), `${t} tendría que ser neutro`).toBe(true);
    }
    expect(classify('totalGeneral')).toBe('neutral');
    expect(classify('cfdiUuid')).toBe('neutral');
  });
});

describe('la lista de excepciones nace vacía, y con la puerta cerrada', () => {
  it('DOMAIN_TERMS está vacía: es la puerta por la que se escapa el plan', () => {
    // Cuando un renombrado cuesta, la tentación es declarar la palabra
    // «término de dominio» y seguir. Si esta prueba se cambia, que sea con
    // una razón escrita al lado de cada entrada, no con un número mayor.
    expect(DOMAIN_TERMS.size).toBe(0);
  });
});

describe('el instrumento no acusa en falso', () => {
  // CERO FALSOS POSITIVOS sobre las carpetas escritas en inglés. Es el número
  // que decide si alguien vuelve a mirar el instrumento: a la tercera señal
  // sobre código que está bien, deja de mirarlo.
  // LAS NUEVE CARPETAS INGLESAS, y no se eligieron a ojo: son las que miden
  // CERO señaladas hoy, con 40 declaraciones o más cada una — 898 en total.
  // El inventario de la investigación las corrobora por el otro lado
  // (`types` 0 % de español, `utils` 0 %).
  //
  // No están aquí `src/api`, `src/services/ap` ni `src/services/ar`, que
  // parecen inglesas por el nombre de la carpeta y no lo son: el léxico señala
  // 235, 60 y 79 declaraciones en ellas, y al mirarlas una a una —
  // `formatearError`, `ORIGENES_CXP`, `porAplicar`— resultan español de
  // verdad. Ése es el trabajo de los tramos I12–I18, no un fallo de la lista.
  const INGLESAS = [
    'src/services/payroll/usa',
    'src/ai/skills',
    'src/ai/jobs',
    'src/ai/webhooks',
    'src/types',
    'src/utils',
    'src/services/vault',
    'src/services/integrations/base',
    'src/services/payroll/tax-engine',
  ];

  it.each(INGLESAS)('%s no tiene una sola declaración señalada por error', (dir) => {
    const señalados: string[] = [];
    for (const f of tsDe(dir)) {
      for (const n of declaracionesDe(f)) {
        if (isFlagged(n)) señalados.push(`${path.relative(RAIZ, f)}: ${n}`);
      }
    }
    // Si esto se pone rojo, la respuesta NO es bajar el número: es mirar el
    // token culpable y decidir si de verdad es español.
    expect(señalados, 'declaraciones inglesas que el léxico señalaría').toEqual([]);
  });
});

describe('el acierto sobre la muestra etiquetada a mano', () => {
  it('≥ 98 % sobre las 200 declaraciones revisadas una a una', () => {
    // LA MUESTRA VIVE EN EL REPOSITORIO, y eso es la mitad del valor de esta
    // prueba. La investigación que precedió a este tramo etiquetó 200
    // declaraciones, sacó 98 % y NO comprometió el archivo: su número no lo
    // puede reproducir nadie. Éste sí — con semilla fija, en un TSV al lado.
    const ESP: Record<string, string> = { es: 'es', en: 'en', mixto: 'mixed', neutro: 'neutral' };
    const filas = fs
      .readFileSync(path.join(__dirname, 'muestra200.tsv'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => {
        const [n, c] = l.split('\t');
        return { n, esperado: ESP[c.trim()] };
      });
    expect(filas).toHaveLength(200);

    const fallos = filas.filter((f) => classify(f.n) !== f.esperado);
    // Los dos límites conocidos —la abreviatura juzgada por sí misma y la
    // posición que el léxico no mira— están explicados en lexicon.ts. Si
    // aparece un tercero, esta prueba lo nombra en vez de esconderlo en un
    // porcentaje.
    expect(
      fallos.map((f) => `${f.n}: esperado ${f.esperado}, dio ${classify(f.n)}`).join(' · '),
      'el acierto bajó del 98 %'
    ).toSatisfy(() => filas.length - fallos.length >= 196);
  });
});
