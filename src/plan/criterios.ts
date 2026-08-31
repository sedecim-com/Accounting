import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// CRITERIOS DE CIERRE, EJECUTABLES
//
// El plan de cierre lleva sus criterios en prosa y NADIE los ha corrido nunca
// como conjunto. El resultado fue predecible: su tabla de estado marcaba
// resueltos paquetes que no lo estaban, y marcaba pendientes otros que sí,
// porque era un espejo escrito a mano del repositorio.
//
// Aquí los criterios son CÓDIGO. El documento los cita; esta lista los decide.
//
// DOS REGLAS QUE VIENEN DE UN ERROR CONCRETO
//
// 1. Un criterio afirma COMPORTAMIENTO, no identificadores. El cerrojo
//    antisimulación del timbrado se construyó bien, quedó mejor documentado
//    que su especificación, y falla el 100% de sus criterios escritos porque
//    su autor eligió nombres en español. Un criterio puede nombrar un archivo
//    sólo cuando el plan está PRESCRIBIENDO dónde va el código.
//
// 2. Un criterio que no se puede evaluar se declara «no evaluable» y dice por
//    qué. Nunca se aproxima: un ✅ inventado es peor que un hueco confesado,
//    porque hace que un comando imposible parezca trabajo de una hora.
// ============================================================

export type Estado = 'ok' | 'falla' | 'no-evaluable';

export interface Resultado {
  estado: Estado;
  /** Lo observado. Es lo que se imprime cuando falla, así que debe bastar para actuar. */
  detalle: string;
}

export interface Criterio {
  paquete: string;
  /** Qué se afirma, en términos de comportamiento observable. */
  enunciado: string;
  /** Precondición que el runner comprueba antes de evaluar. */
  necesita?: 'base-de-datos' | 'red';
  evaluar: () => Promise<Resultado> | Resultado;
}

// ── Ayudas ──────────────────────────────────────────────────

const RAIZ = path.resolve(__dirname, '..', '..');

export function rutaDe(...p: string[]): string {
  return path.join(RAIZ, ...p);
}

export function existe(rel: string): boolean {
  return fs.existsSync(rutaDe(rel));
}

/**
 * Todos los .ts bajo un directorio, sin node_modules ni dist.
 *
 * `src/plan` queda fuera, y no es una comodidad: este archivo CITA los patrones
 * que persigue. Su primera corrida se acusó a sí misma —el criterio que busca
 * «TODO junto a un acto externo» encontró el literal de su propia expresión
 * regular— y una herramienta que se delata en su estreno no se lee dos veces.
 * El precio es explícito: src/plan es el instrumento de medida, no se mide.
 */
export function fuentes(rel = 'src'): string[] {
  const out: string[] = [];
  const raiz = rutaDe(rel);
  if (!fs.existsSync(raiz)) return out;
  const caminar = (dir: string): void => {
    if (path.relative(RAIZ, dir) === path.join('src', 'plan')) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) caminar(full);
      else if (e.name.endsWith('.ts')) out.push(full);
    }
  };
  caminar(raiz);
  return out;
}

/**
 * Quita comentarios de línea y de bloque.
 *
 * Existe porque un criterio afirmó que dos políticas SÍ se consumían, y su
 * única evidencia era la frase «'umbral_capitalizacion_mxn' policy (see
 * mnemosine pending)» dentro de un comentario. Una mención en prosa no ejecuta
 * nada. Aproximación deliberada: no distingue un `//` dentro de una cadena, lo
 * que puede recortar de más — un criterio que se calla de más falla hacia el
 * rojo, que es el lado seguro.
 */
export function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Archivos (relativos a la raíz) donde aparece el patrón.
 * Con `soloCodigo`, ignora lo que sólo aparece en comentarios.
 */
export function dondeAparece(
  patron: RegExp,
  dirs: string[] = ['src'],
  soloCodigo = false
): string[] {
  const hits: string[] = [];
  for (const dir of dirs) {
    for (const f of fuentes(dir)) {
      const bruto = fs.readFileSync(f, 'utf-8');
      const texto = soloCodigo ? sinComentarios(bruto) : bruto;
      patron.lastIndex = 0;
      if (patron.test(texto)) hits.push(path.relative(RAIZ, f));
    }
  }
  return hits;
}

/** Cuántas veces aparece el patrón en total. */
export function apariciones(patron: RegExp, dirs: string[] = ['src']): number {
  let n = 0;
  for (const dir of dirs) {
    for (const f of fuentes(dir)) {
      const m = fs.readFileSync(f, 'utf-8').match(patron);
      n += m ? m.length : 0;
    }
  }
  return n;
}

/**
 * Consumidores de un símbolo exportado: archivos que lo mencionan y que NO son
 * el que lo define ni una prueba. Es la forma de detectar capacidad huérfana —
 * código que existe, typechecka y no llama nadie.
 */
export function consumidoresDe(simbolo: string, definidoEn: string): string[] {
  const patron = new RegExp(`\\b${simbolo}\\b`);
  return dondeAparece(patron, ['src'], true).filter((f) => !f.endsWith(definidoEn));
}

/**
 * El código de un archivo, sin sus comentarios.
 *
 * Casi todo criterio afirma COMPORTAMIENTO, y para eso el comentario es ruido
 * que miente en las dos direcciones. Pasó en las dos: un comentario que citaba
 * una política dio un ✅ falso, y otro que narraba el código YA BORRADO
 * («la implementación entera era un UPDATE a status = 'balanced'») dio un ✘
 * falso contra un endpoint que hoy se niega a mentir. Leer prosa como si fuera
 * conducta es el error que este archivo existe para no cometer.
 */
export function codigoDe(...p: string[]): string {
  return sinComentarios(fs.readFileSync(rutaDe(...p), 'utf-8'));
}

export const ok = (detalle: string): Resultado => ({ estado: 'ok', detalle });
export const falla = (detalle: string): Resultado => ({ estado: 'falla', detalle });
export const noEvaluable = (detalle: string): Resultado => ({ estado: 'no-evaluable', detalle });

// ── Los criterios ───────────────────────────────────────────

export const CRITERIOS: Criterio[] = [
  // ---- E0.0 · Control de versiones y CI ----
  {
    paquete: 'E0.0',
    enunciado: 'El repositorio tiene remoto, así que la CI puede dispararse',
    evaluar: () => {
      const cfg = rutaDe('.git', 'config');
      if (!fs.existsSync(cfg)) return falla('no hay .git');
      const tiene = /\[remote /.test(fs.readFileSync(cfg, 'utf-8'));
      return tiene
        ? ok('remoto configurado')
        : falla('sin remoto: ci.yml existe pero nunca puede ejecutarse');
    },
  },
  {
    paquete: 'E0.0',
    // Esto exigía la línea literal `^\.env$` y la cadena `.env.backup`. Se
    // puso en rojo el día que alguien SUSTITUYÓ esa lista por `.env*` con
    // `!.env.example` — un patrón estrictamente más fuerte, que además cubre
    // el `.env.old` que la lista no cubría. El criterio afirmaba la forma del
    // arreglo en vez de la propiedad, y castigó una mejora.
    //
    // Ahora se le pregunta a git, que es la autoridad: no importa cómo esté
    // escrito el .gitignore mientras la respuesta sea la correcta.
    enunciado: 'Ninguna variante de .env se puede versionar, salvo el ejemplo',
    evaluar: () => {
      const ignorado = (archivo: string): boolean => {
        const r = spawnSync('git', ['check-ignore', '-q', '--no-index', archivo], { cwd: rutaDe() });
        if (r.error || r.status === null || r.status > 1) return false;
        return r.status === 0;
      };
      const deben = ['.env', '.env.local', '.env.backup-2026-08-27', '.env.old', '.env.copia', '.env.produccion'];
      const sueltos = deben.filter((f) => !ignorado(f));
      if (sueltos.length > 0) {
        return falla(
          `git versionaría ${sueltos.join(', ')}: un secreto real entra al historial en el primer \`git add -A\``
        );
      }
      // La excepción tiene que seguir siendo excepción: sin .env.example nadie
      // sabe qué variables hacen falta, y el arreglo obvio es aflojar el patrón.
      return ignorado('.env.example')
        ? falla('.env.example también está ignorado: sin plantilla, el siguiente arreglo será aflojar el patrón')
        : ok(`${deben.length} variantes de .env ignoradas y .env.example versionable`);
    },
  },
  {
    paquete: 'E0.0',
    enunciado: 'Hay un solo archivo de CI y declara sus cuatro jobs',
    evaluar: () => {
      const dir = rutaDe('.github', 'workflows');
      if (!fs.existsSync(dir)) return falla('no existe .github/workflows');
      const archivos = fs.readdirSync(dir);
      if (archivos.length !== 1) return falla(`${archivos.length} archivos de workflow: ${archivos.join(', ')}`);
      const y = fs.readFileSync(path.join(dir, archivos[0]), 'utf-8');
      const jobs = ['typecheck', 'unit', 'integration', 'aislamiento'].filter((j) =>
        new RegExp(`^  ${j}:`, 'm').test(y)
      );
      return jobs.length === 4
        ? ok(`${archivos[0]} con los cuatro jobs`)
        : falla(`faltan jobs: ${['typecheck', 'unit', 'integration', 'aislamiento'].filter((j) => !jobs.includes(j)).join(', ')}`);
    },
  },
  {
    paquete: 'E0.0',
    enunciado: 'La aplicación conecta como rol NO privilegiado en el job que prueba el aislamiento',
    evaluar: () => {
      const y = fs.readFileSync(rutaDe('.github', 'workflows', 'ci.yml'), 'utf-8');
      const bloque = y.slice(y.indexOf('aislamiento:'));
      return /DATABASE_URL:\s*postgresql:\/\/mnemosine_app/.test(bloque)
        ? ok('DATABASE_URL usa mnemosine_app')
        : falla('el job de aislamiento conecta como superusuario: la RLS no filtra y una política ausente no se detecta');
    },
  },

  // ---- E0.1 · Red de pruebas ----
  {
    paquete: 'E0.1',
    enunciado: 'Los proyectos unitario y de integración están separados',
    evaluar: () =>
      existe('vitest.config.ts') && existe('vitest.integration.config.ts')
        ? ok('dos configuraciones')
        : falla('falta la separación entre pruebas con base y sin base'),
  },
  {
    paquete: 'E0.1',
    enunciado: 'La cobertura del motor contable tiene trinquete por archivo',
    evaluar: () => {
      const c = codigoDe('vitest.config.ts');
      if (!/thresholds/.test(c)) return falla('vitest.config.ts no define umbrales de cobertura');
      const archivos = (c.match(/'src\/[^']+\.ts':/g) ?? []).length;
      return archivos >= 3
        ? ok(`${archivos} archivos con umbral propio`)
        : falla(`sólo ${archivos} archivo(s) con umbral: un umbral global es un promedio que deja caer una pieza crítica`);
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'La suite de integración usa una base efímera, no la de desarrollo',
    evaluar: () => {
      if (!existe('tests/integration/global-setup.ts')) return falla('no hay global-setup de integración');
      const s = codigoDe('tests/integration/global-setup.ts');
      return /CREATE DATABASE/i.test(s) && /DROP DATABASE/i.test(s)
        ? ok('crea y destruye su propia base por corrida')
        : falla('el setup no crea ni destruye una base propia');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'Ningún sello de periodo declara menos asientos de los que su periodo cerrado tiene',
    necesita: 'base-de-datos',
    evaluar: async () => {
      // POR QUÉ ESTE CRITERIO ES LA MITAD DE LO QUE FUE.
      //
      // La primera versión afirmaba además que «todo asiento posteado está en
      // la cadena donde el anclaje está activo». Eso no se puede medir sin un
      // inquilino anclado, así que sobre la base recién creada de CI salía NO
      // EVALUABLE — y `estadoDe` trata un criterio inevaluable como impedimento
      // para dar por cerrado el paquete, con razón: quien depende de E0.1 no
      // distingue «está mal» de «nadie sabe si está bien». El trinquete puso la
      // CI en rojo y tenía razón; lo que no encajaba era el criterio.
      //
      // Se parte, y aquí queda la mitad decidible sin datos previos: un sello
      // que declara menos de lo que su periodo cerrado tiene posteado es falso
      // con datos o sin ellos, y cuando no hay sellos no hay nada que
      // contradiga la afirmación. La otra mitad vive donde se puede medir de
      // verdad —tests/integration/sello-periodo.int.spec.ts, que siembra el
      // anclaje y comprueba que postear un borrador entra en la cadena y que
      // `commitPeriod` se niega ante una laguna—.
      //
      // Este criterio es, entonces, un detector de regresión sobre datos
      // reales, no la prueba del paquete. Por eso su detalle SIEMPRE dice
      // cuántos sellos llegó a inspeccionar: un verde que no diga eso sería
      // verde por no mirar, que es justo lo que el sprint persigue.
      const { query } = await import('../database/connection.js');

      let alcance = 'todos los inquilinos';
      try {
        const rol = await query<{ ve: boolean; rol: string }>(
          `SELECT current_user AS rol,
                  COALESCE(rolsuper OR rolbypassrls, false) AS ve
             FROM pg_roles WHERE rolname = current_user`
        );
        if (rol.rows[0] && !rol.rows[0].ve) {
          // Las tablas llevan RLS forzado: sin contexto de inquilino este rol
          // ve cero filas. No es motivo para declararse inevaluable —no hay
          // nada que contradiga la afirmación— pero sí para decirlo.
          alcance = `lo visible para "${rol.rows[0].rol}", que está sujeto a RLS`;
        }
      } catch {
        /* si pg_roles no se deja leer, lo dirá el catch de abajo */
      }

      let sellos;
      try {
        sellos = await query<{ period_id: string; declarados: number; posteados: string }>(
          // Sólo periodos CERRADOS. En uno abierto, un sello que cubre menos
          // no es una mentira sino una foto con fecha: se selló, y después
          // entraron asientos. El endpoint público sirve `committedAt` al
          // lado de la cifra, así que esa diferencia es legible.
          `SELECT pc.period_id,
                  pc.entry_count AS declarados,
                  (SELECT count(*) FROM journal_entries je
                    WHERE je.fiscal_period_id = pc.period_id
                      AND je.entity_id = pc.entity_id
                      AND je.status = 'posted')::text AS posteados
             FROM period_commitments pc
             JOIN fiscal_periods fp ON fp.id = pc.period_id
            WHERE fp.status IN ('soft_close', 'hard_close', 'locked')`
        );
      } catch (e) {
        const porque = (e as Error).message.slice(0, 60) || 'sin detalle';
        return noEvaluable(`no hay base de datos accesible para medirlo (${porque})`);
      }

      const mienten = sellos.rows.filter((x) => x.declarados !== Number(x.posteados));
      if (mienten.length > 0) {
        const m = mienten[0];
        return falla(
          `${mienten.length} sello(s) declaran menos asientos de los que su periodo tiene ` +
            `posteados — p. ej. el periodo ${m.period_id.slice(0, 8)} sella ${m.declarados} ` +
            `de ${m.posteados}. Esa cifra se publica como la cuenta del periodo.`
        );
      }
      return ok(
        sellos.rows.length === 0
          ? `sin sellos de periodos cerrados que revisar en ${alcance}`
          : `${sellos.rows.length} sello(s) de periodos cerrados coinciden con su periodo (${alcance})`
      );
    },
  },

  // ---- E0.2 · Contrato código ↔ esquema ----
  {
    paquete: 'E0.2',
    enunciado: 'El escáner resuelve columnas calificadas por alias, no sólo consultas de una tabla',
    evaluar: () => {
      const p = 'tests/integration/helpers/sql-scan.ts';
      if (!existe(p)) return falla('no existe el escáner');
      return /columnasCalificadas/.test(codigoDe(p))
        ? ok('cubre consultas con alias y JOIN')
        : falla('el escáner sólo mira SELECT de una tabla sin alias: un p.columna_inexistente pasa en verde');
    },
  },
  {
    paquete: 'E0.2',
    enunciado: 'Ninguna consulta nombra la tabla `entities`, que no existe',
    evaluar: () => {
      const hits = dondeAparece(/\b(?:FROM|JOIN|INTO|UPDATE)\s+entities\b/i, ['src'], true);
      return hits.length === 0
        ? ok('cero referencias')
        : falla(`${hits.length} archivo(s): ${hits.slice(0, 3).join(', ')}`);
    },
  },
  {
    paquete: 'E0.2',
    // Nació como el único criterio NO EVALUABLE de los quince paquetes, y su
    // detalle nombraba cinco «divergencias conocidas» — una de ellas mal, era
    // matched_entity_type y no match_type. E0.2-j las cerró todas y creó lo
    // que faltaba para poder medir: un censo que dice a QUÉ COLUMNA pertenece
    // cada vocabulario. Sin ese dato la comparación es imposible; con él es
    // aritmética.
    //
    // No nombra ningún archivo: persigue la FORMA del censo, no su ubicación.
    // Si alguien lo mueve o lo parte en dos, el criterio lo sigue.
    enunciado: 'Ningún vocabulario del código admite un valor que el CHECK rechaza ni esconde uno que admite',
    evaluar: () => {
      const literales = (s: string): string[] =>
        [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));

      // Los CHECK, leídos de las migraciones EN ORDEN: la base contra la que
      // corre la suite de integración se construye ejecutándolas así, y dos
      // columnas se redefinen más tarde (journal_entries.entry_type, en 023 y
      // 025). Gana la última, igual que en Postgres.
      const dir = 'src/database/migrations';
      const enElEsquema = new Map<string, string[]>();
      for (const f of fs.readdirSync(rutaDe(dir)).filter((n) => n.endsWith('.sql')).sort()) {
        const sql = fs.readFileSync(rutaDe(dir, f), 'utf-8').replace(/--[^\n]*/g, '');
        const anota = (tabla: string, columna: string, lista: string): void => {
          const valores = literales(lista);
          if (valores.length) enElEsquema.set(`${tabla.replace(/^public\./i, '')}.${columna}`, valores);
        };
        for (const t of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)\s*\(([\s\S]*?)\n\);/gi)) {
          for (const c of t[2].matchAll(/CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)/gi)) anota(t[1], c[1], c[2]);
        }
        // `[^;]*?` y no `[\s\S]*?`: con el segundo, un ALTER sin CHECK se
        // engancha al CHECK de otra tabla más abajo del archivo y le atribuye
        // un vocabulario ajeno. Costó tres atribuciones falsas descubrirlo.
        for (const a of sql.matchAll(
          /ALTER\s+TABLE\s+(?:ONLY\s+)?([\w.]+)[^;]*?ADD\s+CONSTRAINT[^;]*?CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)/gi
        )) {
          anota(a[1], a[2], a[3]);
        }
      }
      if (enElEsquema.size < 20) {
        return noEvaluable(
          `sólo se leyeron ${enElEsquema.size} CHECK de vocabulario en las migraciones: ` +
            'ya no tienen la forma que este criterio sabe leer'
        );
      }

      // El censo: una terna (tabla, columna, CONSTANTE). Es el único dato que
      // hace comparable un vocabulario, porque `status` tiene CHECK en 37
      // tablas distintas y adivinar por el nombre de la columna produce más de
      // cien falsos positivos.
      const TERNA = /'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*([A-Z][A-Z0-9_]*)\s*\)/;
      const declarado = new Map<string, string[]>();
      const sinCensar: string[] = [];
      for (const archivo of dondeAparece(TERNA, ['src'], true)) {
        const codigo = codigoDe(archivo);
        const constantes = new Map<string, string[]>();
        for (const c of codigo.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*\[([^\]]*)\]\s*as\s+const/g)) {
          constantes.set(c[1], literales(c[2]));
        }
        const censadas = new Set<string>();
        for (const t of codigo.matchAll(new RegExp(TERNA, 'g'))) {
          const clave = `${t[1]}.${t[2]}`;
          if (!enElEsquema.has(clave)) continue;
          censadas.add(t[3]);
          declarado.set(clave, constantes.get(t[3]) ?? []);
        }
        // Declarar la constante y no censarla la deja fuera de vigilancia sin
        // que nada lo note: es la forma silenciosa de volver al problema.
        if (censadas.size > 0) {
          for (const nombre of constantes.keys()) {
            if (!censadas.has(nombre)) sinCensar.push(`${archivo}:${nombre}`);
          }
        }
      }
      if (declarado.size === 0) {
        return falla(
          'ninguna parte del código dice a qué columna pertenece un vocabulario: ' +
            'cada validador guarda su copia a mano y nada la compara con el CHECK'
        );
      }

      // Los dos sentidos, porque fallan distinto: de más es un 500 en la cara
      // del usuario, de menos es una capacidad que existe y nadie alcanza.
      const problemas: string[] = [];
      for (const [clave, valores] of declarado) {
        const reales = enElEsquema.get(clave)!;
        const sobran = valores.filter((x) => !reales.includes(x));
        const faltan = reales.filter((x) => !valores.includes(x));
        if (sobran.length) {
          problemas.push(
            `${clave} acepta ${sobran.join(', ')} que el CHECK rechaza: Postgres lanza 23514 y el usuario ve un 500`
          );
        }
        if (faltan.length) {
          problemas.push(
            `${clave} esconde ${faltan.join(', ')} que el CHECK admite: esa capacidad existe en la base y es inalcanzable`
          );
        }
      }
      if (problemas.length) return falla(problemas.slice(0, 4).join(' · '));
      if (sinCensar.length) {
        return falla(
          `vocabulario declarado sin decir de qué columna es, así que nada lo compara: ${sinCensar.join(', ')}`
        );
      }
      return ok(
        `${declarado.size} vocabularios coinciden exactamente con su CHECK, ` +
          `de ${enElEsquema.size} leídos de las migraciones`
      );
    },
  },

  // ---- E0.3 · Bitácora de auditoría ----
  {
    paquete: 'E0.3',
    enunciado: 'El motor de posteo deja rastro en la misma transacción que el asiento',
    evaluar: () => {
      const p = 'src/services/accounting/posting.ts';
      const s = codigoDe(p);
      const n = (s.match(/registrarAuditoria/g) ?? []).length;
      return n >= 4
        ? ok(`${n} puntos de auditoría en posting.ts`)
        : falla(`sólo ${n}: un asiento creado por la CLI o el agente no deja rastro`);
    },
  },
  {
    paquete: 'E0.3',
    enunciado: 'La bitácora no se puede reescribir: UPDATE y DELETE fallan en Postgres',
    evaluar: () => {
      const migs = fs.readdirSync(rutaDe('src/database/migrations'));
      const protege = migs.some((m) => {
        const s = fs.readFileSync(rutaDe('src/database/migrations', m), 'utf-8');
        return /audit_log/.test(s) && /(REVOKE|CREATE RULE|BEFORE UPDATE OR DELETE)/i.test(s);
      });
      return protege
        ? ok('una migración revoca la reescritura')
        : falla('ninguna migración protege audit_log: el rastro es borrable');
    },
  },
  {
    paquete: 'E0.3',
    enunciado:
      'Toda bitácora de sólo agregar lleva disparador, y la lista de privilegios la refleja',
    evaluar: () => {
      // Este criterio existe porque el anterior no bastaba, y la forma en que
      // no bastaba es instructiva: `/audit_log/ && /REVOKE/` da verde con un
      // archivo que sólo REVOCA. La migración 014 hacía exactamente eso sobre
      // fiscal_credential_access_log —y sólo FROM PUBLIC, que no toca el GRANT
      // explícito a mnemosine_app—, así que un criterio calcado habría
      // declarado protegida una bitácora que cualquiera podía reescribir.
      //
      // Aquí se exige la capa que aguanta: el disparador. Y se cruzan las TRES
      // listas que hoy tienen que decir lo mismo y que nadie comparaba:
      //   · las tablas con disparador, leídas de las migraciones;
      //   · el array `append_only` de rls-policies.sql, que corre DESPUÉS de
      //     todas las migraciones y devuelve la escritura a lo que no esté;
      //   · el mismo array en scripts/provision-roles.sql, cuyo GRANT sobre
      //     ALL TABLES la devuelve otra vez en cada reprovisionado.
      // Una tabla con disparador que falte de cualquiera de los dos arrays
      // pierde la capa barata en silencio; un nombre en un array sin
      // disparador es una protección que sólo existe en la lista.
      //
      // El SQL se lee SIN comentarios. `codigoDe` no sirve aquí: su
      // `sinComentarios` quita `/* */` y `//` —los de TypeScript— y deja
      // pasar `--`, que es el de SQL. Con la versión anterior, comentar la
      // tabla dentro del array bastaba para que este criterio siguiera en
      // verde mientras Postgres la dejaba fuera. Se comprobó ejecutándolo.
      const sinComentariosSql = (t: string): string =>
        t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

      const dir = 'src/database/migrations';
      const sql = sinComentariosSql(
        fs
          .readdirSync(rutaDe(dir))
          .map((m) => fs.readFileSync(rutaDe(dir, m), 'utf-8'))
          .join('\n')
      );

      // Se aceptan las formas equivalentes que Postgres acepta: `CREATE OR
      // REPLACE TRIGGER`, el nombre de tabla entrecomillado, y los eventos en
      // cualquier orden. Exigir la secuencia literal `UPDATE OR DELETE` ponía
      // en rojo código correcto escrito `DELETE OR UPDATE`, que es el modo en
      // que un criterio deja de creerse y se desactiva.
      const eventos = new Map<string, Set<string>>();
      const funcionDe = new Map<string, Set<string>>();
      const RE_TRIGGER =
        /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?\w+"?\s+BEFORE\s+([A-Za-z\s]+?)\s+ON\s+(?:public\.)?"?(\w+)"?([\s\S]*?);/gi;
      for (const m of sql.matchAll(RE_TRIGGER)) {
        const tabla = m[2];
        const evs = m[1].toUpperCase().split(/\s+OR\s+/).map((e) => e.trim());
        const set = eventos.get(tabla) ?? new Set<string>();
        for (const e of evs) set.add(e);
        eventos.set(tabla, set);
        const fn = /EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?"?(\w+)"?/i.exec(m[3]);
        if (fn) {
          const fns = funcionDe.get(tabla) ?? new Set<string>();
          fns.add(fn[1]);
          funcionDe.set(tabla, fns);
        }
      }

      // «Hay disparador» y «el disparador rechaza» son cosas distintas: uno
      // cuyo cuerpo hiciera `RETURN NEW` satisfaría lo primero y no protegería
      // nada. Se exige que la función que cuelga del disparador levante
      // excepción.
      const rechaza = (fn: string): boolean => {
        const i = new RegExp(
          `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?"?${fn}"?`,
          'i'
        ).exec(sql);
        return i !== null && /RAISE\s+EXCEPTION/i.test(sql.slice(i.index, i.index + 2000));
      };

      const protegidas = new Set<string>();
      const parciales: string[] = [];
      for (const [tabla, evs] of eventos) {
        const completa =
          evs.has('UPDATE') && evs.has('DELETE') && evs.has('TRUNCATE');
        const fns = [...(funcionDe.get(tabla) ?? [])];
        const muerden = fns.length > 0 && fns.every(rechaza);
        if (completa && muerden) {
          protegidas.add(tabla);
        } else if (evs.has('UPDATE') || evs.has('DELETE')) {
          // Sólo se reporta lo que PARECE una bitácora cerrada y no lo está.
          // Un disparador BEFORE UPDATE cualquiera —hay varios de
          // `updated_at`— no entra aquí porque su función no levanta excepción.
          if (muerden) {
            parciales.push(
              `${tabla}: rechaza ${[...evs].sort().join('/')} pero le falta ` +
                `${['UPDATE', 'DELETE', 'TRUNCATE'].filter((e) => !evs.has(e)).join(' y ')}` +
                (evs.has('TRUNCATE') ? '' : ' — un TRUNCATE no dispara triggers de fila')
            );
          }
        }
      }
      if (parciales.length > 0) return falla(parciales.join('; '));
      if (protegidas.size === 0) {
        return falla('ninguna tabla lleva disparador de sólo-agregar que rechace');
      }

      const arrayDe = (rel: string): Set<string> | null => {
        const txt = sinComentariosSql(fs.readFileSync(rutaDe(rel), 'utf-8'));
        const m = /append_only\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/.exec(txt);
        if (!m) return null;
        return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
      };

      const fuentes: Array<{ rel: string; porque: string }> = [
        {
          rel: 'src/database/rls-policies.sql',
          porque: 'corre después de migrar y su GRANT general les devuelve la escritura',
        },
        {
          rel: 'scripts/provision-roles.sql',
          porque: 'su GRANT sobre ALL TABLES se la devuelve en cada reprovisionado',
        },
      ];

      const problemas: string[] = [];
      for (const f of fuentes) {
        const lista = arrayDe(f.rel);
        if (!lista) {
          problemas.push(`${f.rel}: no se encontró el array append_only — ${f.porque}`);
          continue;
        }
        const faltan = [...protegidas].filter((t) => !lista.has(t));
        const sobran = [...lista].filter((t) => !protegidas.has(t));
        if (faltan.length > 0) {
          problemas.push(`${f.rel}: falta ${faltan.join(', ')} — ${f.porque}`);
        }
        if (sobran.length > 0) {
          problemas.push(
            `${f.rel}: nombra ${sobran.join(', ')} sin disparador que lo respalde ` +
              '(el dueño del esquema ignora los privilegios de tabla)'
          );
        }
      }
      if (problemas.length > 0) return falla(problemas.join('; '));

      return ok(
        `${protegidas.size} bitácoras con disparador que rechaza y las dos listas de ` +
          `privilegios al día: ${[...protegidas].sort().join(', ')}`
      );
    },
  },

  // ---- E1.1 · Roles de cuenta ----
  {
    paquete: 'E1.1',
    enunciado: 'Toda ruta de alta de entidad siembra los roles, no sólo el asistente',
    evaluar: () => {
      if (!existe('src/services/entity/entity-service.ts')) {
        return falla('crear una entidad sigue siendo privado del asistente init');
      }
      const s = codigoDe('src/services/entity/entity-service.ts');
      return /ensureEntityAccounting/.test(s)
        ? ok('el servicio de alta siembra catálogo y roles')
        : falla('entity-service no siembra la contabilidad de la entidad');
    },
  },
  {
    paquete: 'E1.1',
    enunciado: 'Las cuatro cuentas de IVA se siembran siempre, también sobre catálogo importado',
    evaluar: () => {
      const s = codigoDe('src/services/xml-ingestion/account-roles-seed.ts');
      const faltan = ['1130', '1135', '2120', '2125'].filter(
        (c) => !new RegExp(`code:\\s*'${c}'`).test(s)
      );
      return faltan.length === 0
        ? ok('1130, 1135, 2120 y 2125 en REQUIRED_ACCOUNTS')
        : falla(`no se siembran: ${faltan.join(', ')} — una entidad onboardeada revienta con MISSING_ROLE_ACCOUNT`);
    },
  },

  // ---- E1.2 · Cerebro fiscal del CFDI ----
  {
    paquete: 'E1.2',
    enunciado: 'El IVA de un documento PPD se aparca y sólo el pago lo acredita',
    evaluar: () => {
      if (!existe('src/services/accounting/iva-cash-basis.ts')) {
        return falla('no existe el módulo de IVA sobre flujo');
      }
      const arap = codigoDe('src/services/accounting/ar-ap-posting.ts');
      return /iva-cash-basis/.test(arap)
        ? ok('el posteo de AR/AP consulta el método de pago')
        : falla('ar-ap-posting acredita el IVA al facturar: la declaración mensual no va a cuadrar');
    },
  },
  {
    paquete: 'E1.2',
    enunciado: 'No se libera IVA que el documento nunca aparcó',
    evaluar: () => {
      const p = 'src/services/accounting/iva-cash-basis.ts';
      if (!existe(p)) return falla('no existe el módulo');
      return /ivaStillParked/.test(codigoDe(p))
        ? ok('la liberación se topa contra lo realmente aparcado')
        : falla('una factura anterior al corte abonaría por segunda vez y dejaría la cuenta pendiente en negativo');
    },
  },

  // ---- E1.3 · Políticas con consumidor ----
  {
    paquete: 'E1.3',
    // La versión anterior de este criterio preguntaba si `getPolicy` tenía
    // llamadores. Es un proxy, y uno malo: se puede llamar getPolicy una vez y
    // dejar nueve políticas muertas, y el criterio quedaría en verde. Lo que
    // importa es lo otro — que contestar una política cambie algo.
    enunciado: 'Contestar una política cambia el comportamiento de alguien',
    evaluar: () => {
      const catalogo = rutaDe('src', 'services', 'policy', 'pending-catalog.ts');
      if (!fs.existsSync(catalogo)) return noEvaluable('no existe el catálogo de políticas');
      const claves = [...fs.readFileSync(catalogo, 'utf-8').matchAll(/key:\s*'([a-z0-9_]+)'/g)]
        .map((m) => m[1]);
      if (claves.length === 0) return noEvaluable('el catálogo no declara ninguna clave legible');

      // El módulo de políticas y las pantallas que las PREGUNTAN no cuentan
      // como consumidores: presentar la pregunta no es usar la respuesta.
      const preguntan = [
        path.join('src', 'services', 'policy'),
        path.join('src', 'cli', 'init', 's4-policies.ts'),
        path.join('src', 'cli', 'pending-command.ts'),
      ];
      const ajeno = (f: string): boolean => !preguntan.some((pre) => f.startsWith(pre));

      // Primero lo exacto: consumir una política es pasar su clave a un LECTOR.
      // Si nadie llama a un lector, ninguna clave se lee, y contarlas una por
      // una sólo puede producir falsos verdes.
      const lectores = dondeAparece(/\bgetPolicy(Number)?\s*\(/, ['src'], true).filter(ajeno);
      if (lectores.length === 0) {
        return falla(
          `ninguna de las ${claves.length} políticas se lee: nadie llama a getPolicy ` +
            `fuera del módulo, así que el catálogo entero es decorativo`
        );
      }

      const huerfanas = claves.filter(
        (k) => dondeAparece(new RegExp(`['\`"]${k}['\`"]`), ['src'], true).filter(ajeno).length === 0
      );
      return huerfanas.length === 0
        ? ok(`${claves.length} políticas, todas leídas por algún consumidor`)
        : falla(
            `${huerfanas.length} de ${claves.length} políticas no las lee nadie ` +
              `(${huerfanas.join(', ')}): el usuario las contesta y no cambian nada`
          );
    },
  },

  // ---- E1.4 · Módulos sin puerta ----
  {
    paquete: 'E1.4',
    enunciado: 'La depreciación mensual tiene por dónde invocarse',
    evaluar: () => {
      const cons = consumidoresDe('runMonthlyDepreciation', 'depreciation.ts');
      return cons.length > 0
        ? ok(`invocable desde ${cons.join(', ')}`)
        : falla('runMonthlyDepreciation no tiene llamador: el motor existe y no hay puerta');
    },
  },
  {
    paquete: 'E1.4',
    enunciado: 'Ninguna función reporta éxito de un acto externo que no realiza',
    evaluar: () => {
      const sospechosos = dondeAparece(
        /TODO:[^\n]*(PAC|SAT|IRS|SSA|enviar|send)/i
      );
      return sospechosos.length === 0
        ? ok('sin TODO sobre un acto externo en el camino de escritura')
        : falla(`${sospechosos.join(', ')} — un TODO junto a un UPDATE de estado es un acto que se reporta y no ocurre`);
    },
  },

  // ---- E2.1 · Perímetro ----
  {
    paquete: 'E2.1',
    enunciado: 'El contexto de inquilino se monta una sola vez para todo /v1',
    evaluar: () => {
      if (!existe('src/api/rest/middleware/tenant-context.ts')) return falla('no existe el middleware');
      const idx = codigoDe('src/index.ts');
      return /tenantContext/.test(idx)
        ? ok('montado en index.ts')
        : falla('el middleware existe y no está montado: cada router puede olvidarlo');
    },
  },
  {
    paquete: 'E2.1',
    // La primera versión decía que la guarda «es un no-op porque req.entityId
    // sale del encabezado». Era falso: la guarda SÍ comprueba que la entidad
    // del encabezado pertenezca al usuario. El defecto es otro, y peor —
    // comprueba una entidad y el handler trabaja con otra.
    // CUARTA REDACCIÓN, Y LA PRIMERA QUE NO SE ROMPE SOLA.
    //
    // Las tres anteriores leían las TRIPAS de requireEntityAccess: qué fuentes
    // listaba, si encadenaba con `||`, cómo se llamaba su variable. Cada
    // arreglo de la guarda —hubo tres— dejó ciega a la redacción vigente, y un
    // criterio ciego no protege nada mientras nadie lo mira.
    //
    // Esto pregunta lo único que importa y que ningún refactor de la guarda
    // cambia: ¿queda alguna ruta que acote su trabajo por una entidad que
    // NADIE comprobó? Da igual cómo compruebe la guarda; lo que no puede
    // pasar es que no se monte.
    enunciado: 'Ninguna ruta acota su trabajo por una entidad que nadie comprobó',
    evaluar: () => {
      const dir = 'src/api/rest/routes';
      const archivos = fuentes(dir);
      if (archivos.length === 0) return noEvaluable('no hay rutas REST que revisar');

      // Cada bloque de ruta va desde su `router.verbo(` hasta el siguiente.
      // La cadena de middlewares vive al principio; el manejador, detrás.
      const ROUTER = /router\.(get|post|patch|put|delete)\(\s*'([^']*)'([\s\S]*?)(?=\nrouter\.|\nexport default)/g;
      const desprotegidas: string[] = [];
      let revisadas = 0;

      for (const f of archivos) {
        const texto = sinComentarios(fs.readFileSync(f, 'utf-8'));
        for (const m of texto.matchAll(ROUTER)) {
          revisadas += 1;
          const cuerpo = m[3];
          // La entidad la trae la petición: la cabecera ya resuelta en
          // req.entityId, o la query, o el cuerpo, o el parámetro de ruta.
          const derivaDeLaPeticion =
            /req\.entityId/.test(cuerpo) ||
            /\bentity_id[^;\n]*=\s*req\.(query|body)/.test(cuerpo) ||
            /req\.(query|body)\.entity_id\b/.test(cuerpo) ||
            /\{[^}]*\bentity_id\b[^}]*\}\s*=\s*req\.(query|body)/.test(cuerpo);
          if (!derivaDeLaPeticion) continue;
          // Hay DOS formas legítimas de protegerla, y el repositorio usa las
          // dos: montar requireEntityAccess en la cadena de middlewares, o
          // llamar a assertEntityAccess dentro del manejador sobre el valor
          // que se va a usar —lo que hacen /commit-period y /publish-aggregates
          // en blockchain.ts—. Exigir sólo la primera las acusaba en falso, y
          // una acusación falsa es lo que hace que se deje de leer el informe.
          //
          // La cadena de middlewares se busca sólo al principio del bloque:
          // buscarla entera daría por montada la guarda cuando el nombre
          // aparece dentro del cuerpo por cualquier otra razón.
          const montada = /requireEntityAccess/.test(cuerpo.slice(0, 300));
          const comprobadaDentro = /assertEntityAccess\s*\(/.test(cuerpo);
          if (!montada && !comprobadaDentro) {
            desprotegidas.push(`${path.basename(f)} ${m[1].toUpperCase()} ${m[2]}`);
          }
        }
      }

      return desprotegidas.length === 0
        ? ok(`${revisadas} rutas revisadas; todas las que derivan su entidad de la petición montan la guarda`)
        : falla(
            `${desprotegidas.length} de ${revisadas} rutas acotan por una entidad de la petición sin ` +
              `montar requireEntityAccess: ${desprotegidas.slice(0, 6).join(' · ')}` +
              (desprotegidas.length > 6 ? ` y ${desprotegidas.length - 6} más` : '') +
              '. Basta la cabecera x-entity-id para trabajar sobre otra entidad del mismo inquilino'
          );
    },
  },
  {
    paquete: 'E2.1',
    enunciado: 'GraphQL no expone mutaciones al mayor fuera del prefijo auditado',
    evaluar: () => {
      const idx = codigoDe('src/index.ts');
      if (!/graphql/i.test(idx)) return ok('GraphQL no está montado');
      return /graphqlEnabled/.test(idx)
        ? ok('montado sólo tras GRAPHQL_ENABLED, apagado por omisión')
        : falla('GraphQL montado sin compuerta: dos mutaciones llegan al motor de posteo sin permisos');
    },
  },

  // ---- E2.2 · Catálogo de autorización ----
  {
    paquete: 'E2.2',
    // No pregunta si existe src/auth/roles.ts. Que exista un archivo no le da
    // permisos a nadie; lo que importa es si el rol que el CLI reparte
    // significa algo del otro lado.
    // Antes comparaba dos catálogos y nombraba los roles que sólo existían en
    // uno (contador, revisor). AUD-3 los unificó en src/auth/roles.ts, así que
    // la pregunta ya no es si coinciden: es si vuelve a haber dos.
    enunciado: 'Los permisos de un rol se declaran en un solo sitio',
    evaluar: () => {
      // Un catálogo es un mapa de roles cuyos valores traen `permissions`.
      // Derivarlo de otro —lo que hace hoy middleware/auth.ts— no cuenta:
      // eso es un consumidor con otra forma, no una segunda verdad.
      const declaran = fuentes('src')
        .map((f) => ({ rel: path.relative(rutaDe(), f), texto: sinComentarios(fs.readFileSync(f, 'utf-8')) }))
        .filter(({ texto }) => /^\s*[a-z_]+:\s*\{[\s\S]{0,400}?permissions:\s*\[/m.test(texto))
        .map(({ rel }) => rel);

      if (declaran.length === 0) {
        return noEvaluable('ningún archivo declara permisos por rol con la forma que este criterio lee');
      }
      return declaran.length === 1
        ? ok(`un solo catálogo: ${declaran[0]}`)
        : falla(
            `${declaran.length} catálogos declaran los permisos de un rol por su cuenta ` +
              `(${declaran.join(', ')}): un usuario creado por uno llega al otro con permisos distintos`
          );
    },
  },
  {
    paquete: 'E2.2',
    enunciado: 'La aplicación no arranca en producción con el secreto de desarrollo',
    evaluar: () => {
      const s = codigoDe('src/config/index.ts');
      return /production/.test(s) && /(jwt|secret)/i.test(s) && /throw/i.test(s)
        ? ok('falla rápido con el valor de ejemplo')
        : falla('un default de desarrollo sobrevive callado a producción');
    },
  },

  // ---- E3.1 · Timbrado real ----
  {
    paquete: 'E3.1',
    enunciado: 'Un adaptador simulado no puede producir un timbre ni un acuse',
    evaluar: () => {
      const p = 'src/services/integrations/mexico/pac/pac-router.ts';
      if (!existe(p)) return falla('no existe el router de PAC');
      const s = codigoDe(p);
      const guardas = (s.match(/assertPuedeTimbrar/g) ?? []).length;
      // Dos: timbrar y cancelar. Cancelar es irreversible ante el SAT, así que
      // un acuse fabricado es peor que un timbre fabricado.
      return guardas >= 3
        ? ok('timbrado y cancelación con cerrojo')
        : falla(`sólo ${guardas - 1} de las 2 vías con cerrojo: la que falta puede fabricar un folio`);
    },
  },
  {
    paquete: 'E3.1',
    enunciado: 'Cancelar un CFDI no marca la factura como cancelada sin llamar al PAC',
    evaluar: () => {
      const s = codigoDe('src/api/rest/routes/invoices.ts');
      return /cfdi_status\s*=\s*'cancelled'/.test(s)
        ? falla('la ruta marca cancelado sin acuse: el mayor cree cancelado un CFDI vigente ante el SAT')
        : ok('la ruta no finge cancelar');
    },
  },

  // ---- E3.2 · Descarga del SAT ----
  {
    paquete: 'E3.2',
    enunciado: 'El despacho puede traer del SAT los CFDI que no le llegaron',
    evaluar: () => {
      const cons = dondeAparece(/sat\s+download|descargaMasiva|SolicitaDescarga/i, ['src'], true);
      return cons.length > 0
        ? ok(`${cons.length} archivo(s) en el camino de descarga`)
        : falla('sin descarga masiva el despacho no puede afirmar completitud, que es lo que vende');
    },
  },

  // ---- E4.1 · Ciclos de banca y nómina ----
  {
    paquete: 'E4.1',
    enunciado: 'Una conciliación no se declara cuadrada sin postear su diferencia',
    evaluar: () => {
      const p = 'src/api/rest/routes/bank-reconciliation.ts';
      const s = codigoDe(p);
      const marca = /status\s*=\s*'balanced'/.test(s);
      const postea = /createJournalEntry|postJournalEntry/.test(s);
      if (!marca) return ok('ninguna ruta marca cuadrado sin más');
      return postea
        ? ok('marca cuadrado y postea')
        : falla('marca cuadrado sin postear, y la compuerta de cierre lo acepta como prueba');
    },
  },
  {
    paquete: 'E4.1',
    enunciado: 'El mapeo contable de nómina se siembra en el alta',
    evaluar: () => {
      const cons = consumidoresDe('seedPayrollAccountMapping', 'payroll-account-mapping-seed.ts');
      return cons.length > 0
        ? ok(`sembrado desde ${cons.join(', ')}`)
        : falla('payroll_account_mapping sin escritor: la primera corrida de nómina muere');
    },
  },

  // ---- E4.2 · Trabajos y reportes ----
  {
    paquete: 'E4.2',
    enunciado: 'Postear no dispara el refresco de vistas materializadas',
    evaluar: () => {
      const s = codigoDe('src/services/accounting/posting.ts');
      return /REFRESH\s+MATERIALIZED/i.test(s)
        ? falla('cada posteo refresca las vistas: el coste crece con el volumen y bloquea')
        : ok('el refresco no vive en el camino de posteo');
    },
  },
  {
    paquete: 'E4.2',
    enunciado: 'Las superficies de reportes consumen una sola capa de consulta',
    evaluar: () => {
      const cons = consumidoresDe('getTrialBalance', 'report-service.ts');
      const copias = dondeAparece(/SUM\(\s*COALESCE\(jel\.debit_amount/i, ['src'], true).filter(
        (f) => !f.includes('report-service')
      );
      return copias.length === 0
        ? ok(`una sola capa, consumida por ${cons.length} superficie(s)`)
        : falla(`${copias.length} copia(s) del SQL de saldos fuera de report-service: ${copias.join(', ')}`);
    },
  },

  // ---- E5.1 · Madurez del agente ----
  {
    paquete: 'E5.1',
    enunciado: 'Toda hoja del CLI declara su riesgo, así que hay algo sobre lo que aplicar la compuerta',
    evaluar: async () => {
      // Se mide sobre el PROGRAMA EMBARCADO, no sobre un árbol de juguete.
      // 49 de 106 hojas no declaraban nada —entre ellas las que postean al
      // mayor y la que ejecuta contra el sistema del cliente— y por eso la
      // regla R11 del auditor devolvía cero violaciones: no tenía sobre qué
      // correr. Un verde por no tener nada que mirar es el defecto que este
      // sprint persigue, y aquí estaba en el instrumento mismo.
      const { program } = await import('../cli/mnemosine.js');
      const { riskOf } = await import('../cli/kernel/risk.js');
      const { hojasDe } = await import('../cli/kernel/riesgos-retrofit.js');

      const hojas = hojasDe(program);
      if (hojas.length < 80) {
        return noEvaluable(`sólo se leyeron ${hojas.length} hojas: el árbol no se montó entero`);
      }
      const sin = hojas.filter((h) => !riskOf(h.cmd)).map((h) => h.ruta);
      if (sin.length > 0) {
        return falla(
          `${sin.length} de ${hojas.length} hojas sin declarar (${sin.slice(0, 4).join(', ')}` +
            `${sin.length > 4 ? ', …' : ''}): a lo que no declara no se le aplica ninguna compuerta`
        );
      }
      // Y la garantía que sostiene el diseño del asistente.
      const agenteEnGrave = hojas.filter((h) => {
        const r = riskOf(h.cmd)!;
        return r.agentAllowed && (r.risk === 'irreversible' || r.risk === 'externo');
      });
      return agenteEnGrave.length === 0
        ? ok(`las ${hojas.length} hojas declaran, y ninguna grave es invocable por el agente`)
        : falla(
            `${agenteEnGrave.map((h) => h.ruta).join(', ')}: el agente puede invocar algo irreversible o externo`
          );
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Las herramientas del agente se derivan del registro de riesgo del CLI',
    evaluar: () => {
      const cons = consumidoresDe('allDeclarations', 'risk.ts');
      return cons.length > 0
        ? ok(`el puente existe: ${cons.join(', ')}`)
        : falla(
            'allDeclarations no tiene consumidor: las 24 herramientas del agente están escritas a mano ' +
              'y no comparten nada con el registro de riesgo, así que «el agente comparte la superficie» es una aspiración'
          );
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Una corrida desatendida no puede alcanzar una herramienta que escriba',
    evaluar: () => {
      // La versión anterior miraba runner.ts, y ahí no se eligen herramientas:
      // el runner recibe `runAgentTurn` ya construido. Era un rojo que ningún
      // arreglo podía apagar, y un criterio así se vuelve paisaje.
      const cli = 'src/cli/mnemosine.ts';
      if (!existe(cli)) return noEvaluable('no existe el CLI');
      const texto = codigoDe(cli);
      const i = texto.indexOf('const makeRunAgentTurn');
      if (i < 0) return noEvaluable('makeRunAgentTurn ya no existe: el puente de tareas cambió de forma');
      const fin = texto.indexOf('\n\n', i);
      const fabrica = texto.slice(i, fin < 0 ? undefined : fin);

      return /tools|herramientas|soloLectura|readOnly|allow/i.test(fabrica)
        ? ok('la sesión desatendida se construye con su superficie recortada')
        : falla(
            'makeRunAgentTurn crea la sesión sin recortar herramientas: la corrida desatendida ' +
              'tiene las mismas que una interactiva, y lo único que pide borradores es una ' +
              'frase del prompt (KIND_INSTRUCTIONS). Un modelo que la ignora escribe de verdad'
          );
    },
  },
];
