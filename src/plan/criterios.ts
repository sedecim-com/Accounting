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
  {
    paquete: 'E0.0',
    enunciado: 'Un flujo no se declara cerrado sin su auditoría adversarial registrada',
    evaluar: () => {
      // S1: la regla «la auditoría adversarial cierra cada tramo» era
      // disciplina sin compuerta — AUD-5/AUD-6 existieron como práctica, pero
      // nada impedía declarar cerrado un F0x sin auditarlo. Cerrar un flujo
      // es AÑADIR su entrada aquí, con la ruta de su registro; una entrada
      // cuyo archivo no existe se acusa. El piso de la práctica queda
      // registrado: la auditoría integral del 2026-08-31.
      const FLUJOS_CERRADOS: Record<string, string> = {
        // 'F01': 'docs/auditorias/F01.md',
      };
      if (!existe('docs/auditorias/2026-08-31-integral/README.md')) {
        return falla('el registro de auditorías desapareció: docs/auditorias/2026-08-31-integral');
      }
      const sinRegistro = Object.entries(FLUJOS_CERRADOS).filter(([, doc]) => !existe(doc));
      return sinRegistro.length === 0
        ? ok(
            `${Object.keys(FLUJOS_CERRADOS).length} flujo(s) cerrados con registro; ` +
              'la integral 2026-08-31 en el archivo'
          )
        : falla(
            `flujo(s) declarados cerrados sin registro de auditoría: ${sinRegistro
              .map(([f]) => f)
              .join(', ')}`
          );
    },
  },

  // ---- E0.1 · Red de pruebas ----
  {
    paquete: 'E0.2',
    enunciado: 'Toda tabla muerta está enterrada o reclamada con nombre y dueño',
    evaluar: () => {
      // El censo de AUD-6 encontró siete tablas sin un solo escritor NI
      // lector, y S0.4 demostró el riesgo: capacidad muerta que sobrevive es
      // la que alguien cablea sin contexto. La 038 enterró seis; lo que se
      // conserva muerto tiene que estar RECLAMADO — una promesa con dueño
      // (el flujo que lo va a poblar) — o este criterio lo acusa. Y una
      // entrada reclamada cuya tabla gane escritor sobra: se reporta para
      // borrarla, como la línea base del auditor.
      const RECLAMADAS: Record<string, string> = {
        asset_categories: 'F06/DEP-2: el alta de activo la necesita (fixed_assets.category_id NOT NULL)',
            inventory_items: 'familia inventario: el esquema es el diseñado; el motor es neto nuevo (S0.4)',
        inventory_layers: 'familia inventario: capas de costeo',
        inventory_layer_consumption: 'familia inventario: consumo de capas',
        scheduled_payments: 'F04: la programación de pagos retirada con 501 escribe aquí cuando exista',
      };
      const dirMigraciones = 'src/database/migrations';
      const sql = fs
        .readdirSync(rutaDe(dirMigraciones))
        .map((m) => fs.readFileSync(rutaDe(dirMigraciones, m), 'utf-8'))
        .join('\n');
      const creadas = new Set(
        [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi)].map((m) => m[1])
      );
      const enterradas = new Set(
        [...sql.matchAll(/DROP\s+TABLE\s+IF\s+EXISTS\s+(?:public\.)?(\w+)/gi)].map((m) => m[1])
      );
      const problemas: string[] = [];
      for (const t of creadas) {
        if (enterradas.has(t)) continue;
        // «Muerta» = ni una mención en el código. Un lector sin escritor es
        // otra clase de defecto (lo mide el criterio de la salida de nómina).
        const mencionada = dondeAparece(new RegExp(`\\b${t}\\b`), ['src'], true).length > 0;
        const sembrada = new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?${t}\\b`, 'i').test(sql);
        if (mencionada || sembrada) {
          if (RECLAMADAS[t]) {
            problemas.push(`${t}: reclamada pero ya tiene uso — borra su entrada de RECLAMADAS`);
          }
          continue;
        }
        if (!RECLAMADAS[t]) {
          problemas.push(`${t}: muerta sin reclamo — entiérrala en una migración o reclámala con dueño`);
        }
      }
      return problemas.length === 0
        ? ok(`${Object.keys(RECLAMADAS).length} tablas reclamadas con dueño; el resto o vive o está enterrado`)
        : falla(problemas.join('; '));
    },
  },
  {
    paquete: 'E0.2',
    enunciado: 'Ejecutar una migración y registrarla son un solo acto',
    evaluar: () => {
      // migrate.ts corría el .sql y lo anotaba en public.migrations en DOS
      // transacciones implícitas: un fallo entre ambas dejaba la migración
      // aplicada y sin registrar, y la corrida siguiente la re-ejecutaba —
      // incluidos sus rellenos de datos. Prescriptivo sobre el instrumento,
      // que es el caso en que un criterio puede nombrar el archivo.
      const s = codigoDe('src/database/migrate.ts');
      const transaccional =
        /BEGIN/.test(s) && /ROLLBACK/.test(s) && /INSERT INTO public\.migrations/.test(s);
      if (!transaccional) {
        return falla('migrate.ts no envuelve ejecutar+registrar en una transacción: un fallo entre ambas re-ejecuta la migración en la siguiente corrida');
      }
      // Y el endurecimiento de RLS corre aunque una migración falle: vivía
      // dentro del try y un fallo a mitad dejaba las tablas ya creadas sin
      // política — la fuga silenciosa que el propio bloque dice impedir.
      const finallyIdx = s.indexOf('finally');
      const rlsIdx = s.indexOf('rls-policies.sql');
      return finallyIdx >= 0 && rlsIdx > finallyIdx
        ? ok('transaccional, y el endurecimiento corre pase lo que pase')
        : falla('rls-policies.sql no corre en el finally: un fallo a mitad deja tablas sin política');
    },
  },

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
  {
    paquete: 'E0.1',
    enunciado: 'El compromiso no persiste el valor que promete ocultar',
    evaluar: () => {
      // S1 (E1.4-a rescatada): el range proof placeholder incluía
      // _test_value y _test_bf bajo el comentario «DO NOT store the value in
      // a real proof», y el orquestador lo persistía entero — el compromiso
      // que vende «prueba el rango SIN revelar el importe» llevaba dentro el
      // importe y el factor para abrirlo. El generador ya no las escribe y
      // la 040 purgó las filas; esto vigila que no vuelvan.
      const fuga = dondeAparece(/_test_value|_test_bf/, ['src'], true);
      if (fuga.length > 0) {
        return falla(`el valor volvió al blob del compromiso: ${fuga.join(', ')}`);
      }
      if (!existe('src/database/migrations/040_el_secreto_que_el_compromiso_revelaba.sql')) {
        return falla('la migración de purga (040) desapareció: las filas históricas retendrían la fuga');
      }
      const purga = fs.readFileSync(
        rutaDe('src/database/migrations/040_el_secreto_que_el_compromiso_revelaba.sql'),
        'utf-8'
      );
      return /range_proof\s*=\s*NULL/.test(purga) && /zkverify_proof\s*=\s*NULL/.test(purga)
        ? ok('el generador no escribe el valor y la 040 purgó ambos blobs')
        : falla('la 040 no purga los dos blobs (range_proof y zkverify_proof)');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'Un asiento posteado no admite UPDATE ni DELETE fuera de su lista blanca',
    evaluar: () => {
      // R1: la 033 blindó la bitácora y el mayor —lo que la bitácora
      // protege— seguía físicamente reescribible: un UPDATE balanceado sobre
      // una línea posteada no viola ningún CHECK y desalinea los saldos sin
      // rastro. La 041 pone el disparador condicional (lista blanca de
      // metadatos por resta de JSONB: una columna nueva nace protegida) en
      // las DOS tablas, más el candado de TRUNCATE.
      const m = 'src/database/migrations/041_el_mayor_inviolable.sql';
      if (!existe(m)) return falla('la 041 desapareció: el mayor vuelve a ser reescribible');
      const sql = fs.readFileSync(rutaDe(m), 'utf-8');
      const checks: Array<[boolean, string]> = [
        [/ON journal_entries\b[\s\S]{0,80}FOR EACH ROW/.test(sql) || /BEFORE UPDATE OR DELETE ON journal_entries/.test(sql), 'falta el disparador de journal_entries'],
        [/BEFORE UPDATE OR DELETE ON journal_entry_lines/.test(sql), 'falta el disparador de journal_entry_lines'],
        [(sql.match(/to_jsonb\(NEW\)\s*-\s*permitidas/g) ?? []).length >= 2, 'la comparación por resta de JSONB falta en alguna de las DOS funciones: una columna nueva nacería expuesta (la primera mutación de este criterio se escapó por contar una sola)'],
        [/BEFORE TRUNCATE ON journal_entries/.test(sql) && /BEFORE TRUNCATE ON journal_entry_lines/.test(sql), 'falta el candado de TRUNCATE'],
        [(sql.match(/RAISE EXCEPTION/g) ?? []).length >= 3, 'los disparadores no rechazan'],
      ];
      const roto = checks.find(([pasa]) => !pasa);
      return roto ? falla(roto[1]) : ok('el mayor posteado sólo admite su lista blanca de metadatos, en las dos tablas');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'Los saldos materializados se verifican contra las líneas, y la deriva es fail',
    evaluar: () => {
      // R1: account_balances es tabla load-bearing del cierre y nada la
      // comprobaba contra Σ de líneas posteadas; doctor la vigila y —a
      // diferencia de la capacidad huérfana, informativa a propósito— aquí
      // fallar es 'fail': un mayor que no cuadra con sus líneas no opera.
      const d = codigoDe('src/ai/doctor-service.ts');
      if (!/checkLedgerIntegrity/.test(d)) {
        return falla('doctor perdió el chequeo de integridad del mayor');
      }
      const i = d.indexOf('function checkLedgerIntegrity');
      const cuerpo = d.slice(i, i + 3500);
      if (!/FULL OUTER JOIN/i.test(cuerpo) || !/status\s*=\s*'posted'/.test(cuerpo)) {
        return falla('el chequeo no compara account_balances contra Σ de líneas POSTEADAS por ambos lados');
      }
      if (!/level:\s*'fail'/.test(cuerpo)) {
        return falla('la deriva del mayor quedó degradada a warn: un número falso con aspecto de número');
      }
      return /checks\.push\(await checkLedgerIntegrity\(\)\)/.test(d)
        ? ok('doctor verifica saldos = Σ líneas y posteados con rastro, y la deriva es fail')
        : falla('el chequeo existe y runDoctor no lo corre');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'El posteo y el cierre no se cruzan: el candado del periodo vive en ambas transacciones',
    evaluar: () => {
      // R1 (TOCTOU): la validación leía el periodo FUERA de la transacción
      // del posteo, y el checklist del cierre suave se fotografiaba FUERA de
      // la suya — un posteo en vuelo podía aterrizar en un periodo que
      // cerraba, con un checklist que no lo contaba. FOR SHARE (posteo) ×
      // FOR UPDATE (cierre) sobre la misma fila cierran la carrera.
      const p = codigoDe('src/services/accounting/posting.ts');
      const consumos = (p.match(/bloquearPeriodoParaPostear\(client/g) ?? []).length;
      if (!/FOR SHARE/.test(p) || consumos < 2) {
        return falla(
          `el posteo no toma el candado compartido del periodo en sus dos transacciones (consumos: ${consumos})`
        );
      }
      const c = codigoDe('src/services/accounting/period-close.ts');
      return /FOR UPDATE/.test(c) && /getPeriodCloseStatus\(periodId,\s*entityId,\s*client\)/.test(c)
        ? ok('FOR SHARE en el posteo (×2) y checklist bajo FOR UPDATE en el cierre suave')
        : falla('el cierre suave volvió a fotografiar el checklist fuera de su transacción');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'Ningún posteo paga el refresco de las vistas de reporte de todos',
    evaluar: () => {
      // R3 (decidido en el plan de cierre, ejecutado aquí): el trigger de la
      // 004 refrescaba DOS vistas globales —cross-join de todos los
      // inquilinos— dentro de cada transacción de posteo, serializando
      // posteos de inquilinos distintos entre sí. El orden de migraciones es
      // la verdad: el último acto sobre el trigger debe ser el DROP, y el
      // camino de reemplazo (refresh_reporting_views + report view sync +
      // detector de deriva) debe seguir vivo.
      const dir = 'src/database/migrations';
      const sql = fs
        .readdirSync(rutaDe(dir))
        .sort()
        .map((m) => fs.readFileSync(rutaDe(dir, m), 'utf-8'))
        .join('\n');
      const ultimaCreacion = sql.lastIndexOf('CREATE TRIGGER trg_refresh_materialized_views');
      const ultimoDrop = sql.lastIndexOf('DROP TRIGGER IF EXISTS trg_refresh_materialized_views');
      if (ultimoDrop < 0 || ultimoDrop < ultimaCreacion) {
        return falla(
          'el trigger de refresco sigue vivo al final de la cadena de migraciones: cada posteo vuelve a pagar el reporte de todos'
        );
      }
      if (!/refresh_reporting_views/.test(sql)) {
        return falla('el refresco callable (031) desapareció: no queda camino de refresco');
      }
      return /refreshReportingViews/.test(codigoDe('src/cli/report-command.ts'))
        ? ok('el trigger cayó (042) y el refresco vive en el callable + report view sync + detector de deriva')
        : falla('el comando de refresco desapareció: las vistas sólo se refrescarían a mano por SQL');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'La serie del folio la fija la fecha del documento, no el reloj',
    evaluar: () => {
      // R3: «JE-2026-00042» insinuaba serie anual y el año lo ponía el
      // reloj, con un contador que jamás se reiniciaba — un asiento de
      // diciembre capturado en enero salía en la serie del año nuevo
      // continuando la cuenta del viejo. Decidido ANTES del primer cruce de
      // ejercicio con datos reales.
      const s = codigoDe('src/utils/sequence.ts');
      // El tramo de nextEntityNumber en concreto: la firma de añoDeDocumento
      // también dice `fecha: Date | string` y dio verde a la mutación que
      // volvía opcional la fecha del folio — anclar al símbolo equivocado es
      // el primo del regex que casa el import.
      const iNext = s.indexOf('export async function nextEntityNumber');
      const tramoNext = iNext >= 0 ? s.slice(iNext, s.indexOf('export', iNext + 10)) : '';
      if (!/fecha:\s*Date \| string/.test(tramoNext)) {
        return falla('nextEntityNumber ya no exige la fecha del documento: el reloj vuelve a foliar');
      }
      if (!/\$\{name\}_\$\{año\}/.test(s)) {
        return falla('la llave del contador perdió el año: la serie vuelve a ser una sola cuenta eterna');
      }
      if (!/^\s*const m = \/\^\(\\d\{4\}\)-\\d\{2\}-\\d\{2\}\/\.exec/m.test(s) && !/exec\(String\(fecha\)/.test(s)) {
        return falla('añoDeDocumento dejó de leer la cadena sin pasar por Date: el 31-dic retrocede de año al oeste de Greenwich');
      }
      const m = 'src/database/migrations/043_la_serie_del_folio_por_ejercicio.sql';
      if (!existe(m)) return falla('la 043 desapareció: los contadores anuales arrancarían en 1 y colisionarían con lo emitido');
      const siembra = fs.readFileSync(rutaDe(m), 'utf-8');
      const inserts = (siembra.match(/INSERT INTO entity_sequences/g) ?? []).length;
      return inserts >= 5 && /GREATEST/.test(siembra)
        ? ok('la fecha del documento fija año y contador (llave anual), con la siembra desde los folios reales')
        : falla(`la siembra de la 043 no cubre las cinco series (${inserts}) o perdió el GREATEST`);
    },
  },

  {
    paquete: 'E0.1',
    enunciado: 'El refresco de las materializadas ve el clúster entero, no el inquilino de la sesión',
    evaluar: () => {
      // R3, medido por el detector de deriva: con las 'm' reasignadas a
      // mnemosine_owner (NOBYPASSRLS, RLS forzada), REFRESH corría la
      // consulta definitoria con los lentes del inquilino casual de la
      // sesión — refresh_reporting_views() devolvía «hecho» y dejaba la
      // vista global VACÍA. El dueño de régimen de una materializada es
      // mnemosine_refresher: NOLOGIN (nadie se conecta con él) y BYPASSRLS
      // (el refresco ve a todos, que es su única función). Las planas
      // siguen con el operador: ésas SÍ re-corren su consulta al leerse.
      const prov = codigoDe('scripts/provision-roles.sql');
      const lineaRol = /CREATE ROLE mnemosine_refresher[^;]*;/.exec(prov)?.[0] ?? '';
      // (?<!NO)BYPASSRLS: «NOBYPASSRLS» contiene «BYPASSRLS» y un regex
      // ingenuo daría verde al mutante que apaga el bypass.
      if (!/NOLOGIN/.test(lineaRol) || !/(?<!NO)BYPASSRLS/.test(lineaRol)) {
        return falla('mnemosine_refresher perdió NOLOGIN o BYPASSRLS: el refresco vuelve a mirar por los lentes de un inquilino');
      }
      if (!/GRANT mnemosine_refresher TO mnemosine_owner/.test(prov)) {
        return falla('sin la membresía, refresh_reporting_views() (definer del operador) no pasa el chequeo de propiedad del REFRESH');
      }
      const pol = codigoDe('src/database/rls-policies.sql');
      if (!/'m' THEN 'mnemosine_refresher'/.test(pol) || !/ELSE 'mnemosine_owner'/.test(pol)) {
        return falla('el reconciliador dejó de repartir dueños por tipo: o la materializada refresca filtrada o la plana vuelve a leer sin RLS');
      }
      const ver = codigoDe('scripts/verify-isolation.sh');
      if (!/relkind = 'm'/.test(ver) || !/<> 'mnemosine_refresher'/.test(ver)) {
        return falla('verify-isolation dejó de comprobar el dueño de las materializadas');
      }
      return /CREATE ROLE mnemosine_refresher/.test(codigoDe('tests/integration/global-setup.ts'))
        ? ok('las «m» son del refresher (NOLOGIN+BYPASSRLS), las «v» del operador, y CI lo prueba de punta a punta')
        : falla('la base efímera de integración nace sin refresher: la suite dejaría de probar el refresco real');
    },
  },

  {
    paquete: 'E0.1',
    enunciado: 'El maker-checker vive en el panel y muerde solo la póliza manual',
    evaluar: () => {
      // F01: la decisión §5 no se difirió tácitamente ni se decidió en
      // código — es política del panel (segregacion_de_funciones) con
      // default off, y su lector está DENTRO del motor de posteo: con
      // 'exigir', quien creó el borrador MANUAL no lo postea. Las pólizas
      // del sistema (source_type no nulo: nómina, ai_draft, reversas)
      // quedan exentas por construcción — ahí creador=posteador es
      // intencional y exigir separación produciría falsos positivos.
      const panel = codigoDe('src/services/policy/pending-catalog.ts');
      if (!/key: 'segregacion_de_funciones'/.test(panel) || !/'exigir'/.test(panel)) {
        return falla('la clave segregacion_de_funciones salió del panel: la decisión §5 vuelve a estar diferida tácitamente');
      }
      const p = codigoDe('src/services/accounting/posting.ts');
      const iPost = p.indexOf('export async function postJournalEntry');
      const tramo = iPost >= 0 ? p.slice(iPost, p.indexOf('export', iPost + 10)) : '';
      if (!/!entry\.source_type && entry\.created_by === userId/.test(tramo)) {
        return falla('la compuerta perdió su forma (manual + coincidencia): o muerde a nómina/reversas o dejó de morder');
      }
      if (!/politica\.value === 'exigir'/.test(tramo) || !/SOD_QUIEN_CREA_NO_POSTEA/.test(tramo)) {
        return falla('el lector dejó de comparar contra el literal exigir o perdió su código de dominio');
      }
      if (!/'SOD_QUIEN_CREA_NO_POSTEA'/.test(codigoDe('src/cli/entry-command.ts'))) {
        return falla('el rechazo SoD dejó de salir como BLOQUEADO (5): se leería como entrada inválida');
      }
      // El huérfano pagado: checkSoDViolations con LLAMADA real en doctor
      // (composición de permisos), y el check enchufado a runDoctor.
      // El push, no el nombre: la FIRMA de checkPermisosEnConflicto() también
      // casa `nombre()` — cuarta aparición del regex que muerde el símbolo
      // equivocado en esta serie de sprints.
      const doctor = codigoDe('src/ai/doctor-service.ts');
      return /checkSoDViolations\(permisos\)/.test(doctor) &&
        /checks\.push\(await checkPermisosEnConflicto\(\)\)/.test(doctor)
        ? ok('panel + lector en el motor (solo manual), salida bloqueada, y la composición de permisos vigilada en doctor')
        : falla('checkSoDViolations volvió a quedarse sin consumidor o el check salió de runDoctor');
    },
  },

  {
    paquete: 'E0.1',
    enunciado: 'El espejo del CFDI es por entidad y el estatus SAT dice la verdad',
    evaluar: () => {
      // F02: la unicidad fiscal era GLOBAL (005) y mataba el caso normal de
      // un despacho — las dos partes de la operación como clientes, el mismo
      // XML entrando como 'emitido' y como 'recibido'. Y el estatus SAT era
      // un «Vigente» simulado: un CFDI cancelado se clasificaba vigente. La
      // 046 vuelve la unicidad (entity_id, cfdi_uuid) — y respalda xml_hash
      // en esquema —, el dedupe filtra por entidad en sus DOS sitios, y el
      // estatus sale del ConsultaCFDIService real (público y anónimo:
      // ningún bloqueo de E3.x le aplicó jamás), con apagado que LO DICE.
      const m = 'src/database/migrations/046_el_espejo_del_cfdi.sql';
      if (!existe(m)) return falla('la 046 desapareció: la unicidad fiscal vuelve a ser global');
      const sql = fs.readFileSync(rutaDe(m), 'utf-8');
      if (!/DROP CONSTRAINT xml_documents_cfdi_uuid_key/.test(sql) ||
          // \b tras el nombre: un sufijo _x seguiría casando el regex desnudo
          // — quinta variante de la familia del ancla en estos sprints.
          !/uq_xml_documents_entity_cfdi\b[\s\S]{0,80}\(entity_id, cfdi_uuid\)/.test(sql) ||
          !/uq_xml_documents_entity_hash\b[\s\S]{0,80}\(entity_id, xml_hash\)/.test(sql)) {
        return falla('la 046 perdió una de sus tres piezas (drop global, unique uuid, unique hash)');
      }
      const dedupe = /WHERE entity_id = \$1 AND \(cfdi_uuid = \$2 OR xml_hash = \$3\)/;
      if (!dedupe.test(codigoDe('src/services/xml-ingestion/pre-registration-service.ts'))) {
        return falla('el dedupe del registro dejó de filtrar por entidad: el espejo vuelve a chocar');
      }
      const ingest = codigoDe('src/ai/ingest-service.ts');
      const iPrev = ingest.indexOf('export async function previewCfdiFiles');
      const tramoPrev = iPrev >= 0 ? ingest.slice(iPrev, iPrev + 2500) : '';
      if (!/entityId: string/.test(tramoPrev) || !dedupe.test(tramoPrev)) {
        return falla('previewCfdiFiles perdió la entidad: su veredicto de duplicado sería mentira');
      }
      const stub = codigoDe('src/services/xml-ingestion/sat-validation.ts');
      if (/'Vigente'/.test(stub)) {
        return falla('sat-validation volvió a fabricar un Vigente: un cancelado se clasificaría vigente');
      }
      if (!/consultaCfdi\(/.test(stub)) {
        return falla('sat-validation dejó de delegar en el cliente real');
      }
      const cliente = codigoDe('src/services/sat/cfdi-status.ts');
      return /IConsultaCFDIService\/Consulta/.test(cliente) &&
        /toFixed\(6\)/.test(cliente) && /'DISABLED'/.test(cliente)
        ? ok('unicidad (entidad, uuid) con hash respaldado, dedupe escopado en los dos sitios, y el SOAP real con apagado honesto')
        : falla('el cliente SAT perdió el sobre, el relleno del total o el apagado que lo dice');
    },
  },

  {
    paquete: 'E0.2',
    enunciado: 'La capacidad huérfana conocida sólo encoge',
    evaluar: () => {
      // S1: §7 prometía «doctor sin huérfanos nuevos entra como criterio» y
      // el criterio no existía — mientras tanto, cuatro exports vivían sin un
      // solo llamador de producción, incluido uno en la capa más delicada
      // (autoApproveDraftByPolicy, con docstring que afirmaba en falso ser el
      // camino de la ingesta). El patrón es la línea base del auditor: la
      // lista CONGELA los huérfanos conocidos y sólo puede encoger — un
      // export que gana consumidor obliga a borrar su línea, y borrar la
      // línea es el registro de que la deuda se pagó (o el export se retiró).
      //
      // Los huérfanos NUEVOS los barre doctor a nivel capacidad (nunca fail);
      // esta lista fija los conocidos para que cerrarlos sea visible y
      // olvidarlos imposible. Destinos: earlyPaymentDiscount → F04;
      // calculateBenefitsForPaycheck → F08; checkSoDViolations → decisión §5
      // (maker-checker); autoApproveDraftByPolicy → A3 (un solo autorizador).
      const HUERFANOS_CONGELADOS: Record<string, string> = {
        earlyPaymentDiscount: 'bill-service.ts',
        calculateBenefitsForPaycheck: 'benefits-service.ts',
              autoApproveDraftByPolicy: 'draft-service.ts',
      };
      const conConsumidor = Object.entries(HUERFANOS_CONGELADOS)
        .filter(([simbolo, archivo]) => consumidoresDe(simbolo, archivo).length > 0)
        .map(([simbolo]) => simbolo);
      return conConsumidor.length === 0
        ? ok(`${Object.keys(HUERFANOS_CONGELADOS).length} huérfanos congelados, ninguno resuelto aún`)
        : falla(
            `ya tienen consumidor — borra su línea de HUERFANOS_CONGELADOS: ${conConsumidor.join(', ')}`
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
      // excepción — Y que rechace SIEMPRE: desde la 041 (R1) existe una
      // segunda clase de protección, la inmutabilidad CONDICIONAL del mayor
      // (rechaza lo posteado, deja pasar el resto con RETURN NEW). Esa clase
      // NO es una bitácora de sólo-agregar y no debe entrar a los arrays
      // append_only, que le revocarían el UPDATE que el posteo necesita. El
      // discriminador es estructural: una función de sólo-agregar no tiene
      // ningún camino que devuelva NEW.
      const rechaza = (fn: string): boolean => {
        const i = new RegExp(
          `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?"?${fn}"?`,
          'i'
        ).exec(sql);
        if (i === null) return false;
        const cuerpo = sql.slice(i.index, i.index + 2000);
        return /RAISE\s+EXCEPTION/i.test(cuerpo) && !/RETURN\s+NEW/i.test(cuerpo);
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
  {
    paquete: 'E0.3',
    enunciado: 'La bitácora no guarda en claro lo que las tablas cifran',
    evaluar: () => {
      // S1: el middleware de auditoría escribía JSON.stringify(req.body)
      // entero en audit_log.new_values — un alta de empleado dejaba ssn y
      // bank_account EN CLARO en la única tabla que, por diseño de la 033,
      // no admite remediación. Lo que se exige: el stringify crudo no existe
      // y la redacción cubre, como mínimo, los campos que los servicios
      // cifran hoy (ssn, clabe, bank_account*, password, key/cer).
      const m = codigoDe('src/api/rest/middleware/audit.ts');
      if (/JSON\.stringify\(req\.body\)/.test(m)) {
        return falla('el middleware volvió al stringify crudo: los secretos vuelven a la bitácora inmutable');
      }
      if (!/redactarSensibles/.test(m)) {
        return falla('no hay redacción en el middleware de auditoría');
      }
      const minimos = ['ssn', 'clabe', 'bank_account', 'password', 'key', 'cer'];
      const faltan = minimos.filter((c) => !new RegExp(`'${c}'`).test(m));
      return faltan.length === 0
        ? ok('el cuerpo se redacta antes de tocar la bitácora, con los campos cifrados cubiertos')
        : falla(`la lista de redacción no cubre: ${faltan.join(', ')} — un campo que se cifra en tabla no puede viajar en claro al rastro`);
    },
  },
  {
    paquete: 'E0.3',
    enunciado: 'Los ciclos de vida del dinero dejan su propio rastro, no sólo su asiento',
    evaluar: () => {
      // R1: emitir/anular una factura, aprobar la del proveedor y registrar
      // un pago sólo auditaban su asiento derivado — «quién emitió» o «quién
      // registró el pago» no estaba en ninguna parte. Los tres servicios
      // escriben registrarAuditoria DENTRO de sus transacciones existentes.
      const consumidores = consumidoresDe('registrarAuditoria', 'audit-log.ts');
      const exigidos = [
        'src/services/ar/invoice-service.ts',
        'src/services/ap/bill-service.ts',
        'src/services/payments/payment-service.ts',
      ];
      const faltan = exigidos.filter((f) => !consumidores.includes(f));
      return faltan.length === 0
        ? ok(`el rastro cubre los ciclos de vida (${consumidores.length} escritores en total)`)
        : falla(`ciclos de vida sin rastro propio: ${faltan.join(', ')}`);
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

  {
    paquete: 'E1.2',
    enunciado: 'El cerebro fiscal deja el rastro que prometió',
    evaluar: () => {
      // ROJO HONESTO NUEVO. E1.2 figura cerrado porque sus criterios miden la
      // decisión (PUE/PPD, las cuentas puente) — y esa parte es real. Pero la
      // salida prometida «queda rastro en cfdi_classifications» no ocurrió
      // jamás: la tabla existe desde la migración 015 y tiene CERO menciones
      // en src. Una clasificación que no se persiste no se puede auditar ni
      // reprocesar, y la fila del catálogo que la exige no se puede construir
      // encima de nada. F02 decide: escribirla o retirar la tabla — y este
      // criterio cambia con esa decisión, no antes.
      const escritor = dondeAparece(/INSERT\s+INTO\s+cfdi_classifications\b/i, ['src'], true);
      return escritor.length > 0
        ? ok(`el rastro se escribe desde ${escritor.join(', ')}`)
        : falla(
            'cfdi_classifications: creada en la migración 015, prometida como rastro del ' +
              'clasificador, y con cero menciones en src — la clasificación no se persiste'
          );
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

      // Y «leída» significa DENTRO de una llamada a un lector, no que la
      // cadena aparezca en alguna parte. El falso verde que esto corrige:
      // `cfdi_periodo_cerrado` contaba como consumida porque su nombre
      // aparece como etiqueta `topic` de una decisión del clasificador — que
      // además nunca aplica—, no porque nadie llame a getPolicy con ella. Una
      // coincidencia de cadena no es un consumidor, igual que un re-export de
      // barril no es un puente.
      const huerfanas = claves.filter(
        (k) =>
          dondeAparece(
            new RegExp(`getPolicy(Number)?\\s*\\([\\s\\S]{0,120}?['\`"]${k}['\`"]`),
            ['src'],
            true
          ).filter(ajeno).length === 0
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
      // «email service» no estaba en la lista y por eso el TODO de
      // POST /invoices/:id/send —que respondía sent:true sin transmitir
      // nada— pasó este criterio durante meses. La lección es la de siempre:
      // un detector de clases enumeradas sólo ve las clases que enumeró.
      const sospechosos = dondeAparece(
        /TODO:[^\n]*(PAC|SAT|IRS|SSA|IMSS|enviar|send|email|correo|transmit|integrate)/i
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
  {
    paquete: 'E2.1',
    enunciado: 'El arranque falla cerrado ante un rol que ignora RLS',
    evaluar: () => {
      // S1 (E2.1-e rescatada): el aislamiento entero cuelga de que el rol de
      // conexión esté SUJETO a RLS, y detectarlo era un logger.warn — también
      // en producción. Un aviso que nadie lee no es una defensa. Ahora, en
      // producción, un rol con BYPASSRLS/superusuario impide arrancar salvo
      // la válvula explícita ALLOW_RLS_BYPASS_ROLE (break-glass que queda
      // escrito). En desarrollo sigue siendo warn: la suite de integración
      // corre como superusuario a propósito.
      if (!existe('src/database/rls-guard.ts')) {
        return falla('no existe el guardián del rol (src/database/rls-guard.ts): volvió a ser sólo un warn');
      }
      const g = codigoDe('src/database/rls-guard.ts');
      const lanza = /production/.test(g) && /throw new RolIgnoraRlsError/.test(g);
      const valvula = /ALLOW_RLS_BYPASS_ROLE/.test(g);
      const cableado = /verificarRolSujetoARls/.test(codigoDe('src/index.ts'));
      if (!lanza) return falla('el guardián no lanza en producción: el aislamiento vuelve a colgar de un log');
      if (!valvula) return falla('sin válvula de break-glass explícita, el guardián se puentea comentándolo');
      if (!cableado) return falla('el guardián existe y el arranque no lo llama');
      return ok('producción no arranca con un rol que ignora RLS, salvo break-glass explícito');
    },
  },
  {
    paquete: 'E2.1',
    enunciado: 'Las contrapartes y los webhooks por id llevan la frontera dentro del SQL',
    evaluar: () => {
      // R2: dentro de un inquilino multi-entidad, conocer el UUID bastaba
      // para leer o parchar contrapartes de OTRA entidad (customers/vendors
      // por id sin alcance), y el ciclo entero de webhooks (borrar,
      // re-disparar, historial) filtraba sólo por id. scope.ts existía
      // exactamente para esto y estos caminos no lo usaban.
      const cust = codigoDe('src/services/ar/customer-service.ts');
      const vend = codigoDe('src/services/ap/vendor-service.ts');
      const wh = codigoDe('src/services/webhooks/webhook-service.ts');
      // Forma de LLAMADA, no de import: un import huérfano dio verde en la
      // primera mutación de este criterio — la lección del barril de AUD-6.
      if (!/findByIdInScope[<(]/.test(cust) || !/condicionDeAlcance\(/.test(cust)) {
        return falla('customer-service volvió al id sin frontera (lectura o UPDATE de un viaje)');
      }
      if (!/ByIdInScope[<(]/.test(vend)) {
        return falla('vendor-service volvió al id sin frontera');
      }
      const whChecks: Array<[RegExp, string]> = [
        [/DELETE FROM webhook_subscriptions WHERE id = \$1 AND tenant_id = \$2/, 'borrar un webhook'],
        [/JOIN webhook_subscriptions s ON s\.id = d\.webhook_id\s+WHERE d\.id = \$1 AND s\.tenant_id = \$2/, 're-disparar una entrega'],
        [/WHERE d\.webhook_id = \$1 AND s\.tenant_id = \$2/, 'el historial de entregas'],
      ];
      const roto = whChecks.find(([re]) => !re.test(wh));
      return roto
        ? falla(`webhook-service perdió la frontera de inquilino en: ${roto[1]}`)
        : ok('customers/vendors por scope.ts y el ciclo de webhooks acotado por inquilino en el SQL');
    },
  },
  {
    paquete: 'E2.1',
    enunciado: 'Los webhooks salientes no alcanzan la red privada, firman contra el replay y no regalan su secreto',
    evaluar: () => {
      // R2: la URL de suscripción sólo pasaba un .url() de zod y el servidor
      // le hacía POST — SSRF hacia el metadata endpoint con las credenciales
      // del servidor; la firma cubría sólo el cuerpo (la cabecera de tiempo
      // viajaba sin firmar: replay libre); y el secreto salía ENTERO en cada
      // listado.
      if (!existe('src/services/webhooks/url-guard.ts')) {
        return falla('el guardián de URL desapareció: SSRF de libro con las credenciales del servidor');
      }
      const g = codigoDe('src/services/webhooks/url-guard.ts');
      if (!/a === 169 && b === 254/.test(g) || !/ipPrivada/.test(g)) {
        return falla('el guardián no conoce los rangos privados o el metadata endpoint');
      }
      const s = codigoDe('src/services/webhooks/webhook-service.ts');
      if (!/assertUrlDeWebhook\(url\)/.test(s)) {
        return falla('crear una suscripción ya no valida la URL');
      }
      if (!/assertDestinoPublico\(subscription\.url\)/.test(s)) {
        return falla('la entrega ya no resuelve y verifica el destino: un dominio público que apunte adentro se entrega');
      }
      if (!/t=\$\{timestamp\},v1=/.test(s)) {
        return falla('la firma dejó de cubrir el timestamp: el receptor no puede rechazar un replay por firma');
      }
      return /SELECT id, tenant_id, url, events/.test(s) && !/SELECT \* FROM webhook_subscriptions WHERE tenant_id/.test(s)
        ? ok('URL vigilada dos veces, firma t=…,v1=… y el secreto sólo en el 201')
        : falla('el listado volvió al asterisco: el secreto viaja en cada GET');
    },
  },
  {
    paquete: 'E2.1',
    enunciado: 'La verificación pública tiene camino sancionado, no un empujón al rol que ignora RLS',
    evaluar: () => {
      // R2: /public/v1 corre sin contexto de inquilino y bajo RLS forzada
      // eso era cero filas — el feature sólo podía funcionar conectando el
      // proceso con un rol que ignora RLS, exactamente el despliegue que el
      // guardián de arranque impide. El camino sancionado: mnemosine_verifier
      // (provision-roles) + políticas propias (rls-policies, reconciliadas
      // tras cada migración) + SET LOCAL ROLE por transacción.
      if (!existe('src/database/consulta-publica.ts')) {
        return falla('no existe consulta-publica.ts: el router público vuelve a consultar sin camino');
      }
      const cp = codigoDe('src/database/consulta-publica.ts');
      if (!/SET LOCAL ROLE mnemosine_verifier/.test(cp)) {
        return falla('la consulta pública no asume el rol verificador');
      }
      const router = codigoDe('src/api/rest/routes/public-verification.ts');
      if (/from '..\/..\/..\/database\/connection.js'/.test(router)) {
        return falla('el router público volvió a consultar por el pool directo, fuera del camino sancionado');
      }
      const politicas = fs.readFileSync(rutaDe('src/database/rls-policies.sql'), 'utf-8');
      const n = (politicas.match(/CREATE POLICY verificacion_publica/g) ?? []).length;
      if (n < 5) {
        return falla(`las políticas del verificador no cubren las cinco tablas (hay ${n})`);
      }
      if (!/GRANT SELECT \(id, name, entity_type/.test(politicas)) {
        return falla('legal_entities perdió el GRANT de columnas enumeradas: un SELECT * nuevo expondría en vez de tronar');
      }
      return /mnemosine_verifier/.test(fs.readFileSync(rutaDe('scripts/provision-roles.sql'), 'utf-8'))
        ? ok('rol verificador aprovisionado, políticas en el reconciliador y el router por SET LOCAL ROLE')
        : falla('provision-roles.sql no crea mnemosine_verifier: el camino existe sólo donde alguien lo creó a mano');
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
      // ROJO HONESTO (S1). La versión anterior de este criterio pasó VERDE
      // durante semanas porque su regex matcheaba dos cadenas de PROSA en una
      // pregunta de política (pending-catalog.ts: «direct SAT download …») —
      // la clase exacta de falso verde que AUD-6 purgó, cometida por el
      // propio instrumento. La descarga masiva NO existe: ni cliente SOAP
      // (SolicitaDescarga/VerificaSolicitud), ni lector de paquetes ZIP, ni
      // comando `sat download`, ni la reversa de facturas contabilizadas
      // cuyo CFDI el emisor canceló. Son ~11 tareas de motor (plan de
      // cierre E3.2), no «cargar una credencial».
      //
      // Verde exige el SERVICIO con transporte: un módulo bajo
      // src/services/sat-download/ que el camino de políticas no pueda
      // imitar con una cadena.
      if (!existe('src/services/sat-download')) {
        return falla(
          'la descarga masiva del SAT no existe (ni SOAP, ni ZIP, ni comando): el despacho no ' +
            'puede afirmar completitud, que es lo que vende. El criterio anterior pasaba por dos ' +
            'cadenas de prosa en pending-catalog.ts — este rojo es la corrección'
        );
      }
      if (!existe('src/services/sat-download/descarga-masiva.ts')) {
        return falla('src/services/sat-download existe pero sin descarga-masiva.ts (el motor)');
      }
      const motor = codigoDe('src/services/sat-download/descarga-masiva.ts');
      return /SolicitaDescarga/i.test(motor) && /Verifica/i.test(motor)
        ? ok('el motor de descarga masiva existe con su transporte')
        : falla('src/services/sat-download existe pero sin el ciclo solicitar/verificar/descargar');
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

  {
    paquete: 'E4.1',
    enunciado: 'La nómina escribe los impuestos que sus formularios reportan',
    evaluar: () => {
      // ROJO HONESTO NUEVO. Los dos criterios anteriores de E4.1 miden la
      // conciliación y la siembra del mapeo — y con ellos en verde el paquete
      // entero figuraba cerrado mientras su salida no ocurre: paycheck_taxes,
      // employer_tax_liabilities y garnishments se LEEN (los formularios
      // 941/940, el posteo al mayor, el motor de embargos) y ningún camino
      // las escribe. El resultado es un número falso con aspecto de número:
      // los formularios reportan ceros y los embargos se descuentan de una
      // tabla que nadie puede poblar. `doctor` ya lo clasifica así; el
      // tablero tiene que decirlo también, porque es el que ordena sprints.
      const tablas = ['paycheck_taxes', 'employer_tax_liabilities', 'garnishments'];
      const sinEscritor = tablas.filter(
        (t) => dondeAparece(new RegExp(`INSERT\\s+INTO\\s+${t}\\b`, 'i'), ['src'], true).length === 0
      );
      return sinEscritor.length === 0
        ? ok('las tres tablas de la salida de nómina tienen escritor')
        : falla(
            `${sinEscritor.join(', ')}: se leen y nadie las escribe — los 941/940 reportan ` +
              'ceros y los embargos salen de una tabla que ningún camino puebla'
          );
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
    enunciado: 'La auditoría de consistencia corre contra el binario que se embarca, y su deuda no crece',
    evaluar: async () => {
      // `auditProgram` existía desde el principio y el programa real nunca
      // pasó por ella: vivía en un `.spec.ts` y cada prueba se construía un
      // árbol de juguete. Peor, importarla desde el spec arrastraba su suite,
      // cuyos `resetDeclarations()` vacían el registro de riesgo — así que
      // cualquier prueba que la importara auditaba un programa con cero
      // declaraciones y pasaba en el vacío.
      const { program } = await import('../cli/mnemosine.js');
      const { auditarContraLineaBase, LINEA_BASE } = await import('../cli/kernel/audit.js');

      const { nuevas, obsoletas, heredadas } = auditarContraLineaBase(program);
      if (nuevas.length > 0) {
        return falla(
          `${nuevas.length} violación(es) que no están en la línea base — p. ej. ` +
            `${nuevas[0].command}: ${nuevas[0].detail}`
        );
      }
      if (obsoletas.length > 0) {
        return falla(
          `${obsoletas.length} entrada(s) de la línea base ya no se violan y siguen ahí: una lista ` +
            'que no encoge deja de ser deuda registrada y se vuelve un permiso permanente'
        );
      }
      return ok(
        `sin violaciones nuevas; ${heredadas} de ${LINEA_BASE.length} heredadas siguen vivas`
      );
    },
  },
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
      // FALSO VERDE CORREGIDO. La versión anterior contaba cualquier mención
      // de `allDeclarations` fuera de risk.ts como «consumidor», y eso
      // incluía el re-export del barril (kernel/index.ts) — un archivo que no
      // consume nada, sólo reexporta. El tablero decía «el puente existe»
      // mientras las herramientas del agente seguían escritas a mano. Un
      // criterio cuyo verde puede producirlo un `export {...} from` no mide
      // un puente: mide que el símbolo exista, que ya lo mide el compilador.
      //
      // Consumidor de verdad = un archivo FUERA del núcleo del CLI que nombre
      // el símbolo. El puente será real cuando src/ai derive su superficie de
      // herramientas del registro; hasta entonces, rojo honesto.
      const cons = consumidoresDe('allDeclarations', 'risk.ts').filter(
        (f) => !f.startsWith('src/cli/kernel/')
      );
      return cons.length > 0
        ? ok(`el puente existe: ${cons.join(', ')}`)
        : falla(
            'allDeclarations no tiene consumidor fuera del núcleo (el re-export del barril no ' +
              'consume nada): las herramientas del agente siguen escritas a mano en vez de ' +
              'derivarse del registro de riesgo. La sesión desatendida ya corre con superficie ' +
              'nombrada (S0.3), pero esa lista también es a mano — el puente que las derive es ' +
              'una aspiración, y este rojo es su registro'
          );
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'La corrida desatendida corre con una superficie nombrada, no con «todas»',
    evaluar: () => {
      // La sesión desatendida recibía todas las herramientas porque la
      // fábrica ni siquiera admitía recorte. Hoy pasa una lista EXPLÍCITA
      // (tools/superficie.ts) y buildTools lanza ante nombres que no existen:
      // una herramienta nueva nace excluida de lo desatendido hasta que
      // alguien la añada a la lista, y un renombre rompe en el arranque en
      // vez de encoger la superficie en silencio.
      if (!existe('src/ai/tools/superficie.ts')) {
        return falla('no existe la superficie nombrada: la desatendida vuelve a recibir todo por omisión');
      }
      const cli = codigoDe('src/cli/mnemosine.ts');
      // La expresión admite el ternario de S0.6: con --live viaja la
      // superficie completa y sin ella la variante SANDBOX (misma lista menos
      // las dos lecturas externas). Lo que se afirma es que la opción
      // `herramientas` se alimenta de la lista NOMBRADA, nunca de una omisión.
      if (!/herramientas:[^\n]*SUPERFICIE_DESATENDIDA/.test(cli)) {
        return falla(
          'makeRunAgentTurn no pasa SUPERFICIE_DESATENDIDA: la sesión desatendida recibe la ' +
            'superficie completa por omisión, y una herramienta futura entraría sin que nadie lo decida'
        );
      }
      const fabrica = codigoDe('src/ai/tools/index.ts');
      return /permitidas/.test(fabrica) && /throw new Error/.test(fabrica)
        ? ok('la desatendida corre con lista explícita, y un nombre fantasma rompe en el arranque')
        : falla('buildTools no valida la lista: un nombre renombrado filtraría en silencio');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Los graves declaran junto a su registro, con la compuerta cableada y la llave guardada',
    evaluar: () => {
      // S0.6, tres afirmaciones mecánicas sobre el mismo borde.
      //
      // 1) La tabla de retrofit no declara ningún grave. Un irreversible o
      //    externo declarado por tabla es un manejador que nadie cableó: el
      //    preAction de la tabla sólo sabía rechazar --dry-run/--live en voz
      //    alta, nunca honrarlas. Una fila grave nueva sería ese retroceso.
      const tabla = codigoDe('src/cli/kernel/riesgos-retrofit.ts');
      if (/risk:\s*'(irreversible|externo)'/.test(tabla)) {
        return falla(
          'la tabla de retrofit volvió a declarar un grave: su manejador no honra --dry-run/--live — declara junto al registro y cablea gateMutation'
        );
      }
      // 2) La compuerta tiene consumidores reales fuera del kernel: los ocho
      //    graves migrados más las familias que ya nacieron cableadas.
      const consumidores = consumidoresDe('gateMutation', 'risk.ts').filter(
        (f) => !f.startsWith('src/cli/kernel/')
      );
      if (consumidores.length < 8) {
        return falla(
          `gateMutation se consume en ${consumidores.length} archivo(s) fuera del kernel; con los ocho graves cableados deben ser al menos 8`
        );
      }
      // 3) La llave de idempotencia se guarda de verdad: hay quien escribe
      //    idempotency_keys y más de un comando pasa por el almacén. Sin
      //    esto, --idempotency-key vuelve a ser un aviso que promete de más.
      const escritores = dondeAparece(/INSERT\s+INTO\s+idempotency_keys/i, ['src'], true);
      if (escritores.length === 0) {
        return falla('nadie escribe idempotency_keys: la bandera vuelve a ser un aviso sin almacén');
      }
      const usos = consumidoresDe('conLlave', 'idempotency-store.ts');
      return usos.length >= 3
        ? ok(
            `graves fuera de la tabla; compuerta consumida en ${consumidores.length} archivos; llave guardada (${escritores[0]}) y consumida en ${usos.length}`
          )
        : falla(
            `conLlave se consume en ${usos.length} archivo(s); entry post/reverse/void, close y onboard exigen al menos 3`
          );
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Los importes sobreviven a la compactación por construcción',
    evaluar: () => {
      // S1 (hueco confesado de E5.1-c): el backstop determinista de la
      // compactación cubría UUIDs, RFCs y folios, y los IMPORTES —la carga
      // útil de un agente contable— quedaban «protegidos por instrucción
      // solamente», según confesaba el propio comentario del módulo. Verde
      // exige que MONTO_RE exista y esté en la lista del extractor.
      const c = codigoDe('src/ai/compaction.ts');
      if (!/MONTO_RE/.test(c)) {
        return falla('no existe MONTO_RE: los importes vuelven a depender de que el modelo se porte bien');
      }
      return /\[UUID_RE,\s*RFC_RE,\s*FOLIO_RE,\s*MONTO_RE\]/.test(c)
        ? ok('el extractor incluye importes: lo que el resumen tire, el backstop lo re-adjunta')
        : falla('MONTO_RE existe pero el extractor no lo usa: es un regex decorativo');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'El «--continue» rehidrata el contexto que promete',
    evaluar: () => {
      // ROJO HONESTO (S1, hueco confesado de E5.1-b): la propia opción lo
      // dice — «transcript continuity; the model context starts fresh». Un
      // usuario que retoma su sesión espera que el agente recuerde la
      // conversación, no sólo que el transcript se anexe. Verde exige que
      // las opciones de sesión acepten un historial y que el camino de
      // --continue lo alimente desde getSessionMessages.
      const tipos = codigoDe('src/ai/providers/index.ts');
      const cli = codigoDe('src/cli/mnemosine.ts');
      if (!/historial/.test(tipos)) {
        return falla(
          'CreateLlmSessionOptions no acepta historial: --continue anexa transcript pero el ' +
            'modelo arranca en blanco — la rehidratación es trabajo de la familia del agente'
        );
      }
      return /historial/.test(cli)
        ? ok('el camino de --continue alimenta el historial de la sesión')
        : falla('las opciones aceptan historial y el CLI no lo alimenta');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Los precios del ledger declaran su vigencia, y el reporte la muestra',
    evaluar: () => {
      // S1 (hueco confesado de E5.1-f): la tabla de precios llevaba su fecha
      // de corte en un COMENTARIO. Un costo estimado con precios de hace un
      // año se lee como costo de hoy si nadie lo dice en la salida.
      const p = codigoDe('src/ai/providers/prices.ts');
      if (!/PRECIOS_VIGENTES_A\s*=\s*'\d{4}-\d{2}-\d{2}'/.test(p)) {
        return falla('la fecha de corte volvió a ser prosa: PRECIOS_VIGENTES_A no existe como dato');
      }
      return /PRECIOS_VIGENTES_A/.test(codigoDe('src/cli/usage-command.ts'))
        ? ok('la vigencia es un dato y cada reporte de uso la muestra')
        : falla('la fecha existe y el reporte de uso no la enseña');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Ninguna herramienta del agente alcanza el mayor ni ejecuta hacia fuera',
    evaluar: () => {
      // ESTE CRITERIO ESTABA EN ROJO POR UNA AFIRMACIÓN FALSA.
      //
      // Decía que `makeRunAgentTurn` construye la sesión sin recortar
      // herramientas y concluía que «un modelo que ignora el prompt escribe de
      // verdad». Lo primero es cierto; lo segundo no, y se comprueba mirando
      // la superficie: ninguna herramienta emite INSERT, UPDATE ni DELETE, la
      // familia del mayor sólo tiene SELECT, y lo que sí escribe lo hace en
      // `ai_drafts`, `ai_questions` o la bandeja de salida — que ENCOLA, no
      // ejecuta. La garantía «el agente propone y un humano dispone» se cumple
      // por construcción de las herramientas, no por una frase del prompt.
      //
      // Un rojo falso en el tablero que ordena los sprints es la misma
      // patología que el sprint persigue, cometida sobre el instrumento: se
      // convierte en paisaje, y el día que haya un rojo verdadero nadie lo
      // distinguirá. Así que el criterio pasa a afirmar la propiedad que de
      // verdad sostiene el diseño, y es falsable: una herramienta nueva que
      // llame al motor de posteo lo pone en rojo.
      const dir = 'src/ai/tools';
      const archivos = fuentes(dir);
      if (archivos.length === 0) return noEvaluable('no existe la superficie de herramientas');

      // Tres cercas, porque la auditoría demostró que una sola se salta.
      //
      // 1. NOMBRES prohibidos, por identificador y no por llamada: la
      //    primera versión exigía `nombre(` y un `import { x as y }` la
      //    evadía. Una herramienta no tiene razón legítima ni para NOMBRAR
      //    estos símbolos. La lista incluye las puertas de dinero creadas en
      //    este mismo sprint — la versión anterior vigilaba las viejas y era
      //    ciega a ligarPagoREP y procesarREP, recién nacidas.
      const PROHIBIDOS = [
        'postJournalEntry',
        'createJournalEntry',
        'recordVendorPayment',
        'recordCustomerPayment',
        'issueInvoice',
        'approveBill',
        'approveDraft',
        'hardClosePeriod',
        'commitPeriod',
        'executeExternalOp',
        'ligarPagoREP',
        'procesarREP',
        'processToAccounting',
        'createBankTransaction',
      ];
      // 2. MÓDULOS prohibidos: llamar a un servicio que a su vez postea es la
      //    evasión transitiva. Los módulos de dinero no se importan desde las
      //    herramientas, con ningún nombre.
      const MODULOS_PROHIBIDOS =
        /from\s+'[^']*(accounting\/posting|payments\/payment-service|xml-ingestion\/rep-linkage|accounting\/period-close|xml-ingestion\/pre-registration-service)/;
      const culpables: string[] = [];
      for (const f of archivos) {
        const codigo = sinComentarios(fs.readFileSync(f, 'utf-8'));
        const rel = path.relative(rutaDe(), f);
        for (const nombre of PROHIBIDOS) {
          if (new RegExp(`\\b${nombre}\\b`).test(codigo)) culpables.push(`${rel} → ${nombre}`);
        }
        if (MODULOS_PROHIBIDOS.test(codigo)) {
          culpables.push(`${rel} → importa un módulo de dinero`);
        }
        // 3. SQL de escritura directo, con el UPDATE multilínea incluido: el
        //    regex viejo exigía `UPDATE x SET` en una línea y una plantilla
        //    con salto de línea pasaba.
        if (/INSERT\s+INTO|UPDATE[\s\S]{0,80}?\bSET\b|DELETE\s+FROM|TRUNCATE\s|MERGE\s+INTO/i.test(codigo)) {
          culpables.push(`${rel} → SQL de escritura directo`);
        }
      }
      return culpables.length === 0
        ? ok(
            `${archivos.length} archivos de herramientas: ninguno postea, cobra, paga, timbra ni ` +
              'ejecuta hacia fuera; lo que escriben va a borradores, preguntas o la bandeja de salida'
          )
        : falla(
            `una herramienta del agente alcanza un camino que no debería: ${culpables.join(', ')}`
          );
    },
  },

  {
    paquete: 'E5.1',
    enunciado: 'El clasificador tiene vara de medir: golden set con esperado y arnés fijado',
    evaluar: () => {
      // A1: «medir antes de soltar» era doctrina sin instrumento — la brecha
      // madre de la auditoría integral. La vara: un corpus con respuesta
      // (tests/golden/cfdi, pares xml + esperado.json que incluyen los casos
      // donde lo correcto es PREGUNTAR) y un arnés que corre el MISMO camino
      // que la ingesta —ingestCfdiFiles con sus compuertas— contra un
      // proveedor FIJADO: createLlmSession directo, sin cadena de failover
      // (un eval que cambia de modelo a mitad de corrida no mide nada).
      const dir = rutaDe('tests/golden/cfdi');
      if (!fs.existsSync(dir)) return falla('el golden set no existe: no hay contra qué medir al clasificador');
      const archivos = fs.readdirSync(dir);
      const xmls = archivos.filter((a) => a.endsWith('.xml'));
      const huerfanos = xmls.filter((a) => !archivos.includes(a.replace(/\.xml$/, '.esperado.json')));
      if (xmls.length < 9 || huerfanos.length > 0) {
        return falla(`el corpus perdió casos o respuestas (${xmls.length} xml, sin esperado: ${huerfanos.join(', ') || 'ninguno'})`);
      }
      const arnes = codigoDe('scripts/eval-clasificador.ts');
      if (!/createLlmSession\(/.test(arnes) || /createLlmSessionWithFailover/.test(arnes)) {
        return falla('el arnés dejó de fijar proveedor: con cadena de failover la corrida no es comparable');
      }
      if (!/ingestCfdiFiles\(/.test(arnes)) {
        return falla('el arnés ya no corre el camino real de la ingesta: mediría un clasificador que no existe');
      }
      if (!/clasificador\.jsonl/.test(arnes) || !/agregarPuntuaciones\(/.test(arnes)) {
        return falla('el arnés perdió la bitácora o la puntuación: sin «contra la corrida anterior» no hay tendencia');
      }
      // Forma de LLAMADA (marca('abstencion', …)), no el símbolo: la unión de
      // tipos también dice 'abstencion' y un regex laxo bendice al mutante
      // que renombra la marcación real — el primo del import (AUD-6).
      return /marca\(\s*\n?\s*'abstencion'/.test(codigoDe('src/ai/eval/puntuacion.ts'))
        ? ok(`${xmls.length} casos con esperado, arnés por el camino real, proveedor fijado y bitácora comparable`)
        : falla('la puntuación perdió la clase abstención: dejaría de medirse la humildad de preguntar');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'La calibración se lee del rastro: ai stats por bucket, con delta',
    evaluar: () => {
      // A2: la confianza que el modelo reporta contra lo que el despacho
      // decidió, bucket por bucket — y el DELTA que exhibe el exceso de
      // confianza. El destino se reconstruye del rastro de atribución que
      // los caminos de aprobación dejan a propósito (la nota del auto-post,
      // el reviewed_by 'policy:'), no de una columna que no existe.
      const svc = codigoDe('src/ai/stats-service.ts');
      // Conteos, no presencia: la nota del auto-post aparece en TRES brazos
      // del CASE (el filtro de auto y los dos NOT LIKE que separan política
      // y humano) y el prefijo 'policy:' en DOS. Mutar uno deja los demás y
      // un chequeo de presencia lo bendice — la lección de R1 (la resta
      // JSONB contada una vez, existiendo en dos funciones).
      const notasAuto = (svc.match(/'auto-post by threshold%'/g) ?? []).length;
      const prefijosPolitica = (svc.match(/'policy:%'/g) ?? []).length;
      if (!/FROM ai_drafts/.test(svc) || notasAuto < 3 || prefijosPolitica < 2) {
        return falla(
          `las estadísticas dejaron de leer el rastro de atribución completo (nota auto ×${notasAuto}, prefijo policy ×${prefijosPolitica}): auto, política y humano se confundirían`
        );
      }
      if (!/media\.minus\(tasa\)/.test(svc)) {
        return falla('el delta confianza-vs-realidad desapareció: los buckets sin delta son un conteo, no una calibración');
      }
      const cmd = codigoDe('src/cli/ai-command.ts');
      if (!/declareRisk\(stats,\s*\{\s*risk:\s*'lectura',\s*agent:\s*true/.test(cmd)) {
        return falla('ai stats dejó de ser lectura abierta al agente: medirse a sí mismo es el único privilegio que debe tener');
      }
      return /registerAiCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'))
        ? ok('ai stats registrado: buckets sobre ai_drafts, atribución por rastro y delta a la vista')
        : falla('registerAiCommand no está en el binario: la calibración existiría sin superficie');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Lo que el agente hace deja rastro medible: duración, corridas y eventos',
    evaluar: () => {
      // A2: las métricas que faltaban. duration_ms en el ledger de uso (los
      // DOS runners miden alrededor de su llamada), los counts de la ingesta
      // persistidos por corrida (con consumo, para que costo-por-borrador
      // sea una división), y sospecha/nudge/failover como filas — el delito
      // menor deja rastro ANTES de discutir la autonomía mayor.
      const m = 'src/database/migrations/044_el_agente_medible.sql';
      if (!existe(m)) return falla('la 044 desapareció: sin tablas no hay rastro');
      const sql = fs.readFileSync(rutaDe(m), 'utf-8');
      if (!/ADD COLUMN duration_ms/.test(sql) || !/CREATE TABLE ai_ingest_runs/.test(sql) || !/CREATE TABLE ai_agent_events/.test(sql)) {
        return falla('la 044 perdió una de sus tres piezas (duration_ms, ai_ingest_runs, ai_agent_events)');
      }
      // Conteo por archivo, no presencia: el agente emite en DOS sitios
      // (bucle del runner y summarize) y el compat en TRES (summarize,
      // no-stream, stream) — mutar el sitio principal dejando el secundario
      // pasa un chequeo de presencia. Tercera aparición de la lección del
      // conteo en esta misma corrida.
      // Sólo Date.now() cuenta como medición: una alternativa `durationMs`
      // casaba la FIRMA de emitUsage(usage, durationMs?) y la declaración
      // pasaba por sitio medido — el regex mordiéndose la cola.
      const emisionesMedidas = (f: string): number =>
        (codigoDe(f).match(/emitUsage\([^)]*,\s*Date\.now\(\)/g) ?? []).length;
      const enAgente = emisionesMedidas('src/ai/agent.ts');
      const enCompat = emisionesMedidas('src/ai/providers/openai-compat.ts');
      if (enAgente < 2 || enCompat < 3) {
        return falla(
          `un runner dejó de medir alguna de sus llamadas (agente ${enAgente}/2, compat ${enCompat}/3)`
        );
      }
      if (!/duration_ms/.test(codigoDe('src/ai/usage-ledger.ts'))) {
        return falla('el ledger de uso dejó de persistir la duración que los runners miden');
      }
      const cli = codigoDe('src/cli/mnemosine.ts');
      if (!/registrarCorridaIngesta\(ctx/.test(cli)) {
        return falla('la ingesta volvió a imprimir y evaporar: nadie registra la corrida');
      }
      if ((cli.match(/registrarEventoEnSegundoPlano\(ctx/g) ?? []).length < 3) {
        return falla('los eventos del agente (sospecha/nudge/failover) perdieron cableado en el CLI');
      }
      return /this\.onNudge\?\.\(\)/.test(codigoDe('src/ai/grounding.ts'))
        ? ok('duración en los dos runners y el ledger, corridas de ingesta con consumo, y los tres eventos cableados')
        : falla('el guard de grounding dejó de avisar el nudge: el contador quedaría siempre en cero');
    },
  },

];
