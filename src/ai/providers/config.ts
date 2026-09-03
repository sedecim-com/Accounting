import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { ProviderProfile, ResolvedProfile, VentanaContexto } from './types.js';

// ============================================================
// PROVIDER CONFIG
// Built-in profiles + configuration file + overrides.
// Precedence (standard practice for CLI harnesses):
//   --provider flag  >  env MNEMOSINE_PROVIDER  >  config default_provider  >  'anthropic'
// API keys ALWAYS live in environment variables; the config
// only names the variable (api_key_env).
// Files: ./mnemosine.config.json (project) > ~/.mnemosine/config.json (user)
// ============================================================

// ============================================================
// REPRODUCIBILIDAD DEL PERFIL — lo que hace COMPARABLES dos corridas
//
// El arnés de evaluación (scripts/eval-clasificador.ts) anexa cada corrida a
// docs/evals/clasificador.jsonl y la compara contra la anterior del mismo
// proveedor+modelo: imprime «mejoró/empeoró» por clase. Esa flecha sólo
// significa algo si entre las dos corridas cambió el CLASIFICADOR y no el azar
// del muestreo. Sin temperatura fija y sin un id de modelo que no se mueva bajo
// los pies, dos corridas no son comparables NI EN PRINCIPIO, y la premisa del
// arnés está rota antes de empezar.
//
// MEDIDO, NO ARGUMENTADO. Tres corridas del MISMO caso, el mismo perfil y el
// mismo modelo (ollama · gemma4:26b, 2026-09-02, tests/golden/cfdi/pue-recibido)
// dieron global 0.750, 0.750 y 0.000: las dos primeras clasificaron con
// confianza 0.70 y 0.80, y la tercera ni siquiera clasificó — preguntó. No es
// que la calibración oscile en el tercer decimal: el RESULTADO de clase cambia
// entre corridas idénticas. Sobre eso el arnés estaba dispuesto a imprimir una
// flecha de tendencia. Llevaba un año sin ejecutarse y ese ruido no lo había
// visto nadie.
//
// Por eso cada perfil declara aquí su postura, y NINGUNO PUEDE CALLARSE: el
// campo es obligatorio en el tipo, así que un perfil nuevo sin declarar no
// compila. Un default silencioso sería justo el modo de fallo que esto viene a
// cerrar — el que dejó once perfiles sin un solo `temperature` durante un año.
// ============================================================

/**
 * `fijado`   — el muestreo se puede clavar; `temperature` dice en cuánto.
 * `no-admite` — el proveedor RECHAZA fijarlo, o el perfil no es evaluable en
 *               absoluto. `razon` dice cuál de las dos y por qué. No se finge
 *               una temperatura que la API devolvería como 400.
 */
export type PosturaMuestreo = 'fijado' | 'no-admite';

export interface Reproducibilidad {
  muestreo: PosturaMuestreo;
  /** Temperatura del clasificador. Presente si y sólo si muestreo === 'fijado'. */
  temperature?: number;
  /**
   * Id FECHADO del modelo, para pedir la misma instantánea en cada corrida en
   * vez de un alias que el proveedor repunta cuando quiere. `null` = este
   * perfil no fija ninguna; `razon` dice si es porque el proveedor no publica
   * instantáneas fechadas o porque nadie la ha establecido todavía.
   */
  instantanea: string | null;
  /** Por qué. Obligatoria y sustantiva: una postura sin motivo es una opinión. */
  razon: string;
}

export type PerfilReproducible = ProviderProfile & { reproducibilidad: Reproducibilidad };

// ============================================================
// VENTANA DE CONTEXTO — y por qué la ventana NO es el umbral
//
// El tipo vive en types.ts; aquí se declara perfil por perfil y se deriva el
// umbral de compactación. Dos decisiones que conviene no enterrar:
//
// 1) QUÉ SE DECLARA. Sólo un número que se pueda sostener. Ante la duda,
//    `desconocida` con su razón: equivocarse HACIA ARRIBA es el fallo caro
//    —el umbral queda por encima de lo que el proveedor acepta y la sesión
//    revienta igual que antes—, mientras que `desconocida` cae al respaldo
//    global de 150 000, o sea exactamente la conducta de hoy. De doce
//    perfiles, cuatro traen número y ocho dicen que no lo saben.
//
// 2) CUÁNTO DE LA VENTANA SE PUEDE LLENAR DE HISTORIA. La mitad, y el resto
//    es reserva. El número sale de lo que el umbral NO PUEDE VER, porque
//    estimateViewTokens sólo mide la vista de mensajes:
//      · las herramientas del arnés — MEDIDAS: 25 herramientas, 19 700
//        caracteres de esquema JSON ≈ 4 925 tokens que viajan en CADA
//        petición y que la vista no cuenta;
//      · los bloques de sistema — el rol, el catálogo de cuentas de la
//        entidad, el digest de memoria y las destrezas; miles de tokens más,
//        y crecen con la entidad;
//      · la respuesta, que ya viaja pedida en la petición: MAX_TOKENS es
//        16 000 en el runner Anthropic y 8 192 en el compatible;
//      · y lo que el turno añade DESPUÉS del chequeo: el umbral se mira
//        ANTES de que entre el mensaje del usuario, y el bucle agéntico
//        puede dar hasta 25 vueltas de herramienta con sus resultados.
//    Sumado sobre la ventana más pequeña que declaramos (32 768): 4 925 +
//    sistema + 8 192 de respuesta ya rozan la mitad. Por eso la mitad, y no
//    dos tercios.
//
// 3) EL UMBRAL SOLO NO BASTA. La compactación conserva una cola reciente
//    intacta de 20 000 tokens por omisión; con un umbral de 16 384 esa cola
//    se lo come entero y planCompaction devolvería null SIEMPRE: el paso
//    existiría y no sería ALCANZABLE. Por eso, cuando el umbral se deriva,
//    la cola se deriva con él (la mitad del umbral, nunca por encima de la
//    omisión del compactador). El `keep_recent_tokens` del operador sigue
//    ganando sobre esto igual que su `threshold_tokens`.
//
// LO QUE ESTO NO SABE: `--model` NO mueve la ventana. La declaración es del
// PERFIL, y quien cambia el modelo por bandera puede estar apuntando a uno de
// ventana distinta; el arnés no tiene de dónde deducirlo. Se prefiere dejar en
// pie la ventana declarada —siempre más prudente que el respaldo global en los
// perfiles pequeños, que es el caso que duele— y que quien sepa lo que hace
// mande con `compaction.threshold_tokens`, que gana sobre todo lo de aquí.
// ============================================================

/** Fracción de la ventana que puede ocupar la HISTORIA antes de compactar. */
export const FRACCION_VENTANA_COMPACTABLE = 0.5;

/**
 * La ventana como la EXIGE la tabla de fábrica: una unión discriminada, no el
 * `tokens?: number` suelto de types.ts.
 *
 * types.ts afirma en un comentario que `tokens` está «presente si y sólo si
 * postura === 'declarada'», y su tipo no lo sostiene: `{ postura: 'declarada' }`
 * sin tokens compilaba, y ese perfil derivaba `Math.floor(undefined * 0.5)` =
 * NaN como umbral. Un umbral NaN no apaga ruidosamente: `vista > NaN` es SIEMPRE
 * falso, así que la compactación automática quedaría apagada EN SILENCIO — justo
 * el modo de fallo que esta pieza existe para cerrar. La unión de abajo hace que
 * ese perfil no compile, y `desconocida` con tokens tampoco (un número que nadie
 * declara no es un dato). Anclada con @ts-expect-error en
 * tests/ai/providers/ventana-de-contexto.spec.ts: si alguien la afloja, el
 * typecheck de pruebas lo dice.
 *
 * La guarda de compactacionParaPerfil se queda igualmente, y no por duplicar:
 * `ventanaDe` va por listProfiles, cuyo tipo es ProviderProfile —sin ventana— y
 * que se AFIRMA con un cast a Partial<PerfilDeFabrica>. Lo que llega ahí está
 * aseverado, no probado, y una aseveración no es una garantía.
 */
export type VentanaDeFabrica =
  | { postura: 'declarada'; tokens: number; razon: string }
  | { postura: 'desconocida'; tokens?: undefined; razon: string };

/** Perfil de fábrica: declara su reproducibilidad Y su ventana. Sin excusa. */
export type PerfilDeFabrica = PerfilReproducible & { ventana: VentanaDeFabrica };

/**
 * ¿ENVÍAN YA EL MUESTREO los constructores de petición?
 *
 * HOY NO. `src/ai/agent.ts` (camino Anthropic) y `src/ai/providers/openai-compat.ts`
 * (camino OpenAI-compatible) arman el cuerpo de la petición sin `temperature`, y
 * ninguno de los dos está en la partición del paquete que declaró esta tabla. La
 * declaración de arriba es, por tanto, DECLARACIÓN: dice lo que cada proveedor
 * admite, no lo que hoy viaja por el cable.
 *
 * Esta bandera existe para que esa diferencia no se pudra en un comentario. El
 * arnés la lee y lo dice en voz alta en cada corrida, y
 * tests/ai/eval/arnes-cableado.spec.ts la contrasta contra los dos archivos
 * reales: si alguien cablea el muestreo y no la sube, rojo; si alguien la sube
 * sin cablearlo, rojo. Una nota que se invalida sola en vez de envejecer.
 *
 * TIPADA `boolean` A PROPÓSITO, no como el literal `false` que el valor sugiere:
 * con el literal, TypeScript da por muertas todas las ramas que dependen de que
 * algún día valga `true` —incluida la comparación de la bitácora, que se quedó
 * sin compilar— y el día que alguien la suba se encontraría con código que
 * nadie ha comprobado nunca. El tipo mantiene vivo el camino que la bandera
 * existe para abrir.
 */
export const MUESTREO_CABLEADO: boolean = false;

export const BUILTIN_PROFILES: Record<string, PerfilDeFabrica> = {
  anthropic: {
    type: 'anthropic',
    model: 'claude-opus-5',
    api_key_env: 'ANTHROPIC_API_KEY',
    note: 'Claude via the Anthropic API (default)',
    // Aquí el respaldo global no reventaba nada: sobraba. 150 000 sobre un
    // millón compactaba al 15% de la ventana y tiraba historia que cabía de
    // sobra —el fallo silencioso de la dirección contraria.
    ventana: {
      postura: 'declarada',
      tokens: 1_000_000,
      razon:
        'claude-opus-5 sirve una ventana de un millón de tokens. No es un número inferido: la ' +
        'API lo publica por modelo (GET /v1/models/{id} devuelve max_input_tokens), así que es ' +
        'comprobable contra el proveedor y no contra la memoria de nadie. Si la familia cambia, ' +
        'ese endpoint es donde se mira.',
    },
    // El perfil POR DEFECTO —el que el eval mide si nadie pasa --provider— es
    // el que menos puede fijarse. No es una omisión: es la API.
    reproducibilidad: {
      muestreo: 'no-admite',
      instantanea: null,
      razon:
        'El SDK instalado lo dice en su propia deprecación de `temperature` ' +
        '(node_modules/@anthropic-ai/sdk, BetaMessageCreateParams): los modelos posteriores a ' +
        'Claude Opus 4.6 no admiten fijar la temperatura — se acepta 1.0 por compatibilidad y ' +
        'cualquier otro valor vuelve como 400. claude-opus-5 es posterior, así que temperatura 0 ' +
        'sería un error, no un ajuste. Tampoco hay instantánea que fijar: el id ya es exacto y ' +
        'Anthropic no publica variantes fechadas de esta familia (añadirle un sufijo de fecha da ' +
        'un modelo inexistente). Dos corridas de este perfil NO son comparables por construcción, ' +
        'y el arnés tiene que decirlo en vez de dibujar flechas.',
    },
  },
  hermes: {
    type: 'openai-compatible',
    model: 'Hermes-4-405B',
    base_url: 'https://inference-api.nousresearch.com/v1',
    api_key_env: 'NOUS_API_KEY',
    note: 'Hermes 4 via Nous Portal — standard function calling, the accounting tools work',
    ventana: {
      postura: 'declarada',
      tokens: 131_072,
      razon:
        'Hermes 4 405B es un afinado de Llama 3.1 405B, cuya ventana entrenada son 128k tokens; ' +
        'el afinado no la mueve. El portal podría servir menos y no lo publica, pero declarar ' +
        '128k ya es más prudente que el respaldo global de 150 000, que quedaría POR ENCIMA de ' +
        'la ventana del modelo base.',
    },
    reproducibilidad: {
      muestreo: 'fijado',
      temperature: 0,
      instantanea: null,
      razon:
        'Endpoint Chat Completions clásico: `temperature` es parámetro del cuerpo y 0 es el ' +
        'ajuste del clasificador. El alias del modelo nombra un peso fijo (405B), no un enrutador; ' +
        'no hay instantánea fechada que establecer.',
    },
  },
  'hermes-agent': {
    type: 'openai-compatible',
    model: 'hermes-agent',
    base_url: 'http://127.0.0.1:8642/v1',
    api_key_env: 'HERMES_AGENT_KEY',
    tools: false,
    note:
      'Local Hermes Agent (hermes gateway). WARNING: it runs ITS OWN tools server-side and does not ' +
      'return tool calls to the client — mnemosine accounting tools are NOT invoked ' +
      'over this channel; it is generic chat/agent. For accounting with tools use "hermes".',
    ventana: {
      postura: 'desconocida',
      razon:
        'La pasarela decide qué modelo hay detrás del alias `hermes-agent` y no lo versiona hacia ' +
        'el cliente; su ventana la fija su propia configuración, invisible desde aquí. Además ' +
        'corre sus propias herramientas del lado del servidor, así que ni siquiera es la vista de ' +
        'este arnés la que llena ese contexto. Respaldo global.',
    },
    reproducibilidad: {
      muestreo: 'no-admite',
      instantanea: null,
      razon:
        'Antes que el muestreo falla el sujeto: `tools: false` porque la pasarela corre SUS ' +
        'propias herramientas del lado del servidor y no devuelve llamadas al cliente. Las ' +
        'herramientas contables nunca se invocan, así que este perfil no clasifica nada que el ' +
        'golden set pueda puntuar. No es evaluable, y fijarle una temperatura sugeriría que sí.',
    },
  },
  ollama: {
    type: 'openai-compatible',
    model: 'llama3.1',
    base_url: 'http://localhost:11434/v1',
    note: 'Local model via Ollama. Set "model" to an installed one that supports tools',
    // EL PERFIL QUE MOTIVÓ TODO ESTO. Con el umbral global de 150 000 la
    // sesión reventaba por contexto ANTES de que la compactación se disparara,
    // y el operador veía un error del proveedor donde había un problema de
    // diseño del arnés.
    ventana: {
      postura: 'declarada',
      tokens: 32_768,
      razon:
        'La ventana EFECTIVA de Ollama no es la del modelo: el servidor trunca a su `num_ctx` ' +
        '(4 096 por omisión; se sube con OLLAMA_CONTEXT_LENGTH o un Modelfile), y ese valor no se ' +
        'puede consultar desde aquí. Los 128k nominales de llama3.1 son inalcanzables en local por ' +
        'la caché KV mucho antes que por los pesos. 32 768 es un techo deliberado entre ambos: muy ' +
        'por debajo de lo nominal, muy por encima de la omisión, y siempre por debajo del respaldo ' +
        'global que era el error. Quien conozca su `num_ctx` manda con `compaction.threshold_tokens`.',
    },
    reproducibilidad: {
      muestreo: 'fijado',
      temperature: 0,
      instantanea: null,
      razon:
        'Servidor local con Chat Completions: acepta `temperature`, y al correr contra pesos ' +
        'locales el modelo no se mueve bajo los pies. La instantánea es la etiqueta que el usuario ' +
        'tenga instalada (`--model`), no algo que este perfil pueda fijar por él.',
    },
  },
  openai: {
    type: 'openai-compatible',
    model: 'gpt-5.1',
    base_url: 'https://api.openai.com/v1',
    api_key_env: 'OPENAI_API_KEY',
    max_tokens_param: 'max_completion_tokens',
    note: 'OpenAI via API key (API equivalent of the ChatGPT/Codex subscription)',
    ventana: {
      postura: 'desconocida',
      razon:
        'OpenAI publica la ventana por modelo y NADIE LA HA ESTABLECIDO AQUÍ. No se pone de ' +
        'memoria: este perfil apunta a un modelo de razonamiento cuya ventana total y cuyo límite ' +
        'de entrada no son el mismo número, y equivocarse hacia arriba deja el umbral por encima ' +
        'de lo que la API acepta. Hasta que alguien lo mire en la documentación del modelo que ' +
        'realmente usa, respaldo global.',
    },
    reproducibilidad: {
      muestreo: 'no-admite',
      instantanea: null,
      razon:
        'Modelo de razonamiento — este mismo perfil ya lo delata con `max_tokens_param: ' +
        'max_completion_tokens`. Con el razonamiento activo (el default) la API sólo acepta la ' +
        'temperatura por omisión: cualquier otro valor vuelve como 400 «Unsupported value: ' +
        "'temperature' … Only the default (1) value is supported». No se fija.",
    },
  },
  grok: {
    type: 'openai-compatible',
    model: 'grok-4',
    base_url: 'https://api.x.ai/v1',
    api_key_env: 'XAI_API_KEY',
    note: 'xAI Grok — OpenAI-compatible API',
    ventana: {
      postura: 'desconocida',
      razon:
        'xAI documenta la ventana de grok-4 en su referencia de modelos y nadie la ha traído aquí. ' +
        'Es un dato de una línea que se comprueba en un minuto; hasta que se compruebe, respaldo ' +
        'global, que es lo que este perfil ya hacía.',
    },
    reproducibilidad: {
      muestreo: 'fijado',
      temperature: 0,
      instantanea: null,
      razon:
        'xAI documenta `temperature` en 0–2 para grok-4 (lo que grok-4 sí rechaza es ' +
        '`reasoning_effort`, que este arnés no envía). Sin instantánea fechada establecida.',
    },
  },
  minimax: {
    type: 'openai-compatible',
    model: 'MiniMax-M2',
    base_url: 'https://api.minimax.io/v1',
    api_key_env: 'MINIMAX_API_KEY',
    note: 'MiniMax (global endpoint; for China change base_url to api.minimaxi.com/v1)',
    ventana: {
      postura: 'desconocida',
      razon:
        'La ventana de MiniMax-M2 la publica MiniMax por modelo y no se ha establecido aquí. Sin ' +
        'establecer, respaldo global.',
    },
    reproducibilidad: {
      muestreo: 'fijado',
      temperature: 0,
      instantanea: null,
      razon:
        'Endpoint Chat Completions: `temperature` es parámetro del cuerpo. El alias nombra una ' +
        'versión concreta del modelo (M2); sin instantánea fechada establecida.',
    },
  },
  qwen: {
    type: 'openai-compatible',
    model: 'qwen3-max',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    api_key_env: 'DASHSCOPE_API_KEY',
    note: 'Qwen via DashScope compatible-mode (the API route used by Qwen Code)',
    ventana: {
      postura: 'desconocida',
      razon:
        'Mismo problema que su reproducibilidad: `qwen3-max` es un alias que DashScope repunta, y ' +
        'la ventana viaja con la instantánea concreta que sirva ese día. Un número fijo aquí ' +
        'envejecería sin avisar. Respaldo global hasta que se fije la instantánea.',
    },
    reproducibilidad: {
      muestreo: 'fijado',
      temperature: 0,
      instantanea: null,
      razon:
        'DashScope en modo compatible acepta `temperature` en el cuerpo. `qwen3-max` es un alias ' +
        'que DashScope repunta: la instantánea fechada existe del lado del proveedor y está SIN ' +
        'ESTABLECER aquí — hasta que se fije, dos corridas separadas en el tiempo pueden estar ' +
        'midiendo modelos distintos.',
    },
  },
  gemini: {
    type: 'openai-compatible',
    model: 'gemini-2.5-pro',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    api_key_env: 'GEMINI_API_KEY',
    note: 'Google AI Studio (Gemini) — OpenAI-compatible endpoint; set "model" to the version your account has',
    ventana: {
      postura: 'declarada',
      tokens: 1_048_576,
      razon:
        'gemini-2.5-pro admite 1 048 576 tokens de entrada — el número que Google publica en la ' +
        'ficha del modelo de AI Studio, y que la capa compatible con OpenAI no recorta. Igual que ' +
        'el perfil por defecto, aquí el respaldo global no era peligroso sino desperdiciado.',
    },
    reproducibilidad: {
      muestreo: 'fijado',
      temperature: 0,
      instantanea: null,
      razon:
        'La capa compatible con OpenAI de AI Studio acepta `temperature`. El alias ya lleva ' +
        'versión menor (2.5-pro), pero Google publica instantáneas fechadas por debajo: SIN ' +
        'ESTABLECER aquí.',
    },
  },
  openrouter: {
    type: 'openai-compatible',
    model: 'openrouter/auto',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    note: 'OpenRouter — one key, hundreds of models; change "model" to whichever you prefer',
    ventana: {
      postura: 'desconocida',
      razon:
        'Aquí no es que falte el dato: es que NO EXISTE uno solo. `openrouter/auto` elige modelo ' +
        'por petición, así que la ventana cambia entre turnos de la misma sesión. Declarar un ' +
        'número sería declarar el de un modelo que quizá no conteste el turno siguiente.',
    },
    reproducibilidad: {
      muestreo: 'no-admite',
      instantanea: null,
      razon:
        'Aquí la comparabilidad se rompe UN ESCALÓN ANTES que el muestreo: `openrouter/auto` es un ' +
        'enrutador que elige modelo por petición, así que dos corridas del «mismo proveedor+modelo» ' +
        'pueden haber preguntado a dos modelos distintos — y la bitácora las compararía como si ' +
        'fueran la misma. Fijar la temperatura no arreglaría eso. Para evaluar con OpenRouter hay ' +
        'que pasar `--model` con un modelo concreto; el perfil por omisión no es evaluable.',
    },
  },
  copilot: {
    type: 'openai-compatible',
    model: 'gpt-5.1',
    base_url: 'https://api.githubcopilot.com',
    api_key_env: 'COPILOT_API_TOKEN',
    note:
      'GitHub Copilot. WARNING: it does not use a classic API key — the token comes from the GitHub OAuth flow ' +
      '(short-lived and renewable); useful behind a proxy like copilot-api that refreshes it.',
    ventana: {
      postura: 'desconocida',
      razon:
        'Lo que Copilot sirve detrás del alias lo decide GitHub y no se versiona hacia el cliente; ' +
        'encima el proxy que renueva el token puede recortar el contexto por su cuenta. Dos capas ' +
        'que pueden mover la ventana sin avisar: no hay número que declarar.',
    },
    reproducibilidad: {
      muestreo: 'no-admite',
      instantanea: null,
      razon:
        'Mismo modelo de razonamiento que el perfil `openai` (gpt-5.1) y por tanto el mismo 400 al ' +
        'fijar temperatura; encima, lo que Copilot sirve detrás de ese alias lo decide GitHub y no ' +
        'se versiona hacia el cliente. Dos capas de deriva, ninguna fijable desde aquí.',
    },
  },
  openclaw: {
    type: 'openai-compatible',
    model: 'openclaw:main',
    base_url: 'http://127.0.0.1:18789/v1',
    api_key_env: 'OPENCLAW_GATEWAY_TOKEN',
    tools: false,
    note:
      'Local OpenClaw gateway. Requires gateway.http.endpoints.chatCompletions.enabled=true ' +
      'in its config; the gateway token is an operator credential — loopback only. ' +
      'Like hermes-agent, it runs ITS OWN tools server-side: chat channel, no accounting tools.',
    ventana: {
      postura: 'desconocida',
      razon:
        'Como hermes-agent: `openclaw:main` nombra lo que la pasarela local tenga montado, y su ' +
        'ventana la fija la configuración de esa pasarela. Desde el arnés no se ve.',
    },
    reproducibilidad: {
      muestreo: 'no-admite',
      instantanea: null,
      razon:
        'Como hermes-agent: `tools: false`, la pasarela corre sus propias herramientas del lado del ' +
        'servidor y las contables nunca se invocan. No hay clasificación que puntuar, así que no ' +
        'hay muestreo que fijar.',
    },
  },
};

/**
 * La reproducibilidad DECLARADA de un perfil, o `null` si no la declara.
 *
 * Sólo los perfiles de fábrica la traen. Un perfil definido por el usuario en
 * mnemosine.config.json devuelve `null` a propósito: el archivo de configuración
 * no tiene dónde declararla, y adivinarla por él sería inventar una garantía.
 * El arnés trata ese `null` como «sin garantía de comparabilidad» y lo dice.
 */
export function reproducibilidadDe(nombre: string): Reproducibilidad | null {
  return BUILTIN_PROFILES[nombre]?.reproducibilidad ?? null;
}

/**
 * La ventana DECLARADA del perfil que de verdad se va a usar, o `null` si el
 * perfil no declara ninguna.
 *
 * Va por listProfiles y NO por BUILTIN_PROFILES a propósito: un perfil del
 * archivo REEMPLAZA al de fábrica del mismo nombre (no se fusionan), así que
 * quien redefine `ollama` en su mnemosine.config.json está apuntando a otro
 * servidor y heredarle en silencio la ventana del perfil de fábrica sería
 * afirmar de su montaje algo que nadie declaró. Ese caso cae al respaldo
 * global, que es la conducta previa: peor que hoy, nunca.
 */
export function ventanaDe(nombre: string, cwd = process.cwd()): VentanaContexto | null {
  const perfil = listProfiles(cwd).profiles[nombre] as Partial<PerfilDeFabrica> | undefined;
  return perfil?.ventana ?? null;
}

// Strict fail-closed schemas: an unknown key is ALWAYS a mistake (a typo like
// "api_key_evn" would otherwise silently fall back to defaults — the worst
// failure mode for a credential-bearing config). Rejecting loudly beats
// running on defaults the user did not choose.
const profileSchema = z
  .object({
    type: z.enum(['anthropic', 'openai-compatible']),
    model: z.string().min(1),
    base_url: z.string().url().optional(),
    api_key_env: z.string().optional(),
    api_key_cmd: z.string().optional(),
    stream: z.boolean().optional(),
    /**
     * false = do NOT send `stream_options: { include_usage: true }` on
     * streamed requests. The default (absent/true) asks the server to report
     * token usage on the final streamed chunk; a few old local servers 400
     * on the unknown `stream_options` field — set stream_usage: false for
     * those. Non-streamed requests are unaffected.
     */
    stream_usage: z.boolean().optional(),
    max_tokens_param: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    tools: z.boolean().optional(),
    headers: z.record(z.string()).optional(),
    max_iterations: z.number().int().min(1).max(100).optional(),
    /**
     * Ordered failover chain: names of OTHER profiles to try when this one
     * fails with a failover-eligible error (see providers/failover.ts).
     * Validated lazily by resolveFailoverChain (existence, self-references,
     * cycles) so a chain naming a profile defined later in the file works.
     */
    failover: z.array(z.string().min(1)).optional(),
    /**
     * Per-profile skills allowlist: when present, it is the FINAL set of
     * firm skills the model may see (src/ai/skills/gating.ts). Absent =
     * every visible (ungated) skill.
     */
    skills: z.array(z.string().min(1)).optional(),
    note: z.string().optional(),
  })
  .strict();

const ingestSchema = z
  .object({
    auto_post: z.boolean().optional(),
    auto_post_min_confidence: z.number().min(0).max(1).optional(),
    auto_post_max_amount: z.number().positive().optional(),
  })
  .strict();

/**
 * A3 · E5.1-e: el presupuesto del agente. Sin sección budget no hay
 * límites y no se consulta gasto alguno (opt-in). on_exceed decide si al
 * cruzarlo se ADVIERTE o se CORTA; su omisión la resuelve la ruta: las
 * DESATENDIDAS cortan por defecto («solo avisa» significa que no hay tope).
 */
const budgetSchema = z
  .object({
    daily_usd: z.number().positive().optional(),
    monthly_usd: z.number().positive().optional(),
    on_exceed: z.enum(['warn', 'block']).optional(),
  })
  .strict();

/**
 * History-compaction settings. Auto-compaction is ON BY DEFAULT (see
 * resolveCompactionConfig): omitting the section compacts at ~150k
 * estimated tokens. `threshold_tokens: 0` disables auto-compaction
 * explicitly (manual /compact still works).
 */
const compactionSchema = z
  .object({
    /** Auto-compact above this many estimated in-flight tokens; 0 = off. */
    threshold_tokens: z.number().int().min(0).optional(),
    /** Intact recent tail the compaction must keep. */
    keep_recent_tokens: z.number().int().min(1).optional(),
    /** Identifier survival policy; only 'strict' exists today. */
    identifier_policy: z.enum(['strict']).optional(),
    /**
     * Tope de TURNOS DE DESCARGA DE MEMORIA por sesión. Ver
     * MAX_DESCARGAS_MEMORIA_POR_SESION: 0 apaga la descarga automática, un
     * número grande devuelve la conducta de una por compactación.
     */
    max_memory_flushes: z.number().int().min(0).optional(),
  })
  .strict();

const configFileSchema = z
  .object({
    /** Language for the AGENT's responses (CLI UI is English). Default: es. */
    language: z.enum(['en', 'es']).optional(),
    default_provider: z.string().optional(),
    providers: z.record(profileSchema).optional(),
    ingest: ingestSchema.optional(),
    budget: budgetSchema.optional(),
    compaction: compactionSchema.optional(),
  })
  .strict();

export type MnemosineConfig = z.infer<typeof configFileSchema>;

export function configFilePaths(cwd = process.cwd()): string[] {
  return [
    path.join(cwd, 'mnemosine.config.json'),
    path.join(os.homedir(), '.mnemosine', 'config.json'),
  ];
}

/**
 * Copies an invalid config file aside before we throw, so the user can inspect
 * (and diff) exactly what was rejected. OpenClaw pattern: a config that EXISTS
 * but is invalid must never be silently replaced by defaults — the throw fails
 * closed, and the quarantine copy preserves the evidence even if someone later
 * "fixes" the original by deleting it. Best-effort: quarantine failure must not
 * mask the real validation error.
 *
 * Named by content hash so retries are idempotent: the same invalid content
 * always maps to the same .rejected-<hash> file (no per-run litter), while a
 * differently-broken config still gets its own copy.
 */
function quarantineInvalidConfig(file: string): string | null {
  try {
    const content = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
    const target = `${file}.rejected-${hash}`;
    if (!fs.existsSync(target)) fs.copyFileSync(file, target);
    return target;
  } catch {
    return null;
  }
}

/** Loads the first existing configuration file (project > user). */
export function loadConfigFile(cwd = process.cwd()): { config: MnemosineConfig; source: string | null } {
  for (const file of configFilePaths(cwd)) {
    if (!fs.existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      const quarantined = quarantineInvalidConfig(file);
      throw new Error(
        `Invalid configuration in ${file}: ${(err as Error).message}` +
          (quarantined ? ` (rejected copy kept at ${quarantined})` : '')
      );
    }
    const parsed = configFileSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      const quarantined = quarantineInvalidConfig(file);
      throw new Error(
        `Invalid configuration in ${file}: ${issues}` +
          (quarantined ? ` (rejected copy kept at ${quarantined})` : '')
      );
    }
    return { config: parsed.data, source: file };
  }
  return { config: {}, source: null };
}

/**
 * Effective profiles: built-ins + file. A file profile REPLACES the
 * built-in of the same name (no merging): inheriting invisible fields
 * like api_key_env or tools=false would produce behaviors impossible
 * to disable from the config.
 */
export function listProfiles(cwd = process.cwd()): {
  profiles: Record<string, ProviderProfile>;
  defaultName: string;
  source: string | null;
} {
  const { config, source } = loadConfigFile(cwd);
  const profiles: Record<string, ProviderProfile> = { ...BUILTIN_PROFILES };
  for (const [name, profile] of Object.entries(config.providers ?? {})) {
    profiles[name] = profile;
  }
  const defaultName = process.env.MNEMOSINE_PROVIDER || config.default_provider || 'anthropic';
  return { profiles, defaultName, source };
}

/**
 * Resolves the profile to use. `flagName` comes from --provider; `modelOverride`
 * from --model. Validates that the named API key exists in the environment.
 */
export function resolveProfile(
  flagName?: string,
  modelOverride?: string,
  cwd = process.cwd()
): ResolvedProfile {
  const { profiles, defaultName } = listProfiles(cwd);
  const name = flagName || defaultName;
  const profile = profiles[name];
  if (!profile) {
    throw new Error(
      `Provider "${name}" does not exist. Available: ${Object.keys(profiles).join(', ')}. ` +
        'Define your own providers in mnemosine.config.json'
    );
  }

  let apiKey: string | undefined;
  if (profile.api_key_env) {
    apiKey = process.env[profile.api_key_env] || undefined;
  }
  // Credential helper: only if the env did not resolve. Lets you reuse OAuth
  // tokens of already-logged-in subscriptions (e.g. Codex CLI) or vaults.
  if (!apiKey && profile.api_key_cmd) {
    try {
      apiKey =
        execSync(profile.api_key_cmd, {
          encoding: 'utf-8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim() || undefined;
    } catch (err) {
      throw new Error(
        `Provider "${name}" could not obtain its credential via api_key_cmd: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
    if (!apiKey) {
      throw new Error(`The api_key_cmd of provider "${name}" did not print any credential`);
    }
  }
  // Anthropic resolves credentials on its own (ant profile, auth token);
  // for the rest the credential is mandatory if the profile names it.
  if (!apiKey && profile.api_key_env && profile.type === 'openai-compatible') {
    throw new Error(
      `Provider "${name}" requires the environment variable ${profile.api_key_env} ` +
        '(add it to your .env) or an api_key_cmd in mnemosine.config.json'
    );
  }

  return {
    ...profile,
    name,
    model: modelOverride || profile.model,
    apiKey,
  };
}

// ─── Failover chains ───

/**
 * ProviderProfile plus the optional `failover` list. Kept as an intersection
 * here (rather than widening types.ts) because only the chain resolver reads
 * it; the runtime objects returned by listProfiles already carry the field
 * when the config declares it.
 */
export type ProfileWithFailover = ProviderProfile & { failover?: string[] };

/**
 * Resolves the ordered failover chain for a profile: the profile itself
 * first, then its `failover` list, expanding transitively in breadth-first
 * order (a fallback's own fallbacks are appended after it). Fail-closed
 * validation:
 *   - every referenced name must exist among the effective profiles;
 *   - a profile may not reference itself;
 *   - a profile appearing on its OWN expansion path is a true cycle and is
 *     rejected. A DIAMOND — the same profile reachable via two different
 *     paths (a → b → d, a → c → d) — is NOT a cycle: the duplicate is
 *     deduplicated silently and the chain keeps its first position.
 * Names only, no credential resolution: the caller resolves the credential
 * of the profile it actually attempts (resolveProfile), so a fallback with
 * a missing key fails at attempt time, not at chain-building time.
 */
export function resolveFailoverChain(
  profileName: string,
  cwd = process.cwd()
): Array<ProfileWithFailover & { name: string }> {
  const { profiles } = listProfiles(cwd);
  if (!profiles[profileName]) {
    throw new Error(
      `Provider "${profileName}" does not exist. Available: ${Object.keys(profiles).join(', ')}`
    );
  }

  const chain: Array<ProfileWithFailover & { name: string }> = [];
  // Parallel to `chain`: index of the entry that referenced this one (-1 for
  // the root). Walking `parents` reconstructs an entry's expansion path,
  // which is what distinguishes a true cycle from a harmless diamond.
  const parents: number[] = [];
  const visited = new Set<string>();
  const enqueue = (name: string, parent: number) => {
    chain.push({ ...(profiles[name] as ProfileWithFailover), name });
    parents.push(parent);
    visited.add(name);
  };
  enqueue(profileName, -1);

  const onExpansionPath = (index: number, name: string): boolean => {
    for (let p = index; p !== -1; p = parents[p]) {
      if (chain[p].name === name) return true;
    }
    return false;
  };

  for (let i = 0; i < chain.length; i++) {
    const current = chain[i];
    for (const next of (current as ProfileWithFailover).failover ?? []) {
      if (next === current.name) {
        throw new Error(
          `Invalid failover chain: profile "${current.name}" references itself`
        );
      }
      if (!profiles[next]) {
        throw new Error(
          `Invalid failover chain: profile "${current.name}" references unknown provider "${next}". ` +
            `Available: ${Object.keys(profiles).join(', ')}`
        );
      }
      if (visited.has(next)) {
        if (onExpansionPath(i, next)) {
          throw new Error(
            `Invalid failover chain: cycle detected — "${next}" (referenced by "${current.name}") ` +
              'is already on its own expansion path'
          );
        }
        continue; // diamond: same fallback via another path — dedupe silently
      }
      enqueue(next, i);
    }
  }
  return chain;
}

// ─── Ingest thresholds (auto-post) ───

export interface IngestThresholds {
  /** Master switch: false = everything stays as a draft (safe default). */
  autoPost: boolean;
  /**
   * A4 · modo sombra: las compuertas corren completas y el veredicto se
   * registra (ai_shadow_verdicts), pero nada postea. Solo lo enciende el
   * PANEL (ingest_auto_post = 'shadow'); no hay bandera ni archivo — la
   * sombra es una decisión del despacho, no un override de corrida.
   */
  sombra?: boolean;
  /**
   * A7: el archivo o la bandera pidieron ENCENDER y el panel no lo autoriza,
   * así que se ignoró. Se expone para que la corrida pueda decirlo en voz
   * alta en vez de dejar al operador creyendo que su `true` hizo algo.
   */
  encendidoIgnorado?: boolean;
  /** Minimum AI-reported confidence to auto-post. */
  minConfidence: number;
  /** Maximum amount (entity currency) eligible for auto-post. */
  maxAmount: number;
  /**
   * De dónde salió cada umbral, para el rastro: cuando algo se postea sin
   * humano, la bitácora tiene que poder decir QUIÉN lo decidió — una bandera
   * explícita, el archivo del operador, la política del despacho o la
   * omisión del código. Lo rellena el resolutor con panel.
   */
  fuentes?: {
    autoPost: 'bandera' | 'archivo' | 'politica' | 'omision';
    minConfidence: 'bandera' | 'archivo' | 'omision';
    maxAmount: 'bandera' | 'archivo' | 'politica' | 'omision';
  };
}

const INGEST_DEFAULTS: IngestThresholds = {
  autoPost: false,
  minConfidence: 0.95,
  maxAmount: 10000,
};

/**
 * Valores CRUDOS del bloque ingest del archivo del operador, sin mezclar con
 * omisiones. Existe para que el resolutor con panel (src/ai/ingest-thresholds)
 * pueda insertar la capa de la política ENTRE el archivo y la omisión: la
 * precedencia decidida es bandera > archivo del operador > política del
 * despacho > omisión del código, y para eso hay que saber si el archivo
 * TRAÍA valor, no sólo cuál quedó tras mezclar.
 */
/** A3: los valores CRUDOS de la sección budget del archivo del operador. */
export function budgetFileValues(cwd = process.cwd()): {
  dailyUsd?: number;
  monthlyUsd?: number;
  onExceed?: 'warn' | 'block';
} {
  const { config } = loadConfigFile(cwd);
  const file = config.budget ?? {};
  const num = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  return {
    dailyUsd: num(file.daily_usd),
    monthlyUsd: num(file.monthly_usd),
    onExceed: file.on_exceed,
  };
}

export function ingestFileValues(cwd = process.cwd()): {
  autoPost?: boolean;
  minConfidence?: number;
  maxAmount?: number;
} {
  const { config } = loadConfigFile(cwd);
  const file = config.ingest ?? {};
  const num = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  return {
    autoPost: typeof file.auto_post === 'boolean' ? file.auto_post : undefined,
    minConfidence: num(file.auto_post_min_confidence),
    maxAmount: num(file.auto_post_max_amount),
  };
}

export const UMBRALES_INGESTA_OMISION: IngestThresholds = INGEST_DEFAULTS;

/** Config file + CLI overrides. The default is conservative: no auto-post. */
export function resolveIngestThresholds(
  overrides: Partial<IngestThresholds> = {},
  cwd = process.cwd()
): IngestThresholds {
  const { config } = loadConfigFile(cwd);
  const file = config.ingest ?? {};
  // NaN is not nullish: an invalid flag (--min-confianza abc → parseFloat NaN)
  // would pass the ?? and ALSO `confidence < NaN` is false — the gate would
  // open auto-post. Only finite numbers count as overrides.
  const num = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const minConfidence =
    num(overrides.minConfidence) ?? num(file.auto_post_min_confidence) ?? INGEST_DEFAULTS.minConfidence;
  const maxAmount =
    num(overrides.maxAmount) ?? num(file.auto_post_max_amount) ?? INGEST_DEFAULTS.maxAmount;
  return {
    autoPost: overrides.autoPost ?? file.auto_post ?? INGEST_DEFAULTS.autoPost,
    minConfidence: Math.min(1, Math.max(0, minConfidence)),
    maxAmount: Math.max(0, maxAmount),
  };
}


// ─── Compaction (auto-compaction ON by default) ───

/**
 * Default auto-compaction threshold: safely under every supported
 * provider's context window, so production sessions compact before they
 * overflow even when the config never mentions compaction.
 */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 150_000;

// ============================================================
// CUÁNTAS VECES PUEDE UNA SESIÓN ESCRIBIR MEMORIA SOLA — decidido y declarado
//
// Antes de esta pieza el umbral era 150 000 para todo perfil y la descarga de
// memoria (compaction.ts · buildFlushPrompt) corría UNA VEZ POR COMPACTACIÓN.
// Esa cadencia no la eligió nadie: salía de que el umbral fuera único. Derivar
// el umbral de la ventana la multiplica, y no por un matiz.
//
// MEDIDO, no argumentado (el arnés de la medición vive en
// tests/ai/providers/ventana-de-contexto.spec.ts; turnos de ~7 000 tokens, el
// mismo trabajo, sólo cambia el perfil):
//
//   perfil / umbral                30 turnos   60    100    200
//   ollama, derivado 16 384            27       —     97      —
//   el mismo historial, global 150 000   1       2      5     10
//   anthropic, derivado 500 000          0       —      —      —
//
// Veintisiete descargas donde el mismo trabajo daba una. Cada descarga es un
// bucle agéntico con la superficie completa y un prompt que instruye
// EXPLÍCITAMENTE a persistir criterio; con la ventana pequeña el conteo deja de
// seguir a la conversación y pasa a seguir a los TURNOS (97 en 100). Compactar
// más para respetar una ventana de 32k está bien y se queda; que de ahí se siga
// multiplicar por veintisiete las veces que el sistema escribe memoria es una
// ampliación de autonomía que nadie decidió, y una ampliación de autonomía no es
// un efecto colateral aceptable de arreglar un umbral.
//
// DESCARTADO · UN SUELO AL UMBRAL DERIVADO. Devuelve el fallo que la pieza
// existe para cerrar: sobre una ventana de 32 768 cualquier suelo útil es la
// ventana entera y ollama vuelve a reventar por contexto. Cambiar una ampliación
// de autonomía ACOTADA por un desbordamiento SIN ACOTAR es mal negocio.
//
// DESCARTADO · UN PRESUPUESTO EN TOKENS RETIRADOS (una descarga por cada N
// tokens que salen de la vista). Es el modelo más fino —ata la descarga a la
// conversación y no al perfil— y rompe un contrato embarcado: «cada ventana de
// compactación tiene su propia descarga» (tests/ai/compaction.spec.ts). Cambiar
// ese contrato es una decisión aparte de ésta y no se cuela aquí.
//
// ELEGIDO · TOPE POR SESIÓN = 5, y el número sale de la tabla de arriba: 5 es
// exactamente lo que la cadencia de HOY (umbral global) le da a una sesión de
// 100 turnos. Por debajo de eso el tope no le quita nada a nadie —30 turnos dan
// 1, 60 dan 2—, y por encima acota lo que la ventana pequeña convertía en una
// descarga por turno. Sobre lo medido: ollama 30 turnos pasa de 27 a 5, y 100
// turnos de 97 a 5.
//
// LO QUE EL TOPE NO APAGA, y por eso su coste es el que es: el agente sigue
// pudiendo proponer criterio en un turno normal por la vía de siempre
// (ask_user → pregunta pendiente). Lo acotado es el barrido AUTOMÁTICO previo a
// cada compactación, no la capacidad de proponer. Y la transcripción completa
// nunca se toca: vive en Postgres (`mnemosine sessions`).
//
// El operador manda con `compaction.max_memory_flushes`: 0 apaga el barrido
// automático del todo, y un número grande devuelve la conducta anterior.
export const MAX_DESCARGAS_MEMORIA_POR_SESION = 5;

/**
 * Runner-facing compaction settings resolved from the config file.
 * Duplicated shape of compaction.ts's CompactionConfig (kept structural to
 * avoid a config → compaction import edge).
 */
export interface ResolvedCompactionConfig {
  /** undefined = auto-compaction OFF (explicit threshold_tokens: 0). */
  thresholdTokens?: number;
  keepRecentTokens?: number;
  identifierPolicy?: 'strict';
  /**
   * PROCEDENCIA DEL UMBRAL, y por qué hace falta un campo para decirla.
   *
   * `true` = el archivo del operador NO trae `threshold_tokens`, así que el
   * valor de arriba es sólo el respaldo global y el runner puede sustituirlo
   * por el que se derive de la ventana de SU perfil. Ausente o `false` = el
   * umbral lo puso alguien —el operador en su archivo, o quien construyó la
   * sesión a mano— y manda tal cual, incluido el 0 que apaga.
   *
   * Sin este campo el runner recibiría 150 000 y no podría distinguir «lo
   * escribió el operador» de «nadie dijo nada», que es justo la diferencia
   * entre respetar su control y pisárselo. Y nótese que `thresholdTokens`
   * sigue trayendo el respaldo aunque sea derivable: cualquier consumidor que
   * ignore esta bandera se comporta EXACTAMENTE como antes de que existiera.
   */
  umbralDerivable?: boolean;
  /**
   * Turnos de descarga de memoria que esta sesión puede correr como mucho
   * (MAX_DESCARGAS_MEMORIA_POR_SESION). Los runners lo leen; ausente = el
   * default declarado arriba.
   */
  maxDescargasMemoria?: number;
}

/**
 * Resolves the `compaction` config section. DEFAULT ON: with no section (or
 * no threshold_tokens) auto-compaction fires at ~150k estimated tokens;
 * `threshold_tokens: 0` is the explicit off switch (manual /compact keeps
 * working); any other value moves the threshold.
 *
 * El umbral que sale de aquí es GLOBAL. Quien conozca su perfil lo afina con
 * compactacionParaPerfil, que sólo actúa cuando `umbralDerivable` lo permite.
 */
export function resolveCompactionConfig(cwd = process.cwd()): ResolvedCompactionConfig {
  const { config } = loadConfigFile(cwd);
  const section = config.compaction ?? {};
  const delOperador = section.threshold_tokens !== undefined;
  const threshold = section.threshold_tokens ?? DEFAULT_COMPACTION_THRESHOLD_TOKENS;
  return {
    thresholdTokens: threshold === 0 ? undefined : threshold,
    keepRecentTokens: section.keep_recent_tokens,
    identifierPolicy: section.identifier_policy,
    maxDescargasMemoria: section.max_memory_flushes,
    // La marca sólo aparece cuando dice algo. Un `umbralDerivable: false`
    // presente en cada resolución sería ruido en todo consumidor que compare
    // el objeto entero, y la ausencia ya significa exactamente eso.
    ...(delOperador ? {} : { umbralDerivable: true }),
  };
}

/**
 * El umbral (y la cola) que esta sesión usará DE VERDAD, ya conocido el perfil.
 *
 * Precedencia, de más fuerte a más débil:
 *   1. lo que trae `base` cuando NO es derivable — el `threshold_tokens` del
 *      operador (0 incluido: sigue apagando) o el valor que le pasó a mano
 *      quien construyó la sesión;
 *   2. la ventana declarada por el perfil, por la fracción;
 *   3. el respaldo global que `base` ya traía.
 *
 * `colaRecientePorOmision` la pasa el runner desde el propio compactador
 * (DEFAULT_KEEP_RECENT_TOKENS) en vez de duplicarse aquí: config.ts no importa
 * compaction.ts a propósito, y una copia del número se desincronizaría el día
 * que allí cambie.
 */
export function compactacionParaPerfil(
  nombrePerfil: string,
  base: ResolvedCompactionConfig,
  colaRecientePorOmision: number,
  cwd = process.cwd()
): ResolvedCompactionConfig {
  if (!base.umbralDerivable) return base;
  const ventana = ventanaDe(nombrePerfil, cwd);
  // `Number.isFinite` y no `!== undefined`: lo que hay que impedir no es un
  // campo ausente sino un UMBRAL NaN, que es lo que sale de multiplicar la
  // fracción por undefined y que apagaría la compactación en silencio
  // (`vista > NaN` es siempre falso). undefined, NaN e Infinity caen todos al
  // respaldo global, que es la conducta previa a esta pieza: peor que hoy,
  // nunca. VentanaDeFabrica ya hace que la tabla no pueda declarar ese perfil;
  // esto cubre lo que entra por el cast de ventanaDe.
  if (
    ventana?.postura !== 'declarada' ||
    typeof ventana.tokens !== 'number' ||
    !Number.isFinite(ventana.tokens)
  ) {
    return base;
  }

  const umbral = Math.floor(ventana.tokens * FRACCION_VENTANA_COMPACTABLE);
  return {
    ...base,
    thresholdTokens: umbral,
    // Un umbral por debajo de la cola intacta haría que planCompaction no
    // encontrara NUNCA nada que soltar: el disparo existiría y la compactación
    // sería inalcanzable. La cola del operador, si la puso, sigue mandando.
    keepRecentTokens:
      base.keepRecentTokens ?? Math.min(colaRecientePorOmision, Math.floor(umbral / 2)),
  };
}

// ─── Response language ───

export type AgentLanguage = 'en' | 'es';

/** Language the AGENT answers in. CLI/UI text is always English; Spanish
 *  command aliases exist regardless. Default 'es' (Mexican accounting firms). */
export function resolveLanguage(cwd = process.cwd()): AgentLanguage {
  const env = process.env.MNEMOSINE_LANG?.trim().toLowerCase();
  if (env === 'en' || env === 'es') return env;
  if (env) {
    // An invalid value silently falling back to the default would make the
    // agent answer in the wrong language with no clue why.
    console.warn(
      `[mnemosine] MNEMOSINE_LANG="${process.env.MNEMOSINE_LANG}" is not supported (use en|es); ignoring it.`
    );
  }
  const { config } = loadConfigFile(cwd);
  return config.language ?? 'es';
}

/**
 * Persist the language, preserving other keys. Writes to the config file that
 * currently WINS (project > user): updating ~/.mnemosine/config.json in place
 * when it is the active config, instead of creating a project file that would
 * silently shadow the entire user config. Only when no config exists at all is
 * the project file created. Routed through writeConfigPatch so the strict
 * schema and no-secrets gates apply.
 */
export function setLanguage(lang: AgentLanguage, cwd = process.cwd()): string {
  const { source } = loadConfigFile(cwd);
  const target = source ?? path.join(cwd, 'mnemosine.config.json');
  return writeConfigPatch({ language: lang }, cwd, target);
}

// ─── Config writer (secret auto-routing) ───

// Well-known credential prefixes: Anthropic/OpenAI-style keys (sk-), GitHub
// PATs (ghp_), Slack bot tokens (xoxb-), AWS access key ids (AKIA), JWTs (eyJ).
const SECRET_VALUE_RE = /^(sk-|ghp_|xoxb-|AKIA|eyJ)/;
// Key names that normally carry credentials.
const SECRET_KEY_RE = /(key|token|secret|password)/i;
// The one legitimate value for a secret-named key: the NAME of an environment
// variable (api_key_env: "NOUS_API_KEY"), never the credential itself.
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function assertNoSecrets(value: unknown, keyPath: string[]): void {
  if (typeof value === 'string') {
    const key = keyPath[keyPath.length - 1] ?? '';
    const looksLikeSecretValue = SECRET_VALUE_RE.test(value);
    // *_cmd keys hold credential-helper COMMANDS (api_key_cmd), not credentials;
    // the value-prefix check above still catches a raw key pasted into one.
    const secretNamedWithRawValue =
      SECRET_KEY_RE.test(key) && !/_cmd$/i.test(key) && !ENV_NAME_RE.test(value);
    if (looksLikeSecretValue || secretNamedWithRawValue) {
      throw new Error(
        `Refusing to write "${keyPath.join('.')}" to the config file: the value looks like a ` +
          'credential. Config files are shareable and may end up in git — put the secret in your ' +
          '.env instead and reference it by variable name via api_key_env (or use api_key_cmd ' +
          'for a vault/credential helper).'
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, [...keyPath, String(i)]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoSecrets(v, [...keyPath, k]);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * Merges a patch into the PROJECT config file (mnemosine.config.json), or
 * into `targetFile` when given (e.g. the user-level config when it is the
 * active one), preserving unrelated keys. Two fail-closed gates, in order:
 *   1. SECRETS NEVER LAND IN THE CONFIG: any value that looks like a raw
 *      credential is refused with instructions to route it through .env +
 *      api_key_env (Hermes/OpenClaw secret auto-routing: the config stays
 *      shareable; only names of variables cross it).
 *   2. The merged result must satisfy the strict schema BEFORE writing —
 *      never persist a file that the very next load would quarantine.
 * Returns the path written.
 */
export function writeConfigPatch(
  patch: Record<string, unknown>,
  cwd = process.cwd(),
  targetFile?: string
): string {
  assertNoSecrets(patch, []);

  const file = targetFile ?? path.join(cwd, 'mnemosine.config.json');
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    // Invalid existing JSON throws here (with no quarantine: we are not
    // loading it to run, and clobbering it would destroy the user's file).
    existing = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  }
  const merged = deepMerge(existing, patch);

  const parsed = configFileSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Refusing to write an invalid configuration to ${file}: ${issues}`);
  }

  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  return file;
}
