import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { program } from '../../src/cli/mnemosine.js';
import { declareRisk, riskOf } from '../../src/cli/kernel/risk.js';
import { FLAG_DICTIONARY } from '../../src/cli/kernel/flags.js';
import { LINEA_BASE as LINEA_BASE_AUDITORIA } from '../../src/cli/kernel/audit.js';
import { OBJECTLESS_COMMANDS, VERBS } from '../../src/cli/kernel/vocabulary.js';
import {
  CLAVES,
  LINEAS_BASE,
  SALIDA_NO_TABULAR,
  apretar,
  censar,
  comparar,
  faltaAlias,
  fueraDeIdioma,
  main,
  tieneEjemplo,
  type Censo,
  type Clave,
  type Efectos,
} from '../../scripts/ux-status.js';

/**
 * EL TAMAÑO DEL ÁRBOL DE HOY, PEGADO A LO MEDIDO.
 *
 * Los dos sitios que comprueban «se censó el binario entero» decían
 * `toBeGreaterThan(150)` y `toBeGreaterThan(20)` sobre un árbol de 210 hojas y
 * 56 familias de primer nivel. Sesenta puntos de holgura no son un margen de
 * seguridad: son la misma forma de permiso que `SUELO_HOJAS` de
 * tests/cli/ejemplos-de-ayuda.spec.ts corrigió al pasar de
 * `toBeGreaterThan(80)` a 210, y la misma que este archivo le reprocha a la
 * lista escrita a mano.
 *
 * QUÉ AVERÍA TAPABA, MEDIDO Y NO SUPUESTO. Se le puso a `andar` un `return`
 * para la familia `bank` —un recorrido que deja de ver una rama entera, 32
 * hojas— y el censo salió con 178 hojas y CINCO de las seis medidas idénticas:
 * `bank` está documentada entera, así que perderla de vista no sube
 * `hojas-sin-ejemplo` ni ninguna otra salvo `banderas-del-diccionario-sin-hoja`.
 * `holguras` quedó VACÍA: el trinquete de encoger no vio nada que apretar, y
 * `toBeGreaterThan(150)` pasaba en verde con 178. Pegado a 210 falla, y falla
 * diciendo el número: «expected 178 to be greater than or equal to 210».
 *
 * NO ES EL ÚNICO GUARDIÁN Y NO SE VENDE COMO TAL. El cruce derivado de más
 * arriba —`censar(program).nodos` contra `contarNodos(program)`, una recursión
 * independiente— también cazó ese mutante, y es de mejor forma que un número
 * escrito: no envejece. Éste es su equivalente por el lado de las HOJAS, donde
 * no hay cruce derivado, y sobre todo es la diferencia entre afirmar «el árbol
 * tiene 210 hojas» y afirmar «más de 150», que es afirmar casi nada.
 *
 * Son SUELOS: un árbol que crece nunca los rompe, así que no hay que
 * mantenerlos al día; sólo suben cuando alguien quiera volver a apretarlos,
 * como los tres de ejemplos-de-ayuda.spec.ts.
 */
const HOJAS_DE_HOY = 210;
const FAMILIAS_DE_HOY = 56;

/**
 * EL CENSO CUENTA SOBRE EL ÁRBOL, NO SOBRE UNA LISTA.
 *
 * El guardián que ya había (bilingual-matrix.spec.ts) mide contra un mapa
 * escrito a mano: catorce familias de cuarenta y cinco, diez expresiones
 * regulares sobre cuatro pantallas de ciento setenta y ocho. Pasa en verde
 * porque lo que no está en la lista no existe para él.
 *
 * Por eso lo primero que este archivo prueba no es un número: es que `censar`
 * MIDE. Se le da un programa sintético construido aquí mismo y se comprueba
 * que sus seis cuentas se mueven con lo que ese árbol tiene y le falta. Una
 * prueba que sólo comparase los números de hoy contra la línea base tendría el
 * defecto de la lista paralela otra vez —afirmaría que dos constantes son
 * iguales— y además el defecto que tuvo el trinquete de cobertura: leer llaves
 * y no valores, de modo que una línea base puesta en un número absurdo pasaba.
 *
 * Y la segunda mitad del archivo mide AL PROPIO CENSO con la vara que él usa.
 * De ahí salieron cinco defectos el 2026-09-02 —prosa en el stdout del
 * contrato de máquina, dos ramas sin un solo caso, la raíz sin censar, dos
 * falsos positivos en el detector de ejemplos y un hueco sin declarar en el de
 * alias— y cada uno tiene aquí abajo el caso que lo mata si vuelve.
 */

const RAIZ_REPO = path.join(__dirname, '..', '..');
const RUTA_CENSO = path.join(RAIZ_REPO, 'scripts', 'ux-status.ts');

/** Un programa de juguete con una hoja que cumple y otra que no. */
function programaSintetico(): Command {
  const raiz = new Command('juguete');
  const familia = raiz.command('widget').description('Widget commands');

  // La hoja que cumple: alias del vocabulario, ejemplo en la ayuda, contrato
  // de salida completo y prosa en el idioma canónico.
  const buena = familia
    .command('list')
    .alias('listar')
    .description('List the widgets')
    .option('--format <fmt>', 'output format')
    .option('--json', 'shorthand for --format json')
    .option('--jq <expr>', 'filter the json output')
    .addHelpText('after', '\nExamples:\n  $ juguete widget list --json\n');
  declareRisk(buena, { risk: 'lectura' });

  // La hoja que no cumple, en las cuatro cosas a la vez.
  const mala = familia
    .command('show')
    .description('Muestra un widget por su nombre')
    .option('--quiet', 'identifiers only');
  declareRisk(mala, { risk: 'lectura' });

  return raiz;
}

/** Los nodos del árbol contados aparte del censo, RAÍZ INCLUIDA. */
function contarNodos(cmd: Command): number {
  return 1 + (cmd.commands ?? []).reduce((suma, hijo) => suma + contarNodos(hijo), 0);
}

/** Toda hoja del árbol, con su ruta como la teclea una persona. */
function hojasDe(cmd: Command, cadena: string[] = []): Array<{ ruta: string; cmd: Command }> {
  const hijos = cmd.commands ?? [];
  if (hijos.length === 0) return cadena.length > 0 ? [{ ruta: cadena.join(' '), cmd }] : [];
  return hijos.flatMap((h) => hojasDe(h, [...cadena, h.name()]));
}

describe('el censo cuenta sobre el árbol que se le da', () => {
  const censo = censar(programaSintetico());

  it('cuenta las hojas y los nodos del árbol sintético, no los del binario', () => {
    expect(censo.hojas).toBe(2);
    // juguete (la raíz) + widget + list + show. La raíz cuenta como NODO
    // desde que se arregló el defecto (c); ver la prueba que lo ancla.
    expect(censo.nodos).toBe(4);
  });

  it('la hoja sin ejemplo cuenta y la que lo tiene no', () => {
    expect(censo.numeros['hojas-sin-ejemplo']).toBe(1);
    expect(censo.casos['hojas-sin-ejemplo'][0].sujeto).toBe('widget show');
  });

  it('la hoja de lectura sin --format/--json cuenta', () => {
    expect(censo.numeros['hojas-sin-contrato-de-salida']).toBe(1);
    expect(censo.casos['hojas-sin-contrato-de-salida'][0]).toEqual({
      sujeto: 'widget show',
      motivo: 'falta --format y --json',
    });
  });

  it('la hoja sin alias cuenta', () => {
    expect(censo.numeros['hojas-sin-alias-castellano']).toBe(1);
    expect(censo.casos['hojas-sin-alias-castellano'][0].sujeto).toBe('widget show');
  });

  it('la prosa fuera del idioma canónico cuenta por NODO', () => {
    expect(censo.numeros['nodos-fuera-del-idioma-canonico']).toBe(1);
    expect(censo.casos['nodos-fuera-del-idioma-canonico'][0].sujeto).toBe('widget show');
  });

  it('un nodo con TRES frases fuera de idioma cuenta UNA vez', () => {
    // EL MUTANTE: borrar el `break` del bucle de idioma. Sin esta prueba el
    // programa sintético sólo tenía una frase castellana por nodo, así que
    // quitar el `break` no movía ningún número y la decisión —«se cuenta la
    // PANTALLA, no la frase, porque una pantalla se arregla de una vez»— no
    // estaba defendida por nada. Con tres frases en el mismo nodo, el censo da
    // 3 con el mutante y 1 sin él.
    const raiz = new Command('juguete');
    raiz
      .command('widget')
      .description('Muestra la lista de widgets')
      .option('--nombre <n>', 'nombre del widget')
      .option('--fecha <f>', 'la fecha de alta');

    const c = censar(raiz);
    expect(c.numeros['nodos-fuera-del-idioma-canonico']).toBe(1);
    expect(c.casos['nodos-fuera-del-idioma-canonico']).toHaveLength(1);
    // Y el caso nombra la PRIMERA frase, que es por donde se empieza a arreglar.
    expect(c.casos['nodos-fuera-del-idioma-canonico'][0].motivo).toContain('descripción');
  });

  it('una bandera del diccionario que el árbol declara sale de la lista, y la que no, entra', () => {
    const sinHoja = censo.casos['banderas-del-diccionario-sin-hoja'].map((c) => c.sujeto);
    // `--jq` la declara la hoja buena; `--cursor` no la declara nadie.
    expect(sinHoja).not.toContain('--jq');
    expect(sinHoja).toContain('--cursor');
    expect(censo.numeros['banderas-del-diccionario-sin-hoja']).toBe(
      Object.keys(FLAG_DICTIONARY).filter((f) => !['--format', '--json', '--jq', '--quiet'].includes(f))
        .length
    );
  });

  it('una hoja grave a la que le falta una de las tres banderas cuenta', () => {
    const raiz = new Command('juguete');
    const grave = raiz.command('widget').command('delete').description('Delete a widget');
    declareRisk(grave, { risk: 'irreversible' });
    // `declareRisk` inyecta las tres; se retira una a mano para provocar
    // exactamente el caso que el número vigila: una hoja grave registrada por
    // fuera del núcleo, sin la marcha seca que su clase de riesgo exige.
    const opciones = grave.options as unknown as Array<{ long: string | undefined }>;
    const i = opciones.findIndex((o) => o.long === '--dry-run');
    expect(i, 'declareRisk tiene que haber inyectado --dry-run').toBeGreaterThanOrEqual(0);
    opciones.splice(i, 1);

    const c = censar(raiz);
    expect(c.numeros['hojas-graves-sin-las-tres-banderas']).toBe(1);
    expect(c.casos['hojas-graves-sin-las-tres-banderas'][0].motivo).toContain('--dry-run');
  });

  it('y una hoja EXTERNA a la que le falta una de las tres también', () => {
    // EL MUTANTE: estrechar `riesgo.risk === 'irreversible' || riesgo.risk ===
    // 'externo'` a sólo 'irreversible'. Pasaba en verde: la rama 'externo' no
    // la ejercía nadie. Y no es una rama de adorno — hay cuatro hojas
    // 'externo' declaradas en el árbol embarcado (la prueba de abajo las
    // cuenta) que se quedarían sin vigilancia: son justamente las que llaman
    // al PAC, al SAT o a un banco, donde una repetición no se deshace.
    const raiz = new Command('juguete');
    const externa = raiz.command('cfdi').command('stamp').description('Stamp with the PAC');
    declareRisk(externa, { risk: 'externo' });
    const opciones = externa.options as unknown as Array<{ long: string | undefined }>;
    const i = opciones.findIndex((o) => o.long === '--yes');
    expect(i, 'declareRisk tiene que haber inyectado --yes').toBeGreaterThanOrEqual(0);
    opciones.splice(i, 1);

    const c = censar(raiz);
    expect(c.numeros['hojas-graves-sin-las-tres-banderas']).toBe(1);
    expect(c.casos['hojas-graves-sin-las-tres-banderas'][0].motivo).toBe(
      'riesgo "externo" sin --yes'
    );
  });

  it('el árbol embarcado tiene hojas «externo» de verdad, y con sus tres banderas', () => {
    const externas = hojasDe(program).filter((h) => riskOf(h.cmd)?.risk === 'externo');
    expect(externas.length, 'si esto baja de cuatro, alguien retiró una declaración').toBeGreaterThanOrEqual(4);
    for (const { ruta, cmd } of externas) {
      const declara = new Set(cmd.options.map((o) => o.long));
      for (const bandera of ['--dry-run', '--yes', '--idempotency-key']) {
        expect(declara.has(bandera), `${ruta} sin ${bandera}`).toBe(true);
      }
    }
  });
});

describe('la raíz también es un nodo', () => {
  /**
   * EL DEFECTO (c): `censar` sólo andaba los HIJOS de la raíz. Sus banderas
   * globales SÍ entraban en `declaradas` —`-T/--tenant` salía por ahí de
   * `banderas-del-diccionario-sin-hoja`— pero su prosa no entraba en ninguna
   * cuenta. El censo veía la raíz para un número y no para el otro, y la
   * descripción del programa y la ayuda de sus banderas globales salen en las
   * 210 pantallas: si están fuera del idioma, están mal en las 210.
   */
  it('la prosa de la raíz entra en el idioma canónico, con el binario por ruta', () => {
    const raiz = new Command('juguete')
      .description('Herramienta de juguete para la prueba')
      .option('-T, --tenant <id>', 'entidad sobre la que se opera');
    raiz.command('widget').description('Widget commands');

    const c = censar(raiz);
    expect(c.numeros['nodos-fuera-del-idioma-canonico']).toBe(1);
    expect(c.casos['nodos-fuera-del-idioma-canonico'][0].sujeto).toBe('juguete');
  });

  it('y se cuenta como NODO, nunca como HOJA', () => {
    // Una raíz sin hijos no es una hoja: no tiene verbo del vocabulario, ni
    // clase de riesgo, ni alias castellano que exigirle. Contarla de hoja
    // metería un caso falso en tres de los seis números.
    const sola = new Command('juguete').description('A toy');
    const c = censar(sola);
    expect(c.nodos).toBe(1);
    expect(c.hojas).toBe(0);
    expect(c.numeros['hojas-sin-ejemplo']).toBe(0);
    expect(c.numeros['hojas-sin-alias-castellano']).toBe(0);
  });

  it('en el árbol embarcado, `nodos` cuenta uno por comando y uno por la raíz', () => {
    // El conteo independiente: si alguien vuelve a andar sólo los hijos, este
    // número se queda uno corto y esta prueba lo dice.
    expect(censar(program).nodos).toBe(contarNodos(program));
  });
});

describe('las trampas del detector', () => {
  it('un alias acentuado escrito en NFD cuenta como presente', () => {
    // `período` con la o precompuesta (NFC) y con acento combinante (NFD) son
    // la misma palabra y distintas cadenas. Sin normalizar, el alias que SÍ
    // existe cuenta como ausente y el número sube sin que nadie rompa nada.
    const nfd = 'período'.normalize('NFD');
    expect(nfd).not.toBe('período'.normalize('NFC'));
    expect(faltaAlias('period', [nfd], 'período')).toBeNull();
    // Y el alias equivocado sí se ve, que es la mitad que la lista a mano no veía.
    expect(faltaAlias('correct', ['corrige'], 'corregir')).toMatch(/corregir/);
    expect(faltaAlias('correct', ['corregir'], 'corregir')).toBeNull();
  });

  it('un valor literal entre comillas no convierte una frase inglesa en castellana', () => {
    // La descripción de `lang` es «'en' or 'es'; omit to show the current
    // setting»: el `'es'` es uno de los dos valores que acepta, no una palabra.
    expect(fueraDeIdioma("'en' or 'es'; omit to show the current setting")).toBeNull();
    expect(fueraDeIdioma('Muestra la cuenta por su nombre')).not.toBeNull();
    expect(fueraDeIdioma('Métricas del agente')).toBe('acento o eñe');
  });

  it('la línea `Usage:` no cuenta como ejemplo, ni la escriba Commander ni un autor', () => {
    const raiz = new Command('juguete');
    const hoja = raiz.command('widget').description('a leaf');
    expect(hoja.helpInformation()).toMatch(/Usage: juguete widget/);
    expect(tieneEjemplo(hoja, 'juguete')).toBe(false);

    // Repetir la sinopsis dentro de un bloque propio tampoco enseña nada: es
    // la forma más barata de bajar el número sin escribir un ejemplo.
    hoja.addHelpText('after', '\nUsage: juguete widget [options]\n');
    expect(tieneEjemplo(hoja, 'juguete')).toBe(false);

    hoja.addHelpText('after', '\nExamples:\n  $ juguete widget --json\n');
    expect(tieneEjemplo(hoja, 'juguete')).toBe(true);
  });

  it('una referencia cruzada o una advertencia NO son un ejemplo', () => {
    /**
     * EL DEFECTO (d), y los dos falsos positivos de 117 que produjo:
     *
     *   · `pending define` contaba por «key  Decision key (see: mnemosine
     *     pending)» —una referencia cruzada en la descripción de un argumento;
     *   · `backup create` contaba por «NOT here: a per-entity archive is
     *     `mnemosine backup export --entity <idOrName>`» —una advertencia de
     *     lo que NO hay que teclear, en la descripción de una bandera.
     *
     * EL MUTANTE: volver a medir la ayuda ENTERA (`helpInformation()` con los
     * eventos emitidos) en vez de la prosa que un autor escribió. Las dos
     * primeras aserciones mueren.
     */
    const raiz = new Command('juguete');
    const hoja = raiz
      .command('define')
      .description('Defines a pending decision')
      .argument('<key>', 'Decision key (see: juguete pending)')
      .option('-e, --entity <id>', 'NOT here: use `juguete backup export --entity <id>`');

    // La ayuda entera SÍ lleva las dos invocaciones: el detector no puede
    // mirarla, no que ahí no estén.
    expect(hoja.helpInformation()).toContain('juguete pending');
    expect(hoja.helpInformation()).toContain('juguete backup export');
    expect(tieneEjemplo(hoja, 'juguete')).toBe(false);

    // Y lo que un autor escribe para enseñar sí cuenta, venga de `addHelpText`…
    hoja.addHelpText('after', '\nExamples:\n  $ juguete define lang es\n');
    expect(tieneEjemplo(hoja, 'juguete')).toBe(true);
  });

  it('…o de una descripción que remata con la invocación concreta', () => {
    const raiz = new Command('juguete');
    const hoja = raiz
      .command('chat')
      .description('Open a session; resume one with: juguete chat --resume <id>');
    expect(tieneEjemplo(hoja, 'juguete')).toBe(true);
  });

  it('y en el árbol real, las dos hojas que se colaban cuentan', () => {
    const sinEjemplo = new Set(censar(program).casos['hojas-sin-ejemplo'].map((c) => c.sujeto));
    for (const ruta of ['pending define', 'backup create']) {
      expect(
        sinEjemplo.has(ruta),
        `«${ruta}» dejó de contar como hoja sin ejemplo. Si es porque alguien le ESCRIBIÓ ` +
          'un ejemplo de verdad, borra su renglón de esta lista y aprieta el trinquete. Si es ' +
          'porque el detector volvió a mirar la ayuda entera, deshaz eso.'
      ).toBe(true);
    }
  });
});

describe('lo que `hojas-sin-alias-castellano` NO comprueba, dicho por escrito', () => {
  /**
   * EL DEFECTO (e): para un verbo que no está en `VERBS`, cualquier alias
   * vale, incluso inglés. Se decidió DECLARARLO en vez de fingir que no está
   * (el porqué, entero, en el docstring de `faltaAlias`): decidir si un token
   * suelto es castellano necesita un diccionario que este repositorio no
   * tiene, y la heurística que cabría daría exactamente los falsos positivos
   * que el defecto (d) acaba de quitar.
   */
  it('para un verbo fuera del vocabulario cerrado sólo se comprueba PRESENCIA', () => {
    expect(faltaAlias('run-due', ['ejecutar-vencidos'], undefined)).toBeNull();
    // El hueco, en una aserción, para que nadie lo descubra por sorpresa:
    expect(faltaAlias('run-due', ['whatever-in-english'], undefined)).toBeNull();
    // Lo que sí se comprueba siempre: que haya alias, y que no sea el nombre.
    expect(faltaAlias('run-due', [], undefined)).toBe('no declara ningún alias');
    expect(faltaAlias('run-due', ['run-due'], undefined)).toBe('no declara ningún alias');
    // Y para un verbo que SÍ está, la palabra exacta es obligatoria.
    expect(faltaAlias('run', ['whatever-in-english'], VERBS['run'])).toMatch(/ejecutar/);
  });

  it('el hueco está ACOTADO: ninguna hoja con verbo fuera del vocabulario está sin registrar', () => {
    // Esto es lo que convierte la declaración en una promesa comprobable. El
    // vocabulario es CERRADO; toda hoja cuyo último token no esté en `VERBS`
    // tiene que estar registrada en otro sitio que también sólo puede
    // encoger: `OBJECTLESS_COMMANDS`, o nombrada una a una en la `LINEA_BASE`
    // de src/cli/kernel/audit.ts. El día que un verbo entra en `VERBS`,
    // `faltaAlias` pasa sola a exigirle la palabra exacta.
    const registradas = new Set(LINEA_BASE_AUDITORIA.map((l) => l.split('|')[0]));
    const huerfanas = hojasDe(program)
      .filter((h) => !(h.cmd.name() in VERBS))
      .filter((h) => !OBJECTLESS_COMMANDS.includes(h.cmd.name()) && !registradas.has(h.ruta))
      .map((h) => h.ruta);
    expect(
      huerfanas,
      'Estas hojas tienen un verbo fuera del vocabulario cerrado y no están registradas en ' +
        'ninguna parte: para ellas el censo sólo comprueba que HAYA alias, no que sea ' +
        'castellano. O el verbo entra en VERBS, o la hoja entra en la LINEA_BASE de audit.ts.'
    ).toEqual([]);
  });
});

describe('las excepciones de contrato de salida sólo pueden encoger', () => {
  /**
   * EL DEFECTO (f): `hojas-sin-contrato-de-salida` subió a 22 por
   * `completion`, cuya salida es un GUION DE SHELL. Ver `SALIDA_NO_TABULAR`
   * para las tres salidas que se barajaron y por qué gana la lista explícita.
   */
  it('cada excepción escrita tapa algo que existe hoy', () => {
    expect(
      censar(program).excepcionesMuertas,
      'Estas excepciones ya no tapan nada: bórralas de SALIDA_NO_TABULAR. Una excepción que ' +
        'deja de hacer falta y se queda escrita es un permiso permanente.'
    ).toEqual([]);
  });

  it('sin la lista, la hoja exceptuada cuenta: la excepción no es decorativa', () => {
    const con = censar(program);
    const sin = censar(program, {});
    const rutas = Object.keys(SALIDA_NO_TABULAR);
    expect(rutas.length).toBeGreaterThan(0);
    for (const ruta of rutas) {
      expect(sin.casos['hojas-sin-contrato-de-salida'].map((c) => c.sujeto)).toContain(ruta);
      expect(con.casos['hojas-sin-contrato-de-salida'].map((c) => c.sujeto)).not.toContain(ruta);
    }
    expect(sin.numeros['hojas-sin-contrato-de-salida']).toBe(
      con.numeros['hojas-sin-contrato-de-salida'] + rutas.length
    );
  });

  it('la lista es ÉSTA, entera: una excepción nueva no entra en silencio', () => {
    // La otra mitad del «sólo puede encoger». Que una entrada muerta falle
    // impide que la lista se quede con permisos vencidos; esto impide que
    // crezca de tapadillo. Añadir una excepción cuesta dos actos visibles —el
    // renglón con su razón en scripts/ux-status.ts y este renglón aquí—, que
    // es exactamente lo que cuesta subir una línea base a mano.
    expect(Object.keys(SALIDA_NO_TABULAR)).toEqual(['completion']);
  });

  it('cada excepción lleva su razón escrita al lado', () => {
    for (const [ruta, razon] of Object.entries(SALIDA_NO_TABULAR)) {
      expect(razon.length, `la excepción «${ruta}» no dice por qué`).toBeGreaterThan(40);
    }
  });

  it('una excepción que no tapa nada sale por `excepcionesMuertas`', () => {
    const c = censar(program, { ...SALIDA_NO_TABULAR, 'hoja que no existe': 'una razón cualquiera' });
    expect(c.excepcionesMuertas).toEqual(['hoja que no existe']);
  });

  it('y la excepción no tapa una hoja que MUTA: sólo se exceptúa lo de lectura', () => {
    const raiz = new Command('juguete');
    const escribe = raiz.command('widget').command('create').description('Create a widget');
    declareRisk(escribe, { risk: 'escritura' });
    // Una hoja de escritura nunca estuvo en este número, así que exceptuarla
    // no tapa nada y la excepción sale como muerta en vez de dar permiso.
    const c = censar(raiz, { 'widget create': 'razón que no viene al caso' });
    expect(c.numeros['hojas-sin-contrato-de-salida']).toBe(0);
    expect(c.excepcionesMuertas).toEqual(['widget create']);
  });
});

describe('el trinquete: la línea base sólo puede encoger', () => {
  const censo = censar(program);

  it('se censa el binario entero: si no, esto no prueba nada', () => {
    expect(program.commands.length).toBeGreaterThanOrEqual(FAMILIAS_DE_HOY);
    expect(censo.hojas).toBeGreaterThanOrEqual(HOJAS_DE_HOY);
  });

  it('ningún número CRECIÓ sobre su línea base', () => {
    const { crecidas } = comparar(censo);
    expect(
      crecidas.map((c) => `${c.clave}: ${c.lineaBase} -> ${c.medido}`),
      'La superficie empeoró. Arregla la hoja nueva —ejemplo, contrato de salida, alias, ' +
        'idioma— o, si el crecimiento es deliberado, sube la línea base a mano en ' +
        'scripts/ux-status.ts y dilo en el commit: es lo único que deja rastro.'
    ).toEqual([]);
  });

  it('ninguna línea base quedó con holgura', () => {
    // Esta es la prueba que lee VALORES y no llaves. El trinquete de cobertura
    // tuvo justo ese defecto —comparaba las claves del objeto de umbrales— y
    // por eso una línea base puesta en un número absurdo pasaba en verde. Con
    // ésta, poner `'hojas-sin-ejemplo': 99999` falla aquí y nombra el número.
    const { holguras } = comparar(censo);
    expect(
      holguras.map((h) => `${h.clave}: ${h.lineaBase} -> ${h.medido}`),
      'Estos números bajaron: aprieta el trinquete con `npm run ux:status -- --apretar`. Una ' +
        'línea base con holgura deja de ser deuda registrada y se vuelve un permiso permanente.'
    ).toEqual([]);
  });

  it('hay línea base para las seis medidas y ninguna es negativa', () => {
    for (const clave of CLAVES) {
      expect(LINEAS_BASE[clave], `falta la línea base de ${clave}`).toBeTypeOf('number');
      expect(LINEAS_BASE[clave]).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(LINEAS_BASE).sort()).toEqual([...CLAVES].sort());
  });

  it('`comparar` distingue crecer de encoger', () => {
    const base = Object.fromEntries(
      CLAVES.map((c) => [c, censo.numeros[c]])
    ) as Record<Clave, number>;
    expect(comparar(censo, base)).toEqual({ crecidas: [], holguras: [] });

    const masExigente = { ...base, 'hojas-sin-ejemplo': base['hojas-sin-ejemplo'] - 1 };
    expect(comparar(censo, masExigente).crecidas).toEqual([
      { clave: 'hojas-sin-ejemplo', medido: base['hojas-sin-ejemplo'], lineaBase: base['hojas-sin-ejemplo'] - 1 },
    ]);

    const absurda = { ...base, 'hojas-sin-ejemplo': 99_999 };
    expect(comparar(censo, absurda).holguras).toEqual([
      { clave: 'hojas-sin-ejemplo', medido: base['hojas-sin-ejemplo'], lineaBase: 99_999 },
    ]);
  });
});

describe('`--apretar` sólo aprieta', () => {
  /** Un censo de mentira, para no depender de lo que mida hoy el binario. */
  function censoDe(numeros: Partial<Record<Clave, number>>): Censo {
    const completos = Object.fromEntries(
      CLAVES.map((c) => [c, numeros[c] ?? 0])
    ) as Record<Clave, number>;
    const casos = Object.fromEntries(
      CLAVES.map((c) => [c, [] as Censo['casos'][Clave]])
    ) as Censo['casos'];
    return { hojas: 0, nodos: 0, numeros: completos, casos, excepcionesMuertas: [] };
  }

  const FUENTE = [
    "export const LINEAS_BASE: Readonly<Record<Clave, number>> = Object.freeze({",
    "  'hojas-sin-ejemplo': 151,",
    "  'hojas-sin-contrato-de-salida': 21,",
    "  'hojas-sin-alias-castellano': 17,",
    "  'nodos-fuera-del-idioma-canonico': 6,",
    "  'hojas-graves-sin-las-tres-banderas': 0,",
    "  'banderas-del-diccionario-sin-hoja': 11,",
    '});',
  ].join('\n');

  const BASE_FUENTE: Record<Clave, number> = {
    'hojas-sin-ejemplo': 151,
    'hojas-sin-contrato-de-salida': 21,
    'hojas-sin-alias-castellano': 17,
    'nodos-fuera-del-idioma-canonico': 6,
    'hojas-graves-sin-las-tres-banderas': 0,
    'banderas-del-diccionario-sin-hoja': 11,
  };

  it('baja el número que quedó con holgura y no toca los demás', () => {
    const { texto, apretadas } = apretar(
      FUENTE,
      censoDe({ ...BASE_FUENTE, 'hojas-sin-ejemplo': 140 }),
      BASE_FUENTE
    );
    expect(apretadas).toEqual([
      { clave: 'hojas-sin-ejemplo', medido: 140, lineaBase: 151 },
    ]);
    expect(texto).toContain("'hojas-sin-ejemplo': 140,");
    expect(texto).toContain("'hojas-sin-contrato-de-salida': 21,");
  });

  it('NUNCA sube una línea base: un número que creció deja el fuente intacto', () => {
    // Es la propiedad entera del trinquete. Si `apretar` subiera, bastaría
    // correr el script para legalizar cualquier degradación de la superficie y
    // el censo dejaría de vigilar nada.
    const { texto, apretadas } = apretar(
      FUENTE,
      censoDe({ ...BASE_FUENTE, 'hojas-sin-alias-castellano': 40 }),
      BASE_FUENTE
    );
    expect(apretadas).toEqual([]);
    expect(texto).toBe(FUENTE);
  });

  it('se niega en voz alta si no encuentra la línea base en el fuente', () => {
    expect(() =>
      apretar('const OTRA_COSA = {};', censoDe({ 'hojas-sin-ejemplo': 1 }), {
        ...BASE_FUENTE,
        'hojas-sin-ejemplo': 2,
      })
    ).toThrow(/hojas-sin-ejemplo/);
  });

  it('encuentra y reescribe las SEIS líneas base del ARCHIVO REAL, ida y vuelta', () => {
    // Hasta hoy ninguna prueba ejercía `apretar` contra este archivo: la
    // cadena sintética de arriba podía seguir casando mientras el fuente real
    // cambiaba de forma —un comentario entre las filas, otra sangría, las
    // comillas dobles— y `--apretar` habría muerto con «no encuentro la línea
    // base» el día que hiciera falta, que es el día que alguien arregla hojas.
    //
    // El viaje de ida escribe seis centinelas sobre el archivo real; el de
    // vuelta escribe LO MEDIDO y tiene que devolver el archivo tal cual está
    // en el disco. Eso prueba dos cosas de una vez: que la expresión encuentra
    // las seis filas donde de verdad viven, y que las líneas base de hoy son
    // exactamente lo que el censo mide.
    const fuente = fs.readFileSync(RUTA_CENSO, 'utf-8');
    const censo = censar(program);
    const centinelas = censoDe(
      Object.fromEntries(CLAVES.map((c, i) => [c, i + 1])) as Record<Clave, number>
    );
    const inalcanzable = (n: number): Record<Clave, number> =>
      Object.fromEntries(CLAVES.map((c) => [c, n])) as Record<Clave, number>;

    const ida = apretar(fuente, centinelas, inalcanzable(99_999));
    expect(ida.apretadas.map((a) => a.clave).sort()).toEqual([...CLAVES].sort());
    expect(ida.texto).not.toBe(fuente);
    for (const [i, clave] of CLAVES.entries()) {
      expect(ida.texto).toContain(`'${clave}': ${i + 1},`);
    }

    const vuelta = apretar(ida.texto, censo, inalcanzable(99_999));
    expect(vuelta.texto).toBe(fuente);
  });

  it('y contra las líneas base de HOY no cambia un byte del archivo real', () => {
    const fuente = fs.readFileSync(RUTA_CENSO, 'utf-8');
    const { texto, apretadas } = apretar(fuente, censar(program));
    expect(apretadas).toEqual([]);
    expect(texto).toBe(fuente);
  });
});

describe('stdout es el contrato de máquina y nada más', () => {
  /**
   * EL DEFECTO (a): `--json --apretar` imprimía el JSON y a continuación, en
   * el MISMO stdout, «Apretadas N línea(s) base:…» o «No hay holgura que
   * apretar.». `JSON.parse` de esa salida revienta con «Unexpected
   * non-whitespace character after JSON». Estaba enmascarado porque había una
   * medida crecida y `main` devolvía 1 antes de llegar: el día que esa subida
   * se cerrara —hoy— el contrato se habría roto sin que nadie tocara el JSON.
   */
  function efectosDeMentira(): Efectos & { salida: string[]; queja: string[]; escrito: string[] } {
    const salida: string[] = [];
    const queja: string[] = [];
    const escrito: string[] = [];
    return {
      salida,
      queja,
      escrito,
      fuera: (t) => void salida.push(t),
      error: (t) => void queja.push(t),
      leer: () => fs.readFileSync(RUTA_CENSO, 'utf-8'),
      escribir: (t) => void escrito.push(t),
    };
  }

  it('`--json` sale parseable, y `--json --apretar` también', () => {
    const solo = efectosDeMentira();
    expect(main(['--json'], solo)).toBe(0);
    expect(() => JSON.parse(solo.salida.join('')) as unknown).not.toThrow();

    const conApretar = efectosDeMentira();
    expect(main(['--json', '--apretar'], conApretar)).toBe(0);
    const crudo = conApretar.salida.join('');
    // La aserción que muere si la prosa vuelve a stdout:
    const censoLeido = JSON.parse(crudo) as { ok: boolean; hojas: number };
    expect(censoLeido.ok).toBe(true);
    expect(censoLeido.hojas).toBeGreaterThanOrEqual(HOJAS_DE_HOY);
    // Y la prosa está donde tiene que estar.
    expect(conApretar.queja.join('')).toContain('No hay holgura que apretar.');
    expect(conApretar.escrito, 'sin holgura no se reescribe el archivo').toEqual([]);
  });

  it('en `main` hay UNA sola escritura a stdout, y es el resultado', () => {
    // El otro renglón de prosa —«Apretadas N línea(s) base»— sólo se alcanza
    // cuando hay holgura, y hoy no la hay: sin esta prueba estructural, un
    // mutante que lo devolviera a stdout sobreviviría hasta el día que alguien
    // arreglara nueve hojas y corriera `--json --apretar` en un guion.
    const fuente = fs.readFileSync(RUTA_CENSO, 'utf-8');
    const cuerpo = fuente.slice(fuente.indexOf('export function main('));
    expect(cuerpo.match(/efectos\.fuera\(/g) ?? []).toHaveLength(1);
    expect(cuerpo).toContain(
      'efectos.fuera(json ? comoJson(censo, veredicto) : comoTabla(censo, veredicto));'
    );
  });

  it('`--check` devuelve 0 hoy, y el JSON lo dice en `ok`', () => {
    const e = efectosDeMentira();
    expect(main(['--check'], e)).toBe(0);
    const j = efectosDeMentira();
    main(['--json'], j);
    expect((JSON.parse(j.salida.join('')) as { ok: boolean }).ok).toBe(true);
  });
});

describe('el censo está cableado donde se ejecuta', () => {
  /**
   * EL DEFECTO (h): el censo no aparecía en ninguna parte de .github/, y nada
   * en tests/ leía los renglones de package.json —borrar «ux:status» no ponía
   * nada rojo, porque las pruebas importan el módulo directamente. Un
   * trinquete que no corre en CI es una intención.
   */
  it('CI lo corre, con la forma de sus dos precedentes', () => {
    const ci = fs.readFileSync(path.join(RAIZ_REPO, '.github', 'workflows', 'ci.yml'), 'utf-8');
    expect(ci).toContain('npx tsx scripts/ux-status.ts --check');
    // Y sus dos precedentes siguen ahí: si alguien rehace el job, que se vea.
    expect(ci).toContain('npx tsx scripts/catalogo-estado.ts --check');
    expect(ci).toContain('npx tsx scripts/corpus-manifiesto.ts --check');
  });

  it('y el renglón `ux:status` de package.json apunta a este guion', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(RAIZ_REPO, 'package.json'), 'utf-8')
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['ux:status']).toBe('tsx scripts/ux-status.ts');
  });
});
