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
// La precedencia es la decidida en el plan, y cada capa tiene su porqué:
//
//   bandera > archivo del operador > política del despacho > omisión
//
// La bandera es la invocación explícita de un humano presente; el archivo es
// del OPERADOR de la instalación (quien responde por la máquina); la
// política es del DESPACHO (quien responde por la contabilidad); la omisión
// es conservadora (apagado). El archivo gana a la política a propósito: un
// operador que apagó el auto-posteo en su máquina no debe verlo encendido
// porque el panel diga otra cosa — apagar siempre puede ser más local que
// encender.
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
  let autoPost = UMBRALES_INGESTA_OMISION.autoPost;
  let fuenteAuto: 'bandera' | 'archivo' | 'politica' | 'omision' = 'omision';
  const polAuto = await getPolicy(ctx, 'ingest_auto_post');
  if (polAuto.defined) {
    // El vocabulario del panel está cerrado al declarar y abierto al
    // escribir: sólo el literal 'on' enciende. Un valor desconocido no puede
    // acabar posteando sin revisión.
    autoPost = polAuto.value === 'on';
    fuenteAuto = 'politica';
  }
  if (archivo.autoPost !== undefined) {
    autoPost = archivo.autoPost;
    fuenteAuto = 'archivo';
  }
  if (overrides.autoPost !== undefined) {
    autoPost = overrides.autoPost;
    fuenteAuto = 'bandera';
  }

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
    maxAmount = overrides.maxAmount;
    fuenteMax = 'bandera';
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
    autoPost,
    minConfidence: Math.min(1, Math.max(0, minConfidence)),
    maxAmount: Math.max(0, maxAmount),
    fuentes: { autoPost: fuenteAuto, minConfidence: fuenteConf, maxAmount: fuenteMax },
  };
}
