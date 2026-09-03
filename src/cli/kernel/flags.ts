import { InvalidArgumentError, type Command } from 'commander';
import { FORMATS } from './output.js';

// ============================================================
// FLAG VOCABULARY — the single dictionary (rulebook R6)
//
// One concept, one spelling, one meaning, everywhere. Commands do
// not declare these flags by hand; they apply the group they need.
// That is what makes the R12 consistency test possible: a flag can
// only exist in the CLI if it exists here first.
//
// Short flags are scarce and are assigned once:
//   -e entity  -t tenant  -u user  -p provider  -m model
//   -n limit   -l list    -s status  -a all     -y yes
//   -o output  -q quiet   -v verbose -c set     -z null
//   -M -Q -Y interval
// `-f` is deliberately never assigned: it reads as both --file and
// --force, and the day those two are confused someone overrides a
// period lock while meaning to pass a filename.
//
// Deliberately banned spellings, rejected here so they cannot creep
// back: --dryrun, --out, --fmt, --outfmt, --from/--to, --noinput,
// --silent, --pretty, and -f for force.
// ============================================================

/** Spellings a command may never declare. Enforced by the consistency test. */
export const BANNED_FLAGS = [
  '--dryrun', '--out', '--fmt', '--outfmt', '--from', '--to',
  '--noinput', '--silent', '--pretty', '--confirm', '--validate-only', '--plan',
  '--against', '--sandbox', '--test',
] as const;

/** Every long flag the dictionary defines, with its short form when it has one. */
export const FLAG_DICTIONARY: Record<string, string | null> = {
  '--entity': '-e', '--tenant': '-t', '--user': '-u',
  '--profile': null, '--config': null, '--set': '-c',
  '--period': null, '--since': null, '--until': null, '--as-of': null,
  '--date-basis': null, '--interval': null,
  '--account': null, '--status': '-s', '--limit': '-n', '--offset': null,
  '--cursor': null, '--all': '-a',
  '--format': null, '--json': null, '--output': '-o', '--fields': null,
  '--jq': null, '--quiet': '-q', '--verbose': '-v', '--null': '-z',
  '--no-color': null, '--no-pager': null,
  '--dry-run': null, '--diff': null, '--yes': '-y', '--force': null,
  '--reason': null, '--note': null, '--idempotency-key': null, '--live': null,
  '--strict': null, '--no-input': null, '--watch': null,
  '--provider': '-p', '--model': '-m',
  // S3: el destino de un respaldo (directorio) o de una restauración (base).
  // Lo nombra el catálogo en las filas de `backup` desde antes de existir.
  '--target': null,
  // S3: `backup verify` comprueba hash y manifiesto sin restaurar (lo que el
  // catálogo promete); con --restore ENSAYA la restauración de verdad, que es
  // lo único que demuestra que un respaldo sirve.
  '--restore': null,
  // F04 · la bandeja de CFDI (`bill inbox list|run`). El catálogo las nombra
  // desde antes de que existieran. Entran aquí para congelar la grafía: sin
  // esto `--query` reaparece como --filter o --where en la próxima sesión, y
  // `--vendor` —que `bill list` y `bill create` ya declaraban a mano— podría
  // ganar una forma corta en un comando y no en otro.
  '--vendor': null,
  '--processing-mode': null,
  '--requires-approval': null,
  '--bulk': null,
  '--query': null,
  '--action': null,
  // El lote programado al que `--action set-batch` engancha el pre-registro.
  '--batch': null,
  // F04 · la autorización explícita de alta de proveedor desde un CFDI. Es
  // control interno, no criterio contable: no se pregunta al panel de
  // políticas, se escribe en la orden o no ocurre.
  '--allow-new-vendor': null,
  // F04 · el desglose en prosa de un resultado que la tabla sólo enumera: el
  // porqué de cada partida, no sólo su importe. El catálogo la promete en
  // `ap reconcile` y la reclamarán las demás conciliaciones; entra al
  // diccionario para que las tres se escriban igual. `explain` ya existía como
  // VERBO (`cfdi explain`): son cosas distintas y conviven sin estorbarse,
  // igual que `--diff` convive con el verbo `diff`.
  '--explain': null,

  // ── F05a · la familia `bank` ──────────────────────────────────────────
  //
  // Ninguna de estas lleva forma corta, así que estrictamente el auditor no
  // las exigía aquí. Entran igual porque el diccionario existe para que una
  // grafía se decida UNA vez: `bank account edit --clabe` y el
  // `payment dispatch --clabe` de F05b tienen que ser la misma bandera, y el
  // día que alguien le ponga `-c` a una de las dos el auditor lo dirá en vez
  // de dejarlo pasar. Cuatro de ellas —`--type`, `--currency`, `--name`,
  // `--check`— las hablan ya cuatro familias cada una (account, entry,
  // credit-note, cfdi; ledger, ar, close) sin que nadie las hubiera
  // congelado; se congelan ahora, con la forma que ya tenían.
  '--name': null,
  '--type': null,
  '--currency': null,
  '--check': null,
  '--bank': null,
  '--branch': null,
  '--gl-account': null,
  // Los tres identificadores por los que sale el dinero. Su edición exige
  // --reason y nunca se devuelven en claro (051 · cifrado de la CLABE).
  '--clabe': null,
  '--account-number': null,
  '--routing-ach': null,
  '--routing-wire': null,
  '--swift': null,
  '--iban': null,
  '--sat-bank-code': null,
  // `bank account show --redacted`: oculta hasta los últimos 4, para la
  // pantalla que se comparte. No es lo mismo que enmascarar, que es siempre.
  '--redacted': null,
  // Lecturas de despacho: la misma pregunta sobre todas las entidades del
  // inquilino. Sólo lecturas — un alta necesita saber en cuál entidad ocurre.
  '--all-entities': null,
  // `bank statement import --dir`: el directorio del que se toman los
  // archivos, complementario a los posicionales.
  '--dir': null,
  // El saldo final que el operador AFIRMA, cuando el archivo no lo trae (un
  // CSV no tiene saldos). Si el archivo sí lo trae y no coinciden, se rechaza.
  '--closing-balance': null,
  // `bank statement show --lines`: trae las líneas, no sólo la cabecera.
  '--lines': null,

  // ── F05b · los dos lados y el cotejo ──────────────────────────────────
  //
  // Ninguna lleva forma corta. Las que más importa congelar son las tres
  // últimas del bloque de compuertas: `--min-confidence`, `--max-amount` y
  // `--rules-only` las hablan `bank match preview` y `bank match run`, que son
  // deliberadamente DOS hojas —una ✓ y otra ✗— porque el permiso del agente no
  // puede depender del valor de una bandera. Dos hojas que hacen la misma
  // pregunta tienen que hacerla con las mismas palabras, o la mitad de lectura
  // deja de predecir lo que hará la de escritura, que es lo único que la hace
  // valer para algo.
  //
  // `--unmatched`: el estado de cotejo de un movimiento. Es un atajo de
  // `-s unmatched` y no un filtro paralelo; el catálogo lo nombra así.
  '--unmatched': null,
  // Hacia dónde fue el dinero. Es el SIGNO del importe, no `transaction_type`,
  // que dice de qué clase es el movimiento (comisión, interés) y no su sentido.
  '--direction': null,
  // `bank transaction show --raw`: el `raw_data` como lo publicó el banco.
  // Se pide, no se imprime siempre: suele traer nombre y cuenta de la
  // contraparte, y una ficha que lo enseña por omisión es una fuga por
  // pantalla compartida.
  '--raw': null,
  // `bank book-item list --over-days`: antigüedad mínima. Es la bandera que
  // convierte una lista en un hallazgo —el cheque que lleva ochenta días
  // expedido y que el banco nunca mostró—.
  '--over-days': null,
  // `bank match preview --top`: cuántos MOVIMIENTOS previsualizar. No es
  // `--limit` porque no lista filas de una tabla: recorre movimientos y por
  // cada uno consulta candidatos, así que su costo es el del motor y no el de
  // un SELECT. El catálogo lo escribe así en la fila 1224.
  '--top': null,
  '--min-confidence': null,
  '--max-amount': null,
  '--rules-only': null,
  // La sesión de conciliación a la que se liga el cotejo. Sus dos escritores
  // anteriores la dejaban en NULL mientras su único lector filtraba por ella.
  '--session': null,
  // `bank match apply --stdin`: los ids llegan por tubería, que es lo que hace
  // que `bank match preview -q | mnemosine bank match apply --stdin` exista.
  '--stdin': null,
  // Los dos lados de un grupo de cotejo explícito. El catálogo los escribe
  // `--bank` y `--book`; aquí se llaman por el sustantivo de su hoja
  // (`bank transaction list`, `bank book-item list`) porque `--bank` YA
  // significa otra cosa en esta misma familia —la institución, en
  // `bank account create`— y una grafía con dos significados es exactamente lo
  // que este diccionario existe para impedir.
  '--transaction': null,
  '--book-item': null,
  // Un ajuste declarado del grupo: comisión, diferencia cambiaria. Repetible.
  '--adjust': null,
  // Qué se hace con lo que sobra, y contra qué cuenta si se cancela. Los dos
  // van juntos por CHECK en la 052.
  '--residual': null,
  '--write-off-account': null,

  // ── F05c · la sesión de conciliación ──────────────────────────────────
  //
  // Ninguna lleva forma corta. Se congelan aquí por lo mismo que las de F05a y
  // F05b: para que la grafía se decida UNA vez. Tres de ellas ya existían
  // sueltas en otras familias con esta misma escritura (`--file` en `entry
  // create`, `--amount` en `payment`/`ap`, `--resume` en `chat`), así que lo
  // que hace esta entrada es impedir que la próxima sesión les invente una
  // forma corta o una variante.
  '--file': null,
  '--amount': null,
  // El extracto concreto al que se ata la sesión, cuando el periodo tiene más
  // de uno. Es un documento, no un formato: `bank statement` es su familia.
  '--statement': null,
  // La MAGNITUD del residual que un cierre puede absorber. El criterio de si
  // se admite residual vive en el panel (`conciliacion_tolerancia`) y esta
  // bandera NO lo afloja: con `cero_exacto` se rechaza en voz alta. Existe
  // porque el panel fija el criterio y no el número.
  '--tolerance': null,
  // Hasta qué paso llega el pase guiado. Nunca más allá de `estado`: `approve`
  // y `post` no son pasos de un pase automático.
  '--stop-at': null,
  // Continuar donde se detuvo, en vez de abrir otra sesión que explicaría el
  // mismo movimiento dos veces. Convive con el VERBO `resume`·`reanudar`, como
  // `--explain` convive con el verbo `explain`.
  '--resume': null,
  // La partida conciliatoria que un ajuste explica. Se llama por el objeto que
  // nombra —`bank reconciling-item`— y no `--reconciling-item`, que sería la
  // bandera más larga del binario.
  '--item': null,

  // ── F05d · las dos tasas de tesorería ─────────────────────────────────
  //
  // SON DOS GRAFÍAS Y NO UNA, y ésta es la entrada que más trabajo hace del
  // bloque. `bank fee post` y `bank interest post` piden cada una «la tasa»,
  // pero no la misma: en la comisión es el IVA que el cargo trae DENTRO y en el
  // interés es la RETENCIÓN de ISR que el banco ya se llevó. Un solo `--rate`
  // sirviendo a las dos sería una grafía con dos significados dentro del mismo
  // sustantivo —el caso de `--bank` en F05b y el de `--account` en F05c—, y aquí
  // el precio de confundirlas no es una lista mal filtrada: es un asiento
  // cuadrado con la base y el impuesto cambiados de sitio, que no lo caza nadie.
  //
  // `--rate` es la del catálogo (fila 1260) y se queda donde el catálogo la
  // pone. `--iva-rate` no está en la fila 1259 porque la fila no previó que el
  // tratamiento fiscal tuviera que ser explícito; el servicio no admite valor
  // por omisión —un 16% invisible aplicado a todos los cargos del periodo a la
  // vez es una decisión fiscal que nadie tomó—, así que la bandera tiene que
  // existir. Se escribe con el nombre del impuesto, como `--clabe` y
  // `--sat-bank-code` se escriben con el nombre de lo que nombran.
  '--rate': null,
  '--iva-rate': null,

  // ── F06a · el activo y su corrida ─────────────────────────────────────
  //
  // Ninguna lleva forma corta, y una de ellas es la razón por la que este
  // bloque existe: `--book`.
  //
  // `--book` ES EL LIBRO DE DEPRECIACIÓN (contable o fiscal) Y NADA MÁS. El
  // catálogo lo escribe en once filas de la familia `asset`/`depreciation` con
  // ese único sentido, y F05b ya se negó a usarlo para el otro lado de un
  // cotejo justamente para dejarlo libre: allí se llama `--book-item`. En
  // México las dos depreciaciones existen a la vez —la contable sigue la vida
  // útil de la NIF C-6 y la fiscal las tasas máximas de los artículos 31-38 de
  // la LISR—, dan números distintos sobre el mismo bien todos los meses, y
  // `depreciation_schedules.schedule_type` guarda las dos desde la 003. Una
  // grafía con dos significados aquí no sería una lista mal filtrada: sería
  // deducir por el libro equivocado.
  //
  // LO QUE `--book` NO HACE: elegir. Cuál de los dos libros llega al mayor es
  // la política `base_depreciacion`, que vive en el panel porque es criterio
  // del despacho. La bandera DECLARA sobre cuál se cree estar operando y el
  // comando la contrasta con el panel; si no coinciden, se detiene. Apretar es
  // de cualquiera, aflojar sólo del despacho —la misma asimetría que
  // `--tolerance` en F05c—.
  '--book': null,
  // La dimensión por la que se agrupa un resumen. Ya existía sin congelar en
  // `usage --by` y el catálogo la nombra en nueve filas más (`ap spend show`,
  // `grni list`, `trial-balance show`…). Se congela con la grafía que ya tenía.
  '--by': null,
  // El método de depreciación, del vocabulario que la 056 puso en el CHECK.
  // `--method` es el CONTABLE y `--tax-method` el FISCAL: son dos columnas
  // distintas desde la 003 y confundirlas es el mismo error que `--book`.
  '--method': null,
  '--tax-method': null,
  // La clase del activo. El catálogo la escribe así en `asset create`,
  // `asset capitalization create` y `asset category set`.
  '--category': null,
  // Las tres fechas y los dos importes de un alta. `--cost` es el MOI (monto
  // original de la inversión) y `--salvage` el valor residual; el CHECK de la
  // 003 exige `acquisition_cost > salvage_value`.
  '--acquired': null,
  '--in-service': null,
  '--cost': null,
  '--salvage': null,
  // La vida útil, en años o en meses. Existen las dos porque las tasas de la
  // LISR no dan años enteros —el 30% del equipo de cómputo son 40 meses— y
  // `vidaUtilCoherente` trata los años como el TECHO de los meses entre doce.
  '--life-years': null,
  '--life-months': null,
  // Las tres cuentas del activo, con la grafía que el catálogo ya usa en
  // `asset category create` (`--asset-account`, `--accum-account`). La tercera
  // se nombra igual que sus hermanas y no `--expense-destination`, que en el
  // catálogo es otra cosa: si el gasto va a resultados o a costo de producción.
  '--asset-account': null,
  '--accum-account': null,
  '--expense-account': null,
  // DÓNDE ESTÁ YA EL COSTO. No tiene valor por omisión a propósito: el alta de
  // un activo cuyo importe ya se cargó a la cuenta de activo (el CFDI que se
  // capitalizó) y el alta de uno que nadie ha contabilizado son dos hechos
  // distintos, y suponer uno de los dos duplica el activo o lo deja fuera del
  // mayor. `--source-entry` nombra el asiento donde está, cuando se sabe.
  '--capitalized': null,
  '--source-entry': null,
  // El folio del activo. Se genera solo si no se pasa (`nextEntityNumber`).
  '--number': null,
  // Identidad física del bien: es para lo que sirve un registro de activo fijo
  // —encontrar la cosa—. `--model` y `--manufacturer` NO entran: `-m/--model`
  // ya significa el modelo de IA en este binario, y una grafía con dos
  // significados es lo que este diccionario existe para impedir. Van a
  // `asset edit`, que es fase 2.
  '--serial': null,
  '--location': null,
  '--description': null,

  // ── F06c · la familia `batch` ─────────────────────────────────────────
  //
  // Ninguna lleva forma corta. `--kind` es la que más trabajo hace: ya la
  // hablaban `approvals grant` y `jobs create` sin que nadie la hubiera
  // congelado, y el catálogo la promete en tres filas más (`batch list`,
  // `period adjustment create`, `ap accrue`). Cuatro familias con la misma
  // pregunta —¿de qué clase es esto?— tienen que hacerla con la misma grafía,
  // y sin esta entrada la próxima sesión le inventa un -k o un --type que ya
  // significa otra cosa (la naturaleza de una cuenta bancaria, F05a).
  '--kind': null,
  // `batch post --partial`: aplicar lo válido y DEJAR lo inválido en staging.
  // El catálogo la escribe también en `payment-run edit` (fase 2): se congela
  // ahora para que las dos digan lo mismo con la misma palabra.
  '--partial': null,
  // `batch show --errors-only`: sólo las filas que el parser rechazó. No es
  // `--status` (las filas del staging no tienen estado propio) ni `--strict`
  // (no endurece nada): acota una ficha, y se escribe con el guion completo
  // porque `--errors` a secas leería como «enséñame los errores», que es otra
  // promesa.
  '--errors-only': null,

  // ── R4 · la familia `fx` (NIF B-15) ───────────────────────────────────
  //
  // Ninguna lleva forma corta. `--source` es la que más trabajo hace: ya la
  // hablaban `entry list` (el subdiario de origen) y `webhooks` (la clase de
  // emisor) con esta misma grafía y sin forma corta, y en `fx rate set` y
  // `fx rate download` nombra QUIÉN publicó el tipo — el concepto es siempre
  // «de dónde salió esto». Se congela ahora porque desde la 057 la fuente es
  // parte de la CLAVE de un tipo de cambio (DOF y FIX del mismo día conviven
  // como filas distintas), y una bandera que es clave no puede cambiar de
  // grafía entre la hoja que escribe y la que lee.
  '--source': null,
  // El par de monedas, «USD/MXN». No se parte en --from-currency/--to-currency:
  // --from y --to están PROHIBIDAS arriba justo porque no dicen de qué son.
  '--pair': null,
  // Cuál de los cuatro tipos del CHECK de la 001 (`spot`, `average`, `budget`,
  // `historical`). No es `--type` —la naturaleza de una cuenta bancaria, F05a—
  // ni `--rate` —la tasa de IVA/ISR de tesorería, F05d—: tres conceptos, tres
  // grafías, y ésta se escribe con las dos palabras para no rozar ninguna.
  '--rate-type': null,

  // ── G1b · el estado de flujos de efectivo (NIF B-2 / ASC 230) ─────────
  //
  // Ninguna lleva forma corta. Las dos entradas son de la familia
  // `cashflow`·`flujo`, y el catálogo las escribe así en sus dos filas de
  // fase 1 (docs/cli-command-catalog.md).
  //
  // `--method` NO entra aquí: ya existe, congelada en F06a como el método
  // CONTABLE de depreciación, y `cashflow generate --method indirect|direct`
  // la reutiliza con el mismo significado de fondo —«por qué método se
  // calculó esto»— y sin forma corta, que es lo que el diccionario gobierna.
  // Se deja anotado aquí porque una bandera con dos inquilinos tiene que
  // constar en alguna parte: si algún día uno de los dos le pone `-m` (hoy el
  // modelo de IA), el auditor lo dirá en las dos familias a la vez.
  //
  // `--gross` es la BASE DE PRESENTACIÓN del estado —bruta contra neta, NIF
  // B-2 §40 y ASC 230-10-45-7—, no un nivel de detalle. Se congela con la
  // grafía del catálogo antes de que reaparezca como `--detail` o
  // `--expanded`, que son otra promesa: enseñar más renglones no es dejar de
  // compensar entradas contra salidas.
  '--gross': null,
  // `cashflow reconcile --show-candidates`: los movimientos que PODRÍAN
  // explicar el residuo. El plural va en el sustantivo y no en el verbo, y el
  // nombre dice lo que la lista es —candidatos, no un veredicto—. La declara
  // `cashflow-reconcile-command.ts` desde su primer día; entra al diccionario
  // ahora para que la próxima conciliación que ofrezca pistas —`statement
  // check`, `cashflow explain` de fase 3— las ofrezca con esta misma palabra.
  '--show-candidates': null,

  // ── D1a · el devengo de los pagos anticipados (NIF A-2) ───────────────
  //
  // Ninguna lleva forma corta. Seis grafías nuevas para la familia
  // `prepaid`·`pago-anticipado`, y dos que el catálogo escribe de otra manera
  // en su fila de `prepaid create` (docs/cli-command-catalog.md) y que aquí se
  // apartan a propósito:
  //
  // `--method` NO entra en esta familia, aunque el catálogo la nombre. Está
  // congelada desde F06a como el método CONTABLE de depreciación, con su
  // vocabulario propio (`straight_line`, `units_of_production`…). La
  // convención del devengo tiene OTRO vocabulario —el que la 059 puso en un
  // CHECK— y los tres valores que el catálogo imagina para ella
  // (`straight-line-day|month|usage`) no existen en el motor: `usage` ni
  // siquiera es imaginable sin captura de producción para un seguro. Una
  // grafía con dos vocabularios de valores es peor que una con dos
  // significados, porque el error no se ve al teclear sino al postear.
  //
  // `--asset-account` TAMPOCO, por lo mismo: en F06a es la cuenta del ACTIVO
  // FIJO (`asset create`, `asset category create`), y la 1160 no es esa
  // cuenta. `--prepaid-account` la nombra por lo que es. `--expense-account`
  // sí se reutiliza tal cual: significa lo mismo en las dos familias —dónde
  // aterriza el gasto del mes—.
  //
  // La convención, que DECLARA y no elige, igual que `--book`: cuál de los dos
  // recortes del calendario rige es la política `amortizacion_anticipados_convencion`.
  '--convention': null,
  '--prepaid-account': null,
  // La ventana de cobertura de un contrato. NO son `--since`/`--until`, que
  // son los límites de un FILTRO, ni `--from`/`--to`, que están prohibidas
  // arriba por no decir de qué son. Un seguro que corre del 20 de marzo al 19
  // de marzo tiene un principio y un fin propios, y son un dato de la fila.
  '--start': null,
  '--end': null,
  // DE DÓNDE SALIÓ EL CARGO que ya está en la cuenta. No es `--source` —quién
  // publicó un tipo de cambio, R4— ni `--kind` —de qué clase es esto, F06c—:
  // es el hecho que explica por qué hay un saldo que adoptar, y de él depende
  // que `--source-entry` sea obligatoria.
  '--origin': null,
  // El documento al que apunta la fila: número de póliza, contrato, pedido.
  // `bank`, `ar` y `ap` la van a querer con esta misma escritura; se congela
  // ahora para que no reaparezca como `--ref` o `--document`.
  '--reference': null,
  // El UUID del CFDI del que nace el registro. `--uuid` a secas no dice de qué
  // documento, y en este binario hay tres cosas con UUID (el CFDI, el asiento
  // y la entidad).
  '--cfdi-uuid': null,

  // ── F07b · el XML del Anexo 24 que se entrega ─────────────────────────
  //
  // Sólo DOS grafías nuevas, y ninguna lleva forma corta. La familia
  // `e-accounting`·`contabilidad-electronica` habla sobre todo banderas que ya
  // estaban congeladas —`--period`, `--dry-run`, `-o/--output`, `--check`,
  // `--strict`, `--json`, `-y/--yes`—, y una de ellas conviene dejar anotada
  // porque llega con otro inquilino: `--type`. Está congelada desde F05a como
  // la naturaleza de una cuenta bancaria, y aquí la fila 2063 del catálogo la
  // reutiliza como el TipoEnvio del archivo (N normal, C complementaria). Es
  // el mismo caso que `--method` en G1b: dos inquilinos, un concepto de fondo
  // —«de qué clase es esto»— y ninguna forma corta, que es lo que el
  // diccionario gobierna. Queda escrito aquí para que el día que alguien le
  // ponga una `-t` (hoy el inquilino) el auditor lo diga en las dos familias.
  //
  // `--closing` ES LA BALANZA DEL EJERCICIO Y NO UN MES. Va con Mes 13 y
  // declara los AJUSTES de cierre, así que NO es diciembre otra vez: la
  // diferencia importa porque presentar diciembre con Mes 13 entrega un
  // archivo que la autoridad acepta y que no contiene el cierre — nadie se
  // entera hasta la revisión. Se escribe entera y no `--close` para no rozar
  // el VERBO `close`·`cerrar`, que existe y hace otra cosa, ni
  // `--closing-balance` de F05a, que es el saldo final que un operador afirma
  // sobre un extracto bancario.
  '--closing': null,
  // FECHA EN QUE SE MODIFICÓ LA BALANZA QUE SE COMPLEMENTA (`FechaModBal`).
  // Obligatoria con `--type C` y prohibida con `--type N`, y las dos cosas las
  // impone el constructor del XML, no esta bandera.
  //
  // NO es `--as-of`, que en este diccionario es una fecha de VALUACIÓN con la
  // que se filtra o se valora; ni `--since`/`--until`, que son los límites de
  // un filtro. Es un DATO DE LA FILA —igual que `--start` y `--end` de D1a—:
  // viaja al archivo como un atributo y la autoridad lo lee para saber qué
  // envío anterior está siendo sustituido. Una fecha equivocada aquí no
  // devuelve una lista mal filtrada: liga la complementaria al envío que no es.
  '--modified': null,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePositiveInt(name: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new InvalidArgumentError(`${name} must be a non-negative whole number; got "${value}".`);
    }
    return n;
  };
}

function parseDate(name: string) {
  return (value: string): string => {
    if (!DATE_RE.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
      throw new InvalidArgumentError(`${name} must be a date as YYYY-MM-DD; got "${value}".`);
    }
    return value;
  };
}

/** Which company to operate on, and as whom. */
export function withContext(cmd: Command): Command {
  return cmd
    .option('-e, --entity <idOrName>', 'legal entity to operate on (defaults to the active one)')
    .option('-t, --tenant <id>', 'tenant (firm) whose data to scope to')
    .option('-u, --user <email>', 'acting user, for attribution and permissions');
}

/**
 * Options merged with those declared on the root program.
 *
 * READ THIS BEFORE USING opts.tenant. The root declares a global
 * `-T, --tenant`, and Commander gives a repeated option to the PARENT: a
 * subcommand that also declares `--tenant` sees `undefined` when the user
 * typed it, and the value silently lands on the program instead.
 *
 * It has been benign so far only because `bootstrapTenant(undefined)` falls
 * back to MNEMOSINE_TENANT — so scoping still happened while the VALUE was
 * lost. Any command that needs the tenant as data (creating an entity,
 * attributing a write, naming the firm in output) must read it from here.
 *
 * The command is the last argument Commander passes to an action:
 *   cmd.action((arg, opts, command) => { const all = globalsOf<Opts>(command); })
 */
export function globalsOf<T>(cmd: Command): T {
  return cmd.optsWithGlobals() as T;
}

/**
 * How results are shaped. `--json` stays as the documented shorthand for
 * `--format json` because it is already typed everywhere; it does not get
 * to mean anything else.
 */
export function withOutput(cmd: Command): Command {
  return cmd
    .option(`--format <${FORMATS.join('|')}>`, 'output format', 'table')
    .option('--json', 'shorthand for --format json')
    .option('-o, --output <path>', 'write to a file instead of stdout')
    .option('--fields [names]', 'comma-separated columns; with no value, lists the available ones')
    .option('-q, --quiet', 'identifiers only, one per line, for piping');
}

/** Which rows to return. Every list command carries these. */
export function withSelection(cmd: Command): Command {
  return cmd
    .option('-n, --limit <n>', 'maximum rows to return', parsePositiveInt('--limit'))
    .option('--offset <n>', 'skip this many rows', parsePositiveInt('--offset'))
    .option('-s, --status <state...>', 'filter by lifecycle state (repeatable)')
    .option('-a, --all', 'no default limit; include archived and closed');
}

/**
 * Which dates the filters mean. `--date-basis` exists because document
 * date, posting date and value date are three different things, and one
 * `--date` flag silently answering for all three is a whole class of
 * wrong answers: accrual cutoff, FX rate selection and tax period
 * assignment each key off a different one.
 */
export function withTime(cmd: Command): Command {
  return cmd
    .option('--period <expr>', 'period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06')
    .option('--since <date>', 'inclusive lower bound (YYYY-MM-DD)', parseDate('--since'))
    .option('--until <date>', 'inclusive upper bound (YYYY-MM-DD)', parseDate('--until'))
    .option('--as-of <date>', 'valuation/balance date (YYYY-MM-DD)', parseDate('--as-of'))
    .option(
      '--date-basis <document|posting|value>',
      'which date the filters apply to',
      'posting'
    );
}

/** For `check`-style diagnostics: warnings become failures on demand. */
export function withStrict(cmd: Command): Command {
  return cmd.option('--strict', 'treat warnings as blocking (exit 4)');
}

/** Overriding a hard validation is separate from skipping a prompt. */
export function withForce(cmd: Command): Command {
  return cmd.option(
    '--force',
    'override a blocking validation (closed period, lock date, duplicate); requires --reason'
  );
}

/** A free annotation. Never a justification — that is --reason. */
export function withNote(cmd: Command): Command {
  return cmd.option('--note <text>', 'free annotation stored with the record');
}

/** Convenience for the common read command: context + time + selection + output. */
export function withReadFlags(cmd: Command): Command {
  return withOutput(withSelection(withTime(withContext(cmd))));
}
