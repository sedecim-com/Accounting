import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  codigoDe,
  consumidoresDe,
  type Criterio,
  crudoDe,
  dondeAparece,
  existe,
  falla,
  flagsAsSpanish,
  fuentes,
  leer,
  noEvaluable,
  ok,
  readAccountRoleValues,
  readLexicon,
  readSchemaVocabularies,
  readVocabularyRegistry,
  rutaDe,
  sinProsa,
} from './shared.js';

// ============================================================
// THE E0.2 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E0_2: Criterio[] = [

  // ---- E0.1 · Red de pruebas ----
  {
    paquete: 'E0.2',
    id: 'dead-tables-dropped-or-claimed',
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
        inventory_items: 'familia inventario: el esquema es el diseñado; el motor es neto nuevo (S0.4)',
        inventory_layers: 'familia inventario: capas de costeo',
        inventory_layer_consumption: 'familia inventario: consumo de capas',
        scheduled_payments: 'F04: la programación de pagos retirada con 501 escribe aquí cuando exista',
      };
      const dirMigraciones = 'src/database/migrations';
      const sql = fs
        .readdirSync(rutaDe(dirMigraciones))
        .map((m) => crudoDe(dirMigraciones, m))
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
    id: 'migration-apply-and-record-atomic',
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
    paquete: 'E0.2',
    id: 'migration-fails-loud-under-rls',
    enunciado: 'Una migración de datos que olvide la RLS truena en vez de correr filtrada',
    mutantes: [
      {
        archivo: 'src/database/migrate.ts',
        de: "await client.query('SET row_security = off');",
        a: "await client.query('SET row_security = on');",
        porque: 'apagar el piso es exactamente la regresión que costó cuatro siembras silenciosas',
      },
    ],
    evaluar: () => {
      // Tres veces una siembra corrió como dueño bajo FORCE RLS sin GUC de
      // inquilino y leyó cero filas «con éxito»: la 025 (confesada por la
      // 026), la 043 (colisión de folio, 2026-08-31) y con ellas la 037 y la
      // 040 — la purga de secretos que no purgó. El remedio no es acordarse:
      // el corredor pone row_security=off y Postgres LANZA 42501 donde antes
      // filtraba en silencio (el mismo default de pg_dump). Prescriptivo
      // sobre el instrumento, que es cuando un criterio nombra el archivo.
      const s = codigoDe('src/database/migrate.ts');
      const piso = s.indexOf("SET row_security = off");
      if (piso < 0) {
        return falla('migrate.ts ya no apaga row_security: la siguiente siembra olvidada volverá a leer cero filas en silencio');
      }
      const bucle = s.indexOf('for (const file of files)');
      if (bucle >= 0 && piso > bucle) {
        return falla('el piso row_security=off se pone DESPUÉS de correr los archivos: las migraciones corren sin él');
      }
      // Y el patrón santo sigue siendo transitable: toda migración que itera
      // inquilinos con el GUC debe declarar el opt-in, porque contra el piso
      // un bucle sin declaración muere con 42501 en el primer catch-up de
      // una base rezagada — una regresión que sólo muerde en el campo.
      const dir = rutaDe('src', 'database', 'migrations');
      const sinOptIn = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => {
          // Por el seam (crudoDe), no por fs directo: una lectura que rodea
          // el seam es un criterio que ningún espejo puede mutar — y el
          // criterio E0.0 del arnés cuenta esas lecturas y las acusa.
          const sql = crudoDe('src/database/migrations', f);
          return sql.includes("set_config('app.current_tenant'")
            && !/SET LOCAL row_security = on/.test(sql);
        });
      return sinOptIn.length === 0
        ? ok('el corredor convierte el filtrado silencioso en 42501 y las siembras por inquilino declaran su opt-in')
        : falla(`bucle por inquilino sin «SET LOCAL row_security = on» — contra el piso mueren en el catch-up: ${sinOptIn.join(', ')}`);
    },
  },

  {
    paquete: 'E0.2',
    id: 'matview-migration-survives-rls-floor',
    enunciado: 'Toda migración que recree una vista materializada declara cómo sobrevive al piso de RLS',
    mutantes: [
      {
        archivo: 'src/database/migrations/071_las_vistas_que_perdian_la_archivada.sql',
        de: "EXECUTE 'SET LOCAL ROLE mnemosine_refresher';",
        a: "RAISE NOTICE 'sin cambiar de rol';",
        porque:
          'EL DEFECTO MEDIDO: sin el traje del refrescador, `CREATE MATERIALIZED VIEW ... AS SELECT ... FROM accounts` muere con 42501 contra el piso `row_security = off` y la actualización de TODO despacho instalado se detiene ahí — en instalación nueva no se nota, porque las políticas aún no existen cuando corre',
      },
    ],
    evaluar: () => {
      // LA MINA QUE ESTE CRITERIO CIERRA, Y POR QUÉ EL DE ARRIBA NO LA VIO.
      // El criterio anterior sólo inspecciona migraciones que iteran
      // inquilinos con `set_config('app.current_tenant')`. La 071 no menciona
      // ninguna: crea dos vistas materializadas leyendo `accounts`, y bajo el
      // piso `row_security = off` eso no filtra en silencio, LANZA 42501. Pasó
      // por debajo del instrumento y llegó a main, donde bloqueaba la
      // actualización de cualquier instalación viva. Medido como
      // `mnemosine_owner` con las políticas puestas.
      //
      // Una instalación NUEVA nunca lo veía —rls-policies.sql corre en el
      // `finally`, después—, que es justo por lo que CI tampoco: su base nace
      // sin políticas. El criterio mira el texto porque la conducta sólo
      // aparece con un rol no superusuario y una base ya endurecida.
      const dir = rutaDe('src', 'database', 'migrations');
      const sinDeclarar = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => {
          const sql = sinProsa(crudoDe('src/database/migrations', f));
          if (!/CREATE\s+MATERIALIZED\s+VIEW/i.test(sql)) return false;
          // Tres formas legítimas de sobrevivir al piso, y ninguna es
          // desarmar la RLS: vestirse del rol que la ignora por contrato,
          // no poblar la vista al crearla, o correr antes de que exista
          // política alguna — que es el caso de las migraciones tempranas,
          // donde las tablas que la vista lee todavía no están acotadas.
          const declara = /SET LOCAL ROLE mnemosine_refresher/.test(sql)
            || /WITH NO DATA/i.test(sql)
            || Number(f.slice(0, 3)) < 20;
          return !declara;
        });
      if (sinDeclarar.length === 0 && !existe('tests/integration/migracion-071-actualizacion-bajo-rls.int.spec.ts')) {
        // LA MITAD DINÁMICA, Y NO ES ADORNO (WIT-03). Lo de arriba es
        // PRESENCIA de texto: da verde con el archivo escrito y jamás
        // ejecutado en el estado que lo rompía. La prueba monta las tres cosas
        // que hacen falta para que el defecto exista —rol NOBYPASSRLS que es
        // DUEÑO, políticas con su FORCE, y el piso `row_security = off`— y
        // cae al neutralizar el `SET LOCAL ROLE`, el `RESET ROLE` o la
        // devolución del ACL. Sin ella, una regresión en ese baile bloquearía
        // toda actualización instalada y CI seguiría en verde.
        return falla('no hay prueba que EJECUTE la 071 sobre una base endurecida: leer el archivo no demuestra que la actualización sobreviva');
      }
      return sinDeclarar.length === 0
        ? ok('ninguna migración puebla una vista materializada sin decir cómo esquiva el 42501 del piso, y hay prueba que lo ejecuta bajo FORCE RLS')
        : falla(`vista materializada creada sin declarar cómo sobrevive a «row_security = off»: ${sinDeclarar.join(', ')} — muere con 42501 en toda base ya endurecida, y en instalación nueva no se nota`);
    },
  },

  {
    paquete: 'E0.2',
    id: 'distributed-migration-repaired-by-new-file',
    enunciado: 'La reparación de una migración ya distribuida llega por archivo nuevo, y repone el sello que arranca',
    mutantes: [
      {
        archivo: 'src/database/migrations/072_la_huella_que_se_podia_forjar.sql',
        de: 'ALTER TABLE bank_transactions ENABLE ALWAYS TRIGGER bank_transactions_content_hash;',
        a: '-- sin reponer el ENABLE ALWAYS',
        porque:
          'la trampa medida: recrear el disparador se lleva por delante el `ENABLE ALWAYS` de la 058, y el remedio dejaría el sello «garantia-sellada» colgado de un disparador que vuelve a poder apagarse con session_replication_role',
      },
      {
        archivo: 'src/database/migrations/072_la_huella_que_se_podia_forjar.sql',
        de: 'DROP INDEX IF EXISTS uq_bank_tx_contenido;',
        a: '-- el índice único se queda',
        porque:
          'el remedio deja de reparar lo que cuesta dinero: con el índice ÚNICO, la segunda comisión legítima del mismo día no entra y el sistema la reporta como duplicada, acusando al banco',
      },
      {
        archivo: 'src/database/migrations/072_la_huella_que_se_podia_forjar.sql',
        de: 'DO $huellas$',
        a: null,
        porque:
          'si el remedio desaparece, la instalación que registró la 051 vieja se queda para siempre con la huella forjable: el criterio debe dar ROJO, no reventar leyendo un archivo que ya no está',
      },
    ],
    evaluar: () => {
      // WIT-01 CRÍTICO DE #136. T1 reparó la 051 EDITÁNDOLA EN SU SITIO, y el
      // corredor omite por NOMBRE sin checksum: donde la vieja quedó
      // registrada —toda instalación cuyo `bank_transactions` estaba vacío—,
      // la reparada no corre jamás. El remedio sólo puede llegar por archivo
      // nuevo, y este criterio vigila que ese archivo siga existiendo y siga
      // haciendo las cuatro cosas que tiene que hacer.
      const remedio = 'src/database/migrations/072_la_huella_que_se_podia_forjar.sql';
      if (!existe(remedio)) {
        return falla('desapareció el remedio de la 051: la instalación que registró la vieja se queda con la huella forjable y el índice que se traga movimientos legítimos (#136)');
      }
      const sql = sinProsa(crudoDe(remedio));

      // 1. EL ÍNDICE, en el orden que no rompe: soltar el único ANTES de crear
      //    el llano. Al revés fallaría con 23505 justo donde hace falta.
      if (!/DROP INDEX IF EXISTS uq_bank_tx_contenido/.test(sql)
          || !/CREATE INDEX IF NOT EXISTS idx_bank_tx_contenido/.test(sql)) {
        return falla('el remedio dejó de sustituir el índice único: dos movimientos bancarios legítimamente idénticos siguen siendo irrepresentables');
      }

      // 2. EL DISPARADOR, Y NUNCA CON «CREATE OR REPLACE». Medido: esa forma
      //    degrada `tgenabled` de 'A' a 'O' EN SILENCIO y conserva el
      //    comentario — deja el sello sobre un disparador que ya se puede
      //    apagar, que es peor que no tenerlo.
      if (/CREATE\s+OR\s+REPLACE\s+TRIGGER/i.test(sql)) {
        return falla('el remedio usa CREATE OR REPLACE TRIGGER: degrada el ENABLE ALWAYS de la 058 en silencio y deja la garantía sellada sobre un disparador apagable');
      }
      if (!/ENABLE ALWAYS TRIGGER bank_transactions_content_hash/.test(sql)
          || !/COMMENT ON TRIGGER bank_transactions_content_hash/.test(sql)) {
        return falla('el remedio recrea el disparador sin reponer el sello de la 058: doctor dejaría de contar una garantía que nadie repuso');
      }

      // 3. Y SI TOCA DATOS, CON EL OPT-IN DECLARADO. El corredor corre con
      //    `row_security = off`: un UPDATE pelado sobre una tabla acotada
      //    muere con 42501 y revierte el archivo entero.
      if (/UPDATE bank_transactions/.test(sql)
          && !(/SET LOCAL row_security = on/.test(sql) && /set_config\('app\.current_tenant'/.test(sql))) {
        return falla('el remedio escribe en una tabla acotada sin declarar su opt-in ni recorrer inquilinos: moriría con 42501 en la primera base endurecida');
      }

      // 4. Y SE PRUEBA EJECUTÁNDOLO. Un remedio de migración que sólo se lee
      //    es la misma clase de falso verde que este tramo vino a cerrar.
      return existe('tests/integration/migracion-072-remedio-051.int.spec.ts')
        ? ok('el remedio llega por archivo nuevo, sustituye el índice, recrea el disparador reponiendo el sello de la 058, declara su opt-in y se prueba corriéndolo')
        : falla('el remedio no tiene prueba que lo EJECUTE sobre una base que traiga la 051 vieja: leerlo no demuestra que repare');
    },
  },

  {
    paquete: 'E0.2',
    id: 'one-comment-stripper-for-every-instrument',
    // El tablero aprendió esto a base de SIETE rojos falsos, y lo dejó escrito
    // en `sinComentarios`: un ejemplo de ayuda con el glob `./cfdi/julio/*.xml`
    // lleva un `/*` dentro de una CADENA, y las dos regex ingenuas lo tomaban
    // por comentario de bloque. Lo que se comían no era prosa: era código.
    //
    // El detector de código muerto conservaba su propia copia de esas regex, y
    // por eso acusaba a `describeLastOption` —llamada en mnemosine.ts dentro de
    // las 171 líneas que el falso comentario engullía— de «exportada y no
    // referenciada en ninguna parte». Medido con el escáner viejo contra el
    // nuevo, se equivocaba en las DOS direcciones a la vez:
    // `expected ['describeLastOption'] to deeply equal ['main']`.
    //
    // Un detector de código muerto que acusa en falso no es ruido: lo que
    // propone es BORRAR CÓDIGO VIVO. Por eso el criterio no comprueba que el
    // limpiador esté bien, sino que sólo haya UNO — mientras hubo dos, arreglar
    // el del tablero dejó al del doctor mintiendo y nada se puso rojo.
    enunciado: 'Ningún instrumento se ciega con un glob dentro de una cadena',
    mutantes: [
      {
        archivo: 'src/utils/strip-comments.ts',
        de: 'if (c === 0x27 || c === 0x22 || c === 0x60) {',
        a: 'if (false) {',
        porque: 'el limpiador deja de saltarse las cadenas: un glob vuelve a abrir un comentario y el instrumento analiza un archivo mutilado',
      },
      {
        archivo: 'src/ai/orphan-scan.ts',
        de: "import { stripComments } from '../utils/strip-comments.js';",
        a: "const stripComments = (t: string): string => t.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');",
        porque: 'el detector de código muerto vuelve a tener su copia propia de la regex ingenua, que es como nació la acusación falsa',
      },
      {
        archivo: 'tests/ai/orphan-scan.spec.ts',
        de: "const ayuda = 'mnemosine ingest ./cfdi/julio/*.xml --auto-post';",
        a: "const ayuda = 'mnemosine ingest ./cfdi/julio/todo.xml --auto-post';",
        porque: 'la reproducción deja de llevar el glob: sin el `/*` dentro de la cadena, la prueba pasa con la regex ingenua puesta',
      },
    ],
    evaluar: () => {
      const shared = 'src/utils/strip-comments.ts';
      const scanner = 'src/ai/orphan-scan.ts';
      const spec = 'tests/ai/orphan-scan.spec.ts';
      if (!existe(shared)) return falla(`desapareció ${shared}: el limpiador compartido es lo único que impide que cada instrumento vuelva a tener el suyo`);

      // 1. EL CENSO. Nadie más define un limpiador de comentarios de TypeScript.
      //    Se busca la regex ingenua, que es la forma que falla.
      const INGENUA = /replace\(\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\/\/g/;
      const culpables: string[] = [];
      for (const f of fuentes('src')) {
        const rel = path.relative(rutaDe(), f);
        if (rel === shared) continue;
        const code = leer(f);
        // El SQL es otro idioma y lleva su propio `--`: ésos no cuentan aquí.
        if (INGENUA.test(code) && !/--\[\^\\n\]\*/.test(code)) culpables.push(rel);
      }
      if (culpables.length > 0) {
        return falla(
          `${culpables.length} instrumento(s) volvieron a llevar su propia regex de comentarios (${culpables.join(', ')}): ` +
            'un `/*` dentro de una cadena les borra el código que sigue, y lo que informen después será sobre un archivo mutilado'
        );
      }

      // 2. LOS DOS INSTRUMENTOS BEBEN DE LA MISMA FUENTE.
      if (!codigoDe(scanner).includes("import { stripComments } from '../utils/strip-comments.js';")) {
        return falla('el detector de código muerto dejó de usar el limpiador compartido: vuelve a poder acusar a código vivo');
      }
      // Y el limpiador sigue saltándose las cadenas, que es lo único que hace.
      if (!codigoDe(shared).includes('if (c === 0x27 || c === 0x22 || c === 0x60) {')) {
        return falla('el limpiador dejó de saltarse las cadenas: un glob vuelve a abrir un comentario de bloque');
      }

      // 3. Y CONDUCTA: la reproducción lleva el glob de verdad. Sin él, la
      //    prueba pasa con la regex ingenua puesta y no mide nada.
      if (!existe(spec)) return falla('no hay reproducción del glob que cegaba al detector');
      // Se lee el CÓDIGO y no el crudo: el comentario de la propia prueba cita
      // el glob, y un ancla que su archivo repite desarma su propio espejo.
      const t = codigoDe(spec);
      if (!/julio\/\*\.xml/.test(t)) {
        return falla('la reproducción perdió el glob dentro de la cadena: es lo único que distingue al limpiador bueno del ingenuo');
      }

      return ok(
        'un solo limpiador de comentarios en el árbol, y lo usan el tablero y el detector de código muerto; se salta las cadenas, y la reproducción lleva el glob que cegaba al viejo'
      );
    },
  },

  {
    paquete: 'E0.2',
    id: 'orphan-export-baseline-only-shrinks',
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
      // olvidarlos imposible. Destinos: calculateBenefitsForPaycheck → F08;
      // checkSoDViolations → decisión §5 (maker-checker);
      // autoApproveDraftByPolicy → A3 (un solo autorizador).
      //
      // PAGADO EN F04: earlyPaymentDiscount. Llevaba sin llamador desde que se
      // retiró el programador de pagos que lo usaba, mientras el descuento por
      // pronto pago se aceptaba a ojo en el otro extremo del sistema. Ahora es
      // quien decide cuánto descuento CONCEDEN las condiciones del gasto, y
      // tomar más que eso se rechaza señalando `--mode residual`. Su línea se
      // borra aquí, que es el registro de que la deuda se pagó.
      const HUERFANOS_CONGELADOS: Record<string, string> = {
        // El gemelo del que pagó en A3: mismo motor (matchApproval), brazo
        // external_op. Su consumidor llega con el ejecutor DESATENDIDO del
        // outbox (hoy `outbox run` es humano y no necesita política).
        autoExecuteOpByPolicy: 'external-service.ts',
        calculateBenefitsForPaycheck: 'benefits-service.ts',
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
    id: 'sql-scanner-resolves-alias-columns',
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
    id: 'entities-table-never-queried',
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
    id: 'code-enums-match-check-constraints',
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
        const sql = crudoDe(dir, f).replace(/--[^\n]*/g, '');
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
        //
        // Y `ADD (CONSTRAINT|COLUMN)`, no sólo CONSTRAINT: un vocabulario
        // puede nacer con su columna en el mismo ALTER —
        // `ADD COLUMN account_type VARCHAR(20) ... CHECK (account_type IN (...))`—
        // y ésa es la tercera forma de declarar un CHECK que este criterio no
        // leía. El síntoma era el contrario del defecto: la 051 censó
        // `bank_accounts.account_type` correctamente y el criterio la acusó de
        // «vocabulario declarado sin decir de qué columna es», porque su
        // columna no existía en el esquema QUE ÉL SABE LEER. Un criterio que
        // no reconoce una sintaxis válida no protege menos: acusa en falso.
        for (const a of sql.matchAll(
          /ALTER\s+TABLE\s+(?:ONLY\s+)?([\w.]+)[^;]*?ADD\s+(?:CONSTRAINT|COLUMN)[^;]*?CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)/gi
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
  {
    paquete: 'E0.2',
    // EL MAPA DEL RENOMBRADO, EXIGIDO COMPLETO (I4 · issue #146).
    //
    // El criterio de arriba pregunta si el vocabulario del CÓDIGO coincide con
    // el CHECK. Éste pregunta otra cosa, y por eso vive aparte en vez de
    // sustituirlo: si cada término español que este sistema PERSISTE tiene ya
    // decidido su nombre inglés, o escrita la razón de no tenerlo.
    //
    // Sin esta lista, I23–I25 renombran a ciegas: cada tramo elige el nombre
    // de su clase cuando le toca, y el mismo concepto acaba con dos
    // traducciones en dos tablas. Eso ya no se arregla renombrando; se
    // arregla con otro renombrado, sobre datos de despachos reales.
    //
    // NO SE ANCLA A NINGUNA CIFRA. Cuenta lo que encuentra hoy y exige que el
    // registro lo cubra: una migración nueva con un valor español entra en la
    // cuenta sola, sin que nadie actualice un número aquí.
    enunciado:
      'Todo literal español de un CHECK y todo value de AccountRole está en el registro del vocabulario',
    evaluar: () => {
      const reg = readVocabularyRegistry();
      if (reg === null) {
        return falla('no existe src/language/vocabulary-registry.json: el renombrado de I23–I25 no tiene mapa');
      }
      if (reg.problems.length) {
        return falla(
          `el registro tiene ${reg.problems.length} entrada(s) inválida(s): ` +
            reg.problems.slice(0, 3).join(' · ')
        );
      }

      // EL DETECTOR DE ESPAÑOL ES EL DE I1, NO UNO NUEVO. Se lee su léxico de
      // datos —scripts/language/lexicon.json— y se aplica su misma regla:
      // `isFlagged` devuelve verdadero cuando ALGÚN token es raíz española y
      // no es término de dominio, porque esos son exactamente los casos «es»
      // y «mixed». Que las dos implementaciones coincidan no se supone: lo
      // prueba tests/language/vocabulary-registry.spec.ts sobre las 200
      // declaraciones etiquetadas a mano y sobre todos los valores de CHECK.
      const lexicon = readLexicon();
      if (lexicon === null) {
        return noEvaluable('no se pudo leer scripts/language/lexicon.json: sin léxico no hay veredicto de idioma');
      }
      if (lexicon.roots.size < 1000) {
        return noEvaluable(`el léxico trae ${lexicon.roots.size} raíces: no tiene la forma que este criterio sabe leer`);
      }

      const inSchema = readSchemaVocabularies();
      if (inSchema.size < 20) {
        return noEvaluable(
          `sólo se leyeron ${inSchema.size} CHECK de vocabulario: ya no tienen la forma que este criterio sabe leer`
        );
      }

      const missing: string[] = [];
      let spanish = 0;
      for (const [key, values] of inSchema) {
        for (const v of values) {
          if (!flagsAsSpanish(v, lexicon)) continue;
          spanish++;
          if (!reg.has('check-value', key, v)) missing.push(`${key} = '${v}'`);
        }
      }

      // AccountRole no tiene CHECK —sus 36 valores viven en una unión de
      // TypeScript y en filas sembradas—, así que se lee del fuente. Es la
      // población que el issue nombra aparte por eso mismo: es la única clase
      // grande que la base no protege.
      const roleValues = readAccountRoleValues();
      if (roleValues.length < 20) {
        return noEvaluable(
          `sólo se leyeron ${roleValues.length} values de AccountRole en cfdi-taxonomy.ts: cambió de forma`
        );
      }
      const missingRoles = roleValues.filter((r) => !reg.has('account-role', 'account_roles.role', r));

      if (missing.length || missingRoles.length) {
        const parts: string[] = [];
        if (missing.length) {
          parts.push(
            `${missing.length} literal(es) español(es) de CHECK sin entrada en el registro ` +
              `(${missing.slice(0, 3).join(', ')}): I23–I25 los renombrarían sin mapa`
          );
        }
        if (missingRoles.length) {
          parts.push(
            `${missingRoles.length} value(es) de AccountRole sin registrar ` +
              `(${missingRoles.slice(0, 3).join(', ')}): son roleValues que 26 archivos leen y la base no protege`
          );
        }
        return falla(parts.join(' · '));
      }

      return ok(
        `${reg.total} entries registradas cubren los ${spanish} literals españoles de ` +
          `${inSchema.size} CHECK y los ${roleValues.length} values de AccountRole; ` +
          `${reg.kept} de ellas no se renombran y todas dicen por qué`
      );
    },
    // LOS DOS ESPEJOS QUE LA ISSUE #146 PIDE: «borrar una fila del registro →
    // rojo». Se borra corrompiendo la LLAVE de la fila y no el bloque entero,
    // por dos razones que importan:
    //
    //   · El JSON sigue siendo válido, así que el criterio falla por FALTA DE
    //     COBERTURA y no por «no es JSON válido». Un espejo que mata por el
    //     motivo equivocado no prueba lo que dice probar.
    //   · La entrada sigue bien formada, así que tampoco muere por
    //     `problemsIn`. Lo único que cambia es que el término deja de estar
    //     en el índice — que es exactamente lo que pasa cuando alguien borra
    //     una fila de verdad.
    //
    // Uno por cada población que el criterio vigila, porque fallan por caminos
    // distintos: el CHECK se lee de las migraciones y AccountRole del fuente
    // de una unión de TypeScript.
    mutantes: [
      {
        archivo: 'src/language/vocabulary-registry.json',
        de: '"es": "cfdi_retencion",',
        a: '"es": "cfdi_retencion_BORRADA",',
        porque:
          'fila-borrada: un literal español de un CHECK deja de estar registrado y I23–I25 lo renombrarían sin mapa',
      },
      {
        archivo: 'src/language/vocabulary-registry.json',
        de: '"es": "depreciacion_acumulada",',
        a: '"es": "depreciacion_acumulada_BORRADA",',
        porque:
          'fila-borrada: un valor de AccountRole deja de estar registrado, y es la clase que ningún CHECK protege',
      },
    ],
  },

  // ---- T1 · Que la actualización vuelva a correr ----

  {
    paquete: 'E0.2',
    id: 'migration-numbering-guard-forgives-files-not-numbers',
    enunciado: 'La guarda de numeración perdona ARCHIVOS históricos, no números',
    mutantes: [
      {
        archivo: 'src/database/migrate.ts',
        de: "  '014_rls_tenant_isolation.sql',",
        a: "  '014',",
        porque: 'vuelve el perdón por PREFIJO: un 014_lo_que_sea_de_hoy.sql pasa la guarda y files.sort() lo corre antes de las 015 a 069 (#88)',
      },
      {
        archivo: 'src/database/migrate.ts',
        de: 'fs.some((f) => !DUPLICADOS_HISTORICOS.has(f))',
        a: 'fs.every((f) => !DUPLICADOS_HISTORICOS.has(f))',
        porque: 'un choque con UN solo archivo histórico dentro deja de denunciarse: basta acompañar al intruso de un histórico para colarlo',
      },
    ],
    evaluar: () => {
      // #88. La guarda toleraba los duplicados históricos por su NÚMERO, así
      // que el perdón cubría también a los archivos que aún no existían. Su
      // propio comentario decía «cualquier duplicado NUEVO es un error» y el
      // código no podía distinguirlo, porque no miraba el archivo sino su
      // prefijo. Nueve archivos comparten cuatro números; el intruso número
      // diez tiene que rebotar.
      const m = codigoDe('src/database/migrate.ts');
      if (!/DUPLICADOS_HISTORICOS/.test(m)) {
        return falla('desapareció la lista de duplicados históricos: o la guarda dejó de existir o volvió a tolerarlo todo');
      }
      const lista = m.slice(m.indexOf('DUPLICADOS_HISTORICOS'), m.indexOf('export function assertNumeracionUnica'));
      const entradas = lista.match(/'\d{3}_[a-z0-9_]+\.sql'/g) ?? [];
      if (entradas.length === 0) {
        return falla('la lista de perdón volvió a ser de PREFIJOS: perdona por número, así que también perdona a los archivos que todavía no existen (#88)');
      }
      // La lista NO CRECE: nueve, y los nueve existen. Se cuentan aquí y no se
      // derivan del directorio a propósito — derivarlos sería preguntarle al
      // acusado.
      if (entradas.length !== 9) {
        return falla(`la lista de perdón tiene ${entradas.length} archivos y son NUEVE: crecer la lista es la forma barata de silenciar un choque nuevo`);
      }
      const faltan = entradas
        .map((e) => e.slice(1, -1))
        .filter((f) => !existe(`src/database/migrations/${f}`));
      if (faltan.length > 0) {
        return falla(`la lista perdona archivos que ya no están (${faltan.join(', ')}): alguien renumeró un histórico y el perdón quedó apuntando a un fantasma`);
      }
      // Y el choque se denuncia si CUALQUIERA de sus archivos es nuevo, no sólo
      // si lo son todos.
      return /fs\.some\(\(f\) => !DUPLICADOS_HISTORICOS\.has\(f\)\)/.test(m)
        ? ok('la guarda perdona nueve archivos por su nombre, y un décimo con prefijo repetido rebota')
        : falla('el choque sólo se denuncia cuando NINGUNO de sus archivos es histórico: acompañar al intruso de un histórico lo cuela');
    },
  },

  {
    paquete: 'E0.2',
    id: 'historic-runs-backfill-sees-its-rows',
    enunciado: 'La migración que cierra las corridas históricas llega a verlas',
    mutantes: [
      {
        archivo: 'src/database/migrations/060_la_corrida_que_se_abre_antes.sql',
        de: 'SET LOCAL row_security = on;\nDO $cierre$',
        a: 'DO $cierre$',
        porque: 'sin el opt-in, migrate.ts corre con row_security=off y el UPDATE sobre una tabla acotada lanza 42501 en vez de filtrar: revierte el archivo entero en cualquier despacho instalado (#88)',
      },
      {
        archivo: 'src/database/migrations/060_la_corrida_que_se_abre_antes.sql',
        de: 'FOR t IN SELECT id FROM tenants LOOP',
        a: "FOR t IN SELECT '00000000-0000-0000-0000-000000000000'::uuid AS id LOOP",
        porque: 'el bucle deja de recorrer inquilinos: la migración se aplica sin error y cierra CERO corridas, que es peor que fallar porque nadie se entera',
      },
    ],
    evaluar: () => {
      // #88. La 060 era la única de su familia sin el patrón sancionado, y por
      // eso `npm run migrate` moría ahí en todo despacho ya instalado: quien se
      // niega es el planificador, no un conteo, así que fallaba con la tabla
      // llena o vacía.
      const m = 'src/database/migrations/060_la_corrida_que_se_abre_antes.sql';
      if (!existe(m)) return falla('la 060 desapareció');
      const sql = crudoDe(m);
      const dml = /UPDATE\s+ai_ingest_runs/.test(sql);
      if (!dml) return ok('la 060 ya no escribe datos: sin DML no hay RLS que declarar');
      // EL ORDEN IMPORTA, y es lo que un ancla de mera presencia no ve: el
      // opt-in declarado DESPUÉS del DML no salva nada.
      const iOptIn = sql.search(/SET LOCAL row_security = on/);
      const iDml = sql.search(/UPDATE\s+ai_ingest_runs/);
      if (iOptIn === -1 || iOptIn > iDml) {
        return falla('la 060 escribe datos sobre una tabla acotada por RLS sin declarar antes su opt-in: muere con 42501 y revierte el archivo entero (#88)');
      }
      const cuerpo = sql.slice(iOptIn, iDml);
      return /FOR\s+\w+\s+IN\s+SELECT\s+id\s+FROM\s+tenants/.test(cuerpo)
        ? ok('la 060 declara su opt-in de RLS antes de escribir y recorre los inquilinos: alcanza las corridas que venía a cerrar')
        : falla('la 060 declara el opt-in pero no recorre inquilinos: se aplica sin error y cierra cero corridas, que es peor que fallar porque nadie se entera');
    },
  },
];
