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
    enunciado: 'Ningún respaldo de .env queda versionado',
    evaluar: () => {
      const gi = fs.readFileSync(rutaDe('.gitignore'), 'utf-8');
      const cubre = /^\.env$/m.test(gi) && /\.env\.backup/.test(gi);
      return cubre
        ? ok('.env y .env.backup-* ignorados')
        : falla('.gitignore no cubre los respaldos de .env');
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
    enunciado: 'La entidad que comprueba la guarda es la que usa el handler',
    evaluar: () => {
      const guarda = codigoDe('src/api/rest/middleware/auth.ts');
      const fuentesQueMira = /req\.entityId\s*\|\|\s*req\.params[^;]*\|\|\s*req\.body/.test(guarda);
      const miraQuery = /requireEntityAccess[\s\S]{0,600}req\.query/.test(guarda);
      if (!fuentesQueMira) {
        return noEvaluable('la guarda ya no tiene la forma que este criterio sabe leer');
      }
      if (miraQuery) return ok('la guarda cubre también la cadena de consulta');

      // LAS TRES FUENTES DE LA GUARDA SON UNA SOLA.
      //
      // `authenticate` SIEMPRE puebla req.entityId con el encabezado
      // x-entity-id (auth.ts), y un usuario sin entidades accesibles ni
      // siquiera puede iniciar sesión. Así que en
      // `req.entityId || req.params.entity_id || req.body?.entity_id`
      // el primer término nunca es falsy y los otros dos son código muerto:
      // la guarda comprueba EL ENCABEZADO y nada más.
      //
      // De ahí que un handler que derive su entidad de cualquier otro sitio
      // trabaje sobre una entidad que nadie miró. Basta un encabezado con una
      // entidad propia —que la guarda aprueba— y un ?entity_id= o un
      // entity_id en el cuerpo con una ajena del MISMO inquilino, que es
      // justo el cruce que RLS no puede ver.
      //
      // Se persiguen las dos fuentes por separado porque no pesan igual: la
      // query aparece en listados y reportes (lectura), y el cuerpo aparece en
      // el cierre suave y el cierre duro de un periodo fiscal (ESCRITURA).
      const rutas = 'src/api/rest/routes';
      // \b antes de entity_id en las tres alternativas, y no es cosmética:
      // sin él, `const { matched_entity_id, monto } = req.body` de
      // bank-reconciliation.ts se contaba como una entidad derivada del cuerpo.
      // Una acusación falsa en este criterio vale por diez ciertas, porque es
      // la que hace que se deje de leer.
      const deriva = (texto: string, fuente: 'query' | 'body'): boolean =>
        new RegExp(
          `\\bentity_id[^;\n]*=\\s*req\\.${fuente}|req\\.${fuente}\\.entity_id\\b|` +
            `\\{[^}]*\\bentity_id\\b[^}]*\\}\\s*=\\s*req\\.${fuente}`
        ).test(texto);

      const analizadas = fuentes(rutas).map((f) => ({
        nombre: path.basename(f),
        texto: sinComentarios(fs.readFileSync(f, 'utf-8')),
      }));
      const porQuery = analizadas.filter((a) => deriva(a.texto, 'query')).map((a) => a.nombre);
      const porCuerpo = analizadas.filter((a) => deriva(a.texto, 'body')).map((a) => a.nombre);

      if (porQuery.length === 0 && porCuerpo.length === 0) {
        return ok('ningún handler deriva su entidad de una fuente que la guarda no mira');
      }
      const partes: string[] = [];
      if (porQuery.length) partes.push(`${porQuery.length} por ?entity_id= (${porQuery.join(', ')})`);
      if (porCuerpo.length) {
        partes.push(`${porCuerpo.length} por entity_id del cuerpo (${porCuerpo.join(', ')}), donde hay ESCRITURAS`);
      }
      return falla(
        `la guarda sólo comprueba el encabezado —sus ramas de params y cuerpo son código muerto— y ` +
          `los handlers derivan su entidad de otro sitio: ${partes.join('; ')}. ` +
          'Una entidad ajena del mismo inquilino no la revisa nadie, y RLS no ve ese cruce'
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
    enunciado: 'Un rol que el CLI reparte significa lo mismo en la API',
    evaluar: () => {
      const nombres = (rel: string): string[] => {
        const texto = codigoDe(rel);
        const i = texto.indexOf('export const ROLES');
        if (i < 0) return [];
        const abre = texto.indexOf('{', i);
        const bloque = texto.slice(abre, texto.indexOf('\n};', abre));
        return [...bloque.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
      };
      const cli = nombres('src/cli/init/s2-users.ts');
      const api = nombres('src/api/rest/middleware/auth.ts');
      if (cli.length === 0 || api.length === 0) {
        return noEvaluable('no se pudo leer alguno de los dos catálogos de roles');
      }
      const desconocidos = cli.filter((r) => !api.includes(r));
      return desconocidos.length === 0
        ? ok(`los ${cli.length} roles del CLI existen en la API`)
        : falla(
            `el CLI reparte roles que la API no conoce (${desconocidos.join(', ')}): ` +
              `un usuario creado con ellos llega a HTTP sin los permisos que se le prometieron`
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
