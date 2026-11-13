# Buenas prácticas del arnés: plan de adopción a partir de Hermes Agent y OpenClaw

> Gemela en español de [`harness-best-practices.md`](harness-best-practices.md) · source_sha: f20d2b77abd934d546812889c968f7e4144a1505

> Método: 6 investigadores en paralelo leyeron la documentación y los repositorios vivos de
> [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) y
> [OpenClaw](https://docs.openclaw.ai/) en 6 facetas (sesiones/memoria,
> extensibilidad, seguridad/HITL, UX de configuración, canales/operación, observabilidad/costo),
> y extrajeron 46 prácticas concretas con sus mecanismos y fuentes.
> Hallazgos completos: [research-harness-practices.json](research-harness-practices.json).
> Cada práctica de abajo está calificada para mnemosine en particular: un agente
> contable donde la auditabilidad y la revisión humana no son negociables.

## Lo que mnemosine ya hace y coincide con sus buenas prácticas
- Escrituras en etapas con revisión humana (drafts/outbox) ≈ `write_approval` de Hermes / modo `propose` de OpenClaw: aquí vamos adelante.
- Prompt por capas con puntos de caché (estable→volátil) ≈ prompt escalonado de Hermes.
- Documentación de divulgación progresiva (`read_docs`) ≈ patrón de lista de skills.
- Perfiles multiproveedor y ayudante de credenciales (`api_key_cmd`) ≈ su configuración de proveedores.
- `doctor` (verificaciones estáticas), `onboard` (importación), propuesta de `init` (secciones del asistente).

## Ola 1 — Cimientos (todas de esfuerzo S/M, prioridad alta)

1. **Sesiones y transcripciones durables en Postgres** (tablas `sessions` y `messages`,
   tenant_id + RLS, rol/contenido/tool_calls JSONB/token_count).
   Hermes: SQLite + FTS5; OpenClaw: SQLite + archivo JSONL. Para nosotros cada
   conversación se vuelve evidencia de auditoría: POR QUÉ el agente propuso cada borrador.
   La transcripción completa nunca se borra; sólo cambia lo que ve el modelo.
2. **Reanudar sesión**: `mnemosine --continue` (la más reciente, con una miga de pan
   sensible a la terminal como en Hermes) y `--resume <id>`. Barato una vez que existe (1).
3. **Memoria curada del tenant como instantánea congelada** con topes duros de tokens
   (Hermes: MEMORY.md ≤ ~800 tokens, congelada al iniciar la sesión; nunca cambia
   a mitad de sesión, que es justo lo que maximiza los aciertos del caché del prompt). La nuestra vive
   en Postgres (resumen de precedentes), inyectada en el bloque estable; los metadatos
   activo/reemplazado de OpenClaw corresponden a los precedentes obsoletos por reforma fiscal.
4. **Topes de tamaño a los resultados de herramientas + poda proactiva sin LLM** (Hermes:
   `tool_output.max_bytes`, poda los resultados de herramientas de más de 8K caracteres cuando el historial pasa de 48K
   tokens). Determinista, no inventa nada, protege la auditoría: hacerlo ANTES de
   cualquier compactación con LLM.
5. **`mnemosine prompt-size`** (sin conexión): desglose de presupuesto fijo por componente
   (20 esquemas de herramientas, índice de docs, memoria, perfil) y qué capa está en caché.
   Detecta regresiones (un esquema de herramienta que engordó).
6. **SecretRef + enrutamiento automático de secretos en la configuración** (OpenClaw `{source:'env'|'exec',
   id}`; Hermes enruta las llaves a .env). La configuración se puede compartir sin
   fugas; `exec` integra bóvedas sin cambiar el esquema.
7. **Onboard/init verifica inferencia real antes de persistir** (OpenClaw: corre
   una completación de verdad y persiste sólo la ruta de modelo y credencial verificada;
   volver a correrlo repara en vez de reiniciar). Añadir: SELECT bajo RLS como sonda de la base de datos.
8. **Aprobación atada al contenido exacto + detección de deriva** (OpenClaw): guardar un
   hash canónico del contenido del borrador/outbox al aprobar; recalcularlo al ejecutar;
   si cambió, invalidar y regresar a revisión. Cierra la ventana TOCTOU
   entre la revisión humana y la ejecución: barato y esencial.
9. **Piso infranqueable** (lista de bloqueo estricta de Hermes, sin forma de anularla):
   codificarlo en la capa de HERRAMIENTAS (código, no prompt ni configuración): nunca registrar en periodos cerrados,
   nunca borrar pólizas (sólo revertir), nunca timbrar ni cancelar un CFDI
   sin un elemento aprobado del outbox, los montos sobre el umbral siempre van a un humano.
   Ninguna regla futura de «aprobar siempre» puede saltárselo.
10. **Envolver como no confiable el contenido de la ingesta de CFDI** (marcadores de OpenClaw +
    escaneo de ingesta de Hermes): todo campo controlado por terceros (descripciones de
    conceptos, nombres de emisores, addendas) entra al contexto envuelto como dato
    no confiable, con una regla en el prompt de sistema, en caché, de que nunca es una instrucción;
    escanear en busca de inyección y Unicode invisible antes de indexar en la memoria
    de precedentes.

## Ola 2 — Operación (esfuerzo M)

11. **Compactación segura** sólo después de (4): umbral + recuperación por desbordamiento +
    `/compact` manual; los puntos de corte nunca parten pares tool_use/tool_result;
    cola reciente `keepRecentTokens` intacta; **identifierPolicy: strict** (UUID de CFDI,
    RFC y folios deben sobrevivir textuales a los resúmenes); la transcripción completa se queda en
    Postgres: la compactación sólo cambia lo que ve el modelo.
12. **Vaciado de memoria antes de compactar** (OpenClaw): un turno silencioso que invita al
    agente a persistir los precedentes sin guardar, a través de la herramienta de escritura EN ETAPAS, de modo que se
    conserve la revisión humana. La compactación se vuelve un punto de captura de conocimiento.
13. **Políticas de aprobación graduadas** (una vez/sesión/siempre de Hermes + listas de permitidos de
    OpenClaw): las aprobaciones de outbox/revisión se pueden otorgar por patrón (por ejemplo,
    pólizas de nómina recurrentes de este tenant por debajo de $X), persistidas por tenant
    (RLS) con id + lastUsedAt. Regla que se copia textual: la política efectiva es
    SIEMPRE la más estricta entre la configuración y las aprobaciones guardadas; el piso (9) gana.
14. **Libro de uso + `mnemosine usage`**: una fila por turno (tenant, sesión,
    proveedor, modelo, tokens por tipo, costo desde una tabla local de precios);
    normaliza los campos de uso de Anthropic frente a los compatibles con OpenAI; pie opcional
    por turno. Además: atribuir el MODELO en cada borrador
    (un cambio silencioso a un modelo más débil a media revisión debe quedar registrado).
15. **Cadenas de conmutación por error según el tipo de error** (OpenClaw): conmutar sólo por auth/429/
    5xx/timeout/cobro o saldo del proveedor (billing), nunca por desbordamiento ni rechazos (esos van a
    compactación); enfriamientos escalonados de 30 s a 5 min; nueva sonda automática del principal.
16. **Sondas en vivo por capas en doctor** (Test connection de OpenClaw + status de Hermes):
    sonda en vivo por proveedor con errores CATEGORIZADOS (auth, cobro o saldo del proveedor (billing) o
    timeout cambian lo que hace el operador), `status --all` redactado y
    compartible para tickets de soporte, más verificación de que RLS está activo.
17. **Cron como tareas persistidas del agente de primera clase** (ambos lo tienen): verificación
    nocturna del cierre, conciliación CFDI contra libro, recordatorios de CxC; cada
    corrida en una sesión aislada que deposita resultados como BORRADORES REVISABLES,
    nunca escrituras directas. Trabajos persistidos y bitácora de ejecución en Postgres (RLS =
    rastro de auditoría gratis), retroceso exponencial, desactivación automática tras N fallas.
18. **Compuerta previa wakeAgent** (trabajos no_agent de Hermes): un script determinista
    consulta (¿XML nuevos? ¿descuadres?) y sólo despierta al LLM con el contexto ya analizado cuando
    hay trabajo. Costo en tokens ~0 en ciclos vacíos; la detección sigue siendo
    determinista y auditable.

## Ola 3 — Extensibilidad y canales (M/L)

19. **Skills del despacho** como SKILL.md con frontmatter YAML + divulgación progresiva
    (skills_list → skill_view → archivos de referencia) para los flujos del despacho
    (cierre de mes, lista de verificación de la DIOT, conciliación con el SAT). Índice compacto en
    el bloque estable en caché (OpenClaw), 2 herramientas nuevas (Hermes).
20. **Filtrado declarativo de skills** (requires.bins/env/config, lista de permitidos
    por agente como conjunto FINAL): los tenants sólo ven las skills que les aplican (tiene
    e.firma, ingesta de CFDI activada, régimen X). El modelo nunca ve lo que
    no debe usar.
21. **Escrituras de skills en etapas + escaneo de confianza**: los cambios a una skill van a una
    tabla skill_drafts con aprobación por diff (nuestro patrón de borradores aplicado a
    skills); las skills de terceros son código no confiable: sólo del repositorio en v1, escáner
    de patrones de exfiltración/inyección, confianza explícita por tenant.
22. **Webhooks entrantes con token dedicado + agente lector restringido**
    (hooks.mappings de OpenClaw): notificaciones del banco / buzón del SAT → un perfil de agente
    limitado a herramientas de lectura + crear borrador, contenido envuelto como
    no confiable, llave de sesión derivada del id del documento (idempotencia).
23. **Herramienta de recuerdo de sesiones con FTS** (session_search de Hermes sobre FTS5 → nuestro
    tsvector sobre messages): recuerdo histórico ilimitado bajo demanda en lugar de
    inflar el contexto vivo.

## Lo que deliberadamente NO adoptamos (o adaptamos con dureza)

- **Modo `auto` para escrituras** (exec auto de OpenClaw / yolo de Hermes): nunca en
  contabilidad. Nuestras aprobaciones graduadas (13) se detienen en el «siempre» acotado a un patrón,
  BAJO el piso infranqueable (9).
- **Consolidación autónoma de memoria** (/learn automático en segundo plano): los cambios a los precedentes
  siempre pasan por revisión en etapas; prioridad baja según lo investigado.
- **Exponer mnemosine como API compatible con OpenAI** y **recepción por canales de mensajería
  (WhatsApp/Telegram)**: valiosos más adelante; diferidos hasta que lleguen los webhooks (22)
  y los patrones de emparejamiento/lista de permitidos. Marcados como prioridad baja por la investigación por ahora.
- **Texto cifrado con valor centinela para secretos** (oc-sent-v2 de OpenClaw): excesivo para un
  CLI; en su lugar se adopta la redacción por patrón y por valor exacto (siempre activa, no configurable)
  en bitácoras y transcripciones, más una auditoría de secretos en doctor.
