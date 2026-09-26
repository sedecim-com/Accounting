import * as path from 'node:path';
import {
  codigoDe,
  type Criterio,
  crudoDe,
  existe,
  falla,
  fuentes,
  leer,
  noEvaluable,
  ok,
  rutaDe,
  sinComentarios,
} from './shared.js';

// ============================================================
// THE E2.2 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E2_2: Criterio[] = [

  // ---- E2.2 · Catálogo de autorización ----
  {
    paquete: 'E2.2',
    id: 'single-role-permission-catalog',
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
        .map((f) => ({ rel: path.relative(rutaDe(), f), texto: sinComentarios(leer(f)) }))
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
    id: 'production-boot-rejects-dev-secret',
    enunciado: 'La aplicación no arranca en producción con el secreto de desarrollo',
    evaluar: () => {
      const s = codigoDe('src/config/index.ts');
      return /production/.test(s) && /(jwt|secret)/i.test(s) && /throw/i.test(s)
        ? ok('falla rápido con el valor de ejemplo')
        : falla('un default de desarrollo sobrevive callado a producción');
    },
  },
  {
    paquete: 'E2.2',
    id: 'api-error-message-follows-the-request-language',
    // I9 · issue #151, primer commit. El `code` de un error es contrato de
    // cable y no cambia con el idioma; el `message` es para una persona y sí.
    // Lo que este criterio vigila no es que exista la negociación, sino que la
    // respuesta NO DECLARE un idioma que su cuerpo no tiene: `Content-Language`
    // y `meta.language` salen sólo cuando el mensaje se pintó de una clave del
    // catálogo. Medido cuando se escribió: sin esa condición, un 401 en inglés
    // salía etiquetado `es-MX` y un conflicto de idempotencia en español salía
    // etiquetado `en-US`.
    //
    // Lee el crudo y salta los renglones de comentario por su cuenta, porque
    // `sinComentarios` sigue ciego en archivos grandes y con acentos graves
    // (docs/auditorias/I6.md, I7.md).
    enunciado:
      'El mensaje de un error de la API se pinta en el idioma que negocia la petición, y la respuesta sólo declara idioma cuando lo pintó',
    mutantes: [
      {
        archivo: 'src/api/rest/middleware/error-handler.ts',
        de: '          message: err.localized(language),',
        a: '          message: err.message,',
        porque:
          'idioma-ignorado: el manejador volvería a servir el texto inglés fijo del error mientras la cabecera y meta.language siguen diciendo el idioma que pidió quien llama',
      },
      {
        archivo: 'src/api/rest/middleware/error-handler.ts',
        de: "      res.setHeader('Content-Language', responseLocale(res));",
        a: '      void responseLocale(res);',
        porque:
          'cabecera-que-falta: el cuerpo saldría traducido y sin decirlo, así que una caché no podría distinguir dos respuestas distintas de la misma URL',
      },
      {
        archivo: 'src/index.ts',
        de: '  app.use(negotiateLocale);',
        a: '  // app.use(negotiateLocale);',
        porque:
          'negociacion-desmontada: toda respuesta caería al idioma por omisión y quien pidiera inglés recibiría español sin que nada lo acuse',
      },
    ],
    evaluar: () => {
      const codeLines = (rel: string): string[] =>
        crudoDe(rel)
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

      const handler = 'src/api/rest/middleware/error-handler.ts';
      if (!existe(handler)) return noEvaluable(`${handler} no existe: no hay manejador que juzgar`);
      const handlerCode = codeLines(handler).join('\n');
      if (!/err\.localized\(language\)/.test(handlerCode)) {
        return falla('el manejador de errores dejó de pintar el mensaje en el idioma negociado: serviría el inglés fijo con el que se construyó el error');
      }
      if (!/responseLanguage\(res\)/.test(handlerCode)) {
        return falla('el manejador dejó de leer el idioma de la respuesta: pintaría en el del proceso, que es el de la máquina y no el de quien llama');
      }
      // La condición que hace honesta la etiqueta: cabecera y meta.language
      // SÓLO cuando hay clave. Se exige que las tres cosas cuelguen de `keyed`.
      if (!/const keyed = err\.messageKey !== undefined;/.test(handlerCode)) {
        return falla('el manejador ya no distingue un mensaje pintado de una clave de uno escrito en prosa: etiquetaría con un idioma que el cuerpo puede no tener');
      }
      if (!/if \(keyed\) \{[\s\S]{0,200}Content-Language[\s\S]{0,120}vary\('Accept-Language'\)/.test(handlerCode)) {
        return falla('Content-Language o Vary dejaron de depender de que el mensaje venga de una clave');
      }
      if (!/\.\.\.\(keyed \? \{ language \} : \{\}\)/.test(handlerCode)) {
        return falla('meta.language dejó de depender de que el mensaje venga de una clave');
      }

      // La negociación, montada antes de que nadie pueda contestar.
      const index = codeLines('src/index.ts');
      const mountLine = index.findIndex((l) => /^ {2}app\.use\(negotiateLocale\);$/.test(l));
      if (mountLine === -1) {
        return falla('src/index.ts no monta negotiateLocale en el cuerpo de bootstrap: toda respuesta saldría en el idioma por omisión');
      }
      const auth = index.findIndex((l) => /app\.use\(apiPrefix, authenticate\);/.test(l));
      if (auth !== -1 && mountLine > auth) {
        return falla('negotiateLocale se monta después de authenticate: un 401 no sabría en qué idioma contestar');
      }

      // Y el CLI, que es la otra superficie del mismo error.
      const cliTranslation = codeLines('src/cli/entry-command.ts').join('\n');
      if (!/messageKey !== undefined/.test(cliTranslation)) {
        return falla('translateDomainError volvió a pasar sólo el texto: un error con clave llegaría al contador en inglés aunque trabaje en español');
      }
      return ok('el mensaje sigue el idioma de la petición, y la respuesta sólo declara idioma cuando lo pintó de una clave');
    },
  },
  {
    paquete: 'E2.2',
    id: 'report-api-declares-the-language-it-rendered',
    // I11 · issue #153, THIRD commit — the other half of the contract the
    // criterion above holds, and it is placed right after it on purpose.
    //
    // There, a response declares a language ONLY when the message really came
    // from a catalog key (`const keyed = err.messageKey !== undefined`), because
    // almost every message is still prose and announcing a language over prose
    // is a lie: measured on that commit, an English 401 went out labelled
    // `es-MX`. Here EVERY section label is rendered from a key, so the
    // declaration is unconditional — the same contract applied where it always
    // holds. `key` stays the identity and `name` is the LOCALIZED label
    // (decided in #153): an API that answered only the key would hand every
    // dashboard the job of translating it.
    //
    // WHY `Vary` IS ASKED FOR ON ITS OWN. `Content-Language` tells the caller
    // which language arrived; `Vary: Accept-Language` tells every cache between
    // here and the caller that this URL has more than one representation.
    // Without the second one the first shared cache stores the Spanish balance
    // sheet and serves it to whoever asks next in English — header correct,
    // body wrong, and no test of this process can see it.
    //
    // THE LANGUAGE IS A PARAMETER, and that is the invariant with the longest
    // reach. `localizedSection` takes the language the REQUEST negotiated and
    // never resolves one. A "simplification" that let it ask `getLanguage()`
    // would compile, keep every call site looking right, and answer every HTTP
    // request in the language of the PROCESS — the defect I9 has just closed in
    // the errors, coming back through the door next to it. It does not even
    // take a resolver call: `t()` defaults its third argument to
    // `getLanguage()`, so merely dropping the language from the SUBSECTION call
    // prints Spanish section headings over English subsections.
    //
    // AND THE ASYMMETRY IS WATCHED FROM THIS SIDE TOO. Once two places declare a
    // language, the natural tidy-up is to "unify" them and make the error
    // handler declare unconditionally. That would put the neighbour criterion in
    // red, which is precisely why it is named here as well: the two halves are
    // one contract, and the conditional is the half that is easy to lose.
    enunciado:
      'Los dos extremos de informes rinden sus rótulos en el idioma que negocia la petición, y lo declaran en la cabecera, en Vary y en el sobre',
    mutantes: [
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de: '      assets: localizedSection(report.assets, language),',
        a: '      assets: report.assets,',
        porque:
          'seccion-cruda: el balance publicaría «Assets» en inglés debajo de una cabecera que declara es-MX, con las cifras correctas al lado para que nadie sospeche',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de: '      revenue: localizedSection(report.revenue, language),',
        a: '      revenue: report.revenue,',
        porque:
          'el-otro-estado: la misma sección cruda en el OTRO extremo. Un criterio que mirara el balance —o que sólo contara llamadas— se quedaría verde con el estado de resultados sin traducir',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de: '      equity: localizedSection(report.equity, language),',
        a: "      equity: localizedSection(report.equity, 'es'),",
        porque:
          'idioma-clavado-en-una-seccion: el capital saldría siempre en español mientras sus dos hermanas siguen el Accept-Language, así que el mismo cuerpo llevaría dos idiomas y la cabecera declararía uno',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de: "  res.vary('Accept-Language');",
        a: "  // res.vary('Accept-Language');",
        porque:
          'sin-vary: comentar la línea —la forma más común de retirar una— deja la cabecera en su sitio y la caché ciega: la primera compartida guarda el balance en español y se lo sirve a quien pidió inglés',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de: "  res.setHeader('Content-Language', responseLocale(res));",
        a: '  void responseLocale(res);',
        porque:
          'cuerpo-traducido-que-no-lo-dice: los rótulos salen en el idioma pedido y la respuesta no lo declara, así que quien llama no puede distinguir dos representaciones de la misma URL',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de: '  return responseLanguage(res);',
        a: "  return 'es';",
        porque:
          'la-cabecera-dice-una-cosa-y-el-cuerpo-otra: Content-Language sigue saliendo del locale negociado y los rótulos se rinden siempre en español — la mentira exacta que este contrato existe para no contar',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de:
          '  const report = await getBalanceSheet(entityId, { asOfDate: as_of_date as string });\n' +
          '  const language = declaringLanguage(res);',
        a:
          '  const report = await getBalanceSheet(entityId, { asOfDate: as_of_date as string });\n' +
          '  const language = responseLanguage(res);',
        porque:
          'un-extremo-que-deja-de-declarar: el balance rotula bien y calla; el estado de resultados sigue declarando. Las dos respuestas del balance se cachean como si fueran la misma, y el criterio tiene que mirar los DOS manejadores para verlo',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de:
          '      is_balanced: report.is_balanced,\n' +
          '    },\n' +
          '    meta: { ...meta(req), language },',
        a: '      is_balanced: report.is_balanced,\n    },\n    meta: meta(req),',
        porque:
          'sobre-que-no-lo-dice: un tablero que lee el cuerpo y no las cabeceras —que son casi todos— se queda sin saber en qué idioma están los rótulos que pinta',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de:
          '      net_income: report.net_income,\n' +
          '      ...(report.closing ? { closing_entries: report.closing } : {}),\n' +
          '    },\n' +
          '    meta: { ...meta(req), language },',
        a:
          '      net_income: report.net_income,\n' +
          '      ...(report.closing ? { closing_entries: report.closing } : {}),\n' +
          '    },\n' +
          '    meta: meta(req),',
        porque:
          'el-mismo-sobre-en-el-otro-extremo: `meta: { ...meta(req), language }` aparece DOS veces en el archivo, así que un ancla corta mutaría siempre la primera y la segunda mitad del contrato viajaría sin espejo',
      },
      {
        archivo: 'src/api/rest/routes/reports.ts',
        de: '  const report = await getTrialBalance(entityId, {',
        a: '  void declaringLanguage(res);\n  const report = await getTrialBalance(entityId, {',
        porque:
          'idioma-declarado-sobre-prosa-del-inquilino: la balanza no rinde ni un rótulo del catálogo —`account_name` sale de la base del inquilino—, así que anunciar idioma ahí es la misma mentira que I9 quitó de los errores, y es lo que pasa cuando se «unifica» la declaración por toda la ruta',
      },
      {
        archivo: 'src/i18n/report-labels.ts',
        de:
          'export function localizedSection<T extends LabelledSection>(section: T, language: Language): T {\n' +
          '  const named = { ...section, name: reportSectionLabel(section.key, language) };',
        a:
          'export function localizedSection<T extends LabelledSection>(section: T): T {\n' +
          '  const language = getLanguage();\n' +
          '  const named = { ...section, name: reportSectionLabel(section.key, language) };',
        porque:
          'el-idioma-resuelto-dentro: la «simplificación» compila, deja intactos los cinco sitios de llamada y hace que la API conteste SIEMPRE en el idioma del proceso ignorando Accept-Language; ninguna prueba de unidad, que corre en un solo proceso, lo nota',
      },
      {
        archivo: 'src/i18n/report-labels.ts',
        de: '      name: subsectionLabel(sub.key, language),',
        a: '      name: subsectionLabel(sub.key),',
        porque:
          'recibirlo-y-no-pasarlo: `t()` cae por omisión a `getLanguage()`, así que basta con dejar de pasar el idioma UNA vez para que las subsecciones salgan en el del proceso debajo de secciones rotuladas en el del lector',
      },
      {
        archivo: 'src/api/rest/middleware/error-handler.ts',
        de:
          '    if (keyed) {\n' +
          "      res.setHeader('Content-Language', responseLocale(res));\n" +
          "      res.vary('Accept-Language');\n" +
          '    }',
        a:
          "    res.setHeader('Content-Language', responseLocale(res));\n" +
          "    res.vary('Accept-Language');",
        porque:
          'la-unificacion-que-rompe-la-otra-mitad: al ver dos sitios declarando idioma, lo natural es igualarlos — y allí no se puede, porque casi todo mensaje sigue siendo prosa: un 401 inglés volvería a salir etiquetado es-MX',
      },
      {
        archivo: 'src/api/rest/middleware/error-handler.ts',
        de: '    const keyed = err.messageKey !== undefined;',
        a: '    const keyed = true;',
        porque:
          'la-condicion-vaciada-por-dentro: la forma del `if` sobrevive y la distinción desaparece, así que la cabecera y meta.language salen sobre prosa con toda la estructura intacta',
      },
    ],
    evaluar: () => {
      // Read the raw source through the seam and drop comment lines by hand:
      // `sinComentarios` goes blind on big files and on comments with backticks
      // (docs/auditorias/I6.md, I7.md), and the prose around these routes quotes
      // the very headers that are required here. A criterion that reads its own
      // explanation does not measure.
      const codeOf = (rel: string): string =>
        crudoDe(rel)
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n');

      /** One top-level declaration, from its keyword to the next one. */
      const declarationOf = (source: string, name: string): string => {
        const start = Math.max(
          source.indexOf(`function ${name}(`),
          source.indexOf(`function ${name}<`),
          source.indexOf(`const ${name} =`)
        );
        if (start === -1) return '';
        const rest = source.slice(start);
        const end = rest.slice(1).search(/\n(?:export )?(?:function|const|interface|type|import|class|enum) /);
        return end === -1 ? rest : rest.slice(0, end + 1);
      };

      /** One route handler, from its `router.get(` to the next one. */
      const handlerOf = (source: string, route: string): string => {
        const start = source.indexOf(`router.get('${route}'`);
        if (start === -1) return '';
        const rest = source.slice(start);
        const end = rest.slice(1).indexOf('\nrouter.get(');
        return end === -1 ? rest : rest.slice(0, end + 1);
      };

      const routes = 'src/api/rest/routes/reports.ts';
      if (!existe(routes)) return noEvaluable(`${routes} no existe: no hay extremo de informes que juzgar`);
      const api = codeOf(routes);

      // ── 1. The labeller comes from the edge, not from a copy living in the route ──
      if (!/import \{ localizedSection \} from '[^']*i18n\/report-labels\.js'/.test(api)) {
        return falla(
          'reports.ts dejó de importar localizedSection del rotulador del borde: el rótulo volvería a componerse dentro de la ruta, ' +
            'donde ni el catálogo ni la invariante de servicios lo alcanzan'
        );
      }

      // ── 2. The declaration itself: header, Vary, and the language of the RESPONSE ──
      const declaring = declarationOf(api, 'declaringLanguage');
      if (declaring === '') {
        return falla(
          'reports.ts ya no declara declaringLanguage: cada extremo tendría que acordarse por su cuenta de decir en qué idioma contesta, ' +
            'y el que se olvide no lo acusa nadie'
        );
      }
      if (!/res\.setHeader\('Content-Language', responseLocale\(res\)\)/.test(declaring)) {
        return falla(
          'declaringLanguage dejó de poner Content-Language: el cuerpo saldría con los rótulos traducidos sin decirlo, ' +
            'y quien llama no puede saber qué recibió'
        );
      }
      // Asked for APART from the header, because it is the half that looks
      // redundant and is not: without it the header is a label on a document the
      // cache is free to hand to somebody who asked for the other language.
      if (!/res\.vary\('Accept-Language'\)/.test(declaring)) {
        return falla(
          'declaringLanguage dejó de poner Vary: Accept-Language: la primera caché compartida guardaría el balance en español ' +
            'y se lo serviría a quien pidió inglés, con la cabecera correcta encima'
        );
      }
      if (!/return responseLanguage\(res\)/.test(declaring)) {
        return falla(
          'declaringLanguage devuelve un idioma que no es el negociado: la cabecera diría uno y los rótulos saldrían en otro, ' +
            'que es exactamente la mentira que este contrato existe para no contar'
        );
      }

      // ── 3. Both statements: every section labelled, declared, and said in meta ──
      const statements: [string, string, string[]][] = [
        ['/balance-sheet', 'el balance', ['assets', 'liabilities', 'equity']],
        ['/income-statement', 'el estado de resultados', ['revenue', 'expenses']],
      ];
      let labelled = 0;
      for (const [route, what, sections] of statements) {
        const handler = handlerOf(api, route);
        if (handler === '') {
          return falla(`reports.ts ya no publica ${route}: el extremo que rinde ${sections.length} secciones rotuladas desapareció`);
        }
        if (!/const language = declaringLanguage\(res\);/.test(handler)) {
          return falla(
            `${route} no toma su idioma de declaringLanguage: rendiría rótulos traducidos sin cabecera y sin Vary mientras su hermano ` +
              'sí los declara, y sus dos representaciones se cachearían como si fueran una'
          );
        }
        for (const section of sections) {
          // The section, the language, and the pairing between them: a call that
          // labels `assets` with the liabilities section, or with a pinned
          // language, is as wrong as no call at all and looks right in a diff.
          if (!new RegExp(`\\b${section}: localizedSection\\(report\\.${section}, language\\),`).test(handler)) {
            return falla(
              `${what} publica «${section}» sin rotularla con el idioma de la petición: saldría con el nombre inglés que acuña el ` +
                'servicio, o con uno clavado, debajo de una cabecera que declara otro'
            );
          }
          labelled++;
        }
        const raw = handler
          .split('\n')
          .filter((l) =>
            sections.some(
              (s) => new RegExp(`\\breport\\.${s}\\b`).test(l) && !l.includes(`localizedSection(report.${s}, language)`)
            )
          );
        if (raw.length > 0) {
          return falla(`${what} publica además una sección sin rotular: «${raw[0].trim()}»`);
        }
        if (!/meta: \{ \.\.\.meta\(req\), language \}/.test(handler)) {
          return falla(
            `${route} dejó de llevar language en el sobre: un tablero que lee el cuerpo y no las cabeceras —que son casi todos— ` +
              'se queda sin saber en qué idioma están los rótulos que pinta'
          );
        }
      }

      // ── 4. Whoever declares a language has rendered one ──
      // The honest half of the contract, written in the direction that does not
      // go stale: a handler is free to start labelling tomorrow, but the day one
      // declares a language over rows taken from the tenant's own database
      // —`account_name` in the trial balance— it tells the caller something that
      // is not true. That is the I9 defect, arriving from the other side.
      for (const block of api.split(/\nrouter\.get\(/).slice(1)) {
        const handler = `router.get(${block}`;
        if (/declaringLanguage\(/.test(handler) && !/localizedSection\(/.test(handler)) {
          const route = /^router\.get\('([^']+)'/.exec(handler)?.[1] ?? '(sin ruta)';
          return falla(
            `${route} declara un idioma y no rinde ni un rótulo del catálogo: sus columnas salen de la base del inquilino, ` +
              'así que anunciar Content-Language ahí es la misma mentira que I9 quitó de los errores'
          );
        }
      }

      // ── 5. The language ENTERS the labeller; it is never resolved inside ──
      const edge = 'src/i18n/report-labels.ts';
      if (!existe(edge)) {
        return falla(`${edge} no existe: la ruta importa un rotulador que ya no está, y el informe no llegaría a servirse`);
      }
      const labeller = codeOf(edge);
      const localized = declarationOf(labeller, 'localizedSection');
      if (localized === '') {
        return falla(`${edge} dejó de declarar localizedSection: la API no tendría de dónde sacar la sección ya rotulada`);
      }
      if (!/\blanguage: Language\b/.test(localized.slice(0, localized.indexOf('{')))) {
        return falla(
          'localizedSection dejó de recibir el idioma como parámetro obligatorio: sólo podría resolver el del PROCESO, ' +
            'así que la API contestaría siempre en el idioma de la máquina e ignoraría Accept-Language'
        );
      }
      if (/\b(?:getLanguage|setLanguage|resolveLocale|responseLanguage|responseLocale)\(/.test(labeller)) {
        return falla(
          `${edge} resuelve el idioma por su cuenta: el rotulador del borde existe justamente para no poder hacerlo, y un informe ` +
            'de la API volvería a salir en el idioma del proceso con toda la cadena de llamadas intacta'
        );
      }
      // Receiving the language and not PASSING it is the same defect one call
      // deeper, and it is silent: `t()` defaults its third argument to
      // `getLanguage()`, so a labeller call without it falls back to the process
      // language while the section above it is rendered correctly.
      const passes = localized + declarationOf(labeller, 'subsectionLabel');
      for (const call of passes.matchAll(/\b(subsectionLabel|reportSectionLabel|reportCategoryLabel)\(([^)]*)\)/g)) {
        // The signature neighbour: `nombre(` matches the declaration as well as
        // the use, and a declaration's parameter list ends in the TYPE. Judging
        // it as a call would paint this red on correct code, which is how a
        // guard gets deleted.
        if (/\bfunction\s+$/.test(passes.slice(0, call.index))) continue;
        if (!/,\s*language$/.test(call[2].trim())) {
          return falla(
            `el rotulador llama a ${call[1]}(${call[2]}) sin pasarle el idioma: t() cae por omisión al del proceso, ` +
              'así que ese rótulo saldría en el de la máquina debajo de los que sí siguieron la petición'
          );
        }
      }

      // ── 6. The asymmetry with the errors, intact ──
      const errorHandler = 'src/api/rest/middleware/error-handler.ts';
      if (!existe(errorHandler)) {
        return noEvaluable(`${errorHandler} no existe: no hay con qué comparar la otra mitad del contrato`);
      }
      const errors = codeOf(errorHandler);
      if (!/const keyed = err\.messageKey !== undefined;/.test(errors)) {
        return falla(
          'el manejador de errores dejó de distinguir el mensaje pintado de una clave del escrito en prosa: unificarlo con estos dos ' +
            'extremos vuelve a etiquetar es-MX un 401 inglés, que es lo que I9 midió y quitó'
        );
      }
      if (!/if \(keyed\) \{[\s\S]{0,200}Content-Language[\s\S]{0,120}vary\('Accept-Language'\)/.test(errors)) {
        return falla(
          'la cabecera del manejador de errores dejó de colgar de `keyed`: aquí la declaración es incondicional porque TODO rótulo sale ' +
            'de una clave, y allí no puede serlo porque casi todo mensaje sigue siendo prosa'
        );
      }

      return ok(
        `los dos extremos rinden sus ${labelled} secciones con el idioma que negocia la petición y lo declaran en Content-Language, ` +
          'en Vary y en meta.language; el rotulador lo recibe como parámetro, y el manejador de errores conserva su condición'
      );
    },
  },
];
