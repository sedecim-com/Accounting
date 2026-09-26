import * as path from 'node:path';
import {
  codigoDe,
  consumidoresDe,
  type Criterio,
  crudoDe,
  dondeAparece,
  existe,
  falla,
  fuentes,
  ok,
  RAIZ,
  sinProsa,
} from './shared.js';

// ============================================================
// THE E4.2 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E4_2: Criterio[] = [

  // ---- E4.2 · Trabajos y reportes ----
  {
    paquete: 'E4.2',
    id: 'posting-code-without-matview-refresh',
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
    id: 'agent-balance-sheet-foots',
    enunciado: 'El balance que lee el agente cuadra, y publica con qué notar que no',
    evaluar: () => {
      // T14 (#101). De las tres superficies del balance —CLI, REST y la
      // herramienta del agente— sólo ésta ensamblaba su propio total: una
      // consulta, sin queryUnclosedEarnings, y
      // `total_liabilities_and_equity = pasivo + capital`. Medido sobre un
      // mayor SANO de activo 100 000 con 6 000 de resultado sin barrer,
      // publicaba 94 000.00 contra 100 000.00 — y ni un campo con el que
      // notarlo, mientras la CLI firmaba 100 000.00 sobre los mismos datos.
      const t = codigoDe('src/ai/tools/report-tools.ts');
      if (!/await getBalanceSheet\(ctx\.entityId/.test(t)) {
        return falla('la herramienta del agente volvió a ensamblar su propio balance en vez de proyectar el informe que firman la CLI y el REST');
      }
      if (!/out_of_balance:/.test(t) || !/is_balanced:/.test(t)) {
        return falla('el balance del agente dejó de publicar out_of_balance/is_balanced: el modelo no tendría con qué notar un descuadre');
      }
      // El estado de resultados suma el LIBRO, no sus propios redondeos. Con
      // el `reduce` sobre las filas ya redondeadas publicaba 0.06 donde el
      // gasto posteado es 0.0400: una cifra falsa, no un formato.
      if (!/crudoGastos\.reduce\(\(s, r\) => s\.plus\(netMovement\(r\)\)/.test(t)) {
        return falla('el estado de resultados del agente volvió a sumar filas ya redondeadas: publicaría la suma de los redondeos en vez del redondeo de la suma');
      }
      // Y el detalle a la escala que la cabecera del archivo promete desde
      // que existe, con el residuo NOMBRADO cuando las filas no suman.
      if (!/ending_balance: aEscala\(/.test(t) || !/amount_due: aEscala\(/.test(t)) {
        return falla('las filas de detalle del agente volvieron a publicarse en crudo: DECIMAL(19,4) bajo totales a dos decimales');
      }
      if (!/rounding_residual/.test(t)) {
        return falla('el residuo de redondeo dejó de nombrarse: las filas no sumarían su total y nadie diría por qué');
      }
      // La misma ceguera vivía en el sobre REST, que CALCULABA las dos claves
      // y las tiraba.
      if (!/out_of_balance: report\.out_of_balance/.test(codigoDe('src/api/rest/routes/reports.ts'))) {
        return falla('el sobre REST del balance volvió a descartar out_of_balance/is_balanced: un tablero no podría saber si el estado cuadra');
      }
      return ok('el balance del agente proyecta el informe ensamblado, publica su cuadre, y el detalle sale a escala con su residuo nombrado');
    },
    mutantes: [
      {
        archivo: 'src/ai/tools/report-tools.ts',
        de: 'await getBalanceSheet(ctx.entityId',
        a: 'await queryBalanceSheetRows(ctx.entityId',
        porque: 'la herramienta vuelve a calcularse su propio balance: publicaría pasivo+capital y se comería el resultado del ejercicio',
      },
      {
        archivo: 'src/ai/tools/report-tools.ts',
        de: 'crudoGastos.reduce((s, r) => s.plus(netMovement(r))',
        a: 'expenseRows.reduce((s, r) => s.plus(r.amount)',
        porque: 'el estado de resultados vuelve a sumar sus propios redondeos: publica 0.06 donde el libro dice 0.05',
      },
      {
        archivo: 'src/ai/tools/report-tools.ts',
        de: 'ending_balance: aEscala(',
        a: 'ending_balance: String(',
        porque: 'el detalle vuelve a salir en crudo a cuatro decimales bajo totales de dos, que es lo que tapaba el descuadre',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de: 'out_of_balance: report.out_of_balance',
        a: 'as_of_date_bis: report.as_of_date',
        porque: 'el sobre REST vuelve a tirar el cuadre que su propio informe calcula',
      },
    ],
  },
  {
    paquete: 'E4.2',
    id: 'single-report-query-layer',
    enunciado: 'Las superficies de reportes consumen una sola capa de consulta',
    evaluar: () => {
      const cons = consumidoresDe('getTrialBalance', 'report-service.ts');
      const copias = dondeAparece(/SUM\(\s*COALESCE\(jel\.debit_amount/i, ['src'], true).filter(
        (f) => !f.includes('report-service')
      );
      if (copias.length > 0) {
        return falla(`${copias.length} copia(s) del SQL de saldos fuera de report-service: ${copias.join(', ')}`);
      }
      // T2 · VACUIDAD. «Una sola capa, consumida por 0 superficies» es el verde
      // que sale cuando no hay NADA: cero copias porque no hay código. Lo que
      // este criterio afirma es que las superficies de reportes pasan todas por
      // la misma capa, y una afirmación sobre un conjunto vacío de superficies
      // no afirma nada. Sin consumidor, la capa única es una capa muerta.
      return cons.length > 0
        ? ok(`una sola capa, consumida por ${cons.length} superficie(s)`)
        : falla(
            'la capa de consulta no tiene un solo consumidor: «una sola capa» es cierto y vacío — o ' +
              'las superficies dejaron de pasar por ella, o no queda superficie que mirar'
          );
    },
  },
  {
    paquete: 'E4.2',
    id: 'report-sections-are-identified-by-key',
    // I11 · issue #153, primer commit. Los rótulos de las secciones del balance
    // y del estado de resultados se van a traducir, y tres superficies los leían
    // como identidad: la herramienta del agente derivaba `category` del rótulo
    // («Current Assets» → `current_assets`) y buscaba el resultado del ejercicio
    // por su nombre inglés; la API y `report … --json` los publican. Traducir
    // sin esto le habría cambiado al agente `current_assets` por
    // `activo_circulante` y le habría quitado `equity.result_of_the_period` en
    // silencio, que es lo que `src/ai/docs/reports.md` le promete.
    //
    // Este criterio NO exige todavía que los rótulos salgan del catálogo: eso es
    // el commit siguiente, y su criterio tendrá que mirar los SEIS literales.
    // Lo que fija es la identidad: existe una clave y los consumidores la usan.
    enunciado:
      'Las secciones de los informes tienen clave estable, y el agente agrupa por ella y no por el rótulo inglés',
    mutantes: [
      {
        archivo: 'src/ai/tools/report-tools.ts',
        de: '            category: sub.key,',
        a: "            category: sub.name.toLowerCase().replace(/ /g, '_'),",
        porque:
          'categoria-derivada-del-rotulo: el agente volvería a agrupar por el nombre, así que el día que se traduzca recibiría `activo_circulante` donde su manual le promete `current_assets`',
      },
      {
        archivo: 'src/ai/tools/report-tools.ts',
        de: "        (x: Seccion['subsections'][number]) => x.key === 'result_of_the_period'",
        a: "        (x: Seccion['subsections'][number]) => x.name === 'Result Of The Period'",
        porque:
          'resultado-buscado-por-nombre: traducido el rótulo, la búsqueda no encuentra nada y `equity.result_of_the_period` desaparece del JSON sin que nada lo acuse',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "      key: 'result_of_the_period',\n",
        a: '',
        porque:
          'subseccion-sin-clave: la única subsección que no viene de `fs_category` se quedaría sin identidad, y quien la busque tendría que volver al rótulo',
      },
    ],
    evaluar: () => {
      const codeLines = (rel: string): string[] =>
        crudoDe(rel)
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

      const types = codeLines('src/types/index.ts').join('\n');
      if (!/export interface BalanceSheetSection \{\s*key: string;/.test(types)) {
        return falla('BalanceSheetSection perdió su clave: la identidad de una sección volvería a ser su rótulo, que se traduce');
      }
      if (!/export interface IncomeStatementSection \{\s*key: string;/.test(types)) {
        return falla('IncomeStatementSection perdió su clave: revenue y expenses volverían a identificarse por su rótulo');
      }

      const service = codeLines('src/services/reporting/report-service.ts').join('\n');
      const missing = ["key: 'assets'", "key: 'liabilities'", "key: 'equity'", "key: 'result_of_the_period'"]
        .filter((k) => !service.includes(k));
      if (missing.length > 0) {
        return falla(`report-service no rellena ${missing.length} clave(s) de sección (${missing.join(', ')}): la traducción del rótulo se llevaría por delante la identidad`);
      }
      if (!/key: type === 'revenue' \? 'revenue' : 'expenses'/.test(service)) {
        return falla('las secciones del estado de resultados dejaron de llevar clave');
      }

      const tools = codeLines('src/ai/tools/report-tools.ts').join('\n');
      if (!/category: sub\.key,/.test(tools)) {
        return falla('la herramienta del agente volvió a derivar `category` del rótulo: agruparía distinto en cuanto el rótulo se traduzca');
      }
      if (!/x\.key === 'result_of_the_period'/.test(tools)) {
        return falla('la herramienta del agente busca el resultado del ejercicio por su rótulo: traducido, lo perdería en silencio');
      }
      if (/sub\.name\.toLowerCase\(\)/.test(tools) || /=== 'Result Of The Period'/.test(tools)) {
        return falla('queda una lectura del rótulo inglés en la herramienta del agente');
      }
      return ok('las secciones llevan clave estable y el agente agrupa y busca por ella, no por el rótulo');
    },
  },
  {
    paquete: 'E4.2',
    id: 'report-labels-come-from-the-catalog',
    // I11 · issue #153, SECOND commit — the one the criterion above announces in
    // writing. That one pinned the IDENTITY (a key exists and the agent groups by
    // it); this one watches the LABEL: that the prose a person reads comes out of
    // the catalog, and that it comes out AT THE EDGE.
    //
    // WHY AT THE EDGE, which is the most valuable thing there is to watch here.
    // No file under `src/services/` imports `src/i18n/`, and that is no accident:
    // the two surfaces that read the language resolve it in incompatible ways.
    // The CLI pins it in a module global at start-up; the API only has it in
    // `res.locals`, because it negotiates it per request. A service that asked
    // `getLanguage()` would make EVERY HTTP response come out in the language of
    // the process and ignore `Accept-Language` — the exact defect I9 has just
    // closed in the errors, and which would come back through the door next to it.
    // That is why the service goes on minting its English `name`, the key is the
    // identity, and each human surface paints the label with the language it
    // actually has.
    //
    // WHAT A NAIVE CRITERION LETS THROUGH. The issue proposed scanning
    // `report-service.ts` and nothing else. With that, `report-command.ts` could
    // go on printing 'Total Liabilities and Equity', 'Net income' and
    // `Total ${sub.name}` underneath a table in Spanish, and the criterion stayed
    // green: the three shadow copies lived there and had NO test at all —the 1 928
    // in tests/cli, tests/i18n and tests/services/reporting passed without touching
    // them—. So what is looked at here is BOTH files, the row that travels with the
    // key, the hooks of BOTH human branches, the tree walk that defends the
    // invariant, and the catalog measured against the domain the migration declares.
    //
    // WHAT MEASURING IT WITH THE SEAM FOUND (two attackers, six escapes). A
    // criterion is worth exactly the mutants that have been run against it, and
    // six survived this one. Markdown was not watched at all, while `--format md
    // -o` is the deliverable the wiki teaches. `'Net Income'` walked past a guard
    // whose three neighbours all carried `i`. `'Total ' +` walked past a guard
    // that only knew `${}`. Three of the five catalog keys the command needs were
    // not required at all. The catalogs were read RAW, so commenting a key out
    // retired it from the program and not from the guard — and a key that lived
    // only inside a comment satisfied the guard that every `t('report.*')`
    // resolves, while `t()` throws. And the invariant matched a STRING instead of
    // asking the graph, so a barrel re-export, a `require()` and a computed
    // specifier all went under it. Every one of those is a mutant below.
    enunciado:
      'Los rótulos de los informes salen del catálogo en el borde, y ningún servicio importa el idioma',
    mutantes: [
      {
        archivo: 'src/cli/report-command.ts',
        de: "      rows.push({ section: '', code: '', name: '', amount: is.net_income, line: 'total' });",
        a: "      rows.push({ section: '', code: '', name: 'Net Income', amount: is.net_income, line: 'total' });",
        porque:
          'rotulo-ingles-con-otra-caja: la prosa vuelve a la FILA, y en mayúscula. El guardia de este rótulo era el único de los cuatro sin la bandera `i`, así que «Net Income» pasaba por delante de él mientras «Net income» moría — un rótulo se escapa cambiando una letra de caja',
      },
      {
        archivo: 'src/cli/report-command.ts',
        de: "t('report.total_of', { name: reportCategoryLabel(keyOf(row.category)) })",
        a: "`Total ${reportCategoryLabel(keyOf(row.category))}`",
        porque:
          'concatenacion-que-fija-el-orden: la palabra «Total» vuelve al código con el orden inglés cosido, de modo que ninguna traducción puede moverla de sitio aunque el rótulo que la acompaña sí se traduzca',
      },
      {
        archivo: 'src/cli/report-command.ts',
        de: "t('report.total_of', { name: reportCategoryLabel(keyOf(row.category)) })",
        a: "'Total ' + reportCategoryLabel(keyOf(row.category))",
        porque:
          'el-pegado-que-no-es-plantilla: el mismo defecto escrito con `+` en vez de con `${}`. El guardia miraba sólo la plantilla, así que la forma más natural de recaer —concatenar— salía verde con «Total» cosido delante igual que antes',
      },
      {
        archivo: 'src/cli/report-command.ts',
        de: "t('report.total_liabilities_and_equity')",
        a: "reportSectionLabel('total_liabilities_and_equity')",
        porque:
          'clave-obligatoria-que-nadie-exigia: el renglón de la suma deja de pedirle su prosa al catálogo y se la pide al rotulador de secciones, que no tiene esa clave y cae al identificador crudo. La lista de claves obligatorias sólo nombraba las dos notas al pie, así que los tres rótulos compuestos podían irse sin que nada se pusiera rojo',
      },
      {
        archivo: 'src/cli/report-command.ts',
        de: '              section: section.key,\n              category: sub.key,',
        a: '              section: section.name,\n              category: sub.name,',
        porque:
          'la-fila-lleva-el-rotulo: csv y json volverían a cambiar con el idioma de quien lee, así que dos corridas de la misma orden darían dos documentos distintos y ningún consumidor de máquina podría agrupar por sección',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: "return { data: toTable(rows, cols, numeric, p, opts.jurisdiction, opts.labelled) + '\\n', notes: aviso };",
        a: "return { data: toTable(rows, cols, numeric, p, opts.jurisdiction) + '\\n', notes: aviso };",
        porque:
          'tabla-sin-rotulador: la rama para humanos dejaría de recibir el gancho y el balance imprimiría `non_current_assets` a una persona, con las cifras correctas al lado para que nadie sospeche',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: "return { data: toMarkdown(rows, cols, opts.labelled) + '\\n', notes: aviso };",
        a: "return { data: toMarkdown(rows, cols) + '\\n', notes: aviso };",
        porque:
          'markdown-sin-rotulador: la SEGUNDA rama humana deja de recibir el gancho. `--format md -o` es lo que la wiki enseña como el entregable del mes, así que el informe que se entrega imprimiría `assets` donde la tabla pone «Assets» — y el guardia de las ramas de máquina no nombraba toMarkdown, de modo que esto salía verde',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: '            return esc(label !== undefined ? label(cell(r[c]), r) : cell(r[c]));',
        a: '            return esc(cell(r[c]));',
        porque:
          'gancho-recibido-y-no-aplicado: toMarkdown sigue declarando el parámetro y no lo usa, que es la forma de fallo que una comprobación de FIRMA no ve. El markdown saldría sin rótulos con la firma intacta',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: '  const format = resolveFormat(opts);',
        a:
          '  const format = resolveFormat(opts);\n' +
          '  rows = rows.map((r) => ({ ...r, ...Object.fromEntries(Object.entries(opts.labelled ?? {}).map(([c, f]) => [c, f(cell(r[c]), r)])) }));',
        porque:
          'rotular-una-vez-y-arriba: el atajo natural —rotular antes del switch de formato— haría que csv, json y ndjson contestaran en el idioma del lector, que es dejar de ser formatos de máquina; el dinero ya tiene escrito ahí por qué esa rama es sólo para humanos',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "import { getPolicy } from '../policy/policy-service.js';",
        a: "import { getPolicy } from '../policy/policy-service.js';\nimport { t } from '../../i18n/index.js';",
        porque:
          'idioma-dentro-del-servicio: el servicio pasa a resolver el idioma por su cuenta y sólo puede resolver el del PROCESO, así que la API contestaría en español a quien pide inglés e ignoraría Accept-Language — el defecto que I9 acaba de cerrar en los errores',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "import { getPolicy } from '../policy/policy-service.js';",
        a: "import { getPolicy } from '../policy/policy-service.js';\nconst { t } = require('../../i18n/index.js');",
        porque:
          'el-mismo-import-por-la-puerta-de-atras: `require()` carga exactamente lo mismo y la invariante casaba `from` o `import(`, así que la forma CommonJS del defecto entraba entera sin tocar ninguna puerta',
      },
      {
        archivo: 'src/services/reporting/report-service.ts',
        de: "import { getPolicy } from '../policy/policy-service.js';",
        a: "import { getPolicy } from '../policy/policy-service.js';\nconst catalog = await import(LANGUAGE_MODULE);",
        porque:
          'especificador-que-no-se-puede-leer: con la ruta en una variable no hay cadena que casar, así que cualquier invariante escrita como búsqueda de texto queda ciega por construcción; un servicio no tiene ninguna razón para cargar un módulo computado',
      },
      {
        archivo: 'src/types/index.ts',
        de: 'export enum AccountType {',
        a: "export { t } from '../i18n/index.js';\n\nexport enum AccountType {",
        porque:
          'el-barril-que-esquiva-la-invariante: ningún archivo de src/services nombra i18n y aun así todos pueden leer el idioma, porque veinte de ellos importan este barril por su valor. La invariante casaba una CADENA y el grafo pasaba por debajo',
      },
      {
        archivo: 'src/i18n/en.ts',
        de: "  'report.category.ori': 'Other comprehensive income',\n",
        a: '',
        porque:
          'categoria-sin-rotulo: `ori` es la categoría que la 078 añadió al CHECK y que el enum no tenía; sin su entrada el balance imprime la clave cruda «ori» donde debería decir el renglón de la NIF B-3, y el rotulador cae a la clave en vez de lanzar, así que nada lo acusa',
      },
      {
        archivo: 'src/i18n/en.ts',
        de: "  'report.category.ori': 'Other comprehensive income',",
        a: "  // 'report.category.ori': 'Other comprehensive income',",
        porque:
          'comentar-en-vez-de-borrar: la entrada sigue en el archivo y ya no existe para el programa. El catálogo se leía CRUDO, así que la forma más común de retirar una línea —comentarla— dejaba el criterio verde con el balance imprimiendo «ori»',
      },
      {
        archivo: 'src/i18n/en.ts',
        de: "  'report.net_income': 'Net income',",
        a: "  // 'report.net_income': 'Net income',",
        porque:
          'clave-que-vive-solo-en-un-comentario: peor que el anterior, porque el guardia que comprueba que toda `t(\'report.*\')` existe la DABA POR BUENA leyendo el archivo crudo. `t()` no cae a otro idioma: lanza, y el informe no llega a imprimirse',
      },
      {
        archivo: 'src/i18n/report-labels.ts',
        de: '  return isKnown(key) ? t(key, {}, language) : fallback;',
        a: "  return isKnown(key) ? t(key, {}, 'en') : fallback;",
        porque:
          'rotulador-que-clava-el-idioma: las dos funciones siguen exportadas, el catálogo sigue completo y la tabla sigue rotulando — en inglés, siempre. Un criterio que sólo mira quién llama a quién no distingue esto de lo correcto',
      },
    ],
    evaluar: () => {
      // Read through the seam, and filter the comment lines BY HAND: `sinComentarios`
      // goes blind on big files full of backticks, and here nearly everything that is
      // FORBIDDEN is quoted in the prose that explains why it is forbidden. A criterion
      // that accuses itself does not measure.
      //
      // THE CATALOGS ARE READ THE SAME WAY, and that is not tidiness. Commenting
      // `'report.category.ori'` out instead of deleting it used to leave this green —
      // the most common way anybody retires a line — and worse: a key that exists ONLY
      // inside a comment used to satisfy the guard that every `t('report.*')` resolves.
      // `t()` does not fall back to another language, it throws.
      const codeOf = (rel: string): string =>
        crudoDe(rel)
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n');

      /** One top-level declaration, from its keyword to the next one. */
      const declarationIn = (source: string, name: string): string => {
        const start = Math.max(source.indexOf(`function ${name}(`), source.indexOf(`const ${name} =`));
        if (start === -1) return '';
        const rest = source.slice(start);
        const end = rest.slice(1).search(/\n(?:export )?(?:function|const|interface|type|import|class|enum) /);
        return end === -1 ? rest : rest.slice(0, end + 1);
      };

      // ── The edge labeller exists, exports both functions, and pins no language ──
      const edge = 'src/i18n/report-labels.ts';
      if (!existe(edge)) {
        return falla(
          `${edge} no existe: no hay rotulador en el borde, así que el rótulo volvería al literal inglés del comando o —peor— al servicio`
        );
      }
      const labeller = codeOf(edge);
      for (const fn of ['reportSectionLabel', 'reportCategoryLabel']) {
        if (!new RegExp(`export function ${fn}\\(`).test(labeller)) {
          return falla(`${edge} dejó de exportar ${fn}: la superficie humana no tendría de dónde sacar el rótulo`);
        }
      }
      // BEHAVIOUR belongs to the tests; what a criterion can hold is the shape that
      // makes the behaviour possible. `isKnown` probes the catalog in a fixed language
      // on purpose —it asks whether the key EXISTS, not what it says— and it is the
      // only place allowed to name one. Anywhere else, a literal language is a
      // labeller that answers in it forever while every call site still looks right.
      const outsideGuard = labeller.replace(/function isKnown\([\s\S]*?\n\}/, '');
      if (/\bt\(\s*[^)]*['"](?:en|es)['"]/.test(outsideGuard)) {
        return falla(
          'report-labels.ts clava un idioma en una llamada a t() fuera de su guardia `isKnown`: ' +
            'el informe saldría siempre en ese idioma con toda la cadena de llamadas intacta'
        );
      }

      // ── 1. The three shadow copies, which had no test ──
      const cli = codeOf('src/cli/report-command.ts');
      // Every one of these carries `i`. The `Net income` guard was the one that did
      // not, and a label escapes by changing the case of a single letter.
      const forbidden: [RegExp, string][] = [
        [/Total Liabilities and Equity/i, "el rótulo fijo 'Total Liabilities and Equity'"],
        [/['"`]Net income['"`]/i, "el rótulo fijo 'Net income'"],
        [/= Liabilities \+ Equity/i, 'la comprobación del balance redactada en inglés'],
        [/`[^`\n]*Total \$\{/i, 'la concatenación `Total ${…}`, que cose el orden de las palabras'],
        // The same defect written with `+`. A guard that only knew the template form
        // blessed the most natural way to relapse.
        [
          /['"]\s*Total\s*['"]\s*\+|\+\s*['"]\s*Total\s*['"]/i,
          'el pegado de «Total» con `+`, que cose el orden de las palabras igual que la plantilla',
        ],
      ];
      for (const [pattern, what] of forbidden) {
        if (pattern.test(cli)) {
          return falla(
            `report-command.ts volvió a llevar ${what}: la CLI imprimiría inglés debajo de una tabla en español, y ninguna prueba de las 1 928 lo acusa`
          );
        }
      }
      if (!/from '\.\.\/i18n\/report-labels\.js'/.test(cli)) {
        return falla('report-command.ts dejó de leer el rotulador del borde: los rótulos volverían a escribirse dentro del comando');
      }
      const used = [...new Set([...cli.matchAll(/t\('(report\.[a-z_.]+)'/g)].map((m) => m[1]))];
      const englishCatalog = codeOf('src/i18n/en.ts');
      const spanishCatalog = codeOf('src/i18n/es.ts');
      const unknownKeys = used.filter(
        (k) => !englishCatalog.includes(`'${k}':`) || !spanishCatalog.includes(`'${k}':`)
      );
      if (unknownKeys.length > 0) {
        return falla(
          `report-command.ts pide ${unknownKeys.length} clave(s) que algún catálogo no tiene (${unknownKeys.join(', ')}): ` +
            't() no cae al otro idioma, lanza, y el informe no llegaría a imprimirse'
        );
      }
      // EVERY key the command uses, not just the two footnotes. The list that named
      // only `balance_check` and `income_summary` let the three composed labels walk
      // back to English prose without turning anything red.
      const requiredKeys = [
        'report.total_of',
        'report.net_income',
        'report.total_liabilities_and_equity',
        'report.balance_check',
        'report.income_summary',
      ];
      const dropped = requiredKeys.filter((k) => !used.includes(k));
      if (dropped.length > 0) {
        return falla(
          `${dropped.length} rótulo(s) del informe dejaron de salir del catálogo (${dropped.join(', ')}): ` +
            'volverían a ser prosa inglesa escrita dentro del comando'
        );
      }

      // ── 2. The row travels with the KEY, never with the label ──
      if (/\bsection\.name\b/.test(cli) || /\bsub\.name\b/.test(cli)) {
        return falla('report-command.ts volvió a meter el rótulo en la fila: csv y json cambiarían con el idioma de quien lee');
      }
      if (!/section: section\.key,/.test(cli) || !/category: sub\.key,/.test(cli)) {
        return falla('las filas del informe dejaron de llevar la clave de sección o de categoría: el formato de máquina perdería su identidad');
      }

      // ── 3. The human branches label; the machine ones do not ──
      // BOTH of them: the aligned table AND markdown. `--format md -o` is what the
      // wiki teaches as the deliverable of the month, and while this guard named only
      // `toTable` that deliverable printed `assets` where the table printed «Assets».
      const labelledCalls = cli.match(/labelled: \{[^}]*\}/g) ?? [];
      if (labelledCalls.length < 2) {
        return falla(
          `sólo ${labelledCalls.length} de las dos tablas de informe recibe \`labelled\`: la otra imprimiría \`non_current_assets\` a una persona`
        );
      }
      if (!labelledCalls.every((call) => /\bsection: [A-Za-z]/.test(call) && /\bname: [A-Za-z]/.test(call))) {
        return falla('una de las dos tablas de informe ya no rotula `section` o `name`: el humano leería la clave, o un renglón de subtotal saldría en blanco');
      }
      if (!labelledCalls.some((call) => /\bcategory: [A-Za-z]/.test(call))) {
        return falla('la tabla del balance dejó de rotular `category`: las subsecciones saldrían como `long_term_liabilities`');
      }
      // And each hook reaches the catalog. A hook that is wired but writes its own
      // prose is the same defect one indirection further in.
      const hooks: [string, RegExp, string][] = [
        ['sectionOf', /reportSectionLabel\(/, 'la columna `section` de las dos tablas'],
        ['categoryOf', /reportCategoryLabel\(/, 'la columna `category` del balance'],
        ['balanceSheetName', /reportCategoryLabel\(/, 'el renglón de subtotal del balance'],
        ['incomeStatementName', /t\('report\./, 'el renglón de total del estado de resultados'],
      ];
      for (const [hook, reaches, what] of hooks) {
        const declared = declarationIn(cli, hook);
        if (declared === '') {
          return falla(`report-command.ts ya no declara ${hook}: ${what} se quedaría sin rotulador`);
        }
        if (!reaches.test(declared)) {
          return falla(`${hook} dejó de componer su prosa con el catálogo: ${what} volvería a llevar un literal inglés`);
        }
      }

      const kernel = codeOf('src/cli/kernel/output.ts');
      // A signature check would not see this: the failure mode is a parameter that is
      // received and never applied. So both halves are asked for — it reads the hook
      // (`labelled?.[…]`) and it calls it (`label(`).
      for (const [human, why] of [
        ['toTable', 'la tabla alineada'],
        ['toMarkdown', '`--format md`, que la wiki enseña como el entregable del mes'],
      ] as [string, string][]) {
        const body = declarationIn(kernel, human);
        if (!/labelled\?\.\[/.test(body) || !/\blabel\(/.test(body)) {
          return falla(
            `${human}() no recibe el gancho de rótulos o no lo aplica: ${why} imprimiría \`assets\` donde debe decir «Assets», ` +
              'con las cifras correctas al lado para que nadie sospeche'
          );
        }
      }
      for (const machine of ['toDelimited', 'jsonCell', 'cell']) {
        if (declarationIn(kernel, machine).includes('labelled')) {
          return falla(
            `${machine}() rotula: csv, tsv, ndjson y json contestarían distinto en cada idioma, que es dejar de ser formatos de máquina`
          );
        }
      }
      const composed = declarationIn(kernel, 'compose');
      const times = (composed.match(/labelled/g) ?? []).length;
      if (
        times !== 2 ||
        !/toTable\([^)]*opts\.labelled\)/.test(composed) ||
        !/toMarkdown\([^)]*opts\.labelled\)/.test(composed)
      ) {
        return falla(
          `compose() nombra \`labelled\` ${times} vez(ces) y sólo puede nombrarlo DOS: en la llamada a toTable y en la de toMarkdown. ` +
            'Rotular antes del switch de formato traduce también csv, tsv, ndjson y json; rotular en menos sitios deja a un humano leyendo claves.'
        );
      }

      // ── 4. THE INVARIANT: no service can read the language ──
      // The tree is WALKED, not a hand-written list: a list would not know about the
      // service added tomorrow, and the invariant would be lost by omission, which is
      // how invariants are lost. Three things this had to learn:
      //
      //   · ONE HOP. Matching a string in `src/services` is not the same as asking the
      //     graph. `src/types/index.ts` re-exporting `t` hands the catalog to the
      //     twenty services that import that barrel by value, and not one of them
      //     names i18n. So a file that a service imports is read too, and it counts
      //     when it RE-EXPORTS i18n — when the binding travels on.
      //     Importing i18n and keeping it is NOT the hop: `src/utils/errors.ts` does
      //     exactly that (it renders `AppError` messages, pinning English at
      //     construction and taking the language as an argument in `localized`), and
      //     108 of the 198 service files reach it. Counting a plain import would
      //     paint the invariant red for the wrong reason, and a gate that is red for
      //     the wrong reason gets deleted.
      //   · `require()` AND A COMPUTED SPECIFIER. The first loads the same module with
      //     a syntax the old pattern did not know; the second puts the path in a
      //     variable, where no text search can follow it.
      //   · `import type` IS LEFT OUT ON PURPOSE. tsc erases it: it resolves nothing
      //     at run time, so it cannot read a language. Do not "fix" this omission.
      const namesI18n = (specifiers: string[]): boolean => specifiers.some((s) => /\bi18n\b/.test(s));
      const specifiersOf = (source: string): string[] => {
        const out: string[] = [];
        for (const m of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
          const head = source.slice(0, m.index ?? 0);
          const start = Math.max(head.lastIndexOf('import'), head.lastIndexOf('export'));
          if (start >= 0 && /^(?:import|export)\s+type\b/.test(head.slice(start))) continue;
          out.push(m[1]);
        }
        for (const m of source.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
        return out;
      };
      /** Does this file hand i18n ON to whoever imports it? */
      const handsOnI18n = (source: string): boolean => {
        if (/\bexport\s+(?!type\b)[^;]*?\bfrom\s*['"][^'"]*\bi18n\b[^'"]*['"]/.test(source)) return true;
        const bound: string[] = [];
        for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\bi18n\b[^'"]*['"]/g)) {
          for (const part of m[1].split(',')) {
            const name = (part.replace(/\btype\b/, '').split(/\bas\b/).pop() ?? '').trim();
            if (name) bound.push(name);
          }
        }
        if (bound.length === 0) return false;
        return [...source.matchAll(/\bexport\s*\{([^}]*)\}/g)].some((m) =>
          m[1]
            .split(',')
            .some((p) => bound.includes(p.split(/\bas\b/)[0].replace(/\btype\b/, '').trim()))
        );
      };
      const hopTarget = (fromRel: string, specifier: string): string | null => {
        if (!specifier.startsWith('.')) return null;
        const base = path.join(path.dirname(fromRel), specifier).replace(/\.js$/, '');
        for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
          if (existe(candidate)) return candidate;
        }
        return null;
      };
      const opaqueLoad = /\b(?:require|import)\s*\(\s*[^'"\s)]/;
      const seen = new Map<string, boolean>();
      const offenders: string[] = [];
      for (const file of fuentes('src/services')) {
        const rel = path.relative(RAIZ, file);
        const source = codeOf(rel);
        const specifiers = specifiersOf(source);
        if (namesI18n(specifiers)) {
          offenders.push(`${rel} (directo)`);
          continue;
        }
        if (opaqueLoad.test(source)) {
          offenders.push(`${rel} (especificador computado, que ninguna búsqueda puede seguir)`);
          continue;
        }
        for (const specifier of specifiers) {
          const target = hopTarget(rel, specifier);
          if (target === null) continue;
          if (!seen.has(target)) seen.set(target, handsOnI18n(codeOf(target)));
          if (seen.get(target) === true) {
            offenders.push(`${rel} (vía ${target})`);
            break;
          }
        }
      }
      if (offenders.length > 0) {
        return falla(
          `${offenders.length} archivo(s) de src/services alcanzan el catálogo de idioma (${offenders.slice(0, 2).join(', ')}): ` +
            'un servicio sólo puede resolver el idioma del PROCESO, así que la API contestaría siempre en él e ignoraría Accept-Language'
        );
      }

      // ── 5. The catalog covers the WHOLE domain, and the migration declares the
      // domain: a missing label does not throw —the labeller falls back to the key—
      // so nothing else would accuse it.
      const migration = 'src/database/migrations/078_lo_que_se_debe_y_todavia_no_se_paga.sql';
      if (!existe(migration)) {
        return falla(`${migration} ya no está (¿renumerada?): el catálogo de rótulos se quedaría sin dominio contra el que medirse`);
      }
      const check = sinProsa(crudoDe(migration)).match(/CHECK \(fs_category IN \(([\s\S]*?)\)\)/);
      if (!check) {
        return falla('la 078 dejó de declarar el dominio de fs_category en un CHECK: no hay contra qué medir el catálogo');
      }
      // `other` is not in the CHECK and is in the data: report-service mints it
      // for the account that has no category (`acct.fs_category || 'other'`).
      const domain = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).concat('other');
      const unlabelled = domain.filter((c) => !englishCatalog.includes(`'report.category.${c}':`));
      if (unlabelled.length > 0) {
        return falla(
          `${unlabelled.length} categoría(s) del dominio de fs_category sin rótulo en en.ts (${unlabelled.join(', ')}): ` +
            'esa subsección imprimiría su clave cruda a una persona y el rotulador no lanzaría'
        );
      }
      const keysOfLabeller = labeller.match(/REPORT_SECTION_KEYS = \[([\s\S]*?)\] as const;/);
      const sections = keysOfLabeller ? [...keysOfLabeller[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
      if (sections.length < 6) {
        return falla(`el rotulador declara ${sections.length} claves de sección y son seis: alguna quedaría sin rótulo posible`);
      }
      const unlabelledSections = sections.filter((s) => !englishCatalog.includes(`'report.section.${s}':`));
      if (unlabelledSections.length > 0) {
        return falla(`${unlabelledSections.length} sección(es) sin rótulo en en.ts (${unlabelledSections.join(', ')})`);
      }
      // The two catalogs key by key, not by count: two counts match while each side
      // is missing a different key, and `t()` throws in whichever language lacks one.
      const labelKeysOf = (catalog: string): string[] =>
        [...catalog.matchAll(/'(report\.(?:section|category)\.[a-z_]+)':/g)].map((m) => m[1]);
      const englishKeys = labelKeysOf(englishCatalog);
      const spanishKeys = labelKeysOf(spanishCatalog);
      const lopsided = [
        ...englishKeys.filter((k) => !spanishKeys.includes(k)),
        ...spanishKeys.filter((k) => !englishKeys.includes(k)),
      ];
      if (lopsided.length > 0) {
        return falla(
          `${lopsided.length} rótulo(s) de informe existen en un catálogo y no en el otro (${lopsided.slice(0, 3).join(', ')}): ` +
            'el rotulador pregunta por la clave en inglés y luego pide el texto en el idioma del lector, así que ahí lanzaría'
        );
      }
      return ok(
        `los ${domain.length} rótulos de categoría y las ${sections.length} secciones salen del catálogo en el borde; ` +
          'la tabla y el markdown rotulan, csv/tsv/ndjson/json reciben la clave, y ningún archivo de src/services alcanza el idioma'
      );
    },
  },
];
