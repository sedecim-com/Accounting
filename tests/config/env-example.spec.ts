import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// ============================================================
// .env.example tenía 16 variables y el código leía 63. La diferencia no era
// una lista incompleta: era que un desarrollador nuevo no podía arrancar
// leyendo ese archivo, y que cada variable añadida desde entonces se enteró
// sólo quien la escribió.
//
// Una lista escrita a mano vuelve a desfasarse el día que alguien tiene prisa,
// así que lo que se prueba aquí no es que el archivo esté completo HOY: es que
// no pueda dejar de estarlo. El censo sale del árbol —las lecturas del entorno
// de src/ y scripts/— y no de que alguien se acuerde de contar. Misma lección
// que el catálogo de comandos (tests/docs/catalogo-estado.spec.ts).
//
// La comprobación va en las DOS direcciones. Una variable documentada que ya
// nadie lee miente igual que una leída sin documentar: manda a configurar algo
// que no tiene efecto.
// ============================================================

const RAIZ = path.resolve(__dirname, '../..');

/**
 * Variables que PROVEE el entorno, no quien despliega: no se configuran, se
 * heredan. Documentarlas en .env.example invitaría a ponerles un valor, que es
 * justo lo que no hay que hacer.
 */
const PROVISTAS_POR_EL_ENTORNO = new Set([
  'HOSTNAME', // el contenedor; queda en la fila de auditoría de credenciales
  'USER', // quién corre el CLI, para el `created_by` de un webhook
  'USERNAME', // lo mismo en Windows
  'TERM_SESSION_ID', // identifica la terminal, para no repetir un aviso
  'TMUX_PANE', // idem
  'TZ', // zona horaria del proceso
  'PATH', // lo pone el shell; las puertas de habilidades buscan binarios en él
  // La pone vitest en cada worker. La lee el arnés de criterios de conducta
  // (S4a) para NO montar una base efímera dentro del proyecto unitario, que
  // declara ser rápido y sin base. No se configura: documentarla en
  // .env.example invitaría a ponerla a mano, que es justo lo que no debe pasar.
  'VITEST',
]);

/** Directorios que se recorren buscando lecturas del entorno. */
const FUENTES = ['src', 'scripts'];
/** tests/ sólo cuenta para la dirección «documentada pero muerta»: una
 *  variable que únicamente usa la suite (TEST_ADMIN_DATABASE_URL) está viva. */
const FUENTES_AMPLIADAS = [...FUENTES, 'tests'];

function archivosTs(dir: string): string[] {
  const absoluto = path.join(RAIZ, dir);
  const salida: string[] = [];
  const recorrer = (d: string): void => {
    for (const entrada of readdirSync(d)) {
      if (entrada === 'node_modules' || entrada === 'dist') continue;
      const completo = path.join(d, entrada);
      if (statSync(completo).isDirectory()) recorrer(completo);
      else if (/\.(ts|js)$/.test(entrada) && !entrada.endsWith('.d.ts')) salida.push(completo);
    }
  };
  recorrer(absoluto);
  return salida;
}

/**
 * Nombres de variable que el código lee.
 *
 * TRES formas, porque el código usa las tres: el acceso literal
 * (`process.env.X`, `process.env['X']`); la tabla de perfiles del agente, que
 * NOMBRA la variable de su llave en `api_key_env` y la lee por índice; y el
 * ALIAS —`const env = deps.env ?? process.env`, el patrón con el que medio CLI
 * se hace inyectable— que después lee `env.X`.
 *
 * Las dos indirectas no son adorno. Sin la de la tabla, añadir un proveedor de
 * IA metería una llave nueva sin que nada lo notara. Sin la del alias, el censo
 * tenía un agujero comprobado: MNEMOSINE_NO_BANNER se lee SÓLO así y llevaba
 * indocumentada desde que existe, con la prueba en verde. Un censo con un punto
 * ciego es peor que no tenerlo, porque además tranquiliza.
 */
export function variablesLeidas(dirs: string[]): Set<string> {
  const nombres = new Set<string>();
  for (const dir of dirs) {
    for (const archivo of archivosTs(dir)) {
      for (const n of variablesDeTexto(readFileSync(archivo, 'utf8'))) nombres.add(n);
    }
  }
  return nombres;
}

const LITERAL = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
const POR_TABLA = /api_key_env:\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
/** El archivo se queda con el entorno en una variable propia. */
const ALIASA = /(?:=|\?\?)\s*process\.env\b|\.{3}process\.env\b/;
/** Lectura por el alias. El lookbehind descarta `process.env.X`, que ya cuenta
 *  como literal, y el `=` final descarta la ESCRITURA: backup-service arma el
 *  entorno de `pg_dump` poniendo PGPASSWORD y compañía, y eso no es algo que
 *  haya que documentar — nadie lo configura, el código lo fija. `==` y `===`
 *  no son escrituras y por eso se excluyen del descarte.
 *
 *  LÍMITE CONOCIDO: reconoce el alias por su NOMBRE, `env`, que es la
 *  convención de los dieciocho archivos que hoy lo usan. Un alias llamado de
 *  otro modo (`e`, `entorno`) se le escapa. Se deja así a propósito: aceptar
 *  cualquier identificador metería en el censo el campo en mayúsculas de
 *  cualquier objeto, y un censo que grita por lo que no es una variable de
 *  entorno se acaba silenciando entero. Si alguna vez hace falta otro nombre,
 *  se añade aquí — no se ensancha el patrón. */
const POR_ALIAS = /(?<!process\.)\benv\.([A-Z][A-Z0-9_]{2,})\b\s*(=(?!=))?/g;

/** Nombres que lee UN archivo. Pura y exportada para poder afirmar cada forma
 *  con un caso mínimo, en vez de sobre el árbol entero. */
export function variablesDeTexto(texto: string): Set<string> {
  const nombres = new Set<string>();
  for (const m of texto.matchAll(LITERAL)) nombres.add(m[1] ?? m[2]);
  for (const m of texto.matchAll(POR_TABLA)) nombres.add(m[1]);
  if (ALIASA.test(texto)) {
    for (const m of texto.matchAll(POR_ALIAS)) if (m[2] === undefined) nombres.add(m[1]);
  }
  return nombres;
}

/** Nombres declarados en .env.example: una asignación al principio de línea. */
export function variablesDocumentadas(texto: string): Set<string> {
  const nombres = new Set<string>();
  for (const linea of texto.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(linea);
    if (m) nombres.add(m[1]);
  }
  return nombres;
}

const ejemplo = readFileSync(path.join(RAIZ, '.env.example'), 'utf8');

describe('variablesDocumentadas', () => {
  it('lee la asignación y no el comentario que la explica', () => {
    const nombres = variablesDocumentadas('# PORT es el puerto\nPORT=3000\n');
    expect([...nombres]).toEqual(['PORT']);
  });

  it('una variable comentada NO cuenta como documentada: está apagada', () => {
    expect(variablesDocumentadas('#PORT=3000').size).toBe(0);
  });

  it('acepta el valor vacío, que es como se declara un secreto', () => {
    expect(variablesDocumentadas('JWT_SECRET=').has('JWT_SECRET')).toBe(true);
  });
});

describe('variablesLeidas', () => {
  it('encuentra las tres formas sobre el árbol de verdad', () => {
    const leidas = variablesLeidas(FUENTES);
    expect(leidas.has('DATABASE_URL')).toBe(true); // process.env.X
    expect(leidas.has('ANTHROPIC_API_KEY')).toBe(true); // api_key_env
    expect(leidas.has('MNEMOSINE_NO_BANNER')).toBe(true); // sólo por alias
  });
});

describe('variablesDeTexto — el censo ve a través del alias', () => {
  it('las dos formas literales', () => {
    expect([...variablesDeTexto("process.env.PORT; process.env['OTRA'];")].sort()).toEqual([
      'OTRA',
      'PORT',
    ]);
  });

  it('la lectura por alias, cuando el archivo se guarda el entorno', () => {
    const texto = 'const env = deps.env ?? process.env;\nif (env.MNEMOSINE_NO_BANNER === "1") {}';
    expect(variablesDeTexto(texto).has('MNEMOSINE_NO_BANNER')).toBe(true);
  });

  it('también cuando el entorno se copia con spread', () => {
    const texto = 'const env = { ...process.env };\nconst x = env.VAULT_DIR;';
    expect(variablesDeTexto(texto).has('VAULT_DIR')).toBe(true);
  });

  it('la ESCRITURA no es una lectura: nadie configura lo que el código fija', () => {
    // backup-service arma el entorno de pg_dump. PGPASSWORD no va a .env.example.
    const texto = 'const env = { ...process.env };\nenv.PGPASSWORD = secreto;';
    expect(variablesDeTexto(texto).has('PGPASSWORD')).toBe(false);
  });

  it('pero comparar no es asignar', () => {
    const texto = 'const env = process.env;\nif (env.NODE_ENV === "production") {}';
    expect(variablesDeTexto(texto).has('NODE_ENV')).toBe(true);
  });

  it('un objeto ajeno llamado env no cuenta si el archivo no aliasa el entorno', () => {
    // `config.env` existe y no es el entorno del proceso. Sin la puerta de
    // ALIASA, cualquier campo en mayúsculas de cualquier `env` entraría al censo.
    expect(variablesDeTexto('const x = config.env.INVENTADA;').size).toBe(0);
  });

  it('no confunde process.env.X con una lectura por alias', () => {
    expect([...variablesDeTexto('const env = process.env; const p = process.env.PORT;')]).toEqual([
      'PORT',
    ]);
  });
});

describe('.env.example es el censo, no una lista escrita a mano', () => {
  it('documenta TODAS las variables que src/ y scripts/ leen', () => {
    const documentadas = variablesDocumentadas(ejemplo);
    const sinDocumentar = [...variablesLeidas(FUENTES)]
      .filter((n) => !documentadas.has(n) && !PROVISTAS_POR_EL_ENTORNO.has(n))
      .sort();

    expect(
      sinDocumentar,
      'El código lee estas variables y .env.example no las menciona. Documéntalas ' +
        'ahí (nombre, para qué sirve, valor de ejemplo que no sea un secreto real) o, ' +
        'si el entorno las provee y no se configuran, añádelas a ' +
        'PROVISTAS_POR_EL_ENTORNO explicando por qué.'
    ).toEqual([]);
  });

  it('no documenta variables que ya nadie lee', () => {
    const leidas = variablesLeidas(FUENTES_AMPLIADAS);
    const muertas = [...variablesDocumentadas(ejemplo)].filter((n) => !leidas.has(n)).sort();

    expect(
      muertas,
      'Estas variables están en .env.example y ningún archivo de src/, scripts/ o ' +
        'tests/ las lee. Una variable documentada que no tiene efecto manda a ' +
        'configurar algo que no existe: bórrala del ejemplo.'
    ).toEqual([]);
  });

  it('ningún valor de ejemplo parece un secreto de verdad', () => {
    // Los tres secretos del sistema se declaran VACÍOS a propósito. Un ejemplo
    // con contenido acaba copiado a un .env y de ahí a producción.
    for (const secreto of ['JWT_SECRET', 'ENCRYPTION_KEY', 'PAC_PASSWORD']) {
      const m = new RegExp(`^${secreto}=(.*)$`, 'm').exec(ejemplo);
      expect(m, `${secreto} debe estar declarado en .env.example`).not.toBeNull();
      expect(m?.[1].trim(), `${secreto} debe quedar vacío en el ejemplo`).toBe('');
    }
  });
});
