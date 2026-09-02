import {
  ingestFileValues,
  UMBRALES_INGESTA_OMISION,
  type IngestThresholds,
} from './providers/config.js';
import { getPolicy } from '../services/policy/policy-service.js';

// ============================================================
// LOS UMBRALES DEL AUTO-POSTEO, CON EL PANEL DENTRO.
//
// El auto-posteo decide si un asiento llega al mayor SIN revisión humana.
// Eso es una bifurcación de criterio contable, y la regla de la casa la
// manda al panel de políticas — pero el panel tenía las dos claves
// (`ingest_auto_post`, `ingest_auto_post_max_monto`) y NADIE las leía: el
// que gobernaba era un booleano en mnemosine.config.json, sin bitácora.
// El despacho contestaba la pregunta del panel y no cambiaba nada.
//
// LA PRECEDENCIA NO ES UN ORDEN: ES UNA ASIMETRÍA (A7).
//
// Las capas son tres —bandera (humano presente), archivo (el OPERADOR de la
// instalación) y política (el DESPACHO, que responde por la contabilidad)—
// pero no forman una cadena donde la última gana. Forman una asimetría:
//
//   APAGAR y APRETAR el tope: cualquier capa, siempre. Lo local manda.
//   ENCENDER y AFLOJAR el tope: SÓLO la política del despacho.
//
// La versión anterior era un orden, y con un orden el archivo del operador
// encendía lo que el panel había dejado en 'shadow'. La auditoría integral II
// lo ejecutó: panel en «mídelo primero» + archivo en `true` = posteo real con
// cero evidencia registrada, en silencio. Tres puertas al auto-posteo y una
// sola custodiada.
//
// La regla ya existía para el tope de monto y ahora rige las tres decisiones:
// quien pagó el peaje de la evidencia es quien puede gastarlo.
//
// Cada valor sale con su FUENTE, porque cuando algo se postea sin humano la
// bitácora tiene que poder decir quién lo decidió.
// ============================================================

type Ctx = { tenantId: string; entityId?: string };

export async function resolverUmbralesConPanel(
  overrides: Partial<Pick<IngestThresholds, 'autoPost' | 'minConfidence' | 'maxAmount'>>,
  ctx: Ctx,
  cwd = process.cwd()
): Promise<IngestThresholds> {
  const archivo = ingestFileValues(cwd);
  const num = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  // ── autoPost ──
  //
  // A7 · LA ASIMETRÍA: APAGAR ES LOCAL, ENCENDER NO.
  //
  // Hasta A4 el archivo y la bandera SOBRESCRIBÍAN esta capa, y eso abría
  // tres puertas al auto-posteo con una sola custodiada. La auditoría
  // integral II lo verificó ejecutando: panel en 'shadow' + archivo en
  // `true` = el despacho postea de verdad y NO registra ni un veredicto de
  // sombra. Contestar «mídelo primero» en el panel producía posteo real con
  // cero evidencia, en silencio.
  //
  // El tope de monto ya vivía bajo la regla correcta (el archivo sólo gana si
  // es MÁS ESTRICTO); el interruptor no. Ahora sí: apagar puede ser más local
  // —un operador que no quiere auto-posteo en su máquina manda sobre su
  // máquina—, pero ENCENDER es del despacho, porque el despacho es quien
  // responde por la contabilidad y quien pagó el peaje de la evidencia.
  const polAuto = await getPolicy(ctx, 'ingest_auto_post');
  // A4: la sombra SOLO la enciende el panel — sin bandera ni archivo. Es la
  // decisión del despacho de medir, no un override de corrida; y sigue viva
  // aunque una bandera --no-auto-post apague el interruptor real.
  const sombra = polAuto.defined && polAuto.value === 'shadow';

  // El vocabulario del panel está cerrado al declarar y abierto al escribir:
  // sólo el literal 'on' enciende ('shadow' NO postea: opina). Un valor
  // desconocido no puede acabar posteando sin revisión.
  const autorizado = polAuto.defined
    ? polAuto.value === 'on'
    : UMBRALES_INGESTA_OMISION.autoPost;
  let autoPost = autorizado;
  let fuenteAuto: 'bandera' | 'archivo' | 'politica' | 'omision' = polAuto.defined
    ? 'politica'
    : 'omision';

  /** Sólo se acepta la capa local cuando APAGA: encender es del panel. */
  const aplicarLocal = (
    valor: boolean | undefined,
    fuente: 'archivo' | 'bandera'
  ): void => {
    if (valor === undefined) return;
    if (valor === false) {
      autoPost = false;
      fuenteAuto = fuente;
      return;
    }
    // valor === true sobre un panel que no lo autorizó: se IGNORA. No es un
    // error del usuario —puede ser un archivo viejo— pero tampoco es una
    // decisión que esta capa pueda tomar, así que ni enciende ni revienta la
    // corrida: la fuente sigue siendo la política, que es la verdad.
    if (autorizado) {
      autoPost = true;
      fuenteAuto = fuente;
    }
  };
  aplicarLocal(archivo.autoPost, 'archivo');
  aplicarLocal(overrides.autoPost, 'bandera');

  // Lo que la capa local INTENTÓ y no pudo, dicho: un archivo o una bandera
  // que pedían encender sobre un panel que no autoriza no deben desaparecer
  // en silencio — el operador tiene que poder entender por qué su `true` no
  // hizo nada, y el rastro tiene que poder decirlo.
  const encendidoIgnorado =
    !autorizado &&
    (archivo.autoPost === true || overrides.autoPost === true);

  // ── maxAmount ──
  let maxAmount = UMBRALES_INGESTA_OMISION.maxAmount;
  let fuenteMax: 'bandera' | 'archivo' | 'politica' | 'omision' = 'omision';
  const polMax = await getPolicy(ctx, 'ingest_auto_post_max_monto');
  const maxPolitica = polMax.defined ? num(Number(polMax.value)) : undefined;
  if (maxPolitica !== undefined) {
    maxAmount = maxPolitica;
    fuenteMax = 'politica';
  }
  if (archivo.maxAmount !== undefined) {
    // El tope del archivo sólo gana si es MÁS ESTRICTO que el del despacho.
    // El operador puede bajar la exposición de su máquina; subirla por encima
    // de lo que el despacho contestó en el panel invertiría quién responde
    // por la contabilidad.
    if (maxPolitica === undefined || archivo.maxAmount <= maxPolitica) {
      maxAmount = archivo.maxAmount;
      fuenteMax = 'archivo';
    }
  }
  if (overrides.maxAmount !== undefined && num(overrides.maxAmount) !== undefined) {
    // A7: la bandera vivía FUERA de la asimetría que el archivo ya respetaba,
    // así que `--max-amount 999999` subía el tope por encima de lo que el
    // despacho contestó en el panel. Apretar es de cualquiera; aflojar, del
    // panel. (El piso duro de floor.ts sigue debajo de todo esto: ni el panel
    // puede pasar de FLOOR_MAX_AUTO_POST.)
    const tope = maxPolitica ?? Infinity;
    if (overrides.maxAmount <= tope) {
      maxAmount = overrides.maxAmount;
      fuenteMax = 'bandera';
    }
  }

  // ── minConfidence ── (sin clave en el panel: bandera > archivo > omisión)
  let minConfidence = UMBRALES_INGESTA_OMISION.minConfidence;
  let fuenteConf: 'bandera' | 'archivo' | 'omision' = 'omision';
  if (archivo.minConfidence !== undefined) {
    minConfidence = archivo.minConfidence;
    fuenteConf = 'archivo';
  }
  if (num(overrides.minConfidence) !== undefined) {
    minConfidence = overrides.minConfidence as number;
    fuenteConf = 'bandera';
  }

  return {
    sombra,
    autoPost,
    encendidoIgnorado,
    minConfidence: Math.min(1, Math.max(0, minConfidence)),
    maxAmount: Math.max(0, maxAmount),
    fuentes: { autoPost: fuenteAuto, minConfidence: fuenteConf, maxAmount: fuenteMax },
  };
}
