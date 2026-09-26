import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  codigoDe,
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
  scanWriteRoutes,
  sinComentarios,
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
];
