import { ValidationError } from '../../../utils/errors.js';
import { crearAvisos, recortar, type ColectorAvisos } from './avisos.js';
import { analizarFecha, fechaDeOperacionMt940 } from './fecha.js';
import { analizarImporte } from './importe.js';
import { decodificar, enLineas, type Codificacion } from './texto.js';
import type { ExtractoLeido, LineaLeida } from './tipos.js';

// ============================================================
// MT940 — EL EXTRACTO DE SWIFT
//
// Texto plano de los años ochenta, y sigue siendo lo que muchos bancos
// entregan a una tesorería. Trae los dos saldos (:60F: y :62F:) con su fecha y
// su moneda, que es lo que lo hace utilizable como estado de cuenta de verdad.
//
// TRES COSAS QUE SE HACEN MAL CASI SIEMPRE AL LEERLO:
//
// 1. LAS MARCAS DE REVERSO. El campo :61: no lleva sólo C y D: lleva RC y RD,
//    que son la reversión de un crédito y de un débito. Una lectura que sólo
//    mire la primera letra convierte un reverso de crédito (RC, sale dinero)
//    en un crédito (entra dinero) y descuadra el extracto por el DOBLE del
//    importe. La alternancia se prueba con RC|RD antes que con C|D a propósito.
//
// 2. LA FECHA DE OPERACIÓN NO TRAE AÑO. :61: publica la fecha valor completa
//    (YYMMDD) y la de operación como un MMDD suelto, cuyo año hay que deducir.
//    En el cambio de año eso pone un movimiento a doce meses de distancia.
//
// 3. LAS CONTINUACIONES. Un :86: puede ocupar seis líneas, y las cinco
//    siguientes no empiezan con «:». Tratar cada línea como un campo pierde
//    cinco sextos de las descripciones, que es justo lo que después necesita
//    el cotejo por texto.
// ============================================================

export interface OpcionesMt940 {
  codificacion?: Codificacion;
  maxAvisos?: number;
}

interface Campo {
  etiqueta: string;
  valor: string;
  linea: number;
}

/** Etiquetas que este lector entiende. El resto se cuenta y se avisa. */
const CONOCIDAS = new Set(['20', '21', '25', '28', '28C', '60F', '60M', '61', '62F', '62M', '86']);

export function leerMt940(entrada: string | Buffer, opciones: OpcionesMt940 = {}): ExtractoLeido {
  const avisos = crearAvisos(opciones.maxAvisos);
  const decodificado = decodificar(entrada, opciones.codificacion ?? 'auto');
  decodificado.avisos.forEach((a) => avisos.agregar(a));

  if (decodificado.texto.trim() === '') {
    throw new ValidationError('El archivo está vacío: no tiene ni una línea que leer.');
  }

  const campos = trocear(decodificado.texto);
  if (campos.length === 0 || !campos.some((c) => c.etiqueta === '61' || c.etiqueta === '60F')) {
    throw new ValidationError(
      'El archivo no parece un MT940: no se encontró ningún campo :61: (movimiento) ni :60F: ' +
        '(saldo de apertura).'
    );
  }

  // Un archivo con varios :20: son varios extractos consecutivos —páginas del
  // mismo mes, o meses distintos—. Fundirlos produciría un documento con dos
  // saldos de apertura, así que se lee el primero y se dice cuántos hay.
  const inicios = campos.filter((c) => c.etiqueta === '20');
  if (inicios.length > 1) {
    avisos.agregar(
      `El archivo trae ${inicios.length} extractos (:20: repetido); se leyó el primero y se ` +
        `ignoraron ${inicios.length - 1}. Sepáralos para importarlos todos.`
    );
  }
  const delPrimero = inicios.length > 1 ? campos.slice(0, indiceDe(campos, inicios[1])) : campos;

  const extracto: ExtractoLeido = { formato: 'mt940', lineas: [], avisos: [] };

  const cuenta = delPrimero.find((c) => c.etiqueta === '25');
  if (cuenta) extracto.cuentaDeclarada = cuenta.valor.trim();

  const secuencia = delPrimero.find((c) => c.etiqueta === '28C' || c.etiqueta === '28');
  const referenciaInicial = delPrimero.find((c) => c.etiqueta === '20');
  extracto.numeroDeEstado = secuencia?.valor.trim() ?? referenciaInicial?.valor.trim();

  leerSaldos(delPrimero, extracto, avisos);
  extracto.lineas = leerMovimientos(delPrimero, avisos);

  for (const campo of delPrimero) {
    if (!CONOCIDAS.has(campo.etiqueta)) {
      avisos.agregarUnaVez(
        `etiqueta:${campo.etiqueta}`,
        `El archivo trae campos :${campo.etiqueta}: que este lector no interpreta (visto por primera vez en la línea ${campo.linea}); se ignoraron.`
      );
    }
  }

  if (!extracto.periodoInicio || !extracto.periodoFin) {
    const fechas = extracto.lineas.map((l) => l.fecha);
    if (fechas.length > 0) {
      extracto.periodoInicio ??= fechas.reduce((a, b) => (a < b ? a : b));
      extracto.periodoFin ??= fechas.reduce((a, b) => (a > b ? a : b));
      avisos.agregar(
        'Falta algún saldo con su fecha; el periodo se tomó del rango de los movimientos, que ' +
          'puede ser más corto que el periodo real del estado.'
      );
    }
  }

  extracto.avisos = avisos.listar();
  return extracto;
}

/**
 * Corta el archivo en campos, uniendo las continuaciones.
 *
 * La regla del formato es simple y es la que casi nadie implementa: una línea
 * que NO empieza con «:etiqueta:» es continuación de la anterior. El separador
 * de bloques («-») cierra el mensaje y no es un campo.
 */
function trocear(texto: string): Campo[] {
  const campos: Campo[] = [];
  let actual: Campo | null = null;

  enLineas(texto).forEach((linea, i) => {
    const numero = i + 1;
    const limpia = linea.replace(/\s+$/, '');
    if (limpia.trim() === '' || limpia.trim() === '-') return;

    const encabezado = /^:(\d{2}[A-Z]?):(.*)$/.exec(limpia);
    if (encabezado) {
      actual = { etiqueta: encabezado[1], valor: encabezado[2], linea: numero };
      campos.push(actual);
      return;
    }
    if (actual) {
      // El salto se conserva: en :61: la línea 2 es información suplementaria y
      // en :86: cada línea es un renglón del banco. Fundirlas sin separador
      // pega palabras que después no casan en el cotejo por texto.
      actual.valor += `\n${limpia}`;
    }
  });

  return campos;
}

function indiceDe(campos: Campo[], campo: Campo): number {
  return campos.indexOf(campo);
}

function leerSaldos(campos: Campo[], extracto: ExtractoLeido, avisos: ColectorAvisos): void {
  const apertura = campos.find((c) => c.etiqueta === '60F') ?? campos.find((c) => c.etiqueta === '60M');
  const cierre = campos.find((c) => c.etiqueta === '62F') ?? campos.find((c) => c.etiqueta === '62M');

  const leido = (campo: Campo | undefined, cual: string): SaldoMt940 | undefined => {
    if (!campo) {
      avisos.agregar(`El archivo no trae el saldo de ${cual} (:${cual === 'apertura' ? '60F' : '62F'}:).`);
      return undefined;
    }
    const saldo = leerSaldo(campo.valor);
    if (!saldo) {
      avisos.agregar(
        `Línea ${campo.linea}: el saldo de ${cual} no se pudo leer: «${recortar(campo.valor)}».`
      );
      return undefined;
    }
    // :60M: y :62M: son saldos INTERMEDIOS: el extracto viene paginado y este
    // no es el saldo del periodo completo. Se usa, porque es lo que hay, pero
    // la cadena de saldos que lo compare con el estado anterior tiene derecho a
    // saberlo.
    if (campo.etiqueta.endsWith('M')) {
      avisos.agregar(
        `El saldo de ${cual} viene como :${campo.etiqueta}: (intermedio): el archivo es una página ` +
          'de un extracto más largo, no el estado completo.'
      );
    }
    return saldo;
  };

  const a = leido(apertura, 'apertura');
  const c = leido(cierre, 'cierre');

  if (a) {
    extracto.saldoInicial = a.valor;
    extracto.periodoInicio = a.fecha;
    extracto.moneda = a.moneda;
  }
  if (c) {
    extracto.saldoFinal = c.valor;
    extracto.periodoFin = c.fecha;
    extracto.moneda ??= c.moneda;
    if (a && a.moneda !== c.moneda) {
      avisos.agregar(
        `Los saldos de apertura (${a.moneda}) y cierre (${c.moneda}) vienen en monedas distintas; ` +
          'se conservó la de apertura.'
      );
    }
  }
}

interface SaldoMt940 {
  valor: string;
  fecha: string;
  moneda: string;
}

/** `C260101MXN1000,00` — marca, fecha YYMMDD, moneda ISO y el importe con coma decimal. */
function leerSaldo(valor: string): SaldoMt940 | undefined {
  const m = /^([CD])(\d{6})([A-Z]{3})([\d.,]+)/.exec(valor.trim());
  if (!m) return undefined;

  const fecha = analizarFecha(m[2], 'YYMMDD');
  if (!fecha.ok) return undefined;

  const importe = analizarImporte(m[4], { separadorDecimal: ',' });
  if (!importe.ok) return undefined;

  // «D» en un saldo es SALDO DEUDOR: la cuenta está en rojo.
  return {
    valor: m[1] === 'D' ? negar(importe.valor) : importe.valor,
    fecha: fecha.valor,
    moneda: m[3],
  };
}

/**
 * `2601050105D250,00NTRFREF-123//BANCO-9`
 *
 *  YYMMDD  fecha valor
 *  MMDD    fecha de operación (opcional)
 *  C/D/RC/RD  sentido, con los dos reversos
 *  [A-Z]   código de fondos (opcional, casi nunca usado)
 *  15d     importe con coma decimal
 *  [NFS]xxx tipo de transacción
 *  16x     referencia del cliente, y tras «//» la del banco
 */
const LINEA_61 =
  /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([\d.,]+)([NFS][A-Z0-9]{3})?(.*)$/;

function leerMovimientos(campos: Campo[], avisos: ColectorAvisos): LineaLeida[] {
  const lineas: LineaLeida[] = [];

  campos.forEach((campo, i) => {
    if (campo.etiqueta === '86' && lineas.length === 0) {
      avisos.agregarUnaVez(
        'descripcion-huerfana',
        `Línea ${campo.linea}: hay un :86: antes del primer movimiento; es información del estado, ` +
          'no de una línea, y se ignoró.'
      );
      return;
    }
    if (campo.etiqueta !== '61') return;

    const [primera, ...suplementarias] = campo.valor.split('\n');
    const m = LINEA_61.exec(primera.trim());
    if (!m) {
      avisos.agregar(
        `Línea ${campo.linea}: el campo :61: no tiene la forma esperada. Se omitió: «${recortar(primera)}».`
      );
      return;
    }

    const [, yymmdd, mmdd, marca, , importeCrudo, tipo, resto] = m;

    const fechaValor = analizarFecha(yymmdd, 'YYMMDD');
    if (!fechaValor.ok) {
      avisos.agregar(`Línea ${campo.linea}: ${fechaValor.motivo}. Se omitió.`);
      return;
    }

    let fecha = fechaValor.valor;
    if (mmdd) {
      const operacion = fechaDeOperacionMt940(fechaValor.valor, mmdd);
      if (operacion.ok) fecha = operacion.valor;
      else avisos.agregar(`Línea ${campo.linea}: ${operacion.motivo}; se usó la fecha valor.`);
    }

    const importe = analizarImporte(importeCrudo, { separadorDecimal: ',' });
    if (!importe.ok) {
      avisos.agregar(`Línea ${campo.linea}: ${importe.motivo}. Se omitió.`);
      return;
    }

    // D y RC sacan dinero; C y RD lo meten. El reverso invierte el sentido de
    // lo que reversa, no lo repite.
    const sale = marca === 'D' || marca === 'RC';
    const referencias = resto.split('//');
    const referencia = referencias[0].trim() || undefined;

    // El :86: que sigue es la descripción de ESTE movimiento. Se busca hacia
    // adelante y no hacia atrás porque el formato lo pone después.
    const descripcion = campos[i + 1]?.etiqueta === '86' ? limpiar86(campos[i + 1].valor) : '';

    lineas.push({
      fecha,
      fechaValor: fechaValor.valor,
      importe: sale ? negar(importe.valor) : importe.valor,
      descripcion: descripcion || referencia || '',
      referencia,
      tipo,
      crudo: {
        __linea: campo.linea,
        '61': primera.trim(),
        '61_suplementario': suplementarias.length > 0 ? suplementarias.join('\n') : undefined,
        '86': campos[i + 1]?.etiqueta === '86' ? campos[i + 1].valor : undefined,
        marca,
        referenciaBanco: referencias[1]?.trim(),
        esReverso: marca === 'RC' || marca === 'RD',
      },
    });
  });

  return lineas;
}

/**
 * El :86: viene en renglones de 65 caracteres cortados por el ancho del télex,
 * no por sentido: la palabra partida entre dos renglones se vuelve a unir al
 * juntarlos con un espacio, y `content_hash` depende de esa descripción.
 */
function limpiar86(valor: string): string {
  return valor
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function negar(valor: string): string {
  if (valor.startsWith('-')) return valor.slice(1);
  return /^0+(\.0+)?$/.test(valor) ? valor : `-${valor}`;
}
