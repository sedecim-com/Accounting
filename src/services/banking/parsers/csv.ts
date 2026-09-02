import Decimal from 'decimal.js';
import { ValidationError } from '../../../utils/errors.js';
import { crearAvisos, recortar, type ColectorAvisos } from './avisos.js';
import { analizarFecha } from './fecha.js';
import { analizarImporte, combinarCargoAbono } from './importe.js';
import { PERFILES_CSV, perfilPorNombre } from './perfiles-csv.js';
import { decodificar, normalizarEncabezado, type Codificacion } from './texto.js';
import type {
  ExtractoLeido,
  LineaLeida,
  MapaColumnas,
  PerfilCsv,
  ResultadoValor,
  SelectorColumna,
} from './tipos.js';

// ============================================================
// EL LECTOR DE CSV, QUE ES EL CASO REAL DE MÉXICO
//
// camt.053 y MT940 son normas: se leen igual venga de donde venga el archivo.
// «CSV» no es una norma, es la ausencia de una, y es lo que de verdad recibe
// un despacho mexicano. Por eso este lector no tiene lógica por banco sino un
// PERFIL declarativo por banco: el día que el portal de BBVA cambie una
// columna, lo que cambia es un objeto de datos, no un `if`.
//
// LO QUE NO SE HACE AQUÍ, Y ES DELIBERADO: no se adivina el banco por el
// nombre del archivo, ni se prueba perfil por perfil «a ver cuál no truena».
// La detección exige que TODAS las columnas requeridas del perfil aparezcan en
// el encabezado, y cuando ninguno casa el lector se niega enumerando lo que
// vio. Un CSV importado con el perfil equivocado no falla: entra al sistema
// con las fechas invertidas o el signo al revés, y se descubre en la
// conciliación de dentro de un mes.
// ============================================================

export interface OpcionesCsv {
  /** Nombre del perfil registrado, o un perfil ad-hoc. Sin esto, se detecta. */
  perfil?: string | PerfilCsv;
  /** Registro alterno de perfiles (perfiles de cliente, pruebas). */
  perfiles?: readonly PerfilCsv[];
  /** Pisa la codificación que declara el perfil. */
  codificacion?: Codificacion;
  maxAvisos?: number;
}

interface FilaCruda {
  /** Línea FÍSICA donde empieza el registro, 1-based. Es lo que se cita en los avisos. */
  linea: number;
  celdas: string[];
  texto: string;
}

interface Encabezado {
  /** Posición en la lista de filas ya tokenizadas: por dónde empieza el cuerpo. */
  indiceFila: number;
  /** Línea FÍSICA del archivo, que es la que un humano puede ir a mirar. */
  linea: number;
  celdas: string[];
  /** Encabezado normalizado → índice de columna. */
  indice: Map<string, number>;
}

export interface PerfilDetectado {
  perfil: PerfilCsv;
  encabezado: Encabezado;
  /** Cuántas columnas del perfil se reconocieron. Mide especificidad, no calidad. */
  columnasReconocidas: number;
}

export function leerCsv(entrada: string | Buffer, opciones: OpcionesCsv = {}): ExtractoLeido {
  const registro = opciones.perfiles ?? PERFILES_CSV;
  const avisos = crearAvisos(opciones.maxAvisos);

  // Primera pasada en `auto` sólo para poder MIRAR el encabezado. La
  // codificación definitiva la manda el perfil, que aún no se conoce.
  const exploratoria = decodificar(entrada, opciones.codificacion ?? 'auto');
  if (exploratoria.texto.trim() === '') {
    throw new ValidationError('El archivo está vacío: no tiene ni una línea que leer.');
  }

  const perfil = resolverPerfil(exploratoria.texto, opciones.perfil, registro);

  // Segunda pasada con la codificación del perfil. Sólo se repite si de verdad
  // cambia algo: releer un archivo grande dos veces por gusto es caro y aquí
  // el importador ya lo lee una vez para el sha256.
  const codificacion = opciones.codificacion ?? perfil.codificacion;
  const decodificado =
    codificacion === 'auto' || codificacion === exploratoria.codificacion
      ? exploratoria
      : decodificar(entrada, codificacion);
  decodificado.avisos.forEach((a) => avisos.agregar(a));

  const { filas, aviso: avisoTokenizador } = tokenizar(decodificado.texto, perfil.delimitador);
  if (avisoTokenizador) avisos.agregar(avisoTokenizador);

  const encabezado = ubicarEncabezado(filas, perfil);
  if (!encabezado) {
    throw new ValidationError(
      `El perfil «${perfil.nombre}» no reconoce este archivo: no encontró sus columnas ` +
        `requeridas (${describirRequeridas(perfil)}) en las primeras ` +
        `${perfil.filaEncabezado + perfil.maxDesplazamientoEncabezado} filas.`
    );
  }
  if (encabezado.linea !== perfil.filaEncabezado) {
    avisos.agregar(
      `El perfil «${perfil.nombre}» espera el encabezado en la fila ${perfil.filaEncabezado} y se ` +
        `encontró en la ${encabezado.linea}.`
    );
  }
  duplicadosDeEncabezado(encabezado).forEach((d) =>
    avisos.agregar(`La columna «${d}» aparece más de una vez en el encabezado; se usó la primera.`)
  );

  const columnas = resolverColumnas(perfil.columnas, encabezado);
  if (perfil.importe.modo === 'firmado-por-tipo' && perfil.importe.columnaSigno !== undefined) {
    // `columnaSigno` vive en `importe` y no en `columnas` porque no es un campo
    // de la línea: es la manera de leer otro campo.
    const i = resolver(perfil.importe.columnaSigno, encabezado);
    if (i !== undefined) columnas.signo = i;
  }
  const cuerpo = filas.slice(encabezado.indiceFila + 1);

  const lineas: LineaLeida[] = [];
  const saldos: (string | null)[] = [];

  for (const fila of cuerpo) {
    // El pie de página del banco («TOTAL DE MOVIMIENTOS: 42») llega como una
    // fila con una sola celda. No es una fila corrupta y no merece un aviso de
    // error; sí merece no entrar como movimiento.
    if (fila.celdas.length === 1) continue;

    const leida = leerFila(fila, perfil, columnas, encabezado, avisos);
    if (leida) {
      lineas.push(leida.linea);
      saldos.push(leida.saldo);
    }
  }

  const extracto: ExtractoLeido = {
    formato: 'csv',
    perfil: perfil.nombre,
    lineas,
    avisos: [],
  };

  leerPreambulo(filas.slice(0, encabezado.indiceFila), perfil, extracto, avisos);

  if (!extracto.moneda && perfil.monedaAsumida) {
    extracto.moneda = perfil.monedaAsumida;
    avisos.agregar(
      `El archivo no declara moneda; se asumió ${perfil.monedaAsumida} porque lo dice el perfil ` +
        `«${perfil.nombre}». Verifícalo si la cuenta opera en otra divisa.`
    );
  }

  if (lineas.length === 0) {
    avisos.agregar('El archivo tiene encabezado pero ninguna fila de movimiento legible.');
  } else {
    const fechas = lineas.map((l) => l.fecha);
    extracto.periodoInicio = fechas.reduce((a, b) => (a < b ? a : b));
    extracto.periodoFin = fechas.reduce((a, b) => (a > b ? a : b));
    derivarSaldos(lineas, saldos, extracto, avisos);
  }

  extracto.avisos = avisos.listar();
  return extracto;
}

// ============================================================
// DETECCIÓN DE PERFIL
// ============================================================

/**
 * Deriva qué perfil reconoce el archivo, o se niega nombrando lo que vio.
 *
 * El desempate es por ESPECIFICIDAD —cuántas de sus columnas reconoció el
 * perfil— y no por orden de registro, porque el orden es un accidente del
 * archivo y la especificidad es un hecho del encabezado. Cuando dos perfiles
 * empatan, la respuesta correcta no es elegir uno: es decir que no se puede
 * decidir, porque elegir mal aquí no rompe nada visible.
 */
export function detectarPerfilCsv(
  texto: string,
  perfiles: readonly PerfilCsv[] = PERFILES_CSV
): PerfilDetectado {
  const porDelimitador = new Map<string, FilaCruda[]>();
  const candidatos: PerfilDetectado[] = [];

  for (const perfil of perfiles) {
    let filas = porDelimitador.get(perfil.delimitador);
    if (!filas) {
      filas = tokenizar(texto, perfil.delimitador).filas;
      porDelimitador.set(perfil.delimitador, filas);
    }
    const encabezado = ubicarEncabezado(filas, perfil);
    if (encabezado) {
      candidatos.push({ perfil, encabezado, columnasReconocidas: contarReconocidas(perfil, encabezado) });
    }
  }

  const propios = candidatos.filter((c) => !c.perfil.ultimoRecurso);
  const elegibles = propios.length > 0 ? propios : candidatos;

  if (elegibles.length === 0) {
    const primera = tokenizar(texto, ',').filas.find((f) => f.texto.trim() !== '');
    throw new ValidationError(
      'Ningún perfil reconoce este archivo. ' +
        `Encabezado visto: «${recortar(primera?.texto ?? '(archivo vacío)')}». ` +
        `Perfiles disponibles: ${perfiles.map((p) => p.nombre).join(', ')}. ` +
        'Fija uno con --profile o crea el que falta con `bank format create --file <muestra>`.'
    );
  }

  const maximo = Math.max(...elegibles.map((c) => c.columnasReconocidas));
  const mejores = elegibles.filter((c) => c.columnasReconocidas === maximo);
  if (mejores.length > 1) {
    throw new ValidationError(
      `El archivo casa con ${mejores.length} perfiles a la vez ` +
        `(${mejores.map((c) => c.perfil.nombre).join(', ')}) y ninguno es más específico. ` +
        'Elige uno con --profile: importar con el perfil equivocado no falla, entra torcido.'
    );
  }
  return mejores[0];
}

function resolverPerfil(
  texto: string,
  pedido: string | PerfilCsv | undefined,
  registro: readonly PerfilCsv[]
): PerfilCsv {
  if (pedido === undefined) return detectarPerfilCsv(texto, registro).perfil;
  if (typeof pedido !== 'string') return pedido;

  const encontrado = perfilPorNombre(pedido, registro);
  if (!encontrado) {
    throw new ValidationError(
      `No existe el perfil «${pedido}». Disponibles: ${registro.map((p) => p.nombre).join(', ')}.`
    );
  }
  return encontrado;
}

/**
 * Qué columnas tiene que reconocer un perfil para decir que entendió el
 * archivo. La descripción está entre ellas a propósito: `content_hash` se
 * calcula sobre ella (051), así que un extracto sin descripciones pierde el
 * dedupe de nivel línea y todas sus filas del mismo día y monto colisionan.
 */
function selectoresRequeridos(perfil: PerfilCsv): Array<[string, SelectorColumna]> {
  const c = perfil.columnas;
  const requeridos: Array<[string, SelectorColumna]> = [
    ['fecha', c.fecha],
    ['descripcion', c.descripcion],
  ];
  if (perfil.importe.modo === 'cargo-abono') {
    if (c.cargo !== undefined) requeridos.push(['cargo', c.cargo]);
    if (c.abono !== undefined) requeridos.push(['abono', c.abono]);
  } else {
    if (c.importe !== undefined) requeridos.push(['importe', c.importe]);
    if (perfil.importe.modo === 'firmado-por-tipo' && perfil.importe.columnaSigno !== undefined) {
      requeridos.push(['signo', perfil.importe.columnaSigno]);
    }
  }
  return requeridos;
}

function describirRequeridas(perfil: PerfilCsv): string {
  return selectoresRequeridos(perfil)
    .map(([nombre, sel]) => `${nombre}=${Array.isArray(sel) ? sel.join('|') : String(sel)}`)
    .join(', ');
}

function ubicarEncabezado(filas: FilaCruda[], perfil: PerfilCsv): Encabezado | null {
  const requeridos = selectoresRequeridos(perfil);
  const tope = Math.min(filas.length, perfil.filaEncabezado + perfil.maxDesplazamientoEncabezado);

  for (let i = 0; i < tope; i++) {
    const candidato = construirEncabezado(filas[i], i);
    if (candidato.celdas.length < 2) continue;
    if (requeridos.every(([, sel]) => resolver(sel, candidato) !== undefined)) return candidato;
  }
  return null;
}

function construirEncabezado(fila: FilaCruda, indiceFila: number): Encabezado {
  const indice = new Map<string, number>();
  fila.celdas.forEach((celda, i) => {
    const clave = normalizarEncabezado(celda);
    if (clave !== '' && !indice.has(clave)) indice.set(clave, i);
  });
  return { indiceFila, linea: fila.linea, celdas: fila.celdas, indice };
}

function duplicadosDeEncabezado(encabezado: Encabezado): string[] {
  const vistos = new Set<string>();
  const repetidos = new Set<string>();
  for (const celda of encabezado.celdas) {
    const clave = normalizarEncabezado(celda);
    if (clave === '') continue;
    if (vistos.has(clave)) repetidos.add(celda.trim());
    vistos.add(clave);
  }
  return [...repetidos];
}

function contarReconocidas(perfil: PerfilCsv, encabezado: Encabezado): number {
  const todos: Array<SelectorColumna | undefined> = [
    perfil.columnas.fecha,
    perfil.columnas.fechaValor,
    perfil.columnas.descripcion,
    perfil.columnas.referencia,
    perfil.columnas.tipo,
    perfil.columnas.importe,
    perfil.columnas.cargo,
    perfil.columnas.abono,
    perfil.columnas.saldo,
  ];
  return todos.filter((sel) => sel !== undefined && resolver(sel, encabezado) !== undefined).length;
}

function resolver(sel: SelectorColumna, encabezado: Encabezado): number | undefined {
  if (typeof sel === 'number') {
    return sel >= 0 && sel < encabezado.celdas.length ? sel : undefined;
  }
  for (const alternativa of typeof sel === 'string' ? [sel] : sel) {
    const i = encabezado.indice.get(normalizarEncabezado(alternativa));
    if (i !== undefined) return i;
  }
  return undefined;
}

type ColumnasResueltas = Partial<Record<keyof MapaColumnas | 'signo', number>>;

function resolverColumnas(mapa: MapaColumnas, encabezado: Encabezado): ColumnasResueltas {
  const salida: ColumnasResueltas = {};
  (Object.keys(mapa) as Array<keyof MapaColumnas>).forEach((clave) => {
    const sel = mapa[clave];
    if (sel === undefined) return;
    const i = resolver(sel, encabezado);
    if (i !== undefined) salida[clave] = i;
  });
  return salida;
}

// ============================================================
// LECTURA DE FILA
// ============================================================

interface FilaLeida {
  linea: LineaLeida;
  saldo: string | null;
}

/**
 * Un importe como texto: dos decimales mínimo —para que se lea como dinero— y
 * los cuatro de `DECIMAL(19,4)` en cuanto el número de verdad los tiene.
 *
 * Es la misma regla que aplica `analizarImporte` a lo que lee de una celda, y
 * está aquí para que lo que este lector CALCULA —el signo por columna de tipo,
 * la apertura derivada del saldo corrido— no se recorte por un camino distinto
 * del que siguió lo que leyó.
 */
function enMoneda(valor: Decimal): string {
  return valor.toFixed(valor.decimalPlaces() > 2 ? 4 : 2);
}

function leerFila(
  fila: FilaCruda,
  perfil: PerfilCsv,
  columnas: ColumnasResueltas,
  encabezado: Encabezado,
  avisos: ColectorAvisos
): FilaLeida | null {
  const celda = (indice: number | undefined): string =>
    indice === undefined ? '' : (fila.celdas[indice] ?? '').trim();

  const rechazar = (motivo: string): null => {
    // La fila se cita entera: un aviso que dice «fila 34 inválida» obliga a
    // abrir el archivo, y uno que dice qué había no.
    avisos.agregar(`Línea ${fila.linea}: ${motivo}. Se omitió: «${recortar(fila.texto)}».`);
    return null;
  };

  const fecha = analizarFecha(celda(columnas.fecha), perfil.formatoFecha);
  if (!fecha.ok) return rechazar(fecha.motivo);
  if (fecha.aviso) avisos.agregar(`Línea ${fila.linea}: ${fecha.aviso}`);

  const importe = leerImporte(celda, perfil, columnas);
  if (!importe.ok) return rechazar(importe.motivo);
  if (importe.aviso) avisos.agregar(`Línea ${fila.linea}: ${importe.aviso}`);

  let fechaValor: string | undefined;
  if (columnas.fechaValor !== undefined && celda(columnas.fechaValor) !== '') {
    const fv = analizarFecha(celda(columnas.fechaValor), perfil.formatoFecha);
    if (fv.ok) fechaValor = fv.valor;
    else avisos.agregar(`Línea ${fila.linea}: fecha valor ilegible (${fv.motivo}); se ignoró.`);
  }

  const referencia = celda(columnas.referencia) || undefined;
  // Una descripción vacía debilita `content_hash`, que es lo único que
  // deduplica cuando el banco no publica id. Antes de dejarla en blanco se usa
  // la referencia, que al menos distingue dos movimientos del mismo día.
  const descripcion = celda(columnas.descripcion) || referencia || '';

  const crudo: Record<string, unknown> = { __linea: fila.linea };
  encabezado.celdas.forEach((nombre, i) => {
    const clave = nombre.trim() || `columna_${i + 1}`;
    crudo[clave] = fila.celdas[i] ?? null;
  });

  let saldo: string | null = null;
  if (columnas.saldo !== undefined && celda(columnas.saldo) !== '') {
    const s = analizarImporte(celda(columnas.saldo), {
      separadorDecimal: perfil.importe.separadorDecimal,
      parentesisNegativo: perfil.importe.parentesisNegativo,
    });
    if (s.ok) saldo = s.valor;
  }

  return {
    linea: {
      fecha: fecha.valor,
      fechaValor,
      importe: importe.valor,
      descripcion,
      referencia,
      tipo: celda(columnas.tipo) || undefined,
      crudo,
    },
    saldo,
  };
}

function leerImporte(
  celda: (indice: number | undefined) => string,
  perfil: PerfilCsv,
  columnas: ColumnasResueltas
): ResultadoValor {
  const opciones = {
    separadorDecimal: perfil.importe.separadorDecimal,
    parentesisNegativo: perfil.importe.parentesisNegativo,
    invertirSigno: perfil.importe.invertirSigno,
  };

  if (perfil.importe.modo === 'cargo-abono') {
    return combinarCargoAbono(celda(columnas.cargo), celda(columnas.abono), opciones);
  }

  if (perfil.importe.modo === 'firmado-por-tipo') {
    const marca = normalizarEncabezado(celda(columnas.signo));
    const esCargo = (perfil.importe.valoresCargo ?? []).some((v) => normalizarEncabezado(v) === marca);
    const esAbono = (perfil.importe.valoresAbono ?? []).some((v) => normalizarEncabezado(v) === marca);
    if (!esCargo && !esAbono) {
      return { ok: false, motivo: `la columna de signo dice «${celda(columnas.signo)}», que el perfil no reconoce` };
    }
    const leido = analizarImporte(celda(columnas.importe), { ...opciones, invertirSigno: false });
    if (!leido.ok) return leido;
    const valor = new Decimal(leido.valor).abs();
    const firmado = esCargo ? valor.neg() : valor;
    const final = perfil.importe.invertirSigno ? firmado.neg() : firmado;
    // Los decimales son los que traía la celda, no dos fijos: la columna guarda
    // cuatro, y recortar aquí descuadra después la cadena de saldos por la
    // fracción de centavo que se tiró (ver `derivarSaldos`).
    return { ok: true, valor: enMoneda(final.isZero() ? new Decimal(0) : final), aviso: leido.aviso };
  }

  return analizarImporte(celda(columnas.importe), opciones);
}

// ============================================================
// MEMBRETE Y SALDOS
// ============================================================

function leerPreambulo(
  filas: FilaCruda[],
  perfil: PerfilCsv,
  extracto: ExtractoLeido,
  avisos: ColectorAvisos
): void {
  if (!perfil.preambulo || filas.length === 0) return;
  const texto = filas.map((f) => f.texto).join('\n');

  const cuenta = perfil.preambulo.cuenta?.exec(texto);
  if (cuenta) extracto.cuentaDeclarada = (cuenta[1] ?? cuenta[0]).trim();

  const moneda = perfil.preambulo.moneda?.exec(texto);
  if (moneda) extracto.moneda = (moneda[1] ?? moneda[0]).trim().toUpperCase();

  const numero = perfil.preambulo.numeroDeEstado?.exec(texto);
  if (numero) extracto.numeroDeEstado = (numero[1] ?? numero[0]).trim();

  if (!extracto.cuentaDeclarada && perfil.preambulo.cuenta) {
    // Sin cuenta declarada la prueba de identidad no se puede correr, y esa
    // prueba es lo único que impide importar el extracto de una cuenta contra
    // otra. Vale un aviso aunque el archivo se lea perfecto.
    avisos.agregar(
      'No se encontró el número de cuenta en el membrete: la prueba de identidad de cuenta ' +
        'no podrá correrse con este archivo.'
    );
  }
}

/**
 * Deriva los dos saldos del estado a partir del saldo corrido de las líneas.
 *
 * Un CSV casi nunca publica saldo inicial y saldo final, y `bank_statements`
 * los declara NOT NULL porque sin ellos la conciliación compara contra cero.
 * La derivación es aritmética honesta —el saldo de la primera línea menos su
 * propio importe es el saldo con el que abrió el periodo— pero SIGUE SIENDO
 * una derivación, no un dato del banco, y por eso siempre deja aviso.
 *
 * Los extremos se buscan por FECHA y no por posición: hay exportadores que
 * escriben el archivo del movimiento más nuevo al más viejo, y tomar «la
 * primera fila» ahí devuelve el saldo de cierre como saldo de apertura.
 */
function derivarSaldos(
  lineas: LineaLeida[],
  saldos: (string | null)[],
  extracto: ExtractoLeido,
  avisos: ColectorAvisos
): void {
  if (saldos.every((s) => s === null)) return;

  const descendente = lineas.length > 1 && lineas[0].fecha > lineas[lineas.length - 1].fecha;
  if (descendente) {
    avisos.agregar(
      'El archivo viene del movimiento más reciente al más antiguo; los saldos se derivaron de ' +
        'los extremos por fecha, no por posición.'
    );
  }

  // Con varias líneas en la MISMA fecha extrema, la que lleva el saldo bueno es
  // la última que el banco escribió de ese día: la primera del archivo si viene
  // en orden descendente, la última si viene ascendente.
  let iPrimera = 0;
  let iUltima = 0;
  for (let i = 1; i < lineas.length; i++) {
    const f = lineas[i].fecha;
    if (f < lineas[iPrimera].fecha || (f === lineas[iPrimera].fecha && descendente)) iPrimera = i;
    if (f > lineas[iUltima].fecha || (f === lineas[iUltima].fecha && !descendente)) iUltima = i;
  }

  const saldoFinal = saldos[iUltima];
  const saldoPrimera = saldos[iPrimera];
  if (saldoFinal === null || saldoPrimera === null) {
    avisos.agregar(
      'Hay columna de saldo pero falta el valor en algún extremo del periodo: no se derivaron ' +
        'los saldos de apertura y cierre.'
    );
    return;
  }

  extracto.saldoFinal = saldoFinal;
  // La RESTA se guarda entera. Redondearla a dos era descuadrar el documento por
  // construcción: con un saldo corrido de 0.1250 y una primera línea de 0.0625,
  // la apertura derivada valía 0.06 y la cadena de saldos denunciaba 0.0025 de
  // diferencia sobre un archivo cuyo propio saldo corrido es impecable.
  extracto.saldoInicial = enMoneda(
    new Decimal(saldoPrimera).minus(lineas[iPrimera].importe)
  );
  avisos.agregar(
    `El archivo no publica saldos de estado: se DERIVARON del saldo corrido (inicial ` +
      `${extracto.saldoInicial}, final ${extracto.saldoFinal}). Confírmalos contra el estado en ` +
      'papel antes de cerrar la conciliación.'
  );
}

// ============================================================
// EL TOKENIZADOR
//
// Sí, a mano. La alternativa era una dependencia de parseo, y el proyecto ya
// decidió tener UNA (fast-xml-parser). Lo que hace falta aquí cabe en un
// autómata: comillas RFC 4180 con la comilla doble como escape, delimitador
// configurable, y los tres finales de línea que sueltan los exportadores.
//
// Lo que NO cabía en `split(',')` y por eso está: una descripción con coma
// dentro («PAGO, REF 4471») y una descripción con salto de línea dentro. Las
// dos son comunes y las dos corren las columnas de una fila sin avisar. Por
// eso además se guarda la línea FÍSICA de inicio del registro: es lo que hace
// que un aviso se pueda comprobar abriendo el archivo.
// ============================================================

function tokenizar(texto: string, delimitador: string): { filas: FilaCruda[]; aviso?: string } {
  const filas: FilaCruda[] = [];
  let celdas: string[] = [];
  let celda = '';
  let enComillas = false;
  let linea = 1;
  let lineaInicio = 1;
  let indiceInicio = 0;
  let i = 0;

  const cerrar = (fin: number): void => {
    celdas.push(celda);
    celda = '';
    const cruda: FilaCruda = { linea: lineaInicio, celdas, texto: texto.slice(indiceInicio, fin) };
    // Una línea en blanco no es una fila: los exportadores las intercalan como
    // separación y contarlas como movimiento corrupto llenaría los avisos de
    // ruido que no describe ningún problema.
    if (!(cruda.celdas.length === 1 && cruda.celdas[0].trim() === '')) filas.push(cruda);
    celdas = [];
  };

  while (i < texto.length) {
    const ch = texto[i];

    if (enComillas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          celda += '"';
          i += 2;
          continue;
        }
        enComillas = false;
        i++;
        continue;
      }
      if (ch === '\n') linea++;
      celda += ch;
      i++;
      continue;
    }

    if (ch === '"' && celda === '') {
      enComillas = true;
      i++;
      continue;
    }
    if (ch === delimitador) {
      celdas.push(celda);
      celda = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      cerrar(i);
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      i++;
      linea++;
      lineaInicio = linea;
      indiceInicio = i;
      continue;
    }

    celda += ch;
    i++;
  }

  if (celda !== '' || celdas.length > 0) cerrar(texto.length);

  return {
    filas,
    aviso: enComillas
      ? `El archivo termina con una comilla sin cerrar (desde la línea ${lineaInicio}); la última fila puede haber quedado mal cortada.`
      : undefined,
  };
}
