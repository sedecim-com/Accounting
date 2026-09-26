import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
  codigoDe,
  type Criterio,
  crudoDe,
  dondeAparece,
  existe,
  falla,
  forEachGatewayNode,
  fuentes,
  GATEWAY_APP_CLOSURE,
  GATEWAY_CODE_PRINTER,
  GATEWAY_SERVER_CLOSURE,
  gatewayFiles,
  gatewayNodes,
  gatewaySyntaxOf,
  handlersTableEntry,
  importClosure,
  importClosureViolations,
  isIdentifierReference,
  isLiteralArgument,
  joinedPolicy,
  leer,
  literalText,
  localDeclarationsOf,
  noEvaluable,
  ok,
  plainImportsFrom,
  RAIZ,
  rutaDe,
  sameStatements,
  scanWriteRoutes,
  seamSource,
  sinComentarios,
  soleFunction,
  stringElements,
  topLevelInitializer,
} from './shared.js';

// ============================================================
// THE E2.1 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E2_1: Criterio[] = [

  // ---- E2.1 · Perímetro ----
  {
    paquete: 'E2.1',
    id: 'permission-gate-has-behavioural-proof',
    enunciado: 'La puerta de permisos y la frontera por id se prueban ejerciéndolas, no sólo declarándolas',
    evaluar: () => {
      // T14b·remate. La amputación de GraphQL (#101) se llevó por delante algo
      // que su PR afirmó que no se llevaba: las ÚNICAS pruebas de conducta de
      // `assertPermissions`. Medido después de fusionarla, sobre `main`:
      // convertida en un no-op que no compara nada, la suite unitaria entera
      // pasaba —253 archivos, 5 457 pruebas—. La puerta de permisos de todo el
      // producto podía dejar de preguntar sin que nada chistara.
      //
      // Lo mismo con la frontera POR ID: vaciando `assertEntryAccess`, postear
      // o anular el asiento de la sociedad hermana conociendo su UUID no lo
      // acusaba ninguna prueba. Y quitando `requirePermission('periods:close')`
      // de la ruta de CIERRE DURO —irreversible— tampoco.
      //
      // La red que sí existía era ESTRUCTURAL: `roles.spec.ts` comprueba que el
      // catálogo no conceda el permiso, y `openapi-contrato.spec.ts` que toda
      // ruta declare el suyo. Ninguna de las dos ejerce la NEGATIVA, y ésa es
      // la diferencia que este criterio existe para no volver a perder.
      if (!existe('tests/integration/permiso-y-frontera-por-rest.int.spec.ts')) {
        return falla(
          'desapareció la prueba de conducta de la puerta de permisos: con ella fuera, `assertPermissions` puede dejar de comparar y la suite entera sigue verde — medido'
        );
      }
      const spec = crudoDe('tests/integration/permiso-y-frontera-por-rest.int.spec.ts');
      // Los dos ejes, cada uno con su marca: el 403 del permiso y el 404 de la
      // frontera. Y el 404 NO puede ser 403: distinguirlos delataría que el
      // recurso ajeno existe.
      if (!/403/.test(spec) || !/404/.test(spec)) {
        return falla('la prueba dejó de ejercer alguno de los dos ejes: el 403 del permiso o el 404 de la frontera por id');
      }
      // Y RELEE LA FILA. Un 403 concedido después de escribir no es un 403.
      if (!/const estadoDe = async/.test(spec)) {
        return falla('la prueba dejó de releer el asiento tras el rechazo: un 403 que ya posteó no es un 403');
      }
      // La puerta sigue siendo UNA. Si `requirePermission` dejara de delegar,
      // la prueba de arriba seguiría verde vigilando código muerto.
      const auth = codigoDe('src/api/rest/middleware/auth.ts');
      if (!/assertPermissions\(req\.user, permissions\)/.test(auth)) {
        return falla('`requirePermission` dejó de pasar por `assertPermissions`: la prueba vigilaría una puerta que ya no se usa');
      }
      return ok('el permiso y la frontera por id se ejercen contra Postgres, releyendo la fila, y la puerta sigue siendo una');
    },
    mutantes: [
      {
        archivo: 'tests/integration/permiso-y-frontera-por-rest.int.spec.ts',
        de: 'el eje del PERMISO',
        a: null,
        porque: 'la prueba de conducta desaparece — que es exactamente lo que pasó al retirar GraphQL, y lo que nadie acusó',
      },
      {
        archivo: 'tests/integration/permiso-y-frontera-por-rest.int.spec.ts',
        de: 'const estadoDe = async',
        a: 'const noRelee = async',
        porque: 'la prueba deja de releer la fila tras el rechazo: bendeciría un 403 concedido después de haber escrito',
      },
      {
        archivo: 'src/api/rest/middleware/auth.ts',
        de: 'assertPermissions(req.user, permissions)',
        a: 'assertPermissions(req.user, [])',
        porque: '`requirePermission` deja de exigir lo que declara: la puerta sigue ahí y ya no pregunta nada',
      },
    ],
  },

  {
    paquete: 'E2.1',
    id: 'graphql-surface-withdrawn',
    enunciado: 'La segunda puerta al mayor está retirada, y no puede volver en silencio',
    evaluar: () => {
      // T14b (#101). Aquí vivían DOS criterios sobre una superficie GraphQL
      // apagada tras `GRAPHQL_ENABLED`. Se retiró entera —1 862 líneas y cero
      // consumidores: ningún cliente en el árbol, ningún .graphql, y
      // `npm run graphql:codegen` sin siquiera binario— y con ella se fue el
      // argumento escrito para conservarla, que decía «this repository has no
      // version control, and 891 lines are not recoverable once removed». Hay
      // git, y las líneas eran el doble de las que ese comentario contaba.
      //
      // POR QUÉ ESTE CRITERIO MIDE HECHOS POSITIVOS. El que sustituye empezaba
      // así:
      //     if (!/graphql/i.test(idx)) return ok('GraphQL no está montado');
      // Verde por AUSENCIA DE UNA PALABRA en un archivo. Reproducido: mudando
      // el montaje a otro fichero la superficie seguía sirviendo —401 en
      // /graphql sin credencial, 200 con un JWT de owner— y el tablero no
      // cambiaba un carácter. Y con una asimetría que lo remata: quitar la
      // bandera EN SU SITIO lo ponía en ROJO, y mudar el montaje además de
      // quitarla lo ponía en VERDE, siendo la segunda estrictamente peor.
      //
      // Y NO SE MIDE CON EL CENSO DE RUTAS, que era la reparación evidente:
      // `censarRutas` recorre `layer.route`, y un `app.use(ruta, manejador)` no
      // crea ninguna. Medido: 185 rutas censadas y ninguna era /graphql. El
      // repositorio ya lo tenía fijado por escrito en
      // tests/integration/g4a-ataque.int.spec.ts, «lo que el censo NO alcanza».
      // ── LO PRIMERO: CONTAR. UN CENSO VACÍO NO ABSUELVE ──────────────
      //
      // Es la mitad que le faltaba al criterio anterior y la razón de que se
      // pudiera cegar: «no encontré nada» y «no miré» daban el mismo verde. Si
      // los barridos vuelven vacíos o casi, esto es un instrumento roto, no una
      // puerta retirada, y se dice en rojo. Medido hoy: 369 fuentes, 67 claves
      // en package.json y 482 paquetes en el lock; los suelos van holgados para
      // no romperse con el crecimiento normal.
      const censoFuentes = fuentes('src').length;
      if (censoFuentes < 200) {
        return falla(
          `el barrido de fuentes sólo vio ${censoFuentes} archivos: el instrumento no miró, y no haber mirado no es haber retirado`
        );
      }
      const paquete = crudoDe('package.json');
      const censoClaves = [...paquete.matchAll(/^ {4}"[^"]+":\s*"/gm)].length;
      if (censoClaves < 30) {
        return falla(
          `package.json se leyó con ${censoClaves} claves: no se pudo censar lo que declara, así que no se puede afirmar que no declare Apollo`
        );
      }

      // ── EL CINTURÓN: EL ÁRBOL ───────────────────────────────────────
      //
      // Sin mordida por construcción, y se dice: el arnés de mutación puede
      // fingir que un archivo DESAPARECE, nunca que aparece. Esta rama no la
      // cubre ningún espejo, y por eso no es la carga del criterio.
      if (existe('src/api/graphql')) {
        return falla('src/api/graphql volvió al árbol: la segunda puerta al mayor está de vuelta');
      }

      // ── LA CARGA: LA DEPENDENCIA, EN LOS DOS SITIOS QUE INSTALAN ────
      //
      // El directorio se renombra; un servidor de Apollo no se monta sin su
      // paquete. Y se miran los DOS archivos: package.json es la intención y el
      // lock es lo que `npm ci` instala de verdad — quitarlo de uno y olvidar
      // el otro deja los paquetes entrando por la puerta de atrás.
      const vueltas: string[] = [];
      if (/"@apollo\/server"\s*:/.test(paquete)) vueltas.push('@apollo/server');
      if (/"@graphql-tools\/[^"]+"\s*:/.test(paquete)) vueltas.push('@graphql-tools/*');
      if (/"@as-integrations\/[^"]+"\s*:/.test(paquete)) vueltas.push('@as-integrations/*');
      if (/"graphql"\s*:/.test(paquete)) vueltas.push('graphql');
      if (vueltas.length > 0) {
        return falla(
          `${vueltas.join(', ')} volvió a package.json: sin paquete no hay puerta, así que esto es lo primero ` +
            'que aparece cuando alguien la remonta, se llame como se llame el directorio'
        );
      }
      // El lock se lee como el JSON que es, no por líneas: así el censo depende
      // de la CLAVE que lo estructura, y cegarlo —renombrar `packages`— deja el
      // conteo en cero y el criterio en rojo, que es lo que se quiere. Contarlo
      // con una expresión regular por línea no se podía cegar de una sola
      // pieza, y un censo que no se puede cegar tampoco se puede probar.
      let paquetesDelLock: string[];
      try {
        const lock = JSON.parse(crudoDe('package-lock.json')) as {
          packages?: Record<string, unknown>;
        };
        paquetesDelLock = Object.keys(lock.packages ?? {});
      } catch {
        return falla('package-lock.json no se pudo leer: sin él no se sabe qué instala `npm ci`, y eso no es un verde');
      }
      if (paquetesDelLock.length < 200) {
        return falla(
          `el lock se censó con ${paquetesDelLock.length} paquetes: sin censo no se puede afirmar que \`npm ci\` no instale Apollo`
        );
      }
      const enLock = paquetesDelLock.filter((k) =>
        /(^|\/)(@apollo\/|@graphql-tools\/|@as-integrations\/|graphql)($|\/)/.test(k)
      );
      if (enLock.length > 0) {
        return falla(
          `${enLock.length} paquete(s) de la puerta retirada siguen en package-lock.json (${enLock.slice(0, 3).join(', ')}): ` +
            '`npm ci` los instalaría aunque package.json ya no los declare'
        );
      }

      // ── Y QUE NINGÚN FUENTE LA IMPORTE ──────────────────────────────
      //
      // Sobre CÓDIGO y no comentarios: los que cuentan esta historia son
      // deliberados y se quedan. Tres cegueras conocidas, dichas en vez de
      // ocultadas — un especificador compuesto (`'@apollo' + '/server'`), un
      // import dentro de `src/plan` (que `fuentes()` excluye a propósito) y un
      // archivo .js (que `fuentes()` no recoge, y que sin `allowJs` tampoco
      // compila). Ninguna de las tres pasa el censo del lock de arriba, que es
      // por lo que la carga del criterio está ahí y no aquí.
      const importadores = dondeAparece(/@apollo\/|from 'graphql'|api\/graphql\//, ['src'], true);
      if (importadores.length > 0) {
        return falla(
          `${importadores.length} fuente(s) vuelven a importar la puerta retirada: ${importadores.slice(0, 4).join(', ')}`
        );
      }
      if (/['"]\/graphql['"]/.test(codigoDe('src/index.ts'))) {
        return falla('algo volvió a montarse en /graphql, la ruta que quedaba fuera del prefijo auditado');
      }
      return ok(
        `${censoFuentes} fuentes y ${paquetesDelLock.length} paquetes censados: la segunda puerta no está en el árbol, ni en package.json, ni en el lock, ni la importa nadie, ni hay nada montado en /graphql`
      );
    },
    mutantes: [
      {
        archivo: 'package.json',
        de: '"express":',
        a: '"@apollo/server": "^5.5.1",\n    "express":',
        porque: 'el paquete vuelve: es el ancla que no depende de dónde se ponga el montaje, y tiene que acusar sola',
      },
      {
        archivo: 'package-lock.json',
        de: '"packages": {',
        a: '"paquetes": {',
        porque: 'el censo del lock se queda a oscuras: sin contar antes de absolver, «no encontré Apollo» y «no miré» darían el mismo verde — que es exactamente cómo se cegaba el criterio anterior',
      },
      {
        archivo: 'src/index.ts',
        de: "import express from 'express';",
        a: "import express from 'express';\nimport { ApolloServer } from '@apollo/server';",
        porque: 'un fuente vuelve a importar la puerta retirada: el barrido tiene que verlo aunque el paquete no esté declarado',
      },
      {
        archivo: 'src/index.ts',
        de: 'app.use(helmet());',
        a: "app.use('/graphql', helmet());",
        porque: 'algo vuelve a montarse en /graphql — y el censo de rutas NO lo ve, que es exactamente lo que cegaba al criterio anterior',
      },
    ],
  },

  {
    paquete: 'E2.1',
    id: 'tenant-context-mounted-globally',
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
    id: 'route-entity-access-verified',
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
        const texto = sinComentarios(leer(f));
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
          // NO SE ADMITE UNA TERCERA FORMA, y lo escribo porque lo intenté.
          //
          // Acotar la consulta con `entityScope(req.tenantId!, req.entityId!)`
          // parece una guarda mejor —el filtro va dentro del SQL, sin ventana
          // entre comprobar y usar— y NO sustituye a ésta: `req.entityId` sale
          // de la cabecera `x-entity-id`, y quien comprueba que esa cabecera
          // esté concedida por el token es `requireEntityAccess`. Sin ella,
          // acotar por `req.entityId` acota por lo que el atacante escribió.
          //
          // Son las dos: la cabecera se valida contra el token, y la consulta
          // acota. Es lo que hace journal-entries.ts:160 y lo que T9 lleva a
          // nómina.
          if (!montada && !comprobadaDentro) {
            desprotegidas.push(`${path.basename(f)} ${m[1].toUpperCase()} ${m[2]}`);
          }
        }
      }

      // T2 · VACUIDAD, Y ES EL CASO QUE EL ISSUE NOMBRA. La guarda de arriba
      // mira los ARCHIVOS, y con 27 archivos vacíos `revisadas` sale 0 y esto
      // publicaba «0 rutas revisadas; todas montan la guarda». Es verdad y no
      // dice nada: el censo cuya cifra es la vara con la que T9 va a medir las
      // catorce rutas de nómina salía en verde sin haber mirado una sola ruta.
      // El modo de fallo real no es que borren src/api/rest/routes, es que el
      // patrón deje de casar —un `app.get(` en vez de `router.get(`, un cambio
      // de formateo— y entonces el criterio deja de ver el perímetro entero
      // mientras sigue diciendo que lo revisó.
      //
      // El suelo es un TRINQUETE, no un `> 0`: las rutas sólo crecen, y una
      // caída brusca es exactamente la señal de que el patrón se rompió. La
      // cifra es la MEDIDA de hoy y no una redonda: el primer intento puso 200
      // a ojo y el tablero lo desmintió en la primera corrida — 151.
      const ROUTES_CENSUSED_FLOOR = 151;
      if (revisadas < ROUTES_CENSUSED_FLOOR) {
        return falla(
          `el censo vio ${revisadas} rutas y la línea base son ${ROUTES_CENSUSED_FLOOR}: el patrón dejó ` +
            'de casar y este criterio estaba a punto de decir que el perímetro está limpio sin haberlo mirado'
        );
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
    id: 'payroll-run-scope-is-a-path-not-a-column',
    // POR QUÉ ESTE CRITERIO NO ES EL ANTERIOR OTRA VEZ.
    //
    // `route-entity-access-verified` pregunta si la ruta MONTA la guarda.
    // `POST /finiquito` la montaba desde D1a y aun así liquidaba a la
    // plantilla de la sociedad hermana: la guarda valida la entidad DECLARADA
    // en la cabecera, y acotar la consulta por ella es OTRA defensa. Hacen
    // falta las dos, y ésta vigila la segunda.
    //
    // Y vigila justo donde el ayudante genérico de la casa NO sirve.
    // `pay_runs`, `pay_periods` y `paychecks` no tienen `entity_id`: sólo
    // `tenant_id`. `columnaDeAlcance` deduce la columna del esquema, así que
    // `requireByIdInScope('pay_runs', <id ajeno>, entityScope(A))` DEVUELVE la
    // fila de la sociedad hermana — medido, no supuesto. Una reparación
    // escrita con él contesta 404 sobre otro inquilino y 200 sobre la sociedad
    // de al lado: cerrada en el diff, verde en CI, abierta en producción. Por
    // eso la frontera aquí es un CAMINO —corrida → periodo → calendario→
    // entidad— y por eso el camino tiene que seguir llegando a una columna de
    // entidad de verdad.
    enunciado:
      'Las escrituras de la corrida de nómina acotan por la entidad, que en esas tablas es un camino y no una columna',
    mutantes: [
      {
        archivo: 'src/services/payroll/common/paycheck-service.ts',
        de: 'FROM employees WHERE id = $1 AND tenant_id = $2 AND entity_id = $3',
        a: 'FROM employees WHERE id = $1 AND tenant_id = $2',
        porque:
          'TEN-12: el recibo vuelve a aceptar al empleado de la sociedad hermana en la corrida propia — su sueldo entra en la póliza de nómina de quien calcula y sus cuotas patronales salen del pasivo de la suya',
      },
      {
        archivo: 'src/services/payroll/common/paycheck-service.ts',
        de: '[run.pay_period_id, input.tenant_id]',
        a: '[(input as unknown as { pay_period_id: string }).pay_period_id, input.tenant_id]',
        porque:
          'TEN-12: el periodo vuelve a salir del cuerpo y no de la corrida — medido, el IMSS del mismo trabajador pasaba de 71.25 a 133.00 con un periodo de 28 días nombrado en la petición',
      },
      {
        archivo: 'src/services/payroll/common/paycheck-service.ts',
        de: '[input.employee_id, input.tenant_id, run.entity_id]',
        a: '[input.employee_id, input.tenant_id, input.tenant_id]',
        porque:
          'TEN-12: el empleado se acota contra un valor que no es la entidad de la corrida — la columna sigue escrita en el SQL, pero la llave que la alimenta ya no es la del camino',
      },
      {
        archivo: 'src/services/payroll/common/alcance-nomina.ts',
        de: 'JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id',
        a: 'LEFT JOIN pay_schedules ps ON TRUE',
        porque:
          'el camino deja de llegar al calendario de la entidad y el EXISTS se cumple para cualquier corrida del inquilino: aprobar, marcar pagada y leer la corrida de la sociedad hermana vuelven a contestar 200',
      },
      {
        archivo: 'src/services/payroll/common/pay-run-service.ts',
        de: 'WHERE id = $1 AND ${alcance.sql} FOR UPDATE',
        a: 'WHERE id = $1 FOR UPDATE',
        porque:
          'la aprobación vuelve a tomar la corrida por su id a secas: con ella se acumula el pasivo patronal ajeno y se habilita el posteo y el pago de una corrida que no es de quien la aprueba',
      },
      {
        archivo: 'src/services/payroll/common/pay-run-service.ts',
        de: "WHERE id = $1 AND ${alcance.sql} AND status = 'approved' RETURNING tenant_id",
        a: "WHERE id = $1 AND status = 'approved' RETURNING tenant_id",
        porque:
          '`status = paid` AFIRMA QUE EL DINERO SALIÓ, y vuelve a poder afirmarse sobre la corrida de cualquier entidad: la mentira queda escrita en la fila de otro despacho',
      },
      {
        archivo: 'src/services/payroll/common/pay-run-service.ts',
        de: "UPDATE pay_runs SET status = 'calculating' WHERE id = $1 AND ${alcance.sql}",
        a: "UPDATE pay_runs SET status = 'calculating' WHERE id = $1",
        porque:
          'recalcular vuelve a poder hacerse sobre la corrida de otra entidad, y no sólo la mira: medido, le dejó `total_gross` en 0.00 y `employee_count` en 0 — reescribe los libros de al lado',
      },
      {
        archivo: 'src/services/payroll/mx/cfdi-nomina-generator.ts',
        de: 'WHERE p.id = $1 AND p.tenant_id = $2 AND ${predicadoEntidad.sql}',
        a: 'WHERE p.id = $1',
        porque:
          'el CFDI de nómina vuelve a armarse desde cualquier recibo del sistema, con el RFC, la CURP y el NSS de su empleado dentro, y se manda a timbrar: un comprobante emitido no se deshace',
      },
      {
        archivo: 'src/services/payroll/mx/finiquito-calculator.ts',
        de: "WHERE id = $1 AND tenant_id = $2${porEntidad ? ' AND entity_id = $3' : ''}",
        a: 'WHERE id = $1 AND tenant_id = $2',
        porque:
          'el finiquito vuelve a leer al empleado por inquilino: con la guarda de entidad montada y todo, basta cambiar x-entity-id para liquidar a alguien de la sociedad hermana y ver su sueldo en la respuesta',
      },
    ],
    evaluar: () => {
      const camino = 'src/services/payroll/common/alcance-nomina.ts';
      const corridas = 'src/services/payroll/common/pay-run-service.ts';
      const finiquito = 'src/services/payroll/mx/finiquito-calculator.ts';
      const rutas = 'src/api/rest/routes/payroll.ts';
      const prueba = 'tests/integration/t9c-la-cadena-de-la-corrida.int.spec.ts';
      for (const f of [camino, corridas, finiquito, rutas]) {
        if (!existe(f)) return falla(`desapareció ${f}`);
      }

      // 1. CADA SALTO DEL CAMINO LLEVA SU LLAVE.
      //
      // La primera redacción comprobaba sólo el DESTINO —que el predicado
      // tocara `ps.entity_id`— y su propio mutante la sobrevivió: cambiar el
      // JOIN por `LEFT JOIN pay_schedules ps ON TRUE` deja la columna escrita
      // y el EXISTS cumpliéndose para cualquier calendario del inquilino. Un
      // camino sin llave no es un camino: es un EXISTS que siempre dice que
      // sí mientras parece que acota.
      //
      // Aquí se fija el TEXTO del predicado a propósito, y no es la falta que
      // `route-entity-access-verified` narra en su cuarta redacción. Aquella
      // leía las tripas de una guarda que cambió tres veces; esto son tres
      // fragmentos de SQL de tres líneas que NO tienen tripas: el texto es la
      // conducta entera. Si el camino se reescribe, esta lista se reescribe
      // con él — y quien lo haga tendrá que mirar cada salto, que es justo lo
      // que se quiere.
      const c = codigoDe(camino);
      const saltos: Array<[string, string[]]> = [
        [
          'corridaEnEntidad',
          ['pp.id = ${columnaId}', 'ps.id = pp.pay_schedule_id', 'ps.entity_id = $${indice}'],
        ],
        [
          'periodoEnEntidad',
          ['pp2.id = ${columnaId}', 'ps2.id = pp2.pay_schedule_id', 'ps2.entity_id = $${indice}'],
        ],
        ['reciboEnEntidad', ['e2.id = ${columnaId}', 'e2.entity_id = $${indice}']],
      ];
      for (const [nombre, llaves] of saltos) {
        const desde = c.indexOf(`export const ${nombre}`);
        if (desde < 0) return falla(`${camino} ya no exporta ${nombre}`);
        const cuerpo = c.slice(desde, desde + 400);
        for (const llave of llaves) {
          if (!cuerpo.includes(llave)) {
            return falla(
              `${nombre} perdió un salto del camino («${llave}»): el EXISTS se cumple para filas que no son de la entidad y la sociedad hermana vuelve a caer`
            );
          }
        }
      }
      // Y el predicado completo conserva LOS DOS EJES. Quitar `tenant_id` no
      // abre nada hoy —el camino ya acota—, pero deja la consulta apoyada en
      // un solo salto y sin el índice que ya usaba.
      const compuesto = c.slice(c.indexOf('export function alcanceDeCorrida'));
      if (!/tenant_id = \$\$\{indice\}/.test(compuesto) || !/corridaEnEntidad\(/.test(compuesto)) {
        return falla(
          'alcanceDeCorrida dejó de componer los dos ejes (inquilino y camino a la entidad): uno solo de los dos no es la frontera'
        );
      }

      // 2. LAS DOS ESCRITURAS DE ESTADO LO LLEVAN DENTRO DEL SQL.
      //
      // Dentro y no en una comprobación previa: la aprobación puede mirar y
      // escribir después porque el FOR UPDATE de su misma sentencia tiene la
      // fila tomada; `markPayRunPaid` no corre en transacción con bloqueo, y
      // ahí mirar primero deja la ventana entre las dos sentencias abierta.
      const r = codigoDe(corridas);
      if (!/WHERE id = \$1 AND \$\{alcance\.sql\} FOR UPDATE/.test(r)) {
        return falla(
          'approvePayRun volvió a tomar la corrida por su id sin alcance en la MISMA sentencia que la bloquea: se aprueba y se acumula el pasivo de la corrida ajena'
        );
      }
      if (!/UPDATE pay_runs SET status = 'paid'[\s\S]{0,200}\$\{alcance\.sql\}/.test(r)) {
        return falla(
          "markPayRunPaid volvió a escribir `status = 'paid'` sin acotar: afirma que el dinero salió sobre la corrida de cualquier entidad"
        );
      }

      // 2 bis. Y LAS DOS PUERTAS QUE NO CAMBIAN DE ESTADO PERO ESCRIBEN.
      //
      // `calculatePayRun` abre con la transición a `calculating`: esa es la
      // puerta, y sin cerradura el recálculo REESCRIBE los totales de la
      // corrida ajena (medido: 10.000,00 → 0,00). El timbrado no cambia
      // estado y es peor, porque sale del sistema: un CFDI emitido no se
      // deshace, se cancela ante el SAT.
      if (!/UPDATE pay_runs SET status = 'calculating' WHERE id = \$1 AND \$\{alcance\.sql\}/.test(r)) {
        return falla(
          'calculatePayRun volvió a abrir por `id` a secas: recalcular la corrida ajena no sólo la mira, le reescribe los totales a cero'
        );
      }
      const cfdi = 'src/services/payroll/mx/cfdi-nomina-generator.ts';
      if (!existe(cfdi)) return falla(`desapareció ${cfdi}`);
      if (!/WHERE p\.id = \$1 AND p\.tenant_id = \$2 AND \$\{predicadoEntidad\.sql\}/.test(codigoDe(cfdi))) {
        return falla(
          'el CFDI de nómina volvió a armarse con `WHERE p.id = $1`: cualquier recibo del sistema, con el RFC y el NSS de su empleado, se manda a timbrar — y timbrado no se deshace'
        );
      }

      // 3. Y EL FINIQUITO ACOTA POR LA COLUMNA, que ésa sí la tiene.
      const fq = codigoDe(finiquito);
      if (!/FROM employees\s+WHERE id = \$1 AND tenant_id = \$2\$\{porEntidad/.test(fq)) {
        return falla(
          'el finiquito volvió a leer al empleado sólo por inquilino: es la ruta que desmiente la regla fácil, porque monta requireEntityAccess y aun así liquidaba a la plantilla de al lado'
        );
      }

      // 4. LAS TRES CONSULTAS DE RUTA QUE ACOTAN POR EL CAMINO.
      const rt = codigoDe(rutas);
      const usos = (rt.match(/corridaEnEntidad\(|periodoEnEntidad\(|reciboEnEntidad\(/g) ?? []).length;
      if (usos < 3) {
        return falla(
          `las rutas de nómina sólo usan ${usos} de los 3 predicados de camino: leer la corrida, leer el recibo y crear sobre un periodo ajeno vuelven a no acotar por entidad`
        );
      }

      // 4 bis. EL SALTO QUE FALTABA: EL RECIBO (TEN-12).
      //
      // `calculatePaycheck` resolvía sus tres llaves —empleado, periodo y
      // corrida— por inquilino y nada más, y el periodo lo nombraba la entrada.
      // Medido contra Postgres: una sesión de la sociedad A escribía el recibo
      // de un empleado de la hermana en su propia corrida, y el mismo empleado
      // propio salía con otro IMSS según qué periodo mandara el cuerpo. La
      // corrida va PRIMERO porque es la única llave que la ruta ya acotó; el
      // empleado se ata a la entidad a la que la corrida llega por camino, y el
      // periodo es el de la corrida. Se mide POSICIÓN y LLAVE, no presencia: un
      // `entity_id = $3` alimentado con otra cosa, o una corrida resuelta
      // después del empleado, no son la frontera.
      const paycheckFile = 'src/services/payroll/common/paycheck-service.ts';
      if (!existe(paycheckFile)) return falla(`desapareció ${paycheckFile}`);
      const paycheckSrc = codigoDe(paycheckFile);
      const runLookupAt = paycheckSrc.search(/FROM pay_runs r\s+JOIN pay_periods pp ON pp\.id = r\.pay_period_id\s+JOIN pay_schedules ps ON ps\.id = pp\.pay_schedule_id/);
      const employeeLookupAt = paycheckSrc.indexOf('FROM employees WHERE id = $1 AND tenant_id = $2 AND entity_id = $3');
      if (runLookupAt < 0) {
        return falla('el recibo dejó de resolver la corrida con el camino hasta su entidad: sin él no hay entidad contra la que atar al empleado');
      }
      if (employeeLookupAt < 0 || !paycheckSrc.includes('[input.employee_id, input.tenant_id, run.entity_id]')) {
        return falla(
          'el recibo dejó de atar al empleado a la entidad DE LA CORRIDA: el empleado de la sociedad hermana vuelve a colgarse de la corrida propia, y su sueldo entra en la póliza ajena'
        );
      }
      if (runLookupAt > employeeLookupAt) {
        return falla('el recibo resuelve al empleado ANTES que la corrida: la entidad contra la que se le ata todavía no existe en ese punto');
      }
      if (!paycheckSrc.includes('[run.pay_period_id, input.tenant_id]') || /input\.pay_period_id/.test(paycheckSrc)) {
        return falla(
          'el periodo del recibo volvió a salir de la entrada y no de la corrida: con un periodo de 28 días en la petición, el IMSS de un mismo trabajador pasaba de 71.25 a 133.00'
        );
      }
      const paycheckSpec = 'tests/integration/ten12-sibling-employee-on-own-run.int.spec.ts';
      if (!existe(paycheckSpec)) {
        return falla('no hay reproducción del recibo del empleado ajeno: sin ella es una lectura del diff');
      }
      const paycheckSpecText = crudoDe(paycheckSpec);
      if (!/toBe\(404\)/.test(paycheckSpecText) || /toBe\(403\)/.test(paycheckSpecText) || !/imss_employee/.test(paycheckSpecText)) {
        return falla(
          'la reproducción del recibo dejó de exigir el 404 idéntico, o dejó de comparar la cuota IMSS que delata qué periodo decidió'
        );
      }

      // 5. Y HAY CONDUCTA QUE LO AFIRMA, EN 404 Y NO EN 403.
      //
      // 403 dice «existe y no es tuyo», y frente a un id ya conocido esa es
      // justo la pregunta del atacante. La serie TEN dice 404.
      if (!existe(prueba)) {
        return falla(
          'no hay reproducción de la cadena de la corrida: sin ella, el arreglo es una lectura del diff y no una medición'
        );
      }
      const t = crudoDe(prueba);
      if (/toBe\(403\)/.test(t) || !/toBe\(404\)/.test(t)) {
        return falla(
          'la reproducción dejó de exigir 404: un 403 confirma que la corrida de la otra entidad existe, que es lo único que el atacante no sabía'
        );
      }

      return ok(
        'el camino llega a la entidad; el cálculo, la aprobación, el pago, el timbrado y el finiquito lo llevan dentro del SQL; el recibo ata su empleado a la entidad de la corrida y toma el periodo de ella; las rutas lo usan y hay reproducción que exige 404'
      );
    },
  },
  {
    paquete: 'E2.1',
    id: 'write-route-hands-entity-to-its-resolver',
    // POR QUÉ ESTE CRITERIO NO ES `route-entity-access-verified` OTRA VEZ.
    //
    // Aquél pregunta: «una entidad que viene de la petición, ¿pasó por la
    // guarda?». Su disparador es que la ruta NOMBRE una entidad, y por
    // construcción no ve una ruta que no nombra ninguna — que es justo la que
    // no acota. `POST /v1/bills/:id/approve` no montaba la guarda, llamaba a
    // `approveBill(id, userId)` sin entidad, y quedó fuera de su vista. Medido
    // (TEN-11, #235): una sesión de la sociedad A aprobaba la factura de la
    // hermana y dejaba una póliza POSTEADA en su mayor, con su primer folio.
    // El censo encontró la misma forma en `/nacha` —que entregaba las cuentas
    // bancarias descifradas—, en las elecciones de beneficio y, latente
    // detrás de una avería, en la generación de periodos.
    //
    // Éste pregunta lo otro: «una ruta que ESCRIBE sobre un recurso que la
    // petición nombra por id, ¿le entrega la entidad validada a la llamada que
    // lo resuelve?». Y lo pregunta por llamada, no por manejador: una variable
    // ligada a `req.entityId` que nadie usa deja la llamada sin acotar.
    //
    // No invierte el criterio viejo, y a propósito: eso obligaría a eximir a
    // «las rutas que ya acotan la consulta», que es la exención que en T9a
    // abrió el hueco de la cabecera. Aquí la única exención es por TABLA DEL
    // INQUILINO, y el escáner comprueba contra las migraciones que la tabla
    // eximida de verdad no llega a una entidad.
    //
    // LO QUE NO VE, y queda escrito: una llave foránea escondida en un spread
    // del cuerpo con la guarda montada (la clase de TEN-12); el SQL crudo
    // escrito dentro de una ruta; y la CLI, el agente y los jobs.
    enunciado:
      'Toda ruta que escribe sobre un recurso que la petición nombra por id le entrega la entidad validada a la llamada que lo resuelve',
    mutantes: [
      {
        archivo: 'src/api/rest/routes/bills.ts',
        de: 'approveBill(req.params.id, req.user!.user_id, {\n    entityId: req.entityId!,\n  })',
        a: 'approveBill(req.params.id, req.user!.user_id, {} as never)',
        porque:
          'reabre #235 tal cual: la aprobación vuelve a tomar la factura por su id y postea en el mayor de la hermana. El criterio viejo sigue en verde ante esto, porque la ruta no nombra ninguna entidad',
      },
      {
        archivo: 'src/api/rest/routes/bills.ts',
        de: "IVA acreditable' }), requirePermission('bills:approve'), requireEntityAccess, asyncHandler(",
        a: "IVA acreditable requireEntityAccess' }), requirePermission('bills:approve'), asyncHandler(",
        porque:
          'la guarda desaparece de la cadena de middlewares y su NOMBRE queda escrito dentro de una cadena, en los primeros caracteres del bloque: el criterio viejo, que busca el nombre por texto, sobrevive a este mutante',
      },
      {
        archivo: 'src/api/rest/routes/payroll.ts',
        de: 'const result = await generateNachaFile(entityScope(req.tenantId!, req.entityId!), pay_run_id, company_info);',
        a: 'const alcance = entityScope(req.tenantId!, req.entityId!);\n  void alcance;\n  const result = await generateNachaFile(tenantScope(req.tenantId!), pay_run_id, company_info);',
        porque:
          'la entidad está ligada en el manejador y NO llega a la llamada: el archivo de dispersión vuelve a descifrar las cuentas de la hermana. Un criterio que mirara el manejador entero lo daría por bueno',
      },
      {
        archivo: 'src/services/payroll/usa/nacha-generator.ts',
        de: "corridaEnEntidad('pr.pay_period_id', 3)",
        a: "corridaEnEntidad('pp.id', 3)",
        porque:
          'el camino apunta a la columna equivocada: dentro del EXISTS el alias `pp` tapa al de fuera, la condición es cierta para toda fila y la corrida de la hermana vuelve a leerse — con `ps.entity_id` todavía escrito',
      },
      {
        archivo: 'src/services/payroll/usa/nacha-generator.ts',
        de: 'AND p.net_pay > 0 AND e.entity_id = $2',
        a: 'AND p.net_pay > 0',
        porque:
          'mientras `/calculate` pueda colgar un empleado ajeno de una corrida propia, el archivo propio vuelve a descifrar la cuenta de ese empleado',
      },
      {
        archivo: 'src/services/payroll/usa/benefits/benefits-service.ts',
        de: 'JOIN benefits_plans bp ON bp.id = $3 AND bp.entity_id = e.entity_id',
        a: 'JOIN benefits_plans bp ON bp.id = $3',
        porque:
          'la segunda llave vuelve a cruzar: el plan de la hermana se elige sobre un empleado propio',
      },
      {
        archivo: 'src/services/payroll/common/pay-period-service.ts',
        de: "'pay_schedules', payScheduleId, scope, {",
        a: "'pay_schedules', payScheduleId, tenantScope(scope.tenantId), {",
        porque:
          'el calendario se acota, pero por el eje equivocado: con el mismo inquilino, la hermana vuelve a caer',
      },
      {
        archivo: 'src/api/rest/routes/journal-entries.ts',
        de: "requireByIdInScope('journal_entries', entryId, entityScope(req.tenantId!, req.entityId!), {",
        a: "requireByIdInScope('journal_entries', entryId, tenantScope(req.tenantId!), {",
        porque:
          'la comprobación previa pierde la entidad y las tres rutas que postean, anulan y revierten pólizas la siguen «llamando»: su nombre no cambia, su llave sí',
      },
      {
        archivo: 'tests/integration/ten11-sibling-bill-approval.int.spec.ts',
        de: 'expect(r.status, JSON.stringify(r.body)).toBe(404);',
        a: 'expect(r.status, JSON.stringify(r.body)).toBe(403);',
        porque:
          'un 403 confirma que la factura existe y no es tuya, que es lo único que quien prueba ids no sabía',
      },
    ],
    evaluar: () => {
      const { reviewed, findings } = scanWriteRoutes();
      if (reviewed === 0) return noEvaluable('no hay rutas REST que revisar');
      if (findings.length > 0) {
        return falla(
          `${findings.length} ruta(s) escriben sobre un recurso por id sin entregar la entidad validada: ` +
            findings.slice(0, 5).map((a) => `${a.route} — ${a.issue}`).join(' · ') +
            (findings.length > 5 ? ` y ${findings.length - 5} más` : '') +
            '. RLS acota por inquilino; dentro de un despacho con dos sociedades, eso sólo lo defiende el SQL'
        );
      }

      // LOS SERVICIOS, POR SU TEXTO: son fragmentos de SQL de una línea, donde
      // el texto es la conducta entera.
      const pinned: Array<[string, string, string]> = [
        ['src/services/ap/bill-service.ts', 'WHERE id = $2 AND entity_id = $3 AND status IN', 'aprobar la factura dejó de acotar el UPDATE por entidad'],
        ['src/services/payroll/usa/nacha-generator.ts', "corridaEnEntidad('pr.pay_period_id', 3)", 'el archivo NACHA dejó de llegar a la entidad de la corrida por su llave'],
        ['src/services/payroll/usa/nacha-generator.ts', 'AND p.net_pay > 0 AND e.entity_id = $2', 'el archivo NACHA dejó de acotar los recibos por la entidad del empleado'],
        ['src/services/payroll/usa/benefits/benefits-service.ts', 'JOIN benefits_plans bp ON bp.id = $3 AND bp.entity_id = e.entity_id', 'la elección de beneficio dejó de atar el plan a la entidad del empleado'],
        ['src/services/payroll/usa/benefits/benefits-service.ts', 'WHERE e.id = $2 AND e.entity_id = $7', 'la elección de beneficio dejó de atar el empleado a la entidad de la sesión'],
        ['src/services/payroll/common/pay-period-service.ts', "'pay_schedules', payScheduleId, scope, {", 'generar periodos dejó de acotar el calendario por la entidad de la sesión'],
      ];
      for (const [file, fragment, reason] of pinned) {
        if (!existe(file)) return falla(`desapareció ${file}`);
        if (!codigoDe(file).includes(fragment)) return falla(reason);
      }

      // Y CONDUCTA QUE LO AFIRMA contra Postgres, en 404 y contra un fantasma.
      const specs = [
        'tests/integration/ten11-sibling-bill-approval.int.spec.ts',
        'tests/integration/ten11-sibling-nacha-file.int.spec.ts',
        'tests/integration/ten11-sibling-benefit-elections.int.spec.ts',
        'tests/integration/ten11-sibling-pay-periods.int.spec.ts',
      ];
      for (const spec of specs) {
        if (!existe(spec)) return falla(`no hay reproducción en ${spec}: sin ella esto es una lectura del diff`);
        const t = crudoDe(spec);
        if (/toBe\(403\)/.test(t)) {
          return falla(`${spec} exige un 403: confirma que el recurso existe y no es tuyo, que es lo que quien prueba ids no sabía`);
        }
        if (!/toBe\(404\)/.test(t) || !/randomUUID\(\)/.test(t)) {
          return falla(`${spec} dejó de exigir el 404 idéntico al de un id inexistente`);
        }
      }

      return ok(
        `${reviewed} rutas de escritura revisadas: toda la que nombra un recurso por id le entrega la entidad validada a la llamada que lo resuelve, y hay reproducción de las cuatro que no lo hacían`
      );
    },
  },
  {
    paquete: 'E2.1',
    id: 'startup-rejects-rls-bypass-role',
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
    id: 'counterparty-webhook-tenant-scope',
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
    id: 'outbound-webhook-delivery-hardening',
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
    id: 'public-verification-verifier-role',
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
      const politicas = crudoDe('src/database/rls-policies.sql');
      const n = (politicas.match(/CREATE POLICY verificacion_publica/g) ?? []).length;
      if (n < 5) {
        return falla(`las políticas del verificador no cubren las cinco tablas (hay ${n})`);
      }
      if (!/GRANT SELECT \(id, name, entity_type/.test(politicas)) {
        return falla('legal_entities perdió el GRANT de columnas enumeradas: un SELECT * nuevo expondría en vez de tronar');
      }
      return /mnemosine_verifier/.test(crudoDe('scripts/provision-roles.sql'))
        ? ok('rol verificador aprovisionado, políticas en el reconciliador y el router por SET LOCAL ROLE')
        : falla('provision-roles.sql no crea mnemosine_verifier: el camino existe sólo donde alguien lo creó a mano');
    },
  },

  // ---------------------------------------------------------------
  // S4 · MUTANTE 2/6 · EL PREDICADO DE LA POLÍTICA HIJA
  //
  // El issue lo enuncia así: «cambiar el predicado hijo a `USING (true OR …)`
  // deja hoy las pruebas verdes». Ya no: `rls-por-su-predicado.int.spec.ts`
  // recorre `pg_policy` y lo caza. Pero el TABLERO no podía hablar de este
  // archivo —cuatro criterios lo leen y ninguno mira este predicado—, así que
  // el arnés no tenía dónde declarar el espejo.
  //
  // EL ANCLA CIERRA EL PREDICADO POR LOS DOS LADOS: el paréntesis pegado al
  // EXISTS por la izquierda y el cierre por la derecha. Un `true OR ` sólo cabe
  // entre esos dos, y es ahí donde rompe. Es la lección de las anclas que no
  // acotan: un predicado abierto por un lado se deja ampliar sin que el
  // criterio se mueva.
  //
  // Lo que protege son las tablas hijas: el EXISTS es lo único que las ata a un
  // padre visible, y neutralizarlo las abre a todos los inquilinos.
  // ---------------------------------------------------------------
  {
    paquete: 'E2.1',
    id: 'child-policy-predicate-hangs-on-parent',
    enunciado:
      'La política de las tablas hijas cuelga EXACTAMENTE del padre visible, sin nada que la puentee',
    evaluar: () => {
      const pol = codigoDe('src/database/rls-policies.sql');
      const CHILD_PREDICATE =
        /USING '\s*\|\|\s*'\(EXISTS \(SELECT 1 FROM public\.%I p WHERE p\.id = %I\.%I\)\)'/;
      if (!CHILD_PREDICATE.test(pol)) {
        return falla(
          'el predicado de las hijas dejó de colgar EXACTAMENTE del padre: cualquier cosa entre el ' +
            'USING y el EXISTS —un `true OR`, un OR al final— abre las hijas a todos los inquilinos ' +
            'y RLS deja de ser la segunda cerradura que dice ser'
        );
      }
      return ok('el predicado de las hijas es el EXISTS del padre y nada más');
    },
    mutantes: [
      {
        archivo: 'src/database/rls-policies.sql',
        de: "      || '(EXISTS (SELECT 1 FROM public.%I p WHERE p.id = %I.%I))',",
        a: "      || '(true OR EXISTS (SELECT 1 FROM public.%I p WHERE p.id = %I.%I))',",
        porque:
          'el `USING (true OR …)` que el issue nombra: la política de las hijas admite cualquier ' +
          'fila y el EXISTS que las ata a un padre visible queda de adorno',
      },
    ],
  },

  // ---- F07b · El XML que se entrega a la autoridad ----

  {
    paquete: 'E2.1',
    id: 'anexo24-balance-scope-and-nature',
    enunciado: 'La contabilidad electrónica no cruza inquilinos, y el recálculo del SAT respeta la naturaleza de la cuenta',
    mutantes: [
      {
        // Gravedad 2 que el adversarial cazó: la balanza resolvía el
        // contribuyente con `WHERE id = $1` y nada más, mientras el catálogo
        // sí acotaba. Con la RLS inerte —que es como corre la suite, a
        // propósito— verificar la balanza de una entidad ajena publicaba su
        // plan de cuentas entero, y generar habría archivado un artefacto
        // FISCAL con el tenant_id del otro despacho.
        archivo: 'src/services/sat/anexo24/balanza-service.ts',
        de: '      WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,',
        a: '      WHERE id = $1`,',
        porque: 'la balanza del Anexo 24 vuelve a resolver el contribuyente sin acotar por inquilino: se publica el plan de cuentas de otro despacho y se archiva un artefacto fiscal con su tenant_id',
      },
      {
        // La trampa del tramo: el recálculo que la autoridad rehace NO es
        // simétrico. Una cuenta acreedora y una deudora con los mismos
        // cuatro números se declaran distinto, y tratarlas igual entrega un
        // archivo que cuadra en el sistema y no en el SAT.
        archivo: 'src/services/sat/anexo24/balanza-invariantes.ts',
        de: 'export function recalculoDelSat(i: ImportesDeclarados, natur: Natur): Decimal {',
        a: 'export function recalculoDelSat(i: ImportesDeclarados, _natur: Natur): Decimal {',
        porque: 'el recálculo deja de mirar la naturaleza de la cuenta: una acreedora se verifica con la aritmética de una deudora y el archivo entregado cuadra donde el SAT dirá que no cuadra',
      },
    ],
    evaluar: () => {
      const bal = codigoDe('src/services/sat/anexo24/balanza-service.ts');
      const inv = codigoDe('src/services/sat/anexo24/balanza-invariantes.ts');
      const art = codigoDe('src/services/sat/anexo24/artefactos.ts');

      // 1. LA FRONTERA, DENTRO DEL SQL. Séptima aparición de esta frontera en
      //    el proyecto, y la primera en un artefacto que se entrega a la
      //    autoridad: aquí el cruce no sólo filtra datos, los ARCHIVA a
      //    nombre de otro contribuyente.
      if (!/tenant_id = \$2::uuid/.test(bal)) {
        return falla('la balanza del Anexo 24 dejó de acotar por inquilino: publicaría el plan de cuentas de otro despacho y archivaría su artefacto fiscal con el tenant ajeno');
      }
      // 2. EL RECÁLCULO RESPETA LA NATURALEZA. SaldoIni + Debe − Haber =
      //    SaldoFin no se calcula igual en una cuenta deudora que en una
      //    acreedora, y ésa es la trampa que hace que un archivo cuadre aquí
      //    y no allá.
      if (!/export function recalculoDelSat\(i: ImportesDeclarados, natur: Natur\)/.test(inv)) {
        return falla('el recálculo del SAT dejó de mirar la naturaleza de la cuenta: el archivo cuadraría en el sistema y no en la autoridad');
      }
      // 3. Y EL ARCHIVO NO VA SELLADO SALVO QUE EL DESPACHO LO DIGA. La
      //    e.firma es el contribuyente firmando, no el software: construir el
      //    archivo y firmarlo son actos distintos y de manos distintas.
      // Se ancla el CAMPO, no el nombre de la política: `codigoDe` despoja los
      // comentarios, y el nombre de la política sólo aparecía en uno. Un
      // criterio que ancla prosa mide lo que el despojador acaba de borrar —
      // la lección del censo de confirmación, esta vez del otro lado.
      const sinSellar = /politicaSellado: string;/.test(art);
      return sinSellar
        ? ok('el Anexo 24 no cruza inquilinos, el recálculo respeta la naturaleza de cada cuenta, y el archivo sale sin sellar salvo que el panel diga lo contrario')
        : falla('el artefacto dejó de registrar el criterio de sellado: nadie podría saber si el archivo entregado llevaba la e.firma del contribuyente');
    },
  },

  // ---- G4b · El contrato que se pregunta, y la entrega que se reintenta ----

  {
    paquete: 'E2.1',
    id: 'openapi-census-and-delivery-retry',
    enunciado: 'El contrato de la API se deriva del censo de rutas, y la entrega saliente vencida se reintenta',
    mutantes: [
      {
        // Que el contrato deje de preguntarle a la app y pase a ser una lista.
        archivo: 'src/api/rest/openapi.ts',
        de: "import { censarRutas, VERBOS_QUE_MUTAN, alcanceDeIdempotencia, type RutaCensada } from './risk.js';",
        a: "import { VERBOS_QUE_MUTAN, alcanceDeIdempotencia, type RutaCensada } from './risk.js';\nconst censarRutas = (): RutaCensada[] => [];",
        porque: 'la especificación deja de derivar de la pila real y pasa a describir un vacío: publicaría lo que alguien recordó y no lo que la app sirve, que es el defecto que este proyecto lleva un mes cazando',
      },
      {
        archivo: 'src/services/webhooks/barrido-entregas.ts',
        de: '            AND d.next_retry_at <= NOW()',
        a: '            AND d.next_retry_at > NOW()',
        porque: 'el barrido reclama justo las entregas que NO toca reintentar todavía y deja las vencidas donde estaban: la cola vuelve a no vaciarse nunca y la caída de treinta segundos vuelve a perder el evento para siempre',
      },
    ],
    evaluar: () => {
      const oa = codigoDe('src/api/rest/openapi.ts');
      const barrido = codigoDe('src/services/webhooks/barrido-entregas.ts');

      // 1. EL CONTRATO SE PREGUNTA, NO SE ESCRIBE. `censarRutas` (G4a) ya
      //    recorre la pila real de Express; una especificación escrita al
      //    lado del código se desincroniza el primer martes, y un cliente
      //    generado de ella integra contra una API que no existe.
      // Se ancla la IMPORTACIÓN, no el nombre: `censarRutas` aparece tres
      // veces en el archivo, así que una sustitución local —un `const
      // censarRutas = () => []` encima— deja la cadena viva y el ancla
      // contenta mientras el contrato describe un vacío. Lo que importa no es
      // que la palabra esté: es que venga del censo de G4a.
      if (!/import \{[^}]*\bcensarRutas\b[^}]*\} from '\.\/risk\.js'/.test(oa)) {
        return falla('el contrato de la API dejó de derivar del censo: volvería a describir lo que alguien recordó en vez de lo que la app sirve');
      }
      // 2. Y DICE LA VERDAD QUE G4a ESTABLECIÓ: qué ruta es irreversible y
      //    cuál exige llave. Un contrato que no lo dice no sirve para
      //    integrar con cuidado — el integrador no sabe qué no puede repetir.
      if (!/alcanceDeIdempotencia/.test(oa)) {
        return falla('la especificación dejó de publicar qué rutas exigen Idempotency-Key: quien integre no sabrá cuáles no puede reintentar a ciegas');
      }
      // 3. LA ENTREGA VENCIDA SE RECLAMA. El esquema traía desde la 003
      //    `next_retry_at` y hasta su índice —un índice para una consulta que
      //    no existía— y nadie leía la columna: `markFailed` la escribía y el
      //    barrido no existía, así que una caída de treinta segundos del
      //    receptor perdía el evento para siempre y en silencio.
      // Las TRES apariciones, contadas: el reclamo, el conteo de pendientes y
      // el informe comparten el predicado, y un mutante que invierta una sola
      // deja las otras dos en pie con la presencia intacta.
      const vencidas = (barrido.match(/next_retry_at <= NOW\(\)/g) ?? []).length;
      const reclama = vencidas === 3;
      return reclama
        ? ok('el contrato deriva del censo y publica riesgo e idempotencia, y las entregas vencidas se reclaman en vez de quedarse')
        : falla('el barrido dejó de reclamar las entregas vencidas: la cola no se vacía y el evento se pierde sin que nadie se entere');
    },
  },

  // ---- G4a · Una sola superficie declarada ----

  {
    paquete: 'E2.1',
    id: 'mutating-route-risk-declaration',
    enunciado: 'La API declara el riesgo de cada ruta que muta, en el primer manejador, y el arranque muere si alguna no lo hace',
    mutantes: [
      {
        // Que el censo vuelva a aceptar una declaración que no llega a
        // correr. Es el diente exacto: la ruta pasa el censo, se cuenta como
        // cerrada, y no protege nada.
        archivo: 'src/api/rest/risk.ts',
        de: '  if (resumen.malColocadas.length > 0) {',
        a: '  if (false) {',
        porque: 'una declaración escrita DETRÁS del manejador vuelve a contar como declaración: el manejador ya respondió cuando al marcador le tocaría correr, así que la ruta se queda sin llave de idempotencia y sin el renglón de auditoría, y el censo la cuenta como cerrada — medido, el acto irreversible se ejecuta DOS veces con la misma llave',
      },
      {
        archivo: 'src/index.ts',
        de: '  const censo = auditarRiesgoDeRutas(app);',
        a: '  const censo = { total: 0, porRiesgo: {} } as ReturnType<typeof auditarRiesgoDeRutas>;',
        porque: 'el censo deja de correr al arrancar: la API vuelve a poder desplegar rutas que mutan sin declarar su clase, que es la definición del segundo motor con menos reglas',
      },
    ],
    evaluar: () => {
      const risk = codigoDe('src/api/rest/risk.ts');
      const index = codigoDe('src/index.ts');

      // 1. LA DECLARACIÓN EXISTE Y ES UN MANEJADOR. Commander tiene un objeto
      //    `Command` donde colgarla; Express no, así que la declaración viaja
      //    DENTRO de lo que Express registra y no puede desincronizarse de lo
      //    que la ruta hace.
      if (!/export function declararRiesgoRuta/.test(risk)) {
        return falla('la API se quedó sin registro de riesgo: vuelve a ser un motor con menos reglas que el CLI, que sí declara');
      }
      // 2. EL CENSO ES DERIVADO. Recorre la pila real de Express; una lista
      //    escrita al lado del código es el defecto que este proyecto lleva
      //    un mes cazando, y aquí sería el más caro de todos.
      if (!/_router|route\.stack/.test(risk)) {
        return falla('el censo dejó de recorrer la pila real de Express: si vuelve a ser una lista paralela, declarará lo que alguien recordó, no lo que la app sirve');
      }
      // 3. Y MUERE AL ARRANCAR, no en la petición. Un censo que sólo avisa es
      //    un censo que nadie mira: el binario del CLI no arranca con una
      //    declaración imposible, y la API tampoco debe.
      if (!/auditarRiesgoDeRutas\(app\)/.test(index)) {
        return falla('el censo salió del arranque: se podrían desplegar rutas que mutan sin declarar, y nadie se enteraría hasta la auditoría');
      }
      // 4. LA POSICIÓN SE EXIGE. Una declaración detrás del manejador
      //    certifica sin proteger, y el censo la contaba como cerrada.
      const posicion = /resumen\.malColocadas\.length > 0/.test(risk);
      return posicion
        ? ok('la API declara como el CLI, el censo deriva de la pila real, el arranque muere si falta una y la declaración tiene que poder correr')
        : falla('el censo volvió a aceptar declaraciones que no llegan a correr: certifican sin proteger, que es peor que no declarar');
    },
  },


  // ---- E1a · El predicado que se paga por fila ----

  {
    paquete: 'E2.1',
    id: 'tenant-predicate-inlinable-and-qualified',
    enunciado:
      'El predicado que cobra cada política se inserta en línea, y sigue cualificado sin la cláusula que lo impedía',
    mutantes: [
      {
        archivo: 'src/database/migrations/069_el_predicado_que_se_paga_por_fila.sql',
        de: 'LANGUAGE sql STABLE\nAS $fn$',
        a: 'LANGUAGE plpgsql STABLE\nAS $fn$',
        porque:
          'vuelve el marco de PL/pgSQL por fila. Ninguna prueba se pone roja —la respuesta es idéntica— y todo el sistema paga 6.1× en cada política',
      },
      {
        archivo: 'src/database/migrations/069_el_predicado_que_se_paga_por_fila.sql',
        de: 'LANGUAGE sql STABLE\nAS $fn$',
        a: 'LANGUAGE sql STABLE\nSET search_path = pg_catalog, public\nAS $fn$',
        porque:
          'el reflejo de endurecimiento que este criterio existe para frenar: la cláusula parece gratis, impide el inline y devuelve el coste entero sin cambiar una sola respuesta',
      },
      {
        archivo: 'src/database/migrations/069_el_predicado_que_se_paga_por_fila.sql',
        de: "pg_catalog.current_setting('app.current_tenant', true)",
        a: "current_setting('app.current_tenant', true)",
        porque:
          'la mitad peligrosa del cambio: sin la cláusula SET, un nombre sin cualificar SÍ es secuestrable por search_path',
      },
      {
        archivo: 'src/database/migrations/069_el_predicado_que_se_paga_por_fila.sql',
        de: 'CREATE OR REPLACE FUNCTION public.app_current_tenant() RETURNS uuid',
        a: null,
        porque:
          'si la migración desaparece, la última definición vuelve a ser la de la 014: el criterio debe dar ROJO, no reventar leyendo un archivo que ya no está',
      },
    ],
    evaluar: () => {
      // E1a. `app_current_tenant()` la evalúa CADA política de aislamiento, y
      // una política se evalúa UNA VEZ POR FILA: es la función más llamada del
      // esquema. La 014 la escribió en PL/pgSQL con `SET search_path`, y esa
      // cláusula IMPIDE el inline, así que cada fila pagaba un marco entero.
      // Medido sobre 800 000 filas: 1 447 ms → 237 ms (6.1×, docs/auditorias/E1a.md).
      //
      // Este criterio no vigila la 069 por su nombre: vigila QUIÉN DEFINE LA
      // FUNCIÓN AL FINAL. Una migración posterior que la «endurezca»
      // devolviéndole la cláusula no rompe ninguna prueba —la respuesta es la
      // misma— y sólo se nota en la factura. Es exactamente la regresión que
      // nadie encuentra leyendo un diff.
      const dir = 'src/database/migrations';
      const definen = fs
        .readdirSync(rutaDe(dir))
        .filter((f) => f.endsWith('.sql'))
        .sort()
        // El overlay gobierna la EXISTENCIA pero no `readdirSync`: sin este
        // filtro, el mutante que borra la 069 haría REVENTAR al criterio en vez
        // de ponerlo rojo, y «no pude mirar» no es «está mal».
        .filter((f) => existe(`${dir}/${f}`))
        .filter((f) => /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?app_current_tenant/i.test(crudoDe(dir, f)));

      const ultima = definen[definen.length - 1];
      if (!ultima) return falla('nadie define app_current_tenant: las políticas de aislamiento no tienen predicado');

      // Sólo el CUERPO. `crudoDe` no quita comentarios, y la cabecera de la 069
      // cita literalmente «LANGUAGE sql CON SET search_path» en su tabla de
      // mediciones: juzgar el archivo entero sería acusar a la prosa que
      // explica el cambio.
      const texto = crudoDe(dir, ultima);
      const i = texto.search(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?app_current_tenant/i);
      const j = texto.indexOf('$fn$;', i);
      const cuerpo = j > i ? texto.slice(i, j) : texto.slice(i);

      if (!/LANGUAGE\s+sql\b/i.test(cuerpo)) {
        return falla(`${ultima} devolvió app_current_tenant a un lenguaje procedural: deja de insertarse en línea y cada política vuelve a pagar un marco por fila`);
      }
      if (/SET\s+search_path/i.test(cuerpo)) {
        return falla(`${ultima} le devolvió SET search_path a app_current_tenant: la cláusula impide el inline y multiplica por seis el coste de TODA política de aislamiento`);
      }
      // Sin la cláusula, lo que se resuelve por nombre queda expuesto: la
      // función y el tipo del cast. `nullif` no cuenta —es gramática, no
      // función, y no se resuelve por nombre— y cualificarlo es un error de
      // sintaxis, no una protección.
      if (!/pg_catalog\.current_setting\(/.test(cuerpo) || !/::\s*pg_catalog\.uuid/.test(cuerpo)) {
        return falla(`${ultima} dejó sin cualificar la función o el tipo del cast: quitar SET search_path sin cualificar es abrir el secuestro que la cláusula cerraba`);
      }
      return ok(`el predicado de aislamiento se inserta en línea y va cualificado (${ultima})`);
    },
  },

  // ---- T3a · La frontera de inquilino ----

  {
    paquete: 'E2.1',
    id: 'requested-tenant-is-the-queried-tenant',
    enunciado: 'El inquilino que se pide es el inquilino que se consulta, y una hoja no puede deshacerlo',
    mutantes: [
      {
        archivo: 'src/ai/context.ts',
        de: '  const pedido = limpio(tenantFlag);',
        a: '  const pedido = limpio(tenantFlag) ?? limpio(process.env.MNEMOSINE_TENANT);',
        porque: 'EL DEFECTO DE #90: la ausencia de valor vuelve a ser una ORDEN de usar el entorno, así que cada hoja pisa con MNEMOSINE_TENANT el inquilino que la bandera acababa de fijar y la balanza del despacho A sale rotulada como la de B',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: '  return deLaHoja ?? deLaRaiz;',
        a: '  return deLaRaiz ?? deLaHoja;',
        porque: 'vuelven las DOS reglas de precedencia contrarias: el gancho rotula y comprueba con el valor de la raíz mientras la consulta corre con el de la hoja, y el aviso nombra un despacho distinto del que sale en las filas',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: '  if (deLaHoja && deLaRaiz && deLaHoja !== deLaRaiz) {',
        a: '  if (false) {',
        porque: 'dos órdenes contrarias del operador (--tenant X y -t Y) vuelven a resolverse por dentro y en silencio, en vez de decirse',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: '  if (inquilino.tenantId && !chatDbInitError && !SIN_COMPROBAR_INQUILINO.has(actionCommand.name())) {',
        a: "  if (inquilino.origen === 'bandera' && inquilino.tenantId && !chatDbInitError) {",
        porque: 'el escalón que el README y `mnemosine init` mandan usar —MNEMOSINE_TENANT— vuelve a quedar mudo: un .env que sobrevive a un re-seed devuelve el informe vacío con código 0',
      },
      {
        archivo: 'src/cli/init/s1-identity.ts',
        de: '    const fijado = currentTenant() ?? process.env.MNEMOSINE_TENANT ?? null;',
        a: '    const fijado = process.env.MNEMOSINE_TENANT || null;',
        porque: 'el asistente vuelve a listar las sociedades del inquilino del .env aunque se pidiera otro con --tenant, y la comprobación de RLS de init informa del inquilino equivocado',
      },
    ],
    evaluar: () => {
      // #90. La bandera se aceptaba y se ignoraba, y no por no llegar: LLEGABA,
      // el gancho la aplicaba, y la hoja la PISABA. `bootstrapTenant` era
      // `tenantFlag || process.env.MNEMOSINE_TENANT`, así que el `undefined` de
      // las 81 llamadas no significaba «no me han dicho nada» sino que era una
      // ORDEN de usar el entorno.
      //
      // Y había una segunda avería encajada: `--tenant` y `-t` no eran dos
      // grafías de una bandera. La raíz declara `-T` y se queda la forma LARGA
      // la teclee quien la teclee; la CORTA no la reconoce (la comparación
      // distingue mayúsculas) y viaja a la hoja. Por eso `-t` funcionaba
      // siempre y `--tenant` no funcionaba nunca.
      const ctx = codigoDe('src/ai/context.ts');
      const cli = codigoDe('src/cli/mnemosine.ts');

      // 1. LA AUSENCIA DEJA DE SER UNA ORDEN. Un valor explícito manda; no
      //    haberlo recibido re-entra lo que la raíz ya resolvió.
      // Se ancla en la línea EXACTA que decide, y no en la forma vieja del
      // defecto: escribirlo con `??` en vez de con `||` es el mismo defecto con
      // otra sintaxis, y un ancla que persiga `||` lo dejaría pasar. `pedido`
      // sale del ARGUMENTO y de nada más. (bootstrapTenant sí lee el entorno
      // más abajo, pero sólo para poder decir cuál está ignorando.)
      if (!/const pedido = limpio\(tenantFlag\);/.test(ctx)) {
        return falla('bootstrapTenant volvió a mezclar el entorno en lo que PIDE el llamador: cada hoja pisaría con MNEMOSINE_TENANT el inquilino que la bandera fijó, y la balanza del despacho A saldría rotulada como la de B (#90)');
      }
      if (!/export function bootstrapTenant/.test(ctx)) {
        return falla('bootstrapTenant desapareció: los 81 llamadores resolverían el inquilino cada uno por su cuenta');
      }

      // 2. UNA SOLA REGLA DE PRECEDENCIA. `optsWithGlobals` da globales sobre
      //    locales; `bootstrapTenant` hace mandar a la hoja. Fijadas las dos a
      //    la vez, el gancho rotula un inquilino y la consulta usa otro.
      if (!/return deLaHoja \?\? deLaRaiz;/.test(cli)) {
        return falla('el gancho volvió a resolver con globales-sobre-locales mientras bootstrapTenant hace mandar a la hoja: el aviso nombraría un despacho distinto del que sale en las filas');
      }
      // 3. Y UN DESACUERDO SE DICE, no se resuelve por dentro.
      if (!/deLaHoja && deLaRaiz && deLaHoja !== deLaRaiz/.test(cli)) {
        return falla('dos grafías con valores distintos vuelven a resolverse en silencio: elegir entre dos órdenes contrarias del operador sin decirlo es la misma clase de mentira que este tramo repara');
      }

      // 4. EL INQUILINO INEXISTENTE FALLA VENGA DE DONDE VENGA. Bajo RLS «no
      //    existe» y «vacío» son la misma cero-filas, y el caso realista no es
      //    la errata al teclear sino el .env que sobrevive a un re-seed.
      // El ancla va en la GUARDA, que es lo que el mutante toca: dejar en pie la
      // constante y estrechar el `if` a `origen === 'bandera'` volvería a dejar
      // mudo el escalón del .env con la declaración intacta.
      // La ventana es LA LÍNEA de la guarda de EXISTENCIA, identificada por lo
      // único que la distingue. Dos trampas se pagaron aquí: buscar por
      // longitud atrapaba el `const duro = inquilino.origen === 'bandera'` de
      // tres líneas más abajo —que es correcto—, y buscar
      // `if (inquilino.tenantId` agarraba OTRA guarda, la del validador de
      // uuid, que aparece antes en el archivo.
      const iGuarda = cli.indexOf('SIN_COMPROBAR_INQUILINO.has(');
      const inicio = iGuarda === -1 ? -1 : cli.lastIndexOf('\n', iGuarda) + 1;
      const guarda = inicio === -1 ? '' : cli.slice(inicio, cli.indexOf('\n', iGuarda));
      if (!/inquilino\.tenantId/.test(guarda) || /origen === 'bandera'/.test(guarda)) {
        return falla('la comprobación de existencia volvió a mirar sólo la bandera: el escalón que el README y `mnemosine init` mandan usar quedaría mudo, y un .env que sobrevive a un re-seed devolvería el informe vacío con código 0 (#90)');
      }
      // Con su exención declarada: los comandos que existen para ARREGLAR el
      // inquilino no pueden morir por él.
      const exencion = cli.slice(cli.indexOf('SIN_COMPROBAR_INQUILINO'), cli.indexOf('SIN_COMPROBAR_INQUILINO') + 400);
      if (!/'init'/.test(exencion) || !/'doctor'/.test(exencion)) {
        return falla('init o doctor dejaron de estar exentos de la comprobación: son los dos comandos a los que se acude cuando el .env apunta a un despacho que ya no está, y tumbarlos cierra el único camino de salida');
      }

      // 5. Y EL ASISTENTE NO SE SALTA LA PRECEDENCIA POR SU CUENTA.
      const ident = codigoDe('src/cli/init/s1-identity.ts');
      const infra = codigoDe('src/cli/init/s0-infra.ts');
      const leeEntornoASecas =
        /const fijado = process\.env\.MNEMOSINE_TENANT \|\| null/.test(ident) ||
        /tenantId: process\.env\.MNEMOSINE_TENANT \|\| undefined/.test(ident) ||
        /const tenant = process\.env\.MNEMOSINE_TENANT \?\?/.test(infra);
      return leeEntornoASecas
        ? falla('init volvió a leer MNEMOSINE_TENANT por su cuenta: lista y CREA sociedades bajo el inquilino del .env aunque se pidiera otro, y su comprobación de RLS informa del inquilino equivocado')
        : ok('la bandera manda sobre el entorno, una sola regla de precedencia gobierna el gancho y la hoja, el inquilino inexistente falla venga de donde venga, y el asistente usa el inquilino efectivo');
    },
  },

  // ---- W0 · The unauthenticated metrics surface ----
  {
    paquete: 'E2.1',
    id: 'metrics-route-label-bounded',
    // W0 (#117). `/metrics` is mounted before auth, and prom-client keeps
    // every label set it has seen for the life of the process. The route label
    // of a request no route matched was the literal `req.path`, so each random
    // path minted a permanent series: anyone could grow the scrape and the
    // heap one request at a time, without credentials. The first fix kept one
    // more channel open: `req.baseUrl` is the mount prefix as the client
    // spelled it, and Express matches mounts case-insensitively, so every case
    // variant of `/v1/ai/webhooks` (a route that answers its own 401) minted a
    // series too.
    //
    // What the criterion checks, on the middleware's syntax tree (a comment
    // that quotes a fallback moves nothing):
    //   · the bounded label is an exported const string literal;
    //   · an ALLOWLIST of reads: the request only as `.method`, `.route` and a
    //     lowercased `.baseUrl`, the response only as `.on` and `.statusCode`.
    //     Any other use of either (another member, a bracket, an alias, an
    //     argument to a helper, `res.req`) is a finding. A denylist of path
    //     names let `req.query`, `req.get('referer')` and a module-level helper
    //     handed `res` through;
    //   · the value that reaches prom-client is the one checked: `stop` and
    //     `httpRequestsTotal.inc` receive only the `labels` const, whose `route`
    //     is the `route` const bound to the bounded conditional, and that
    //     conditional's matched branch reads nothing but the request.
    // What it does not check: that the counters are not used from another
    // module (today nothing outside metrics.ts imports them), and that every
    // mount stays a literal with no parameter, which is what makes lowercasing
    // `baseUrl` exact. A mount with a parameter would put the client's value
    // back into the label; guarding the mount table from here would pin a
    // Spanish-named file and grow two plan lanes of
    // `scripts/language-status.ts`, so it waits for that file's rename. Behaviour is covered, over a real socket, by
    // tests/api/middleware/metrics-label.spec.ts.
    enunciado:
      'Ninguna petición acuña una serie nueva en el /metrics que se sirve sin credenciales: la etiqueta de ruta sale del código, no de lo que envía el cliente',
    mutantes: [
      {
        archivo: 'src/api/rest/middleware/metrics.ts',
        de: '      : UNMATCHED_ROUTE_LABEL;',
        a: '      : req.path;',
        porque:
          'every random unmatched path would create a permanent prom-client series, reachable without credentials',
      },
      {
        archivo: 'src/api/rest/middleware/metrics.ts',
        de: '      status: String(res.statusCode),\n    };',
        a: "      status: String(res.statusCode),\n      ...(res.statusCode === 404 ? { route: req['originalUrl'] } : {}),\n    };",
        porque:
          'the bounded fallback stays in place and the 404 label is overwritten after it, through bracket access: a check of the ternary alone stays green',
      },
      {
        archivo: 'src/api/rest/middleware/metrics.ts',
        de: '    const labels = {\n      method: req.method,\n      route,',
        a: '    const incoming = req;\n    const labels = {\n      method: req.method,\n      route: res.statusCode === 404 ? incoming.path : route,',
        porque:
          'an alias of the request hides the path read from a check that only looks for `req.`',
      },
      {
        archivo: 'src/api/rest/middleware/metrics.ts',
        de: "      ? `${(req.baseUrl || '').toLowerCase()}${req.route.path}`",
        a: "      ? `${req.baseUrl || ''}${req.route.path}`",
        porque:
          'Express matches a mount case-insensitively and baseUrl keeps the client spelling: each case variant of an unauthenticated mount mints its own series',
      },
      {
        archivo: 'src/api/rest/middleware/metrics.ts',
        de: 'export const metricsMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {\n  const stop = httpRequestDuration.startTimer();\n  res.on(\'finish\', () => {\n    const route = req.route?.path\n      ? `${(req.baseUrl || \'\').toLowerCase()}${req.route.path}`\n      : UNMATCHED_ROUTE_LABEL;\n    const labels = {\n      method: req.method,\n      route,',
        a: 'function unknownEndpoint(r: Response): string {\n  return r.req.path;\n}\n\nexport const metricsMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {\n  const stop = httpRequestDuration.startTimer();\n  res.on(\'finish\', () => {\n    const route = req.route?.path\n      ? `${(req.baseUrl || \'\').toLowerCase()}${req.route.path}`\n      : UNMATCHED_ROUTE_LABEL;\n    const labels = {\n      method: req.method,\n      route: route === UNMATCHED_ROUTE_LABEL && req.method !== \'GET\' ? unknownEndpoint(res) : route,',
        porque:
          'a helper declared outside the middleware reads the path through res.req, and only for non-GET requests: a check that follows `req` inside the body, and a spec that only sends GET, both stay green',
      },
      {
        archivo: 'src/api/rest/middleware/metrics.ts',
        de: '      route,\n      status: String(res.statusCode),',
        a: "      route: route === UNMATCHED_ROUTE_LABEL && typeof req.query.q === 'string' ? req.query.q : route,\n      status: String(res.statusCode),",
        porque:
          'the query string is as much client text as the path: a denylist of path, url and originalUrl lets it through',
      },
    ],
    evaluar: () => {
      const file = 'src/api/rest/middleware/metrics.ts';
      if (!existe(file)) {
        return falla(`desapareció ${file}: no queda nada que acote las etiquetas de /metrics`);
      }
      const sf = ts.createSourceFile(file, crudoDe(file), ts.ScriptTarget.Latest, true);

      // 1. The bounded label is a top-level exported const string literal:
      // nothing computed can hide behind the name.
      let labelValue: string | undefined;
      let middleware: ts.Expression | undefined;
      for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          if (d.name.text === 'UNMATCHED_ROUTE_LABEL' && exported && isConst && d.initializer && ts.isStringLiteral(d.initializer)) {
            labelValue = d.initializer.text;
          }
          if (d.name.text === 'metricsMiddleware') middleware = d.initializer;
        }
      }
      if (labelValue !== 'unmatched') {
        return falla(
          "metrics.ts ya no exporta `const UNMATCHED_ROUTE_LABEL = 'unmatched'` en su nivel superior: la etiqueta de una ruta sin coincidencia deja de ser un valor fijo"
        );
      }
      if (!middleware || !(ts.isArrowFunction(middleware) || ts.isFunctionExpression(middleware))) {
        return falla('no se encontró el inicializador de metricsMiddleware como función: el instrumento no puede mirar la etiqueta');
      }
      const [requestParam, responseParam] = middleware.parameters;
      if (!requestParam || !ts.isIdentifier(requestParam.name) || !responseParam || !ts.isIdentifier(responseParam.name)) {
        return falla(
          'metricsMiddleware no declara la petición y la respuesta como sus dos primeros parámetros con nombre: el instrumento no puede seguirlas'
        );
      }
      const requestName = requestParam.name.text;
      const responseName = responseParam.name.text;
      const body = middleware.body;

      function* walk(n: ts.Node): Generator<ts.Node> {
        yield n;
        for (const child of n.getChildren()) yield* walk(child);
      }
      const at = (n: ts.Node): string =>
        `:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText().slice(0, 60)}`;
      // An identifier that names a member (`x.req`, `{ route: … }`) or declares
      // a binding is not a read of a binding with that name.
      const isRead = (n: ts.Identifier): boolean => {
        const p = n.parent;
        if (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)) return p.name !== n;
        if (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p)) {
          return p.name !== n;
        }
        return true;
      };
      const readsIn = (n: ts.Node): ts.Identifier[] =>
        [...walk(n)].filter((x): x is ts.Identifier => ts.isIdentifier(x) && isRead(x));

      // 2. An allowlist of reads. Every label value must come from the code, so
      // the request is read only for its method (Node's parser admits a fixed
      // set), its matched route (registered by the code) and its mount prefix
      // lowercased; the response only to listen and for its status. Any other
      // use of either could launder client text into a label.
      const allowedMembers = new Map([
        [requestName, new Set(['method', 'route', 'baseUrl'])],
        [responseName, new Set(['on', 'statusCode'])],
      ]);
      // `(req.baseUrl || '').toLowerCase()` or `req.baseUrl.toLowerCase()`.
      const lowercased = (read: ts.Node): boolean => {
        let n = read;
        for (;;) {
          const p = n.parent;
          const defaulted =
            ts.isBinaryExpression(p) &&
            p.left === n &&
            (p.operatorToken.kind === ts.SyntaxKind.BarBarToken || p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
            ts.isStringLiteralLike(p.right);
          if (!ts.isParenthesizedExpression(p) && !defaulted) break;
          n = p;
        }
        const member = n.parent;
        return (
          ts.isPropertyAccessExpression(member) &&
          member.expression === n &&
          member.name.text === 'toLowerCase' &&
          ts.isCallExpression(member.parent) &&
          member.parent.expression === member
        );
      };
      const findings: string[] = [];
      for (const n of readsIn(body)) {
        const allowed = allowedMembers.get(n.text);
        if (!allowed) continue;
        const member = n.parent;
        if (!ts.isPropertyAccessExpression(member) || member.expression !== n || !allowed.has(member.name.text)) {
          findings.push(at(member));
        } else if (n.text === requestName && member.name.text === 'baseUrl' && !lowercased(member)) {
          findings.push(`${at(member)} sin pasar a minúsculas`);
        }
      }

      // 3. The value that reaches prom-client is the value checked. A check of
      // the conditional alone stays green when the label is overridden after it.
      const soleConstInBody = (name: string): ts.Expression | undefined => {
        const declared = [...walk(sf)].filter(
          (x) =>
            (ts.isVariableDeclaration(x) || ts.isParameter(x) || ts.isBindingElement(x) || ts.isFunctionDeclaration(x)) &&
            x.name !== undefined &&
            ts.isIdentifier(x.name) &&
            x.name.text === name
        );
        const [d] = declared;
        if (declared.length !== 1 || !ts.isVariableDeclaration(d)) return undefined;
        const isConst = ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0;
        const inBody = d.getStart() >= body.getStart() && d.getEnd() <= body.getEnd();
        return isConst && inBody ? d.initializer : undefined;
      };

      const routeInit = soleConstInBody('route');
      if (
        !routeInit ||
        !ts.isConditionalExpression(routeInit) ||
        !ts.isIdentifier(routeInit.whenFalse) ||
        routeInit.whenFalse.text !== 'UNMATCHED_ROUTE_LABEL' ||
        !/\.route\b/.test(routeInit.condition.getText())
      ) {
        findings.push(
          'la etiqueta ya no es un único `const route` del middleware que, sin ruta coincidente, cae en UNMATCHED_ROUTE_LABEL'
        );
      } else {
        for (const n of readsIn(routeInit.whenTrue)) {
          if (n.text !== requestName) findings.push(`${at(n.parent)} (la rama de la ruta coincidente lee ${n.text})`);
        }
      }

      const labelsInit = soleConstInBody('labels');
      if (!labelsInit || !ts.isObjectLiteralExpression(labelsInit)) {
        findings.push('las etiquetas ya no son un único `const labels = { … }` literal del middleware');
      } else {
        const values = new Map<string, ts.Expression>();
        let named = 0;
        for (const p of labelsInit.properties) {
          if (ts.isShorthandPropertyAssignment(p)) {
            named += 1;
            values.set(p.name.text, p.name);
          } else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
            named += 1;
            values.set(p.name.text, p.initializer);
          } else {
            findings.push(`${at(p)} (una etiqueta sin nombre fijo)`);
          }
        }
        const names = [...values.keys()].sort().join(', ');
        if (names !== 'method, route, status') {
          findings.push(`labels declara {${names}} en vez de exactamente {method, route, status}`);
        } else if (values.size !== named) {
          findings.push('labels repite una etiqueta: la última escritura gana y no es la que se comprobó');
        }
        const routeValue = values.get('route');
        if (!routeValue || !ts.isIdentifier(routeValue) || routeValue.text !== 'route') {
          findings.push(`${at(routeValue ?? labelsInit)} (la etiqueta route no es el const route acotado)`);
        }
        for (const key of ['method', 'status']) {
          const value = values.get(key);
          if (!value) continue;
          for (const n of readsIn(value)) {
            if (![requestName, responseName, 'String'].includes(n.text)) {
              findings.push(`${at(n.parent)} (la etiqueta ${key} lee ${n.text})`);
            }
          }
        }
      }

      // Only `labels` reaches the two metrics: `stop(labels)` from a timer
      // started with no labels, and `httpRequestsTotal.inc(labels)`. Any other
      // use of `labels`, `stop` or either metric in the file is a finding.
      const isCallWithLabels = (call: ts.Node, callee: ts.Node): boolean =>
        ts.isCallExpression(call) &&
        call.expression === callee &&
        call.arguments.length === 1 &&
        ts.isIdentifier(call.arguments[0]) &&
        call.arguments[0].text === 'labels';
      for (const n of readsIn(sf)) {
        const p = n.parent;
        let fine = true;
        if (n.text === 'labels') {
          fine =
            ts.isCallExpression(p) &&
            p.arguments.length === 1 &&
            ((ts.isIdentifier(p.expression) && p.expression.text === 'stop') ||
              (ts.isPropertyAccessExpression(p.expression) &&
                ts.isIdentifier(p.expression.expression) &&
                p.expression.expression.text === 'httpRequestsTotal' &&
                p.expression.name.text === 'inc'));
        } else if (n.text === 'stop') {
          fine = isCallWithLabels(p, n);
        } else if (n.text === 'httpRequestsTotal') {
          fine = ts.isPropertyAccessExpression(p) && p.name.text === 'inc' && isCallWithLabels(p.parent, p);
        } else if (n.text === 'httpRequestDuration') {
          fine =
            ts.isPropertyAccessExpression(p) &&
            p.name.text === 'startTimer' &&
            ts.isCallExpression(p.parent) &&
            p.parent.expression === p &&
            p.parent.arguments.length === 0;
        }
        if (!fine) findings.push(`${at(p)} (llega a prom-client algo que no es labels)`);
      }
      const stopInit = soleConstInBody('stop');
      if (!stopInit || !ts.isCallExpression(stopInit) || !/^httpRequestDuration\.startTimer$/.test(stopInit.expression.getText())) {
        findings.push('`stop` ya no es un único const del middleware iniciado con httpRequestDuration.startTimer()');
      }

      if (findings.length > 0) {
        return falla(
          `una etiqueta de /metrics puede tomar su valor de lo que envía el cliente (${findings.join(' · ')}): cada petición distinta acuñaría una serie permanente, sin credenciales`
        );
      }
      return ok(
        "metricsMiddleware etiqueta con el patrón de la ruta (montaje en minúsculas) o con 'unmatched', y de la petición sólo lee método y ruta: /metrics no crece con peticiones al azar"
      );
    },
  },

  // ---- W0 · The web gateway ----
  {
    paquete: 'E2.1',
    id: 'web-gateway-never-reaches-the-engine',
    // W0 (#117). The gateway runs as its own process so that a compromised
    // gateway holds browser sessions and not the engine. This criterion holds
    // that line in the source:
    //   · the server process's transitive import closure stays inside
    //     src/gateway (minus the browser program), four borrowed auth and
    //     trust-proxy modules, express, jose and a named list of Node builtins
    //     (no loader: node:module, vm and child_process stay out, except
    //     child_process in the token store);
    //   · the browser program's closure stays inside src/gateway/app and the
    //     two typed catalogs, with no package at all, and the program has at
    //     least seven modules (W1), so an emptied or moved app is not a clean
    //     closure;
    //   · what that closure binds from jose is the verification half only, and
    //     no file in it (borrowed modules included) names node:crypto's or
    //     WebCrypto's signers, a token-minting library or an engine credential,
    //     not even in a comment;
    //   · `process` is used only through a short list of members, and its
    //     environment is read in exactly one place, the default parameter of
    //     readGatewayConfig, whose alias is read only as env.<GATEWAY KEY>.
    // All of it is read on the syntax tree of every file the walk visited, so
    // process['env'], destructuring and an aliased require are not text the
    // criterion fails to see. The walk is importClosure above; the runtime
    // complement is tests/gateway/module-isolation.spec.ts, which loads the
    // server in a fresh process and lists what got required.
    enunciado:
      'El gateway web no alcanza el motor: su cierre de imports no toca base de datos, servicios ni configuración del motor, no firma tokens y sólo lee sus propias variables de entorno',
    mutantes: [
      {
        archivo: 'src/gateway/proxy.ts',
        de: "import type { SessionStore } from './session-store.js';",
        a: "import type { SessionStore } from './session-store.js';\nimport { query } from '../database/connection.js';",
        porque: 'the gateway would read Postgres directly: a third engine with no risk declaration and no audit',
      },
      {
        archivo: 'src/auth/oidc.ts',
        de: "import { createRemoteJWKSet, customFetch, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';",
        a: "import '../database/connection.js';\nimport { createRemoteJWKSet, customFetch, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';",
        porque: 'laundering through an allowed module: only a transitive walk catches it',
      },
      {
        archivo: 'src/gateway/server.ts',
        de: 'export function createGatewayApp(',
        a: "const engineModule = 'pg';\nvoid import(engineModule);\nexport function createGatewayApp(",
        porque: 'a computed dynamic import hides the specifier from any literal scan',
      },
      {
        archivo: 'src/gateway/logger.ts',
        de: 'export type LogField = string | number | boolean;',
        a: "const driver = require('pg') as unknown;\nexport type LogField = string | number | boolean;",
        porque: 'a require of an engine package is an import all the same',
      },
      {
        archivo: 'src/gateway/oidc-client.ts',
        de: "import { discover, isAsymmetric, verifyIdpToken } from '../auth/oidc.js';",
        a: "import { SignJWT } from 'jose';\nimport { discover, isAsymmetric, verifyIdpToken } from '../auth/oidc.js';",
        porque: 'the gateway would start minting tokens and become the authorization engine',
      },
      {
        archivo: 'src/gateway/config.ts',
        de: 'const publicOrigin = env.GATEWAY_PUBLIC_ORIGIN',
        a: 'const databaseUrl = env.DATABASE_URL;\n  const publicOrigin = env.GATEWAY_PUBLIC_ORIGIN',
        porque: 'the gateway process would start depending on the database credential',
      },
      {
        archivo: 'src/gateway/server.ts',
        de: '  const fetchImpl = deps.fetchImpl ?? fetch;',
        a: "  const fetchImpl = deps.fetchImpl ?? fetch;\n  const tenant = process.env['MNEMOSINE_TENANT'];",
        porque: 'a second read of the environment outside readGatewayConfig escapes both the key list and the env census',
      },
      {
        archivo: 'src/gateway/oidc-client.ts',
        de: "import { discover, isAsymmetric, verifyIdpToken } from '../auth/oidc.js';",
        a: "import { CompactSign } from 'jose';\nimport { discover, isAsymmetric, verifyIdpToken } from '../auth/oidc.js';",
        porque: 'jose signs under names other than SignJWT: a CompactSign mints a JWS just the same',
      },
      {
        archivo: 'src/auth/oidc.ts',
        de: "import { createRemoteJWKSet, customFetch, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';",
        a: "import { createRemoteJWKSet, customFetch, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';\nexport { SignJWT as TokenWriter } from 'jose';",
        porque: 'a signer re-exported under another name from a borrowed module reaches the gateway without its name',
      },
      {
        archivo: 'src/gateway/logger.ts',
        de: 'export type LogField = string | number | boolean;',
        a: "const load = require;\nexport const driver = (): unknown => load('pg');\nexport type LogField = string | number | boolean;",
        porque: 'an aliased require loads the engine driver with no require( in sight',
      },
      {
        archivo: 'src/gateway/logger.ts',
        de: 'export type LogField = string | number | boolean;',
        a: "import { createRequire } from 'node:module';\nexport const driver = (): unknown => createRequire(__filename)('pg');\nexport type LogField = string | number | boolean;",
        porque: 'createRequire is a loader that node:module hands out as an ordinary builtin',
      },
      {
        archivo: 'src/gateway/server.ts',
        de: '  const fetchImpl = deps.fetchImpl ?? fetch;',
        a: "  const fetchImpl = deps.fetchImpl ?? fetch;\n  const tenant = process['env']['MNEMOSINE_TENANT'];",
        porque: "process['env'] reads the environment without the text process.env",
      },
      {
        archivo: 'src/gateway/config.ts',
        de: 'const publicOrigin = env.GATEWAY_PUBLIC_ORIGIN',
        a: 'const { PAC_PASSWORD: pac } = env;\n  const publicOrigin = env.GATEWAY_PUBLIC_ORIGIN',
        porque: 'destructuring the env alias reads a key that no env.<KEY> access shows',
      },
      {
        archivo: 'src/auth/oidc.ts',
        de: "import { createRemoteJWKSet, customFetch, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';",
        a: "import { createRemoteJWKSet, customFetch, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';\nconst tenant = process.env.MNEMOSINE_TENANT;",
        porque: 'a borrowed module the gateway process loads reads the environment the gateway was built not to read',
      },
      {
        archivo: 'src/auth/oidc.ts',
        de: "import { createRemoteJWKSet, customFetch, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';",
        a: "import { createRemoteJWKSet, customFetch, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';\nexport const ENGINE_KEY = 'ENCRYPTION_KEY';",
        porque: 'an engine credential named in a borrowed module is inside the gateway process all the same',
      },
      {
        archivo: 'src/gateway/app/main.ts',
        de: "import { mount, skipWithoutNavigating } from './dom.js';",
        a: "import '../config.js';\nimport { mount, skipWithoutNavigating } from './dom.js';",
        porque: 'the browser program would reach server configuration code, and whatever it imports ships to every page',
      },
      {
        archivo: 'src/gateway/app/messages.ts',
        de: "import { ES } from '../../i18n/es.js';",
        a: "import { ES } from '../../i18n/es.js';\nimport { t } from '../../i18n/index.js';",
        porque: "the CLI's catalog runtime reads the process locale; in the browser it is a second analyzer and a Node dependency",
      },
    ],
    evaluar: () => {
      const { server, app } = gatewayFiles();
      if (server.length < 10) {
        return falla(
          `src/gateway sólo tiene ${server.length} archivo(s) del proceso servidor: el instrumento no miró, y no haber mirado no es haber aislado`
        );
      }
      if (app.length < 7) {
        return falla(
          `src/gateway/app sólo tiene ${app.length} módulo(s) del programa del navegador: el instrumento no miró, y un cierre vacío no es un cierre contenido`
        );
      }
      const serverClosure = importClosure(seamSource, server, GATEWAY_SERVER_CLOSURE);
      const findings = [...serverClosure.violations, ...importClosureViolations(seamSource, app, GATEWAY_APP_CLOSURE)];

      // Everything below reads every file the server process loads, the
      // borrowed auth and trust-proxy modules included: a credential or an
      // environment read in src/auth/oidc.ts is inside the gateway all the same.
      const banned = ['jsonwebtoken', 'JWT_SECRET', 'DATABASE_URL', 'ENCRYPTION_KEY'];
      // jose is judged by its bindings in the walk; these are node:crypto's and
      // WebCrypto's signers, named wherever they appear, member access included.
      const signers = new Set(['createHmac', 'createSign', 'subtle']);
      const processMembers = new Set(['stderr', 'stdout', 'exit', 'exitCode', 'once', 'on', 'platform']);
      const allowedKeys = new Set([
        'AUTH_OIDC_ISSUER',
        'AUTH_OIDC_AUDIENCE',
        'AUTH_OIDC_WEB_CLIENT_ID',
        'AUTH_OIDC_WEB_CLIENT_SECRET',
        'NODE_ENV',
      ]);
      const configFile = 'src/gateway/config.ts';
      let defaultEnvironmentReads = 0;

      for (const rel of serverClosure.files) {
        const text = crudoDe(rel);
        for (const word of banned) if (text.includes(word)) findings.push(`${rel} nombra ${word}`);
        const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
        const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

        forEachGatewayNode(sf, (n) => {
          if (!ts.isIdentifier(n)) return;
          if (signers.has(n.text)) findings.push(`${at(n)} usa ${n.text}, una primitiva de firma`);

          if (n.text === 'process' && isIdentifierReference(n)) {
            const p = n.parent;
            if (!ts.isPropertyAccessExpression(p) || p.expression !== n) {
              // process['env'], `const { env } = process`, an alias, an argument.
              findings.push(`${at(n)} usa process sin nombrar un miembro permitido: ${p.getText(sf).slice(0, 60)}`);
            } else if (p.name.text === 'env') {
              const declaration = p.parent;
              const isTheDefault =
                rel === configFile &&
                ts.isParameter(declaration) &&
                declaration.initializer === p &&
                ts.isIdentifier(declaration.name) &&
                declaration.name.text === 'env' &&
                ts.isFunctionDeclaration(declaration.parent) &&
                declaration.parent.name?.text === 'readGatewayConfig';
              if (isTheDefault) defaultEnvironmentReads += 1;
              else findings.push(`${at(n)} lee process.env fuera del parámetro por omisión de readGatewayConfig`);
            } else if (!processMembers.has(p.name.text)) {
              findings.push(`${at(n)} usa process.${p.name.text}`);
            }
          }

          // In config.ts the alias `env` may only be read as env.<ALLOWED_KEY>:
          // destructuring, spreading, indexing or handing it along reads keys no
          // property access shows.
          if (rel === configFile && n.text === 'env' && isIdentifierReference(n)) {
            const p = n.parent;
            if (ts.isParameter(p) && p.name === n) return;
            if (ts.isPropertyAccessExpression(p) && p.expression === n) {
              const key = p.name.text;
              if (!key.startsWith('GATEWAY_') && !allowedKeys.has(key)) findings.push(`${configFile} lee env.${key}`);
            } else {
              findings.push(`${at(n)} usa el entorno sin nombrar una clave: ${p.getText(sf).slice(0, 60)}`);
            }
          }
        });
      }

      if (!existe(configFile)) {
        findings.push(`desapareció ${configFile}: no queda el único lector del entorno`);
      } else if (defaultEnvironmentReads !== 1) {
        findings.push(
          `el entorno del proceso se lee ${defaultEnvironmentReads} vez(ces) como parámetro por omisión de readGatewayConfig; debe ser exactamente una, y en ningún otro sitio`
        );
      }

      if (findings.length > 0) {
        return falla(`el gateway web alcanza lo que no debe (${findings.join(' · ')})`);
      }
      return ok(
        `el cierre de imports de ${server.length} archivo(s) del servidor del gateway (${serverClosure.files.length} con los módulos prestados) y ${app.length} del programa del navegador se queda dentro de lo permitido, sin firmar tokens ni leer más entorno que el suyo`
      );
    },
  },

  {
    paquete: 'E2.1',
    id: 'web-gateway-own-routes-are-plumbing',
    // W0 (#117). The gateway answers four plumbing routes of its own and
    // relays GET and HEAD under exactly /v1. A fifth own route is where
    // aggregation (the next engine) begins; another proxied method is cookie
    // authority over the API's body-less external acts; a wider prefix puts
    // the session in front of /metrics and /public/v1. Read on the syntax
    // tree: the route table, the prefix, the method pair and, statement by
    // statement, the predicate that reads it and the gate that enforces it; a
    // single express() app with no Router, no express.static and no ad hoc
    // app.get/post, exactly six app.use calls and one table-driven registration
    // in server.ts; and a static table whose paths cannot shadow the proxy or
    // the session routes.
    // Aliasing `app` escapes a syntax check; tests/gateway/gateway-routes.spec.ts
    // walks the real router stack for that.
    enunciado:
      'El gateway web sólo tiene cuatro rutas propias de fontanería y retransmite a /v1 únicamente lecturas GET y HEAD, sin rutas registradas fuera de su tabla',
    mutantes: [
      {
        archivo: 'src/gateway/routes.ts',
        de: "  ['GET', '/healthz', 'health'],",
        a: "  ['GET', '/healthz', 'health'],\n  ['GET', '/portfolio', 'health'],",
        porque: 'a fifth own route is where aggregation, the next engine, begins',
      },
      {
        archivo: 'src/gateway/routes.ts',
        de: "export const PROXIED_METHODS = ['GET', 'HEAD'] as const;",
        a: "export const PROXIED_METHODS = ['GET', 'HEAD', 'POST'] as const;",
        porque:
          'cookie authority would reach the body-less CFDI stamp and cancel before the API enforces its dry-run and live flags',
      },
      {
        archivo: 'src/gateway/server.ts',
        de: '  app.use(notFound);',
        a: "  app.get('/summary', notFound);\n  app.use(notFound);",
        porque: 'an ad hoc registration outside the literal table',
      },
      {
        archivo: 'src/gateway/routes.ts',
        de: "export const PROXY_PREFIX = '/v1';",
        a: "export const PROXY_PREFIX = '/';",
        porque: 'the session would reach /metrics, /ready and /public/v1',
      },
      {
        archivo: 'src/gateway/static-assets.ts',
        de: "  ['/', 'index.html', 'text/html; charset=utf-8'],",
        a: "  ['/v1/portfolio', 'index.html', 'text/html; charset=utf-8'],",
        porque: 'a static file answering under the proxied prefix would shadow the contract',
      },
      {
        archivo: 'src/gateway/server.ts',
        de: '  app.use(staticAssets);',
        a: '  app.use(express.static(DEFAULT_STATIC_ROOT));',
        porque: 'directory serving replaces the closed table: source maps, sources and dotfiles become reachable',
      },
      {
        archivo: 'src/gateway/routes.ts',
        de: '  return (PROXIED_METHODS as readonly string[]).includes(method);',
        a: "  return (PROXIED_METHODS as readonly string[]).includes(method) || method === 'POST';",
        porque: 'the method pair stays literal while the predicate that reads it admits a body-less POST to the stamp route',
      },
      {
        archivo: 'src/gateway/request-guards.ts',
        de: "  if (!isProxiedMethod(req.method)) return sendError(res, 405, 'METHOD_NOT_PROXIED');",
        a: "  if (!isProxiedMethod(req.method) && req.method !== 'POST') return sendError(res, 405, 'METHOD_NOT_PROXIED');",
        porque: 'the gate that enforces the pair lets POST through to a relay that forwards req.method',
      },
    ],
    evaluar: () => {
      const findings: string[] = [];

      const routesFile = 'src/gateway/routes.ts';
      const routes = gatewaySyntaxOf(routesFile);
      if (!routes) return falla(`desapareció ${routesFile}: no queda la tabla de rutas del gateway`);
      const table = topLevelInitializer(routes, 'GATEWAY_ROUTES');
      const declared: string[] = [];
      if (!table || !ts.isArrayLiteralExpression(table.node)) {
        findings.push('GATEWAY_ROUTES ya no es un arreglo literal');
      } else {
        for (const e of table.node.elements) {
          const tuple = ts.isArrayLiteralExpression(e) ? stringElements(e) : undefined;
          if (!tuple || tuple.length !== 3) findings.push(`GATEWAY_ROUTES tiene un elemento que no es [método, ruta, manejador]: ${e.getText(routes).slice(0, 60)}`);
          else declared.push(`${tuple[0]} ${tuple[1]}`);
        }
        const expected = ['GET /healthz', 'GET /auth/login', 'GET /auth/callback', 'POST /auth/logout'];
        if ([...declared].sort().join(' | ') !== [...expected].sort().join(' | ')) {
          findings.push(`GATEWAY_ROUTES declara {${declared.join(', ')}} en vez de exactamente {${expected.join(', ')}}`);
        }
      }
      const prefix = topLevelInitializer(routes, 'PROXY_PREFIX');
      if (!prefix || !ts.isStringLiteral(prefix.node) || prefix.node.text !== '/v1') {
        findings.push("PROXY_PREFIX ya no es exactamente '/v1'");
      }
      const methods = topLevelInitializer(routes, 'PROXIED_METHODS');
      const methodList = methods ? stringElements(methods.node) : undefined;
      if (!methods || !ts.isAsExpression(methods.raw) || methods.raw.type.getText(routes) !== 'const' || methodList?.join(',') !== 'GET,HEAD') {
        findings.push(`PROXIED_METHODS ya no es exactamente ['GET', 'HEAD'] as const (${methods?.raw.getText(routes).slice(0, 60) ?? 'ausente'})`);
      }

      // The pair is only as good as the code that reads it. isProxiedMethod is
      // the one predicate (the method gate and the CSRF guard's Origin rule
      // both call it), and methodGate is the one place a method is refused
      // before the relay forwards req.method as it came.
      const predicate = soleFunction(routes, 'isProxiedMethod');
      if (
        !predicate ||
        predicate.parameters.length !== 1 ||
        predicate.parameters[0].name.getText(routes) !== 'method' ||
        !sameStatements(predicate.body?.statements, routes, 'return (PROXIED_METHODS as readonly string[]).includes(method);')
      ) {
        findings.push('isProxiedMethod ya no es exactamente «PROXIED_METHODS incluye el método»');
      }
      const guardsFile = 'src/gateway/request-guards.ts';
      const guards = gatewaySyntaxOf(guardsFile);
      if (!guards) {
        findings.push(`desapareció ${guardsFile}: no queda la compuerta de métodos`);
      } else {
        const gate = topLevelInitializer(guards, 'methodGate');
        const gateBody = gate && ts.isArrowFunction(gate.node) && ts.isBlock(gate.node.body) ? gate.node.body.statements : undefined;
        if (
          !sameStatements(gateBody, guards, "if (!isProxiedMethod(req.method)) return sendError(res, 405, 'METHOD_NOT_PROXIED');\nnext();")
        ) {
          findings.push('methodGate ya no rechaza con 405 todo método que isProxiedMethod no admite');
        }
        if (!plainImportsFrom(guards, './routes.js').has('isProxiedMethod') || localDeclarationsOf(guards, 'isProxiedMethod') > 0) {
          findings.push('request-guards.ts ya no usa el isProxiedMethod de routes.ts');
        }
      }

      const { server } = gatewayFiles();
      const registrationVerbs = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head']);
      let expressApps = 0;
      for (const rel of server) {
        const sf = gatewaySyntaxOf(rel);
        if (!sf) continue;
        for (const n of gatewayNodes(sf)) {
          if (!ts.isCallExpression(n)) continue;
          const callee = n.expression;
          const at = `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
          if (ts.isIdentifier(callee) && callee.text === 'express') {
            expressApps += 1;
            if (rel !== 'src/gateway/server.ts') findings.push(`${at} crea una app express fuera de server.ts`);
          }
          if ((ts.isIdentifier(callee) && callee.text === 'Router') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Router')) {
            findings.push(`${at} crea un Router`);
          }
          if (ts.isPropertyAccessExpression(callee)) {
            const receiver = callee.expression.getText(sf);
            if (callee.name.text === 'static' && receiver === 'express') findings.push(`${at} sirve un directorio con express.static`);
            if (callee.name.text === 'route') findings.push(`${at} registra con .route(`);
            if ((receiver === 'app' || receiver === 'router') && registrationVerbs.has(callee.name.text)) {
              findings.push(`${at} registra ${receiver}.${callee.name.text}( fuera de la tabla`);
            }
          }
        }
      }
      if (expressApps !== 1) findings.push(`hay ${expressApps} llamada(s) a express() en el gateway; debe haber una, en server.ts`);

      const serverFile = 'src/gateway/server.ts';
      const serverSf = gatewaySyntaxOf(serverFile);
      if (!serverSf) {
        findings.push(`desapareció ${serverFile}`);
      } else {
        const calls = [...gatewayNodes(serverSf)].filter(ts.isCallExpression);
        const uses = calls.filter(
          (c) => ts.isPropertyAccessExpression(c.expression) && c.expression.expression.getText(serverSf) === 'app' && c.expression.name.text === 'use'
        );
        const elementCalls = calls.filter(
          (c) => ts.isElementAccessExpression(c.expression) && c.expression.expression.getText(serverSf) === 'app'
        );
        if (uses.length !== 6) findings.push(`server.ts hace ${uses.length} llamada(s) a app.use; el orden declarado tiene seis`);
        const loopRegistration =
          elementCalls.length === 1 &&
          (() => {
            let p: ts.Node | undefined = elementCalls[0].parent;
            while (p && !ts.isSourceFile(p)) {
              if (ts.isForOfStatement(p)) return p.expression.getText(serverSf) === 'GATEWAY_ROUTES';
              p = p.parent;
            }
            return false;
          })();
        if (!loopRegistration) {
          findings.push(`server.ts registra ${elementCalls.length} ruta(s) por índice sobre app; debe ser una sola, dentro del recorrido de GATEWAY_ROUTES`);
        }
      }

      const assetsFile = 'src/gateway/static-assets.ts';
      const assets = gatewaySyntaxOf(assetsFile);
      const assetTable = assets ? topLevelInitializer(assets, 'STATIC_ASSETS') : undefined;
      if (!assets || !assetTable || !ts.isArrayLiteralExpression(assetTable.node) || assetTable.node.elements.length === 0) {
        findings.push('STATIC_ASSETS ya no es un arreglo literal con al menos un archivo');
      } else {
        for (const e of assetTable.node.elements) {
          const tuple = ts.isArrayLiteralExpression(e) ? stringElements(e) : undefined;
          if (!tuple || tuple.length !== 3) {
            findings.push(`STATIC_ASSETS tiene un elemento que no es [ruta publicada, archivo, tipo]: ${e.getText(assets).slice(0, 60)}`);
            continue;
          }
          const published = tuple[0];
          if (published !== '/' && !/\.(?:html|js|css|woff2)$/.test(published)) {
            findings.push(`STATIC_ASSETS publica ${published}, que no es la raíz ni un recurso web`);
          }
          if (/^\/(?:v1|auth|healthz)(?:\/|$)/i.test(published)) {
            findings.push(`STATIC_ASSETS publica ${published}, que tapa el proxy o las rutas de sesión`);
          }
        }
      }

      if (findings.length > 0) {
        return falla(`el gateway web responde más de lo que su tabla declara (${findings.join(' · ')})`);
      }
      return ok(
        'el gateway registra sus cuatro rutas de fontanería desde una sola tabla, retransmite sólo GET y HEAD bajo /v1 y sirve archivos estáticos desde una tabla cerrada que no tapa ninguna de las dos'
      );
    },
  },

  {
    paquete: 'E2.1',
    id: 'browser-session-is-not-ambient-authority',
    // W0 (#117). The browser session is the first ambient authority this
    // repository ships: the browser attaches the cookie by itself. What keeps
    // it from acting for anyone else, read on the syntax tree:
    //   · the session cookie is __Host- with HttpOnly, Secure, SameSite=Strict
    //     and Path=/, set only through those attributes, and no cookie names a
    //     Domain; the login cookie is Lax and lives ten minutes; no other file
    //     writes a cookie except through the cookies.ts helpers;
    //   · the Host guard, statement by statement, answers 421 to every Host
    //     but the public origin's, with ONE exemption, GET /healthz, because
    //     probes address the pod IP; it is bound once to its factory, imported
    //     unrenamed, and is the first app.use of server.ts, so no own route,
    //     static file or relayed read answers under another Host;
    //   · the CSRF guard, statement by statement, demands the custom header,
    //     same-origin Sec-Fetch-Site and, for unsafe methods, the exact public
    //     Origin; logout sits behind it too;
    //   · the /v1 pipeline is path, CSRF, method, session, relay, in that order,
    //     and those names are the guards (csrfGuard bound once to the factory,
    //     the rest imported unrenamed);
    //   · the relay forwards four request headers, reads the client's headers
    //     only in the loop over that list, writes authorization once from the
    //     session, and follows no redirect. Back to the browser it copies only
    //     FORWARDED_RESPONSE_HEADERS, in one loop whose body is pinned, plus
    //     the three headers it sets by literal name, and it touches `res`
    //     through no other member: no Set-Cookie, Location or Access-Control-*
    //     goes back, whatever upstream sends;
    //   · a token is stored only after acceptTokenResponse checked it is
    //     asymmetric and verified it against the IdP;
    //   · the session record keeps no ID token;
    //   · and the API never learns to read a cookie.
    // Behaviour is in tests/gateway/gateway-csrf.spec.ts, gateway-proxy.spec.ts
    // and gateway-oidc.spec.ts.
    enunciado:
      'La sesión del navegador no es autoridad ambiental: la cookie es __Host- y Strict, CSRF se exige antes que el método y la sesión, y el proxy no reenvía credenciales del cliente ni guarda tokens sin verificar',
    mutantes: [
      {
        archivo: 'src/gateway/cookies.ts',
        de: "const SESSION_COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Strict; Path=/';",
        a: "const SESSION_COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=None; Path=/';",
        porque: "every cross-site request would carry the operator's session again",
      },
      {
        archivo: 'src/gateway/proxy.ts',
        de: "export const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'if-none-match', 'x-entity-id'] as const;",
        a: "export const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'if-none-match', 'x-entity-id', 'authorization'] as const;",
        porque: 'a Bearer supplied by the browser, including a forged HS256 one, would reach the API in place of the verified token',
      },
      {
        archivo: 'src/gateway/server.ts',
        de: 'app.use(PROXY_PREFIX, pathGuard, csrfGuard, methodGate, sessionGuard, proxyToApi);',
        a: 'app.use(PROXY_PREFIX, pathGuard, methodGate, sessionGuard, proxyToApi);',
        porque: 'the CSRF guard would leave the pipeline while the function still exists',
      },
      {
        archivo: 'src/gateway/oidc-client.ts',
        de: '  if (!isAsymmetric(tokens.access_token)) {',
        a: '  if (false) {',
        porque: 'a token endpoint returning HS256 would store a credential whose claims the API trusts verbatim',
      },
      {
        archivo: 'src/gateway/request-guards.ts',
        de: 'req.headers.origin !== config.publicOrigin',
        a: 'false',
        porque: 'unsafe methods would accept any Origin, including a same-site sibling',
      },
      {
        archivo: 'src/gateway/server.ts',
        de: '    logout: [csrfGuard, createLogoutRoute(authDeps)],',
        a: '    logout: [createLogoutRoute(authDeps)],',
        porque: 'a cross-site form could sign the operator out, and the one unsafe own route would stand outside the guard',
      },
      {
        archivo: 'src/gateway/proxy.ts',
        de: "        redirect: 'manual',",
        a: "        redirect: 'follow',",
        porque: 'an upstream redirect would carry the session Bearer to wherever the Location header points',
      },
      {
        archivo: 'src/gateway/request-guards.ts',
        de: '    if (!isProxiedMethod(req.method) && req.headers.origin !== config.publicOrigin) {',
        a: '    if (isProxiedMethod(req.method) && req.headers.origin !== config.publicOrigin) {',
        porque: 'one dropped ! demands Origin on reads and on nothing that writes, logout included',
      },
      {
        archivo: 'src/gateway/request-guards.ts',
        de: "    if (site !== undefined && site !== 'same-origin') return sendError(res, 403, 'CSRF_REJECTED');",
        a: "    if (site === undefined && site !== 'same-origin') return sendError(res, 403, 'CSRF_REJECTED');",
        porque: 'a flipped comparison accepts Sec-Fetch-Site cross-site while the text still names same-origin',
      },
      {
        archivo: 'src/gateway/request-guards.ts',
        de: "    if (req.headers[CSRF_HEADER] !== '1') return sendError(res, 403, 'CSRF_REJECTED');",
        a: "    if (req.headers[CSRF_HEADER] !== '1') return next();",
        porque: 'the header is still read, and a request without it goes through',
      },
      {
        archivo: 'src/gateway/server.ts',
        de: '  const csrfGuard = createCsrfGuard(config);',
        a: '  const csrfGuard: RequestHandler = function csrfGuard(_req, _res, next) {\n    next();\n  };',
        porque: 'the pipeline keeps the name csrfGuard while the binding behind it checks nothing',
      },
      {
        archivo: 'src/gateway/proxy.ts',
        de: "    headers.set('authorization', `Bearer ${session.record.accessToken}`);",
        a: "    headers.set('authorization', req.headers.authorization ?? `Bearer ${session.record.accessToken}`);",
        porque: 'a client Authorization, a forged HS256 token included, wins over the verified one with the header list untouched',
      },
      {
        archivo: 'src/gateway/auth-routes.ts',
        de: "    res.append('Set-Cookie', sessionCookie(created.cookieValue, deps.sessionAbsoluteSeconds));",
        a: "    res.cookie(SESSION_COOKIE, created.cookieValue, { httpOnly: true, secure: true, sameSite: 'none' });",
        porque: 'a session cookie written outside cookies.ts carries whatever SameSite its author chose',
      },
      {
        archivo: 'src/gateway/proxy.ts',
        de: '    res.status(upstream.status);',
        a: '    res.status(upstream.status);\n    upstream.headers.forEach((value, name) => res.setHeader(name, value));',
        porque:
          "every upstream header, Set-Cookie and Location included, would reach the browser while FORWARDED_RESPONSE_HEADERS still reads clean",
      },
      {
        archivo: 'src/gateway/request-guards.ts',
        de: "    if (req.method === 'GET' && req.path === '/healthz') return next();",
        a: "    if (req.method === 'GET' || req.path === '/healthz') return next();",
        porque: "the probe's exemption widens to every GET, so the board and its reads answer under any Host",
      },
      {
        archivo: 'src/gateway/request-guards.ts',
        de: "    if (host !== expectedHost) return sendError(res, 421, 'HOST_REJECTED');",
        a: "    if (host === undefined) return sendError(res, 421, 'HOST_REJECTED');",
        porque: 'the 421 is still spelled while no Host is compared with the public origin',
      },
      {
        archivo: 'src/gateway/server.ts',
        de: '  app.use(hostGuard);',
        a: "  app.use('/auth', hostGuard);",
        porque: 'the guard would stand only in front of the session routes, and the static files and the relay would answer under any Host',
      },
    ],
    evaluar: () => {
      const findings: string[] = [];
      const required = (rel: string): ts.SourceFile | undefined => {
        const sf = gatewaySyntaxOf(rel);
        if (!sf) findings.push(`desapareció ${rel}`);
        return sf;
      };
      const literal = (sf: ts.SourceFile, name: string): string | undefined => {
        const init = topLevelInitializer(sf, name);
        return init && ts.isStringLiteral(init.node) ? init.node.text : undefined;
      };

      // Cookies.
      const cookies = required('src/gateway/cookies.ts');
      if (cookies) {
        if (literal(cookies, 'SESSION_COOKIE') !== '__Host-mnemosine_session') findings.push('SESSION_COOKIE ya no es __Host-mnemosine_session');
        if (literal(cookies, 'LOGIN_COOKIE') !== '__Host-mnemosine_login') findings.push('LOGIN_COOKIE ya no es __Host-mnemosine_login');
        if (literal(cookies, 'SESSION_COOKIE_ATTRIBUTES') !== 'HttpOnly; Secure; SameSite=Strict; Path=/') {
          findings.push('los atributos de la cookie de sesión ya no son exactamente HttpOnly; Secure; SameSite=Strict; Path=/');
        }
        const loginAttributes = (literal(cookies, 'LOGIN_COOKIE_ATTRIBUTES') ?? '').split(';').map((s) => s.trim());
        for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) {
          if (!loginAttributes.includes(attribute)) findings.push(`la cookie de login perdió ${attribute}`);
        }
        if (/domain\s*=/i.test(crudoDe('src/gateway/cookies.ts'))) findings.push('cookies.ts nombra un Domain');
        // Every template that writes a cookie name writes that cookie's attributes too.
        for (const n of gatewayNodes(cookies)) {
          if (!ts.isTemplateExpression(n)) continue;
          const substitutions = n.templateSpans.map((s) => s.expression.getText(cookies));
          for (const [name, attributes] of [
            ['SESSION_COOKIE', 'SESSION_COOKIE_ATTRIBUTES'],
            ['LOGIN_COOKIE', 'LOGIN_COOKIE_ATTRIBUTES'],
          ] as const) {
            if (substitutions[0] === name && !n.getText(cookies).includes(attributes)) {
              findings.push(`una cookie ${name} se escribe sin ${attributes}: ${n.getText(cookies).slice(0, 60)}`);
            }
          }
        }
      }

      // And a cookie is written only through those helpers: express's
      // res.cookie() takes whatever SameSite its caller spells, and a
      // Set-Cookie header built anywhere else escapes the attribute checks.
      const cookieWriters = new Set(['sessionCookie', 'clearSessionCookie', 'loginCookie', 'clearLoginCookie']);
      const headerSetters = new Set(['setHeader', 'append', 'set', 'header']);
      for (const rel of gatewayFiles().server) {
        if (rel === 'src/gateway/cookies.ts') continue;
        const sf = gatewaySyntaxOf(rel);
        if (!sf) continue;
        const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
        const fromCookies = plainImportsFrom(sf, './cookies.js');
        for (const name of cookieWriters) {
          if (localDeclarationsOf(sf, name) > 0) findings.push(`${rel} declara su propio ${name}`);
        }
        forEachGatewayNode(sf, (n) => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(?:cookie|clearCookie)$/.test(n.expression.name.text)) {
            findings.push(`${at(n)} escribe una cookie con .${n.expression.name.text}(, fuera de cookies.ts`);
          }
          if (!(ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) || !/^set-cookie$/i.test(n.text)) return;
          const call = n.parent;
          const value = ts.isCallExpression(call) && call.arguments[0] === n ? call.arguments[1] : undefined;
          const fine =
            ts.isCallExpression(call) &&
            ts.isPropertyAccessExpression(call.expression) &&
            headerSetters.has(call.expression.name.text) &&
            value !== undefined &&
            ts.isCallExpression(value) &&
            ts.isIdentifier(value.expression) &&
            cookieWriters.has(value.expression.text) &&
            fromCookies.has(value.expression.text);
          if (!fine) findings.push(`${at(n)} escribe Set-Cookie sin los ayudantes de cookies.ts: ${call.getText(sf).slice(0, 60)}`);
        });
      }

      // The CSRF guard, statement by statement: a dropped `!`, a flipped
      // comparison or a refusal turned into next() keeps every name in place.
      const guards = required('src/gateway/request-guards.ts');
      if (guards) {
        if (literal(guards, 'CSRF_HEADER') !== 'x-mnemosine-request') findings.push('la guarda CSRF ya no exige x-mnemosine-request: 1');
        const factory = soleFunction(guards, 'createCsrfGuard');
        const only = factory?.body?.statements.length === 1 ? factory.body.statements[0] : undefined;
        const returned = only && ts.isReturnStatement(only) ? only.expression : undefined;
        const guard = returned && ts.isFunctionExpression(returned) && returned.name?.text === 'csrfGuard' ? returned : undefined;
        if (
          !sameStatements(
            guard?.body.statements,
            guards,
            [
              "if (req.headers[CSRF_HEADER] !== '1') return sendError(res, 403, 'CSRF_REJECTED');",
              "const site = req.headers['sec-fetch-site'];",
              "if (site !== undefined && site !== 'same-origin') return sendError(res, 403, 'CSRF_REJECTED');",
              "if (!isProxiedMethod(req.method) && req.headers.origin !== config.publicOrigin) {",
              "  return sendError(res, 403, 'CSRF_REJECTED');",
              '}',
              'next();',
            ].join('\n')
          )
        ) {
          findings.push(
            'la guarda CSRF ya no es exactamente: cabecera x-mnemosine-request, Sec-Fetch-Site same-origin cuando viene, y Origin exacto en los métodos que escriben, cada una con 403'
          );
        }

        // The Host guard the same way. Its one early return is the probe's
        // exemption, GET /healthz and nothing wider, and after it comes the
        // comparison with the public origin's host and the 421.
        const hostFactory = soleFunction(guards, 'createHostGuard');
        if (
          !sameStatements(
            hostFactory?.body?.statements,
            guards,
            [
              'const expectedHost = new URL(config.publicOrigin).host.toLowerCase();',
              'return function hostGuard(req, res, next) {',
              "  if (req.method === 'GET' && req.path === '/healthz') return next();",
              '  const host = req.headers.host?.toLowerCase();',
              "  if (host !== expectedHost) return sendError(res, 421, 'HOST_REJECTED');",
              '  next();',
              '};',
            ].join('\n')
          )
        ) {
          findings.push(
            'la guarda de Host ya no es exactamente: GET /healthz como única excepción, y 421 para todo Host distinto del del origen público'
          );
        }
      }

      // Pipeline order and the one unsafe own route.
      const server = required('src/gateway/server.ts');
      if (server) {
        const pipelines = [...gatewayNodes(server)].filter(
          (n): n is ts.CallExpression =>
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.getText(server) === 'app.use' &&
            n.arguments[0]?.getText(server) === 'PROXY_PREFIX'
        );
        const order = pipelines.map((c) => c.arguments.map((a) => a.getText(server)).join(', '));
        if (order.length !== 1 || order[0] !== 'PROXY_PREFIX, pathGuard, csrfGuard, methodGate, sessionGuard, proxyToApi') {
          findings.push(`el pipeline de /v1 es [${order.join(' | ')}] en vez de path, CSRF, método, sesión y proxy`);
        }
        const logout = handlersTableEntry(server, 'logout');
        if (logout !== 'csrfGuard') findings.push(`POST /auth/logout no empieza por csrfGuard (${logout ?? 'sin manejadores'})`);
        // The names in the pipeline are the guards themselves: csrfGuard is
        // bound once, to the factory, and the rest are imported unrenamed.
        const csrfBindings: ts.VariableDeclaration[] = [];
        forEachGatewayNode(server, (n) => {
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'csrfGuard') csrfBindings.push(n);
        });
        const csrfInit = csrfBindings.length === 1 ? csrfBindings[0].initializer : undefined;
        if (
          localDeclarationsOf(server, 'csrfGuard') !== 1 ||
          !csrfInit ||
          GATEWAY_CODE_PRINTER.printNode(ts.EmitHint.Expression, csrfInit, server) !== 'createCsrfGuard(config)'
        ) {
          findings.push('csrfGuard ya no es, en server.ts, una sola constante igual a createCsrfGuard(config)');
        }
        const imported = plainImportsFrom(server, './request-guards.js');
        for (const name of ['createCsrfGuard', 'createHostGuard', 'pathGuard', 'methodGate']) {
          if (!imported.has(name) || localDeclarationsOf(server, name) > 0) findings.push(`server.ts ya no usa el ${name} de request-guards.ts`);
        }
        // hostGuard is bound once, to its factory, and mounted first and on
        // every path: mounted later or under a prefix, whatever answers before
        // it answers under any Host.
        const hostBindings: ts.VariableDeclaration[] = [];
        forEachGatewayNode(server, (n) => {
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'hostGuard') hostBindings.push(n);
        });
        const hostInit = hostBindings.length === 1 ? hostBindings[0].initializer : undefined;
        if (
          localDeclarationsOf(server, 'hostGuard') !== 1 ||
          !hostInit ||
          GATEWAY_CODE_PRINTER.printNode(ts.EmitHint.Expression, hostInit, server) !== 'createHostGuard(config)'
        ) {
          findings.push('hostGuard ya no es, en server.ts, una sola constante igual a createHostGuard(config)');
        }
        const firstUse = [...gatewayNodes(server)].find(
          (n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText(server) === 'app.use'
        );
        const firstUsePrinted = firstUse ? GATEWAY_CODE_PRINTER.printNode(ts.EmitHint.Expression, firstUse, server) : 'ninguno';
        if (firstUsePrinted !== 'app.use(hostGuard)') {
          findings.push(`el primer app.use de server.ts es ${firstUsePrinted.slice(0, 60)} y no app.use(hostGuard)`);
        }
      }

      // The relay.
      const proxy = required('src/gateway/proxy.ts');
      if (proxy) {
        const requestHeaders = topLevelInitializer(proxy, 'FORWARDED_REQUEST_HEADERS');
        const forwarded = requestHeaders ? stringElements(requestHeaders.node) : undefined;
        if ([...(forwarded ?? [])].sort().join(',') !== 'accept,accept-language,if-none-match,x-entity-id') {
          findings.push(`el proxy reenvía las cabeceras {${(forwarded ?? []).join(', ')}} en vez de accept, accept-language, if-none-match y x-entity-id`);
        }
        const responseHeaders = topLevelInitializer(proxy, 'FORWARDED_RESPONSE_HEADERS');
        const back = responseHeaders ? stringElements(responseHeaders.node) : undefined;
        if (!back) findings.push('FORWARDED_RESPONSE_HEADERS ya no es un arreglo literal de cadenas');
        for (const h of back ?? []) {
          if (/^(?:set-cookie|location|www-authenticate|access-control-)/i.test(h)) findings.push(`el proxy devuelve ${h} al navegador`);
        }
        const code = sinComentarios(crudoDe('src/gateway/proxy.ts'));
        const redirects = [...code.matchAll(/\bredirect:\s*'([a-z]+)'/g)].map((m) => m[1]);
        if (redirects.length !== 1 || redirects[0] !== 'manual') {
          findings.push(`la llamada al API ya no usa redirect: 'manual' (${redirects.join(', ') || 'ninguno'})`);
        }

        // The header list is not the only door: the relay writes authorization
        // once, from the session, and reads the client's headers only inside
        // the loop over that list.
        const authorizationMentions: ts.Node[] = [];
        const clientReads: string[] = [];
        forEachGatewayNode(proxy, (n) => {
          if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isIdentifier(n)) && /^authorization$/i.test(n.text)) {
            authorizationMentions.push(n);
          }
          if (!ts.isIdentifier(n) || n.text !== 'req' || !isIdentifierReference(n)) return;
          const p = n.parent;
          if (ts.isParameter(p) && p.name === n) return;
          const line = `proxy.ts:${proxy.getLineAndCharacterOfPosition(n.getStart(proxy)).line + 1}`;
          if (!ts.isPropertyAccessExpression(p) || p.expression !== n) {
            clientReads.push(`${line} ${p.getText(proxy).slice(0, 60)}`);
          } else if (p.name.text === 'headers') {
            const access = p.parent;
            let loop: ts.Node | undefined = access;
            while (loop && !ts.isForOfStatement(loop) && !ts.isFunctionLike(loop)) loop = loop.parent;
            const inLoop =
              ts.isElementAccessExpression(access) &&
              access.expression === p &&
              ts.isIdentifier(access.argumentExpression) &&
              loop !== undefined &&
              ts.isForOfStatement(loop) &&
              loop.expression.getText(proxy) === 'FORWARDED_REQUEST_HEADERS' &&
              ts.isVariableDeclarationList(loop.initializer) &&
              loop.initializer.declarations.length === 1 &&
              loop.initializer.declarations[0].name.getText(proxy) === access.argumentExpression.text;
            if (!inLoop) clientReads.push(`${line} ${access.getText(proxy).slice(0, 60)}`);
          } else if (!['ip', 'method', 'originalUrl'].includes(p.name.text)) {
            clientReads.push(`${line} req.${p.name.text}`);
          }
        });
        const write = authorizationMentions.length === 1 ? authorizationMentions[0].parent : undefined;
        if (
          !write ||
          !ts.isCallExpression(write) ||
          write.arguments[0] !== authorizationMentions[0] ||
          GATEWAY_CODE_PRINTER.printNode(ts.EmitHint.Expression, write, proxy) !== "headers.set('authorization', `Bearer ${session.record.accessToken}`)"
        ) {
          findings.push(
            `el proxy ya no escribe authorization una sola vez, desde la sesión (${authorizationMentions.length} mención(es) de authorization)`
          );
        }
        for (const read of clientReads) findings.push(`el proxy lee de la petición fuera de la lista de cabeceras: ${read}`);

        // Nor is FORWARDED_RESPONSE_HEADERS the only door back. A header
        // reaches the browser from the one loop over that list, whose body is
        // pinned, or under one of the three names the relay sets itself; and
        // `res` is touched through no other member. An
        // upstream.headers.forEach, a res.set(object), a writeHead with a
        // header bag or an alias of `res` would copy Set-Cookie and Location
        // back with the list untouched.
        const responseLoops = [...gatewayNodes(proxy)].filter(
          (n): n is ts.ForOfStatement => ts.isForOfStatement(n) && n.expression.getText(proxy) === 'FORWARDED_RESPONSE_HEADERS'
        );
        const responseLoop = responseLoops.length === 1 ? responseLoops[0] : undefined;
        const responseLoopBody = responseLoop && ts.isBlock(responseLoop.statement) ? responseLoop.statement : undefined;
        if (
          !responseLoop ||
          !responseLoopBody ||
          GATEWAY_CODE_PRINTER.printNode(ts.EmitHint.Unspecified, responseLoop.initializer, proxy) !== 'const name' ||
          !sameStatements(responseLoopBody.statements, proxy, 'const value = upstream.headers.get(name);\nif (value !== null) res.setHeader(name, value);')
        ) {
          findings.push(
            `el proxy ya no copia la respuesta en un solo recorrido de FORWARDED_RESPONSE_HEADERS que lee upstream.headers.get(name) (${responseLoops.length} recorrido(s))`
          );
        }
        if (!plainImportsFrom(proxy, './errors.js').has('sendError') || localDeclarationsOf(proxy, 'sendError') > 0) {
          findings.push('proxy.ts ya no responde con el sendError de errors.ts');
        }
        const ownResponseHeaders = new Set(['Cache-Control', 'Vary', 'Content-Security-Policy']);
        const inside = (n: ts.Node, container: ts.Node | undefined): boolean => {
          for (let q: ts.Node | undefined = n; q; q = q.parent) if (q === container) return true;
          return false;
        };
        const responseWrites: string[] = [];
        forEachGatewayNode(proxy, (n) => {
          if (!ts.isIdentifier(n) || n.text !== 'res' || !isIdentifierReference(n)) return;
          const p = n.parent;
          if (ts.isParameter(p) && p.name === n) return;
          const line = `proxy.ts:${proxy.getLineAndCharacterOfPosition(n.getStart(proxy)).line + 1}`;
          if (ts.isCallExpression(p) && p.arguments.includes(n)) {
            const callee = p.expression;
            const sent = ts.isIdentifier(callee) && callee.text === 'sendError' && p.arguments[0] === n;
            const piped = ts.isPropertyAccessExpression(callee) && callee.name.text === 'pipe' && p.arguments.length === 1;
            if (!sent && !piped) responseWrites.push(`${line} ${p.getText(proxy).slice(0, 60)}`);
            return;
          }
          if (!ts.isPropertyAccessExpression(p) || p.expression !== n) {
            responseWrites.push(`${line} ${p.getText(proxy).slice(0, 60)}`);
            return;
          }
          if (p.name.text === 'locals') return;
          const call = p.parent;
          // status, end and destroy as statements of their own: res.status(…)
          // returns res, and a chained .set(…) would be a write this walk
          // never sees as `res`.
          const standalone = ts.isCallExpression(call) && call.expression === p && ts.isExpressionStatement(call.parent);
          if (['status', 'end', 'destroy'].includes(p.name.text) && standalone) return;
          if (p.name.text === 'setHeader' && ts.isCallExpression(call) && call.expression === p) {
            const headerName = call.arguments[0];
            if (headerName && ts.isStringLiteral(headerName) && ownResponseHeaders.has(headerName.text)) return;
            if (responseLoopBody && inside(call, responseLoopBody)) return;
          }
          responseWrites.push(`${line} ${(ts.isCallExpression(call) ? call : p).getText(proxy).slice(0, 60)}`);
        });
        for (const w of responseWrites) findings.push(`el proxy escribe en la respuesta fuera de la lista de cabeceras: ${w}`);
      }

      // Verify before store.
      const oidc = required('src/gateway/oidc-client.ts');
      if (oidc) {
        const accept = oidc.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'acceptTokenResponse');
        const body = accept?.body ? sinComentarios(accept.body.getText(oidc)) : '';
        if (!body.includes('if (!isAsymmetric(tokens.access_token)) {')) findings.push('acceptTokenResponse ya no rechaza un token que no es asimétrico');
        if (!/\bverifyIdpToken\(/.test(body)) findings.push('acceptTokenResponse ya no verifica el token contra el IdP');
      }

      // No ID token in the session.
      const store = required('src/gateway/session-store.ts');
      if (store) {
        const record = store.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'SessionRecord');
        if (!record) findings.push('SessionRecord ya no es una interfaz de session-store.ts');
        for (const m of record?.members ?? []) {
          const name = m.name?.getText(store) ?? '';
          if (/idtoken|id_token|claims|email|subject/i.test(name)) findings.push(`la sesión guarda ${name}`);
        }
      }

      // The API never trusts a cookie.
      for (const abs of fuentes('src/api')) {
        const rel = path.relative(RAIZ, abs).split(path.sep).join('/');
        const code = sinComentarios(crudoDe(rel));
        if (/\breq\.cookies\b|cookie-parser/.test(code)) findings.push(`${rel} lee cookies: el API sólo cree en Authorization`);
      }

      if (findings.length > 0) {
        return falla(`la sesión del navegador puede actuar por otros (${findings.join(' · ')})`);
      }
      return ok(
        'la cookie de sesión es __Host- y Strict, CSRF va antes del método y de la sesión (también en el logout), el proxy no reenvía credenciales del cliente ni sigue redirecciones, y sólo se guardan tokens asimétricos verificados'
      );
    },
  },

  {
    paquete: 'E2.1',
    id: 'web-client-reads-only-contracted-paths',
    // W1 (#117). The browser program reads the API through one table and one
    // client, and the table is checked against the contract the repository
    // commits, not against itself. Read on the syntax tree:
    //   · API_OPERATIONS in contract.ts is an object literal of {method, path}
    //     string pairs, it has a portfolio entry, every method is GET and every
    //     path is a GET operation of docs/openapi.json (a :param is {param});
    //   · no other module of src/gateway/app spells '/v1' in a string or a
    //     template;
    //   · fetch is named only in api.ts, exactly twice, each a direct call:
    //     fetch(request.url, request.init) on what buildGetRequest built, and
    //     fetch(SIGN_OUT_PATH, {…}) with its init written out as plain pairs;
    //     SIGN_OUT_PATH is the gateway's /auth/logout, not the API;
    //   · `method` is spelled in three places only: GET in the table and in
    //     the init type, GET in buildGetRequest's init, POST in that sign-out
    //     init. A shorthand, an `init.method =`, a quoted key or a variable
    //     named method anywhere in the program is red, because each can turn
    //     a contracted read into a write;
    //   · no module names another way to reach the network (XMLHttpRequest,
    //     WebSocket, EventSource, sendBeacon, a worker), neither as a name nor
    //     as a string key, and none takes the global object whole (by key,
    //     cast or alias) instead of reading one dotted member of it.
    // A renamed or retired route, a call the contract never declared, or a
    // write dressed as a read turns this red; tests/gateway/web-contract.spec.ts
    // is the runtime side. What a static read cannot see is a name assembled
    // at run time from pieces through some other object. Against that, the
    // gateway's GET/HEAD method gate still refuses a write; an uncontracted
    // read would get through.
    enunciado:
      'El cliente web sólo lee rutas del contrato: cada llamada a /v1 es un GET que existe en docs/openapi.json y pasa por un único cliente',
    mutantes: [
      {
        archivo: 'src/gateway/app/contract.ts',
        de: "  portfolio: { method: 'GET', path: '/v1/portfolio' },",
        a: "  portfolio: { method: 'GET', path: '/v1/portfolio-summary' },",
        porque: 'the client would call an operation the contract does not declare',
      },
      {
        archivo: 'docs/openapi.json',
        de: '"/v1/portfolio": {',
        a: '"/v1/portfolio-retired": {',
        porque: 'the contract drifts under an unchanged client, and the plan must fail, not the demo',
      },
      {
        archivo: 'src/gateway/app/view.ts',
        de: "import { text } from './messages.js';",
        a: "import { text } from './messages.js';\nconst sideRead = (): Promise<unknown> => fetch('/v1/accounts');",
        porque: 'a second network call site would bypass the contracted client and its CSRF header',
      },
      {
        archivo: 'src/gateway/app/contract.ts',
        de: "  drafts: { method: 'GET', path: '/v1/ai/drafts' },",
        a: "  drafts: { method: 'POST', path: '/v1/ai/drafts' },",
        porque: 'the client would start issuing writes the table was never checked for',
      },
      {
        archivo: 'src/gateway/app/contract.ts',
        de: "    init: { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers },",
        a: "    init: { method: 'DELETE', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers },",
        porque: 'the table still says GET while every request the client builds is a write',
      },
      {
        archivo: 'src/gateway/app/api.ts',
        de: '    response = await fetch(request.url, request.init);',
        a: '    response = await fetch(`/v1/accounts${request.url}`, request.init);',
        porque: 'the one client would call a path of its own instead of the one the table built',
      },
      {
        archivo: 'src/gateway/app/view.ts',
        de: "import { text } from './messages.js';",
        a: "import { text } from './messages.js';\nconst load = window.fetch;",
        porque: 'an aliased fetch is a second client with no fetch( in sight',
      },
      {
        archivo: 'src/gateway/app/main.ts',
        de: "const root = document.getElementById('app');",
        a: "const root = document.getElementById('app');\nconst feed = new EventSource('/events');",
        porque: 'a stream opened beside fetch reaches the network outside the contract and the client',
      },
      {
        archivo: 'src/gateway/app/view.ts',
        de: "import { text } from './messages.js';",
        a: "import { text } from './messages.js';\nexport const sideRead = (): Promise<Response> => (globalThis as unknown as Record<string, (u: string, i: object) => Promise<Response>>)['fetch']('/v' + '1/accounts', { headers: { 'X-Mnemosine-Request': '1' } });",
        porque: 'fetch reached by a string key off the global object is the same second client, and a split path hides its /v1',
      },
      {
        archivo: 'src/gateway/app/api.ts',
        de: '    response = await fetch(request.url, request.init);',
        a: "    const method = 'DELETE';\n    response = await fetch(request.url, { ...request.init, method });",
        porque: 'a shorthand method spread over the built init turns every contracted read into a write',
      },
    ],
    evaluar: () => {
      const findings: string[] = [];
      const contractFile = 'src/gateway/app/contract.ts';
      const clientFile = 'src/gateway/app/api.ts';

      // The contract the repository commits.
      let contractPaths: Record<string, Record<string, unknown> | undefined> | undefined;
      if (!existe('docs/openapi.json')) {
        findings.push('no existe docs/openapi.json: no hay contrato contra el que medir la tabla');
      } else {
        try {
          contractPaths = (JSON.parse(crudoDe('docs/openapi.json')) as { paths?: typeof contractPaths }).paths;
        } catch {
          findings.push('docs/openapi.json no es JSON válido');
        }
        if (findings.length === 0 && !contractPaths) findings.push('docs/openapi.json no tiene paths');
      }

      // The table.
      const contract = gatewaySyntaxOf(contractFile);
      const table = contract ? topLevelInitializer(contract, 'API_OPERATIONS') : undefined;
      if (!contract || !table || !ts.isObjectLiteralExpression(table.node) || table.node.properties.length === 0) {
        findings.push('API_OPERATIONS ya no es, en contract.ts, un objeto literal con al menos una operación');
      } else {
        const names: string[] = [];
        for (const property of table.node.properties) {
          const entry = ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer) ? property.initializer : undefined;
          const fields = new Map<string, string>();
          for (const field of entry?.properties ?? []) {
            if (ts.isPropertyAssignment(field) && ts.isIdentifier(field.name) && ts.isStringLiteral(field.initializer)) {
              fields.set(field.name.text, field.initializer.text);
            } else {
              fields.set('', '');
            }
          }
          const method = fields.get('method');
          const route = fields.get('path');
          if (!entry || fields.size !== 2 || method === undefined || route === undefined) {
            findings.push(`API_OPERATIONS tiene una entrada que no es {method, path} literal: ${property.getText(contract).slice(0, 60)}`);
            continue;
          }
          const name = property.name?.getText(contract) ?? '';
          names.push(name);
          if (method !== 'GET') findings.push(`API_OPERATIONS.${name} es ${method}: el cliente web sólo lee`);
          const operation = contractPaths?.[route.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')];
          if (contractPaths && !operation?.get) findings.push(`API_OPERATIONS.${name} llama a GET ${route}, que docs/openapi.json no declara`);
        }
        if (!names.includes('portfolio')) findings.push('API_OPERATIONS ya no tiene la operación portfolio');

        const signOut = topLevelInitializer(contract, 'SIGN_OUT_PATH');
        if (!signOut || !ts.isStringLiteral(signOut.node) || signOut.node.text !== '/auth/logout') {
          findings.push('SIGN_OUT_PATH ya no es la ruta /auth/logout del gateway');
        }
      }

      // Every module of the browser program.
      const { app } = gatewayFiles();
      if (!app.includes(clientFile)) findings.push(`desapareció ${clientFile}, el único cliente`);
      const networkBans = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'Worker', 'SharedWorker', 'importScripts']);
      const globalObjects = new Set(['globalThis', 'window', 'self']);
      const fetchCalls: string[] = [];
      /** The init of the sign-out call, when it is written out as plain `name: value` pairs. */
      const plainInit = (node: ts.Expression | undefined): node is ts.ObjectLiteralExpression =>
        node !== undefined && ts.isObjectLiteralExpression(node) && node.properties.every((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name));
      for (const rel of app) {
        const sf = gatewaySyntaxOf(rel);
        if (!sf) continue;
        const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
        forEachGatewayNode(sf, (n) => {
          const literal = literalText(n);
          if (literal !== undefined && literal.includes('/v1') && rel !== contractFile) {
            findings.push(`${at(n)} escribe una ruta /v1 fuera de contract.ts`);
          }
          // A network API named in a string is reached by key: `globalThis['fetch']`, Reflect.get.
          if (isLiteralArgument(n) && networkBans.has(n.text)) findings.push(`${at(n)} nombra ${n.text} en una cadena`);
          if (isLiteralArgument(n) && n.text === 'method') findings.push(`${at(n)} nombra method en una cadena`);
          if (!ts.isIdentifier(n)) return;

          // The global object only as `window.location`, never by key, cast or alias.
          if (globalObjects.has(n.text) && isIdentifierReference(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)) {
            findings.push(`${at(n)} toma ${n.text} entero: por clave, alias o conversión alcanza cualquier API de red`);
          }

          // `method` is written in exactly three places: GET in the table and the
          // init type, GET in buildGetRequest's init, POST in the sign-out call.
          // Any other spelling (shorthand, `init.method =`, a spread partner)
          // is a method the table was never checked for.
          if (n.text === 'method') {
            const p = n.parent;
            const assigned = ts.isPropertyAssignment(p) && p.name === n ? literalText(p.initializer) : undefined;
            const typed = ts.isPropertySignature(p) && p.name === n && p.type && ts.isLiteralTypeNode(p.type) ? literalText(p.type.literal) : undefined;
            const signOutCall = ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.parent) && ts.isCallExpression(p.parent.parent) ? p.parent.parent : undefined;
            const sanctioned =
              rel === contractFile
                ? assigned === 'GET' || typed === 'GET'
                : rel === clientFile &&
                  assigned === 'POST' &&
                  signOutCall !== undefined &&
                  ts.isIdentifier(signOutCall.expression) &&
                  signOutCall.expression.text === 'fetch' &&
                  signOutCall.arguments[0]?.getText(sf) === 'SIGN_OUT_PATH' &&
                  signOutCall.arguments[1] === p.parent;
            if (!sanctioned) findings.push(`${at(n)} escribe method fuera de los GET de contract.ts y del POST de cierre de sesión: ${p.getText(sf).slice(0, 60)}`);
          }

          if (!networkBans.has(n.text)) return;
          const call = n.parent;
          const direct = n.text === 'fetch' && rel === clientFile && isIdentifierReference(n) && ts.isCallExpression(call) && call.expression === n;
          if (!direct) {
            findings.push(n.text === 'fetch' ? `${at(n)} nombra fetch fuera de una llamada directa en api.ts` : `${at(n)} usa ${n.text}`);
            return;
          }
          const [target, init, ...rest] = call.arguments;
          const shape =
            rest.length === 0 && target?.getText(sf) === 'SIGN_OUT_PATH' && plainInit(init)
              ? 'SIGN_OUT_PATH, {…}'
              : call.arguments.map((a) => a.getText(sf)).join(', ');
          fetchCalls.push(shape);
        });
        if (rel === clientFile && !plainImportsFrom(sf, './contract.js').has('buildGetRequest')) {
          findings.push('api.ts ya no construye sus lecturas con buildGetRequest');
        }
      }
      if ([...fetchCalls].sort().join(' | ') !== 'SIGN_OUT_PATH, {…} | request.url, request.init') {
        findings.push(
          `api.ts llama a fetch como [${fetchCalls.join(' | ')}] en vez de una vez con (request.url, request.init) y otra con SIGN_OUT_PATH y un init escrito entero`
        );
      }

      if (findings.length > 0) {
        return falla(`el cliente web alcanza la API fuera de su contrato (${findings.join(' · ')})`);
      }
      return ok(
        `las ${table && ts.isObjectLiteralExpression(table.node) ? table.node.properties.length : 0} operaciones del cliente web son GET declarados en docs/openapi.json, y los ${app.length} módulos del navegador llegan a la red sólo por las dos llamadas de api.ts`
      );
    },
  },

  {
    paquete: 'E2.1',
    id: 'web-client-cannot-inject-markup',
    // W1 (#117). Entity names, draft descriptions and questions are written by
    // third parties and reach the page; with the session cookie behind the
    // proxy, one of them turned into script could read through /v1 as the
    // operator. So markup cannot happen by construction, and each layer is
    // read here:
    //   · the SPA policy in security-headers.ts has default-src 'none', only
    //     'self' for scripts, styles and fetches, no base, form or frame
    //     target, no object, and Trusted Types with no policy; no directive
    //     carries anything but one 'none' or 'self' source (so no unsafe-*,
    //     host, scheme, hash, nonce or wildcard, in a listed directive or an
    //     added one such as script-src-elem), and no directive name repeats (a
    //     browser keeps the first one). The API policy keeps default-src
    //     'none' and sandbox;
    //   · every served module (src/gateway/app and the two catalogs it
    //     imports, which ship as they are) names no HTML sink (innerHTML and
    //     its kin, setHTMLUnsafe, parseHTMLUnsafe, DOMParser…), no eval or
    //     Function, no string timer, no document.write, and creates no script,
    //     style or frame element; setAttribute appears only in dom.ts, right
    //     after its allow-list check, and that allow-list's free-text
    //     attributes are exactly class, id, scope, lang and role. A name counts
    //     written as an identifier or as a string, so `el['innerHTML']` is the
    //     same finding as `el.innerHTML`;
    //   · index.html has no inline script, no style element or attribute, no
    //     on* handler, no javascript: URL and no external URL.
    // Trusted Types is enforced only in Chromium-family browsers; this, the
    // eslint browser block and dom.ts are what hold everywhere else. A static
    // read sees names as written, not a name assembled at run time from
    // pieces; the CSP's script-src 'self' without unsafe-inline still keeps
    // injected markup from running inline script or handlers there.
    enunciado:
      'El cliente web no puede inyectar marcado: CSP estricta con Trusted Types, respuestas del API en sandbox y ningún sumidero de HTML en el código que se sirve',
    mutantes: [
      {
        archivo: 'src/gateway/security-headers.ts',
        de: `  "script-src 'self'",`,
        a: `  "script-src 'self' 'unsafe-inline'",`,
        porque: 'one reflected string would become script that drives the proxy with the session',
      },
      {
        archivo: 'src/gateway/security-headers.ts',
        de: `  "require-trusted-types-for 'script'",`,
        a: `  "img-src 'self'",`,
        porque: 'HTML sinks would stop throwing, and textContent would be a convention again',
      },
      {
        archivo: 'src/gateway/app/dom.ts',
        de: 'node.textContent = child;',
        a: 'node.innerHTML = child;',
        porque: 'entity names, draft descriptions and questions are third-party strings',
      },
      {
        archivo: 'src/gateway/public/index.html',
        de: '<script type="module" src="/modules/gateway/app/main.js"></script>',
        a: '<script>window.booted = true</script><script type="module" src="/modules/gateway/app/main.js"></script>',
        porque: 'an inline script forces the CSP to be loosened',
      },
      {
        archivo: 'src/i18n/en.ts',
        de: '} as const;',
        a: '} as const;\nexport const renderNote = (target: { innerHTML: string }, note: string): void => {\n  target.innerHTML = note;\n};',
        porque: 'the catalogs ship to the page as modules, so a sink written there is served code too',
      },
      {
        archivo: 'src/gateway/app/dom.ts',
        de: "const TEXT_ATTRIBUTES: ReadonlySet<string> = new Set(['class', 'id', 'scope', 'lang', 'role']);",
        a: "const TEXT_ATTRIBUTES: ReadonlySet<string> = new Set(['class', 'id', 'scope', 'lang', 'role', 'onclick']);",
        porque: 'an event-handler attribute taken from the view tree is script waiting for a string',
      },
      {
        archivo: 'src/gateway/app/dom.ts',
        de: '    if (!isAllowedAttribute(name, value)) throw new RejectedAttribute(name);',
        a: '    void RejectedAttribute;',
        porque: 'with the check gone every attribute name a spec carries is set, style and on* included',
      },
      {
        archivo: 'src/gateway/app/dom.ts',
        de: "  if (name === 'href') return SAFE_HREF.test(value) || value === SIGN_IN_PATH;",
        a: "  if (name === 'href') return true;",
        porque: 'a javascript: URL in a link is script one click away, and the CSP does not stop a navigation',
      },
      {
        archivo: 'src/gateway/app/main.ts',
        de: "if (skipLink) skipLink.textContent = text(language, 'web.app.skip_to_content');",
        a: "if (skipLink) skipLink.insertAdjacentHTML('beforeend', text(language, 'web.app.skip_to_content'));",
        porque: 'catalog text parsed as markup outside dom.ts is a sink the view tree never sees',
      },
      {
        archivo: 'src/gateway/security-headers.ts',
        de: `  "connect-src 'self'",`,
        a: `  "connect-src 'self' https:",`,
        porque: 'an injected script could send what it read to any https host',
      },
      {
        archivo: 'src/gateway/security-headers.ts',
        de: `  "trusted-types 'none'",`,
        a: `  "trusted-types 'none'",\n  "script-src-elem 'self' cdn.jsdelivr.net",`,
        porque: 'script-src-elem overrides script-src for script elements, so a bare host source loads script from a third party',
      },
      {
        archivo: 'src/gateway/app/main.ts',
        de: "if (skipLink) skipLink.textContent = text(language, 'web.app.skip_to_content');",
        a: "if (skipLink) skipLink.setHTMLUnsafe(text(language, 'web.app.skip_to_content'));",
        porque: 'setHTMLUnsafe parses its string as markup like innerHTML does, under a name the old list did not have',
      },
      {
        archivo: 'src/gateway/app/main.ts',
        de: "if (skipLink) skipLink.textContent = text(language, 'web.app.skip_to_content');",
        a: "if (skipLink) skipLink['innerHTML'] = text(language, 'web.app.skip_to_content');",
        porque: 'a sink written as a string key is the same sink, and the name is a literal, not an identifier',
      },
      {
        archivo: 'src/gateway/app/dom.ts',
        de: 'node.textContent = child;',
        a: "node['setAttribute']('onclick', child);",
        porque: 'setAttribute called through a string key skips the allow-list check the dotted call is held to',
      },
    ],
    evaluar: () => {
      const findings: string[] = [];

      // The policies.
      const headersFile = 'src/gateway/security-headers.ts';
      const headers = gatewaySyntaxOf(headersFile);
      const spa = headers ? joinedPolicy(headers, 'SPA_CONTENT_SECURITY_POLICY') : undefined;
      const api = headers ? joinedPolicy(headers, 'API_CONTENT_SECURITY_POLICY') : undefined;
      if (!spa) {
        findings.push('SPA_CONTENT_SECURITY_POLICY ya no es un arreglo literal de directivas unido con "; "');
      } else {
        const required = [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self'",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "object-src 'none'",
          "require-trusted-types-for 'script'",
          "trusted-types 'none'",
        ];
        for (const directive of required) if (!spa.includes(directive)) findings.push(`la CSP del SPA perdió ${directive}`);
        const seen = new Set<string>();
        for (const directive of spa) {
          // Every directive, listed or not, carries one source and it is 'none'
          // or 'self': a host, a scheme, a hash, a nonce or a keyword added to
          // any of them (script-src-elem overrides script-src) loosens the page.
          const [rawName, ...sources] = directive.trim().split(/\s+/);
          const name = rawName.toLowerCase();
          const allowed = name === 'require-trusted-types-for' ? ["'script'"] : ["'none'", "'self'"];
          if (sources.length !== 1 || !allowed.includes(sources[0])) {
            findings.push(`la CSP del SPA afloja ${directive}: cada directiva lleva una sola fuente, 'none' o 'self'`);
          }
          if (seen.has(name)) findings.push(`la CSP del SPA repite ${name}`);
          seen.add(name);
        }
      }
      if (!api || !api.includes('sandbox') || !api.includes("default-src 'none'")) {
        findings.push("la CSP de las respuestas del API ya no tiene default-src 'none' y sandbox");
      }

      // The served modules.
      const { app } = gatewayFiles();
      if (app.length === 0) findings.push('src/gateway/app no tiene módulos: no hay nada que mirar, y no mirar no es estar limpio');
      const domFile = 'src/gateway/app/dom.ts';
      const served = [...app, 'src/i18n/en.ts', 'src/i18n/es.ts'];
      const sinkNames = new Set([
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'srcdoc',
        'createContextualFragment',
        'DOMParser',
        'parseFromString',
        'setHTMLUnsafe',
        'parseHTMLUnsafe',
        'setHTML',
      ]);
      const codeNames = new Set(['eval', 'Function']);
      // Names that, written as a string, reach a sink or a guarded call by key:
      // `el['innerHTML']`, `globalThis['eval']`, `node['setAttribute']`.
      const keyedNames = new Set([
        ...sinkNames,
        ...codeNames,
        'write',
        'writeln',
        'setAttribute',
        'setAttributeNS',
        'setAttributeNode',
        'createElement',
        'setTimeout',
        'setInterval',
      ]);
      const markupElements = /^(?:script|style|iframe|frame|object|embed|link|base|template)$/i;
      for (const rel of served) {
        const sf = gatewaySyntaxOf(rel);
        if (!sf) {
          findings.push(`desapareció ${rel}, que se sirve a la página`);
          continue;
        }
        const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
        forEachGatewayNode(sf, (n) => {
          if (isLiteralArgument(n) && keyedNames.has(n.text)) {
            findings.push(`${at(n)} nombra ${n.text} en una cadena`);
            return;
          }
          if (ts.isIdentifier(n)) {
            if (sinkNames.has(n.text)) findings.push(`${at(n)} usa ${n.text}`);
            if (codeNames.has(n.text) && isIdentifierReference(n)) findings.push(`${at(n)} usa ${n.text}`);
            if (/^write(?:ln)?$/.test(n.text) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) {
              findings.push(`${at(n)} escribe con ${n.parent.getText(sf)}`);
            }
            return;
          }
          if (!ts.isCallExpression(n)) return;
          const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : '';
          const first = n.arguments[0];
          if ((callee === 'setTimeout' || callee === 'setInterval') && first !== undefined && literalText(first) !== undefined) {
            findings.push(`${at(n)} pasa una cadena a ${callee}`);
          }
          if (callee === 'createElement') {
            // dom.ts creates by the spec's tag, which ALLOWED_TAGS checks below;
            // anywhere else the tag must be a literal, and never a markup element.
            const tag = first === undefined ? undefined : literalText(first);
            if (tag === undefined ? rel !== domFile : markupElements.test(tag)) {
              findings.push(`${at(n)} crea un elemento ${first?.getText(sf) ?? ''}`);
            }
          }
          if (/^(?:setAttribute|setAttributeNS|setAttributeNode)$/.test(callee)) {
            const guarded =
              rel === domFile &&
              callee === 'setAttribute' &&
              ts.isBlock(n.parent.parent) &&
              sameStatements(
                n.parent.parent.statements,
                sf,
                'if (!isAllowedAttribute(name, value)) throw new RejectedAttribute(name);\nnode.setAttribute(name, value);'
              );
            if (!guarded) findings.push(`${at(n)} fija un atributo fuera de la lista permitida de dom.ts: ${n.getText(sf).slice(0, 60)}`);
          }
        });
      }

      // dom.ts's allow-lists: free text only where free text cannot load, run
      // or style; an href only to an in-page route or the sign-in route; no
      // element that parses or loads.
      const dom = gatewaySyntaxOf(domFile);
      const setOf = (name: string): string[] | undefined => {
        const init = dom ? topLevelInitializer(dom, name) : undefined;
        return init && ts.isNewExpression(init.node) && init.node.arguments?.length === 1 ? stringElements(init.node.arguments[0]) : undefined;
      };
      const listed = setOf('TEXT_ATTRIBUTES');
      if (!listed || [...listed].sort().join(',') !== 'class,id,lang,role,scope') {
        findings.push(`los atributos de texto libre de dom.ts son [${(listed ?? []).join(', ')}] en vez de class, id, lang, role y scope`);
      }
      const tags = setOf('ALLOWED_TAGS');
      if (!tags || tags.length === 0 || tags.some((tag) => markupElements.test(tag))) {
        findings.push(`las etiquetas permitidas de dom.ts son [${(tags ?? []).join(', ')}]`);
      }
      const safeHref = dom ? topLevelInitializer(dom, 'SAFE_HREF') : undefined;
      if (!safeHref || !ts.isRegularExpressionLiteral(safeHref.node) || safeHref.node.text !== '/^#\\/[A-Za-z0-9/_-]*$/') {
        findings.push('SAFE_HREF de dom.ts ya no es una ruta interna #/…');
      }
      const allowed = dom ? soleFunction(dom, 'isAllowedAttribute') : undefined;
      if (
        !dom ||
        !sameStatements(
          allowed?.body?.statements,
          dom,
          [
            'if (TEXT_ATTRIBUTES.has(name)) return true;',
            "if (name === 'href') return SAFE_HREF.test(value) || value === SIGN_IN_PATH;",
            "if (name === 'type') return value === 'button';",
            "if (name === 'tabindex') return value === '0' || value === '-1';",
            'return /^aria-[a-z]+$/.test(name);',
          ].join('\n')
        )
      ) {
        findings.push('isAllowedAttribute de dom.ts ya no es exactamente: texto libre, href interno o de inicio de sesión, type button, tabindex 0 o -1, y aria-*');
      }

      // The shell.
      const shellFile = 'src/gateway/public/index.html';
      if (!existe(shellFile)) {
        findings.push(`desapareció ${shellFile}`);
      } else {
        const html = crudoDe(shellFile);
        // El cierre admite espacios y basura antes del '>': `</script\nfoo>`
        // cierra igual, y un filtro que sólo conoce `</script>` lee lo que sigue
        // como texto (CodeQL js/bad-tag-filter).
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
        if (scripts.length === 0) findings.push('index.html no carga ningún módulo');
        for (const [, attributes, body] of scripts) {
          if (!/\ssrc\s*=/i.test(attributes) || body.trim() !== '') findings.push('index.html tiene un script en línea');
        }
        if ((html.match(/<script\b/gi) ?? []).length !== scripts.length) findings.push('index.html tiene un script sin cerrar');
        if (/<style\b/i.test(html)) findings.push('index.html tiene un elemento style');
        if (/\sstyle\s*=/i.test(html)) findings.push('index.html tiene un atributo style');
        if (/\son[a-z]+\s*=/i.test(html)) findings.push('index.html tiene un manejador on*');
        if (/javascript:/i.test(html)) findings.push('index.html tiene una URL javascript:');
        if (/(?:https?:)?\/\/[a-z0-9]/i.test(html)) findings.push('index.html carga algo de otro origen');
        if (/<(?:iframe|object|embed|base)\b/i.test(html)) findings.push('index.html tiene un marco, un objeto o un base');
      }

      if (findings.length > 0) {
        return falla(`el cliente web puede convertir una cadena en marcado o en código (${findings.join(' · ')})`);
      }
      return ok(
        `la CSP del SPA es 'self' sin unsafe-* y con Trusted Types, las respuestas del API van en sandbox, y ${served.length} módulos servidos y index.html no tienen un solo sumidero de HTML`
      );
    },
  },
];
