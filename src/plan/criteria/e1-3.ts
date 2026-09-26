import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  codigoDe,
  type Criterio,
  crudoDe,
  dondeAparece,
  existe,
  falla,
  leer,
  noEvaluable,
  ok,
  rutaDe,
} from './shared.js';

// ============================================================
// THE E1.3 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E1_3: Criterio[] = [


  // ---- E1.3 · Políticas con consumidor ----
  {
    paquete: 'E1.3',
    id: 'every-policy-key-has-reader',
    // La versión anterior de este criterio preguntaba si `getPolicy` tenía
    // llamadores. Es un proxy, y uno malo: se puede llamar getPolicy una vez y
    // dejar nueve políticas muertas, y el criterio quedaría en verde. Lo que
    // importa es lo otro — que contestar una política cambie algo.
    enunciado: 'Contestar una política cambia el comportamiento de alguien',
    evaluar: () => {
      const catalogo = rutaDe('src', 'services', 'policy', 'pending-catalog.ts');
      if (!fs.existsSync(catalogo)) return noEvaluable('no existe el catálogo de políticas');
      const claves = [...leer(catalogo).matchAll(/key:\s*'([a-z0-9_]+)'/g)]
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
      //
      // LA CLAVE PUEDE VIAJAR EN UNA CONSTANTE, y eso no la hace huérfana.
      // F08a puso el defecto delante: `leerRegistroDelSubsidio` llama a
      // getPolicy con CLAVE_POLITICA_SUBSIDIO_ENTREGADO, declarada tres líneas
      // arriba con esa cadena exacta, y el criterio la contó como no leída. El
      // instrumento medía un MODISMO —la literal pegada al paréntesis— y no el
      // hecho, así que empujaba a duplicar la cadena en el sitio donde el
      // compilador ya la tenía. Se acepta la constante sólo si el MISMO archivo
      // la declara con esa clave y la pasa a un lector: un identificador suelto
      // que se llame parecido no cuenta, igual que no cuenta una coincidencia
      // de cadena.
      const leePorConstante = (k: string): boolean =>
        dondeAparece(new RegExp(`const\\s+([A-Za-z0-9_$]+)\\s*=\\s*['\`"]${k}['\`"]`), ['src'], true)
          .filter(ajeno)
          .some((f) => {
            const fuente = codigoDe(f);
            const decl = new RegExp(`const\\s+([A-Za-z0-9_$]+)\\s*=\\s*['\`"]${k}['\`"]`).exec(fuente);
            if (decl === null) return false;
            return new RegExp(`getPolicy(Number)?\\s*\\([\\s\\S]{0,120}?\\b${decl[1]}\\b`).test(fuente);
          });

      const huerfanas = claves.filter(
        (k) =>
          dondeAparece(
            new RegExp(`getPolicy(Number)?\\s*\\([\\s\\S]{0,120}?['\`"]${k}['\`"]`),
            ['src'],
            true
          ).filter(ajeno).length === 0 && !leePorConstante(k)
      );
      return huerfanas.length === 0
        ? ok(`${claves.length} políticas, todas leídas por algún consumidor`)
        : falla(
            `${huerfanas.length} de ${claves.length} políticas no las lee nadie ` +
              `(${huerfanas.join(', ')}): el usuario las contesta y no cambian nada`
          );
    },
  },

  // ---- A7 · Una sola puerta al auto-posteo ----

  {
    paquete: 'E1.3',
    id: 'policy-panel-owns-auto-post',
    enunciado: 'Encender el auto-posteo es del panel: la bandera y el archivo sólo pueden ser más estrictos',
    evaluar: () => {
      // A7: el piso de evidencia (A4) vive en el panel, así que cualquier capa
      // que encienda por su cuenta lo rodea ENTERO. La auditoría integral II
      // lo ejecutó: panel en 'shadow' + archivo en true = posteo real, sin un
      // solo veredicto de sombra registrado. Contestar «mídelo primero»
      // producía posteo con cero evidencia, en silencio.
      //
      // La regla ya existía para el tope de monto y ahora rige las tres
      // decisiones: apagar y apretar son de cualquiera; encender y aflojar,
      // sólo del despacho.
      const t = codigoDe('src/ai/ingest-thresholds.ts');
      // La forma exacta de la asimetría: encender exige que el panel ya lo
      // hubiera autorizado. Un `autoPost = valor` suelto la rompe.
      if (!/const autorizado = polAuto\.defined/.test(t)) {
        return falla('el interruptor dejó de derivarse del panel: la capa local volvería a poder encender');
      }
      if (!/if \(valor === false\) \{/.test(t) || !/if \(autorizado\) \{/.test(t)) {
        return falla('la asimetría perdió su forma: apagar y encender volverían a tratarse igual');
      }
      // Y el intento ignorado no desaparece: el operador tiene que poder
      // entender por qué su `true` no hizo nada.
      if (!/encendidoIgnorado/.test(t) || !/encendidoIgnorado/.test(codigoDe('src/cli/mnemosine.ts'))) {
        return falla('un encendido ignorado volvería a ser silencioso: el operador no sabría por qué su archivo no hace nada');
      }
      // El tope: la bandera vivía FUERA de la regla que el archivo ya
      // respetaba, así que --max-amount subía el techo del panel.
      return /const tope = maxPolitica \?\? Infinity/.test(t)
        ? ok('encender y aflojar el tope son del panel; apagar y apretar, de cualquier capa, y lo ignorado se dice')
        : falla('la bandera puede volver a aflojar el tope por encima de lo que el despacho contestó');
    },
    mutantes: [
      {
        archivo: 'src/ai/ingest-thresholds.ts',
        de: 'if (autorizado) {',
        a: 'if (true) {',
        porque: 'la capa local vuelve a encender sobre un panel que no lo autorizó: la puerta que A7 cerró',
      },
      {
        archivo: 'src/ai/ingest-thresholds.ts',
        de: 'const tope = maxPolitica ?? Infinity;',
        a: 'const tope = Infinity;',
        porque: 'la bandera vuelve a aflojar el tope por encima del panel',
      },
    ],
  },
  {
    paquete: 'E1.3',
    id: 'shadow-evidence-matches-enabled-mode',
    enunciado: 'La sombra mide el modo que se va a encender, y la decisión se escribe donde se midió',
    evaluar: () => {
      // A7, dos mitades de la misma idea: la evidencia sólo autoriza si mide
      // LO MISMO que se enciende, y en el MISMO alcance.
      //
      // (1) Desde A3 el modo encendido tiene dos vías: el umbral y, cuando una
      //     compuerta discrecional no basta, la política otorgada. Una sombra
      //     ciega a la segunda acumula evidencia sobre un clasificador más
      //     conservador que el real.
      const ing = codigoDe('src/ai/ingest-service.ts');
      if (!/wouldMatchApproval\(/.test(ing)) {
        return falla('la sombra volvió a medir sólo el umbral: la evidencia validaría un clasificador que no es el que se enciende');
      }
      if (!/wouldAutoPost: habriaPosteado/.test(ing)) {
        return falla('el veredicto registrado dejó de incluir la vía de política');
      }
      // La sombra NO puede gastar políticas: el emparejador de solo lectura
      // existe justo para eso, y debe seguir sin tocar last_used_at.
      const ap = codigoDe('src/ai/approval-policy.ts');
      const iWould = ap.indexOf('export async function wouldMatchApproval');
      const cuerpo = iWould >= 0 ? ap.slice(iWould, ap.indexOf('export async function matchApproval')) : '';
      if (!cuerpo || /UPDATE ai_approval_policies/.test(cuerpo)) {
        return falla('el emparejador de sombra escribe: una sombra con efectos gasta las políticas que dice sólo observar');
      }
      // (2) El alcance: la evidencia se mide por entidad y la decisión se
      //     escribía sin acotar, así que siete días de sombra en UNA entidad
      //     encendían el auto-posteo de todas.
      const ps = codigoDe('src/services/policy/policy-service.ts');
      return /AND entity_id IS NOT DISTINCT FROM \$6::uuid/.test(ps)
        ? ok('la sombra consulta la vía de política sin consumirla, y la decisión se resuelve en el alcance que se midió')
        : falla('resolvePolicy volvió a escribir sin acotar por entidad: la evidencia de una entidad encendería a todas');
    },
    mutantes: [
      {
        archivo: 'src/services/policy/policy-service.ts',
        de: 'AND entity_id IS NOT DISTINCT FROM $6::uuid',
        a: '',
        porque: 'la decisión vuelve a escribirse sin alcance: la evidencia de una entidad enciende a todas (pilar 6 del plan)',
      },
      {
        archivo: 'src/ai/ingest-service.ts',
        de: 'wouldAutoPost: habriaPosteado',
        a: 'wouldAutoPost: veredicto.procede',
        porque: 'la sombra vuelve a registrar sólo el umbral y la evidencia mide un modo distinto del que se enciende',
      },
    ],
  },

  {
    paquete: 'E1.3',
    id: 'policy-panel-governs-writeoff-account',
    enunciado: 'A qué cuenta va un saldo condonado lo decide el panel, y sin motivo escrito no se condona',
    mutantes: [
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: "if (residual && !opts.shortPayReason?.trim()) {",
        a: 'if (false) {',
        porque: 'un pasivo podría desaparecer sin una línea que explique por qué: es lo único que el auditor tiene',
      },
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: "      ? await getPolicy({ tenantId, entityId }, 'pago_corto_residual')",
        a: "      ? { key: 'x', value: 'descuento_compras', defined: true, question: '', rationale: null }",
        porque: 'la cuenta se cablea en el código y el panel deja de gobernarla: la opción «prohibir» del despacho no se aplicaría nunca',
      },
    ],
    evaluar: () => {
      // Una bifurcación de criterio contable no se pregunta por chat ni se
      // elige en el código: se añade al panel. Aquí la bifurcación es a dónde
      // va el saldo que deja de deberse —menos costo (5200) u otro ingreso
      // (4200)—, y hasta puede estar prohibido cerrar corto. El código postea
      // lo que el panel dicte.
      const cat = codigoDe('src/services/policy/pending-catalog.ts');
      const svc = codigoDe('src/services/payments/payment-service.ts');
      const post = codigoDe('src/services/accounting/ar-ap-posting.ts');

      // 1. La decisión está en el panel, con sus tres salidas.
      //
      // El recorte va de SU clave a la siguiente entrada del catálogo (o al
      // final), no por una ventana de N caracteres: la primera versión usaba
      // 1400 y la prosa de `whyAsking`/`whatIDo` empujaba `priority:` más
      // allá, así que el criterio fallaba por la longitud del texto y no por
      // lo que mide. Una ventana fija es una ancla que caduca cuando alguien
      // escribe de más.
      const desde = cat.indexOf("key: 'pago_corto_residual'");
      if (desde < 0) {
        return falla('la decisión pago_corto_residual desapareció del panel');
      }
      const siguiente = cat.indexOf("\n    key: '", desde);
      const spec = cat.slice(desde, siguiente < 0 ? cat.length : siguiente);
      const opciones = ['descuento_compras', 'otros_ingresos', 'prohibir'].filter(
        (o) => !new RegExp(`value: '${o}'`).test(spec)
      );
      if (opciones.length > 0) {
        return falla(
          `la decisión pago_corto_residual perdió opciones del panel: ${opciones.join(', ')}`
        );
      }

      // 2. Y TIENE LECTOR. Un panel sin lector es decoración: la regla de la
      //    casa es que la decisión y quien la obedece viajan en el mismo
      //    commit.
      if (!/getPolicy\([\s\S]{0,80}?'pago_corto_residual'\)/.test(svc)) {
        return falla('pago_corto_residual no se lee en ninguna parte: sería una pregunta sin consecuencia');
      }

      // 3. «prohibir» PROHÍBE de verdad. Se ancla el throw, no el `if`.
      if (!/politica\?\.value === 'prohibir'[\s\S]{0,300}?throw new ValidationError\(/.test(svc)) {
        return falla('la opción «prohibir» del panel ya no impide cerrar un gasto pagando de menos');
      }

      // 4. La capa de asiento NO decide: recibe la cuenta y se niega a postear
      //    sin ella, en vez de suponer una.
      if (!/writeOffRole\?: 'devolucion_compras' \| 'otros_ingresos'/.test(post)) {
        return falla('el asiento dejó de recibir la cuenta del pago corto como parámetro: la estaría eligiendo él');
      }
      if (!/condonado\.greaterThan\(0\) && !writeOffRole[\s\S]{0,300}?throw new AccountingError\(/.test(post)) {
        return falla('el asiento postearía un pago corto sin saber a qué cuenta: elegiría una por su cuenta o descuadraría');
      }

      // 5. Sin motivo escrito no se condona.
      const motivo = /if \(residual && !opts\.shortPayReason\?\.trim\(\)\) \{[\s\S]{0,300}?throw new ValidationError\(/.test(svc);
      return motivo
        ? ok('la cuenta del pago corto la dicta el panel (con «prohibir» que prohíbe), el asiento la recibe y sin motivo escrito no se condona')
        : falla('cerrar un gasto pagando de menos ya no exige motivo: el pasivo desaparecería sin explicación');
    },
  },
  {
    paquete: 'E1.3',
    id: 'pending-explains-policy-with-preview',
    enunciado:
      'La capa explicativa vive donde se decide, no sólo en el alta: pending imprime los tres campos del catálogo, pide el preview con el contexto de la entidad y no enseña prosa sin envolver',
    mutantes: [
      {
        archivo: 'src/cli/pending-command.ts',
        de: "    out.push(...wrapLines('   ', '   ', wording.question));",
        a: '    out.push(`   ${wording.question}`);',
        porque:
          'prosa-sin-envolver: las 21 políticas del catálogo tienen impact de más de 72 caracteres (la más larga, 406) y el terminal las reflowa a columna cero, perdiendo la sangría que dice a qué clave pertenece cada cosa',
      },
    ],
    evaluar: () => {
      const cli = codigoDe('src/cli/pending-command.ts');
      // The wording comes from the CATALOG through `policyWording` (I10 ·
      // #152); the explanatory fields below still come from the spec. That
      // the row's copy is never read is judged by
      // `policy-wording-comes-from-the-catalog`, next to this criterion.
      if (!/policyWording\(/.test(cli) || !/getPolicySpec\(/.test(cli)) {
        return falla('pending dejó de leer el catálogo: imprimiría el texto congelado al sembrar, que caduca sin avisar');
      }
      for (const campo of ['whyAsking', 'whatIDo', 'ifSkipped']) {
        if (!new RegExp(`spec\\??\\.${campo}`).test(cli)) {
          return falla(
            `pending dejó de imprimir ${campo}: la capa explicativa volvería a existir sólo en el alta, el único momento en que no tiene datos que enseñar`
          );
        }
      }
      // El preview, con el contexto de la ENTIDAD: sin él el ejemplo
      // deja de ser el del cliente, que es lo único que lo hace valer.
      if (!/previewFor\(/.test(cli)) {
        return falla('pending dejó de pedir la vista previa: el contador vería la pregunta sin sus propios datos debajo');
      }
      // Envoltura en las DOS pantallas, cada una con su ancla PROPIA.
      // Contar llamadas con un umbral era holgura: sobran sitios
      // envueltos, así que quitar uno dejaba el conteo por encima del
      // tope y el mutante pasaba en verde. Arreglar el listado y no el
      // prompt de define es reparar la instancia: son la misma decisión
      // vista dos veces, y el prompt es el instante en que se toma.
      if (!/wrapLines\('   ', '   ', wording\.question\)/.test(cli)) {
        return falla('el listado de pending dejó de envolver la pregunta: la prosa del catálogo saldría a columna cero, sin la sangría que dice a qué clave pertenece');
      }
      if (!/for \(const l of wrapLines\('', '', wording\.question\)\)/.test(cli)) {
        return falla('el prompt de «pending define» dejó de envolver la pregunta: la mitad de la envoltura volvería a llegar a una sola de las dos pantallas');
      }
      const envueltos = (cli.match(/wrapLines\(/g) ?? []).length;
      return ok(`la capa explicativa vive en pending con su preview y ${envueltos - 1} campos envueltos en las dos pantallas`);
    },
  },
  {
    paquete: 'E1.3',
    id: 'policy-wording-comes-from-the-catalog',
    // I10 · issue #152, first commit. `seedPolicies` copies question, impact,
    // options and default_rationale into every row with ON CONFLICT DO NOTHING,
    // so those columns hold the catalog as it was on the tenant's seed day.
    // Every screen that painted them showed a different panel depending on when
    // the tenant was created, and no fix to the catalog text reached an
    // existing tenant. The wording now goes through ONE seam,
    // `policyWording` in policy-service.ts, and this criterion keeps it there.
    //
    // It reads the RAW source and skips comment lines itself instead of using
    // `codigoDe`: `sinComentarios` fails on large files and on comments with
    // backticks (docs/auditorias/I6.md, I7.md), and a criterion that counts
    // reads "in code" would inherit that blindness.
    enunciado:
      'El texto del panel de políticas sale del catálogo: ninguna pantalla lee la copia sembrada en la fila, y la costura es su único lector',
    mutantes: [
      {
        archivo: 'src/cli/pending-command.ts',
        de: "      out.push(...field('impact', wording.impact, c));",
        a: "      out.push(...field('impact', p.impact, c));",
        porque:
          'texto-del-dia-de-siembra: `pending -v` volvería a pintar el impacto copiado al sembrar, que para un inquilino antiguo es el catálogo de aquel día y no el de hoy',
      },
      {
        archivo: 'src/ai/tools/policy-tools.ts',
        de: '      question: wording.question,',
        a: '      question: fila.question,',
        porque:
          'el-agente-ve-otro-panel: la herramienta del agente entregaría la pregunta sembrada mientras `pending` enseña la del catálogo, y los dos contestarían sobre textos distintos',
      },
      {
        archivo: 'src/services/policy/policy-service.ts',
        de: '      question: policyWording(row).question,',
        a: '      question: row.question,',
        porque:
          'lectura-fuera-de-la-costura: getPolicy leería la copia de la fila por su cuenta y la costura dejaría de ser el único sitio que decide de dónde sale el texto',
      },
      {
        archivo: 'src/ai/memory-service.ts',
        de: '    const valores = policyOptions(row.policy_key, seeded)',
        a: '    const valores = (seeded ?? [])',
        porque:
          'vocabulario-del-dia-de-siembra: el mismo precedente seria contradicción para un inquilino sembrado después de que `ingest_auto_post` ganara `shadow`, y silencio para uno sembrado antes',
      },
    ],
    evaluar: () => {
      const codeLines = (rel: string): string[] =>
        crudoDe(rel)
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
      const seededRead = /\b(p|row|fila)\.(question|impact|options|default_rationale)\b/;

      const screens = [
        'src/cli/pending-command.ts',
        'src/cli/init/s4-policies.ts',
        'src/ai/tools/policy-tools.ts',
      ];
      for (const rel of screens) {
        if (!existe(rel)) return noEvaluable(`${rel} no existe: no hay pantalla que juzgar`);
        const lines = codeLines(rel);
        if (!lines.some((l) => /policyWording\(/.test(l))) {
          return falla(`${rel} dejó de pedir el texto a policyWording: pinta desde otro sitio que la costura no controla`);
        }
        const reads = lines.filter((l) => seededRead.test(l));
        if (reads.length > 0) {
          return falla(
            `${rel} lee la copia sembrada en la fila (${reads.length} renglón(es), p. ej. «${reads[0].trim()}»): ` +
              'para un inquilino antiguo eso es el catálogo del día de su siembra'
          );
        }
      }

      // The seam is the ONLY reader of the seeded columns in policy-service.
      const service = crudoDe('src/services/policy/policy-service.ts');
      const start = service.indexOf('function seedSnapshotWording(');
      const end = start === -1 ? -1 : service.indexOf('\n}\n', start);
      if (start === -1 || end === -1) {
        return falla('policy-service.ts perdió seedSnapshotWording: ya no hay un único lector nombrado de la copia sembrada');
      }
      const inside = service.slice(start, end);
      const outside = service.slice(0, start) + service.slice(end);
      const rowRead = /\brow\??\.(question|impact|options|default_rationale)\b/;
      if (!rowRead.test(inside)) {
        return falla('seedSnapshotWording ya no lee la fila: una clave retirada se quedaría sin texto');
      }
      const strays = outside
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && rowRead.test(l));
      if (strays.length > 0) {
        return falla(`policy-service.ts lee la copia sembrada fuera de la costura: «${strays[0].trim()}»`);
      }

      if (!/policyOptions\(/.test(codeLines('src/ai/memory-service.ts').join('\n'))) {
        return falla('memory-service volvió a tomar el vocabulario de opciones de la fila: la detección de contradicciones depende otra vez del día de siembra');
      }
      return ok(`las ${screens.length} pantallas del panel y la memoria del agente piden el texto a la costura, que es su único lector`);
    },
  },
  {
    paquete: 'E1.3',
    id: 'policy-panel-reaches-deciding-turn',
    enunciado:
      'El panel del despacho llega al turno que decide, y una política sin contestar se pregunta en vez de aplicarse el defecto',
    mutantes: [
      {
        archivo: 'src/ai/ingest-service.ts',
        de: "2. READ YOUR FIRM'S POLICY PANEL with get_accounting_policies BEFORE deciding the treatment.",
        a: '2. Decide the accounting treatment with your own judgement.',
        porque:
          'la-herramienta-que-nadie-pide: la pieza correcta a una llamada de función de donde hace falta — el panel existe, la herramienta existe, y el turno que clasifica el CFDI decide sin mirarlo',
      },
    ],
    evaluar: () => {
      // La herramienta existe Y el turno la pide. Lo primero sin lo segundo es
      // exactamente la tesis que la auditoría III le puso al producto.
      if (!existe('src/ai/tools/policy-tools.ts')) {
        return falla('la herramienta del panel desapareció: el agente vuelve a decidir sin ver lo que el despacho contestó');
      }
      const prompt = codigoDe('src/ai/ingest-service.ts');
      if (!/get_accounting_policies/.test(prompt)) {
        return falla('el prompt de la ingesta dejó de pedir el panel: el CFDI de 12 000 se clasifica sin que el umbral del despacho exista en el contexto');
      }
      // Y la superficie la lleva: una herramienta fuera de la lista nombrada
      // no llega al turno aunque esté registrada.
      const sup = codigoDe('src/ai/tools/superficie.ts');
      return /get_accounting_policies/.test(sup)
        ? ok('el panel llega al turno que decide, por prompt y por superficie')
        : falla('get_accounting_policies salió de la superficie nombrada: existiría sin llegar a la corrida que la necesita');
    },
  },
  {
    paquete: 'E1.3',
    id: 'blank-policy-value-never-decides',
    enunciado:
      'Una política contestada en blanco no está contestada, y el motor no la lee como cero',
    mutantes: [
      {
        archivo: 'src/services/policy/policy-service.ts',
        de: "  if (value.trim() === '') {",
        a: '  if (false) {',
        porque:
          'respuesta-en-blanco: la fila entra como «resolved» con el valor vacío y el sistema se la presenta al agente bajo el sello «tu despacho decidió esto» — y un piso más abajo Number("  ") es 0, así que el umbral de capitalización del motor queda en CERO',
      },
    ],
    evaluar: () => {
      const svc = codigoDe('src/services/policy/policy-service.ts');
      // La ESCRITURA: se corta donde entra, que es el único sitio que cubre a
      // los dos llamadores (pending define y el asistente del alta). La ruta
      // interactiva recortaba; la ruta por ARGUMENTO no.
      if (!/value\.trim\(\) === ''/.test(svc)) {
        return falla('resolvePolicy volvió a admitir una respuesta en blanco: la política quedaría marcada como decidida por el despacho con un valor vacío');
      }
      // La LECTURA: el cinturón, porque una fila anterior a la guarda sigue en
      // la base. `Number('')` es 0 y `Number.isFinite(0)` es true, así que sin
      // el recorte el respaldo al default declarado no se dispara nunca.
      return /crudo === '' \? Number\.NaN : Number\(crudo\)/.test(svc)
        ? ok('el blanco se rechaza al escribirse y no se confunde con cero al leerse')
        : falla('getPolicyNumber volvió a Number(p.value) a secas: un valor en blanco heredado pondría el umbral de capitalización en cero — «capitalízalo todo», en silencio');
    },
  },
];
