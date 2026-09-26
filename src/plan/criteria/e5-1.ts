import * as fs from 'node:fs';
import * as os from 'node:os';
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
  leer,
  noEvaluable,
  ok,
  rutaDe,
  sinComentarios,
} from './shared.js';

// ============================================================
// THE E5.1 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E5_1: Criterio[] = [

  // ---- E5.1 · Madurez del agente ----
  {
    paquete: 'E5.1',
    id: 'cli-audit-baseline-ratchet',
    enunciado: 'La auditoría de consistencia corre contra el binario que se embarca, y su deuda no crece',
    evaluar: async () => {
      // `auditProgram` existía desde el principio y el programa real nunca
      // pasó por ella: vivía en un `.spec.ts` y cada prueba se construía un
      // árbol de juguete. Peor, importarla desde el spec arrastraba su suite,
      // cuyos `resetDeclarations()` vacían el registro de riesgo — así que
      // cualquier prueba que la importara auditaba un programa con cero
      // declaraciones y pasaba en el vacío.
      const { program } = await import('../../cli/mnemosine.js');
      const { auditarContraLineaBase, LINEA_BASE, DEUDA_DE_LLAVES } = await import(
        '../../cli/kernel/audit.js'
      );

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
      // La deuda congelada son ahora DOS listas: LINEA_BASE (40 violaciones de
      // vocabulario y contrato) y DEUDA_DE_LLAVES (las hojas que aceptan
      // --idempotency-key y no la honran, que R11 acusa desde T3). Sumarlas
      // aquí es lo que hace que el número que se imprime siga siendo el
      // denominador de verdad.
      return ok(
        `sin violaciones nuevas; ${heredadas} de ${LINEA_BASE.length + DEUDA_DE_LLAVES.length} heredadas siguen vivas`
      );
    },
  },
  {
    paquete: 'E5.1',
    id: 'output-flag-writes-complete-output',
    enunciado:
      '`-o` entrega un archivo con la salida COMPLETA del comando: todo dato sale por una sola puerta',
    evaluar: async () => {
      // `-o/--output` es CONTRATO con guiones y con el agente, y mentía de
      // tres formas medidas sobre el binario: `cfdi list --fields -o f` salía
      // 0 sin crear `f`; una tabla de cero filas tampoco lo creaba; y
      // `cfdi show -o f` dejaba en `f` sólo los conceptos, porque el segundo
      // `render` truncaba al primero.
      //
      // ESTE CRITERIO NO CUENTA ESCRITURAS. Un censo de `out.write(` mide la
      // ortografía de un archivo —se satisface aliaseando el flujo, o
      // escribiendo `process.stdout`— y no afirma nada sobre `-o`. Lo que se
      // mira aquí es el SEAM que hace imposible el escape, y luego la
      // promesa, ejecutándola:
      //
      //   · quien compone el texto no recibe ningún flujo (no tiene a dónde
      //     escribir) y devuelve un tipo TOTAL, así que una rama futura
      //     —`--summary`, `--count`— que se olvide de producir su texto es un
      //     error de `tsc`, no un archivo que no aparece;
      //   · `render` no escribe el dato: se lo entrega a la puerta;
      //   · y con `-o` el archivo existe y contiene las DOS salidas de un
      //     comando que rinde dos veces.
      const codigo = sinComentarios(crudoDe('src', 'cli', 'kernel', 'output.ts'));

      const firma = /function compose\(([^)]*)\)\s*:\s*Composed\s*\{/.exec(codigo);
      if (!firma) {
        return falla(
          'el compositor de output.ts ya no es `compose(...): Composed`: o desapareció, o su ' +
            'tipo de retorno dejó de ser total — y con un retorno opcional el compilador deja ' +
            'de exigirle a cada rama que produzca su texto, que es lo único que impide que la ' +
            'siguiente nazca sin archivo'
        );
      }
      if (/WriteStream/.test(firma[1])) {
        return falla(
          'el compositor volvió a recibir un flujo de escritura: con un `out` en el alcance, ' +
            'cualquier rama puede imprimir por su cuenta y `-o` vuelve a no crear el archivo'
        );
      }

      const cuerpoRender = /export function render\([\s\S]*?\n\}/.exec(codigo)?.[0] ?? '';
      if (!/\bemit\(\s*data\s*,\s*opts\s*,\s*out\s*\)/.test(cuerpoRender)) {
        return falla(
          '`render` ya no entrega su texto a la puerta que conoce `--output`: el dato se escribe ' +
            'en otro sitio, que es exactamente como se perdían la cabecera de `cfdi show` y el ' +
            'archivo de `--fields`'
        );
      }

      // Y ahora la promesa, EJECUTADA. Se mide por TAMAÑO y no leyendo el
      // archivo, y no es un rodeo: el archivo tiene que pesar exactamente lo
      // que los mismos renders habrían impreso por stdout, que es una
      // afirmación más fuerte que «contiene tal palabra» — la cabecera de
      // `cfdi show` se perdía entera y una palabra suelta la habría dado por
      // buena. (Además, `fs.readFileSync` aquí subiría el conteo que vigila
      // el meta-criterio del seam, y ése mide bien: ninguna lectura de este
      // archivo debe rodear `leer()`.)
      const { render, resetOutputTargets } = await import('../../cli/kernel/output.js');
      const impreso: string[] = [];
      const espia = {
        write: (t: string) => {
          impreso.push(t);
          return true;
        },
        isTTY: false,
      } as unknown as NodeJS.WriteStream;
      const callado = { write: () => true, isTTY: false } as unknown as NodeJS.WriteStream;
      const cabecera = [{ uuid: 'AAAA', total: '1160.00' }];
      const conceptos = [{ linea: 1, importe: '1000.00' }];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promesa-de-archivo-'));
      try {
        // Lo que este comando IMPRIME cuando nadie pidió archivo.
        resetOutputTargets();
        render(cabecera, { stdout: espia, stderr: callado });
        render(conceptos, { stdout: espia, stderr: callado });
        const esperado = Buffer.byteLength(impreso.join(''), 'utf8');

        const destino = path.join(dir, 'salida.txt');
        resetOutputTargets();
        render(cabecera, { output: destino, stdout: callado, stderr: callado });
        render(conceptos, { output: destino, stdout: callado, stderr: callado });
        render([], { output: destino, stdout: callado, stderr: callado });
        if (!fs.existsSync(destino)) return falla('`-o` salió 0 sin crear el archivo que prometió');
        const pesa = fs.statSync(destino).size;
        if (pesa !== esperado) {
          return falla(
            `el archivo de \`-o\` pesa ${pesa} byte(s) y la salida del comando son ${esperado}: ` +
              'no contiene lo que el comando habría impreso. Con menos, una tabla borró a la ' +
              'anterior — es el defecto con el que `cfdi show -o` devolvía los conceptos sin el ' +
              'comprobante; con más, se está acumulando algo que no es de esta invocación'
          );
        }

        const vacio = path.join(dir, 'vacio.txt');
        resetOutputTargets();
        render([], { output: vacio, stdout: callado, stderr: callado });
        if (!fs.existsSync(vacio)) {
          return falla(
            'cero filas con `-o` no creó archivo: cero filas es un RESULTADO, y `-o` prometió un ' +
              'archivo, no un contenido'
          );
        }

        const censo = path.join(dir, 'campos.txt');
        resetOutputTargets();
        render(cabecera, { output: censo, fields: true, stdout: callado, stderr: callado });
        if (!fs.existsSync(censo)) {
          return falla('`--fields` a secas con `-o` salió 0 sin crear el archivo');
        }
        return ok(
          `el compositor no tiene flujo al que escribir, \`render\` pasa por la puerta, y dos ` +
            `renders con el mismo \`-o\` dejan los ${esperado} byte(s) completos en el archivo`
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    mutantes: [
      {
        archivo: 'src/cli/kernel/output.ts',
        de: 'function compose(rows: Row[], opts: RenderOptions, p: Palette): Composed {',
        a: 'function compose(rows: Row[], opts: RenderOptions, p: Palette, out: NodeJS.WriteStream): Composed {',
        porque:
          'firma-que-recupera-el-flujo: devolverle un `out` al compositor reabre la puerta de atrás ' +
          'por la que `--fields` y la tabla vacía escribían sin pasar por `--output`',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: 'function compose(rows: Row[], opts: RenderOptions, p: Palette): Composed {',
        a: 'function compose(rows: Row[], opts: RenderOptions, p: Palette): Composed | void {',
        porque:
          'retorno-que-deja-de-ser-total: con `| void` el compilador ya no rechaza la rama futura ' +
          'que se olvida de producir su texto, y el guardián deja de ser tsc para volver a ser la suerte',
      },
      {
        archivo: 'src/cli/kernel/output.ts',
        de: '  emit(data, opts, out);',
        a: '  out.write(data);',
        porque:
          'puerta-esquivada: escribir el dato en `render` en vez de entregarlo a `emit` es el defecto ' +
          'original entero — el archivo de `-o` deja de existir aunque el comando salga 0',
      },
    ],
  },
  {
    paquete: 'E5.1',
    id: 'idempotency-key-honored-and-scoped',
    enunciado:
      'R11 comprueba que la llave se HONRE, y todo ámbito declarado llega de verdad al almacén',
    evaluar: async () => {
      // R11 COMPROBABA SU PROPIO EFECTO SECUNDARIO. Verificaba que un comando
      // de riesgo llevara --dry-run, --yes e --idempotency-key, y
      // `declareRisk` se las inyecta él mismo unas líneas antes: sobre el
      // binario embarcado daba CERO violaciones en 36 hojas graves. Mientras
      // tanto la promesa textual de la bandera —«a retry with the same key
      // and payload returns the recorded result»— la cumplían 15.
      //
      // Este criterio vigila las DOS mitades de la reparación, y ninguna se
      // puede satisfacer inyectando una bandera:
      //   (a) la regla nombra la acusación, así que puede fallar;
      //   (b) todo ámbito DECLARADO viaja hasta una llamada al almacén.
      // (a) SE MIDE **Y** SE ANCLA, y las dos mitades hacen falta.
      //
      //     El ancla de texto sola no medía nada: con el literal en su sitio,
      //     la acusación podía dejar de emitirse y el criterio seguía verde —
      //     que habría sido, un piso más abajo, el MISMO error que denuncia.
      //     Pero la medición sola tampoco basta: el seam del arnés gobierna la
      //     LECTURA DE TEXTO, no los módulos importados, así que un criterio
      //     que sólo hace `await import(...)` es inmune a su propio espejo y
      //     sus mutantes sobreviven. Juntas: la medición caza el silencio, el
      //     ancla deja que el arnés muerda.
      const audit = crudoDe('src/cli/kernel/audit.ts');
      if (!audit.includes("rule: 'R11 llave aceptada sin honrar',")) {
        return falla(
          'R11 volvió a comprobar sólo las banderas que declareRisk inyecta: una regla que ' +
            'verifica su propio efecto secundario no puede fallar'
        );
      }
      // Y AHORA LA MEDICIÓN. La primera versión de este criterio
      //     comprobaba `audit.includes("rule: '…'")` sobre el fuente, y eso
      //     habría sido, un piso más abajo, el MISMO error que denuncia:
      //     verificar la existencia de un literal en vez de la conducta. Con
      //     el literal en su sitio, la acusación podía dejar de emitirse y el
      //     criterio seguía verde. Aquí se corre el auditor sobre el binario
      //     de verdad y se CUENTAN las acusaciones.
      const { program } = await import('../../cli/mnemosine.js');
      const { auditProgram, esDeudaDeLlave, DEUDA_DE_LLAVES } = await import('../../cli/kernel/audit.js');
      const acusadas = auditProgram(program).filter(esDeudaDeLlave);
      if (acusadas.length === 0) {
        return falla(
          'R11 no acusa a ninguna hoja: o volvió a comprobar sólo las banderas que declareRisk ' +
            'inyecta —una regla que verifica su propio efecto secundario no puede fallar— o dejó ' +
            'de emitirse con su literal intacto'
        );
      }
      if (acusadas.length !== DEUDA_DE_LLAVES.length) {
        return falla(
          `R11 acusa a ${acusadas.length} hojas y la deuda declarada tiene ${DEUDA_DE_LLAVES.length}: ` +
            'la lista sólo puede ENCOGER, y encoge borrando el renglón de la hoja que se cablea, ' +
            'nunca dejando de acusar'
        );
      }

      // El fuente del CLI SIN comentarios y SIN las declaraciones: si no, la
      // propia `llave: { scope: 'X' }` se encontraría a sí misma y el
      // criterio diría que el ámbito está cableado por haberlo escrito.
      const cli = fuentes('src/cli')
        .map((f) => sinComentarios(leer(f)))
        .join('\n')
        .replace(/llave:\s*\{\s*scope:\s*'[^']*'\s*\}/g, '');
      const declarados = [
        ...sinComentarios(
          fuentes('src/cli')
            .map((f) => leer(f))
            .join('\n')
        ).matchAll(/llave:\s*\{\s*scope:\s*'([^']*)'\s*\}/g),
      ].map((m) => m[1]);
      if (declarados.length < 15) {
        return falla(
          `sólo ${declarados.length} hoja(s) declaran el ámbito de su llave: el censo medido eran 19`
        );
      }
      // EL ÁMBITO PUEDE VIAJAR POR UNA CONSTANTE, no sólo como literal en la
      // llamada: `receipt record` lo hace así porque lo usan DOS sitios —la
      // consulta temprana de la llave y su consumo—, y dos literales que puedan
      // divergir serían dos deduplicaciones distintas con el mismo nombre. Lo
      // que este cruce defiende es que la palabra declarada ESTÉ en el fuente
      // del manejador, no la forma sintáctica con que llega.
      const huerfanos = declarados.filter((a) => !cli.includes(`'${a}'`));
      if (huerfanos.length > 0) {
        return falla(
          `${huerfanos.length} ámbito(s) declarados que ninguna llamada a conLlave usa ` +
            `(${huerfanos.join(', ')}): la declaración promete una deduplicación que el manejador no hace`
        );
      }
      // Y las dos que duplicaban DINERO, por su nombre: son las que el issue
      // #90 pone como ejemplo y las que se reprodujeron contra Postgres.
      const dinero = ['receipt record', 'payment create'].filter((a) => !declarados.includes(a));
      if (dinero.length > 0) {
        return falla(`${dinero.join(' y ')} volvió a aceptar la llave sin honrarla`);
      }
      return ok(
        `${declarados.length} ámbito(s) declarados, todos entregados al almacén; ` +
          'R11 acusa a las que no la honran'
      );
    },
    mutantes: [
      {
        archivo: 'src/cli/kernel/audit.ts',
        de: "rule: 'R11 llave aceptada sin honrar',",
        a: "rule: 'R11 risk flags',",
        porque:
          'la acusación se disuelve dentro de la regla tautológica: R11 vuelve a decir sólo lo que ' +
          'declareRisk acaba de inyectar y deja de poder fallar',
      },
      {
        archivo: 'src/cli/receipt-command.ts',
        de: "const AMBITO_DE_COBRO = 'receipt record';",
        a: "const AMBITO_DE_COBRO = 'cobro';",
        porque:
          'el manejador consuma la llave bajo OTRO ámbito que el declarado — el escape de ' +
          'firma-como-llamada: la declaración sigue escrita y la deduplicación de `receipt record` ' +
          'deja de existir para quien la lea',
      },
      {
        archivo: 'src/cli/payment-command.ts',
        de: "          scope: 'payment create',",
        a: "          scope: 'entry post',",
        porque:
          'dos hojas bajo el mismo ámbito se deduplican ENTRE SÍ (la unicidad de idempotency_keys ' +
          'es por tenant+scope+clave), y el ámbito declarado por `payment create` deja de tener ' +
          'llamada propia',
      },
    ],
  },
  {
    paquete: 'E5.1',
    id: 'every-cli-leaf-declares-risk',
    enunciado: 'Toda hoja del CLI declara su riesgo, así que hay algo sobre lo que aplicar la compuerta',
    evaluar: async () => {
      // Se mide sobre el PROGRAMA EMBARCADO, no sobre un árbol de juguete.
      // 49 de 106 hojas no declaraban nada —entre ellas las que postean al
      // mayor y la que ejecuta contra el sistema del cliente— y por eso la
      // regla R11 del auditor devolvía cero violaciones: no tenía sobre qué
      // correr. Un verde por no tener nada que mirar es el defecto que este
      // sprint persigue, y aquí estaba en el instrumento mismo.
      const { program } = await import('../../cli/mnemosine.js');
      const { riskOf } = await import('../../cli/kernel/risk.js');
      const { hojasDe } = await import('../../cli/kernel/riesgos-retrofit.js');

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
    id: 'agent-tools-from-risk-registry',
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
    id: 'unattended-named-tool-surface',
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
    id: 'dangerous-commands-gated-and-keyed',
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
    id: 'amounts-survive-context-compaction',
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
    id: 'resumed-session-rehydrates-history',
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
    id: 'model-prices-effective-date-shown',
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
    id: 'agent-tools-propose-never-execute',
    enunciado: 'Ninguna herramienta del agente alcanza el mayor ni ejecuta hacia fuera',
    mutantes: [
      {
        archivo: 'src/ai/tools/ledger-tools.ts',
        de: 'envolverDatosDeTerceros(',
        a: 'envolverDatosDeTerceros(postJournalEntry, ',
        porque: 'una herramienta que NOMBRA una puerta de dinero debe enrojecer, aunque no la llame (la lección del import)',
      },
    ],
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
        const codigo = sinComentarios(leer(f));
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
    id: 'cfdi-classifier-golden-set',
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
    id: 'confidence-calibration-buckets-with-delta',
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
    id: 'agent-work-leaves-measurable-trace',
    enunciado: 'Lo que el agente hace deja rastro medible: duración, corridas y eventos',
    evaluar: () => {
      // A2: las métricas que faltaban. duration_ms en el ledger de uso (los
      // DOS runners miden alrededor de su llamada), los counts de la ingesta
      // persistidos por corrida (con consumo, para que costo-por-borrador
      // sea una división), y sospecha/nudge/failover como filas — el delito
      // menor deja rastro ANTES de discutir la autonomía mayor.
      const m = 'src/database/migrations/044_el_agente_medible.sql';
      if (!existe(m)) return falla('la 044 desapareció: sin tablas no hay rastro');
      const sql = crudoDe(m);
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
      // El criterio afirma la CONDUCTA —que la corrida quede registrada—, no
      // el nombre de la función que la registra. Afirmaba
      // `registrarCorridaIngesta(ctx` y se puso rojo el día que A7·3 partió
      // esa función en abrir/cerrar para que la fila naciera ANTES del bucle:
      // acusaba «la ingesta volvió a imprimir y evaporar» sobre una capacidad
      // que acababa de mejorar. Un criterio que nombra un identificador
      // castiga el refactor que lo cumple mejor — la lección de la casa que
      // la cabecera de este archivo abre, cobrada otra vez.
      if (!/conCorridaRegistrada\(|registrarCorridaIngesta\(ctx/.test(cli)) {
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

  {
    paquete: 'E5.1',
    id: 'single-auto-approval-authorizer',
    enunciado: 'Un solo autorizador: la vía de política lleva tope obligatorio y su «no casó» tiene nombre',
    mutantes: [
      {
        archivo: 'src/ai/ingest-service.ts',
        de: 'opts.deps?.autoApproveByPolicy ?? autoApproveDraftByPolicy',
        a: 'opts.deps!.autoApproveByPolicy',
        porque: 'el seam de pruebas se vuelve el camino de producción: el default al autorizador real desaparece',
      },
    ],
    evaluar: () => {
      // A3: había DOS autorizadores — matchApprovalPolicy con toda la
      // jurisprudencia (tope del operador vía Math.min, revocación,
      // last_used_at) y un gemelo huérfano que la ingesta no usaba. La
      // ingesta migró a la vía única: cuando una compuerta DISCRECIONAL no
      // basta, autoApproveDraftByPolicy tiene su oportunidad; las de
      // INTEGRIDAD retornan antes y jamás llegan ahí.
      const ing = codigoDe('src/ai/ingest-service.ts');
      // Forma de LLAMADA con el default (la lección de la firma-como-
      // callsite): el seam de pruebas debe caer al autorizador real, no a
      // un stub que aprobaría sin jurisprudencia.
      if (!/opts\.deps\?\.autoApproveByPolicy \?\? autoApproveDraftByPolicy/.test(ing)) {
        return falla('la ingesta dejó de caer al autorizador real: el seam de pruebas se volvió el camino de producción');
      }
      if (!/configuredMaxAmount: floorMaxAutoAmount\(thresholds\.maxAmount\)/.test(ing)) {
        return falla('la vía de política perdió el tope obligatorio del operador: una política podría autorizar por encima');
      }
      if (!/if \(veredicto\.integridad\)/.test(ing)) {
        return falla('la integridad dejó de retornar antes de la política: sospecha, multi-draft, moneda o cuadre se volverían negociables');
      }
      if (!/instanceof NoMatchingApprovalPolicyError/.test(ing)) {
        return falla('el «no casó» perdió el nombre: no se distinguiría de «casó y falló al aplicarse»');
      }
      // El huérfano pagó: la ingesta IMPORTA el autorizador del servicio de
      // borradores (si este import muere, E0.2 debe recongelar el símbolo).
      if (!/import\s*\{[^}]*\bautoApproveDraftByPolicy\b[^}]*\}\s*from '\.\/draft-service\.js'/.test(ing)) {
        return falla('la ingesta ya no importa autoApproveDraftByPolicy: volvería a haber dos autorizadores o ninguno');
      }
      return /code = 'NO_MATCHING_APPROVAL_POLICY'/.test(codigoDe('src/ai/draft-service.ts'))
        ? ok('vía única con tope floor-clampeado, integridad no negociable y NoMatchingApprovalPolicyError con código')
        : falla('el error de política sin casar perdió su código: los llamadores volverían a comparar strings');
    },
  },
  {
    paquete: 'E5.1',
    id: 'budget-enforced-at-session-chokepoint',
    enunciado: 'El presupuesto corta donde nacen las sesiones, y desatendido el tope es tope',
    mutantes: [
      {
        archivo: 'src/ai/budget.ts',
        de: "opts.unattended ? 'block' : 'warn'",
        a: "'warn'",
        porque: 'la ruta desatendida pierde su default block: «solo avisa» significa que no hay tope',
      },
    ],
    evaluar: () => {
      // A3 (spec E5.1-e): presupuesto opt-in por archivo de config, pero con
      // un default que distingue rutas: con humano enfrente, warn; en ruta
      // DESATENDIDA (grounding apagado = nadie mira), block — «solo avisa»
      // significa que no hay tope. Y el corte vive en el ÚNICO sitio donde
      // nacen las sesiones, no repartido por los llamadores.
      if (!existe('src/ai/budget.ts')) return falla('budget.ts no existe: el gasto del agente no tiene tope posible');
      const b = codigoDe('src/ai/budget.ts');
      if (!/opts\.unattended \? 'block' : 'warn'/.test(b)) {
        return falla('la ruta desatendida perdió su default block: un agente sin humano enfrente correría sin tope real');
      }
      if (!/code = 'AI_BUDGET_EXCEEDED'/.test(b)) {
        return falla('BudgetExceededError perdió su código: los llamadores no distinguirían tope de cualquier otro error');
      }
      // Declarado Y usado en la comparación (conteo, no presencia): mutar el
      // umbral del aviso dejando la constante viva pasa un chequeo laxo.
      if ((b.match(/BUDGET_WARN_RATIO/g) ?? []).length < 2) {
        return falla('el aviso del 80% dejó de compararse: el usuario se enteraría del tope al chocar con él');
      }
      if (!/sin medición/.test(b)) {
        return falla('block dejó de ser cerrado ante una base que no responde: un tope que no puede medirse no debe fingir que midió');
      }
      const prov = codigoDe('src/ai/providers/index.ts');
      if (!/const unattended = opts\.grounding\?\.enabled === false/.test(prov)) {
        return falla('la señal de desatendido se desconectó del grounding: la ruta sin humano dejaría de reconocerse');
      }
      if (!/await assertWithinBudget\(ctx, opts\.cwd, \{ unattended \}\)/.test(prov)) {
        return falla('createLlmSession dejó de pasar por el presupuesto: el chokepoint tiene un desvío');
      }
      // El decorador muerde al ENTRAR a cada turno: un cruce a mitad de
      // sesión corta sin esperar a la siguiente sesión.
      if (!/guard\.check\(\);\s*return session\.runTurn\(/.test(prov)) {
        return falla('withBudgetGuard dejó de checar por turno: un cruce a mitad de sesión seguiría gastando');
      }
      return /return withBudgetGuard\(session, guard\)/.test(prov)
        ? ok('presupuesto opt-in con block por default en desatendido, cerrado sin medición, y el guard muerde cada turno en el chokepoint')
        : falla('la sesión sale sin decorar: el guard existiría sin morder');
    },
  },
  {
    paquete: 'E5.1',
    id: 'shadow-verdicts-gate-auto-post',
    enunciado: 'La sombra opina sin postear, y encender el auto-posteo exige su historial',
    mutantes: [
      {
        archivo: 'src/services/policy/policy-service.ts',
        de: 'c.decididos < FLOOR_SOMBRA_VEREDICTOS ||',
        a: '',
        porque: 'el piso pierde la vara del volumen decidido: tres comparaciones, cada una con ancla propia',
      },
    ],
    evaluar: () => {
      // A4: autoPost 'shadow' corre TODAS las compuertas, registra el
      // veredicto y no postea nada. La concordancia cruza esos veredictos
      // contra decisiones HUMANAS (nunca contra el propio umbral ni contra
      // políticas), y resolvePolicy exige ese historial antes de aceptar
      // 'on': el encendido es una decisión con evidencia, no una casilla.
      const m = 'src/database/migrations/047_el_veredicto_de_la_sombra.sql';
      if (!existe(m)) return falla('la 047 desapareció: la sombra no tendría dónde opinar');
      const sql = crudoDe(m);
      if (!/CREATE TABLE ai_shadow_verdicts/.test(sql) || !/UNIQUE \(draft_id\)/.test(sql)) {
        return falla('ai_shadow_verdicts perdió la unicidad por borrador: una sombra que opina dos veces infla su propia concordancia');
      }
      const ing = codigoDe('src/ai/ingest-service.ts');
      if (!/const modoSombra = thresholds\.sombra === true && !thresholds\.autoPost/.test(ing)) {
        return falla("la sombra dejó de excluir autoPost encendido: 'shadow' sólo tiene sentido cuando nada postea");
      }
      // El MISMO evaluador para el modo real y la sombra: el veredicto
      // registrado sale de evaluarAutoPost, no de una copia que diverge.
      //
      // EL ANCLA CAMBIÓ EN A7, Y ES LA MITAD DE LA HISTORIA. Pedía
      // literalmente `wouldAutoPost: veredicto.procede`, y eso era exacto
      // mientras el modo encendido tuviera UNA sola vía. A3 le añadió la
      // segunda —la política otorgada, cuando una compuerta discrecional no
      // basta— y entonces la fidelidad exigía lo contrario de lo que el
      // criterio pedía: registrar sólo el umbral mide un clasificador MÁS
      // CONSERVADOR que el que se enciende. El piso por criterio (S2) cazó
      // este cambio en el mismo commit, que es exactamente para lo que se
      // construyó. Se sigue exigiendo que el veredicto salga del evaluador
      // compartido, ahora componiéndolo con la vía de política.
      if (!/const habriaPosteado = veredicto\.procede \|\| porPolitica !== null/.test(ing)) {
        return falla('la sombra dejó de componer su veredicto con el evaluador compartido y la vía de política: mediría un clasificador que no es el real');
      }
      const sv = codigoDe('src/ai/shadow-verdicts.ts');
      if (!/ON CONFLICT \(draft_id\) DO NOTHING/.test(sv)) {
        return falla('el registro del veredicto perdió su idempotencia: reintentos duplicarían opiniones');
      }
      // Conteos ×2 (numerador Y denominador excluyen máquina): mutar uno
      // dejando el otro pasa un chequeo de presencia — la lección de R1.
      const notasAuto = (sv.match(/'auto-post by threshold%'/g) ?? []).length;
      const prefPol = (sv.match(/'policy:%'/g) ?? []).length;
      if (notasAuto < 2 || prefPol < 2) {
        return falla(
          `la concordancia volvería a contar decisiones de máquina (nota auto ×${notasAuto}, prefijo policy ×${prefPol}): el agente se calificaría a sí mismo`
        );
      }
      const ps = codigoDe('src/services/policy/policy-service.ts');
      if (!/key === 'ingest_auto_post' && value === 'on'/.test(ps)) {
        return falla("la compuerta de evidencia desapareció de resolvePolicy: 'on' volvería a ser una casilla sin historial");
      }
      // Las TRES varas del piso, cada una comparada de verdad.
      if (
        !/c\.dias_con_veredictos < FLOOR_SOMBRA_DIAS/.test(ps) ||
        !/c\.decididos < FLOOR_SOMBRA_VEREDICTOS/.test(ps) ||
        !/acuerdo < FLOOR_SOMBRA_ACUERDO/.test(ps)
      ) {
        return falla('el piso del encendido perdió una de sus tres varas (días, volumen decidido, acuerdo)');
      }
      if (!/polAuto\.defined && polAuto\.value === 'shadow'/.test(codigoDe('src/ai/ingest-thresholds.ts'))) {
        return falla('la sombra dejó de ser SOLO del panel: un literal suelto en el archivo de config no debe encenderla');
      }
      return /value: 'shadow'/.test(codigoDe('src/services/policy/pending-catalog.ts'))
        ? ok('sombra panel-only con veredicto único por borrador, concordancia sobre humanos y encendido con peaje de evidencia')
        : falla('el panel perdió la opción shadow: el camino al encendido quedaría sin puerta');
    },
  },
  // ══════════════════════════════════════════════════════════
  // S-UX · lote 2. Seis criterios que nacen de una lección repetida:
  // el guardián se deriva del ÁRBOL, nunca de una lista paralela. Los
  // cinco entregables de este tramo pasaron por un adversario con el
  // encargo de tumbarlos, y los cinco tenían el mismo defecto de
  // familia — la prueba miraba un árbol de juguete, una sola fila, o
  // un suelo con holgura. Cada criterio de abajo cita el mutante que
  // SOBREVIVÍA antes de armarlo.
  // ══════════════════════════════════════════════════════════
  {
    paquete: 'E5.1',
    id: 'shell-completion-from-shipped-tree',
    enunciado:
      'El guion de completado se genera del árbol embarcado entero, y su cuerpo no le devuelve la lista al shell para que la expanda',
    mutantes: [
      {
        archivo: 'src/cli/completion-command.ts',
        de: '      visit(child, childPath);',
        a: '      if (childPath.length < 3) visit(child, childPath);',
        porque:
          'profundidad-truncada: un generador que se detiene un nivel antes pierde las 53 tablas de tercer nivel (el guion cae de 597 a 544 líneas) y una prueba sobre un árbol sintético de dos niveles no tiene tercer nivel que perder',
      },
    ],
    evaluar: () => {
      const gen = codigoDe('src/cli/completion-command.ts');
      // El recorrido no se topa: un tope de profundidad es el modo de
      // fallo que deja `sat cred add --<TAB>` sin ofrecer --dry-run.
      if (/childPath\.length\s*<\s*\d/.test(gen)) {
        return falla('el generador de completado topó la profundidad del recorrido: las hojas de tercer nivel perderían su tabla de banderas');
      }
      // Escape con bandera GLOBAL. Sin /g sólo se escapa la primera
      // comilla, y un nombre con dos deja el resto del texto donde el
      // shell lo expande. Demostrado en bash 3.2: se ejecuta.
      if (!/\.replace\(\/'\/g,/.test(gen)) {
        return falla('shellQuote perdió la bandera global del escape: un nombre con dos comillas deja carga ejecutable en el guion');
      }
      // El cuerpo consumidor lee palabra a palabra. `compgen -W` EXPANDE
      // la lista, así que devuelve al shell justo lo que las tablas
      // habían entrecomillado bien. OJO al ancla: el módulo NOMBRA
      // «compgen -W» dentro del comentario BASH que lo prohíbe, y ese
      // comentario viaja en una cadena de TypeScript, así que
      // codigoDe() no lo quita. Buscar el nombre acusaría a la frase
      // que previene el defecto — el primer intento de este criterio
      // hizo justo eso. Se ancla en la CONDUCTA: ninguna línea que
      // abra `candidates=(` puede continuar con una expansión.
      if (/candidates=\(\s*\$\(/.test(gen)) {
        return falla('el consumidor del guion volvió a construir la lista con una expansión: un alias hostil ejecuta código al pulsar TAB');
      }
      if (!/while IFS= read -r word/.test(gen)) {
        return falla('el cuerpo del guion perdió el lector línea a línea: es la pieza que impide que el shell expanda lo que se le ofrece');
      }
      // Y el guardián mira el objeto que la pieza produce: el program
      // EMBARCADO, no un árbol inventado. Ésta es la lección entera.
      const spec = codigoDe('tests/cli/completion-command.spec.ts');
      return /from '\.\.\/\.\.\/src\/cli\/mnemosine\.js'/.test(spec)
        ? ok('el completado se genera del árbol embarcado, con escape global y sin reexpansión en el consumidor')
        : falla('la prueba del completado dejó de importar el program embarcado: volvería a certificar un árbol de juguete');
    },
  },
  {
    paquete: 'E5.1',
    id: 'cli-reference-mirrors-real-help',
    enunciado:
      'El documento que el agente lee como «el binario exacto» reproduce la ayuda real, con los ejemplos incluidos',
    mutantes: [
      {
        archivo: 'scripts/generate-cli-reference.ts',
        de: "  emitir(cmd, 'afterHelp', contexto);",
        a: '  // emitir(cmd, contexto);',
        porque:
          'ayuda-a-medias: helpInformation() no dispara afterHelp, así que las 244 invocaciones de ejemplo desaparecen del documento mientras el generador sigue prometiendo fidelidad byte a byte',
      },
    ],
    evaluar: () => {
      const gen = codigoDe('scripts/generate-cli-reference.ts');
      if (!/emitir\(cmd, 'afterHelp', contexto\)/.test(gen)) {
        return falla('el generador volvió a la ayuda sin afterHelp: los ejemplos no llegarían al documento que el agente lee como el binario');
      }
      // Conteo sobre el ARTEFACTO, no sobre el generador: un generador
      // correcto con un documento sin regenerar es el mismo hueco.
      const doc = crudoDe('src/ai/docs/cli-reference.md');
      const ejemplos = (doc.match(/Examples:/g) ?? []).length;
      if (ejemplos < 100) {
        return falla(
          `cli-reference.md sólo trae ${ejemplos} bloques de ejemplos: el documento está sin regenerar y el agente no ve la mitad visible de la ayuda`
        );
      }
      return ok(`el documento del agente reproduce la ayuda real: ${ejemplos} bloques de ejemplos`);
    },
  },
  {
    paquete: 'E5.1',
    id: 'every-help-example-parses',
    enunciado:
      'Todo ejemplo de la ayuda lo acepta el Commander embarcado, en la hoja en cuya ayuda vive, y ninguno enseña la clave legada tax=',
    mutantes: [
      {
        archivo: 'src/cli/bill-command.ts',
        de: 'tax-amount=2000.00',
        a: 'tax=16',
        porque:
          'ejemplo-que-miente: tax= es TASA en invoice y MONTO en bill, así que el ejemplo copiable registraría 16 pesos de IVA donde van 2 000 — la confusión H3 que este tramo existe para curar, en el propio texto que la cura',
      },
    ],
    evaluar: () => {
      const spec = codigoDe('tests/cli/ejemplos-de-ayuda.spec.ts');
      // La prueba PARSEA con el Commander real: comprobar que la bandera
      // existe deja pasar el ejemplo al que le falta el argumento
      // posicional, y ése muere en el parser del usuario, no en CI.
      if (!/\.parse\(argv, \{ from: 'user' \}\)/.test(spec)) {
        return falla('el guardián de ejemplos dejó de pasar las invocaciones por el Commander real: un ejemplo sin su argumento posicional volvería a pasar en verde');
      }
      // Los suelos van en el valor MEDIDO. Un suelo con holgura no es un
      // trinquete: es un permiso — con 97 sobre 115 se podía borrar una
      // familia documentada entera sin un solo rojo.
      const suelos = spec.match(/(?:SUELO|MINIMO)_[A-Z_]+\s*=\s*(\d+)/g) ?? [];
      if (suelos.length < 2) {
        return falla('el guardián de ejemplos perdió sus suelos medidos: sin ellos un revert parcial pasa en verde');
      }
      const bill = codigoDe('src/cli/bill-command.ts');
      const ejemplosDeBill = bill.slice(bill.indexOf('EJEMPLOS'));
      return /tax-amount=/.test(ejemplosDeBill) && !/--line "[^"]*[,"]tax=/.test(ejemplosDeBill)
        ? ok('los ejemplos parsean contra el Commander embarcado y bill enseña tax-amount, no la clave legada')
        : falla('un ejemplo de bill volvió a la clave legada tax=: registraría el IVA con un factor de diez');
    },
  },
  {
    paquete: 'E5.1',
    id: 'contract-exit-codes-have-producers',
    enunciado:
      'El 8 y el 9 del contrato tienen productor de verdad: un fallo externo transitorio y un rechazo definitivo mueren con enteros distintos',
    mutantes: [
      {
        archivo: 'src/services/integrations/accounting/contalink-adapter.ts',
        de: '      throw new ExternalRejectedError(this.name, `HTTP ${response.status} at ${path}`, detalle);',
        a: '      throw new ExternalServiceError(this.name, `HTTP ${response.status} at ${path}`, detalle);',
        porque:
          'rechazo-disfrazado-de-fallo: un 401 (credencial muerta) o un 422 (payload que jamás aceptará) saldrían por el 8, y el contrato dice de ese 8 «Retryable» — el cron reintentaría para siempre una petición que nunca puede salir bien',
      },
      {
        archivo: 'src/services/integrations/accounting/contalink-adapter.ts',
        // El espejo anterior aquí era un NO-OP MEDIDO: reescribía el `json()`
        // como `Promise.resolve(response).then(...)`, que hace exactamente lo
        // mismo dentro del mismo try. Mataba al criterio por su expresión
        // regular, no por la conducta — que es el fallo que este proyecto
        // persigue, cometido por el espejo que lo vigila. Éste SÍ neutraliza:
        // saca la decodificación FUERA del try, que es el defecto literal.
        de: '    let data: T;\n    try {\n      data = (await response.json()) as T;',
        a: '    const data = (await response.json()) as T;\n    try {',
        porque:
          'el-cuarto-desenlace: el `json()` vuelve a quedar FUERA del guarda, así que un proxy o un portal cautivo que conteste 200 con HTML da un SyntaxError pelado que sale por el 1 genérico y ni siquiera nombra al proveedor',
      },
      {
        archivo: 'src/cli/kernel/index.ts',
        de: '  424: ExitCode.EXTERNAL_REJECTED,',
        a: '  424: ExitCode.FAILURE,',
        porque:
          'la-puerta-tapiada: la única fila del mapa que produce el 9. Borrada, la clase ExternalRejectedError sigue existiendo intacta y el árbol compila — pero todo rechazo definitivo vuelve al 1 genérico y el 9 vuelve a ser papel',
      },
      {
        archivo: 'src/ai/external-service.ts',
        de: '    if (err instanceof ExternalRejectedError || err instanceof ExternalServiceError) {',
        a: '    if (false) {',
        porque:
          'el-veredicto-aplastado-al-final: el adaptador clasifica y executeExternalOp vuelve a envolverlo en un Error pelado, así que `outbox run` —la hoja que llama un cron— pierde la distinción en el último paso pese a que todo lo anterior la calculó bien',
      },
      {
        archivo: 'src/cli/kernel/exit.ts',
        de: '  if (codes.includes(ExitCode.EXTERNAL_FAILED)) return ExitCode.EXTERNAL_FAILED;',
        a: '  if (codes.includes(ExitCode.EXTERNAL_REJECTED)) return ExitCode.EXTERNAL_REJECTED;',
        porque:
          'el-lote-condenado: invierte quién domina en un lote mixto, así que un lote con UNA operación viva y una rechazada sale 9 («no reintentes nunca») y la que sí podía salir bien no se reintenta jamás',
      },
    ],
    evaluar: async () => {
      // SE MIDE **Y** SE LEE EL FUENTE, y hacen falta las dos.
      //
      // El arnés de mutación gobierna la LECTURA DE TEXTO, así que un criterio
      // que sólo hiciera `await import()` sería inmune a sus propios espejos.
      // Pero uno que sólo lea texto sobrevive a una conducta rota: éste lo
      // hacía —seguía verde con el reparto que convierte un rechazo definitivo
      // en «reintentable», que es LITERALMENTE el daño que describe su primer
      // espejo—. Así que primero se ejecuta el reparto de verdad.
      const { ExitCode, batchExitCode } = await import('../../cli/kernel/exit.js');
      const { exitCodeFor } = await import('../../cli/kernel/index.js');
      const { ExternalRejectedError, ExternalServiceError } = await import('../../utils/errors.js');
      const transitorio = exitCodeFor(new ExternalServiceError('contalink', 'unreachable'));
      const definitivo = exitCodeFor(new ExternalRejectedError('contalink', 'HTTP 401'));
      if (transitorio !== ExitCode.EXTERNAL_FAILED || definitivo !== ExitCode.EXTERNAL_REJECTED) {
        return falla(
          `un fallo transitorio muere con ${transitorio} y un rechazo definitivo con ${definitivo}: ` +
            'el contrato publica 8=reintenta y 9=no reintentes nunca, y un cron no puede actuar sobre ' +
            'una distinción que el binario no expresa'
        );
      }
      // Y el veredicto del LOTE: uno solo que pueda reintentarse manda sobre
      // los rechazos, porque condenar el lote entero deja sin reintento a la
      // operación que sí podía salir bien.
      if (
        batchExitCode([ExitCode.EXTERNAL_REJECTED, ExitCode.EXTERNAL_FAILED]) !== ExitCode.EXTERNAL_FAILED ||
        batchExitCode([ExitCode.EXTERNAL_REJECTED]) !== ExitCode.EXTERNAL_REJECTED
      ) {
        return falla('el veredicto del lote dejó de distinguir «alguna se puede reintentar» de «todas fueron rechazadas»');
      }

      // AHORA EL TEXTO, que es lo que el arnés puede mutar.
      const ad = codigoDe('src/services/integrations/accounting/contalink-adapter.ts');

      // 1. Los CUATRO desenlaces del adaptador están clasificados. Antes
      //    los cuatro eran `new Error(...)` y salían por el 1 genérico.
      if (/throw new Error\(/.test(ad)) {
        return falla(
          'el adaptador de Contalink volvió a tirar un Error pelado: ese desenlace sale por el 1 genérico y un cron no puede distinguir «reintenta» de «no reintentes nunca»'
        );
      }
      if (!/catch[\s\S]{0,400}ExternalServiceError\(this\.name, `unreachable at/.test(ad)) {
        return falla('la llamada de red quedó fuera de su guarda: un DNS caído o una conexión rechazada saldría por el 1, sin nombrar al proveedor');
      }
      // El cuarto desenlace, el que no estaba en el issue: response.json()
      // vivía FUERA de todo try.
      if (!/try \{\s*\n\s*data = \(await response\.json\(\)\) as T;/.test(ad)) {
        return falla('response.json() volvió a quedar fuera del try: un 200 con HTML de un proxy da un SyntaxError pelado que ni siquiera nombra al proveedor');
      }
      if (!/esTransitorio\(response\.status\)/.test(ad) || !/ExternalRejectedError\(this\.name, `HTTP/.test(ad)) {
        return falla('el adaptador dejó de separar el 5xx/408/429 del 4xx: un rechazo definitivo volvería a leerse como reintentable');
      }

      // 2. Las DOS puertas del mapa. La de 502 existía desde el principio y
      //    nunca se activó por falta de productor; la de 424 es la única
      //    que produce el 9.
      const mapa = codigoDe('src/cli/kernel/index.ts');
      if (!/502: ExitCode\.EXTERNAL_FAILED/.test(mapa) || !/424: ExitCode\.EXTERNAL_REJECTED/.test(mapa)) {
        return falla('el mapa de estados perdió una de las dos puertas externas: el código publicado que la cruzaba vuelve a ser inalcanzable');
      }
      const errores = codigoDe('src/utils/errors.ts');
      if (!/class ExternalServiceError extends AppError/.test(errores) ||
          !/class ExternalRejectedError extends AppError/.test(errores)) {
        return falla('desaparecieron las clases que llevan los estados 502/424: sin productor, las dos filas del mapa vuelven a ser decorado');
      }

      // 3. El veredicto SOBREVIVE al re-envoltorio del outbox.
      const svc = codigoDe('src/ai/external-service.ts');
      if (!/instanceof ExternalRejectedError \|\| err instanceof ExternalServiceError/.test(svc)) {
        return falla('executeExternalOp volvió a aplastar el veredicto del adaptador en un Error pelado: `outbox run` pierde la distinción en el último paso');
      }

      // 4. Y la hoja que llama un cron COMPONE su código en vez de fijarlo.
      //    `failed > 0 ? 1 : 0` no lo veía ningún censo de `shutdown(1)`.
      const raiz = codigoDe('src/cli/mnemosine.ts');
      if (/shutdown\(failed > 0 \? 1 : 0\)/.test(raiz)) {
        return falla('`outbox run` volvió a fijar su código a 1: el lote entero informa lo mismo tras un corte de red que tras una credencial revocada');
      }
      if (!/shutdown\(batchExitCode\(veredictos\)\)/.test(raiz)) {
        return falla('`outbox run` dejó de componer su código con batchExitCode: un lote que siguió adelante no puede lanzar, así que si no compone, miente');
      }
      const ex = codigoDe('src/cli/kernel/exit.ts');
      if (!/export function batchExitCode/.test(ex) ||
          !/if \(codes\.includes\(ExitCode\.EXTERNAL_FAILED\)\) return ExitCode\.EXTERNAL_FAILED;/.test(ex)) {
        return falla('batchExitCode perdió la regla de que lo reintentable domina: un lote mixto saldría 9 y la operación que aún podía salir bien no se reintentaría nunca');
      }

      // 5. Y el contrato publicado dice quién los produce, en su idioma.
      const doc = crudoDe('docs/cli-command-registry.md');
      if (!/ExternalServiceError/.test(doc) || !/ExternalRejectedError/.test(doc)) {
        return falla('la tabla publicada volvió a prometer el 8 y el 9 sin nombrar quién los produce: «se documenta y no ocurre» es el defecto');
      }

      return ok('el 8 y el 9 nacen en el adaptador, sobreviven al outbox y llegan distintos al process.exit; los cuatro desenlaces externos están clasificados');
    },
  },
  {
    paquete: 'E5.1',
    id: 'cli-leaf-preserves-exit-code',
    enunciado:
      'Ninguna hoja del CLI aplasta su código de salida: el catch devuelve el código del contrato, y el error de uso de Commander pasa por la puerta que cierra el pool',
    mutantes: [
      {
        archivo: 'src/cli/memory-command.ts',
        de: '        await deps.shutdown(exitCodeFor(err));',
        a: '        await deps.shutdown(1);',
        porque:
          'código-aplastado: una hoja que ninguna fila conductual visita, con un texto que ningún grep de «shutdown(1)» esperaba encontrar de vuelta — 39 de 179 hojas vivían así y el contrato de trece códigos era papel',
      },
    ],
    evaluar: () => {
      // Barrido de la clase entera, no de la instancia: el defecto que
      // este criterio vigila vivía en 14 archivos a la vez.
      const archivos = fs
        .readdirSync(rutaDe('src/cli'))
        .filter((n) => n.endsWith('.ts'))
        .sort();
      const aplastan: string[] = [];
      for (const nombre of archivos) {
        if (/shutdown\(1\)/.test(codigoDe('src/cli', nombre))) aplastan.push(nombre);
      }
      if (aplastan.length > 0) {
        return falla(
          `${aplastan.length} archivo(s) del CLI vuelven a aplastar el código de salida a 1: ${aplastan.slice(0, 4).join(', ')} — el contrato de trece códigos vuelve a ser papel`
        );
      }
      // Y la capa de Commander: sin exitOverride, un error de uso sale
      // por el process.exit() propio de Commander, con código 1 y sin
      // drenar las atestaciones ni cerrar el pool.
      const raiz = codigoDe('src/cli/mnemosine.ts');
      return /exitOverride/.test(raiz)
        ? ok(`ninguna hoja aplasta su código de salida (${archivos.length} archivos barridos) y Commander pasa por la puerta del kernel`)
        : falla('el program perdió exitOverride: los errores de uso saldrían con 1 y sin cerrar el pool');
    },
  },


  // ══════════════════════════════════════════════════════════
  // A7·remate. Las tres ganancias que A7 dejó nombradas, más la que
  // apareció mirándolas: el panel se podía contestar en blanco.
  // ══════════════════════════════════════════════════════════
  {
    paquete: 'E5.1',
    id: 'eval-harness-measures-shipped-surface',
    enunciado:
      'El arnés del eval mide la superficie que se embarca, y no puede salir en verde sin haber medido',
    mutantes: [
      {
        archivo: 'scripts/eval-clasificador.ts',
        de: '          herramientas: SUPERFICIE_INGESTA,',
        a: '          // herramientas: sin lista',
        porque:
          'clasificador-más-ancho: buildTools sin lista devuelve las 25 herramientas mientras la ingesta embarca 11, así que el arnés juzgaría a un agente que nadie corre — y la cabecera del propio arnés lo prohíbe por escrito',
      },
    ],
    evaluar: () => {
      const arnes = codigoDe('scripts/eval-clasificador.ts');
      const hoja = codigoDe('src/cli/mnemosine.ts');
      // La MISMA constante en los dos sitios: el arnés no puede medir una
      // superficie que la hoja no embarca, ni al revés.
      if (!/herramientas: SUPERFICIE_INGESTA/.test(arnes)) {
        return falla('el arnés del eval abre sesión sin superficie nombrada: buildTools le daría las 25 y mediría un clasificador que la ingesta no embarca');
      }
      if (!/herramientas: SUPERFICIE_INGESTA/.test(hoja)) {
        return falla('la hoja de ingest dejó de pasar su superficie: el arnés mediría una cosa y el contador correría otra');
      }
      // El código de salida distingue «medí y salió mal» de «NO PUDE MEDIR».
      // Es la doctrina que kernel/exit.ts publica en su cabecera, y el arnés
      // salía 0 con el proveedor caído al cien por cien.
      if (!/process\.exitCode = codigoDeSalida\(/.test(arnes)) {
        return falla('el arnés dejó de fijar su salida con el veredicto: una llave caducada volvería a producir casilla verde');
      }
      if (!/EXTERNAL_FAILED/.test(arnes)) {
        return falla('el arnés perdió la rama del fallo del proveedor: «no pude mirar» volvería a contarse como «no encontré nada»');
      }
      // Y siembra el panel que el corpus declara: puntuar un caso bajo un
      // panel distinto del declarado es medir con una vara chueca.
      return /politicasRequeridas\(/.test(arnes)
        ? ok('el arnés mide la superficie embarcada, siembra el panel declarado y su salida dice si midió')
        : falla('el arnés dejó de leer las precondiciones de política del corpus: puntuaría los casos bajo el panel por omisión');
    },
  },
  {
    paquete: 'E5.1',
    id: 'batch-cfdi-scoped-and-recorded',
    enunciado:
      'Todo camino que clasifica CFDI por lotes corre con superficie recortada y deja su fila de corrida',
    mutantes: [
      {
        archivo: 'src/cli/init/s5-import.ts',
        // El ancla es el USO, no el import: quitar la línea 14 rompe la
        // compilación pero deja el nombre en la línea 121, y un criterio que
        // busca el texto lo bendecía igual. El espejo tiene que quitar la
        // CONDUCTA, no el símbolo — y este mutante lo cobró en su primera
        // corrida, que es exactamente para lo que sirve.
        de: '    herramientas: SUPERFICIE_INGESTA,',
        a: '    // sin superficie: buildTools devuelve las 25',
        porque:
          'la-clase-a-medias: se reparó la hoja de `ingest` y quedó vivo el segundo camino — el alta clasifica una carpeta entera con las 25 herramientas, brazo externo incluido, y sin dejar una sola fila de corrida',
      },
    ],
    evaluar: () => {
      // Los DOS caminos, contados. Reparar uno y dejar el otro es la instancia,
      // no la clase: `mnemosine init` clasifica por lotes igual que `ingest`.
      const caminos = [
        { rel: 'src/cli/mnemosine.ts', nombre: 'la hoja de ingest' },
        { rel: 'src/cli/init/s5-import.ts', nombre: 'el alta (init)' },
      ];
      for (const c of caminos) {
        const src = codigoDe(c.rel);
        // El CABLEADO, no el nombre. La primera versión buscaba
        // «SUPERFICIE_INGESTA» a secas y el import solo ya la satisfacía: se
        // podía borrar la línea que la PASA y el criterio seguía verde. Lo
        // cazó su propio espejo en la primera corrida, que es para lo que el
        // arnés de mutación existe.
        if (!/herramientas:\s*SUPERFICIE_INGESTA/.test(src)) {
          return falla(`${c.nombre} clasifica por lotes sin pasar su superficie: buildTools le devolvería las 25 herramientas, con el brazo externo dentro`);
        }
        if (!/conCorridaRegistrada\(/.test(src)) {
          return falla(`${c.nombre} no envuelve su bucle: una corrida que muera a media lista dejaría los borradores y cero filas de corrida`);
        }
      }
      // Y la fila se abre ANTES del bucle, que es la mitad que la 044 no tenía:
      // sin estado no se distingue «murió a medias» de «no encontró nada».
      const m = crudoDe('src/database/migrations/060_la_corrida_que_se_abre_antes.sql');
      return /status/.test(m) && /closed_at/.test(m)
        ? ok('los dos caminos de lote corren recortados y su corrida se abre antes del bucle, con estado y cierre')
        : falla('la 058 perdió el estado o el cierre de la corrida: una fila abierta para siempre es indistinguible de una corrida vacía');
    },
  },
];
