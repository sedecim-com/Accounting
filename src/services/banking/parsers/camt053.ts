import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ValidationError } from '../../../utils/errors.js';
import { crearAvisos, type ColectorAvisos } from './avisos.js';
import { analizarFecha } from './fecha.js';
import { analizarImporte } from './importe.js';
import { decodificar, type Codificacion } from './texto.js';
import type { ExtractoLeido, LineaLeida } from './tipos.js';

// ============================================================
// camt.053 — EL ESTADO DE CUENTA DE ISO 20022
//
// Es el único de los tres formatos que fue DISEÑADO para ser un estado de
// cuenta, y se nota en lo que trae: los saldos de apertura y cierre vienen
// etiquetados (OPBD/CLBD), el periodo viene declarado (FrToDt) y la secuencia
// electrónica también (ElctrncSeqNb). Eso es exactamente lo que el resto del
// tramo necesita y lo que un CSV obliga a derivar.
//
// DOS DECISIONES QUE NO SON OBVIAS:
//
// 1. EL SIGNO NO ESTÁ EN EL IMPORTE. camt escribe todos los montos sin signo y
//    pone el sentido en `CdtDbtInd`. DBIT sale negativo aquí porque en este
//    módulo negativo significa «sale dinero de la cuenta», y un extracto donde
//    el signo dependa del formato de origen no se puede conciliar.
//
// 2. LOS ASIENTOS NO CONTABILIZADOS SE EXCLUYEN. Un camt.053 es el estado
//    CERRADO: todo lo que trae debería venir con `Sts=BOOK`. Si aparece un
//    PDNG es que alguien exportó un camt.052 (informe intradía) con el nombre
//    equivocado, y meter dinero pendiente en el estado rompe la cadena de
//    saldos —el CLBD del banco no lo incluye— sin que nada lo diga. Se
//    excluye y se nombra en `avisos`.
//
// Sobre `parseTagValue: false`: es la línea más importante del archivo. Con el
// valor por omisión, fast-xml-parser convierte «1000.00» en el número 1000 y
// «0007» en 7, y a partir de ahí el dinero ya viajó por un float. Aquí todo
// sale como texto y lo valida decimal.js.
// ============================================================

export interface OpcionesCamt053 {
  codificacion?: Codificacion;
  maxAvisos?: number;
}

/** Códigos de saldo de ISO 20022, en orden de preferencia para cada extremo. */
const SALDOS_APERTURA = ['OPBD', 'PRCD', 'OPAV'] as const;
const SALDOS_CIERRE = ['CLBD', 'CLAV', 'ITBD'] as const;

export function leerCamt053(
  entrada: string | Buffer,
  opciones: OpcionesCamt053 = {}
): ExtractoLeido {
  const avisos = crearAvisos(opciones.maxAvisos);
  const decodificado = decodificar(entrada, opciones.codificacion ?? 'auto');
  decodificado.avisos.forEach((a) => avisos.agregar(a));

  if (decodificado.texto.trim() === '') {
    throw new ValidationError('El archivo está vacío: no tiene ni una línea que leer.');
  }

  // El espacio de nombres se busca en el TEXTO y no en el árbol: con
  // `removeNSPrefix` —que es lo que permite leer `<Ntry>` sin saber qué prefijo
  // eligió el banco— fast-xml-parser borra también las declaraciones `xmlns`,
  // así que preguntárselo al árbol devuelve siempre `undefined` y el guardia de
  // abajo no guardaría nada.
  const declarado =
    /xmlns(?::[A-Za-z0-9_.-]+)?\s*=\s*["'](urn:iso:std:iso:20022:tech:xsd:camt\.[^"']*)["']/.exec(
      decodificado.texto.slice(0, 8192)
    );
  if (declarado && !declarado[1].includes('camt.053')) {
    // Un camt.054 es una NOTIFICACIÓN de movimientos y un camt.052 un informe
    // intradía: ninguno trae saldos de apertura y cierre, así que aceptarlos
    // aquí produciría un `bank_statements` con dos ceros.
    throw new ValidationError(
      `Este XML declara «${declarado[1]}», que no es camt.053. Un camt.052 o un camt.054 no traen ` +
        'saldos de apertura y cierre, así que no pueden entrar como estado de cuenta.'
    );
  }
  if (!declarado) {
    avisos.agregar('El XML no declara espacio de nombres camt; se leyó como camt.053 por su estructura.');
  }

  // fast-xml-parser NO valida por omisión: se traga un documento con etiquetas
  // sin cerrar y devuelve el trozo que entendió. Un extracto truncado leído así
  // entra al sistema con la mitad de sus movimientos y con los saldos del
  // banco, que entonces no cuadran contra nada.
  const validacion: unknown = XMLValidator.validate(decodificado.texto);
  if (validacion !== true) {
    throw new ValidationError(`El archivo no es XML bien formado: ${motivoDeValidacion(validacion)}`);
  }

  const analizador = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Los camt reales llegan con prefijo de espacio de nombres y no siempre el
    // mismo. Quitarlo es lo que evita tener que preguntar por `ns:Ntry` y por
    // `Doc:Ntry` y por `Ntry`.
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (nombre) => ['Stmt', 'Bal', 'Ntry', 'TxDtls', 'Ustrd'].includes(nombre),
  });

  // La firma de fast-xml-parser devuelve `any`. Se estrecha a `unknown` aquí,
  // una sola vez, y a partir de esta línea todo el archivo navega el árbol con
  // guardas de tipo: el `any` no se propaga.
  let crudo: unknown;
  try {
    crudo = analizador.parse(decodificado.texto) as unknown;
  } catch (error) {
    throw new ValidationError(
      `El archivo no es XML válido: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const documento = hijo(crudo, 'Document');
  const estados = comoLista(ruta(documento, 'BkToCstmrStmt', 'Stmt'));
  if (estados.length === 0) {
    throw new ValidationError(
      'El XML no contiene ningún <Stmt> dentro de <BkToCstmrStmt>: no es un camt.053.'
    );
  }
  if (estados.length > 1) {
    // Un archivo con varios <Stmt> suele traer varias CUENTAS. Fundirlas sería
    // mezclar extractos de cuentas distintas en un solo documento; partirlos es
    // trabajo del importador, que es quien sabe a qué `bank_account_id` va cada
    // uno. Aquí se lee el primero y se dice cuántos quedaron.
    avisos.agregar(
      `El archivo trae ${estados.length} estados (<Stmt>); se leyó el primero y se ignoraron ` +
        `${estados.length - 1}. Sepáralos en archivos distintos para importarlos todos.`
    );
  }
  const estado = estados[0];

  // La moneda de la CUENTA manda sobre la del saldo: son la misma salvo en
  // exportaciones defectuosas, y ahí la de la cuenta es la que vale.
  const moneda = comoTexto(ruta(estado, 'Acct', 'Ccy')) ?? monedaDeAlgunSaldo(estado);

  const extracto: ExtractoLeido = {
    formato: 'camt053',
    cuentaDeclarada:
      comoTexto(ruta(estado, 'Acct', 'Id', 'IBAN')) ??
      comoTexto(ruta(estado, 'Acct', 'Id', 'Othr', 'Id')),
    moneda,
    numeroDeEstado:
      comoTexto(hijo(estado, 'ElctrncSeqNb')) ??
      comoTexto(hijo(estado, 'LglSeqNb')) ??
      comoTexto(hijo(estado, 'Id')),
    lineas: [],
    avisos: [],
  };

  leerSaldos(estado, extracto, avisos);
  leerPeriodo(estado, extracto, avisos);
  extracto.lineas = leerMovimientos(estado, avisos);

  if (!extracto.periodoInicio || !extracto.periodoFin) {
    const fechas = extracto.lineas.map((l) => l.fecha);
    if (fechas.length > 0) {
      extracto.periodoInicio ??= fechas.reduce((a, b) => (a < b ? a : b));
      extracto.periodoFin ??= fechas.reduce((a, b) => (a > b ? a : b));
      avisos.agregar(
        'El estado no declara periodo (<FrToDt>) ni fecha en sus saldos; se tomó el rango de las ' +
          'fechas de los movimientos, que puede ser más corto que el periodo real.'
      );
    }
  }

  extracto.avisos = avisos.listar();
  return extracto;
}

function leerSaldos(estado: unknown, extracto: ExtractoLeido, avisos: ColectorAvisos): void {
  const balances = comoLista(hijo(estado, 'Bal'));

  const apertura = primerSaldo(balances, SALDOS_APERTURA, avisos);
  const cierre = primerSaldo(balances, SALDOS_CIERRE, avisos);

  if (apertura) {
    extracto.saldoInicial = apertura.valor;
    if (apertura.codigo !== 'OPBD') {
      avisos.agregar(
        `El estado no trae saldo de apertura OPBD; se usó ${apertura.codigo} como saldo inicial.`
      );
    }
  } else {
    avisos.agregar(
      'El estado no trae saldo de apertura (ni OPBD ni PRCD): `bank_statements.opening_balance` ' +
        'tendrá que venir de otra parte.'
    );
  }

  if (cierre) {
    extracto.saldoFinal = cierre.valor;
    if (cierre.codigo !== 'CLBD') {
      avisos.agregar(
        `El estado no trae saldo de cierre CLBD; se usó ${cierre.codigo} como saldo final.`
      );
    }
  } else {
    avisos.agregar('El estado no trae saldo de cierre (CLBD ni CLAV).');
  }

  // Las fechas de los saldos son el mejor sustituto del periodo cuando el
  // estado no declara <FrToDt>: son las fechas que el propio banco puso a los
  // extremos del documento.
  if (apertura?.fecha) extracto.periodoInicio = apertura.fecha;
  if (cierre?.fecha) extracto.periodoFin = cierre.fecha;
}

interface SaldoLeido {
  codigo: string;
  valor: string;
  fecha?: string;
}

function primerSaldo(
  balances: unknown[],
  codigos: readonly string[],
  avisos: ColectorAvisos
): SaldoLeido | undefined {
  for (const codigo of codigos) {
    for (const bal of balances) {
      const propio =
        comoTexto(ruta(bal, 'Tp', 'CdOrPrtry', 'Cd')) ??
        comoTexto(ruta(bal, 'Tp', 'CdOrPrtry', 'Prtry'));
      if (propio !== codigo) continue;

      const importe = analizarImporte(comoTexto(hijo(bal, 'Amt')) ?? '', { separadorDecimal: '.' });
      if (!importe.ok) {
        avisos.agregar(`El saldo ${codigo} no se pudo leer: ${importe.motivo}.`);
        continue;
      }

      // Un saldo DBIT es un saldo DEUDOR: la cuenta está sobregirada y el
      // número vale en negativo. Ignorar el indicador aquí invierte el saldo
      // justo en las cuentas donde más duele.
      const sentido = comoTexto(hijo(bal, 'CdtDbtInd'));
      const valor = sentido === 'DBIT' ? negar(importe.valor) : importe.valor;

      const fechaCruda =
        comoTexto(ruta(bal, 'Dt', 'Dt')) ?? comoTexto(ruta(bal, 'Dt', 'DtTm'));
      const fecha = fechaCruda ? analizarFecha(fechaCruda, 'YYYY-MM-DD') : undefined;

      return { codigo, valor, fecha: fecha?.ok ? fecha.valor : undefined };
    }
  }
  return undefined;
}

function leerPeriodo(estado: unknown, extracto: ExtractoLeido, avisos: ColectorAvisos): void {
  const desde = comoTexto(ruta(estado, 'FrToDt', 'FrDtTm')) ?? comoTexto(ruta(estado, 'FrToDt', 'FrDt'));
  const hasta = comoTexto(ruta(estado, 'FrToDt', 'ToDtTm')) ?? comoTexto(ruta(estado, 'FrToDt', 'ToDt'));

  if (desde) {
    const f = analizarFecha(desde, 'YYYY-MM-DD');
    if (f.ok) extracto.periodoInicio = f.valor;
    else avisos.agregar(`La fecha de inicio del periodo no se pudo leer: ${f.motivo}.`);
  }
  if (hasta) {
    const f = analizarFecha(hasta, 'YYYY-MM-DD');
    if (f.ok) extracto.periodoFin = f.valor;
    else avisos.agregar(`La fecha de fin del periodo no se pudo leer: ${f.motivo}.`);
  }
}

function leerMovimientos(estado: unknown, avisos: ColectorAvisos): LineaLeida[] {
  const lineas: LineaLeida[] = [];
  const entradas = comoLista(hijo(estado, 'Ntry'));

  entradas.forEach((entrada, i) => {
    const posicion = `<Ntry> ${i + 1}`;
    const referencia =
      comoTexto(hijo(entrada, 'NtryRef')) ??
      comoTexto(hijo(entrada, 'AcctSvcrRef')) ??
      comoTexto(ruta(entrada, 'NtryDtls', 'TxDtls', '0', 'Refs', 'EndToEndId'));

    const estatus = comoTexto(hijo(entrada, 'Sts')) ?? comoTexto(ruta(entrada, 'Sts', 'Cd'));
    if (estatus && estatus !== 'BOOK') {
      avisos.agregar(
        `${posicion} (ref ${referencia ?? 'sin referencia'}) viene con Sts=${estatus} y no ` +
          'contabilizado: se excluyó. Un camt.053 sólo debería traer movimientos BOOK; revisa si ' +
          'lo que exportaste era en realidad un camt.052.'
      );
      return;
    }

    const sentido = comoTexto(hijo(entrada, 'CdtDbtInd'));
    if (sentido !== 'DBIT' && sentido !== 'CRDT') {
      avisos.agregar(`${posicion}: CdtDbtInd dice «${sentido ?? '(nada)'}»; sin sentido no hay signo. Se omitió.`);
      return;
    }

    const importe = analizarImporte(comoTexto(hijo(entrada, 'Amt')) ?? '', { separadorDecimal: '.' });
    if (!importe.ok) {
      avisos.agregar(`${posicion}: ${importe.motivo}. Se omitió.`);
      return;
    }

    const fechaCruda =
      comoTexto(ruta(entrada, 'BookgDt', 'Dt')) ??
      comoTexto(ruta(entrada, 'BookgDt', 'DtTm')) ??
      comoTexto(ruta(entrada, 'ValDt', 'Dt')) ??
      comoTexto(ruta(entrada, 'ValDt', 'DtTm'));
    const fecha = fechaCruda ? analizarFecha(fechaCruda, 'YYYY-MM-DD') : { ok: false as const, motivo: 'no trae fecha' };
    if (!fecha.ok) {
      avisos.agregar(`${posicion}: ${fecha.motivo}. Se omitió.`);
      return;
    }

    const valorCrudo = comoTexto(ruta(entrada, 'ValDt', 'Dt')) ?? comoTexto(ruta(entrada, 'ValDt', 'DtTm'));
    const fechaValor = valorCrudo ? analizarFecha(valorCrudo, 'YYYY-MM-DD') : undefined;

    const detalles = comoLista(ruta(entrada, 'NtryDtls', 'TxDtls'));
    if (detalles.length > 1) {
      // Un asiento por lote (una nómina, un remesado) trae N transacciones bajo
      // UN solo apunte bancario. La línea correcta es el apunte —es lo que
      // movió el saldo— pero el detalle se pierde para el cotejo, y eso hay que
      // decirlo.
      avisos.agregar(
        `${posicion} (ref ${referencia ?? 'sin referencia'}) es un asiento por lote con ` +
          `${detalles.length} transacciones; se importó como UN movimiento y el detalle quedó en raw_data.`
      );
    }

    lineas.push({
      fecha: fecha.valor,
      fechaValor: fechaValor?.ok ? fechaValor.valor : undefined,
      importe: sentido === 'DBIT' ? negar(importe.valor) : importe.valor,
      descripcion: describir(entrada, detalles) || referencia || '',
      referencia,
      tipo:
        comoTexto(ruta(entrada, 'BkTxCd', 'Prtry', 'Cd')) ??
        comoTexto(ruta(entrada, 'BkTxCd', 'Domn', 'Cd')),
      crudo: comoObjeto(entrada) ?? {},
    });
  });

  return lineas;
}

/**
 * La descripción, buscada donde los bancos la ponen de verdad.
 *
 * `AddtlNtryInf` es el campo libre y es lo primero que llena un banco; cuando
 * no está, la información remitida (`RmtInf/Ustrd`) es lo que el ordenante
 * escribió, que suele ser mejor para el cotejo que cualquier código. El nombre
 * de la contraparte queda de último recurso porque identifica a QUIÉN, no QUÉ.
 */
function describir(entrada: unknown, detalles: unknown[]): string {
  const libre = comoTexto(hijo(entrada, 'AddtlNtryInf'));
  if (libre) return libre;

  const remitida = detalles
    .flatMap((d) => comoLista(ruta(d, 'RmtInf', 'Ustrd')))
    .map((u) => comoTexto(u))
    .filter((u): u is string => u !== undefined);
  if (remitida.length > 0) return remitida.join(' ');

  for (const d of detalles) {
    const nombre =
      comoTexto(ruta(d, 'RltdPties', 'Cdtr', 'Nm')) ??
      comoTexto(ruta(d, 'RltdPties', 'Dbtr', 'Nm')) ??
      comoTexto(ruta(d, 'RltdPties', 'Cdtr', 'Pty', 'Nm')) ??
      comoTexto(ruta(d, 'RltdPties', 'Dbtr', 'Pty', 'Nm'));
    if (nombre) return nombre;
  }
  return '';
}

function monedaDeAlgunSaldo(estado: unknown): string | undefined {
  for (const bal of comoLista(hijo(estado, 'Bal'))) {
    const ccy = comoTexto(ruta(bal, 'Amt', '@_Ccy'));
    if (ccy) return ccy;
  }
  return undefined;
}

function negar(valor: string): string {
  if (valor.startsWith('-')) return valor.slice(1);
  return /^0+(\.0+)?$/.test(valor) ? valor : `-${valor}`;
}

// ============================================================
// NAVEGACIÓN TIPADA DEL ÁRBOL
//
// fast-xml-parser devuelve `any`, y `any` recorriendo un árbol de dieciocho
// niveles es exactamente cómo un typo en un nombre de etiqueta se vuelve
// `undefined` silencioso en producción. Estas cuatro funciones son la frontera:
// nada sale de aquí sin haber pasado por un `typeof`.
// ============================================================

/** El mensaje que devuelve XMLValidator, sin dejar que su `any` se propague. */
function motivoDeValidacion(validacion: unknown): string {
  const err = hijo(validacion, 'err');
  const msg = comoTexto(hijo(err, 'msg')) ?? 'estructura inválida';
  const linea = comoTexto(hijo(err, 'line'));
  return linea ? `${msg} (línea ${linea})` : msg;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function comoObjeto(valor: unknown): Record<string, unknown> | undefined {
  return esObjeto(valor) ? valor : undefined;
}

function hijo(valor: unknown, clave: string): unknown {
  if (Array.isArray(valor)) {
    const indice = Number(clave);
    return Number.isInteger(indice) ? valor[indice] : undefined;
  }
  return esObjeto(valor) ? valor[clave] : undefined;
}

function ruta(valor: unknown, ...claves: string[]): unknown {
  let actual = valor;
  for (const clave of claves) {
    if (actual === undefined || actual === null) return undefined;
    actual = hijo(actual, clave);
  }
  return actual;
}

function comoLista(valor: unknown): unknown[] {
  if (valor === undefined || valor === null) return [];
  return Array.isArray(valor) ? valor : [valor];
}

/**
 * El texto de un nodo. Contempla el caso que sí se da: con
 * `ignoreAttributes: false`, un `<Amt Ccy="MXN">100.00</Amt>` no es un string
 * sino `{ '@_Ccy': 'MXN', '#text': '100.00' }`.
 */
function comoTexto(valor: unknown): string | undefined {
  if (typeof valor === 'string') return valor.trim() === '' ? undefined : valor.trim();
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  if (esObjeto(valor)) return comoTexto(valor['#text']);
  return undefined;
}
