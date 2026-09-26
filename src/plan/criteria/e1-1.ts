import * as path from 'node:path';
import {
  codigoDe,
  type Criterio,
  crudoDe,
  dondeAparece,
  existe,
  falla,
  fuentes,
  noEvaluable,
  ok,
  RAIZ,
  sinComentarios,
  spanishJurisdictionPaths,
} from './shared.js';

// ============================================================
// THE E1.1 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E1_1: Criterio[] = [
  {
    paquete: 'E1.1',
    id: 'law-is-read-by-date-and-fails-closed',
    enunciado: 'La ley se lee por la fecha del hecho, y sin vigencia falla en vez de devolver cero',
    evaluar: () => {
      // POR QUÉ NACE (J0.2, issue #123). La ley vivía quemada en el código o en
      // `tax_parameters`, que la guarda POR AÑO aunque la UMA cambie el 1 de
      // febrero. Y donde faltaba la fila, el sistema no se detenía: el IMSS
      // dejaba las tasas en CERO y el INFONAVIT aplicaba un 5 % quemado. Una
      // cifra inventada que cuadra es peor que un error, porque nadie la busca.
      //
      // Este criterio vigila las tres propiedades que hacen que la tabla no
      // nazca huérfana ni mienta: que se lea por FECHA, que falle CERRADO, y
      // que la columna del panel tenga quien la lea.
      const lector = codigoDe('src/services/jurisdiction/legal-parameters.ts');
      const panel = codigoDe('src/services/policy/policy-service.ts');

      // (a) POR LA FECHA DEL HECHO. Un recálculo de mayo tiene que leer la ley
      // de mayo. Sin `effective_from <= fecha` ordenado descendente, la lectura
      // devolvería la más reciente y reexpediría el pasado con la ley de hoy.
      if (!/AND effective_from <= \$3::date/.test(lector) || !/ORDER BY[^;]*effective_from DESC/i.test(lector)) {
        return falla(
          'el lector de la ley no elige por fecha del hecho: o no compara effective_from, o no toma la ' +
            'más reciente que la precede'
        );
      }

      // (b) FALLA CERRADO. Es el corazón del tramo: sin vigencia, LANZA.
      if (!/'never_loaded',/.test(lector) || !/if \(row === null\) \{/.test(lector)) {
        return falla(
          'el lector no lanza cuando no hay vigencia: si devuelve cero o un valor por omisión, repite el ' +
            'defecto del IMSS en cero que J0 viene a cerrar'
        );
      }

      // (c) LA COLUMNA TIENE LECTOR. Una columna que nadie selecciona es
      // capacidad huérfana, y `doctor` la acusa.
      if (!/jurisdiction/.test(panel)) {
        return falla('policy_decisions.jurisdiction no tiene lector en el servicio de políticas: nace muerta');
      }

      return ok(
        'la ley se lee por la fecha del hecho, falla cerrado sin vigencia, y la jurisdicción del panel ' +
          'tiene quien la lea'
      );
    },
    mutantes: [
      {
        archivo: 'src/services/jurisdiction/legal-parameters.ts',
        de: "        'never_loaded',",
        a: "        'ninguno', // el hueco deja de nombrarse",
        porque:
          'el lector deja de fallar cerrado: una clave sin vigencia pasaría a devolver un hueco en vez de ' +
          'detener el cálculo, que es exactamente cómo el IMSS acabó cotizando en cero',
      },
      {
        archivo: 'src/services/jurisdiction/legal-parameters.ts',
        de: 'AND effective_from <= $3::date',
        a: 'AND effective_from >= $3::date',
        porque:
          'invierte la fecha: la lectura devolvería la PRIMERA vigencia posterior al hecho en vez de la que ' +
          'regía, y un recálculo de mayo se haría con la ley que entró en junio',
      },
    ],
  },

  // ---- E1.1 · Roles de cuenta ----

  {
    paquete: 'E1.1',
    // La identidad la exige I0, que entró en main mientras este tramo
    // esperaba revisión: sin `id`, el piso no puede protegerlo y traducir su
    // enunciado lo daría de baja sin tocar el instrumento.
    id: 'single-jurisdiction-switch',
    enunciado:
      'La jurisdicción de una entidad se contesta en un solo sitio, y en SQL dice lo mismo que en TypeScript',
    evaluar: () => {
      // POR QUÉ NACE (J0.1, issue #123, docs/jurisdicciones.md §3.1).
      //
      // «¿Esta entidad lleva contabilidad mexicana?» tenía una respuesta
      // canónica y CUATRO copias que no la usaban. No difieren en el estilo:
      // difieren en la RESPUESTA. Con el país en minúsculas, o con un tercer
      // país, la entidad entraba en el estrato fiscal mexicano para el
      // sembrador y quedaba fuera para el censo de IVA y para el doctor. Es la
      // peor clase de convención: la que parece una y son varias.
      //
      // Y la mitad de SQL pesa tanto como la de TypeScript. El censo de IVA
      // PPD alimenta a `reclasificar`, que ESCRIBE asientos: si el predicado se
      // muda a JavaScript, la consulta se trae filas de más y la frontera sale
      // del SQL, que es donde este proyecto la exige.
      const p = 'src/services/jurisdiction/jurisdiction.ts';
      if (!existe(p)) {
        return falla('no hay conmutador de jurisdicción: la pregunta vuelve a contestarse en cada sitio');
      }
      const j = codigoDe(p);
      // Los DOS campos, anclados en su declaración y no en su nombre suelto:
      // `books` aparece también como variable local tres líneas más abajo, y
      // con el ancla floja un mutante que renombrara el campo de la interfaz
      // seguía encontrando la palabra y sobrevivía. Medir presencia donde hay
      // gemelos textuales es exactamente lo que este arnés castiga.
      if (!/^\s*fiscal: JurisdictionCode;$/m.test(j) || !/^\s*books: AccountingStandard;$/m.test(j)) {
        return falla(
          'el conmutador volvió a colapsar las dos preguntas: qué autoridad fiscal gobierna a la ' +
            'entidad y bajo qué norma lleva los libros no son la misma, y una filial extranjera con ' +
            'libros en NIF necesita las dos por separado'
        );
      }
      if (!/export function sqlKeepsMexicanBooks/.test(j)) {
        return falla(
          'el conmutador no publica su gemelo en SQL: la próxima consulta que acote por jurisdicción ' +
            'lo escribirá a mano, que es exactamente como nacieron las cuatro copias'
        );
      }
      const copias = dondeAparece(
        /(incorporation_country|accounting_standard)\s*(===|!==|==|=)\s*'/,
        ['src'],
        true
      ).filter((f) => !f.includes(path.join('services', 'jurisdiction')));
      return copias.length === 0
        ? ok('un solo conmutador, con su gemelo en SQL, y ninguna copia que compare la columna a mano')
        : falla(
            `${copias.length} archivo(s) vuelven a comparar la columna a mano: ${copias.join(', ')}`
          );
    },
    mutantes: [
      {
        archivo: 'src/services/accounting/iva-ppd-reclass.ts',
        de: "${sqlKeepsMexicanBooks('le')}",
        a: "le.incorporation_country = 'MX'",
        porque:
          'la copia inline renace dentro del SQL del censo, con el borde al revés: el mes de una ' +
          'entidad con el país en minúsculas deja de reclasificarse y nadie lo dice',
      },
      {
        archivo: 'src/ai/doctor-service.ts',
        de: "${sqlKeepsMexicanBooks('e')}",
        a: "e.incorporation_country = 'MX'",
        porque:
          'el doctor vuelve a preguntar por el país a secas y deja de revisar los roles de IVA que el ' +
          'sembrador sí creó: el diagnóstico deja de comprobar lo que la semilla hizo',
      },
      {
        archivo: 'src/services/jurisdiction/jurisdiction.ts',
        de: 'books: AccountingStandard;',
        a: 'booksNobodyReads: AccountingStandard;',
        porque:
          'el conmutador vuelve a ser un booleano con otro nombre: sin `books` no hay forma de decir ' +
          'que una filial de Delaware lleva libros en NIF, que es la mitad que el booleano colapsaba',
      },
    ],
  },
  {
    paquete: 'E1.1',
    id: 'jurisdiction-module-born-english',
    // I5 (issue #147). J0.1 se renombró al inglés EN SU PROPIA RAMA antes de
    // fusionar, a petición del revisor (WIT-140-01), y ése fue el punto: el
    // módulo tenía diez consumidores y CERO criterios por ruta, así que
    // renombrarlo antes costó S y después habría entrado a la línea base y
    // costado un tramo entero de I14.
    //
    // Lo que queda de aquel tramo es esto: la guarda de que no vuelva. Un
    // renombrado sin criterio es una decisión que dura hasta el primer
    // `git revert` o el primer archivo nuevo que copie el nombre de al lado.
    //
    // TRES AFIRMACIONES, y la tercera es la que hace que el tramo valga:
    // entrar sin deuda es distinto de entrar traducido. Un módulo puede estar
    // en inglés y aun así pesar en un carril; si pesa, el trinquete lo protege
    // y renombrarlo deja de ser gratis.
    enunciado:
      'El módulo de la jurisdicción no conserva un nombre español, ni pesa en un carril exigido del idioma',
    evaluar: () => {
      // 1 · LOS NOMBRES VIEJOS, TODOS. No sólo `esContabilidadMexicana`, que
      // es el que la issue nombra: los siete exportados y el directorio. Un
      // criterio que vigila uno de siete deja seis puertas abiertas, y el
      // `git revert` que las abriría las abre todas a la vez.
      const OLD_NAMES = [
        'jurisdiccionDe',
        'CodigoJurisdiccion',
        'NormaContable',
        'EntidadConJurisdiccion',
        'esContabilidadMexicana',
        'sqlEsContabilidadMexicana',
        // `Jurisdiccion` va al final y con frontera de palabra: es subcadena de
        // los dos anteriores, y sin `\b` se contaría tres veces cada aparición.
        'Jurisdiccion',
      ];
      const revived: string[] = [];
      for (const name of OLD_NAMES) {
        const hits = dondeAparece(new RegExp(`\\b${name}\\b`), ['src'], true);
        if (hits.length) revived.push(`${name} (${hits.length} archivo(s): ${hits[0]})`);
      }

      // 2 · NI EL DIRECTORIO. El renombrado de la carpeta es la mitad que un
      // codemod de identificadores no hace, y la que rompe diez imports.
      const oldFolder = spanishJurisdictionPaths(RAIZ);

      // 3 · SIN ENTRADA EN UN CARRIL EXIGIDO.
      //
      // «Sin entrada» a secas sería falso y pondría el criterio rojo por algo
      // que el epic bendice: el módulo SÍ tiene 176 líneas de comentario en
      // español, y ese carril está declarado `informational` —los comentarios
      // no se tocan hasta I20—. Lo que I5 promete es que no pese donde se
      // EXIGE: identificadores, nombres de archivo, anclas del plan.
      //
      // Qué carril es informativo no se escribe aquí: se lee de donde se
      // declara, para que añadir o quitar uno no deje este criterio mintiendo.
      const informationalLanes = new Set<string>();
      for (const file of ['scripts/language/lanes/docs.ts', 'scripts/language/lanes/code.ts', 'scripts/language/lanes/plan.ts']) {
        if (!existe(file)) continue;
        const text = crudoDe(file);
        for (const m of text.matchAll(/informational:\s*true/g)) {
          const before = text.slice(0, m.index ?? 0);
          const id = [...before.matchAll(/\bid:\s*'([^']+)'/g)].pop();
          if (id) informationalLanes.add(id[1]);
        }
      }
      if (informationalLanes.size === 0) {
        return noEvaluable(
          'ningún carril se declara `informational`: sin esa distinción este criterio exigiría ' +
            'cero comentarios españoles en la jurisdicción, que es I20 y no I5'
        );
      }

      const rel = 'docs/language-baseline.json';
      if (!existe(rel)) return noEvaluable(`no existe ${rel}: el metro de I2 todavía no está en este árbol`);
      let baseline: { perFile?: Record<string, Record<string, number>> };
      try {
        baseline = JSON.parse(crudoDe(rel)) as typeof baseline;
      } catch {
        return falla(`${rel} no es JSON válido`);
      }
      // EXIGIR EL DESGLOSE ANTES DE AFIRMAR NADA SOBRE ÉL. Sin esto, una línea
      // base sin `perFile` —o con el desglose vacío— hacía que la tercera
      // afirmación pasara MIDIENDO CERO ARCHIVOS y el criterio cantara
      // victoria. Es «el cero que parece una victoria» que el propio metro
      // tiene escrito en scripts/language/lanes/plan.ts, y lo encontré
      // atacando este criterio con el desglose vaciado a mano.
      const breakdown = baseline.perFile ?? {};
      if (Object.keys(breakdown).length < 5) {
        return noEvaluable(
          `${rel} trae ${Object.keys(breakdown).length} carril(es) con breakdown por archivo: ` +
            'sin él la tercera afirmación pasaría sin mirar un solo archivo'
        );
      }
      const weighs: string[] = [];
      for (const [lane, perFile] of Object.entries(breakdown)) {
        if (informationalLanes.has(lane)) continue;
        for (const [file, n] of Object.entries(perFile)) {
          // LAS DOS GRAFÍAS. `jurisdicci?on` casa «jurisdiccion» y NO casa
          // «jurisdiction»: le falta la `t`. Lo cazó el arnés de mutación en
          // la primera corrida —el mutante que mete el módulo en un carril
          // exigido sobrevivía— y es el error exacto que este criterio existe
          // para impedir: vigilar sólo el nombre viejo y quedarse ciego ante
          // el nuevo, que es el que hoy puede coger deuda.
          if (/(^|\/)jurisdic(?:c?ion|tion)(\/|$|\.)/i.test(file) && n > 0) {
            weighs.push(`${lane} · ${file} = ${n}`);
          }
        }
      }

      const problems: string[] = [];
      if (revived.length) {
        problems.push(
          `${revived.length} nombre(s) español(es) de vuelta en src/: ${revived.slice(0, 3).join(', ')}`
        );
      }
      if (oldFolder.length) {
        problems.push(`la carpeta \`jurisdiccion\` reapareció en ${oldFolder.length} ruta(s) de src/`);
      }
      if (weighs.length) {
        problems.push(
          `el módulo pesa en ${weighs.length} carril(es) EXIGIDO(s) (${weighs.slice(0, 2).join(' · ')}): ` +
            'dejó de entrar sin deuda, y renombrarlo ya no es gratis'
        );
      }
      if (problems.length) return falla(problems.join(' · '));

      return ok(
        `los ${OLD_NAMES.length} nombres viejos y la carpeta siguen en cero, y el módulo no pesa en ` +
          `ninguno de los carriles exigidos (${informationalLanes.size} informativo(s) exento(s) por contrato)`
      );
    },
    mutantes: [
      {
        archivo: 'src/services/jurisdiction/jurisdiction.ts',
        de: 'export function keepsMexicanBooks(',
        a: 'export function esContabilidadMexicana(',
        porque:
          'el revert del renombrado: vuelve el nombre que la issue nombra, y con él los otros seis por el mismo camino',
      },
      {
        archivo: 'docs/language-baseline.json',
        de: '"src/ai/agent-events.ts": 4',
        a: '"src/services/jurisdiction/jurisdiction.ts": 4',
        porque:
          'el módulo entra a la línea base de un carril EXIGIDO: sigue en inglés y ya no es gratis renombrarlo',
      },
    ],
  },
  {
    paquete: 'E1.1',
    id: 'entity-creation-seeds-accounting',
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
    id: 'iva-accounts-seeded-mexican-entities',
    enunciado:
      'Las cuatro cuentas de IVA se siembran en toda entidad MEXICANA, también sobre catálogo importado',
    mutantes: [
      {
        archivo: 'src/services/xml-ingestion/account-roles-seed.ts',
        de: "code: '1135', name: 'IVA Pendiente de Acreditar'",
        a: "code: '1136', name: 'IVA Pendiente de Acreditar'",
        porque:
          'el IVA de una factura PPD se queda sin cuenta donde esperar al pago; el mutante ' +
          'renumera en vez de borrar porque borrar el renglón entero también movería otras ' +
          'anclas, y un espejo debe fallar por la razón que dice',
      },
    ],
    evaluar: async () => {
      // El enunciado decía «siempre» y se volvió falso el día que la siembra
      // empezó a ramificar por país: una entidad estadounidense ya no recibe
      // cuentas de IVA, y debe ser así. Pero el criterio no se relaja, se
      // AFINA — lo que protegía sigue protegido y ahora además se comprueba
      // que la ramificación no se lleve por delante el caso mexicano, que es
      // el 100% de los clientes de este producto.
      const s = codigoDe('src/services/xml-ingestion/account-roles-seed.ts');
      const faltan = ['1130', '1135', '2120', '2125'].filter(
        (c) => !new RegExp(`code:\\s*'${c}'`).test(s)
      );
      if (faltan.length > 0) {
        return falla(
          `no se siembran: ${faltan.join(', ')} — una entidad onboardeada revienta con MISSING_ROLE_ACCOUNT`
        );
      }
      // Y que sigan llegando a una entidad mexicana pese al filtro por país.
      // Sin esto, marcar los cuatro códigos como fiscales-mexicanos-y-fuera
      // dejaría el criterio en verde con las cuentas fuera del catálogo.
      const { cuentasRequeridasPara } = await import(
        '../../services/xml-ingestion/account-roles-seed.js'
      );
      const mexicanas = new Set(cuentasRequeridasPara(true).map((a) => a.code));
      const perdidas = ['1130', '1135', '2120', '2125'].filter((c) => !mexicanas.has(c));
      return perdidas.length === 0
        ? ok('1130, 1135, 2120 y 2125 declaradas y entregadas a toda entidad mexicana')
        : falla(
            `${perdidas.join(', ')} están declaradas pero el filtro por país no se las entrega ` +
              'a una entidad mexicana: el IVA dejaría de acreditarse'
          );
    },
  },

  {
    paquete: 'E1.1',
    id: 'account-code-single-name',
    enunciado: 'Un código de cuenta significa UNA cuenta en todas las semillas',
    mutantes: [
      {
        archivo: 'src/services/payroll/common/payroll-account-mapping-seed.ts',
        de: "code: '6110', name: 'Sueldos y Salarios'",
        a: "code: '5200', name: 'Sueldos y Salarios'",
        porque:
          'devolver la nómina al código de las devoluciones sobre compras es EL fallo que ' +
          'este criterio vino a impedir: el sueldo bruto cargado a un contra-costo acreedor',
      },
      {
        archivo: 'src/services/accounting/chart-seed.ts',
        de: "code: '6110', name: 'Sueldos y Salarios'",
        a: "code: '6110', name: 'Nomina'",
        porque:
          'la colisión tiene dos lados y el criterio debe morder por los dos: renombrar la ' +
          'cuenta del catálogo base sin tocar las otras semillas es la mitad que un espejo ' +
          'de un solo sentido bendeciría',
      },
    ],
    evaluar: () => {
      // EL FALLO QUE ESTE CRITERIO PERSIGUE. Cuatro semillas escriben en el
      // catálogo de la MISMA entidad —el catálogo base, los roles del CFDI, el
      // mapeo de nómina y el sembrador de `npm run seed`— y las tres que
      // corren después se guardan de pisar a la anterior COMPARANDO CÓDIGOS:
      // `if (byCode.has(spec.code)) continue`. La guarda funciona; lo que no
      // vigila nadie es que dos semillas llamen cosas distintas al mismo
      // número. Cuando pasa, la segunda no crea su cuenta, hereda la ajena, y
      // el error es de SIGNIFICADO: no hay excepción, no hay fila de más, y
      // UNIQUE(code, entity_id) tampoco puede acusarlo porque desde la base
      // sólo hay una cuenta con ese código, que es justo lo que exige.
      //
      // Ocurrió con seis códigos a la vez: 5200 mandaba el sueldo bruto a
      // «Devoluciones y Descuentos sobre Compras», y 2150/2160/2170/2180
      // repartían los pasivos de nómina entre anticipos de clientes, sueldos
      // por pagar e IEPS.
      //
      // El criterio DESCUBRE los catálogos en vez de enumerarlos: la lección
      // que este archivo ya pagó una vez es que un detector de clases
      // enumeradas sólo ve las clases que enumeró, y una quinta semilla
      // añadida mañana tiene que quedar vigilada sin tocar esto.
      const decl = /code:\s*'([^']+)'\s*,\s*name:\s*'([^']*)'/g;
      const porCodigo = new Map<string, Map<string, string[]>>();
      for (const f of fuentes('src')) {
        // Por el seam (crudoDe) y no por fs directo: una lectura que lo rodea
        // deja el criterio fuera del arnés de mutación, y un criterio que
        // ningún mutante puede matar es prosa con forma de compuerta.
        const rel = path.relative(RAIZ, f);
        const texto = sinComentarios(crudoDe(rel));
        decl.lastIndex = 0;
        for (const m of texto.matchAll(decl)) {
          const [, codigo, nombre] = m;
          const nombres = porCodigo.get(codigo) ?? new Map<string, string[]>();
          nombres.set(nombre, [...(nombres.get(nombre) ?? []), rel]);
          porCodigo.set(codigo, nombres);
        }
      }
      if (porCodigo.size === 0) {
        return noEvaluable('ninguna fuente declara pares código/nombre de cuenta');
      }

      // La comparación es TOTAL, también entre el catálogo mexicano y el
      // estadounidense, que hoy no coexisten en una misma entidad. Es a
      // propósito y tiene precio: obliga a que MX y EE. UU. no compartan
      // número aunque podrían. A cambio, el criterio no necesita un modelo de
      // qué semillas son mutuamente excluyentes —el modelo que estaba mal era
      // justamente ése: `ensureEntityAccounting` siembra el catálogo base
      // mexicano en TODA entidad, país incluido o no— y la regla que enuncia
      // se puede leer sin saberse el pipeline: un número, un nombre.
      const choques = [...porCodigo.entries()]
        .filter(([, nombres]) => nombres.size > 1)
        .map(([codigo, nombres]) => {
          const partes = [...nombres.entries()].map(
            ([nombre, archivos]) => `«${nombre}» (${[...new Set(archivos)].join(', ')})`
          );
          return `${codigo}: ${partes.join(' vs ')}`;
        });

      return choques.length === 0
        ? ok(`${porCodigo.size} códigos de cuenta declarados, cada uno con un solo nombre`)
        : falla(
            `${choques.length} código(s) con dos significados — la semilla que corre después ` +
              `no crea su cuenta y hereda la ajena, sin error: ${choques.join(' · ')}`
          );
    },
  },
];
