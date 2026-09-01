# Plan de cierre de brechas

> Derivado del Atlas Mnemosine (mapa de 147 funcionalidades verificado contra el código el 24-ago-2026).
> Artefacto navegable: https://claude.ai/code/artifact/e4875e41-dc39-4ee6-83e4-663e44d75075

**15 paquetes · 147 tareas · 85 decisiones · ~86 semanas-persona** (S=0.3, M=0.6, L=1.2)


## Estado de ejecución

**El estado ya no se escribe aquí. Se pregunta:**

```bash
npm run plan:status
```

Un paquete queda ✅ sólo cuando TODOS sus criterios se evalúan y pasan; 🟠 cuando
ninguno falla pero alguno no se puede evaluar; 🟡 con verdes y rojos mezclados;
⬜ sin un solo verde. El comando **nombra la comprobación que falla**, no un
porcentaje. Para un paquete suelto: `npm run plan:status -- E2.1`.

Los criterios viven en [`src/plan/criterios.ts`](../src/plan/criterios.ts) y son
código: este documento los cita, el comando los decide. Cada uno afirma
comportamiento observable, nunca la existencia de un archivo o de un nombre.

### Por qué se borró la tabla que estaba aquí

Era un espejo escrito a mano del repositorio, y como todo espejo escrito a mano
se desincronizó de lo que reflejaba. En su última versión afirmaba que E1.2
seguía pendiente y que «cada factura a crédito adelanta un IVA que aún no es
acreditable» — el commit que lo arregló ya estaba en el historial. Afirmaba que
E1.3 estaba pendiente porque `getPolicy` no tenía llamadores: cierto, y sigue
siéndolo, pero nadie podía saber si seguía siéndolo sin volver a comprobarlo a
mano. Una tabla que hay que verificar a mano para creerle no sirve de nada.

Fue peor que inútil: el plan que la contenía nació con su hecho fundacional ya
refutado, porque el balance se arregló setenta y cuatro segundos antes de que el
documento se escribiera.

### Instantánea

No se copia. El estado vivo se pregunta:

    npm run plan:status                  # el plan, criterio por criterio
    npx tsx scripts/catalogo-estado.ts   # el catálogo CLI (reescribe su bloque generado en docs/cli-command-catalog.md)

(Aquí vivía la salida copiada de `plan:status`. Se pudrió como todo espejo: dos renglones más
abajo afirmaba resuelto lo que su propio texto mostraba a medias — S0.7 la retiró.)

## Antes de la primera tarea

_Esta sección decía que el repositorio no estaba bajo control de versiones, que
no había `vitest.config.ts` y que no existía `.github/`. Las tres cosas eran
falsas cuando alguien las leyó por última vez, y una de ellas —la del control de
versiones— llegó a usarse como argumento para no borrar código muerto. Las tres
las comprueba hoy `npm run plan:status -- E0.0`._

`.env` contiene las contraseñas reales de `mnemosine_app` y `mnemosine_owner`, y
por eso está en `.gitignore`. Que siga estándolo es uno de los criterios de E0.0.

## Secuencia

- **E0 · Cimientos verificables: red de seguridad, contrato con el esquema y bitácora de auditoría** — E0.2, E0.1, E0.3 · ≈19 semanas-persona (E0.1 ≈7, E0.2 ≈6.6, E0.3 ≈5.1, contando S=0.3, M=0.6, L=1.2). Con tres carriles: ~7 semanas de calendario. Es la etapa más cara en proporción a lo que 'se ve' y la única que no se puede recortar sin que todo lo demás quede indemostrable.
  - Salida: 1) `npm run test:e2e` levanta un Postgres vacío, corre todas las migraciones y pasa en verde en CI, sin depender de ningún UUID de la base de desarrollo. 2) El verificador de contrato falla el build ante cualquier tabla/columna/CHECK inexistente y las 25 divergencias están reparadas (entities→legal_entities, garnishments, benefits_plans, tax_form_filings, futa). 3) `ls src/database/migrations | sed 's/_.*//' | sort | uniq -d` devuelve vacío y migrate.ts rechaza un número repetido. 4) Un INSERT al mayor sin fila de audit_log es imposible y un UPDATE/DELETE sobre audit_log falla a nivel de Postgres, probado y no supuesto. 5) El repositorio está bajo git con CI corriendo en cada push.
- **E1 · Que la contabilidad funcione sin SQL a mano: roles de cuenta, cerebro fiscal del CFDI, políticas con consumidor y módulos sin puerta** — E1.1, E1.3, E1.2, E1.4 · ≈21 semanas-persona (E1.1 ≈4.2, E1.3 ≈4.5, E1.2 ≈6.9, E1.4 ≈5.4). Con tres carriles: ~8 semanas de calendario. E1.1 es corta pero está en la ruta crítica de tres paquetes más: arranca el día 1 de la etapa con el mejor recurso disponible.
  - Salida: 1) Una entidad creada de cero por `mnemosine init` postea factura de cliente, factura de proveedor y ambos pagos sin que nadie toque SQL, y `mnemosine doctor` lo confirma. 2) Un CFDI PPD deja el IVA en 1135/2125 y sólo el REP lo acredita o lo causa; queda rastro en cfdi_classifications; el histórico mal acreditado está corregido por reversa. 3) Cada clave de POLICY_CATALOG tiene consumidor declarado y verificado por test, o está marcada explícitamente como sin consumidor; las cuatro invocaciones de approveDraft pasan expectedHash. 4) `mnemosine assets depreciate` existe y el checklist de cierre lo engancha; inventarios y src/services/mexico/cfdi.ts están retirados o en cuarentena declarada; /public/v1 no publica datos simulados como reales.
- **E2 · Perímetro multi-inquilino activo y un solo catálogo de autorización** — E2.1, E2.2 · ≈9.3 semanas-persona (E2.1 ≈5.4, E2.2 ≈3.9). Con dos carriles: ~5 semanas de calendario. E2.2-a (catálogo puro, sin express ni pg) se escribe en paralelo desde el primer día porque todavía no toca el middleware.
  - Salida: 1) Ninguna petición HTTP alcanza Postgres fuera de withTenant, y la batería del perímetro tiene un test rojo por cada uno de los cinco vectores (?entity_id= en query string, recurso de otra entidad por :id, GraphQL sin permiso, GraphQL sin validación de entidad, /public/v1 anónimo). 2) La app arranca conectada como mnemosine_app y falla al arrancar si el rol es superusuario o si el secreto JWT es el de desarrollo. 3) `tsc` rompe ante un permiso inexistente en src/auth/roles.ts y el censo exigidos-vs-concedidos está en cero. 4) verify-isolation.sh cubre tablas hijas y vistas materializadas y es puerta de CI.
- **E3 · Fiscal real: timbrado con CSD propio y traer los CFDI del SAT** — E3.1, E3.2 · ≈14.1 semanas-persona (E3.1 ≈6.9, E3.2 ≈7.2). Con dos carriles: ~7 semanas de calendario, MÁS el plazo del trámite de credenciales del PAC y del SAT, que es tiempo de espera y no de trabajo y que hay que arrancar en E0.
  - Salida: 1) Ningún adaptador simulado puede escribir un folio fiscal como real: el cerrojo está probado con un test que intenta hacerlo y falla. 2) Una factura real se arma, se sella con el CSD custodiado en la bóveda, se timbra contra el sandbox del PAC, se persiste el XML, y un reintento con el mismo insumo no genera un segundo folio. 3) Cancelar ante el SAT dispara la reversa contable encadenada. 4) `mnemosine sat download` trae un paquete real, lo descomprime e ingiere con import_source='sat_download'; `mnemosine sat verify` sustituye el 'Vigente' simulado y alimenta satStatus del clasificador.
- **E4 · Cerrar el ciclo contable de banca y nómina, y darle al sistema dónde correr trabajo diferido** — E4.1, E4.2 · ≈16.8 semanas-persona (E4.1 ≈8.4 con tres tareas L, E4.2 ≈8.4 con tres tareas L). Con dos o tres carriles: ~7 semanas de calendario. E4.1 es el paquete individual más grande junto con E4.2 y el que más decisiones fiscales de fondo arrastra.
  - Salida: 1) Un match de conciliación queda ligado a su sesión, marca la línea del mayor una sola vez (probado con doble ejecución), y 'balanced' es una variancia calculada dentro de tolerancia, no una etiqueta. 2) Una corrida de nómina persiste paycheck_taxes, genera employer_tax_liabilities, entrega en efectivo el remanente del subsidio, y 941/940 reportan cifras distintas de cero. 3) posting.ts ya no dispara ningún REFRESH y el worker ejecuta el refresco con reclamo atómico e historial. 4) Las cuatro superficies de reportes (REST, GraphQL, herramientas del agente, external-service) consumen src/services/reporting/queries.ts y el test no-new-copies impide que vuelvan a separarse.
- **E5 · Madurez del agente y gobierno documental** — E5.1 · ≈5.1 semanas-persona (6 tareas M, 5 tareas S). Con dos carriles: ~3 semanas de calendario. Es la etapa más barata y la más fácil de reubicar.
  - Salida: 1) `mnemosine chat --resume` devuelve contexto real al modelo, verificado con una sesión que referencia un dato del turno anterior. 2) Un corpus de prueba con importes y folios pasa por la compactación sin perder ninguno. 3) El failover cambia de proveedor a mitad de sesión usando la historia compactada. 4) Existe un tope de gasto aplicado en el punto donde nace toda sesión y la tabla de precios tiene fecha de corte auditada con test de frescura. 5) `mnemosine skills stage` y la herramienta del agente crean skill_drafts sobre una raíz única. 6) NIF, NIIF y cli-reference tienen índice generado y test de sincronía.

**Ruta crítica:** E0.2 → E0.1 → E1.1 → E1.4 → E4.1 → E4.2

## Se puede empezar hoy

- `E0.1-a · Arnés de cliente pg falso y separación de proyectos vitest (unitario vs integración)` — Hoy `npm test` invoca vitest sin ningún vitest.config.ts en el repositorio, con 81 archivos .spec.ts mezclando pruebas que necesitan Postgres con las que no. En una tarde queda separado el proyecto unitario del de integración y existe un fake-pg reutilizable: a partir de ahí CUALQUIER otra tarea del plan puede escribir su prueba en vez de esperar a que alguien monte la infraestructura.
- `E0.2-e · `entities` no existe: siete consultas contra legal_entities y las columnas que le faltan` — Los cuatro generadores de formas fiscales de EE.UU. (941, 940, W-2, W-3) consultan una tabla llamada `entities` que el esquema no tiene: revientan en tiempo de ejecución la primera vez que alguien los invoca. Es un cambio de nombre de tabla en cuatro archivos, sin dependencias, y convierte cuatro funcionalidades muertas en ejecutables el mismo día.
- `E1.1-f · Dejar de mentir en el mensaje MISSING_ROLE_ACCOUNT` — Es el error que encuentra todo el mundo al crear una entidad nueva, y el mensaje no dice cómo salir de él. Cambiar el texto por el rol exacto que falta y el comando que lo siembra no arregla la causa (eso es el resto de E1.1) pero desatasca a cualquiera que esté probando el sistema mientras tanto, incluidos los propios desarrolladores del plan.
- `E1.4-a · Purgar el valor en claro y el blinding factor del range proof, y limpiar las filas ya escritas` — Una 'prueba de rango' que guarda el valor en claro junto a la prueba no prueba nada, y los datos ya escritos siguen ahí. Tarea S que elimina una fuga de datos existente y limpia lo ya persistido. No espera a nadie; sólo hay que reservarle número de migración con la política de E0.2-k.
- `E1.4-c · Sanear el router público: handlers que no cuelguen y dejar de exponer tenant_id sin autenticación` — /public/v1 es anónimo, filtra el tenant_id y tiene handlers que dejan la petición colgada. Cerrarlo hoy quita el peor agujero de la superficie pública y simplifica la decisión de E2.1-f sobre qué hacer con ese router bajo RLS, porque llega a esa discusión ya sin datos sensibles que proteger.
- `E2.1-a · runInTenant() síncrono, middleware tenantContext y cierre de las dos fugas de enterWith` — Adelantar esta tarea S al día 1 —aunque el resto de E2.1 se ejecute en la etapa E2— fija la firma con la que todo el código nuevo de E1, E3 y E4 debe pedir su conexión. Sin esto, tres etapas de código nuevo se escriben contra pool.query() directo y hay que revisarlas archivo por archivo cuando llegue el perímetro. Es la mitigación más barata del mayor riesgo de reproceso del plan.

## Decisiones bloqueantes por etapa

### E0 · Cimientos verificables

- Dónde vive el repositorio y la CI: el proyecto no está bajo control de versiones y dos tareas del plan escriben .github/workflows/ci.yml. Sin esta decisión, E0.1-l y E0.2-l no tienen dónde ejecutarse y ninguna etapa posterior tiene puerta de calidad.
- Política de numeración de migraciones y si se renumeran los archivos duplicados existentes (012, 014, 015, 018). Bloquea a las diez tareas de otros paquetes que planean crear un 031_*.sql.
- Con qué rol de base de datos corre la suite de integración. Debe decidirse aquí y no en E2.1: si la suite corre como superusuario nunca detectará una política RLS faltante y el perímetro de E2 llegará a producción sin haber sido probado nunca.
- Ante una divergencia entre el vocabulario Zod del código y el CHECK de Postgres, ¿manda el código o el esquema? Y en el mismo sentido: las columnas que el código de nómina inventó, ¿se agregan al esquema o se elimina el código que las usa? Determina el sentido de las 25 reparaciones.
- D1 de E0.3: un fallo al escribir la auditoría, ¿aborta la operación auditada (fail-closed) o sólo alerta? Cambia la firma de recordAudit y el manejo de errores de posting.ts, period-close.ts, draft-service.ts y external-service.ts a la vez.
- D2 de E0.3: audit_log.user_id es UUID NOT NULL. ¿Qué se escribe cuando el actor no es una persona (cron, arranque, reintento de outbox)? Sin esto no se puede escribir la migración de auditoría.
- ¿postJournalEntry debe atestar el asiento, como ya hace createJournalEntry con autoPost? Define el comportamiento que las pruebas de E0.1-c van a congelar.
- ¿La cobertura es puerta de CI y con qué umbral? ¿El cierre suave bloquea asientos o sólo advierte? ¿Se eliminan scripts/e2e-reversal.ts y scripts/e2e-arap.ts al portarlos o se conservan? Las tres fijan aserciones de la suite.
- Recomendada adelantar desde E2.1: la firma de runInTenant() y el rol mnemosine_app, para que todo el código de E1, E3 y E4 nazca dentro del contexto de inquilino.

### E1 · Que la contabilidad funcione sola

- Qué hace el sistema cuando el catálogo de cuentas de la entidad NO contiene los códigos que ROLE_MAP espera —el caso de una entidad onboardeada desde otro sistema, cuyo catálogo lo creó executeOnboarding a partir del balance remoto (src/ai/onboarding-service.ts:179). Define si ensureEntityAccounting es idempotente y seguro o si rompe entidades vivas.
- En bases ya desplegadas con entidades vivas, ¿el backfill crea cuentas por su cuenta o sólo mapea lo que encuentra? Determina si E1.1-g es una tarea de datos reversible o una que altera catálogos contables existentes.
- ¿El catálogo de roles esperados se materializa en la base (account_role_catalog + vista v_account_roles_missing) o se queda en TypeScript? Afecta al chequeo del doctor, al backfill y a los tres roles nuevos que E1.4-e y E4.1-d añadirán después.
- ¿Se sigue mapeando tres retenciones distintas a la misma cuenta 2140 y 'impuestos_locales_gasto' a la misma 6100 que 'gasto', o se abre el soporte de qualifiers? Afecta a E1.1, E1.2 y E4.1 por igual.
- D1, D2 y D3 de E1.4 —depreciación, inventarios y blockchain: ¿construir, etiquetar como simulación o retirar? Son decisiones de producto, no técnicas, y la de depreciación determina además si existe E4.2-f en la etapa E4.
- Con el clasificador cableado, ¿un CFDI cuyo veredicto es 'ready' se contabiliza de forma determinista sin pasar por el modelo, o sigue generando un ai_draft para revisión humana? Define el contrato entre E1.2 y E1.3-c y el coste operativo de la ingesta.
- En la remediación del histórico de IVA de PPD mal acreditado: ¿qué universo se corrige y con qué fecha se reversa? Es irreversible en la práctica y toca periodos que pueden estar cerrados.
- Precedencia entre mnemosine.config.json y la política del tenant para los umbrales de ingesta (D7 de E1.3): si no se decide, dos fuentes de verdad compiten en el mismo camino de auto-posteo.
- D2 de E1.3: politica_restaurantes = 'split_85', ¿se implementa el prorrateo 8.5/91.5 o la política se declara sin consumidor? Y D5: efirma_accion_anomalia ofrece 'bloquear_fuera_horario' y no existe ninguna ventana horaria en el sistema.

### E2 · Encender el perímetro

- Qué se hace con /public/v1, que la RLS deja sin datos por ser anónimo y no poder tener contexto de inquilino. Hay que coordinarla con E1.4-b/c, que ya desmonta ese router por defecto: si E1 lo retira y E2 lo reconstruye con una política de lectura, es trabajo hecho dos veces.
- ¿Se mantiene una transacción por consulta o se pasa a una conexión por petición? Es la decisión de arquitectura de conexiones del sistema entero; cambiarla después de E2.1-b significa reescribir el middleware y revisar cada servicio.
- Cuando el recurso pertenece a otra entidad del MISMO inquilino, ¿403 o 404? Define las aserciones de la batería del perímetro (E2.1-h) y no se puede cambiar sin reescribirlas.
- ¿Se retira la rama HS256 de authenticate, cuyo secreto cae por defecto en 'dev-secret-change-me' y que no tiene ningún emisor legítimo detrás, o basta con abortar el arranque si el secreto es el de desarrollo?
- Cómo se cubren los permisos de nómina (payroll:read/create/update/approve), que hoy sólo puede ejercer owner en los 36 endpoints de /v1/payroll, y quién debe tener settings:manage, el permiso más exigido del sistema (30 rutas). Sin esto, el catálogo único de E2.2-a no se puede escribir.
- ¿Los permisos efectivos se derivan del catálogo a partir de users.roles en cada autenticación, o se siguen materializando como copia en users.permissions? Determina si el doctor detecta deriva o si la deriva deja de ser posible.
- ¿Cuál es el modo por defecto de 'segregacion_de_funciones' (maker-checker) y sobre qué documentos se aplica? ¿Se retiran los montajes duplicados de xml-ingestion y blockchain?

### E3 · Fiscal real

- ¿Con qué PAC se hace la integración real primero y quién consigue las credenciales de su sandbox? Es la única decisión del plan con plazo externo: debe tomarse y ejecutarse durante E0, no al empezar E3.
- ¿El sellado se hace con nuestro CSD custodiado en la bóveda o se delega al PAC subiéndole el CSD? Cambia qué credenciales hay que tramitar, y por tanto se decide ANTES del punto anterior.
- ¿Dónde vive el XML timbrado: en Postgres o en un almacén de objetos? Determina la migración de timbrado y añade —o no— una dependencia de infraestructura nueva al despliegue.
- Cuando la cancelación queda 'En proceso' (comprobante cancelable con aceptación del receptor), ¿se anula el asiento contable de inmediato o se espera al acuse definitivo? Es una decisión contable con consecuencias fiscales.
- ¿Se implementa ahora el motor de exenciones del artículo 93 de la LISR o se capturan los importes exentos como dato de entrada? Es la diferencia entre una tarea L y una M en E3.1-h, y entre una nómina auditable y una que confía en la captura.
- ¿El UUID fiscal queda registrado en el asiento contable o basta el enlace a través de la factura? Toca el esquema del mayor, que E0 acaba de poner bajo contrato.
- ¿Se conservan los adaptadores simulados detrás del cerrojo o se eliminan? ¿Lector de ZIP propio o dependencia (yauzl/adm-zip)? ¿Se guarda el ZIP crudo del SAT y se soporta tipoSolicitud='Metadata'?
- ¿La descarga desatendida deja que el motor de reglas auto-contabilice lo que trae? Interactúa directamente con la política de auto-posteo decidida en E1.3. Y qué hace el sistema al detectar el patrón anómalo de acceso a la e.firma (efirma_accion_anomalia).

### E4 · Cerrar los ciclos

- Qué régimen del subsidio al empleo aplica para el año fiscal que el sistema va a calcular: el tabular con entrega en efectivo del excedente, o el de porcentaje fijo de UMA en el que el subsidio no puede exceder al ISR ni entregarse en efectivo. Es la decisión más cara de retrasar: E4.1-h y E4.1-i se implementan distinto y se rehacen enteras si cambia.
- ¿El asiento de nómina abona el neto directamente a banco o a un pasivo 'Sueldos por Pagar' que se cancela con un segundo asiento al dispersar? Define si E4.1-l existe o no.
- ¿El runtime de trabajos se construye sobre bullmq + Redis —ambos ya están en package.json aunque no se usen para esto— o se extiende el patrón de tareas persistidas en Postgres que ya existe en src/ai/jobs (reclamo atómico, wake-gate, runner, `mnemosine jobs run-due`)? Toda la arquitectura de E4.2 y la topología de despliegue cuelgan de aquí.
- Cómo se despliega el worker: proceso propio de larga vida, `worker tick` desde cron externo, o dentro del proceso HTTP. Decisión de operación previa a escribir el runtime.
- Qué se hace con mv_trial_balance y mv_account_balance_summary, que no tienen un solo lector, antes de invertir en refrescarlas desde el worker. Si se borran, E4.2-c se simplifica a una migración.
- En la balanza filtrada por periodo fiscal, ¿el importe devuelto incluye el saldo de apertura arrastrado? Es la semántica de beginning_balance/ending_balance y define qué unifican los reportes.
- Al unificar los cuatro SQL de reportes, qué se hace con las divergencias reales entre las copias actuales (HAVING del estado de resultados, orden de la antigüedad, 2 vs 4 decimales, account_level obligatorio, only_with_balance). Cada una es un cambio observable para algún consumidor.
- ¿El calendario de entero de los pasivos fiscales es constante por jurisdicción o se configura por entidad? ¿El ajuste de conciliación desglosa el IVA de las comisiones bancarias? ¿Los intereses se registran brutos con retención de ISR desglosada o netos? ¿Se permite conciliación parcial desde el primer día?
- ¿Se puede persistir el cuerpo crudo de los webhooks entrantes y por cuánto tiempo? Y cuando la revalidación descubre que un CFDI ya contabilizado fue cancelado por el emisor, ¿qué hace el sistema? Debe ser la misma respuesta que la decidida en E3.2-i o habrá dos comportamientos para el mismo hecho.

### E5 · Madurez del agente

- Quién es el dueño del presupuesto de IA: E4.2-h y E5.1-e implementan lo mismo. Hay que decidirlo antes de que la primera de las dos se ejecute, no cuando la segunda descubra que ya existe. Y si el presupuesto es por entidad o por tenant.
- ¿El presupuesto viene apagado por defecto o con un tope duro, y bloquea o sólo avisa en las rutas desatendidas? En una ruta desatendida, 'sólo avisa' significa que no hay tope.
- ¿Qué cuenta como IMPORTE para el backstop determinista de la compactación y qué formato numérico se asume? Sin una definición cerrada, el test que garantiza que no se pierden importes no se puede escribir.
- ¿`--continue` rehidrata por defecto, aunque cueste una llamada al modelo al arrancar? Intercambio entre coste por sesión y utilidad; determina si E5.1-b es un cambio de comportamiento o una bandera.
- ¿Qué hacer cuando un turno falla en el proveedor vivo DESPUÉS de haber ejecutado una herramienta de escritura? Es la decisión más delicada de la etapa: mal resuelta, el failover duplica asientos.
- ¿Puede el AGENTE proponer cambios a skills (herramienta propose_skill) o sólo el humano por `mnemosine skills stage`? Define si E5.1-h entrega una o dos entradas.
- Qué alcance tiene el registro NIF —sólo lo que el corpus ya cubre o el catálogo completo del CINIF— y cuál es la ventana de frescura de la tabla de precios antes de que el test de gobierno falle.

---

## E0 · Cimientos verificables

### E0.0 · Control de versiones, un solo archivo de CI y reparto de números de migración
**Objetivo.** Poner las 41 847 líneas bajo git antes de tocar nada, dejar un único flujo de CI al que los demás paquetes solo añaden jobs, y repartir de antemano los números de migración para que catorce paquetes no colisionen.

**Por qué aquí.** Verificado a mano: `git status` responde «not a git repository» y no existe .git, ni vitest.config.ts, ni .github/. Ejecutar 144 tareas sobre un árbol sin historial significa que ningún cambio se puede revisar, revertir ni bisecar. Además el revisor encontró que nueve paquetes crean cada uno un archivo llamado 031_*.sql y que dos crean el mismo ci.yml: ambas colisiones se evitan decidiéndolo una vez, aquí.

**Depende de:** — · **Migraciones:** `031-034` · **3 tareas · 0.9 sem-persona**

#### Decisiones a resolver

**¿Dónde se aloja el repositorio y quién tiene acceso?**

El proyecto custodia e.firmas de clientes y contabilidad real. El alojamiento determina quién puede leer el código que toca esas credenciales.

- GitHub privado
- GitLab autoalojado
- Solo local con respaldo cifrado

_Recomendación:_ GitHub privado: es lo que asume el flujo de CI especificado y da revisión por pares sin infraestructura propia. Si hay restricción de que el código no salga, GitLab autoalojado y el mismo ci.yml sobre su runner.

_Bloquea:_ E0.0-b y, con él, todos los criterios de cierre que dicen «pasa en CI».

#### Tareas

##### `E0.0-a` Inicializar el repositorio y su primer commit · **S**

git init sobre /Users/victor/projects/Accounting. Escribir .gitignore que excluya node_modules, dist, .env, tests/fixtures/certs/*.key y cualquier material de credenciales. VERIFICAR ANTES DEL PRIMER COMMIT que .env no queda incluido: contiene DATABASE_URL con contraseñas reales de mnemosine_app y mnemosine_owner. Añadir .env.example con las claves sin valores. Primer commit con el árbol completo como línea base.

**Archivos**

- `.gitignore` — crear: node_modules, dist, .env, *.key, material de bóveda local
- `.env.example` — crear: claves sin valores

**Criterios de aceptación**

- `git status` responde con una rama y un árbol limpio.
- `git log --stat -1 | grep -c '\.env$'` devuelve 0: el archivo con contraseñas no entró en el historial.
- `git ls-files | wc -l` es coherente con el árbol sin node_modules ni dist.

**Riesgo.** Cometer .env en el primer commit deja contraseñas en el historial para siempre: verificar ANTES de commitear, no después.

##### `E0.0-b` Un único .github/workflows/ci.yml con jobs nombrados · **S**

Crear el flujo con un servicio postgres:15 y jobs separados: `typecheck` (tsc --noEmit y tsc -p tsconfig.test.json), `unit` (vitest run), `integration` (migraciones sobre base vacía + npm run test:e2e), `aislamiento` (scripts/verify-isolation.sh). Los paquetes E0.1, E0.2, E2.1 y E2.2 AÑADEN jobs a este archivo; ninguno lo crea de nuevo. Documentar esa regla en el propio archivo como comentario de cabecera.

**Archivos**

- `.github/workflows/ci.yml` — crear: flujo único con jobs typecheck/unit/integration/aislamiento

**Criterios de aceptación**

- El flujo corre en cada push y falla si cualquiera de los cuatro jobs falla.
- Ningún otro paquete crea .github/workflows/ci.yml: solo lo modifican.

##### `E0.0-c` Repartir los números de migración y bloquear los choques · **S**

Hoy hay 35 archivos y la última numerada es 030, con cuatro números duplicados (012, 014, 015, 018) ya aplicados en bases existentes: NO se renumeran, se documentan. Reservar rangos por etapa para el trabajo nuevo — E0: 031-034 · E1: 035-039 · E2: 040-042 · E3: 043-046 · E4: 047-050 · E5: 051-053 — y anotar el rango asignado en la cabecera de cada paquete. Añadir a migrate.ts (o a un test) una comprobación que falle si dos archivos comparten prefijo numérico, con excepción explícita para los cuatro duplicados históricos.

**Archivos**

- `src/database/migrate.ts` — modificar: rechazar prefijos numéricos duplicados salvo la lista histórica
- `docs/migraciones.md` — crear: reparto de rangos y los cuatro duplicados históricos

**Criterios de aceptación**

- Dado un archivo nuevo que repite un número ya usado, cuando corre npm run migrate o el test, entonces falla nombrando ambos archivos.
- Los cuatro duplicados históricos no hacen fallar la comprobación.

**Pruebas**

- `tests/database/migration-numbering.spec.ts` — detecta prefijos duplicados y tolera los históricos

#### Cómo se sabe que cerró

- `git log` muestra historial y `.env` nunca aparece en él.
- Un push hace correr los cuatro jobs y el badge queda en verde.
- `ls src/database/migrations | cut -c1-3 | sort | uniq -d` solo devuelve los cuatro duplicados históricos documentados.


### E0.1 · Red de seguridad del motor contable: pruebas unitarias, suite de integración reproducible y CI
**Objetivo.** Poner bajo prueba automatizada el único punto de escritura al libro mayor (posting.ts), el cierre de periodo (period-close.ts), la numeración atómica (sequence.ts) y las dos reglas de validación sin cobertura, y convertir los dos scripts E2E manuales —hoy atados a UUID de una base de desarrollo— en una suite de integración que cualquiera puede correr contra un Postgres vacío con `npm run test:e2e` y que una CI ejecuta en cada cambio.

**Por qué aquí.** Todos los paquetes posteriores tocan este núcleo: sembrar account_roles, corregir la cuenta de utilidades acumuladas, auditar desde el motor, cablear el clasificador CFDI y cerrar el ciclo de conciliación cambian código que hoy no tiene una sola prueba propia. Verificado: ningún archivo de tests/ importa src/services/accounting/posting.ts, src/services/accounting/period-close.ts ni src/utils/sequence.ts (el único que menciona period-close, tests/ai/close-service.spec.ts, la mockea). Sin esta red, cada corrección posterior se hace a ciegas y la única evidencia sigue siendo dos scripts con UUID fijos que no corren con `npm test` y que ninguna CI ejecuta (no existe .github/ ni .git). Además no depende de nada: el fixture puede llamar a seedAccountRoles directamente sin esperar a que se cablee a `mnemosine init`.

**Depende de:** `E0.0` · **Migraciones:** `031-034` · **12 tareas · 7.2 sem-persona**

**Precondiciones:**

- Postgres 15 accesible con un rol capaz de CREATE DATABASE y de crear las extensiones uuid-ossp, pgcrypto y pg_trgm (las tres son trusted desde PG13, así que basta el dueño de la base). En local sirve el servicio `postgres` de docker/docker-compose.yml.
- Node >= 20 (package.json engines) y el package-lock.json en sincronía para `npm ci`.
- El repositorio debe estar bajo git con un remoto para que el flujo de CI llegue a ejecutarse: hoy /Users/victor/projects/Accounting NO es un repositorio git (verificado: `git status` responde 'not a git repository'). Ver decisión sobre dónde vive la CI.
- La cadena de migraciones 001→030 debe poder correr completa sobre una base vacía. Nunca se ha verificado que así sea; es el primer criterio de aceptación de la tarea E0.1-h y cualquier rotura se arregla dentro de este paquete.

#### Decisiones a resolver

**¿postJournalEntry debe atestar el asiento, como ya hace createJournalEntry con autoPost?**

Verificado en el código: createJournalEntry con autoPost captura el tenant dentro de la transacción y lanza attestEntryAsync tras el commit (posting.ts:199-226); reverseJournalEntry y voidJournalEntry hacen lo mismo. postJournalEntry (posting.ts:229-298) no atesta en absoluto. Consecuencia: todo asiento creado como borrador y posteado después —el camino de la ruta REST POST /journal-entries/:id/post y de cualquier flujo de aprobación— nunca llega a la cadena. Escribir una prueba que declare esto 'esperado' congelaría la asimetría.

- Corregir ahora: replicar el patrón resolveTenantId + attestEntryAsync tras el commit dentro de postJournalEntry (unas 6 líneas) y asertarlo en E0.1-c.
- Documentar el hueco con una prueba que afirma que NO atesta, y dejar la corrección al paquete de auditoría/atestación.
- Unificar en un solo punto: extraer un helper `postearEnTx` compartido por createJournalEntry(autoPost) y postJournalEntry para que la atestación no pueda olvidarse.

_Recomendación:_ Corregir ahora (opción 1). Es pequeño, cabe en el mismo cambio que la prueba y evita que la red de seguridad certifique un agujero. La unificación (opción 3) es mejor a medio plazo pero toca demasiado código para un paquete cuyo propósito es no cambiar comportamiento.

_Bloquea:_ E0.1-c (el caso 8 no se puede escribir hasta decidirlo)

**¿Con qué rol de base de datos corre la suite de integración?**

Un superusuario ignora RLS por completo, así que la suite pasaría sin ejercitar el perímetro multi-tenant. mnemosine_owner sí está sujeto a FORCE ROW LEVEL SECURITY (rls-policies.sql:54-55) y además puede crear la base y limpiarla; mnemosine_app no puede hacer DDL ni TRUNCATE por diseño (scripts/provision-roles.sql). Correr como owner exige haber ejecutado provision-roles.sql, que necesita superusuario y es un paso extra en cada máquina de desarrollo.

- CI como mnemosine_owner (RLS real) y local como superusuario por defecto, con TEST_DB_OWNER como interruptor.
- Siempre mnemosine_owner, documentando provision-roles.sql como requisito de la primera vez.
- Siempre superusuario, dejando toda la verificación de RLS a verify-isolation.sh.

_Recomendación:_ Opción 1. La CI es donde una regresión de aislamiento debe morir, y el desarrollador local no debería necesitar provisionar roles para correr las pruebas del motor contable. La diferencia queda visible en un único parámetro (TEST_DB_OWNER) en vez de escondida.

_Bloquea:_ E0.1-h y E0.1-l

**El proyecto no está bajo control de versiones: ¿dónde vive la CI?**

Verificado: /Users/victor/projects/Accounting no es un repositorio git (no existe .git) y por tanto tampoco hay remoto. Un archivo .github/workflows/ci.yml es correcto pero inerte hasta que exista un repositorio en GitHub. Todo el valor de este paquete —que una regresión falle antes de llegar a producción— depende de esto.

- git init + repositorio privado en GitHub y el workflow tal cual.
- Otro alojamiento (GitLab/Gitea) y traducir el workflow a su formato.
- Sin CI remota: un gancho pre-commit o un script `npm run verificar` que corra typecheck + unitarias + integración en local.

_Recomendación:_ Opción 1. Es la que hace efectivo el resto del paquete y la que menos trabajo añade; el workflow ya está escrito para GitHub Actions. Si se descarta, hay que decir explícitamente que E0.1-l no se entrega y que la garantía queda en manos de la disciplina de quien programa.

_Bloquea:_ E0.1-l entero

**¿Se eliminan scripts/e2e-reversal.ts y scripts/e2e-arap.ts al portarlos, o se conservan?**

Los dos scripts dejan de ser ejecutables en cuanto la base demo cambie de UUID, y mantener dos fuentes de verdad para la misma comprobación garantiza que una de ellas se desactualice. Por otro lado, son útiles como sonda manual contra una base real ya poblada, cosa que la suite —que crea su propio tenant— no hace.

- Eliminarlos: la suite de integración los sustituye por completo.
- Conservarlos reescritos sobre el fixture (sin UUID fijos) como comandos de diagnóstico manual.
- Conservarlos tal cual con un aviso en la cabecera.

_Recomendación:_ Opción 1. Cualquier necesidad de sondar una base real se cubre mejor apuntando TEST_ADMIN_DATABASE_URL a esa instancia; conservar código con UUID de una máquina concreta es exactamente la deuda que este paquete viene a saldar.

_Bloquea:_ E0.1-i y E0.1-j (sólo el paso de borrado)

**¿La cobertura es una puerta de CI y con qué umbral?**

Las métricas de cierre proponen 85% en posting.ts, 100% en sequence.ts, 90% en validation.ts y 70% en period-close.ts. Convertirlas en puerta desde el primer día puede bloquear cambios legítimos en archivos vecinos; no convertirlas en puerta hace que la cobertura se erosione en semanas.

- Sin puerta: la CI publica el informe y nada más.
- Puerta sólo sobre los cuatro archivos del motor, con los umbrales indicados (vitest coverage.thresholds.perFile con glob).
- Puerta global sobre todo src/ con un umbral bajo (40%) que sólo impida retrocesos grandes.

_Recomendación:_ Opción 2. El objetivo del paquete es proteger el motor contable, no todo el repositorio; una puerta acotada a esos cuatro archivos es exigible y no penaliza el trabajo en el resto del código.

_Bloquea:_ E0.1-l (paso de cobertura), y decide si el script test:coverage entra o no en el workflow

**¿El cierre suave bloquea asientos o sólo advierte?**

periodStatusRule (validation.ts:134-142) trata 'soft_close' como advertencia y deja pasar el asiento, mientras la CLI anuncia que el cierre suave bloquea nuevos asientos. Las pruebas E0.1-e (caso soft_close) y E0.1-i (caso 8, reversa en periodo con cierre suave) tienen que asertar una de las dos cosas.

- Fijar el comportamiento actual (advertir) y dejar la corrección al paquete de semántica del cierre, con un comentario que lo señale.
- Cambiar aquí mismo la regla para que 'soft_close' bloquee salvo entry_type 'adjusting'/'closing'/'reversing'.
- Fijar el comportamiento actual pero añadir un it.todo con la semántica deseada.

_Recomendación:_ Opción 3. Este paquete no debe cambiar comportamiento contable, pero tampoco debe dejar la contradicción invisible: el it.todo la mantiene a la vista de quien tome la decisión, sin congelarla como contrato.

_Bloquea:_ E0.1-e y el caso 8 de E0.1-i

#### Tareas

##### `E0.1-a` Arnés de cliente pg falso y separación de proyectos vitest (unitario vs integración) · **S**

Hoy `npm test` es `vitest` (modo watch en TTY) y recoge todo tests/**/*.spec.ts; las pruebas unitarias mockean `query` con vi.fn() suelto (patrón de tests/accounting/validation.spec.ts y tests/ai/close-service.spec.ts). posting.ts y period-close.ts no se pueden probar así: sus funciones corren sobre un `pg.PoolClient` que reciben de `withTransaction`, no sobre `query`. Crear un arnés reutilizable.

En tests/helpers/fake-pg.ts exportar:

  export interface RegistroConsulta { sql: string; params: unknown[] }
  export interface ReglaConsulta {
    cuando: RegExp;
    responde: { rows?: unknown[]; rowCount?: number }
            | ((sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number });
    unaVez?: boolean;
  }
  export function clienteFalso(reglas: ReglaConsulta[]): {
    client: pg.PoolClient;
    consultas: RegistroConsulta[];
    coincidencias(re: RegExp): RegistroConsulta[];
  }

Comportamiento exigido:
- antes de evaluar las reglas normaliza el SQL con `sql.replace(/\s+/g, ' ').trim()`; `consultas` guarda el SQL normalizado y los params;
- gana la PRIMERA regla que coincide; con `unaVez: true` la regla se consume (permite que la misma SELECT devuelva algo distinto la segunda vez, que es lo que necesita createJournalEntry al releer el asiento tras el UPDATE);
- si ninguna regla coincide, LANZA `new Error('Consulta no esperada por el arnés: ' + sql)`. Nunca devolver `{ rows: [] }` por defecto: un default silencioso hace pasar pruebas contra SQL que ya cambió, que es exactamente la clase de bug que este paquete existe para atrapar;
- `client.release` y `client.query` son vi.fn(); `client.query` acepta la firma `(text, params?)` que usa todo el repo.

En tests/helpers/entidades.ts exportar constructores `asientoFalso(overrides?: Partial<JournalEntry>): JournalEntry` y `lineaFalsa(overrides?: Partial<JournalEntryLine>): JournalEntryLine` con valores por defecto coherentes con el esquema (id, entity_id, fiscal_period_id, status 'draft', entry_number 'JE-2026-00007', entry_type 'standard', total_debits/total_credits).

Separar los proyectos de vitest:
- vitest.config.ts (unitario): include ['tests/**/*.spec.ts'], exclude ['tests/integration/**', 'node_modules/**', 'dist/**'];
- vitest.integration.config.ts se define en E0.1-h.

Scripts de package.json: `test` = `vitest run --config vitest.config.ts` (deja de ser watch: la CI lo necesita), `test:watch` = `vitest --config vitest.config.ts`, `test:coverage` = `vitest run --config vitest.config.ts --coverage`.

Añadir devDependency `@vitest/coverage-v8@^1.2.0`: el script test:coverage existe desde antes pero el proveedor de cobertura NO está instalado (verificado en devDependencies), así que hoy falla.

tsconfig.json excluye "tests", de modo que `npm run typecheck` no comprueba ni un archivo de prueba. Crear tsconfig.test.json que extienda ./tsconfig.json con { "include": ["tests/**/*.ts", "src/**/*.ts"], "compilerOptions": { "noEmit": true } } y el script `typecheck:tests` = `tsc -p tsconfig.test.json --noEmit`.

**Archivos**

- `tests/helpers/fake-pg.ts` — crear: arnés clienteFalso con enrutado por RegExp, registro de consultas y fallo ruidoso ante SQL no previsto
- `tests/helpers/entidades.ts` — crear: constructores asientoFalso/lineaFalsa
- `vitest.config.ts` — crear: proyecto unitario que excluye tests/integration
- `tsconfig.test.json` — crear: extiende tsconfig.json e incluye tests/ (hoy excluidos del typecheck)
- `package.json` — modificar: scripts test/test:watch/test:coverage/typecheck:tests y devDependency @vitest/coverage-v8

**Criterios de aceptación**

- Dado un clienteFalso con una sola regla /FROM fiscal_periods/, cuando el código bajo prueba ejecuta un INSERT no previsto, entonces la promesa se rechaza con un mensaje que contiene 'Consulta no esperada por el arnés' y el SQL completo.
- Dada una regla con unaVez:true, cuando la misma SELECT se ejecuta dos veces, entonces la segunda vez responde la siguiente regla que coincida (o falla si no hay ninguna).
- `npm test` termina sin quedarse en watch y no incluye ningún archivo de tests/integration/.
- `npm run test:coverage` genera informe sin pedir instalar nada.
- `npm run typecheck:tests` sale con código 0 y comprueba los archivos de tests/.

**Pruebas**

- `tests/helpers/fake-pg.spec.ts` — el arnés lanza ante SQL no previsto en vez de devolver filas vacías, y consume las reglas unaVez en orden

**Riesgo.** Cambiar `test` de watch a `vitest run` altera el hábito de quien lo usa a diario; se compensa con test:watch. El arnés que falla ruidosamente hará más ruidosas las pruebas futuras: es intencional, pero conviene documentarlo en el encabezado del archivo.

##### `E0.1-b` Pruebas unitarias de createJournalEntry en sus dos ramas · **M**

createJournalEntry (src/services/accounting/posting.ts:60) tiene dos ramas de ejecución (autoPost sí/no) y dos modos de transacción (options.client del llamador vs withTransaction propia), más la mecánica de atestación diferida al commit mediante el objeto `attest`.

En tests/accounting/posting-create.spec.ts declarar los mocks de módulo (vi.mock se iza, van arriba del archivo):
- '../../src/database/connection.js' → { query: vi.fn(), withTransaction: vi.fn(), currentTenant: vi.fn() }
- '../../src/services/accounting/validation.js' → { validateJournalEntry: vi.fn() }
- '../../src/services/blockchain/orchestrator.js' → { blockchainOrchestrator: { attestJournalEntry: vi.fn().mockResolvedValue(null) } }
- '../../src/utils/sequence.js' → { nextEntityNumber: vi.fn().mockResolvedValue('JE-2026-00007') } — mockear la numeración mantiene esta suite independiente del reloj del sistema (formatDocumentNumber usa new Date().getFullYear()).

Un array compartido `orden: string[]`: withTransaction.mockImplementation(async (fn) => { const r = await fn(client); orden.push('commit'); return r; }) y attestJournalEntry.mockImplementation(async () => { orden.push('attest'); return null; }).

Reglas del clienteFalso: /FROM fiscal_periods/ → [{ id: 'fp-1' }]; /INSERT INTO journal_entries/ → []; /INSERT INTO journal_entry_lines/ → []; /SELECT \* FROM journal_entries WHERE id/ → [asiento]; /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/ → [líneas]; /UPDATE journal_entries SET status = 'posted'/ → []; /INSERT INTO account_balances/ → []; /SELECT tenant_id FROM legal_entities/ → [{ tenant_id: 't-lookup' }].

Casos a cubrir:
1. Rama sin autoPost: devuelve el asiento con status 'draft' y sus líneas; NO se llamó validateJournalEntry; no hay ninguna consulta que coincida con /UPDATE journal_entries SET status = 'posted'/ ni con /INSERT INTO account_balances/; attestJournalEntry no se llamó.
2. Rama autoPost: validateJournalEntry recibió (entry, lines) exactamente una vez; se ejecutó el UPDATE a 'posted' con params [fecha, createdBy, entryId]; hay exactamente `lines.length` consultas /INSERT INTO account_balances/ y cada una contiene 'ON CONFLICT (account_id, fiscal_period_id)' y lleva params [account_id, fiscal_period_id, entity_id, debit_amount, credit_amount].
3. Atestación DESPUÉS del commit: orden === ['commit', 'attest'] (invertirlo es el bug que el comentario de posting.ts:195 advierte: el orquestador relee el asiento de la base).
4. Con options.client: withTransaction no se llamó y attestJournalEntry tampoco (el docstring de posting.ts:75-80 asigna esa responsabilidad al llamador).
5. currentTenant() devuelve 't-ctx': no hay consulta /SELECT tenant_id FROM legal_entities/ y la atestación recibe { tenantId: 't-ctx' }. currentTenant() devuelve undefined: sí se consulta y atesta con 't-lookup'. La consulta devuelve cero filas: no atesta y NO lanza.
6. Sin periodo: la regla /FROM fiscal_periods/ devuelve [] ⇒ rechaza con AccountingError cuyo `code` es 'PERIOD_CLOSED' y mensaje 'No open fiscal period found for the entry date'; además el SQL capturado contiene "status NOT IN ('hard_close', 'locked')" (fija el candado: si alguien quita 'locked' de la lista, esta prueba cae).
7. Validación inválida: validateJournalEntry devuelve { isValid:false, errors:['a','b'], warnings:[] } ⇒ rechaza con code 'VALIDATION_FAILED' y mensaje que contiene 'a; b', y NO se ejecutó ningún /INSERT INTO account_balances/.
8. Numeración: nextEntityNumber fue llamado con (client, entityId, 'journal_entry', 'JE') y su resultado viaja como segundo parámetro del INSERT de journal_entries.
9. Líneas: los line_number son 1..n en el orden del arreglo de entrada, y cost_center_id/project_id ausentes se envían como null.

**Archivos**

- `tests/accounting/posting-create.spec.ts` — crear: 9 casos sobre createJournalEntry

**Criterios de aceptación**

- Dado un entryDate sin periodo abierto, cuando se llama createJournalEntry, entonces se rechaza con code 'PERIOD_CLOSED' y ninguna consulta INSERT llegó al cliente.
- Dado autoPost:true y una validación fallida, cuando se llama createJournalEntry, entonces se rechaza con code 'VALIDATION_FAILED' y no se ejecutó ningún INSERT INTO account_balances.
- Dado autoPost:true sin options.client, cuando termina la llamada, entonces attestJournalEntry se invocó exactamente una vez y después del commit (orden === ['commit','attest']).
- Dado options.client, cuando termina la llamada, entonces withTransaction no se invocó y attestJournalEntry tampoco.
- Dadas 3 líneas y autoPost:true, entonces hay exactamente 3 consultas INSERT INTO account_balances, todas con la cláusula ON CONFLICT (account_id, fiscal_period_id).

**Pruebas**

- `tests/accounting/posting-create.spec.ts` — atestación posterior al commit y silencio total de la rama sin autoPost

**Riesgo.** El arnés fija el SQL literal en varias aserciones; un reformateo inocente del query rompe pruebas. Mitigación: asertar siempre sobre el SQL NORMALIZADO por espacios y usar fragmentos cortos y semánticos ("ON CONFLICT (account_id, fiscal_period_id)", "status NOT IN"), nunca la consulta completa.

##### `E0.1-c` Pruebas unitarias de postJournalEntry y sus candados · **S**

postJournalEntry (src/services/accounting/posting.ts:229) abre su propia transacción, bloquea el asiento con FOR UPDATE, rechaza estados imposibles, valida y actualiza account_balances.

En tests/accounting/posting-post.spec.ts, con los mismos mocks de E0.1-b, cubrir:
1. Cero filas ⇒ AccountingError code 'ENTRY_NOT_FOUND'.
2. status 'posted' ⇒ code 'ALREADY_POSTED'.
3. status 'void' ⇒ code 'ENTRY_VOID' ('Cannot post a voided entry').
4. Validación inválida ⇒ code 'VALIDATION_FAILED' y ningún /INSERT INTO account_balances/.
5. Camino feliz: el UPDATE lleva status='posted', posted_date (Date) y posted_by = userId; hay un upsert de balances por línea con los mismos params que en createJournalEntry; el resultado devuelve { ...fila, lines }.
6. El SELECT inicial contiene 'FOR UPDATE' (sin el lock, dos posteos concurrentes duplican el movimiento en account_balances).
7. Periodo cerrado: validateJournalEntry devuelve el error de periodStatusRule ('Cannot post to hard_close period') ⇒ el rechazo llega como 'VALIDATION_FAILED' con ese texto. Esta prueba deja escrito dónde vive el candado PERIOD_CLOSED en el camino de dos pasos: en la regla de validación, no en postJournalEntry.
8. Atestación: hoy postJournalEntry NO llama attestEntryAsync (verificado, posting.ts:229-298), a diferencia de createJournalEntry con autoPost. La prueba se escribe según lo que resuelva la decisión 'atestación en el camino de dos pasos'. Si se decide corregir (recomendado), añadir en posting.ts, después del commit y con el mismo patrón del objeto `attest` que usan reverseJournalEntry y voidJournalEntry (resolveTenantId dentro de la transacción, attestEntryAsync fuera), y asertar orden === ['commit','attest'].

**Archivos**

- `tests/accounting/posting-post.spec.ts` — crear: 8 casos sobre postJournalEntry
- `src/services/accounting/posting.ts` — modificar (sólo si la decisión sobre atestación se resuelve como 'corregir'): capturar tenantId con resolveTenantId dentro de la transacción de postJournalEntry y llamar attestEntryAsync tras el commit

**Criterios de aceptación**

- Dado un asiento ya posteado, cuando se llama postJournalEntry, entonces se rechaza con code 'ALREADY_POSTED' y no se ejecutó ningún UPDATE.
- Dado un asiento 'void', entonces se rechaza con code 'ENTRY_VOID'.
- Dado un asiento válido en draft, cuando se postea, entonces el UPDATE fija posted_by = userId y hay un upsert de balances por cada línea.
- El SELECT que carga el asiento contiene FOR UPDATE.
- Si la decisión es corregir la atestación: dado un posteo exitoso, attestJournalEntry se invoca una vez y después del commit; si es documentar, existe una prueba explícita que afirma que NO se invoca, con un comentario que nombra la decisión.

**Pruebas**

- `tests/accounting/posting-post.spec.ts` — los tres candados de estado y la ausencia de escritura a balances cuando la validación falla

**Riesgo.** Añadir la atestación a postJournalEntry cambia comportamiento de producción dentro de un paquete de pruebas. Es una línea y sin ella la asimetría queda congelada por un test; por eso se formula como decisión y no se decide aquí.

##### `E0.1-d` Pruebas unitarias de reverseJournalEntry, voidJournalEntry y voidJournalEntryInTx · **M**

reverseWithinTransaction (posting.ts:324) concentra los dos candados que el atlas llama críticos y que la ruta REST no tenía: ENTRY_NOT_POSTED y ALREADY_REVERSED. voidJournalEntryInTx (posting.ts:438) añade ALREADY_VOID y la semántica NIF B-1 (el asiento posteado NO cambia a 'void'; se le enlaza un espejo posteado).

En tests/accounting/posting-reverse-void.spec.ts, mismos mocks; adicionalmente espiar createJournalEntry NO es posible (es una llamada interna al mismo módulo), así que la comprobación de las líneas espejo se hace sobre el SQL: capturar las consultas /INSERT INTO journal_entry_lines/ y leer sus params.

reverseJournalEntry:
1. Cero filas ⇒ 'ENTRY_NOT_FOUND'.
2. status 'draft' ⇒ 'ENTRY_NOT_POSTED', y el mensaje contiene el entry_number y el status ('is \'draft\''), tal como lo redacta posting.ts:334.
3. reversed_by_entry_id no nulo ⇒ 'ALREADY_REVERSED', mensaje que menciona 'corrupt balances'.
4. Camino feliz: por cada línea original se inserta una línea espejo con debit_amount = credit_amount original y viceversa, y description que empieza con 'Reversal: '; el INSERT del asiento espejo lleva entry_type 'reversing', is_reversal true, reverses_entry_id = id original y reference = entry_number original; existe una consulta /UPDATE journal_entries SET reversed_by_entry_id/ con params [idEspejo, idOriginal].
5. options.reason ⇒ description 'Reversal of JE-...: <reason>'; sin reason ⇒ 'Reversal of JE-...'.
6. options.reversalDate ⇒ la búsqueda de periodo (/FROM fiscal_periods/) recibe esa fecha como $2; sin ella, recibe una fecha ~= ahora (asertar con vi.useFakeTimers()).
7. Atestación: se invoca una vez, DESPUÉS del commit, y con el id del ESPEJO, no con el del original.
8. El SELECT inicial contiene FOR UPDATE.

voidJournalEntryInTx / voidJournalEntry:
9. status 'void' ⇒ 'ALREADY_VOID'.
10. Asiento en draft ⇒ UPDATE con status='void' y notes concatenadas con '\nVoided: <reason>'; el resultado trae reversal === null; no se creó ningún asiento espejo.
11. Asiento posteado ⇒ NO hay ningún UPDATE que fije status='void' sobre ese id (asertar que ninguna consulta capturada coincide con /SET status = 'void'/ para ese id); sí hay espejo y sí se concatenan las notas. Esta es la garantía que impide que mv_trial_balance y mv_account_balance_summary —que filtran status='posted'— se separen de account_balances.
12. Segundo void de un asiento ya reversado ⇒ 'ALREADY_REVERSED' (el candado llega desde reverseWithinTransaction, no desde voidJournalEntryInTx).
13. voidJournalEntryInTx corriendo sobre el cliente del llamador NO atesta (attestJournalEntry no se invoca): la atestación es responsabilidad de voidJournalEntry, que sí lo hace tras el commit y con el id del espejo.

**Archivos**

- `tests/accounting/posting-reverse-void.spec.ts` — crear: 13 casos sobre reversa y anulación

**Criterios de aceptación**

- Dado un asiento en 'draft', cuando se llama reverseJournalEntry, entonces se rechaza con code 'ENTRY_NOT_POSTED' y el mensaje nombra el entry_number y el estado real.
- Dado un asiento con reversed_by_entry_id, entonces reverseJournalEntry y voidJournalEntry se rechazan con code 'ALREADY_REVERSED'.
- Dado un asiento posteado, cuando se anula, entonces ninguna consulta fija status='void' sobre él y sí existe un UPDATE que fija reversed_by_entry_id.
- Dadas líneas [DR 100 a A, CR 100 a B], el espejo inserta [CR 100 a A, DR 100 a B] con descripciones que empiezan por 'Reversal: '.
- La atestación de una reversa se lanza tras el commit y con el id del asiento espejo.

**Pruebas**

- `tests/accounting/posting-reverse-void.spec.ts` — el asiento posteado anulado permanece 'posted' (NIF B-1) y su espejo queda enlazado en ambos sentidos

**Riesgo.** Rutinario.

##### `E0.1-e` Pruebas de las dos reglas de validación sin cobertura: lineAmountRule y periodStatusRule · **S**

tests/accounting/validation.spec.ts ya cubre balance, accountType, accountPermission, currency y nifSubstance con el helper mockRuleQueries. Ampliarlo (mismo archivo, mismo helper) con dos describe nuevos.

lineAmountRule (validation.ts:49):
- línea sin debit ni credit ⇒ error 'Line N: Must have exactly one of debit_amount or credit_amount';
- línea con ambos ⇒ el mismo error (la condición es hasDebit === hasCredit);
- debit_amount '0' ⇒ error 'debit_amount must be positive';
- credit_amount '-5.00' ⇒ error 'credit_amount must be positive';
- una entrada con dos líneas correctas no produce ningún error de esta regla;
- los mensajes citan el line_number recibido, no el índice del arreglo.

periodStatusRule (validation.ts:116):
- fiscal_periods devuelve [] ⇒ isValid false y error 'Fiscal period not found', y la regla NO evalúa nada más;
- status 'hard_close' ⇒ error 'Cannot post to hard_close period';
- status 'locked' ⇒ error 'Cannot post to locked period';
- status 'soft_close' ⇒ NINGÚN error, sólo la advertencia 'Period is in soft_close status. Only adjusting entries recommended.' y isValid true. Escribir junto a esta prueba el comentario que la explica: la CLI anuncia que el cierre suave bloquea asientos y la regla sólo advierte; la prueba fija el comportamiento ACTUAL y deberá cambiarse cuando se resuelva la decisión sobre la semántica del cierre suave;
- status 'future' ⇒ advertencia que cita 'NIF A-2' y 'devengación', sin error;
- status 'open' ⇒ ni error ni advertencia.

Añadir además el caso del cortocircuito de validateJournalEntry: con una sola línea devuelve isValid false, errors ['Journal entry must have at least 2 lines'] y `query` no se invocó ni una vez (ninguna regla llegó a correr).

**Archivos**

- `tests/accounting/validation.spec.ts` — modificar: añadir describe('lineAmountRule'), describe('periodStatusRule') y el caso de cortocircuito con menos de 2 líneas

**Criterios de aceptación**

- Dada una línea con debit_amount y credit_amount a la vez, entonces validateJournalEntry devuelve isValid false con el error 'Must have exactly one of debit_amount or credit_amount'.
- Dado un periodo en 'hard_close', entonces hay un error 'Cannot post to hard_close period'; dado 'locked', el error equivalente.
- Dado un periodo en 'soft_close', entonces isValid es true y existe exactamente una advertencia sobre asientos de ajuste.
- Dado un asiento de una sola línea, entonces el resultado es el error de 'at least 2 lines' y el mock de query registra cero llamadas.

**Pruebas**

- `tests/accounting/validation.spec.ts` — soft_close advierte pero no bloquea — comportamiento actual, marcado como pendiente de decisión

**Riesgo.** La prueba de soft_close congela un comportamiento que el roadmap quiere cambiar. Mitigación explícita: comentario en el propio test que nombra la decisión pendiente, para que quien la resuelva sepa que debe invertir esta aserción y no la interprete como contrato deseado.

##### `E0.1-f` Pruebas unitarias de sequence.ts · **S**

src/utils/sequence.ts tiene cuatro funciones, dos de ellas deprecadas, y ninguna prueba.

En tests/utils/sequence.spec.ts:

formatDocumentNumber(prefix, n):
- con vi.useFakeTimers() y vi.setSystemTime(new Date('2027-02-01T12:00:00Z')): formatDocumentNumber('JE', 42) === 'JE-2027-00042';
- relleno a 5 dígitos y sin truncar por encima: formatDocumentNumber('INV', 123456) === 'INV-2027-123456';
- una prueba explícita, con comentario, que documenta el defecto conocido: el año sale del RELOJ DEL SISTEMA, no de entry_date, de modo que un asiento fechado en diciembre de 2026 capturado en enero de 2027 recibe folio 'JE-2027-...'. La prueba fija el comportamiento actual para que el paquete que corrija la numeración por año fiscal la haga fallar y tenga que actualizarla conscientemente.

nextEntityNumber(client, entityId, name, prefix):
- con clienteFalso cuya regla /INSERT INTO entity_sequences/ responde [{ value: '7' }]: devuelve 'JE-<año actual>-00007';
- el SQL ejecutado contiene 'INSERT INTO entity_sequences', 'ON CONFLICT (entity_id, name)', 'DO UPDATE SET value = entity_sequences.value + 1' y 'RETURNING value', y los params son [entityId, name];
- se ejecuta SOBRE EL CLIENTE recibido: el mock de `query` de connection.js registra cero llamadas (si alguien lo cambiara al pool, el número se consumiría fuera de la transacción del llamador y sobreviviría a un ROLLBACK);
- value devuelto como bigint en cadena ('4294967296') se formatea sin pérdida.

Deprecadas: generateEntryNumber('JE', 4) === formatDocumentNumber('JE', 5); una prueba de generateSequenceNumber que documenta que interpola `tableName` directamente en el SQL y por eso no debe recibir nada que venga del usuario.

**Archivos**

- `tests/utils/sequence.spec.ts` — crear: pruebas de formatDocumentNumber, nextEntityNumber y las dos funciones deprecadas

**Criterios de aceptación**

- Con el reloj fijado en 2027, formatDocumentNumber('JE', 42) devuelve exactamente 'JE-2027-00042'.
- Dado un cliente falso que devuelve value '7', nextEntityNumber devuelve un folio terminado en '-00007' y el mock de query (pool) no registró ninguna llamada.
- El SQL de nextEntityNumber contiene ON CONFLICT (entity_id, name) y RETURNING value.

**Pruebas**

- `tests/utils/sequence.spec.ts` — el folio se consume sobre el cliente transaccional, nunca sobre el pool

**Riesgo.** Rutinario.

##### `E0.1-g` Pruebas unitarias de period-close.ts: checklist, cierre suave y candados del cierre duro · **M**

getPeriodCloseStatus (period-close.ts:20) hace cinco `query()` en orden fijo; softClosePeriod y hardClosePeriod son control de flujo sobre resultados. Todo eso es unitario; los asientos de cierre y el arrastre de saldos van a integración (E0.1-k).

En tests/accounting/period-close-status.spec.ts, mockear '../../src/database/connection.js' ({ query, withTransaction, currentTenant }) y '../../src/services/accounting/posting.js' ({ createJournalEntry: vi.fn(), attestEntryAsync: vi.fn() }). Enrutar `query` por RegExp igual que hace el helper de validation.spec.ts.

getPeriodCloseStatus:
1. El checklist tiene exactamente 5 ítems y en este orden: 'All journal entries posted', 'Bank reconciliations complete', 'All invoices reviewed', 'Depreciation calculated and posted', 'Trial balance balanced'.
2. 3 asientos en draft ⇒ can_close false y blocking_issues incluye '3 unposted journal entries'.
3. 2 cuentas bancarias sin conciliar ⇒ warnings, can_close SIGUE siendo true.
4. 5 activos sin depreciación ⇒ warnings, can_close SIGUE siendo true. Escribir el comentario que lo aclara: contra lo que afirma el atlas, la depreciación NO bloquea el cierre; sólo marca is_complete:false y añade una advertencia (period-close.ts:95 hace warnings.push, no blocking_issues.push). El checklist es insatisfacible mientras no exista corrida de depreciación, pero el cierre no queda impedido.
5. diff '0.0100' ⇒ is_complete true y sin bloqueo (frontera exacta); diff '0.0200' ⇒ bloqueo cuyo texto contiene 'out of balance by 0.0200'.
6. La consulta de balanza sin filas ⇒ se trata como 0 y no bloquea.

softClosePeriod:
7. Con blocking_issues ⇒ AccountingError code 'CANNOT_CLOSE_PERIOD' y el mensaje enumera los bloqueos; no se ejecutó el UPDATE.
8. UPDATE con 0 filas ⇒ code 'PERIOD_NOT_OPEN'; el SQL contiene "AND status = 'open'".
9. Camino feliz: se inserta en audit_log con action 'close', entity_type 'fiscal_period' y new_values con el checklist serializado; close_checklist se guarda como JSON.

hardClosePeriod:
10. 0 filas ⇒ 'PERIOD_NOT_FOUND'; el SELECT lleva FOR UPDATE.
11. status 'open' ⇒ 'PERIOD_NOT_SOFT_CLOSED'.
12. is_last false ⇒ createJournalEntry NO se llamó (no es cierre anual) y aun así se ejecuta el UPDATE a 'hard_close'.
13. is_last true ⇒ createJournalEntry se llamó con entry_type 'closing', con la fecha de FIN DE PERIODO (no con new Date()) y con { autoPost: true, client } — es decir, dentro de la misma transacción del cierre.
14. Atestación: con currentTenant() definido se llama attestEntryAsync una vez por asiento de cierre y después del commit; con currentTenant() undefined no se llama ninguna vez (comportamiento actual: un cierre lanzado sin contexto de tenant no atesta; dejarlo escrito).
15. Una prueba que captura el UPDATE etiquetado 'Lock all journal entries' (period-close.ts:216-221) y documenta que hoy es un no-op: reescribe cada fila con su propio status, no existe ningún estado 'locked' escrito por nadie y el único efecto real es reescribir las tuplas de todos los asientos del periodo. La prueba asegura que quien implemente el bloqueo de verdad tenga que tocarla.

**Archivos**

- `tests/accounting/period-close-status.spec.ts` — crear: 15 casos sobre checklist, soft close y candados del hard close

**Criterios de aceptación**

- Dado un periodo con 3 asientos en draft, cuando se pide getPeriodCloseStatus, entonces can_close es false y blocking_issues contiene '3 unposted journal entries'.
- Dados 5 activos sin depreciación y ningún otro problema, entonces can_close es true y el ítem 4 del checklist tiene is_complete false: la depreciación advierte, no bloquea.
- Dado un desbalance de exactamente 0.01, entonces el ítem 'Trial balance balanced' está completo; con 0.02, el cierre queda bloqueado.
- Dado un periodo en 'open', cuando se llama hardClosePeriod, entonces se rechaza con code 'PERIOD_NOT_SOFT_CLOSED'.
- Dado el último periodo del año, cuando se cierra en duro, entonces createJournalEntry recibe entry_type 'closing', la fecha de fin de periodo y options.client (misma transacción).

**Pruebas**

- `tests/accounting/period-close-status.spec.ts` — el checklist mantiene sus 5 ítems en orden y sólo dos de ellos bloquean

**Riesgo.** El atlas afirma que el checklist hace el cierre imposible por la depreciación; el código dice otra cosa. La prueba deja el hecho asentado para que nadie 'arregle' un problema inexistente; el problema real (checklist insatisfacible por falta de corrida de depreciación) sigue vivo y pertenece a otro paquete.

##### `E0.1-h` Infraestructura de integración: base efímera por corrida, tenant desechable por archivo y catálogo de cuentas compartido · **L**

Decisión de aislamiento tomada y justificada (ver también metricas_de_cierre):
- Transacción con ROLLBACK por prueba: DESCARTADA. postJournalEntry (posting.ts:233), reverseJournalEntry (posting.ts:395) y voidJournalEntry (posting.ts:496) llaman withTransaction, que hace getPool().connect() y abre su PROPIO BEGIN; no aceptan un cliente externo. Envolverlas en una transacción de prueba es imposible sin cambiar su firma. Sólo carryForwardBalances y nextEntityNumber, que sí reciben client, pueden probarse así, y allí se usa.
- Esquema temporal por worker: DESCARTADA. src/database/rls-policies.sql filtra por n.nspname='public', la función refresh_materialized_views de 024 fija SET search_path = public, y las dos vistas materializadas viven en public. Un esquema temporal no ejercitaría las políticas ni los disparadores reales, que es justo lo que hay que probar.
- testcontainers: DESCARTADA como opción por defecto (no es dependencia, exige demonio Docker en cada máquina y añade arranque). Queda accesible: basta apuntar TEST_ADMIN_DATABASE_URL a un contenedor.
- ELEGIDA: una BASE EFÍMERA POR CORRIDA creada en globalSetup, migrada con el runner real, y destruida al final; dentro de ella, un TENANT DESECHABLE POR ARCHIVO de prueba. El aislamiento entre archivos lo da el propio RLS (cada archivo lee sólo su tenant) y la limpieza fallida nunca contamina la siguiente corrida porque la base entera desaparece.

tests/integration/global-setup.ts (export default async function setup(): Promise<() => Promise<void>>):
1. Lee TEST_ADMIN_DATABASE_URL (por defecto 'postgresql://postgres:postgres@localhost:5432/postgres').
2. dbName = 'mnemosine_test_' + randomUUID().replace(/-/g,'').slice(0,12). CREATE DATABASE con identificador citado; si TEST_DB_OWNER está definido, añade OWNER <rol> — necesario en PG15, donde sólo el dueño de la base tiene CREATE sobre el esquema public, y necesario también para que FORCE ROW LEVEL SECURITY signifique algo (verificado: rls-policies.sql:54-55 hace ENABLE + FORCE).
3. Construye la URL de la base nueva reemplazando el pathname de la URL de migración (TEST_MIGRATION_DATABASE_URL si existe, si no la de admin).
4. Ejecuta las migraciones con el runner real, como subproceso: execFileSync('npx', ['tsx', 'src/database/migrate.ts'], { env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url }, stdio: 'inherit' }). Se usa el runner y no un volcado SQL a propósito: es el único camino que reaplica src/database/rls-policies.sql después de las migraciones, que es la convención del repositorio.
5. process.env.DATABASE_URL = url y process.env.MIGRATION_DATABASE_URL = url. globalSetup corre en el proceso principal ANTES de que arranquen los workers, así que los workers heredan estas variables y el pool perezoso de connection.ts (getPool lee config.database.url en el primer uso) toma la base correcta.
6. Devuelve el teardown: DROP DATABASE <dbName> WITH (FORCE) —PG13+, y el compose usa postgres:15— salvo que MNEMOSINE_KEEP_TEST_DB=1, en cuyo caso imprime el nombre para inspección manual; después cierra el pool de administración.

vitest.integration.config.ts: include ['tests/integration/**/*.int.spec.ts'], globalSetup ['tests/integration/global-setup.ts'], fileParallelism: false (los disparadores de refresco de vistas materializadas serializan de todos modos y la base es una sola), isolate: true, pool: 'forks', testTimeout: 30000, hookTimeout: 60000.

Catálogo de cuentas compartido: mover el arreglo `accounts` de src/database/seed.ts:73-117 a src/database/seeds/catalogo-mx.ts (el directorio existe y está vacío) exportando `CATALOGO_MX` con el mismo contenido y tipos explícitos; seed.ts pasa a importarlo. Sin esto el fixture duplicaría 38 cuentas y las dos copias se separarían.

tests/integration/helpers/tenant-fixture.ts:

  export interface TenantDePrueba {
    tenantId: string; orgId: string; entityId: string; userId: string;
    fiscalYearId: string;
    periodos: Array<{ id: string; numero: number; inicio: string; fin: string }>;
    cuentas: Map<string, string>;   // código → account_id
    customerId: string; vendorId: string;
  }
  export async function crearTenantDePrueba(opts?: {
    anio?: number; periodosAbiertos?: number; conRoles?: boolean; aniosExtra?: number;
  }): Promise<TenantDePrueba>;
  export async function destruirTenantDePrueba(t: TenantDePrueba): Promise<void>;
  export function comoTenant<T>(t: TenantDePrueba, fn: () => Promise<T>): Promise<T>;   // envuelve withTenant
  export async function saldoDe(t: TenantDePrueba, codigo: string, periodoId: string):
    Promise<{ debit_total: string; credit_total: string; ending_balance: string } | null>;

crearTenantDePrueba:
- todos los identificadores con uuidv4(); NINGÚN UUID literal en todo tests/integration/;
- INSERT en tenants sin contexto (tenants está excluida de RLS, rls-policies.sql:20) con subdomain 'test-' + sufijo aleatorio y schema_name 'public'; INSERT en users igual (también excluida);
- todo lo demás dentro de withTenant(tenantId, ...): organizations, legal_entities (entity_type 'sapi', tax_id 'XAXX010101000', functional_currency 'MXN', accounting_standard 'mx_nif'), fiscal_years (anio por defecto = año en curso, porque createJournalEntry busca el periodo por la fecha del asiento y las pruebas usan new Date()), 12 fiscal_periods (los primeros `periodosAbiertos`, por defecto 12, en 'open' y el resto en 'future'), el catálogo CATALOGO_MX completo con sus parent_id e is_system_account, un customer y un vendor;
- con aniosExtra > 0, además el año siguiente con sus 12 periodos: lo exige la prueba de arrastre de saldos;
- con conRoles: true llama a seedAccountRoles(entityId, tenantId, userId) y LANZA si el resultado no es { accountsCreated: 15 elementos, rolesMapped: 31, unmapped: [] }. Esos números están verificados: REQUIRED_ACCOUNTS tiene 15 cuentas que el catálogo base no trae y ROLE_MAP tiene 31 roles. Un fixture que siembra a medias debe fallar en el setup, no en una aserción confusa tres pruebas más tarde.

destruirTenantDePrueba: dentro de comoTenant, DELETE en este orden — journal_entries (las líneas caen por ON DELETE CASCADE), account_balances, invoice_lines, invoices, bill_lines, bills, customer_payments, vendor_payments, account_roles, entity_sequences, bank_accounts, accounts, fiscal_periods, fiscal_years, customers, vendors, legal_entities, organizations; y fuera del contexto, users y tenants. Si un DELETE falla por clave foránea, propagar el error: nombra la tabla donde la prueba dejó basura.

No hace falta mockear el orquestador de blockchain en integración: BlockchainOrchestrator.getConfig (orchestrator.ts:411) devuelve null cuando no hay fila en blockchain_config para el tenant, y attestJournalEntry sale sin escribir nada. Aun así, cada archivo llama drainAttestations(2000) antes de limpiar.

Patrón obligatorio de cada archivo de integración: beforeAll crea el tenant; afterAll hace drainAttestations(2000) → destruirTenantDePrueba → closeDatabase(); todas las llamadas al motor van envueltas en comoTenant (nunca enterTenant, que es de proceso y se filtraría entre archivos dentro del mismo worker).

**Archivos**

- `tests/integration/global-setup.ts` — crear: crea la base efímera, corre migrate.ts contra ella, exporta DATABASE_URL y la destruye al terminar
- `tests/integration/helpers/tenant-fixture.ts` — crear: crearTenantDePrueba/destruirTenantDePrueba/comoTenant/saldoDe, sin un solo UUID literal
- `vitest.integration.config.ts` — crear: proyecto de integración con globalSetup y fileParallelism false
- `src/database/seeds/catalogo-mx.ts` — crear: exporta CATALOGO_MX, movido literalmente desde seed.ts:73-117
- `src/database/seed.ts` — modificar: importar CATALOGO_MX en lugar de declarar el arreglo en línea
- `package.json` — modificar: scripts test:e2e = vitest run --config vitest.integration.config.ts y test:all = npm run test && npm run test:e2e

**Migración**

```sql
Ninguna migración nueva. Sí es requisito que la cadena existente corra sobre una base vacía: el orden lexicográfico mezcla prefijos repetidos (012_ai_drafts_unique_source antes de 012_fix_mv_account_balance_summary; tres archivos 014; dos 015; dos 018). Si alguno depende de otro con el mismo prefijo, se renombra con sufijo ordenado dentro de este paquete y se documenta en el propio archivo.
```

**Criterios de aceptación**

- Dado un Postgres vacío y TEST_ADMIN_DATABASE_URL apuntando a él, cuando corre `npm run test:e2e`, entonces la cadena completa de migraciones 001→030 se aplica sin error, las políticas de rls-policies.sql quedan aplicadas y la suite arranca.
- Dado un tenant creado con conRoles:true, entonces account_roles tiene 31 filas para esa entidad y seedAccountRoles reporta 15 cuentas creadas y unmapped vacío.
- Al terminar la corrida, `SELECT datname FROM pg_database WHERE datname LIKE 'mnemosine_test_%'` no devuelve ninguna fila (salvo con MNEMOSINE_KEEP_TEST_DB=1).
- `grep -rn '[0-9a-f]\{8\}-[0-9a-f]\{4\}-' tests/integration/` no devuelve ningún UUID literal.
- Dos corridas seguidas de `npm run test:e2e` dan el mismo resultado sin limpieza manual entre ellas.

**Pruebas**

- `tests/integration/fixture.int.spec.ts` — el fixture crea y destruye un tenant completo y deja cero filas suyas en legal_entities, accounts y account_roles

**Riesgo.** La cadena de migraciones nunca se ha ejecutado desde cero de forma verificable; es plausible que falle. Es el mayor riesgo del paquete y también su primer beneficio: hasta ahora nadie podía saberlo. Segundo riesgo: si vitest se configurara con isolate:false, la mutación de process.env desde globalSetup seguiría bien, pero el registro de módulos compartido podría fijar el pool de una base ya destruida; por eso isolate:true va explícito en la configuración.

##### `E0.1-i` Portar scripts/e2e-reversal.ts a prueba de integración reejecutable · **M**

scripts/e2e-reversal.ts hace 8 comprobaciones válidas pero: hardcodea TENANT/ENTITY/USER/ACC_A/ACC_B de una base concreta (líneas 12-16), no está en package.json, imprime en vez de asertar, y al limpiar REPARA A MANO la denormalización de account_balances (líneas 89-93) porque no puede tirar los datos.

Crear tests/integration/posting-reversal.int.spec.ts con crearTenantDePrueba() (sin roles; usa t.cuentas.get('1110') y t.cuentas.get('1120')) y portar cada comprobación a su it():
1. reverseJournalEntry sobre un asiento en draft ⇒ rechaza con code 'ENTRY_NOT_POSTED'.
2. Tras postJournalEntry, la reversa crea el espejo: is_reversal true, reverses_entry_id = original, y la fila original queda con reversed_by_entry_id = espejo y status 'posted'.
3. Segunda reversa ⇒ 'ALREADY_REVERSED'.
4. voidJournalEntry de un asiento posteado ⇒ el asiento permanece 'posted' con reversed_by_entry_id enlazado; el segundo void ⇒ 'ALREADY_REVERSED'.
5. voidJournalEntry de un draft ⇒ status 'void' y sin espejo.
6. entry_type 'payroll' aceptado por el CHECK ampliado en 023_entry_type_payroll.sql.

Comprobaciones NUEVAS que el script no hacía y que son el motivo de portarlo:
7. Sobre ACCOUNT_BALANCES, no sobre las líneas: capturar ending_balance de la cuenta 1110 en el periodo antes de crear nada, postear un asiento, reversarlo y comprobar que ending_balance vuelve EXACTAMENTE al valor inicial y que debit_total y credit_total subieron ambos en el mismo importe. El script sólo sumaba journal_entry_lines, que es justamente donde el bug de balances no se ve.
8. La reversa de un asiento cuyo periodo está en 'soft_close' se crea sin error (el candado del cierre suave hoy es una advertencia); anotar en el test que esta aserción cambia si se decide bloquear.
9. Reversa con options.reversalDate en un periodo distinto ⇒ el espejo queda en el fiscal_period_id de ESA fecha, no en el del original.

Eliminar scripts/e2e-reversal.ts (ver decisión sobre conservar o borrar los scripts).

**Archivos**

- `tests/integration/posting-reversal.int.spec.ts` — crear: 9 casos, todos sobre el tenant del fixture
- `scripts/e2e-reversal.ts` — eliminar: sustituido por la prueba de integración (sujeto a la decisión sobre los scripts)

**Criterios de aceptación**

- `npm run test:e2e` ejecuta este archivo contra una base recién migrada y pasa sin ningún dato preexistente.
- Dado el saldo inicial S de la cuenta 1110 en el periodo, cuando se postea un asiento de 100 y se reversa, entonces ending_balance vuelve a S y debit_total y credit_total aumentaron 100 cada uno.
- Ninguna prueba repara account_balances a mano ni ejecuta UPDATE alguno sobre esa tabla.
- El archivo no contiene ningún UUID literal.

**Pruebas**

- `tests/integration/posting-reversal.int.spec.ts` — original más espejo dejan account_balances exactamente como estaba

**Riesgo.** Rutinario, salvo que la comprobación 7 destape una divergencia real entre account_balances y las líneas. Sería un hallazgo, no un fallo de la prueba: documentarlo y abrir tarea.

##### `E0.1-j` Portar scripts/e2e-arap.ts a prueba de integración con roles sembrados por el propio fixture · **M**

scripts/e2e-arap.ts es la única evidencia del posteo AR/AP y, según la auditoría, 'sólo pasa porque LEE roles preexistentes' (líneas 45-49) de una base con UUID fijos (líneas 19-24), incluido AUG_2026_PERIOD.

Crear tests/integration/ar-ap.int.spec.ts con crearTenantDePrueba({ conRoles: true }) y portar sus comprobaciones:
1. Factura → asiento: DR cxc por el total, CR ingreso por línea, CR iva_trasladado; el asiento queda 'posted' con entry_type 'auto_invoice' y invoices.journal_entry_id enlazado.
2. Idempotencia: un segundo postInvoiceEntry sobre la misma factura devuelve null y no crea otro asiento (respaldado por el índice parcial uq_je_document_source de 025).
3. Cobro de cliente → DR banco / CR cxc.
4. Bill → CR cxp / DR gasto / DR iva_acreditable con entry_type 'auto_bill'.
5. Pago a proveedor → DR cxp / CR banco.
6. Void de la factura ⇒ reversa enlazada del asiento (voidJournalEntryInTx sobre el cliente de la transacción).

Comprobación NUEVA, la que cierra la brecha que el script no podía cubrir:
7. Sobre un tenant creado con conRoles:false, postInvoiceEntry rechaza con code 'MISSING_ROLE_ACCOUNT' y el mensaje nombra el rol 'cxc'. Es la prueba que demuestra que account_roles es un prerrequisito duro del posteo de documentos y la que hará visible cualquier regresión del sembrado.

Todos los INSERT de documentos usan uuidv4() y los ids del fixture; ninguna referencia a periodos por UUID literal (usar t.periodos).

Eliminar scripts/e2e-arap.ts (sujeto a la decisión sobre los scripts). El caso 8 del script (carryForwardBalances con rollback deliberado) se traslada a E0.1-k, donde vive con el resto del cierre.

**Archivos**

- `tests/integration/ar-ap.int.spec.ts` — crear: 7 casos, con siembra propia de account_roles
- `scripts/e2e-arap.ts` — eliminar: sustituido por la prueba de integración (sujeto a la decisión sobre los scripts)

**Criterios de aceptación**

- Dado un tenant nuevo con conRoles:true, cuando se postea una factura de 1000 + 160 de IVA, entonces el asiento tiene DR cxc 1160, CR ingreso 1000 y CR iva_trasladado 160, y la factura queda enlazada.
- Dado un tenant SIN roles sembrados, cuando se llama postInvoiceEntry, entonces se rechaza con code 'MISSING_ROLE_ACCOUNT' y el mensaje nombra el rol faltante.
- Un segundo posteo de la misma factura devuelve null y el conteo de journal_entries no cambia.
- El archivo no contiene ningún UUID literal ni depende de ninguna fila preexistente.

**Pruebas**

- `tests/integration/ar-ap.int.spec.ts` — sin account_roles el posteo de documentos es inejecutable: MISSING_ROLE_ACCOUNT

**Riesgo.** El caso 7 documenta como esperado un fallo que otro paquete va a eliminar cableando seedAccountRoles a `mnemosine init`. No hay conflicto: el fallo seguirá siendo el correcto para una entidad sin roles; lo que cambiará es que ninguna entidad creada por el producto llegue a ese estado.

##### `E0.1-k` Integración del cierre de periodo, arrastre de saldos y concurrencia de la numeración · **L**

Dos archivos.

A) tests/integration/period-close.int.spec.ts, con crearTenantDePrueba({ aniosExtra: 1 }):
1. softClosePeriod con un asiento en draft en el periodo ⇒ 'CANNOT_CLOSE_PERIOD' y el mensaje enumera los asientos sin postear.
2. softClosePeriod feliz ⇒ fiscal_periods.status 'soft_close', soft_close_date y closed_by fijados, close_checklist con los 5 ítems, y una fila nueva en audit_log con action 'close' y entity_type 'fiscal_period'.
3. softClosePeriod sobre un periodo ya en soft_close ⇒ 'PERIOD_NOT_OPEN'.
4. hardClosePeriod sobre un periodo en 'open' ⇒ 'PERIOD_NOT_SOFT_CLOSED'.
5. Cierre anual completo: postear ingresos y gastos en el periodo 1, cerrar en suave y en duro el periodo 12 y comprobar que (a) se crean exactamente dos asientos con entry_type 'closing' fechados el 31 de diciembre y en el periodo 12, (b) el saldo agregado de las cuentas de resultados del AÑO queda en cero, (c) 3900 (Resumen de Ingresos y Gastos) queda en cero, (d) 3200 (Resultado de Ejercicios Anteriores) recibe la utilidad neta y 3100 (Capital Social) NO se toca. La agregación del año completo, no sólo del último periodo, es lo que la consulta de period-close.ts:319-329 promete.
6. Tras el cierre duro, createJournalEntry con fecha dentro del periodo cerrado ⇒ 'PERIOD_CLOSED' (el periodo ya no aparece en la búsqueda que excluye 'hard_close').
7. Arrastre: tras el cierre duro del periodo 12, el periodo 1 del año siguiente tiene beginning_balance = ending_balance del cerrado para cada cuenta de balance con saldo distinto de cero, ending_balance = beginning + debit_total − credit_total, y NINGUNA cuenta de resultados arrastrada.
8. Idempotencia del arrastre: llamar carryForwardBalances dos veces dentro de una withTransaction propia (acepta client, así que aquí SÍ aplica el ROLLBACK deliberado, como ya hacía scripts/e2e-arap.ts:177-209) y comprobar que los valores no se duplican.
9. carryForwardBalances sin periodo siguiente devuelve 0 y no escribe nada.
10. it.todo('generateClosingEntries debe lanzar si faltan las cuentas 3900/3200 en vez de devolver [] y dejar que el cierre duro reporte éxito') — marcador visible del defecto, propiedad de otro paquete; no se escribe una aserción que lo dé por bueno.

B) tests/integration/sequence-concurrency.int.spec.ts:
11. Promise.all de 20 createJournalEntry (sin autoPost, para no disparar 40 refrescos de vistas materializadas) sobre la misma entidad ⇒ 20 entry_number distintos y entity_sequences.value = 20 para (entity, 'journal_entry').
12. Prueba del candado de fila: abrir la transacción A con getClient() + BEGIN y llamar nextEntityNumber sin commitear; desde la transacción B, con `SET LOCAL statement_timeout = '500ms'`, llamar nextEntityNumber sobre la MISMA (entity, name) ⇒ el error tiene code '57014' (statement timeout), lo que demuestra que el UPSERT serializa. Después, commitear A y comprobar que un tercer llamador obtiene el número siguiente. Liberar siempre los clientes en finally.
13. Rollback: dentro de una transacción propia llamar nextEntityNumber y hacer ROLLBACK; comprobar que entity_sequences.value NO avanzó (el folio sólo se consume si la transacción del llamador confirma, tal como afirma el docstring de sequence.ts:4-11).

**Archivos**

- `tests/integration/period-close.int.spec.ts` — crear: 10 casos de cierre suave, duro, asientos de cierre y arrastre
- `tests/integration/sequence-concurrency.int.spec.ts` — crear: 3 casos de numeración concurrente, bloqueo por fila y rollback

**Criterios de aceptación**

- Dado un año con ingresos por 10 000 y gastos por 4 000, cuando se cierra en duro el periodo 12, entonces 3200 queda acreditada por 6 000, 3900 en cero y 3100 sin movimiento.
- Dado el cierre duro del periodo 12, entonces createJournalEntry con fecha dentro de ese periodo se rechaza con code 'PERIOD_CLOSED'.
- Dadas 20 llamadas concurrentes a createJournalEntry, entonces se obtienen 20 entry_number distintos y entity_sequences.value vale 20.
- Dada una transacción que llama nextEntityNumber y hace ROLLBACK, entonces entity_sequences.value permanece igual.
- Dada una transacción abierta que ya tomó el número, una segunda con statement_timeout de 500 ms falla con code '57014'.

**Pruebas**

- `tests/integration/period-close.int.spec.ts` — el cierre anual barre resultados a 3200 y deja intacto 3100
- `tests/integration/sequence-concurrency.int.spec.ts` — el UPSERT de entity_sequences serializa y el folio se revierte con la transacción

**Riesgo.** El caso 12 depende de un tiempo de espera: en una máquina cargada podría fallar por otro motivo. Mitigación: asertar sobre el `code` '57014' y no sobre el mensaje, y dar 500 ms de margen. El caso 5 es el más frágil del paquete porque depende de que el catálogo tenga 3900 y 3200 marcadas is_system_account; el fixture las crea desde CATALOGO_MX, donde ya vienen marcadas (seed.ts:98,100).

##### `E0.1-l` Flujo de CI: typecheck, unitarias y suite de integración contra un Postgres de servicio, más verify-isolation.sh · **M**

No existe .github/ ni ningún automatismo. Crear .github/workflows/ci.yml con dos trabajos.

Trabajo `unidad` (sin base de datos, es la garantía de que las unitarias no dependen de Postgres):
- actions/checkout; actions/setup-node@v4 con node-version 20 y cache 'npm'; npm ci;
- npm run typecheck; npm run typecheck:tests; npm test.

Trabajo `integracion` (needs: unidad):
- services.postgres: image postgres:15-alpine (la misma que docker/docker-compose.yml), env POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB=postgres, ports 5432:5432, options con --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 10;
- pasos, en este orden:
  1. checkout, setup-node, npm ci;
  2. crear la base de trabajo: psql -c 'CREATE DATABASE accounting_core';
  3. MIGRATION_DATABASE_URL/DATABASE_URL apuntando a accounting_core como superusuario: npm run migrate y npm run seed. El seed corre como superusuario a propósito: seed.ts escribe con query() sin contexto de tenant y bajo FORCE RLS sería rechazado por la política; además deja el tenant que verify-isolation.sh necesita como 'otro tenant';
  4. psql -v app_pw=... -v owner_pw=... -f scripts/provision-roles.sql (crea mnemosine_app y mnemosine_owner y traspasa la propiedad, requisito para que FORCE RLS tenga a quién forzar);
  5. SUPERUSER_URL=postgresql://postgres:postgres@localhost:5432/accounting_core MNEMOSINE_APP_PASSWORD=... bash scripts/verify-isolation.sh. Es la primera vez que este guion corre automáticamente; comprueba las tres fronteras de RLS, la cobertura de políticas, la propiedad de las vistas y los permisos de la app;
  6. TEST_ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres, TEST_DB_OWNER=mnemosine_owner, TEST_MIGRATION_DATABASE_URL=postgresql://mnemosine_owner:<owner_pw>@localhost:5432/postgres y npm run test:e2e. Conectar como mnemosine_owner y no como superusuario es deliberado: un superusuario ignora RLS y la suite dejaría de ejercitar el perímetro (ver decisión).
- Contraseñas de CI en el propio workflow como literales de usar y tirar (el clúster vive y muere con el trabajo); no usar secretos para esto.

~~NO incluir `npm run lint` en la CI: eslint 8 está en devDependencies pero no existe ningún .eslintrc* ni eslint.config.* en el repositorio, así que `npm run lint` falla hoy por falta de configuración. Añadir la configuración de eslint no pertenece a este paquete; dejarlo anotado en el propio workflow con un comentario.~~

**SUPERADO (2026-08-27).** La brecha quedó cerrada: el repositorio tiene `eslint.config.mjs` (configuración plana de ESLint 9 con typescript-eslint y reglas con información de tipos) y el guion es `eslint src/ tests/ scripts/ --max-warnings 1067`. La CI sí invoca `npm run lint`, en un trabajo propio llamado `lint`. Las 1067 advertencias (436 en src, 631 en tests) son la falta de solidez que entra por tipos de terceros (`req.body: any` de Express, `parse(): any` de fast-xml-parser, filas `Record<string, unknown>`, y el cliente pg falso de tests/helpers); el tope las congela, de modo que la deuda no puede crecer en silencio, y baja conforme se tipe cada frontera.

`scripts/` también quedó cubierto. Antes sólo se revisaba `build-niif-indice.ts`, y de rebote: `tests/ai/niif-registry.spec.ts` lo importa y eso lo mete en el programa de tsconfig.test.json. Por eso su autor topó con la restricción y dejó escrito que usa `__dirname` y no `import.meta` (el proyecto compila a CommonJS). Los otros dos guiones no los revisaba nadie, y justo por eso `generate-cli-reference.ts` se había desviado de esa convención y usaba `import.meta` (TS1470). Ahora `tsconfig.test.json` incluye `scripts/**/*`, el guion desviado usa `__dirname` como su hermano, y eslint le aplica las mismas reglas con información de tipos que a `src/`. Importa porque `scripts/reclasificar-iva-ppd.ts` reescribe IVA ya contabilizado: ahí `no-floating-promises` es exactamente la regla que se quiere apuntando.

Disparadores: push a la rama principal y pull_request. Hasta que el proyecto esté bajo git con un remoto (hoy no lo está), el archivo queda inerte: ver la decisión correspondiente.

**Archivos**

- `.github/workflows/ci.yml` — crear: trabajos 'unidad' e 'integracion' con servicio postgres:15-alpine
- `package.json` — modificar: asegurar que test, test:e2e, typecheck y typecheck:tests existen con los nombres que usa el workflow

**Criterios de aceptación**

- El trabajo `unidad` pasa sin ningún servicio de base de datos declarado: ninguna prueba unitaria abre una conexión.
- El trabajo `integracion` corre migrate + seed + provision-roles + verify-isolation.sh + test:e2e y termina verde sobre un Postgres recién levantado.
- verify-isolation.sh imprime 'Aislamiento verificado.' y sale con código 0.
- ~~El workflow no invoca `npm run lint` y lleva el comentario que explica por qué.~~ SUPERADO: el workflow sí invoca `npm run lint` y el trabajo `lint` termina verde.
- Introducir a propósito un fallo (por ejemplo quitar el candado ALREADY_REVERSED) hace fallar la CI.

**Riesgo.** Riesgo principal: la CI no puede ejecutarse porque el proyecto no está bajo control de versiones. Segundo riesgo: verify-isolation.sh elige T1 con `SELECT tenant_id FROM legal_entities WHERE tenant_id <> $T2 LIMIT 1`; si el paso de seed se omitiera, T1 quedaría vacío y la comprobación de escritura cruzada fallaría por una razón equivocada. Por eso el orden de los pasos es parte de la especificación, no una sugerencia.

#### Cómo se sabe que cerró

- `npm run typecheck` y `npm run typecheck:tests` salen con código 0.
- `npm test` corre sin base de datos, en modo run (no watch), e incluye al menos: 9 casos de createJournalEntry, 8 de postJournalEntry, 13 de reversa/anulación, 15 de period-close, 10 de sequence y 12 nuevos de validación.
- `npm run test:coverage` reporta para src/services/accounting/posting.ts >= 85% de líneas, src/utils/sequence.ts 100%, src/services/accounting/validation.ts >= 90% y src/services/accounting/period-close.ts >= 70%.
- `npm run test:e2e` termina verde contra un Postgres 15 vacío, sin ninguna preparación manual más que TEST_ADMIN_DATABASE_URL.
- `grep -rn "f4642318-31ed-4870\|1ddac7ab-1f0d-42a2\|5fb92480-fb84-47a4" scripts/ tests/ src/` no devuelve ninguna línea.
- `ls scripts/e2e-*.ts` no devuelve nada (o, si la decisión fue conservarlos, cada uno arranca con un aviso de que la fuente de verdad es tests/integration/).
- Tras una corrida completa, `psql -tAc "SELECT count(*) FROM pg_database WHERE datname LIKE 'mnemosine_test_%'"` devuelve 0.
- `bash scripts/verify-isolation.sh` corre dentro de la CI y sale con código 0.
- Existe .github/workflows/ci.yml y su última ejecución está en verde (bloqueado hasta que el repositorio tenga remoto).


### E0.2 · Contrato entre el código y el esquema: test que lo verifica, reparación de toda divergencia y numeración de migraciones a prueba de choques
**Objetivo.** Convertir en fallo de CI cualquier consulta SQL del código que referencie tablas, columnas, restricciones únicas o vocabularios de CHECK que el esquema real no tiene, y reparar las 25 divergencias verificadas hoy (nómina MX/US, banca, blockchain). De paso, fijar la numeración de migraciones para que no vuelvan a chocar dos archivos con el mismo número.

**Por qué aquí.** Es la etapa 0 porque hoy ningún test ve el esquema: las 80 suites mockean `query`, así que 1155 pruebas verdes conviven con código que revienta en la primera consulta contra Postgres. Todo el subsistema de nómina (recibos US, timbrado de nómina MX, IDSE, SUA, 941/940/W-2/W-3, beneficios, embargos) es inejecutable hoy, y el paquete de nómina con E2E contra base real depende de que esta reparación exista primero. Además es barato: no toca el motor contable, no cambia ninguna regla de negocio y no depende de ningún otro paquete.

**Depende de:** `E0.0` · **Migraciones:** `031-034` · **12 tareas · 6.6 sem-persona**

**Precondiciones:**

- Postgres 15 disponible en local (docker/docker-compose.yml ya trae postgres:15-alpine) y en CI, con un rol capaz de CREATE DATABASE y DDL
- MIGRATION_DATABASE_URL apuntando a ese Postgres para el runner del contrato
- Saber que hoy NO existe .github/ en el repo: el workflow de CI se crea en este paquete (tarea E0.2-l)
- Ninguna de las correcciones toca posting.ts, ar-ap-posting.ts ni period-close.ts, así que no hay escritura al mayor en juego: no aplica createJournalEntry/postJournalEntry ni attestEntryAsync en ninguna tarea

#### Decisiones a resolver

**¿Las columnas que el código de nómina inventó se agregan al esquema o se elimina el código que las usa?**

Tres bloques de columnas no existen en ninguna migración: el domicilio del patrón y el registro patronal IMSS de legal_entities, las banderas CCPA de garnishments (supports_second_family, arrears_over_12_weeks, exempt_amount) y el acuse de envío de tax_form_filings. No es una decisión técnica: es decidir si el producto va a emitir W-2/W-3, lotes IDSE y acuses de IRS/SSA de verdad.

- Agregarlas al esquema (migración 031) y dejar el código como está
- Recortar el código: emitir las formas sin domicilio, sin registro patronal, sin topes CCPA por orden y sin acuse
- Recortar ahora y agregarlas cuando el paquete de nómina las necesite

_Recomendación:_ Agregarlas (opción 1). Son datos que las formas oficiales exigen y que el código ya sabe usar; recortarlos convertiría un bug de esquema en una pérdida de funcionalidad, y la migración cuesta seis ALTER TABLE con IF NOT EXISTS. Toda la especificación de arriba está escrita sobre esta opción.

_Bloquea:_ E0.2-e, E0.2-f y E0.2-h; sin decidirlo no se puede escribir la migración 031

**¿El motor de embargos debe honrar garnishments.max_withholding_pct?**

La columna existe en la tabla desde la migración 008 con el comentario «e.g. CCPA 50-65%», y garnishment-engine nunca la lee: aplica solo el tope CCPA global. Es decir, una orden judicial que dice «no más del 20%» se cobra al 50%. Aplicarla cambia importes calculados, no solo nombres de columna.

- Aplicarla como tope adicional por orden, con Math.min sobre el importe ya topado por CCPA
- Dejarla sin usar y documentar que el tope por orden no se respeta
- Quitar la columna de la tabla

_Recomendación:_ Aplicarla (opción 1), pero NO en este paquete: es un cambio de comportamiento y este paquete es de contrato. Anotarla como tarea del paquete de nómina, con su prueba propia. Lo que sí corresponde aquí es que la columna deje de ser invisible.

_Bloquea:_ Nada de E0.2; condiciona el alcance de E0.2-f

**¿El tipo de contribución a beneficios se llama 'percentage' o 'percent'?**

El comentario del DDL de employee_benefit_elections dice «percent, fixed_amount»; el tipo TS y la ruta REST (payroll.ts:91) usan 'percentage'. La columna no tiene CHECK, así que hoy conviven; la tabla está vacía en toda instalación porque su INSERT nunca pudo ejecutarse.

- 'percentage' (lo que el código ya usa) y corregir el comentario del DDL
- 'percent' (lo que el DDL documenta) y cambiar código y ruta
- Añadir un CHECK con ambos

_Recomendación:_ 'percentage' (opción 1): es lo que el código, el tipo TS y la ruta ya usan, y no hay una sola fila que migrar. Corregir el comentario con COMMENT ON COLUMN en la 031 y, si se quiere cerrar del todo, añadir un CHECK en un paquete posterior.

_Bloquea:_ E0.2-g (solo el texto del COMMENT)

**¿El test de contrato exige Postgres siempre, o se salta cuando no lo hay?**

Todas las suites actuales corren sin base porque mockean `query`. El verificador por PREPARE necesita una base real. Un skip silencioso lo dejaría inerte justo en la máquina de quien escribe el bug.

- Skip local con instrucción visible, fallo obligatorio cuando CI está definido
- Fallo siempre: quien no tenga Postgres no puede correr npm test
- Solo runner de CLI, sin suite de vitest

_Recomendación:_ Opción 1. Mantiene `npm test` corriendo en cualquier laptop sin docker, y hace que el contrato sea inevitable en CI, que es donde tiene que morder. Está especificado así en E0.2-c.

_Bloquea:_ E0.2-c y E0.2-l

**¿Se renumeran los nueve archivos de migración con número duplicado?**

public.migrations lleva el filename como clave única (migrate.ts:17-21 y 32-35). Renombrar un archivo ya aplicado hace que migrate.ts no lo reconozca y lo vuelva a ejecutar en toda instalación existente; varias de esas migraciones (014_rls_tenant_isolation, 015_account_roles, 018_fix_account_roles_unique) no son idempotentes en su totalidad.

- Congelarlos y listarlos como excepción histórica
- Renumerar y migrar public.migrations con un UPDATE de mapeo viejo→nuevo
- Renumerar y aceptar la reejecución

_Recomendación:_ Congelarlos (opción 1). El desorden ya ocurrió y es inofensivo: el orden alfabético dentro de cada número resulta correcto en los cuatro casos (015_account_roles antes que 015_identities, 018_ai_sessions antes que 018_fix_account_roles_unique). Lo que hay que impedir es el próximo choque, y eso lo hace la guarda de E0.2-k. La opción 2 exige un UPDATE manual en cada instalación existente para no romperlas — precio alto por cosmética.

_Bloquea:_ E0.2-k

**Ante una divergencia enum, ¿manda el código o manda el esquema?**

Hay seis y no admiten una sola regla: 'finiquito' y 'submitted' son conceptos reales que faltan en la base; 'mirror', 'verify_only', 'direct', 'hybrid', 'journal_entry' y 'payment' son vocabularios que alguien inventó en la capa REST y que ningún motor entiende (el orchestrator de blockchain ya usa el vocabulario de la base).

- Caso por caso: ampliar el CHECK cuando el concepto es real y estrechar el Zod cuando es invención de la capa REST
- Ampliar siempre el CHECK
- Estrechar siempre el Zod

_Recomendación:_ Caso por caso (opción 1), con el reparto ya detallado en E0.2-j: ampliar para pay_runs.run_type y tax_form_filings.status; estrechar para banca y los cuatro de blockchain. Ampliar siempre convertiría la base en un basurero de sinónimos; estrechar siempre borraría el finiquito, que es una corrida real en México.

_Bloquea:_ E0.2-h y E0.2-j

#### Tareas

##### `E0.2-a` Extractor de literales SQL con archivo, línea y símbolo · **M**

Crear el módulo `src/database/contract/extract.ts` (bajo src/ para que `npm run typecheck` lo cubra: tsconfig.json incluye solo src/** y excluye tests/).

Tipo:
```ts
export interface LiteralSql {
  archivo: string;        // ruta relativa a la raíz del repo
  linea: number;          // 1-based: línea donde abre el literal
  simbolo: string;        // función o const que lo contiene, o '<módulo>'
  sql: string;            // contenido del literal, sin las comillas invertidas
  interpolaciones: string[]; // cada expresión ${...} tal como aparece
}
export function extraerLiteralesSql(rutaRelativa: string, fuente: string): LiteralSql[];
export function extraerDeDirectorio(raizSrc: string): LiteralSql[];
```

Algoritmo de `extraerLiteralesSql`:
1. Neutralizar comentarios: reemplazar el contenido de `/* … */` por espacios preservando saltos de línea, y truncar cada línea en `//` que no venga precedido de `:`, comilla o backslash (evita destrozar URLs y rutas).
2. Recorrer literales de plantilla (backticks) con un lexer que respete `\`` y `${…}` anidados. NO usar comillas simples ni dobles: los 499 literales SQL del repo son todos de plantilla salvo tres triviales en migrate.ts y doctor-service.ts sobre `public.migrations`, que se excluyen por la lista blanca del punto 4.
3. Descartar el literal si, tras `trim()`, su primera palabra no es SELECT, INSERT, UPDATE, DELETE, WITH o VALUES. Esto deja fuera prosa, XML de CFDI y mensajes de error (verificado: el filtro por palabra inicial elimina los falsos positivos tipo `Could not update the secret in AWS…` de aws-secrets-manager.ts:95).
4. Lista blanca de tablas que no viven en las migraciones y no deben reportarse: `public.migrations` (la crea migrate.ts en su propio bootstrap), catálogos `pg_*` e `information_schema.*`.
5. `simbolo`: recorrer hacia atrás desde el offset de apertura del literal buscando la primera coincidencia de `/^export\s+(async\s+)?function\s+([A-Za-z0-9_]+)/m` o `/^export\s+const\s+([A-Za-z0-9_]+)/m` o `/^(async\s+)?function\s+([A-Za-z0-9_]+)/m`; si no hay ninguna, `'<módulo>'`.
6. `interpolaciones`: el texto interior de cada `${…}` de primer nivel, en orden.

`extraerDeDirectorio` recorre `src/` recursivamente, solo `.ts`, y devuelve el arreglo plano ordenado por archivo y línea.

Dato de calibración medido sobre el repo actual: 499 literales SQL, de los cuales 96 llevan interpolación.

**Archivos**

- `src/database/contract/extract.ts` — crear: extraerLiteralesSql, extraerDeDirectorio y el tipo LiteralSql
- `tests/database/contract-extract.spec.ts` — crear: pruebas unitarias del extractor sin tocar la base

**Criterios de aceptación**

- Dado el archivo real src/services/payroll/usa/forms/w2-generator.ts, cuando corre extraerLiteralesSql, entonces devuelve un LiteralSql con linea=64, simbolo='generateW2' y sql que empieza por 'SELECT tax_id, name, address_line1'
- Dado un archivo con el texto `Could not update the secret in AWS: ${x}` dentro de un literal de plantilla, cuando corre el extractor, entonces no devuelve ningún LiteralSql (su primera palabra no está en la lista de verbos SQL)
- Dado un literal que contiene una cadena SQL con la palabra 'from' en prosa —por ejemplo el INSERT de src/ai/memory-service.ts:146, cuyo valor incluye 'did not arise from a question'—, cuando el verificador lo procesa, entonces no reporta ninguna tabla llamada 'a'
- Dado un archivo sin ninguna función exportada antes del literal, cuando corre el extractor, entonces simbolo === '<módulo>'
- Corriendo extraerDeDirectorio('src') sobre el repo tal cual, devuelve 499 ± 5 literales

**Pruebas**

- `tests/database/contract-extract.spec.ts` — reconoce SELECT/INSERT/UPDATE/DELETE/WITH y rechaza prosa, XML y mensajes de error
- `tests/database/contract-extract.spec.ts` — resuelve el símbolo contenedor para function exportada, const exportada y función local
- `tests/database/contract-extract.spec.ts` — no confunde el contenido de una cadena SQL entrecomillada con estructura SQL
- `tests/database/contract-extract.spec.ts` — lista las interpolaciones de primer nivel en orden y no las anidadas

**Riesgo.** Un lexer de backticks mal hecho se come el archivo entero a partir de un `\``. Mitigación: prueba dedicada con un literal que contenga backtick escapado y otro con `${`a${b}`}` anidado.

##### `E0.2-b` Normalizador de literales interpolados, con salida explícita 'no verificable' · **M**

Crear `src/database/contract/normalize.ts`.

```ts
export type ResultadoNormalizacion =
  | { estado: 'listo'; sql: string }
  | { estado: 'no_verificable'; motivo: string };
export function recolectarConstantes(fuente: string): Map<string, string>;
export function normalizar(lit: LiteralSql, constantes: Map<string, string>): ResultadoNormalizacion;
```

`recolectarConstantes` extrae las `const NOMBRE = '…'` / `= \`…\`` de nivel de módulo cuyo valor sea un literal SIN interpolación. Es lo que resuelve los casos más frecuentes del repo: `POLICY_COLUMNS` (src/ai/approval-policy.ts:161), `ENTITY_COLUMNS` (src/ai/context.ts:75,89,97) y `JOB_COLUMNS` (src/ai/jobs/job-store.ts:181,189).

`normalizar` sustituye cada `${expr}` aplicando, en este orden:
1. `expr` es un identificador simple presente en `constantes` → sustituir por su valor.
2. La interpolación está dentro de un `IN (${…})` → sustituir por `NULL` (cubre `${placeholders}` de src/ai/draft-service.ts:176 y src/services/accounting/validation.ts:88,170,256).
3. La interpolación ocupa una posición de predicado (el texto inmediatamente anterior, ignorando espacios, termina en WHERE, AND u OR) → sustituir por `true` (cubre `${conditions.join(' AND ')}` de approval-policy.ts:161 y external-service.ts:199).
4. La interpolación sigue a ORDER BY, LIMIT u OFFSET → sustituir por `1`.
5. Cualquier otro caso → devolver `{ estado: 'no_verificable', motivo: 'interpolación no reconocida: ' + expr }`.

El runner (tarea E0.2-c) lleva la cuenta de los 'no verificable' y la compara contra una línea base guardada en `src/database/contract/baseline.json` con la forma `{ "noVerificables": N }`. Si el número SUBE, el runner falla con «hay N literales SQL que el contrato ya no puede verificar (línea base M): o los normalizas o los declaras». Bajar la línea base es libre; subirla exige editar el archivo a propósito.

**Archivos**

- `src/database/contract/normalize.ts` — crear: recolectarConstantes, normalizar y ResultadoNormalizacion
- `src/database/contract/baseline.json` — crear: { "noVerificables": N } con el N medido al terminar la tarea
- `tests/database/contract-normalize.spec.ts` — crear: pruebas del normalizador

**Criterios de aceptación**

- Dado `SELECT ${ENTITY_COLUMNS} FROM legal_entities WHERE is_active = true` y la constante ENTITY_COLUMNS del mismo archivo, cuando corre normalizar, entonces devuelve estado 'listo' con la lista de columnas ya sustituida
- Dado `... WHERE entity_id = $1 AND code IN (${placeholders})`, cuando corre normalizar, entonces la interpolación queda como NULL y el estado es 'listo'
- Dado `SELECT ${COLS} FROM t WHERE ${conditions.join(' AND ')} ORDER BY created_at`, cuando corre normalizar, entonces el predicado queda como `true`
- Dado un literal con una interpolación en medio de la cláusula FROM, cuando corre normalizar, entonces devuelve 'no_verificable' con un motivo que cita la expresión
- Corriendo el runner sobre el repo, el número de no verificables es ≤ el de baseline.json y el runner lo imprime en el resumen

**Pruebas**

- `tests/database/contract-normalize.spec.ts` — resuelve constantes de columnas de módulo
- `tests/database/contract-normalize.spec.ts` — IN (${…}) → NULL, predicado → true, ORDER BY → 1
- `tests/database/contract-normalize.spec.ts` — una interpolación estructural devuelve no_verificable en vez de un SQL inventado

**Riesgo.** Sustituir con demasiada alegría convierte una consulta rota en una válida y el contrato deja de ver el bug. Mitigación: la regla 5 es el caso por defecto —ante la duda, no verificable— y la línea base impide que ese cajón crezca sin que alguien lo note.

##### `E0.2-c` Verificador contra Postgres efímero por PREPARE, y runner de línea de comandos · **L**

El verificador principal NO reimplementa un parser de SQL: usa Postgres. `PREPARE` obliga al servidor a analizar y planear la consulta, lo que resuelve tablas, columnas, funciones y restricciones de ON CONFLICT sin ejecutar nada ni tocar datos. Esto es lo que atrapa los bugs que el análisis estático no ve, como `SELECT id, type, … FROM garnishments WHERE … status = 'active'`, donde ninguna columna va calificada por alias.

Crear `src/database/contract/ephemeral.ts`:
```ts
export interface BaseEfimera { client: pg.Client; nombreBd: string; destruir(): Promise<void>; }
export async function crearBaseEfimera(urlAdmin: string): Promise<BaseEfimera>;
```
Crea `contrato_sql_<pid>_<epoch>` desde template0, conecta, aplica en orden `fs.readdirSync(migrationsDir).filter(.sql).sort()` —el mismo orden exacto que src/database/migrate.ts:26-28— y al final aplica `src/database/rls-policies.sql`, tal como hace migrate.ts:55-60. `destruir()` cierra y hace DROP DATABASE.

Crear `src/database/contract/verify.ts`:
```ts
export interface Hallazgo {
  archivo: string; linea: number; simbolo: string;
  regla: 'tabla_o_columna' | 'not_null' | 'valor_check' | 'enum_declarado';
  sqlstate?: string; mensaje: string; sql: string; sugerencia?: string;
}
export async function verificarPorPrepare(lits: LiteralSql[], client: pg.Client): Promise<{ hallazgos: Hallazgo[]; verificados: number; noVerificables: number }>;
```
Por cada literal normalizado: `PREPARE contrato_<n> AS <sql>` y luego `DEALLOCATE contrato_<n>`. Clasificación del error por `err.code`:
- 42P01 (tabla inexistente), 42703 (columna inexistente), 42883 (función inexistente), 42P10 (ON CONFLICT sin restricción que lo respalde), 42704 (objeto indefinido) → Hallazgo con regla 'tabla_o_columna'.
- 42P18 y 42804 cuyo mensaje mencione `parameter $` → no verificable (Postgres no puede inferir el tipo del parámetro; no es un defecto de esquema).
- 42601 (sintaxis) → no verificable con motivo 'el normalizador produjo SQL inválido'.
- Cualquier otro código → Hallazgo, para no tragarse nada en silencio.
Saltar los literales cuya primera palabra no sea PREPARE-able (todo lo que no sea SELECT/INSERT/UPDATE/DELETE/VALUES/WITH).

Formato del mensaje, obligatorio y literal (es el requisito de «archivo y símbolo»):
```
[contrato-sql] src/services/payroll/usa/forms/w2-generator.ts:64  generateW2()
  42P01  relation "entities" does not exist
  SELECT tax_id, name, address_line1, city, state_province, postal_code FROM entities WHERE id = $1
```
Y una línea `→ <sugerencia>` cuando la haya.

Crear el runner `src/database/contract/cli.ts` y el script `"contract:sql": "tsx src/database/contract/cli.ts"` en package.json. Sale con código 1 si hay hallazgos o si los no verificables superan la línea base; imprime al final `N literales verificados · H hallazgos · V no verificables`.

Crear la suite `tests/database/sql-contract.spec.ts` que llama al mismo verificador. Si no hay URL de base (`CONTRACT_DATABASE_URL` o, en su defecto, `MIGRATION_DATABASE_URL`): si `process.env.CI` está definido, FALLA con «el contrato SQL requiere Postgres en CI»; si no, hace `describe.skip` imprimiendo cómo levantarlo (`docker compose -f docker/docker-compose.yml up -d postgres`). Un skip silencioso convertiría este paquete en decoración.

**Archivos**

- `src/database/contract/ephemeral.ts` — crear: crearBaseEfimera con el mismo orden de migraciones que migrate.ts y reaplicación de rls-policies.sql
- `src/database/contract/verify.ts` — crear: verificarPorPrepare, tipo Hallazgo y clasificación por SQLSTATE
- `src/database/contract/cli.ts` — crear: runner que arma la base efímera, verifica, imprime y sale 0/1
- `package.json` — modificar: agregar el script "contract:sql"
- `tests/database/sql-contract.spec.ts` — crear: la suite que corre el contrato completo contra la base efímera

**Criterios de aceptación**

- Dado el repo con `FROM entities` sin corregir, cuando corre `npm run contract:sql`, entonces sale con código 1 y lista exactamente 7 hallazgos 42P01 nombrando form-941-generator.ts:78, form-940-generator.ts:60, w2-generator.ts:64, w3-generator.ts:37, w3-generator.ts:131, imss-idse-adapter.ts:62 y cfdi-nomina-generator.ts:50, cada uno con su símbolo
- Dado el repo con garnishment-engine sin corregir, cuando corre el contrato, entonces hay un hallazgo 42703 en garnishment-engine.ts:52 con símbolo calculateGarnishments
- Dado el INSERT con ON CONFLICT (employee_id, benefit_plan_id) de benefits-service.ts:61 antes de la migración 031, cuando corre el contrato, entonces hay un hallazgo 42P10
- Dado el repo ya reparado por las tareas e–j, cuando corre `npm run contract:sql`, entonces sale con código 0 y reporta 0 hallazgos
- Dado que la variable de base no está definida y CI=1, cuando corre `npx vitest run tests/database/sql-contract.spec.ts`, entonces la suite falla en vez de saltarse
- La base efímera se destruye siempre: tras una corrida fallida, `SELECT datname FROM pg_database WHERE datname LIKE 'contrato_sql_%'` devuelve cero filas

**Pruebas**

- `tests/database/sql-contract.spec.ts` — el contrato completo del repo no arroja hallazgos
- `tests/database/sql-contract.spec.ts` — un literal inyectado a mano con una columna inexistente produce un hallazgo con archivo, línea y símbolo
- `tests/database/sql-contract.spec.ts` — un literal con parámetro de tipo indeterminado cuenta como no verificable, no como hallazgo

**Riesgo.** Crear y migrar una base por corrida cuesta segundos; si se vuelve lento, cachear por hash del directorio de migraciones. Segundo riesgo: `DROP DATABASE` falla si quedó una conexión abierta — cerrar el client antes y usar WITH (FORCE) en PG15.

##### `E0.2-d` Chequeos estáticos que PREPARE no puede dar: NOT NULL omitidos y valores literales fuera del CHECK · **M**

PREPARE valida nombres, no valores ni obligatoriedad. Dos chequeos más, ambos automáticos y medidos como muy poco ruidosos sobre este repo.

Crear `src/database/contract/schema-model.ts`:
```ts
export interface ColumnaDDL { nombre: string; tipo: string; notNull: boolean; tieneDefault: boolean; }
export interface TablaDDL { nombre: string; columnas: Map<string, ColumnaDDL>; checksIn: Map<string, Set<string>>; }
export async function modelarEsquemaDesdeBD(client: pg.Client): Promise<Map<string, TablaDDL>>;
```
Lee `information_schema.columns` (is_nullable, column_default) y `pg_constraint` con `pg_get_constraintdef(oid)` filtrando los CHECK cuya definición sea de la forma `(col = ANY (ARRAY['a'::…, …]))` para poblar `checksIn`. Se modela desde el catálogo vivo, no reparseando SQL: es la única fuente que no miente.

Crear `src/database/contract/static-checks.ts`:
```ts
export function verificarNotNullEnInserts(lits: LiteralSql[], modelo: Map<string, TablaDDL>): Hallazgo[];
export function verificarLiteralesContraCheck(lits: LiteralSql[], modelo: Map<string, TablaDDL>): Hallazgo[];
```
1. `verificarNotNullEnInserts`: para cada `INSERT INTO t (cols…)`, si alguna columna de `t` es NOT NULL, no tiene DEFAULT y no está en la lista, hallazgo regla 'not_null'. Medido sobre el repo actual: exactamente 2 hallazgos, ambos reales (benefits-service.ts:49 omite `name`; benefits-service.ts:61 omite `employee_contribution_type` y `employee_contribution_value`). Cero falsos positivos, así que la línea base es 0.
2. `verificarLiteralesContraCheck`: para cada `INSERT … VALUES` con valor de cadena literal en posición conocida, y para cada `UPDATE t SET col = 'valor'`, si `t.col` tiene CHECK IN y el valor no está en el conjunto, hallazgo regla 'valor_check'. Medido sobre el repo actual: exactamente 1 hallazgo, real (irs-efile-adapter.ts:63, `SET status = 'submitted'` contra el CHECK ('draft','ready','filed','accepted','rejected','amended')).

Ambos se integran en el runner y en la suite; sus hallazgos usan el mismo formato de mensaje.

**Archivos**

- `src/database/contract/schema-model.ts` — crear: modelarEsquemaDesdeBD leyendo information_schema y pg_constraint
- `src/database/contract/static-checks.ts` — crear: verificarNotNullEnInserts y verificarLiteralesContraCheck
- `src/database/contract/cli.ts` — modificar: sumar los dos chequeos estáticos al reporte

**Criterios de aceptación**

- Dado el repo sin la corrección de beneficios, cuando corren los chequeos estáticos, entonces hay exactamente 2 hallazgos 'not_null', en benefits-service.ts:49 y :61, citando name / employee_contribution_type / employee_contribution_value
- Dado el repo sin la migración 031, cuando corren los chequeos estáticos, entonces hay exactamente 1 hallazgo 'valor_check' en irs-efile-adapter.ts:63 por status='submitted'
- Dado el repo ya reparado, los dos chequeos estáticos devuelven cero hallazgos
- modelarEsquemaDesdeBD sobre la base efímera devuelve 96 tablas y reconoce el CHECK de pay_runs.run_type con sus valores

**Pruebas**

- `tests/database/contract-static.spec.ts` — un INSERT que omite una NOT NULL sin DEFAULT se reporta; uno que la omite pero con DEFAULT no
- `tests/database/contract-static.spec.ts` — un UPDATE con un valor fuera del CHECK se reporta con la lista de valores permitidos en el mensaje

**Riesgo.** Rutina.

##### `E0.2-e` `entities` no existe: siete consultas contra legal_entities y las columnas que le faltan · **S**

El atlas dice «siete archivos de nómina»; el código dice 6 archivos y 7 sitios (w3-generator tiene dos). Gana el código.

Sustituir `entities` por `legal_entities` en:
- src/services/payroll/usa/forms/form-941-generator.ts:78 (`SELECT tax_id, name`)
- src/services/payroll/usa/forms/form-940-generator.ts:60 (`SELECT tax_id, name`)
- src/services/payroll/usa/forms/w2-generator.ts:64
- src/services/payroll/usa/forms/w3-generator.ts:37 y :131
- src/services/payroll/integrations/imss-idse-adapter.ts:62
- src/services/payroll/mx/cfdi-nomina-generator.ts:65 (`JOIN entities ent ON ent.id = e.entity_id`)

Pero renombrar no basta: `legal_entities` (001_core_schema.sql:76-92) tiene id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type, incorporation_country, functional_currency, accounting_standard, fiscal_year_start_month, is_active, created_at, updated_at — y nada más. NO tiene address_line1, city, state_province, postal_code (que w2 y w3 piden para la dirección del patrón en la forma) ni imss_registro_patronal (que imss-idse pide para el registro patronal). Esas columnas se agregan en la migración 031 (ver campo `migracion`).

Además, en imss-idse-adapter.ts:63 hoy hace `entResult.rows[0]?.imss_registro_patronal || ''`, es decir, si falta emite un lote IDSE con el registro patronal en blanco. Cambiarlo por un fallo explícito: si `rp` queda vacío, lanzar `new ValidationError('La entidad no tiene registro patronal IMSS: captúralo antes de generar el lote IDSE')`. Un archivo de 270 caracteres con los primeros 11 en blanco es un rechazo del IMSS disfrazado de éxito.

En w2-generator.ts:73 y w3-generator.ts:41 la dirección se arma con `[ent?.address_line1, ent?.city, …].filter(Boolean).join(', ')`: eso sigue funcionando con las columnas nuevas en NULL, así que no hay que tocarlo.

**Archivos**

- `src/services/payroll/usa/forms/form-941-generator.ts` — modificar línea 78: FROM entities → FROM legal_entities
- `src/services/payroll/usa/forms/form-940-generator.ts` — modificar línea 60: FROM entities → FROM legal_entities
- `src/services/payroll/usa/forms/w2-generator.ts` — modificar línea 64: FROM entities → FROM legal_entities
- `src/services/payroll/usa/forms/w3-generator.ts` — modificar líneas 37 y 131: FROM entities → FROM legal_entities
- `src/services/payroll/integrations/imss-idse-adapter.ts` — modificar línea 62 (FROM entities → FROM legal_entities) y línea 63 (fallar si el registro patronal viene vacío en vez de emitir el lote con 11 espacios)
- `src/services/payroll/mx/cfdi-nomina-generator.ts` — modificar línea 65: JOIN entities ent → JOIN legal_entities ent
- `src/database/migrations/031_payroll_schema_contract.sql` — crear: columnas de domicilio y registro patronal en legal_entities (más lo de las tareas f, g y h)

**Migración**

```sql
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255);
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(100);
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS state_province VARCHAR(50);
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20);
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS imss_registro_patronal VARCHAR(11);
```

**Criterios de aceptación**

- Dado el repo reparado, `grep -rn "FROM entities\|JOIN entities" src` devuelve cero resultados
- Dada la base con la migración 031 aplicada, cuando corre el contrato SQL, entonces no hay ningún hallazgo 42P01 ni 42703 en los seis archivos de esta tarea
- Dada una entidad legal sin imss_registro_patronal, cuando se llama generateIdseBatch, entonces lanza ValidationError con un mensaje que nombra el registro patronal, y no devuelve contenido
- Dada una entidad legal con tax_id y name, cuando se llama generateForm941 contra la base efímera, entonces la consulta ejecuta y employer.ein trae el tax_id

**Pruebas**

- `tests/payroll/usa/forms-schema.spec.ts` — contra la base efímera con una entidad sembrada, generateForm941 y generateForm940 devuelven employer.ein y no lanzan
- `tests/payroll/mx/idse.spec.ts` — generateIdseBatch lanza si la entidad no tiene registro patronal

**Riesgo.** Las nuevas columnas nacen en NULL: W-2 y W-3 saldrán sin dirección del patrón hasta que alguien la capture. Es visible y honesto (mejor que hoy, que ni siquiera corren), pero conviene que `mnemosine doctor` lo advierta para entidades con trabajadores US. Se anota como seguimiento del paquete de nómina, no aquí.

##### `E0.2-f` Embargos: alinear garnishment-engine con la tabla garnishments real · **M**

src/services/payroll/usa/garnishments/garnishment-engine.ts:52-68 consulta ocho columnas que no existen. La tabla real (008_payroll.sql:424-447) es: id, employee_id, garnishment_type, priority, amount_type, amount_value, max_withholding_pct, case_number, issuing_authority, payee_name, payee_address, payee_bank_account_encrypted, start_date, end_date, total_owed, total_paid, is_active, metadata. No tiene created_at.

Mapa columna-a-columna:
- `type` → `garnishment_type`
- `status = 'active'` → `is_active = true`
- `created_at` (en el ORDER BY) → `start_date` (es el orden legalmente correcto entre órdenes de la misma prioridad: primero en llegar, primero en cobrar) y, para desempate estable, `id`
- `amount_per_period` / `percentage` → derivar de `amount_type` + `amount_value`: si amount_type='fixed' → amount_per_period = amount_value; si amount_type IN ('percent_disposable','percent_gross') → percentage = amount_value
- `supports_second_family`, `arrears_over_12_weeks`, `exempt_amount` → no existen en ninguna migración (verificado: `grep -rn garnishments src/database/migrations/*.sql` fuera de 008 devuelve cero). Se crean en la migración 031, porque son datos reales de la orden judicial y no cabe inventarlos desde el motor.

Consulta nueva:
```sql
SELECT id, garnishment_type, amount_type, amount_value, priority,
       supports_second_family, arrears_over_12_weeks, exempt_amount
  FROM garnishments
 WHERE employee_id = $1
   AND is_active = true
   AND start_date <= $2
   AND (end_date IS NULL OR end_date >= $2)
 ORDER BY priority ASC, start_date ASC, id ASC
```
El `$2` es la fecha del periodo: hoy el motor cobra órdenes que aún no arrancan o ya vencieron. Añadir a `GarnishmentInput` el campo obligatorio `pay_date: string` y pasarlo desde paycheck-service.ts:293 (ahí ya está disponible `period`, del que sale la fecha de pago).

El catálogo de `garnishment_type` documentado en el DDL es child_support, tax_levy_federal, tax_levy_state, creditor, student_loan, pension_alimenticia; el tipo TS del motor es child_support | tax_levy | creditor | bankruptcy | student_loan. Añadir en el mismo archivo:
```ts
export function mapTipoEmbargo(tipoBd: string): GarnishmentOrder['type'] | null
```
que traduce tax_levy_federal y tax_levy_state → 'tax_levy'; child_support, creditor, student_loan → tal cual; pension_alimenticia → 'child_support' (es su equivalente mexicano y el tope CCPA no aplica en MX, pero el motor solo corre para country_code='US', así que en la práctica no se alcanza); cualquier otro → null, y el motor lo omite registrando un warning con el id de la orden. No inventar 'bankruptcy': no está en el catálogo; el tipo TS lo conserva por compatibilidad pero mapTipoEmbargo nunca lo devuelve.

No tocar la aritmética CCPA (líneas 80-130): está bien y es lo único de este archivo que hoy tiene pruebas.

Actualizar tests/payroll/usa/garnishments.spec.ts: las 8 pruebas siguen mockeando `query`, pero sus filas deben pasar a los nombres reales de columna. El test de contrato es quien impide que el mock vuelva a divergir.

**Archivos**

- `src/services/payroll/usa/garnishments/garnishment-engine.ts` — modificar: consulta de las líneas 52-68, mapeo amount_type/amount_value, nuevo campo pay_date en GarnishmentInput y nueva función exportada mapTipoEmbargo
- `src/services/payroll/common/paycheck-service.ts` — modificar línea 293: pasar pay_date a calculateGarnishments
- `tests/payroll/usa/garnishments.spec.ts` — modificar: las filas mockeadas usan garnishment_type/amount_type/amount_value/is_active; añadir caso de orden fuera de vigencia y caso de tipo desconocido
- `src/database/migrations/031_payroll_schema_contract.sql` — modificar: agregar las tres columnas CCPA y created_at a garnishments

**Migración**

```sql
ALTER TABLE garnishments ADD COLUMN IF NOT EXISTS supports_second_family BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE garnishments ADD COLUMN IF NOT EXISTS arrears_over_12_weeks  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE garnishments ADD COLUMN IF NOT EXISTS exempt_amount          NUMERIC(14,2);
ALTER TABLE garnishments ADD COLUMN IF NOT EXISTS created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW();
```

**Criterios de aceptación**

- Dado un trabajador US con una orden activa, cuando corre calculateGarnishments contra la base efímera, entonces devuelve el importe esperado y no lanza 42703
- Dada una orden con end_date anterior a la fecha de pago, cuando corre calculateGarnishments, entonces esa orden no aparece en per_order
- Dada una orden con amount_type='percent_disposable' y amount_value=25, cuando el disponible es 1000, entonces el importe deseado antes de topes es 250
- Dada una orden con garnishment_type='tax_levy_state', cuando corre el motor, entonces se trata como 'tax_levy' y aplica el exento de Pub 1494
- Dada una orden con garnishment_type desconocido, cuando corre el motor, entonces se omite y se registra un warning con el id de la orden, sin lanzar
- Los 8 casos existentes de garnishments.spec.ts siguen verdes con los nombres de columna reales

**Pruebas**

- `tests/payroll/usa/garnishments.spec.ts` — topes CCPA con las columnas reales (los 8 casos existentes, adaptados)
- `tests/payroll/usa/garnishments.spec.ts` — filtra órdenes fuera de vigencia por start_date/end_date
- `tests/payroll/usa/garnishments.spec.ts` — mapTipoEmbargo traduce los seis valores del catálogo y devuelve null para lo desconocido

**Riesgo.** El motor ignora `max_withholding_pct`, que existe en la tabla justamente para topar la orden. Honrarlo cambia importes calculados, así que se deja como decisión (ver decisiones_a_resolver) y no se toca en esta tarea.

##### `E0.2-g` Beneficios: alinear benefits-service con benefits_plans y employee_benefit_elections · **M**

Cinco consultas de src/services/payroll/usa/benefits/benefits-service.ts hablan de un esquema que no existe. Columnas reales (008_payroll.sql:388-418):
- benefits_plans: id, tenant_id, entity_id, plan_type, **name**, provider, is_pre_tax, employer_match_formula, **contribution_limit_annual**, catchup_limit_annual, is_active, metadata
- employee_benefit_elections: id, employee_id, benefit_plan_id, effective_date, end_date, **employee_contribution_type**, **employee_contribution_value**, employer_contribution_value, is_active

Correcciones:
1. Línea 49, INSERT INTO benefits_plans: `plan_name` → `name`, `annual_limit` → `contribution_limit_annual`. La columna `name` es NOT NULL sin DEFAULT y hoy se omite, así que este INSERT nunca pudo ejecutarse (lo detecta el chequeo estático de la tarea d).
2. Línea 61, INSERT INTO employee_benefit_elections: `election_type` → `employee_contribution_type`, `election_value` → `employee_contribution_value`, y eliminar `status` (la columna es `is_active BOOLEAN DEFAULT true`). El `ON CONFLICT (employee_id, benefit_plan_id)` revienta con 42P10 porque la tabla no tiene esa clave única: la crea la migración 031. En el DO UPDATE, `status = 'active'` pasa a `is_active = true`.
3. Líneas 94-98, SELECT de calculateBenefitsForPaycheck: `ebe.election_type`, `ebe.election_value`, `bp.annual_limit` y `ebe.status = 'active'` → `ebe.employee_contribution_type`, `ebe.employee_contribution_value`, `bp.contribution_limit_annual` y `ebe.is_active = true`. Añadir al WHERE la vigencia por fecha, coherente con el resto: `AND ebe.effective_date <= $2 AND (ebe.end_date IS NULL OR ebe.end_date >= $2)`, con $2 la fecha de pago; propagarla desde el llamador.
4. Línea 151, listBenefitPlans: `ORDER BY plan_type, plan_name` → `ORDER BY plan_type, name`.
5. Líneas 159-163, listEmployeeElections: `bp.plan_name` → `bp.name`, `ebe.status = 'active'` → `ebe.is_active = true`.

El tipo `election_type: 'percentage' | 'fixed_amount'` del código y el comentario del DDL («percent, fixed_amount») no coinciden en el primer valor. La columna no tiene CHECK, así que ambos entran; se decide en decisiones_a_resolver. Mientras tanto, dejar en el código el valor que ya usa la ruta REST (`percentage`, src/api/rest/routes/payroll.ts:91) y corregir el comentario del DDL en la migración 031 con un COMMENT ON COLUMN, para que el esquema deje de documentar algo que nadie escribe.

Ajustar tests/payroll/usa/benefits.spec.ts a los nombres reales de columna.

**Archivos**

- `src/services/payroll/usa/benefits/benefits-service.ts` — modificar: las cinco consultas (49, 61, 94-98, 151, 159-163) y propagar la fecha de pago a calculateBenefitsForPaycheck
- `src/services/payroll/common/paycheck-service.ts` — modificar: pasar la fecha de pago a calculateBenefitsForPaycheck
- `tests/payroll/usa/benefits.spec.ts` — modificar: filas mockeadas con employee_contribution_type/value, contribution_limit_annual e is_active; añadir caso de elección fuera de vigencia
- `src/database/migrations/031_payroll_schema_contract.sql` — modificar: UNIQUE(employee_id, benefit_plan_id) en employee_benefit_elections y COMMENT ON COLUMN del tipo de contribución

**Migración**

```sql
ALTER TABLE employee_benefit_elections DROP CONSTRAINT IF EXISTS employee_benefit_elections_emp_plan_uniq;
-- Deduplicar antes de imponer la clave: en instalaciones existentes la tabla está vacía
-- (el INSERT nunca pudo ejecutarse), pero la limpieza cuesta nada y evita una migración que falla.
DELETE FROM employee_benefit_elections a USING employee_benefit_elections b
 WHERE a.ctid < b.ctid AND a.employee_id = b.employee_id AND a.benefit_plan_id = b.benefit_plan_id;
ALTER TABLE employee_benefit_elections
  ADD CONSTRAINT employee_benefit_elections_emp_plan_uniq UNIQUE (employee_id, benefit_plan_id);
COMMENT ON COLUMN employee_benefit_elections.employee_contribution_type IS 'percentage | fixed_amount';
```

**Criterios de aceptación**

- Dada la base efímera con la 031 aplicada, cuando corre createBenefitPlan, entonces inserta y no falla por `name` NOT NULL
- Dado electBenefit llamado dos veces con el mismo (employee_id, benefit_plan_id), entonces la segunda actualiza la fila existente en vez de fallar con 42P10, y la tabla queda con una sola fila
- Dada una elección con end_date anterior a la fecha de pago, cuando corre calculateBenefitsForPaycheck, entonces no produce deducción
- Dado el repo reparado, `grep -rn "plan_name\|annual_limit\|election_value" src/services/payroll` devuelve cero resultados
- El chequeo estático de NOT NULL devuelve cero hallazgos en benefits-service.ts

**Pruebas**

- `tests/payroll/usa/benefits.spec.ts` — tope anual y match patronal con los nombres reales de columna
- `tests/payroll/usa/benefits.spec.ts` — electBenefit es idempotente sobre el par (empleado, plan)
- `tests/payroll/usa/benefits.spec.ts` — una elección vencida no genera deducción

**Riesgo.** Rutina; la tabla está vacía en toda instalación porque su único escritor nunca pudo correr.

##### `E0.2-h` tax_form_filings: acuse de envío (submission_id, submitted_at, provider) y el estado 'submitted' · **S**

Dos adaptadores escriben columnas que no existen y un estado fuera del CHECK:
- src/services/payroll/integrations/ssa-bso-adapter.ts:49 inserta `provider, submission_id, submitted_at` y pasa `'submitted'` como status por parámetro $4.
- src/services/payroll/integrations/irs-efile-adapter.ts:63 hace `UPDATE tax_form_filings SET status='submitted', submission_id=$1, submitted_at=NOW(), provider='irs_mef'`.
- src/services/payroll/integrations/irs-efile-adapter.ts:86 consulta `WHERE submission_id = $1`.

La tabla (008_payroll.sql:482-503) tiene id, tenant_id, entity_id, form_type, tax_year, period, status, filed_at, confirmation_number, xml_path, pdf_path, data, employee_id, created_at; y `CHECK (status IN ('draft','ready','filed','accepted','rejected','amended'))`.

El arreglo va del lado del esquema, no del código: 'submitted' es un estado real y distinto de 'filed' (enviado y sin acuse todavía frente a presentado y aceptado), y el acuse necesita dónde guardarse. Precedente exacto en el repo: la migración 023 recrea un CHECK por la misma razón (el enum TS y la ruta REST aceptaban 'payroll' y el CHECK de 001 no lo listaba).

En la migración 031: agregar `provider VARCHAR(30)`, `submission_id VARCHAR(64)`, `submitted_at TIMESTAMPTZ`, un índice parcial sobre submission_id (irs-efile-adapter.ts:86 lo usa como criterio de búsqueda) y recrear el CHECK de status insertando 'submitted' entre 'ready' y 'filed'.

Del lado del código, un solo cambio de comportamiento: irs-efile-adapter.ts:63 hoy corre en autocommit el UPDATE y luego devuelve; dejarlo así (una sola sentencia es atómica por sí misma). No introducir transacción donde no hay dos escrituras.

**Archivos**

- `src/database/migrations/031_payroll_schema_contract.sql` — modificar: tres columnas nuevas, índice parcial y CHECK de status recreado con 'submitted'
- `src/services/payroll/integrations/irs-efile-adapter.ts` — sin cambios de SQL; verificar que el contrato deja de reportar el 'valor_check' de la línea 63
- `src/services/payroll/integrations/ssa-bso-adapter.ts` — sin cambios de SQL; verificar que el contrato deja de reportar 42703

**Migración**

```sql
ALTER TABLE tax_form_filings ADD COLUMN IF NOT EXISTS provider      VARCHAR(30);
ALTER TABLE tax_form_filings ADD COLUMN IF NOT EXISTS submission_id VARCHAR(64);
ALTER TABLE tax_form_filings ADD COLUMN IF NOT EXISTS submitted_at  TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tax_filings_submission
    ON tax_form_filings(submission_id) WHERE submission_id IS NOT NULL;
ALTER TABLE tax_form_filings DROP CONSTRAINT IF EXISTS tax_form_filings_status_check;
ALTER TABLE tax_form_filings ADD CONSTRAINT tax_form_filings_status_check
    CHECK (status IN ('draft','ready','submitted','filed','accepted','rejected','amended'));
```

**Criterios de aceptación**

- Dada la base con la 031, `SELECT count(*) FROM information_schema.columns WHERE table_name='tax_form_filings' AND column_name IN ('submission_id','submitted_at','provider')` devuelve 3
- Dada una fila en estado 'ready', cuando corre submitFormToIrs, entonces el UPDATE ejecuta sin violación de CHECK y la fila queda con status='submitted', submission_id no nulo y provider='irs_mef'
- Dado el repo con la 031 aplicada, el chequeo 'valor_check' del contrato devuelve cero hallazgos
- getSubmissionStatus encuentra la fila por submission_id usando el índice (EXPLAIN muestra el índice parcial, no un seq scan, con la tabla poblada)

**Pruebas**

- `tests/payroll/usa/tax-filings.spec.ts` — contra la base efímera: submitFormToIrs deja status='submitted' y acuse persistido; getSubmissionStatus lo recupera

**Riesgo.** Recrear un CHECK valida todas las filas existentes: si alguna instalación tuviera un status fuera de la nueva lista, la migración aborta. La lista nueva es un superconjunto estricto de la vieja, así que no puede ocurrir.

##### `E0.2-i` Forma 940: la columna se llama futa, no futa_employer · **S**

src/services/payroll/usa/forms/form-940-generator.ts:38-44 hace `COALESCE(SUM(p.futa_employer), 0)` cinco veces (total y los cuatro trimestres) sobre `paychecks p`. La columna real es `futa NUMERIC(14,2) DEFAULT 0` (008_payroll.sql, bloque paychecks; la vecina es `suta`). No hay ningún `futa_employer` en ninguna migración.

Sustituir las cinco ocurrencias de `p.futa_employer` por `p.futa`. Nada más en el archivo cambia: `p.taxable_wages_futa` sí existe, y la subconsulta a employer_tax_liabilities (amount, tax_type, period_start, period_end, deposited_at) está correcta.

Este hallazgo no está en el atlas: lo encontró el barrido de columnas calificadas por alias de esta especificación.

**Archivos**

- `src/services/payroll/usa/forms/form-940-generator.ts` — modificar líneas 38-44: p.futa_employer → p.futa (cinco ocurrencias)

**Criterios de aceptación**

- Dado el repo reparado, `grep -rn futa_employer src` devuelve cero resultados
- Dada la base efímera con paychecks sembrados, cuando corre generateForm940, entonces line_8 (FUTA total) es la suma de paychecks.futa y no lanza 42703
- El contrato SQL no reporta hallazgos en form-940-generator.ts

**Pruebas**

- `tests/payroll/usa/forms-schema.spec.ts` — generateForm940 suma paychecks.futa y reparte por trimestre según pay_periods.pay_date

**Riesgo.** Rutina.

##### `E0.2-j` Seis vocabularios Zod que el CHECK de Postgres rechaza, y el registro que impide que vuelvan a divergir · **M**

Cada vocabulario pasa a vivir en UNA tupla `as const` exportada por el módulo dueño; la ruta REST construye su `z.enum` a partir de esa tupla, y el registro del contrato compara la tupla contra el CHECK real. Así el enum no puede volver a separarse del esquema sin que el test lo vea.

Crear `src/database/contract/enum-registry.ts`:
```ts
export interface ParEnum { tabla: string; columna: string; fuente: string; valores: readonly string[]; }
export const CONTRATO_ENUMS: ParEnum[];
export function verificarEnums(modelo: Map<string, TablaDDL>, pares: ParEnum[]): Hallazgo[];
```
`verificarEnums` falla si `valores` NO es subconjunto del CHECK de `tabla.columna`, y avisa (no falla) si el CHECK tiene valores que ninguna tupla usa.

Divergencias verificadas y su resolución:
1. **pay_runs.run_type** — src/api/rest/routes/payroll.ts:84 acepta 'finiquito'; el CHECK (008_payroll.sql:158-159) lista regular, bonus, correction, final, off_cycle. El valor llega al INSERT porque el handler hace `createPayRun({ ...req.body, … })` (payroll.ts:195-199) y pay-run-service.ts:39-41 lo mete tal cual. Resolución: ampliar el CHECK (migración 032). Además la unión TS de pay-run-service.ts:24 incluye 'final' pero el Zod no, así que la ruta REST no puede crear una corrida final: exportar `export const TIPOS_CORRIDA = ['regular','bonus','correction','final','off_cycle','finiquito'] as const` desde pay-run-service.ts, tipar `run_type?: typeof TIPOS_CORRIDA[number]` y escribir `z.enum(TIPOS_CORRIDA)` en la ruta.
2. **reconciliation_matches.matched_entity_type** — src/api/rest/routes/bank-reconciliation.ts:34 acepta 'journal_entry' y 'payment'; el CHECK (003_banking_assets_inventory.sql:108-109) lista journal_entry_line, invoice, bill, customer_payment, vendor_payment. El valor entra al INSERT de bank-reconciliation.ts:161-166. Resolución: estrechar el código al esquema — 'journal_entry' → 'journal_entry_line' y 'payment' se parte en 'customer_payment' y 'vendor_payment'. Exportar la tupla desde src/services/banking/matching.ts y usarla en la ruta.
3-5. **blockchain_config** — src/api/rest/routes/blockchain.ts:22, 24 y 25 aceptan redundancy_mode ['none','mirror','verify_only'], verification_layer ['zkverify','none'] y messaging_protocol [...,'none']; los CHECK de 006_blockchain_integration.sql:21-31 exigen ('none','async_backup','sync_multi','consensus'), ('zkverify','native','both') y ('layerzero','wormhole','axelar','ccip'). El orchestrator (src/services/blockchain/orchestrator.ts:16-17) ya usa el vocabulario de la base. Resolución: estrechar el Zod al vocabulario del orchestrator, exportando las tuplas desde orchestrator.ts. El 'none' de messaging_protocol se expresa dejando la columna en NULL (es nullable), no con un literal.
6. **bitcoin_anchor_config.anchor_method** — blockchain.ts:52 acepta ['opentimestamps','direct','hybrid']; el CHECK (006:90-91) exige ('direct_op_return','opentimestamps','both'). Resolución: estrechar — 'direct' → 'direct_op_return', 'hybrid' → 'both'. Este no lo cita el atlas.

Registrar los seis pares en CONTRATO_ENUMS, más tax_form_filings.status y pay_runs.status como pares de control.

**Archivos**

- `src/database/contract/enum-registry.ts` — crear: CONTRATO_ENUMS con los ocho pares y verificarEnums
- `src/services/payroll/common/pay-run-service.ts` — modificar: exportar TIPOS_CORRIDA as const y tipar run_type desde ahí
- `src/api/rest/routes/payroll.ts` — modificar línea 84: z.enum(TIPOS_CORRIDA) importado del servicio
- `src/services/banking/matching.ts` — modificar: exportar TIPOS_ENTIDAD_CONCILIADA as const con los cinco valores del CHECK
- `src/api/rest/routes/bank-reconciliation.ts` — modificar línea 34: z.enum(TIPOS_ENTIDAD_CONCILIADA)
- `src/services/blockchain/orchestrator.ts` — modificar: exportar MODOS_REDUNDANCIA, CAPAS_VERIFICACION, PROTOCOLOS_MENSAJERIA y METODOS_ANCLAJE as const, y derivar de ellas los tipos de BlockchainConfig
- `src/api/rest/routes/blockchain.ts` — modificar líneas 22, 24, 25 y 52: construir los z.enum desde las tuplas del orchestrator; messaging_protocol pasa a .nullable() en vez de aceptar 'none'
- `src/database/migrations/032_pay_run_type_finiquito.sql` — crear: recrear el CHECK de pay_runs.run_type con 'finiquito'

**Migración**

```sql
-- 032_pay_run_type_finiquito.sql
-- El finiquito es una corrida real en México y la ruta REST ya lo acepta
-- (payroll.ts:84), pero el CHECK original de 008 nunca lo listó: cada intento
-- moría con 23514. Mismo criterio que la migración 023 con entry_type='payroll'.
ALTER TABLE pay_runs DROP CONSTRAINT IF EXISTS pay_runs_run_type_check;
ALTER TABLE pay_runs ADD CONSTRAINT pay_runs_run_type_check
    CHECK (run_type IN ('regular','bonus','correction','final','off_cycle','finiquito'));
```

**Criterios de aceptación**

- Dada la base con la 032, cuando POST /v1/payroll/pay-runs recibe run_type='finiquito', entonces crea la corrida y no lanza 23514
- Dado POST /v1/bank-transactions/:id/match con matched_entity_type='payment', entonces la validación Zod lo rechaza con 400 antes de tocar la base, y 'customer_payment' sí es aceptado
- Dado PUT de configuración blockchain con redundancy_mode='mirror', entonces devuelve 400 y no una violación de CHECK; con 'async_backup' persiste
- Dado que alguien agrega un valor a cualquiera de las ocho tuplas sin migrar el CHECK, cuando corre `npm run contract:sql`, entonces falla nombrando la tupla, la tabla y la columna
- verificarEnums avisa de que pay_runs.run_type ya no tiene valores del CHECK sin uso en la tupla

**Pruebas**

- `tests/database/contract-enums.spec.ts` — cada par de CONTRATO_ENUMS es subconjunto del CHECK real de la base efímera
- `tests/database/contract-enums.spec.ts` — un par con un valor de más produce un hallazgo con la lista de valores permitidos
- `tests/api/bank-reconciliation-enums.spec.ts` — 'journal_entry' y 'payment' quedan rechazados por Zod; los cinco valores del CHECK pasan

**Riesgo.** Estrechar los enum de blockchain y banca es un cambio incompatible para cualquier cliente que hoy mande 'mirror' o 'payment'. En la práctica no lo hay: esos valores nunca pudieron persistirse, siempre reventaban en el CHECK. Documentarlo igual en el CHANGELOG.

##### `E0.2-k` Numeración de migraciones: política, guarda en migrate.ts, huella y chequeo en doctor · **M**

Estado verificado: `src/database/migrations/` tiene 34 archivos y cuatro números repetidos, nueve archivos en total —012_ai_drafts_unique_source / 012_fix_mv_account_balance_summary; 014_ai_external_ops / 014_fiscal_credentials / 014_rls_tenant_isolation; 015_account_roles / 015_identities; 018_ai_sessions / 018_fix_account_roles_unique—. El orden real de aplicación es el alfabético de `readdirSync().sort()` (migrate.ts:26-28), no el numérico, así que hoy el orden dentro de cada número lo decide el sufijo. El último número libre es 031.

**Política** (documentarla en `src/database/migrations/README.md`):
1. Nombre `NNN_slug_en_snake_case.sql`, NNN de tres dígitos, único en todo el directorio, igual a (máximo actual + 1).
2. Nunca renombrar ni editar un archivo ya aplicado. `public.migrations.filename` es la clave única (migrate.ts:17-21), de modo que un renombrado reejecuta el archivo en toda instalación existente y una edición deja instalaciones divergentes sin aviso. Toda corrección se hace con una migración nueva — es el mismo criterio que las correcciones por reversa del mayor (NIF B-1): no se edita el pasado, se le añade.
3. Los nueve archivos con número duplicado quedan **congelados con su nombre actual** y se listan como excepción explícita. No se renumeran.

**Guarda en migrate.ts**, antes del bucle (después de leer `files` en la línea 28 y antes del `for`):
```ts
const DUPLICADOS_HISTORICOS = new Set([
  '012_ai_drafts_unique_source.sql', '012_fix_mv_account_balance_summary.sql',
  '014_ai_external_ops.sql', '014_fiscal_credentials.sql', '014_rls_tenant_isolation.sql',
  '015_account_roles.sql', '015_identities.sql',
  '018_ai_sessions.sql', '018_fix_account_roles_unique.sql',
]);
export function validarNumeracion(archivos: string[]): string[]; // devuelve los mensajes de error
```
`validarNumeracion` agrupa por los tres primeros caracteres; para cada grupo con más de un archivo, si TODOS están en DUPLICADOS_HISTORICOS lo deja pasar; si alguno no lo está, produce «el número NNN ya lo usa X; renombra Y a ZZZ_… (siguiente libre)». Si hay algún mensaje, migrate.ts imprime todos y hace `process.exit(1)` **sin aplicar ninguna migración**. Fallar antes de tocar la base es lo que hace que la guarda sirva.

Validar también que todo archivo respete `/^\d{3}_[a-z0-9_]+\.sql$/`.

**Huella de contenido**: en el bootstrap de migrate.ts, tras el CREATE TABLE IF NOT EXISTS, añadir `ALTER TABLE public.migrations ADD COLUMN IF NOT EXISTS checksum CHAR(64)`. Al aplicar un archivo, guardar `sha256(contenido)`. Al saltar uno ya aplicado: si `checksum` es NULL (fila anterior a este cambio), rellenarlo con el actual y anotar «huella sembrada»; si difiere, abortar con «MIGRATION_CHECKSUM_MISMATCH: NNN_… cambió después de aplicarse; corrige con una migración nueva» y `process.exit(1)`. Esto convierte la regla 2 en algo que la herramienta hace cumplir, no en una costumbre.

**Doctor**: agregar `checkMigrationNumbering(deps: DoctorDeps): Promise<CheckResult>` en src/ai/doctor-service.ts, junto a `checkMigrations` (línea 78). Nivel 'fail' si hay duplicados no históricos, 'warn' si hay huellas divergentes, 'ok' en otro caso; `fix` sugiere el siguiente número libre. Registrarlo en la lista de chequeos que arma el reporte.

**Archivos**

- `src/database/migrate.ts` — modificar: exportar validarNumeracion y DUPLICADOS_HISTORICOS; invocarla antes del bucle con salida 1; ADD COLUMN IF NOT EXISTS checksum en el bootstrap; guardar y comparar sha256 por archivo
- `src/ai/doctor-service.ts` — modificar: nueva función checkMigrationNumbering y su registro en el reporte
- `src/database/migrations/README.md` — crear: la política de numeración, la lista de duplicados históricos y el porqué de no renombrar
- `tests/database/migration-naming.spec.ts` — crear: pruebas de validarNumeracion, sin base de datos

**Criterios de aceptación**

- Dado el directorio de migraciones tal como está hoy, cuando corre validarNumeracion, entonces devuelve cero mensajes (los nueve duplicados están en la lista histórica)
- Dados dos archivos nuevos 033_a.sql y 033_b.sql, cuando corre `npm run migrate`, entonces imprime el conflicto, sugiere 034 y sale con código 1 SIN haber insertado nada en public.migrations
- Dado un archivo llamado 33_algo.sql o migracion_nueva.sql, cuando corre validarNumeracion, entonces lo rechaza por formato
- Dada una instalación con 030 aplicada y sin columna checksum, cuando corre `npm run migrate`, entonces la columna se crea, las 34 filas quedan con huella y el proceso termina en 0
- Dado que alguien edita 025_ledger_hardening.sql después de aplicado, cuando corre `npm run migrate`, entonces aborta con MIGRATION_CHECKSUM_MISMATCH nombrando el archivo
- Dado un entorno con duplicados, `mnemosine doctor` muestra el chequeo de numeración en nivel fail con el siguiente número libre como fix
- `ls src/database/migrations | cut -c1-3 | sort | uniq -d` devuelve exactamente 012, 014, 015 y 018 y nada más

**Pruebas**

- `tests/database/migration-naming.spec.ts` — el directorio real no produce mensajes; un duplicado nuevo sí, y el mensaje trae el siguiente número libre
- `tests/database/migration-naming.spec.ts` — rechaza nombres fuera del patrón NNN_slug.sql
- `tests/database/migration-naming.spec.ts` — un duplicado histórico parcial (uno de los dos renombrado) sí falla: la excepción es por par completo

**Riesgo.** Añadir `checksum` a public.migrations toca una tabla que migrate.ts crea fuera del sistema de migraciones. Por eso se hace con ADD COLUMN IF NOT EXISTS en el bootstrap y no con un archivo .sql: un archivo de migración que modifica la tabla de migraciones es una trampa circular.

##### `E0.2-l` CI con Postgres que corre migraciones, contrato y suite · **S**

Hoy no existe `.github/` (verificado): sin él, el contrato es un script que alguien puede olvidar. Crear `.github/workflows/ci.yml` con un solo job sobre ubuntu-latest y `services.postgres: postgres:15-alpine` (usuario postgres, contraseña postgres, base ci, healthcheck pg_isready).

Pasos, en orden:
1. `actions/checkout` y `actions/setup-node` con node 20 y cache de npm.
2. `npm ci`.
3. `npm run typecheck`.
4. `npm run migrate` con `MIGRATION_DATABASE_URL` apuntando al servicio — esto ya ejercita la guarda de numeración y la reaplicación de rls-policies.sql.
5. `npm run contract:sql` con `CONTRACT_DATABASE_URL` — falla el job ante cualquier hallazgo.
6. `npm test -- --run` con `CI=true`, de modo que tests/database/sql-contract.spec.ts falle si no encuentra base en vez de saltarse.
7. `bash scripts/verify-isolation.sh` contra la base recién migrada (el atlas lo señala como no ejecutado por nadie; el entorno ya está montado en este job, así que cuesta un paso).

El paso 5 y el 6 se solapan a propósito: el runner da un reporte legible en el log aunque la suite de vitest se caiga por otro motivo.

**Archivos**

- `.github/workflows/ci.yml` — crear: job con servicio postgres:15-alpine y los siete pasos
- `package.json` — modificar: verificar que "test" acepte --run y que exista "contract:sql"

**Criterios de aceptación**

- Dado un push a cualquier rama, el job corre y termina verde con el repo reparado
- Dado un PR que introduce `SELECT nombre_inexistente FROM accounts`, el job falla en el paso 5 con el mensaje [contrato-sql] que nombra archivo, línea y símbolo
- Dado un PR que agrega 033_a.sql y 033_b.sql, el job falla en el paso 4 antes de aplicar migraciones
- Dado un PR que rompe el aislamiento por tenant, el job falla en el paso 7

**Riesgo.** Que la primera corrida de CI destape fallos de otros paquetes (posting, RLS) y bloquee todo. Mitigación: correr el workflow una vez en modo informativo (continue-on-error en los pasos 6 y 7) antes de hacerlo obligatorio, y quitar la bandera en cuanto la base esté verde.

#### Cómo se sabe que cerró

- `npm run contract:sql` sale con código 0 e imprime «N literales verificados · 0 hallazgos · V no verificables» con V ≤ el valor de src/database/contract/baseline.json
- `npm run typecheck` sale 0 y `npm test -- --run` queda verde con al menos las 1155 pruebas actuales más las nuevas de contrato, extractor, normalizador, numeración, embargos y beneficios
- `grep -rn "FROM entities\|JOIN entities\|futa_employer\|plan_name\|annual_limit\|election_value" src` devuelve cero resultados
- Contra una base recién migrada: `SELECT count(*) FROM information_schema.columns WHERE table_name='tax_form_filings' AND column_name IN ('submission_id','submitted_at','provider')` devuelve 3, y `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='pay_runs_run_type_check'` incluye 'finiquito'
- Dado un tenant nuevo con un trabajador estadounidense y una orden de embargo activa, cuando corre el cálculo del recibo, entonces calculateGarnishments devuelve importes y ya no lanza 42703: hoy ese camino es inejecutable
- Con dos archivos 033_*.sql en el directorio, `npm run migrate` sale con código 1, nombra el conflicto, sugiere 034 y `SELECT count(*) FROM public.migrations` no cambió
- Editar un archivo de migración ya aplicado hace que `npm run migrate` aborte con MIGRATION_CHECKSUM_MISMATCH nombrando el archivo
- `ls src/database/migrations | cut -c1-3 | sort | uniq -d` devuelve exactamente 012, 014, 015 y 018
- El workflow de CI corre en verde de punta a punta: typecheck, migrate, contract:sql, npm test con CI=true y verify-isolation.sh
- Prueba de veneno: introducir a propósito `SELECT columna_que_no_existe FROM accounts` en cualquier archivo de src/ hace fallar `npm run contract:sql` con un mensaje que trae archivo, línea y símbolo contenedor


### E0.3 · Bitácora de auditoría independiente del transporte: emitir desde el motor, proteger la tabla
**Objetivo.** Que toda escritura consecuente al mayor y toda aprobación dejen una fila de audit_log emitida por el dominio dentro de la misma transacción que el hecho auditado —CLI, agente, REST y GraphQL por igual—, con actor, origen y motivo explícitos. Y que audit_log sea físicamente append-only, como pretende serlo fiscal_credential_access_log (que hoy no lo es).

**Por qué aquí.** La CLI es la interfaz principal del producto y hoy no deja rastro alguno: audit_log solo se escribe desde src/api/rest/middleware/audit.ts (una fila por mutación HTTP exitosa) y desde softClosePeriod. Todo lo demás —posteo, reversa, anulación, hard close, aprobación de borradores y ejecución de operaciones externas— es invisible. Va en la etapa 0 porque es barato (el punto de emisión ya está centralizado: posting.ts es el único escritor del mayor), porque no depende de nada, y porque los paquetes posteriores que amplían superficie (reversar/anular por CLI, aprobaciones automáticas por política, descarga SAT desatendida) generan escrituras que nacerían sin rastro si se hacen antes. Además arregla dos defectos verificados que corrompen la trazabilidad existente: el middleware pisa el x-request-id que fijó correlationIdMiddleware, y src/database/rls-policies.sql vuelve a otorgar UPDATE/DELETE sobre fiscal_credential_access_log a mnemosine_app en cada migración, anulando el REVOKE de la migración 014.

**Depende de:** `E0.0`, `E0.2` · **Migraciones:** `031-034` · **10 tareas · 5.1 sem-persona**

**Precondiciones:**

- Base de datos con las 30 migraciones aplicadas y `npm run migrate` operativo (el runner reaplica src/database/rls-policies.sql tras cada migración: migrate.ts:54).
- Suite verde antes de empezar: `npm test` y `npx tsc --noEmit`.
- Decidida la pregunta D1 (fail-closed) antes de tocar posting.ts, y la D5 (retención) antes de escribir la migración 031.

#### Decisiones a resolver

**D1 · ¿Un fallo al escribir la auditoría debe abortar la operación auditada (fail-closed) o solo alertar?**

Al emitir desde el motor con el client de la transacción, un error del INSERT propaga y hace ROLLBACK del asiento. Hoy el middleware hace lo contrario: `.catch(err => console.error(...))`, de modo que un asiento puede quedar posteado sin rastro y nadie se entera. La decisión define el carácter del sistema: si la trazabilidad es una garantía o un mejor esfuerzo.

- Fail-closed en el motor (posting, cierre, aprobaciones) y best-effort en el middleware residual de transporte
- Fail-closed en todo, incluido el transporte (una auditoría que no se puede escribir devuelve 500)
- Best-effort en todo, con alerta y contador de métricas

_Recomendación:_ Fail-closed en el motor, best-effort en el transporte. El hecho contable y su registro nacen de la misma transacción: si no se puede escribir el registro, el hecho no debe existir. En el transporte el hecho YA ocurrió cuando el middleware se entera (se ejecuta en res.json), así que abortar ahí no revierte nada y solo convertiría un problema de bitácora en un error para el usuario.

_Bloquea:_ E0.3-c (comportamiento de recordAudit ante error) y E0.3-d (si es best-effort, el motor tendría que envolver cada recordAudit en try/catch, lo que cambia la especificación)

**D2 · audit_log.user_id es UUID NOT NULL. ¿Qué se escribe cuando el actor no es una persona (cron, arranque, reintento de outbox)?**

Todos los caminos actuales que escriben al mayor exigen un createdBy que es un users.id real (resolveReviewer lo garantiza en la CLI). Pero llegan actores no humanos: el runtime de trabajos en segundo plano, la descarga SAT desatendida y las políticas de auto-aprobación. fiscal_credential_access_log resolvió lo mismo con un `actor VARCHAR(255)` que admite 'scheduler'.

- Hacer user_id NULLABLE con CHECK (actor_type <> 'human' OR user_id IS NOT NULL), y usar actor_label para el actor no humano
- Crear un usuario centinela por tenant ('system@mnemosine') y atribuirle todo lo automático
- Dejar NOT NULL y exigir que todo camino automático resuelva un humano responsable (el que configuró el cron o la política)

_Recomendación:_ La primera: user_id nullable con el CHECK. Un usuario centinela contamina la tabla users y hace que informes de segregación de funciones cuenten a una ficción como persona; exigir siempre un humano obligaría a inventar atribuciones falsas en el cron. actor_type + actor_label dicen la verdad, y para el caso de las políticas de aprobación conservamos lo mejor de la tercera opción: user_id sigue siendo el humano que OTORGÓ la política (draft-service.ts ya lo resuelve así, líneas 527-530).

_Bloquea:_ E0.3-b (el ALTER COLUMN y el CHECK) y E0.3-c (validación en recordAudit)

**D3 · ¿Se deja de concatenar la razón de anulación a journal_entries.notes?**

voidJournalEntryInTx hace hoy `notes = COALESCE(notes,'') || '\nVoided: <razón>'` en ambas ramas (posting.ts:470 y 475). Con la fila de auditoría, esa razón queda con fecha, usuario y origen. Mantener las dos escrituras significa que el mismo hecho vive en dos sitios y que una fila del mayor sigue mutando después de posteada.

- Retirar la concatenación: la razón vive solo en audit_log.reason (y la CLI/REST la muestran leyendo la bitácora)
- Conservar ambas: notes para lectura inmediata en pantallas que ya lo muestran, audit_log como registro formal
- Conservar notes pero congelarlo: escribirlo una sola vez, sin append acumulativo

_Recomendación:_ La segunda por ahora, la primera como objetivo. Retirar la concatenación en este paquete obligaría a tocar todas las vistas que hoy leen notes y a migrar el histórico; no es el trabajo de un paquete de auditoría. Registrar la deuda con un comentario en posting.ts que apunte a la fila de audit_log como registro de verdad, y retirar la concatenación cuando el lector de E0.3-i esté integrado en las pantallas de asiento.

_Bloquea:_ Nada duro: E0.3-d se implementa igual en los tres casos. Solo cambia si el UPDATE de notes se conserva o no.

**D4 · ¿Se unifica fiscal_credential_access_log dentro de audit_log?**

El punto (c) del encargo lo pregunta explícitamente. El log de credenciales tiene columnas propias (purpose, unattended, denied_reason, source_host), es de alta frecuencia (un acceso por descifrado, con límite diario de 24 por credencial) y ya lo consumen withCredential para el rate limit (service.ts:241-245) y policy-preview.ts:148.

- Mantener separadas y espejar en audit_log solo denegaciones, errores y eventos administrativos (alta/revocación)
- Fusionar todo en audit_log con action='access' y las columnas específicas dentro de context JSONB
- Mantener separadas sin espejo alguno, y unificar solo en la capa de lectura

_Recomendación:_ La primera. Fusionar rompería la consulta de rate limit (que cuenta filas de éxito en 24 h) y mezclaría dos frecuencias muy distintas en una sola tabla. El espejo selectivo da a quien lee la bitácora general la señal que importa —accesos denegados y cambios en la custodia— sin duplicar el tráfico normal, y el lector de E0.3-i ofrece la vista unificada, que es lo que el auditor realmente pide.

_Bloquea:_ E0.3-h (qué se espeja) y E0.3-i (si el lector combina fuentes o consulta una sola tabla)

**D5 · Retención y crecimiento de audit_log**

La tabla no se purga ni se particiona (004_partitioning_and_views.sql solo particiona journal_entry_lines). Con la cobertura nueva pasa de ~1 fila por mutación HTTP a 2-4 filas por asiento, y siendo append-only con trigger, ni siquiera se puede borrar sin desactivarlo. El CFF mexicano exige conservar la contabilidad 5 años (art. 30), con supuestos que llegan a más.

- Retención indefinida, sin purga; particionar por mes cuando el volumen lo exija
- Particionar por RANGE de timestamp desde ya (mensual), con creación automática de particiones, y desprender particiones a almacenamiento frío tras N años
- Retención de 10 años con un trabajo de purga que desactiva temporalmente el trigger

_Recomendación:_ La primera para este paquete, con los índices de E0.3-b dimensionados para consultas por tenant y por entidad. Particionar ahora añade una máquina (creación de particiones, DEFAULT partition, interacción con RLS que ya obliga a `NOT c.relispartition` en rls-policies.sql) sin datos que la justifiquen. La tercera es la peor: cualquier mecanismo capaz de borrar filas destruye la propiedad que este paquete construye.

_Bloquea:_ E0.3-b (si se elige particionar, la migración 031 cambia por completo: tabla nueva particionada y copia del histórico)

**D6 · ¿Se capturan old_values, y con qué alcance?**

audit_log.old_values existe desde 001 y nunca se ha escrito. En el motor es barato y exacto (el estado previo ya está en memoria bajo FOR UPDATE: status, reversed_by_entry_id). En el transporte requiere un SELECT extra por mutación antes de ejecutarla, es decir un cambio en cada handler REST.

- Solo en el motor y en las aprobaciones, con el estado previo ya leído; en el transporte queda NULL
- En todos lados, añadiendo un SELECT previo genérico en el middleware por tabla/id
- En ninguno: la reconstrucción se hace encadenando filas de la bitácora

_Recomendación:_ La primera. En el motor old_values es gratis y es lo que responde la pregunta que un auditor hace de verdad ('¿en qué estado estaba antes de anularse?'). Un SELECT genérico en el middleware exige mapear ruta→tabla, duplica carga en cada mutación y devolvería filas ya sin RLS aplicada correctamente si el handler opera en otra conexión.

_Bloquea:_ E0.3-d, E0.3-e y E0.3-g (qué se pasa en oldValues)

#### Tareas

##### `E0.3-a` Contexto de actor propagado por AsyncLocalStorage (independiente del transporte) · **S**

Crear src/services/audit/actor-context.ts, espejo exacto del patrón ya establecido en src/database/connection.ts (withTenant/enterTenant/currentTenant, líneas 96-121) y en src/utils/logger.ts (logContext).

Tipos exportados:
  export type AuditOrigin = 'cli' | 'rest' | 'graphql' | 'agente' | 'sistema';
  export type ActorType  = 'human' | 'agent' | 'policy' | 'system';
  export interface ActorContext {
    origin: AuditOrigin;
    actorType: ActorType;
    userId?: string;      // users.id (UUID). Obligatorio si actorType==='human'
    actorLabel?: string;  // correo, 'scheduler', 'policy:<uuid>' — legible por humanos
    requestId?: string;   // x-request-id en REST/GraphQL; un uuid por corrida en CLI
    aiSessionId?: string; // ai_sessions.id cuando el hecho nace de una sesión del agente
    ipAddress?: string;
    userAgent?: string;
    extra?: Record<string, unknown>; // draft_id, policy_id, ai_model, provider...
  }

API:
  const store = new AsyncLocalStorage<ActorContext>();
  export function withActor<T>(ctx: ActorContext, fn: () => Promise<T>): Promise<T>  // servidor: se sale del ámbito
  export function enterActor(ctx: ActorContext): void                                 // CLI: store.enterWith, un proceso = un actor (mismo razonamiento documentado en connection.ts:106-116)
  export function mergeActor(patch: Partial<ActorContext>): void                      // enriquece el store actual in situ; no-op si no hay contexto
  export function currentActor(): ActorContext | undefined

mergeActor existe porque la identidad se conoce en dos momentos: el origen se sabe al entrar (CLI/REST), pero el userId (resolveReviewer) y el aiSessionId (createSession) se resuelven después.

No importar nada de express ni de pg en este archivo: el motor contable lo consume y no debe arrastrar el transporte.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/audit/actor-context.ts` — crear: ActorContext, withActor, enterActor, mergeActor, currentActor sobre AsyncLocalStorage

**Criterios de aceptación**

- Dado dos llamadas concurrentes a withActor con contextos distintos, cuando ambas leen currentActor() dentro de sus callbacks, entonces cada una ve el suyo y ninguna ve el de la otra.
- Dado un proceso que llamó enterActor({origin:'cli',...}), cuando cualquier módulo llama currentActor() después (aunque sea varios await más tarde), entonces obtiene ese contexto.
- Dado mergeActor({userId:'u1'}) sin contexto activo, entonces no lanza y currentActor() sigue devolviendo undefined.
- Dado `grep -n "express\|from 'pg'" src/services/audit/actor-context.ts`, entonces devuelve cero líneas.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/audit/actor-context.spec.ts` — aislamiento entre dos withActor concurrentes; enterActor persiste a través de awaits; mergeActor sin contexto no lanza

##### `E0.3-b` Migración 031: forma del registro, append-only real y corrección del GRANT que lo anulaba · **M**

Crear src/database/migrations/031_audit_coverage.sql. La tabla audit_log (001_core_schema.sql:454-475) se conserva; se extiende.

(1) Acciones. El CHECK actual solo admite create|update|delete|post|void|approve|close|reopen. Reemplazarlo:
  ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check;
  ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (action IN (
    'create','update','delete','post','void','reverse','approve','reject','execute','close','reopen','access'));

(2) request_id es UUID y correlationIdMiddleware honra un x-request-id ENTRANTE arbitrario (correlation.ts:21-22): un gateway que mande 'req-abc' hace fallar el INSERT con 22P02 y —bajo fail-closed— tiraría el posteo. Cambiar a texto:
  ALTER TABLE audit_log ALTER COLUMN request_id TYPE TEXT USING request_id::text;

(3) Actor y origen (columnas nuevas, con DEFAULT para que las filas históricas queden marcadas y sin FKs: la bitácora debe sobrevivir al borrado de sus referentes):
  ALTER TABLE audit_log
    ADD COLUMN origin VARCHAR(20) NOT NULL DEFAULT 'rest',
    ADD COLUMN actor_type VARCHAR(20) NOT NULL DEFAULT 'human',
    ADD COLUMN actor_label VARCHAR(255),
    ADD COLUMN legal_entity_id UUID,
    ADD COLUMN ai_session_id UUID,
    ADD COLUMN context JSONB;
  ALTER TABLE audit_log ADD CONSTRAINT audit_log_origin_check CHECK (origin IN ('cli','rest','graphql','agente','sistema'));
  ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('human','agent','policy','system'));
  (Los DEFAULT 'rest'/'human' describen con verdad lo único que hay escrito hoy; una vez migrado, retirar el DEFAULT: ALTER COLUMN origin DROP DEFAULT y ALTER COLUMN actor_type DROP DEFAULT, para que quien inserte deba declarar el origen.)

(4) user_id: ver decisión D2. Si se acepta la recomendación:
  ALTER TABLE audit_log ALTER COLUMN user_id DROP NOT NULL;
  ALTER TABLE audit_log ADD CONSTRAINT audit_log_human_has_user CHECK (actor_type <> 'human' OR user_id IS NOT NULL);

(5) Índices para las consultas que la tarea E0.3-h necesita:
  CREATE INDEX idx_audit_log_tenant_ts ON audit_log(tenant_id, timestamp DESC);
  CREATE INDEX idx_audit_log_legal_entity_ts ON audit_log(legal_entity_id, timestamp DESC);
  CREATE INDEX idx_audit_log_origin_ts ON audit_log(origin, timestamp DESC);
  CREATE INDEX idx_audit_log_request ON audit_log(request_id);

(6) Append-only por trigger (los triggers disparan también para el dueño de la tabla; solo TRUNCATE los esquiva, de ahí el REVOKE de TRUNCATE):
  CREATE OR REPLACE FUNCTION public.audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN RAISE EXCEPTION 'La bitácora es append-only: % rechazado sobre %', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501'; END $fn$;
  DROP TRIGGER IF EXISTS trg_audit_log_append_only ON audit_log;
  CREATE TRIGGER trg_audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_append_only();
  DROP TRIGGER IF EXISTS trg_fcal_append_only ON fiscal_credential_access_log;
  CREATE TRIGGER trg_fcal_append_only BEFORE UPDATE OR DELETE ON fiscal_credential_access_log FOR EACH ROW EXECUTE FUNCTION public.audit_append_only();

(7) Privilegios:
  REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, fiscal_credential_access_log FROM PUBLIC;
  DO $g$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnemosine_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, fiscal_credential_access_log FROM mnemosine_app;
    GRANT SELECT, INSERT ON audit_log, fiscal_credential_access_log TO mnemosine_app;
  END IF; END $g$;

(8) LO IMPRESCINDIBLE — parchear src/database/rls-policies.sql. Su bucle $grants$ (líneas 80-104) ejecuta hoy `GRANT SELECT, INSERT, UPDATE, DELETE` sobre TODA tabla del esquema propiedad del rol actual, incluida fiscal_credential_access_log: eso deshace en cada `npm run migrate` el REVOKE de 014_fiscal_credentials.sql:91, y desharía también el del punto (7). Declarar en el DO:
  append_only text[] := ARRAY['audit_log','fiscal_credential_access_log'];
y dentro del LOOP, para relkind distinto de 'S':
  IF r.relname = ANY(append_only) THEN
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO mnemosine_app', r.relname);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM mnemosine_app', r.relname);
  ELSE
    <el GRANT actual>
  END IF;
Añadir el comentario que explique por qué esas dos tablas son distintas, en el estilo del resto del archivo.

audit_log ya queda cubierta por la política tenant_isolation del bucle principal (tiene tenant_id NOT NULL, predicado `tenant_id = public.app_current_tenant()`), así que no hace falta política nueva.

**Archivos**

- `/Users/victor/projects/Accounting/src/database/migrations/031_audit_coverage.sql` — crear: CHECK de acciones ampliado, request_id a TEXT, columnas origin/actor_type/actor_label/legal_entity_id/ai_session_id/context, índices, función y triggers audit_append_only, REVOKE/GRANT
- `/Users/victor/projects/Accounting/src/database/rls-policies.sql` — modificar el bucle $grants$ (líneas 80-104): lista append_only con audit_log y fiscal_credential_access_log, a las que solo se otorga SELECT, INSERT y se les revoca UPDATE/DELETE/TRUNCATE

**Migración**

```sql
src/database/migrations/031_audit_coverage.sql — el SQL completo está en la especificación de esta tarea (puntos 1 a 7); el punto 8 no es migración sino parche al archivo canónico de políticas.
```

**Criterios de aceptación**

- Dado un `npm run migrate` sobre una base al día, cuando termina, entonces `SELECT has_table_privilege('mnemosine_app','audit_log','DELETE')` devuelve false y lo mismo para 'UPDATE' y para fiscal_credential_access_log.
- Dado que la migración corrió, cuando se ejecuta `UPDATE audit_log SET reason='x'` como cualquier rol no superusuario, entonces falla con SQLSTATE 42501 y el mensaje 'La bitácora es append-only'.
- Dado que la migración corrió, cuando se vuelve a ejecutar `npm run migrate` (que reaplica rls-policies.sql), entonces los privilegios siguen siendo solo SELECT/INSERT — la regresión que motiva esta tarea no reaparece.
- Dado un INSERT con action='reverse' y origin='cli', entonces es aceptado; dado action='frobnicate' u origin='desktop', entonces es rechazado por el CHECK.
- Dado un INSERT con actor_type='human' y user_id NULL, entonces falla por audit_log_human_has_user.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/database/append-only.spec.ts` — comprobación estática al estilo de tests/accounting/period-close-accounts.spec.ts: rls-policies.sql contiene la lista append_only y no otorga UPDATE/DELETE sobre esas dos tablas; 031 crea los dos triggers y revoca TRUNCATE

**Riesgo.** El trigger append-only rompería cualquier código que hoy actualice audit_log; verificado por grep que no existe ninguno (los únicos INSERT son audit.ts:18 y period-close.ts:149). Riesgo real inverso: si alguien vuelve a añadir tablas append-only sin registrarlas en la lista de rls-policies.sql, la protección se pierde en silencio — de ahí el test estático.

##### `E0.3-c` Emisor único: recordAudit, en la transacción del hecho auditado · **M**

Crear src/services/audit/audit-log.ts. Es el ÚNICO lugar del repositorio que escribe audit_log a partir de esta tarea.

  type Queryable = Pick<pg.PoolClient, 'query'>;   // mismo alias que src/ai/session-store.ts:52
  export type AuditAction = 'create'|'update'|'delete'|'post'|'void'|'reverse'|'approve'|'reject'|'execute'|'close'|'reopen'|'access';
  export interface AuditInput {
    action: AuditAction;
    entityType: string;        // 'journal_entry' | 'fiscal_period' | 'ai_draft' | 'ai_external_op' | 'fiscal_credential' | ...
    entityId: string;          // UUID de la fila afectada. NUNCA se inventa
    tenantId: string;
    legalEntityId?: string;
    oldValues?: Record<string, unknown> | null;
    newValues?: Record<string, unknown> | null;
    reason?: string | null;
    approverId?: string | null;
    actor?: Partial<ActorContext>;  // completa/pisa el ambiente
  }
  export async function recordAudit(client: Queryable, input: AuditInput): Promise<void>
  export async function recordAuditStandalone(input: AuditInput): Promise<void>  // usa query() de connection.ts; solo para llamadores que demostrablemente no tienen transacción (executeExternalOp)

Comportamiento de recordAudit:
 1. actor = { ...currentActor(), ...input.actor }. Si no hay ninguno de los dos, usar { origin:'sistema', actorType:'system', actorLabel:`unresolved:${process.argv[1] ?? 'unknown'}` } y emitir logger.warn('audit_actor_unresolved', { entity_type, action }). Nunca inventar un UUID de usuario ni de entidad.
 2. Si input.tenantId es falsy: lanzar AccountingError('AUDIT_TENANT_UNRESOLVED', `No se puede auditar ${input.action} sobre ${input.entityType} sin tenant`). Un hecho que no se puede atribuir no debe commitear (ver D1).
 3. Sanear valores: aplicar redactValues() (misma función que usa el middleware, exportada desde este módulo) sobre oldValues/newValues, y truncar el JSON serializado a 8 KiB por columna, sustituyendo el exceso por {"_truncated": true, "_bytes": n}.
 4. INSERT parametrizado, sin ON CONFLICT, sin catch:
    INSERT INTO audit_log (id, user_id, tenant_id, legal_entity_id, action, entity_type, entity_id,
      old_values, new_values, ip_address, user_agent, request_id, reason, approver_id,
      origin, actor_type, actor_label, ai_session_id, context)
    VALUES ($1,…,$19)
    con id = uuidv4() y context = JSON.stringify(actor.extra ?? null).

redactValues(v: unknown): unknown — recorre recursivamente objetos y arreglos; toda clave que case /pass(word)?|secret|token|api[_-]?key|credential|private[_-]?key|clave|contrase|csd|efirma|pfx|\.cer$|\.key$|authorization|cookie/i se sustituye por '[REDACTED]'; cadenas de más de 2 KiB se truncan. Exportada porque la usa también E0.3-f.

No hay reintento ni cola: el registro vive o muere con la transacción del hecho. Ese es justamente el punto de moverlo al motor.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/audit/audit-log.ts` — crear: AuditAction, AuditInput, recordAudit, recordAuditStandalone, redactValues
- `/Users/victor/projects/Accounting/src/services/audit/index.ts` — crear: reexporta actor-context.ts y audit-log.ts (mismo patrón que src/services/accounting/index.ts)

**Criterios de aceptación**

- Dado un contexto de actor {origin:'cli', actorType:'human', userId:'u1', actorLabel:'ana@x.mx'} y recordAudit(client, {action:'post', entityType:'journal_entry', entityId:'je1', tenantId:'t1'}), entonces el INSERT recibe 19 parámetros con origin='cli', actor_type='human', user_id='u1', actor_label='ana@x.mx' y entity_id='je1'.
- Dado newValues={ password:'secreta', total:'100.00' }, entonces la columna new_values contiene {"password":"[REDACTED]","total":"100.00"}.
- Dado tenantId undefined, cuando se llama recordAudit, entonces lanza AccountingError con code 'AUDIT_TENANT_UNRESOLVED' y NO ejecuta ningún INSERT.
- Dado que no hay contexto de actor, entonces la fila se escribe con origin='sistema', actor_type='system', user_id NULL y se registra un logger.warn('audit_actor_unresolved').
- Dado un newValues cuyo JSON supera 8 KiB, entonces la columna almacena el marcador de truncado y el INSERT no falla.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/audit/audit-log.spec.ts` — forma y orden de los 19 parámetros; herencia del actor ambiente; sobreescritura por input.actor; redacción de claves sensibles anidadas; truncado a 8 KiB; AUDIT_TENANT_UNRESOLVED sin INSERT

**Riesgo.** redactValues sobre payloads grandes en el camino caliente del posteo. Mitigación: los newValues del motor son resúmenes (totales y conteo de líneas), nunca el arreglo de líneas completo; el recorrido profundo solo aparece en el camino REST residual.

##### `E0.3-d` Auditar el mayor desde posting.ts: creación, posteo, reversa y anulación · **M**

Modificar src/services/accounting/posting.ts. Todos los registros se escriben con el MISMO client de la transacción en curso (el propio o el de options.client), de modo que si el asiento no commitea, su fila de auditoría tampoco existe.

(1) createJournalEntry, dentro de run(client), después de insertar cabecera y líneas y ANTES del bloque autoPost:
    const tenantId = await resolveTenantId(client, entityId);   // ya existe en posting.ts:301; es function declaration, está izada
    if (!tenantId) throw new AccountingError('AUDIT_TENANT_UNRESOLVED', 'No se pudo resolver el tenant de la entidad para auditar el asiento');
    await recordAudit(client, {
      action: 'create', entityType: 'journal_entry', entityId: entryId,
      tenantId, legalEntityId: entityId,
      newValues: { entry_number: entryNumber, entry_type: entryType, entry_date: entryDate.toISOString().slice(0,10),
                   fiscal_period_id: fiscalPeriodId, description, source_type: options?.sourceType ?? null,
                   source_id: options?.sourceId ?? null, reference: options?.reference ?? null,
                   line_count: lines.length, total_debits, total_credits,
                   is_reversal: options?.isReversal ?? false, reverses_entry_id: options?.reversesEntryId ?? null },
      actor: { userId: createdBy },
    });
  total_debits/total_credits se calculan con Decimal sumando las líneas de entrada (mismo criterio de 4 decimales que usa el INSERT). NO se copian las líneas completas.
  Reemplazar la resolución de tenant que hoy vive dentro del bloque autoPost (líneas 199-206) por esta única resolución; attest.info sigue poblándose igual.

(2) Al final del bloque autoPost, tras actualizar account_balances:
    await recordAudit(client, { action:'post', entityType:'journal_entry', entityId: entryId, tenantId, legalEntityId: entityId,
      oldValues: { status: 'draft' }, newValues: { status: 'posted', posted_by: createdBy, posted_date: now.toISOString() },
      actor: { userId: createdBy } });

(3) postJournalEntry: dentro de su withTransaction, tras el UPDATE a 'posted' y las actualizaciones de saldos:
    recordAudit con action:'post', oldValues:{ status: entry.status }, newValues:{ status:'posted', posted_by:userId, posted_date: now.toISOString() }, actor:{ userId }.
    tenantId = await resolveTenantId(client, entry.entity_id).

(4) reverseWithinTransaction: después del UPDATE que fija reversed_by_entry_id (línea 374):
    recordAudit con action:'reverse', entityId: entry.id (el asiento ORIGINAL), oldValues:{ reversed_by_entry_id: null, status: entry.status },
    newValues:{ reversed_by_entry_id: reversal.id, reversal_entry_number: reversal.entry_number }, reason: description, actor:{ userId }.
    (El espejo genera además sus propias filas 'create' y 'post' vía createJournalEntry: la reversa queda con tres filas que cuentan la historia completa.)

(5) voidJournalEntryInTx: en AMBAS ramas, tras el UPDATE correspondiente:
    recordAudit con action:'void', entityId, oldValues:{ status: entry.status },
    newValues:{ status: updatedEntry.status, reversal_entry_id: reversal?.id ?? null },
    reason,  // la columna audit_log.reason existe desde 001 y nunca se ha usado
    actor:{ userId }.
    Sobre la concatenación a notes, ver decisión D3.

Invariante a documentar en el encabezado del módulo (donde ya dice que aquí viven todas las escrituras físicas): «toda escritura al mayor emite su fila de auditoría con el mismo client; quien pase options.client hereda la transacción y, por tanto, la auditoría».

**Archivos**

- `/Users/victor/projects/Accounting/src/services/accounting/posting.ts` — modificar: importar recordAudit; resolver tenantId una sola vez en createJournalEntry; emitir create, post, reverse y void; ampliar el comentario de cabecera con la invariante de auditoría

**Criterios de aceptación**

- Dado un tenant con entidad y periodo abierto, cuando se llama createJournalEntry(..., {autoPost:true}), entonces audit_log tiene exactamente dos filas nuevas para ese entity_id: action='create' y action='post', ambas con origin y actor_type del contexto activo.
- Dado un asiento posteado, cuando se llama voidJournalEntry(id, userId, 'error de captura'), entonces existe una fila action='void' cuyo campo reason es exactamente 'error de captura' y cuyo new_values.reversal_entry_id apunta al espejo.
- Dado un asiento posteado, cuando se le aplica reverseJournalEntry, entonces hay una fila action='reverse' sobre el asiento ORIGINAL y dos filas ('create','post') sobre el espejo.
- Dado que la transacción de posteo aborta (por ejemplo VALIDATION_FAILED), entonces audit_log no contiene ninguna fila de ese entity_id.
- Dado postInvoiceEntry ejecutándose dentro de la transacción del llamador (options.client), entonces las filas de auditoría del asiento se escriben con ese mismo client y commitean junto con la factura.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/accounting/posting-audit.spec.ts` — con client mockeado: createJournalEntry con autoPost emite create+post; sin autoPost emite solo create; voidJournalEntryInTx emite void con reason en la columna reason; reverseWithinTransaction emite reverse sobre el id original; todas las llamadas a recordAudit reciben el MISMO objeto client que el resto de la transacción

**Riesgo.** Una excepción de recordAudit ahora tira el posteo (fail-closed, D1). Es el comportamiento deseado, pero convierte cualquier defecto de la migración 031 en una caída del motor: por eso 031 va antes y la métrica de cierre incluye un posteo real contra base con migraciones aplicadas.

##### `E0.3-e` Cierre de periodo: auditar el hard close y sacar el soft close del INSERT crudo · **S**

Modificar src/services/accounting/period-close.ts.

(1) softClosePeriod (líneas 120-155) hoy hace el UPDATE con query() y después un INSERT a audit_log en otra conexión (líneas 148-152), con un COALESCE que resuelve el tenant por subconsulta: si el proceso muere entre ambos, el periodo queda cerrado sin rastro. Reescribir la función completa dentro de withTransaction(async (client) => { ... }):
   - el UPDATE ... RETURNING * pasa a client.query;
   - si rowCount === 0 se sigue lanzando AccountingError('PERIOD_NOT_OPEN', ...);
   - const tenantId = currentTenant() ?? (await client.query('SELECT tenant_id FROM legal_entities WHERE id = $1',[entityId])).rows[0]?.tenant_id;
   - await recordAudit(client, { action:'close', entityType:'fiscal_period', entityId: periodId, tenantId, legalEntityId: entityId,
       oldValues:{ status:'open' },
       newValues:{ status:'soft_close', checklist: status.checklist.map(c => ({ item: c.item, is_complete: c.is_complete })), warnings: status.warnings },
       actor:{ userId } });
   Eliminar el INSERT crudo.

(2) hardClosePeriod (líneas 157-238) no audita nada. Dentro de su withTransaction ya existente, después del UPDATE a 'hard_close' (línea 208) y antes del SELECT final:
   await recordAudit(client, { action:'close', entityType:'fiscal_period', entityId: periodId, tenantId, legalEntityId: entityId,
     oldValues:{ status:'soft_close' },
     newValues:{ status:'hard_close', year_end: isYearEnd.rows[0]?.is_last === true, closing_entry_ids: closingEntryIds, carried_accounts: carried },
     actor:{ userId } });
   donde `carried` es el valor devuelto por carryForwardBalances (hoy se descarta: capturarlo en una const). tenantId se resuelve como en (1).

(3) Cuando exista la reapertura de periodo (paquete de superficie CLI), su punto de emisión es el mismo: action:'reopen', entityType:'fiscal_period'. Dejar el comentario que lo indique junto a hardClosePeriod para que no se resuelva en otro lado.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/accounting/period-close.ts` — modificar: softClosePeriod pasa a withTransaction y usa recordAudit (se elimina el INSERT de las líneas 148-152); hardClosePeriod emite action='close' con los ids de asientos de cierre; capturar el retorno de carryForwardBalances

**Criterios de aceptación**

- Dado un periodo en soft_close, cuando corre `mnemosine close --hard`, entonces audit_log tiene una fila action='close', entity_type='fiscal_period', new_values.status='hard_close' y new_values.closing_entry_ids con los asientos generados.
- Dado un periodo abierto que se cierra en suave, entonces existe exactamente una fila action='close' con new_values.status='soft_close', y `grep -c "INSERT INTO audit_log" src/services/accounting/period-close.ts` devuelve 0.
- Dado que el hard close falla en carryForwardBalances, entonces no queda fila de auditoría del cierre (misma transacción).
- Dado un cierre anual, entonces las filas de auditoría del cierre y las de los asientos de cierre comparten tenant_id y legal_entity_id y son consultables por `WHERE request_id = <el de la corrida>`.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/accounting/period-close-audit.spec.ts` — con withTransaction y client mockeados: softClose emite close/soft_close en el mismo client que el UPDATE; hardClose emite close/hard_close incluyendo closing_entry_ids; ninguna de las dos usa query() para auditar

**Riesgo.** softClosePeriod cambia de query() a withTransaction: getPeriodCloseStatus se sigue llamando ANTES de abrir la transacción (usa query() y varias consultas), así que no hay cambio de semántica de bloqueo. Verificar que ningún test existente afirme sobre el INSERT crudo.

##### `E0.3-f` Aprobaciones: borradores del agente y operaciones externas · **M**

(1) src/ai/draft-service.ts, approveDraftInternal (líneas 352-434): dentro de la MISMA transacción, después del UPDATE guardado de ai_drafts (línea 416) y antes del return:
    await recordAudit(client, {
      action: 'approve', entityType: 'ai_draft', entityId: draftId,
      tenantId: ctx.tenantId, legalEntityId: ctx.entityId,
      oldValues: { status: 'pending_review' },
      newValues: { status: 'approved', journal_entry_id: entry.id, entry_number: entry.entry_number,
                   reviewed_by: reviewedByAs, approved_content_hash: contentHash },
      approverId: reviewer.userId,
      actor: { actorType: reviewedByAs.startsWith('policy:') ? 'policy' : 'human',
               userId: reviewer.userId, actorLabel: reviewedByAs,
               extra: { draft_id: draftId, notes: notes ?? null } },
    });
  Esto responde el punto (b) del encargo: cuando el asiento nace del agente, el actor es el HUMANO que aprobó (reviewer.userId, resuelto por resolveReviewer contra users) o la POLÍTICA que lo autorizó ('policy:<uuid>', con actor_type='policy'); la sesión del agente viaja en ai_session_id desde el contexto ambiente, y el borrador en context.draft_id. El asiento resultante queda ligado por source_type='ai_draft'/source_id (ya lo hace createJournalEntry) y por las filas 'create'/'post' que E0.3-d emite con el mismo request_id.

(2) src/ai/draft-service.ts, rejectDraft (línea 545): emitir action:'reject', entityType:'ai_draft', reason = la razón de rechazo, approverId = reviewer.userId. Si la función no abre transacción, usar recordAuditStandalone.

(3) src/ai/external-service.ts:
   - executeExternalOp (línea 272) corre sin transacción (query() sueltos). Tras la transición terminal exitosa a 'executed' (línea 368-373, rowCount===1): recordAuditStandalone({ action:'execute', entityType:'ai_external_op', entityId: opId, tenantId: ctx.tenantId, legalEntityId: ctx.entityId, newValues: { provider: op.provider, operation: op.operation, approved_content_hash: contentHash, result_keys: Object.keys(result) }, actor: { actorLabel: reviewedBy, extra: { op_id: opId } } }).
     En la rama de fallo del adaptador (línea 349) emitir igualmente action:'execute' con newValues:{ outcome:'failed' } y reason = message: la escritura externa pudo haber aterrizado y esa es exactamente la fila que un auditor necesita.
     En la rama de rechazo por antigüedad (línea 298) emitir action:'reject' con reason = el mensaje de caducidad y actor_type='system'.
   - rejectExternalOp (línea 206): action:'reject', reason, actor_label = reviewedBy.
   NOTA: no se auditan los payloads de las operaciones externas tal cual — pasan por redactValues, y de result solo se guardan las claves, nunca los valores.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/draft-service.ts` — modificar approveDraftInternal y rejectDraft: emitir approve/reject sobre ai_draft con approver_id y actor_type human|policy
- `/Users/victor/projects/Accounting/src/ai/external-service.ts` — modificar executeExternalOp (éxito, fallo del adaptador y rechazo por antigüedad) y rejectExternalOp: emitir execute/reject sobre ai_external_op

**Criterios de aceptación**

- Dado un borrador pendiente y `mnemosine review` con respuesta 'a', entonces audit_log contiene una fila action='approve', entity_type='ai_draft', approver_id = el UUID del revisor, actor_type='human' y, si la aprobación ocurrió dentro de una sesión de chat, ai_session_id no nulo.
- Dado autoApproveDraftByPolicy, entonces la fila de aprobación tiene actor_type='policy' y actor_label='policy:<uuid>', y user_id sigue siendo el humano que otorgó la política.
- Dado que la aprobación falla por drift de hash, entonces no queda ninguna fila de auditoría (la transacción revierte).
- Dado un `mnemosine outbox` que ejecuta una operación y el adaptador falla, entonces existe una fila action='execute' con new_values.outcome='failed' y reason con el mensaje del proveedor.
- Dado un payload de operación externa con una clave api_key, entonces la fila de auditoría la guarda como '[REDACTED]'.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/ai/draft-approval-audit.spec.ts` — approveDraftInternal emite approve con approver_id y actor_type correcto según reviewedByAs; la emisión usa el client de la transacción; el rechazo emite reject con reason
- `/Users/victor/projects/Accounting/tests/ai/external-ops-audit.spec.ts` — executeExternalOp emite execute en éxito y en fallo del adaptador; rechazo por antigüedad emite reject con actor_type='system'; los payloads pasan por redactValues

**Riesgo.** executeExternalOp no tiene transacción: si el proceso muere entre el UPDATE a 'executed' y el recordAuditStandalone, la operación queda ejecutada sin fila. Es una ventana estrecha y conocida; envolver ese par en withTransaction excede este paquete (implicaría reescribir el reclamo atómico) — dejarlo anotado en el código con un TODO que apunte al paquete de outbox.

##### `E0.3-g` Transporte: dejar de pisar el request-id, dejar de inventar UUIDs, dejar de volcar el cuerpo · **M**

Reescribir src/api/rest/middleware/audit.ts y ajustar el montaje en src/index.ts.

(1) Nuevo export: `export function actorContextMiddleware(origin: AuditOrigin): RequestHandler`. Devuelve un middleware que llama withActor / store.run con { origin, actorType:'human', userId: req.user?.user_id, actorLabel: req.user?.email, requestId: String(req.headers['x-request-id'] ?? ''), ipAddress: req.ip, userAgent: req.get('user-agent') } y ejecuta next() DENTRO del run — exactamente el patrón que correlationIdMiddleware ya usa con logContext (correlation.ts:29-41), que es lo que hace que el contexto fluya por la tubería async de Express.
  Debe montarse DESPUÉS de authenticate (necesita req.user).

(2) auditLogMiddleware: quitar las líneas 7-8 (`const requestId = uuidv4(); req.headers['x-request-id'] = requestId;`). El id de correlación se LEE de req.headers['x-request-id'], que correlationIdMiddleware ya fijó y devolvió en la cabecera de respuesta.

(3) Alcance residual. Como el dominio ya audita journal_entries, fiscal_periods, ai_drafts y ai_external_ops, el middleware pasa a cubrir SOLO lo que ningún servicio audita todavía. Declarar la constante:
    const TRANSPORT_AUDITED = new Set(['accounts','customers','vendors','invoices','bills','bank-accounts','payroll','webhooks','xml']);
  y salir sin escribir si extractEntityType(req.path) no está en el conjunto. Documentar en el archivo que la lista solo puede ENCOGER: cada vez que un dominio adquiere su propio emisor, se retira de aquí (si no, la fila se duplica).

(4) entity_id: si extractEntityId devuelve null, NO insertar; emitir logger.warn('audit_entity_id_unresolved', { path: req.path, method: req.method }). Eliminar el `|| uuidv4()` de la línea 27.

(5) Cuerpo: sustituir `JSON.stringify(req.body)` por `redactValues(req.body)` (exportada por src/services/audit/audit-log.ts) y delegar el INSERT a recordAuditStandalone, para que exista un solo INSERT en el repositorio. old_values queda fuera de este paquete (ver decisión D6).

(6) Fallo de inserción: `logger.error('audit_write_failed', {...})` en vez de console.error, y incrementar un contador en el middleware de métricas si es trivial hacerlo. El fallo NO tumba la respuesta HTTP (el hecho ya ocurrió y su auditoría de dominio, si la tiene, ya commiteó).

(7) src/index.ts: el orden pasa a ser
    app.use(apiPrefix, authenticate);
    app.use(apiPrefix, enrichLogContextMiddleware);
    app.use(apiPrefix, actorContextMiddleware('rest'));
    app.use(apiPrefix, rateLimiter);
    app.use(apiPrefix, auditLogMiddleware);
  y para GraphQL:
    app.use('/graphql', authenticate, actorContextMiddleware('graphql'), expressMiddleware(apolloServer, {...}));
  Con eso, las mutaciones GraphQL de resolvers/index.ts (createJournalEntry, postJournalEntry, voidJournalEntry) heredan origin='graphql' sin tocar un solo resolver.

(8) CLI: crear src/cli/actor.ts con `export function enterCliActor(opts?: { userId?: string; label?: string }): string` que llama enterActor({ origin:'cli', actorType:'human', requestId: uuidv4(), ... }) y devuelve el requestId. Invocarlo justo después de bootstrapTenant/resolveEntity en src/cli/mnemosine.ts y, donde ya se resuelve el revisor, refinar con mergeActor({ userId: reviewer.userId, actorLabel: reviewer.email }) — los sitios verificados son mnemosine.ts:990 (review), close-command.ts:148 (close) y pending-command.ts:199/254. En el comando de chat, tras crear la sesión (mnemosine.ts, variable sessionId), llamar mergeActor({ origin:'agente', actorType:'agent', aiSessionId: sessionId }) para que todo lo que ocurra dentro de la conversación quede marcado como del agente.

**Archivos**

- `/Users/victor/projects/Accounting/src/api/rest/middleware/audit.ts` — modificar: eliminar el pisado del x-request-id (líneas 7-8) y el `|| uuidv4()` del entity_id (línea 27); añadir actorContextMiddleware(origin); acotar a TRANSPORT_AUDITED; redactar el cuerpo; delegar en recordAuditStandalone; logger.error en vez de console.error
- `/Users/victor/projects/Accounting/src/index.ts` — modificar líneas 116-119 y 155-165: montar actorContextMiddleware('rest') tras authenticate y actorContextMiddleware('graphql') en /graphql
- `/Users/victor/projects/Accounting/src/cli/actor.ts` — crear: enterCliActor()
- `/Users/victor/projects/Accounting/src/cli/mnemosine.ts` — modificar: llamar enterCliActor tras resolver la entidad; mergeActor con el revisor en el comando review; mergeActor con origin 'agente' y aiSessionId al crear la sesión de chat
- `/Users/victor/projects/Accounting/src/cli/close-command.ts` — modificar línea 148: mergeActor({ userId: reviewer.userId, actorLabel: reviewer.email }) tras resolveReviewer

**Criterios de aceptación**

- Dado un POST /v1/journal-entries con cabecera x-request-id: 'gw-123', cuando responde 201, entonces la fila de auditoría del asiento (emitida por el motor) tiene request_id='gw-123' y la respuesta lleva X-Request-Id: gw-123 — hoy la fila lleva un UUID distinto del de los logs.
- Dado `grep -n uuidv4 src/api/rest/middleware/audit.ts`, entonces no aparece ninguna llamada para request_id ni para entity_id.
- Dado un POST /v1/admin/integrations con { api_key: 'sk-real' } en el cuerpo, entonces new_values.api_key es '[REDACTED]'.
- Dado un POST cuya ruta no permite deducir el id del recurso, entonces no se inserta fila y queda un logger.warn('audit_entity_id_unresolved').
- Dado un POST /v1/journal-entries, entonces existe UNA sola fila action='create' para ese asiento (el middleware ya no duplica lo que audita el motor).
- Dado `mnemosine close --hard`, entonces la fila de cierre tiene origin='cli' y actor_label con el correo del revisor.
- Dada una mutación GraphQL voidJournalEntry, entonces la fila action='void' tiene origin='graphql'.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/api/middleware/audit.spec.ts` — el middleware conserva el x-request-id entrante; no inserta cuando el entity_id no se deduce; redacta claves sensibles del cuerpo; ignora las rutas fuera de TRANSPORT_AUDITED; actorContextMiddleware deja currentActor() visible dentro del handler
- `/Users/victor/projects/Accounting/tests/cli/actor.spec.ts` — enterCliActor fija origin='cli' y un requestId estable durante toda la corrida; mergeActor con el revisor no lo pierde

**Riesgo.** Al acotar el middleware a TRANSPORT_AUDITED se pierde la fila para rutas que hoy sí la generan (p. ej. /v1/ai/...). Es intencional donde el dominio ya audita; revisar la lista contra `ls src/api/rest/routes/` antes de cerrar la tarea y anotar en el archivo qué recurso audita quién.

##### `E0.3-h` Credenciales fiscales: mantener el log especializado y espejar en audit_log lo que un auditor necesita ver · **S**

Responde al punto (c) del encargo. fiscal_credential_access_log NO se fusiona con audit_log (ver decisión D4): conserva su granularidad por descifrado (purpose, unattended, denied_reason, outcome) y su volumen propio. Lo que se añade es un espejo selectivo, para que quien lea la bitácora general no ignore que hubo acceso a material fiscal.

En src/services/fiscal-credentials/service.ts:
 - En logAccess (línea 279), cuando outcome !== 'success', emitir además recordAuditStandalone({ action:'access', entityType:'fiscal_credential', entityId: row.id, tenantId: row.tenant_id, legalEntityId: row.entity_id, newValues:{ purpose: opts.purpose, unattended: opts.unattended, outcome, denied_reason: extra.deniedReason ?? null }, actor:{ actorLabel: opts.actor, actorType: opts.unattended ? 'system' : 'human', origin: opts.unattended ? 'sistema' : (currentActor()?.origin ?? 'cli') } }). Los éxitos NO se espejan (serían ruido de alta frecuencia y ya están en su log); las denegaciones y los errores sí, porque son la señal de compromiso que describe el propio comentario de la migración 014 (líneas 63-66).
 - En storeCredential/revokeCredential (revokeCredential está en la línea 316): emitir action:'create' y action:'delete' sobre entity_type='fiscal_credential' con newValues { credential_type, rfc, cert_serial, valid_to, vault_backend } — NUNCA vault_ref ni nada del material.

En el lector (tarea E0.3-i), la vista combinada muestra ambas fuentes ordenadas por fecha, marcando la procedencia. La unificación es de LECTURA, no de almacenamiento.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/fiscal-credentials/service.ts` — modificar logAccess para espejar denegaciones y errores en audit_log; emitir create/delete en el alta y la revocación de credenciales

**Criterios de aceptación**

- Dado un acceso a e.firma denegado por rate_limit, entonces hay una fila en fiscal_credential_access_log (outcome='denied') y una fila en audit_log (action='access', entity_type='fiscal_credential', new_values.denied_reason='rate_limit').
- Dado un acceso exitoso, entonces hay fila en fiscal_credential_access_log y NINGUNA en audit_log.
- Dado `mnemosine sat cred revoke`, entonces audit_log tiene una fila action='delete' sobre entity_type='fiscal_credential' y en ninguna de sus columnas aparece vault_ref.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/fiscal-credentials/audit-mirror.spec.ts` — extiende el patrón de mocks de tests/fiscal-credentials/service.spec.ts: denegación produce INSERT en ambas tablas; éxito solo en la especializada; el espejo nunca contiene vault_ref

##### `E0.3-i` Superficie de lectura: `mnemosine audit` y GET /v1/audit, con el permiso unificado · **M**

Sin lector, nada de lo anterior es verificable por el usuario (hoy no existe ninguna ruta ni comando que lea audit_log; el único lector de bitácoras es `mnemosine sat cred audit`, sat-commands.ts:201).

(1) src/services/audit/audit-reader.ts:
    export interface AuditFilter { entityId?: string; entityType?: string; action?: AuditAction; origin?: AuditOrigin; actor?: string; since?: Date; until?: Date; requestId?: string; limit?: number }
    export async function listAudit(tenantId: string, legalEntityId: string, f: AuditFilter): Promise<AuditRow[]>
    export async function listEntryTrail(entityId: string): Promise<AuditRow[]>  // toda la historia de un asiento: create, post, reverse, void
    Consultas parametrizadas, LIMIT acotado con Math.min(500, ...) como hace getAccessLog (service.ts:345), ORDER BY timestamp DESC, apoyadas en idx_audit_log_legal_entity_ts.

(2) src/cli/audit-command.ts: `mnemosine audit` (alias 'auditoria'), con --entity, --entry <numero|uuid>, --action, --origin, --since, --limit, --json. Salida tabular en el estilo del resto de la CLI (palette.ts). Con --entry resuelve el asiento por entry_number y llama listEntryTrail. Con --credentials añade las filas de fiscal_credential_access_log, marcando la procedencia (unificación de lectura de D4). Registrar el comando en src/cli/mnemosine.ts junto a los demás y añadir la entrada correspondiente a la referencia de la CLI.

(3) src/api/rest/routes/audit.ts: GET /v1/audit y GET /v1/audit/entries/:id, con requirePermission('audit:read') y requireEntityAccess, montado en src/index.ts como `app.use(`${apiPrefix}/audit`, auditRouter)`.

(4) Nombre del permiso: hoy conviven 'audit:read' (src/cli/init/s2-users.ts:39, que es el catálogo que REALMENTE escribe los permisos del rol auditor) y 'audit_log:read' (src/api/rest/middleware/auth.ts:170, catálogo que nadie importa). Usar 'audit:read' y corregir auth.ts:170 para que diga lo mismo. La unificación completa de catálogos de roles pertenece a otro paquete; aquí solo se alinea esta cadena para que el rol auditor sembrado por `mnemosine init` pueda efectivamente leer.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/audit/audit-reader.ts` — crear: listAudit y listEntryTrail
- `/Users/victor/projects/Accounting/src/cli/audit-command.ts` — crear: comando `mnemosine audit` / `auditoria`
- `/Users/victor/projects/Accounting/src/api/rest/routes/audit.ts` — crear: GET /v1/audit y GET /v1/audit/entries/:id con requirePermission('audit:read')
- `/Users/victor/projects/Accounting/src/api/rest/middleware/auth.ts` — modificar línea 170: 'audit_log:read' → 'audit:read', alineado con el catálogo de src/cli/init/s2-users.ts:39
- `/Users/victor/projects/Accounting/src/index.ts` — modificar: montar auditRouter en `${apiPrefix}/audit`
- `/Users/victor/projects/Accounting/src/cli/mnemosine.ts` — modificar: registrar el comando audit

**Criterios de aceptación**

- Dado un asiento posteado y luego anulado, cuando corre `mnemosine audit --entry JE-000123`, entonces se listan en orden create, post, void (con su razón) y reverse, cada una con su actor y su origen.
- Dado un usuario con el rol auditor sembrado por `mnemosine init`, cuando llama GET /v1/audit, entonces recibe 200; dado un usuario sin 'audit:read', entonces recibe 403.
- Dado `mnemosine audit --origin cli --since 2026-08-01`, entonces solo devuelve filas con origin='cli' posteriores a esa fecha.
- Dado un tenant B, cuando su usuario consulta GET /v1/audit, entonces no ve ninguna fila del tenant A (RLS: la política tenant_isolation ya cubre audit_log).

**Pruebas**

- `/Users/victor/projects/Accounting/tests/cli/audit-command.spec.ts` — renderiza el rastro completo de un asiento en orden cronológico; --json emite la estructura esperada; --credentials mezcla ambas fuentes marcando procedencia
- `/Users/victor/projects/Accounting/tests/audit/audit-reader.spec.ts` — listAudit construye el WHERE parametrizado según los filtros y acota el LIMIT a 500; listEntryTrail ordena ascendente por timestamp

##### `E0.3-j` E2E contra base real: el rastro completo de una vida contable · **M**

Crear scripts/e2e-audit.ts al estilo de scripts/e2e-reversal.ts, pero SIN UUIDs hardcodeados: siembra su propio tenant, entidad, usuario, año y periodo fiscal al arrancar, y los deja identificados por un prefijo con marca de tiempo para poder limpiar.

Secuencia y aserciones (todas contra audit_log, consultando por legal_entity_id):
 1. enterCliActor + createJournalEntry sin autoPost → 1 fila create, origin='cli'.
 2. postJournalEntry → 1 fila post con old_values.status='draft'.
 3. reverseJournalEntry → 1 fila reverse sobre el original + create y post del espejo.
 4. createJournalEntry con autoPost + voidJournalEntry → filas create, post y void, con reason exactamente igual al texto pasado.
 5. softClosePeriod y hardClosePeriod → dos filas close con status soft y hard.
 6. Intento de `UPDATE audit_log SET reason='tamper'` → debe fallar con 42501.
 7. Consulta de cobertura: cero asientos posteados durante la corrida sin su fila action='post'.
 Al final imprime un resumen y limpia lo que sembró (audit_log NO se puede borrar: el script debe dejarlo así y decirlo en su salida; usar una base efímera o un tenant desechable).

Añadir a package.json: "e2e:audit": "tsx scripts/e2e-audit.ts" — hoy ningún script E2E figura en package.json, y ese es justamente el motivo por el que la auditoría adversarial los descartó como evidencia.

**Archivos**

- `/Users/victor/projects/Accounting/scripts/e2e-audit.ts` — crear: E2E de cobertura de auditoría con fixtures sembradas, sin UUIDs hardcodeados
- `/Users/victor/projects/Accounting/package.json` — modificar scripts: añadir "e2e:audit": "tsx scripts/e2e-audit.ts"

**Criterios de aceptación**

- Dado `npm run e2e:audit` contra una base con las 31 migraciones, entonces termina con código 0 e imprime el conteo por acción: create=3, post=3, reverse=1, void=1, close=2.
- Dado el mismo script, cuando intenta modificar una fila de la bitácora, entonces reporta el rechazo 42501 como PASA (no como fallo).
- Dado el mismo script ejecutado dos veces seguidas, entonces la segunda corrida también pasa (no depende de estado previo).

**Riesgo.** Necesita una base real; no corre en `npm test`. Mitigación: es el único artefacto del paquete que exige base, y su ausencia se detecta porque las métricas de cierre lo nombran explícitamente.

#### Cómo se sabe que cerró

- `npm test` verde, incluyendo los siete specs nuevos (tests/audit/*, tests/accounting/posting-audit.spec.ts, tests/accounting/period-close-audit.spec.ts, tests/ai/draft-approval-audit.spec.ts, tests/ai/external-ops-audit.spec.ts, tests/api/middleware/audit.spec.ts, tests/database/append-only.spec.ts) y `npx tsc --noEmit` con código 0.
- `npm run e2e:audit` contra base con las 31 migraciones: código 0 y conteo create=3, post=3, reverse=1, void=1, close=2.
- Consulta que debe devolver CERO: `SELECT count(*) FROM journal_entries je WHERE je.status='posted' AND je.created_at > '<inicio de la corrida>' AND NOT EXISTS (SELECT 1 FROM audit_log al WHERE al.entity_type='journal_entry' AND al.entity_id=je.id AND al.action='post');`
- Consulta que debe devolver CERO: `SELECT count(*) FROM audit_log WHERE origin IS NULL OR actor_type IS NULL OR (actor_type='human' AND user_id IS NULL);`
- Consulta que debe devolver FALSE tres veces: `SELECT has_table_privilege('mnemosine_app','audit_log','UPDATE'), has_table_privilege('mnemosine_app','audit_log','DELETE'), has_table_privilege('mnemosine_app','fiscal_credential_access_log','DELETE');` — y sigue devolviendo FALSE tras volver a ejecutar `npm run migrate`.
- `UPDATE audit_log SET reason='tamper' WHERE true;` falla con SQLSTATE 42501 y el mensaje 'La bitácora es append-only'.
- `grep -c "INSERT INTO audit_log" -r src/` devuelve 1 (solo src/services/audit/audit-log.ts).
- `grep -n "uuidv4" src/api/rest/middleware/audit.ts` no devuelve ninguna línea que asigne request_id ni entity_id.
- Dado un asiento creado desde la CLI y otro desde REST, `mnemosine audit --entry <numero>` muestra el rastro completo de ambos, y `SELECT DISTINCT origin FROM audit_log` incluye al menos 'cli' y 'rest' — hoy solo puede contener 'rest'.


## E1 · Que la contabilidad funcione sola

### E1.1 · account_roles: sembrar la capa semántica en el alta de entidad y en `mnemosine init`
**Objetivo.** Que toda entidad creada por `mnemosine init` (y toda entidad ya existente en bases desplegadas) tenga su catálogo de cuentas base y sus 31 filas de account_roles, de modo que postInvoiceEntry/postBillEntry/postCustomerPaymentEntry/postVendorPaymentEntry dejen de lanzar MISSING_ROLE_ACCOUNT sin intervención manual en SQL. El paquete no escribe nada al mayor: toca sólo `accounts` y `account_roles`.

**Por qué aquí.** Es el hueco crítico #1 y la raíz de tres degradaciones de la auditoría (ar-ap-posting, posteo automático AR/AP, seedAccountRoles). Es prerequisito de E1.2 (cuenta de utilidades acumuladas por rol en period-close), del cableado del clasificador CFDI declarativo y del E2E reproducible de AR/AP. El código, la tabla (migración 015 + 018) y REQUIRED_ACCOUNTS ya existen: falta el llamador y el catálogo base.

**Depende de:** `E0.1`, `E0.2` · **Migraciones:** `035-039` · **8 tareas · 4.2 sem-persona**

**Precondiciones:**

- Migraciones aplicadas hasta 030 (account_roles nace en 015_account_roles.sql; sus dos índices únicos parciales, en 018_fix_account_roles_unique.sql).
- RLS reaplicada desde src/database/rls-policies.sql tras la última migración: account_roles queda cubierta por el bucle genérico (tiene tenant_id NOT NULL) y accounts por el predicado vía legal_entities (no tiene tenant_id). No hace falta añadir nada a ese archivo.
- Contexto de tenant activo (enterTenant/withTenant) en cualquier proceso que ejecute la siembra: el INSERT en account_roles lleva tenant_id explícito y la política FOR ALL reutiliza USING como WITH CHECK.
- Nota verificada contra el código: `accounts.created_by` es UUID NOT NULL SIN FK a users (001_core_schema.sql), pero la atribución debe ser un usuario real; ver E1.1-c.

#### Decisiones a resolver

**¿Qué hace el sistema cuando el catálogo de cuentas de la entidad NO contiene los códigos que ROLE_MAP espera —el caso de una entidad onboardeada desde otro sistema contable, cuyo catálogo lo creó executeOnboarding a partir del balance remoto (src/ai/onboarding-service.ts:179)?**

ROLE_MAP referencia 27 códigos. REQUIRED_ACCOUNTS crea 14; los otros 13 (1110,1120,1130,1140,1210,2110,2120,2140,4100,4300,6100,6110,6300) sólo existen si corrió el catálogo base. En una entidad importada, los códigos son los del despacho anterior (a menudo el agrupador SAT: 101, 105, 118, 201, 209, 401, 601…), así que ningún código de ROLE_MAP casa y los 31 roles quedarían sin mapear. Crear 52 cuentas mexicanas dentro del catálogo del cliente no es un detalle técnico: le cambia el plan de cuentas y el balance que ya conoce.

- A) Crear siempre las cuentas faltantes (catálogo base + REQUIRED_ACCOUNTS) en toda entidad.
- B) No crear nunca: sólo mapear los roles cuyo código exista y dejar el resto en unmapped, para que el humano los resuelva con `mnemosine accounts roles --fix` u overrides.
- C) Híbrido por estado de la entidad: si accounts está vacío (entidad nacida en mnemosine) se crea el catálogo completo; si ya tiene cuentas (llegó por onboarding) sólo se mapea y se reporta lo que falta.
- D) Preguntar siempre al usuario en la sección de init, sin default.

_Recomendación:_ C, con la puerta de escape de B: es la regla implementada en ensureEntityAccounting (E1.1-c, paso 3) mediante `accountCount === 0`, sobrescribible con withBaseChart/strategy y complementada con `overrides` rol→código para catálogos ajenos. A rompe catálogos de clientes reales; B deja inservible el caso mayoritario (entidad nueva); D convierte cada init en un interrogatorio sobre algo que en el 90% de los casos tiene una respuesta obvia.

_Bloquea:_ E1.1-c (la regla por defecto), E1.1-d (el default del confirm de la sección) y E1.1-g (si el backfill crea o no cuentas).

**¿Se sigue mapeando tres retenciones distintas a la misma cuenta 2140 'Retenciones por Pagar', y 'impuestos_locales_gasto' a la misma 6100 que 'gasto'?**

Verificado en ROLE_MAP (account-roles-seed.ts:140-152): isr_retenido_por_pagar, iva_retenido_por_pagar e isr_nomina_por_pagar apuntan los tres al código 2140; impuestos_locales_gasto apunta al 6100, el mismo de 'gasto'. Consecuencia práctica: el saldo de 2140 mezcla retenciones de ISR a terceros, IVA retenido y el ISR de nómina, que se enteran en declaraciones distintas y con papeles distintos (la DIOT necesita el IVA retenido por separado). Sembrarlo así hoy hace más caro separarlo después: habría que reclasificar saldos por reversa.

- A) Dejarlo como está (una sola cuenta 2140 y 6100 compartida) y documentarlo.
- B) Añadir a REQUIRED_ACCOUNTS 2141 'ISR Retenido por Pagar', 2142 'IVA Retenido por Pagar', 2143 'ISR de Nómina por Pagar' y 6150 'Impuestos Locales', y repuntar esos cuatro roles.
- C) Dejar los códigos como están pero usar el `qualifier` de account_roles (la tabla ya lo admite) para distinguirlos.

_Recomendación:_ B. Es un cambio de tres constantes en un arreglo de TypeScript ANTES de que ninguna base tenga saldos en esos roles —hoy account_roles está vacía en todas partes, que es precisamente lo que este paquete arregla—, así que es el único momento barato para hacerlo. C no sirve: ar-ap-posting y cfdi-classifier consultan siempre `qualifier IS NULL`, de modo que un qualifier no cambiaría a qué cuenta va el importe.

_Bloquea:_ E1.1-b (contenido de REQUIRED_ACCOUNTS y de ROLE_MAP) y, por arrastre, el conteo '31 roles / 52 cuentas' de los criterios de aceptación de E1.1-c y E1.1-d, que pasaría a 31 roles / 56 cuentas.

**En bases ya desplegadas con entidades vivas, ¿el backfill crea cuentas por su cuenta o sólo mapea lo que encuentra?**

Es la diferencia entre `--apply` y `--apply --create-missing` en E1.1-g. Crear cuentas en el catálogo de un cliente en producción cambia sus reportes y su árbol de cuentas sin que nadie lo haya pedido; no crearlas deja las entidades sin poder postear AR/AP hasta que alguien intervenga.

- A) Backfill que crea siempre lo que falta, en una sola pasada desatendida.
- B) Backfill seco por defecto; --apply mapea sin crear; --create-missing explícito para crear.
- C) No hacer backfill: que cada entidad se repare la primera vez que alguien corra `mnemosine init --section accounting` o `mnemosine accounts roles --fix`.

_Recomendación:_ B, más el check de doctor de E1.1-e para que una instalación sin backfillear sea visible en lugar de silenciosa. C es tentador por simplicidad pero deja el fallo latente hasta el primer posteo, que es exactamente el patrón que este paquete existe para eliminar.

_Bloquea:_ E1.1-g (el default del script y lo que se documenta en el README).

**¿El catálogo de roles esperados se materializa en la base (tabla de referencia account_role_catalog + vista v_account_roles_missing) o se queda en TypeScript?**

El punto (c) del paquete pide 'una vista o comando'. La lista canónica de roles hoy es la unión de tipos AccountRole (cfdi-taxonomy.ts:11-30) y ROLE_MAP. Una vista SQL necesitaría la lista en SQL, es decir, duplicarla y arriesgar deriva —el mismo defecto que ya sufre period-close.ts con sus códigos '3100'/'3900' escritos a mano.

- A) Sólo TypeScript: diagnoseAccountRoles + `mnemosine accounts roles` + check de doctor.
- B) Tabla de referencia account_role_catalog sembrada por migración + vista v_account_roles_missing, consultable por SQL y por herramientas externas.
- C) Ambas, con un test que verifique que la tabla y ROLE_MAP no divergen (el patrón del corpus NIIF).

_Recomendación:_ A para este paquete. La vista sólo gana valor si algo fuera de Node necesita el diagnóstico (BI, un runbook de soporte); mientras el producto sea CLI-first, el comando y el check de doctor cubren el caso y no crean una segunda fuente de verdad. Si más adelante hace falta, C es la forma correcta de añadirla, no B.

_Bloquea:_ E1.1-e (si hace falta o no una migración 031 con la tabla y la vista).

#### Tareas

##### `E1.1-a` Extraer el catálogo de cuentas base a un módulo reutilizable (hoy sólo existe dentro de seed.ts) · **M**

HALLAZGO QUE CONTRADICE AL ATLAS: el atlas asume que sólo falta llamar a seedAccountRoles. El código dice más: `mnemosine init` NUNCA crea un catálogo de cuentas. IdentidadSection.createEntity (src/cli/init/s1-identity.ts:111-151) inserta tenant, organizations y legal_entities y nada más; el único INSERT INTO accounts con un plan completo vive en src/database/seed.ts:128 (38 cuentas, demo). ROLE_MAP referencia 27 códigos distintos; REQUIRED_ACCOUNTS crea 14 de ellos; los 13 restantes (1110, 1120, 1130, 1140, 1210, 2110, 2120, 2140, 4100, 4300, 6100, 6110, 6300) sólo existen si corrió `npm run seed`. Por tanto, cablear seedAccountRoles sin catálogo base dejaría 13 roles sin mapear —incluidos cxc(1120), cxp(2110), banco(1110), ingreso(4100), gasto(6100), iva_trasladado(2120), iva_acreditable(1130)—, es decir TODOS los roles que AR/AP necesita, y el bug seguiría vivo.

Crear src/services/accounting/chart-seed.ts con:

  export interface ChartAccountSpec { code: string; name: string; account_type: 'asset'|'liability'|'equity'|'revenue'|'expense'|'contra_asset'|'contra_liability'|'contra_equity'; account_subtype?: string; fs_category?: string; normal_balance: 'debit'|'credit'; parent?: string; is_header?: boolean; is_system_account?: boolean; description?: string }

  export const BASE_CHART_MX: ChartAccountSpec[]  // las 38 filas hoy embebidas en seed.ts:71-108, transcritas SIN cambios de código ni de nombre

  export async function ensureBaseChart(client: pg.PoolClient, entityId: string, createdBy: string): Promise<string[]>

Comportamiento de ensureBaseChart: (1) SELECT code, id FROM accounts WHERE entity_id = $1 → Map byCode; (2) recorre BASE_CHART_MX EN ORDEN (el arreglo ya está topológicamente ordenado: el padre siempre precede al hijo) y para cada código ausente hace `INSERT INTO accounts (code,name,account_type,account_subtype,fs_category,normal_balance,entity_id,parent_id,is_header,is_system_account,allow_manual_entries,created_by) VALUES (...) ON CONFLICT (code, entity_id) DO NOTHING RETURNING id`; parent_id se resuelve desde byCode; allow_manual_entries = NOT is_header (el CHECK `is_header = false OR allow_manual_entries = false` de 001_core_schema.sql lo exige); (3) si el RETURNING viene vacío (carrera con otro init), re-SELECT del id por (code, entity_id) y sigue; (4) devuelve los códigos efectivamente creados. NO abre transacción propia: siempre trabaja sobre el client recibido.

Refactorizar src/database/seed.ts para que el paso 6 llame a ensureBaseChart en vez de mantener su arreglo local, preservando el orden actual de inserción y los UUID generados a partir de ahí (accountIds sigue construyéndose leyendo accounts tras la siembra, no antes).

**Archivos**

- `/Users/victor/projects/Accounting/src/services/accounting/chart-seed.ts` — crear: ChartAccountSpec, BASE_CHART_MX (38 cuentas transcritas de seed.ts:71-108) y ensureBaseChart(client, entityId, createdBy)
- `/Users/victor/projects/Accounting/src/database/seed.ts` — modificar: sustituir el arreglo local `accounts` (líneas 71-108) y su bucle de inserción (líneas 120-145 aprox.) por una llamada a ensureBaseChart dentro de una withTransaction; el resto del seed no cambia

**Criterios de aceptación**

- Dado un entity_id sin ninguna fila en accounts, cuando corre ensureBaseChart, entonces existen 38 cuentas para esa entidad y toda cuenta con `parent` tiene parent_id no nulo apuntando a la cuenta de ese código en la MISMA entidad.
- Dado un entity_id que ya tiene las 38 cuentas, cuando ensureBaseChart corre otra vez, entonces devuelve [] y el count de accounts no cambia.
- Dado un entity_id con una cuenta 1120 renombrada a mano, cuando corre ensureBaseChart, entonces el nombre NO se sobrescribe y 1120 no se duplica.
- Dado `npm run seed` sobre una base recién migrada, entonces termina en código 0 y produce el mismo catálogo de 38 cuentas que antes del refactor.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/accounting/chart-seed.spec.ts` — BASE_CHART_MX: todo `parent` referenciado existe como code en el propio arreglo y aparece ANTES que su hijo; ninguna cuenta con is_header true declara allow_manual_entries; los 27 códigos de ROLE_MAP están cubiertos por BASE_CHART_MX ∪ REQUIRED_ACCOUNTS (este test es el que impide la regresión de fondo)
- `/Users/victor/projects/Accounting/tests/accounting/chart-seed.spec.ts` — ensureBaseChart con un client falso: segunda pasada no emite ningún INSERT (idempotencia sobre el Map byCode)

**Riesgo.** El refactor de seed.ts es el único punto donde puede romperse la demo. Mitigación: ensureBaseChart preserva el orden del arreglo y el CHECK is_header/allow_manual_entries se respeta explícitamente; correr `npm run seed` contra una base limpia antes de dar la tarea por cerrada.

##### `E1.1-b` Mover account-roles-seed a services/accounting y darle client inyectable, estrategia y resultado diagnosticable · **M**

Mover /Users/victor/projects/Accounting/src/services/xml-ingestion/account-roles-seed.ts a /Users/victor/projects/Accounting/src/services/accounting/account-roles-seed.ts (git mv). El módulo lo consume el motor contable (ar-ap-posting) tanto como la ingesta; su casa actual es engañosa. Verificado: los únicos referentes son su propio archivo, el texto del error de ar-ap-posting.ts:51 y tests/xml-ingestion/account-roles-seed.spec.ts, así que el movimiento toca 2 imports. El import de tipo `AccountRole` sigue apuntando a ../xml-ingestion/cfdi-taxonomy.js.

Reescribir la firma:

  export type RoleStrategy = 'create_missing' | 'map_only';
  export interface SeedAccountRolesOptions {
    /** Transacción del llamador; si falta, la función abre la suya con withTransaction. */
    client?: pg.PoolClient;
    /** 'create_missing' (por defecto): crea las cuentas de REQUIRED_ACCOUNTS que falten.
     *  'map_only': no crea NINGUNA cuenta; los roles cuyo código no exista quedan en unmapped. */
    strategy?: RoleStrategy;
    /** Sobrescritura rol → código de cuenta para catálogos ajenos (E1.1-g). */
    overrides?: Partial<Record<AccountRole, string>>;
  }
  export interface SeedResult {
    accountsCreated: string[];
    /** Filas INSERTADAS en esta corrida (0 en una segunda pasada). */
    rolesInserted: number;
    /** Filas de account_roles con qualifier IS NULL que la entidad tiene AL TERMINAR. */
    rolesTotal: number;
    unmapped: Array<{ role: string; code: string }>;
  }
  export async function seedAccountRoles(entityId: string, tenantId: string, createdBy: string, opts?: SeedAccountRolesOptions): Promise<SeedResult>

Cambios de comportamiento:
1. El campo `rolesMapped` se renombra a `rolesInserted` y se añade `rolesTotal`, calculado con `SELECT count(*) FROM account_roles WHERE entity_id=$1 AND qualifier IS NULL` al final de la misma transacción. Razón verificada: hoy `rolesMapped` cuenta rowCount de INSERTs con ON CONFLICT DO NOTHING, así que una segunda corrida devuelve 0 y cualquier status() que lo use reportaría 'missing' sobre una entidad correcta.
2. Cuerpo extraído a `async function run(client: pg.PoolClient, ...)`; el export decide: `opts?.client ? run(opts.client, ...) : withTransaction((c) => run(c, ...))`. Nunca abre una transacción anidada.
3. Guardas al entrar (antes de escribir nada), lanzando AccountingError de src/utils/errors.js: `SELECT tenant_id FROM legal_entities WHERE id = $1` → si no hay fila, AccountingError('ENTITY_NOT_FOUND'); si tenant_id ≠ tenantId, AccountingError('TENANT_MISMATCH', `la entidad ${entityId} pertenece a otro tenant`). Sin esta guarda el fallo llega como un error opaco de RLS ("new row violates row-level security policy").
4. El INSERT de REQUIRED_ACCOUNTS (hoy líneas 185-195) gana `ON CONFLICT (code, entity_id) DO NOTHING RETURNING id`; si no devuelve fila, re-SELECT del id. Hoy dos inits concurrentes revientan con 23505.
5. Con strategy 'map_only' se salta por completo el bucle de REQUIRED_ACCOUNTS.
6. `overrides` se aplica sobre ROLE_MAP con spread antes del bucle de roles: `const map = { ...ROLE_MAP, ...(opts?.overrides ?? {}) }`.
7. Se conserva tal cual el INSERT de account_roles con `ON CONFLICT DO NOTHING` sin target y su comentario: los dos índices parciales de 018 son los que dan la unicidad y nombrar la constraint vieja no protegería el caso qualifier NULL.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/xml-ingestion/account-roles-seed.ts` — eliminar (git mv al destino de abajo)
- `/Users/victor/projects/Accounting/src/services/accounting/account-roles-seed.ts` — crear con el contenido movido + nueva firma seedAccountRoles(entityId, tenantId, createdBy, opts), SeedResult ampliado, guardas ENTITY_NOT_FOUND/TENANT_MISMATCH, ON CONFLICT en el INSERT de accounts y soporte de strategy/overrides
- `/Users/victor/projects/Accounting/tests/xml-ingestion/account-roles-seed.spec.ts` — eliminar (se traslada a tests/accounting/account-roles-seed.spec.ts con los mismos 8 casos y el import actualizado)
- `/Users/victor/projects/Accounting/tests/accounting/account-roles-seed.spec.ts` — crear: los 8 casos existentes sobre ROLE_MAP y REQUIRED_ACCOUNTS + los nuevos de esta tarea

**Criterios de aceptación**

- Dado un entityId cuyo legal_entities.tenant_id difiere del tenantId recibido, cuando se llama seedAccountRoles, entonces lanza AccountingError('TENANT_MISMATCH') y no escribe ninguna fila.
- Dado un client de una transacción ya abierta pasado en opts.client, cuando seedAccountRoles termina y el llamador hace ROLLBACK, entonces no queda ninguna cuenta ni ningún rol creado.
- Dada una entidad con las 31 filas ya sembradas, cuando se vuelve a llamar, entonces rolesInserted = 0, rolesTotal = 31, accountsCreated = [] y unmapped = [].
- Dado strategy 'map_only' sobre una entidad sin las 14 cuentas de REQUIRED_ACCOUNTS, entonces accountsCreated = [] y unmapped lista exactamente los roles cuyo código no existe.
- Dado overrides { cxc: '1121' } y una cuenta 1121 existente, entonces account_roles.role='cxc' apunta al id de 1121.
- `grep -rn "xml-ingestion/account-roles-seed" src tests scripts` no devuelve nada.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/accounting/account-roles-seed.spec.ts` — con un pg.PoolClient falso (vi.fn sobre .query) verifica: guarda de tenant, que con opts.client no se invoca withTransaction, que la segunda pasada no emite INSERTs de cuentas, y que overrides gana sobre ROLE_MAP

**Riesgo.** El renombre rolesMapped→rolesInserted rompe cualquier consumidor. Verificado que hoy no hay ninguno (la función tiene cero llamadores), así que el riesgo es nulo salvo por el spec movido.

##### `E1.1-c` ensureEntityAccounting: el único punto de entrada idempotente (catálogo + roles) y su diagnóstico · **M**

Crear /Users/victor/projects/Accounting/src/services/accounting/entity-bootstrap.ts:

  /** Roles sin los cuales AR/AP no puede postear NADA (verificado en ar-ap-posting.ts:67,118,167,190,213). */
  export const CRITICAL_ROLES = ['cxc','cxp','banco','ingreso','gasto','iva_trasladado','iva_acreditable'] as const;

  export interface BootstrapOptions { client?: pg.PoolClient; strategy?: RoleStrategy; withBaseChart?: boolean; overrides?: Partial<Record<AccountRole,string>> }
  export interface BootstrapResult { baseAccountsCreated: string[]; requiredAccountsCreated: string[]; rolesInserted: number; rolesTotal: number; unmapped: Array<{role:string; code:string}>; missingCritical: string[] }

  export async function ensureEntityAccounting(entityId: string, tenantId: string, createdBy: string, opts: BootstrapOptions = {}): Promise<BootstrapResult>

Orden de operaciones, TODO en una sola transacción (la del llamador si viene opts.client; si no, una withTransaction propia):
  1. Guarda de tenant/entidad (delegada a seedAccountRoles, que ya la hace; repetirla aquí sería redundante — se llama primero a la guarda extrayéndola a `assertEntityInTenant(client, entityId, tenantId)` exportada del mismo módulo y usada por ambos).
  2. `const accountCount = SELECT count(*) FROM accounts WHERE entity_id = $1`.
  3. Si `opts.withBaseChart ?? (accountCount === 0)` → ensureBaseChart(client, entityId, createdBy). La regla por defecto es la que resuelve el punto (b) del paquete: una entidad recién nacida (0 cuentas) recibe el catálogo base; una entidad que llegó por onboarding desde otro sistema contable (accountCount > 0, cuentas creadas por executeOnboarding en src/ai/onboarding-service.ts:179) NO recibe cuentas base inyectadas — se le mapean roles contra su propio catálogo y lo que no case cae en unmapped. Ver decisión 1.
  4. seedAccountRoles(entityId, tenantId, createdBy, { client, strategy: opts.strategy ?? (accountCount === 0 ? 'create_missing' : 'map_only'), overrides: opts.overrides }).
  5. missingCritical = CRITICAL_ROLES que aparecen en unmapped.

  export interface RoleDiagnosis { entityId: string; entityName: string; total: number; mapped: Array<{role:string; code:string; name:string}>; missing: Array<{role:string; expectedCode:string; codeExists:boolean}>; missingCritical: string[] }
  export async function diagnoseAccountRoles(entityId: string): Promise<RoleDiagnosis>
  export async function diagnoseAllEntities(): Promise<RoleDiagnosis[]>

diagnoseAccountRoles no escribe: hace `SELECT ar.role, a.code, a.name FROM account_roles ar JOIN accounts a ON a.id = ar.account_id WHERE ar.entity_id = $1 AND ar.qualifier IS NULL` (la misma forma que loadRoleMap en cfdi-classifier.ts:66-71), resta contra Object.keys(ROLE_MAP) y para cada rol faltante marca codeExists consultando accounts por el código esperado — así el usuario sabe si le falta la cuenta o sólo el mapeo. diagnoseAllEntities itera `SELECT id, name FROM legal_entities WHERE is_active` (ya filtrado por RLS).

El catálogo de roles esperado vive en TypeScript (ROLE_MAP), no en SQL: no se crea vista ni tabla de referencia. Ver decisión 4.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/accounting/entity-bootstrap.ts` — crear: CRITICAL_ROLES, assertEntityInTenant, ensureEntityAccounting, diagnoseAccountRoles, diagnoseAllEntities

**Criterios de aceptación**

- Dada una entidad nueva sin cuentas, cuando corre ensureEntityAccounting, entonces accounts tiene 52 filas (38 base + 14 de REQUIRED_ACCOUNTS), account_roles tiene 31 filas con qualifier NULL, unmapped = [] y missingCritical = [].
- Dada esa misma entidad, cuando se corre ensureEntityAccounting una segunda vez, entonces baseAccountsCreated = [], requiredAccountsCreated = [], rolesInserted = 0 y rolesTotal = 31.
- Dada una entidad con catálogo ajeno (p. ej. sólo códigos 101/201/401 traídos por onboarding), cuando corre con los defaults, entonces NO se crea ninguna cuenta, rolesTotal refleja sólo los códigos que casaron, y missingCritical incluye al menos 'cxc' y 'cxp'.
- Dada una entidad con catálogo ajeno y overrides { cxc:'105', cxp:'201', banco:'101', ingreso:'401', gasto:'601', iva_trasladado:'209', iva_acreditable:'118' }, entonces missingCritical = [].
- Dado que la transacción del llamador falla después de ensureEntityAccounting, entonces no queda ninguna cuenta ni rol (todo o nada).

**Pruebas**

- `/Users/victor/projects/Accounting/tests/accounting/entity-bootstrap.spec.ts` — con client falso: con 0 cuentas invoca ensureBaseChart y strategy create_missing; con >0 cuentas NO lo invoca y usa map_only; missingCritical se calcula sobre CRITICAL_ROLES
- `/Users/victor/projects/Accounting/tests/accounting/entity-bootstrap.spec.ts` — diagnoseAccountRoles distingue 'falta la cuenta' (codeExists false) de 'falta el mapeo' (codeExists true)

**Riesgo.** La regla `accountCount === 0` decide crear o no cuentas en el catálogo de un cliente real. Está aislada en un único punto y es sobrescribible con withBaseChart/strategy, pero es la decisión de producto de la que depende el resto: no implementar antes de resolver la decisión 1.

##### `E1.1-d` Cablear la siembra a `mnemosine init`: sección propia + llamada en el alta de entidad · **M**

DOS puntos de llamada, un solo orquestador.

(1) Sección nueva. Crear /Users/victor/projects/Accounting/src/cli/init/s2b-accounting.ts con `export class ContabilidadSection implements SetupSection`, id 'contabilidad' (ya está en la unión SectionId de section.ts:13-15, hoy sin implementación), title 'Chart of accounts and accounting roles', required = true. El prefijo 's2b' es deliberado: la sección corre justo DESPUÉS de S2 (usuarios) porque necesita entidad (S1) y un usuario real al que atribuir accounts.created_by (S2); renumerar s3/s4/s5 se descarta como churn puro sobre archivos críticos, y el orden real siempre lo fija buildSections.
  · status(): para cada entidad activa llama diagnoseAllEntities(); 'missing' si alguna tiene total = 0, 'partial' si alguna tiene missing.length > 0, 'ok' si todas tienen 31/31. Envuelto en try/catch → 'missing' (mismo patrón que PoliciesSection.status, s4-policies.ts:40-50).
  · configure(ctx): resuelve entidad con resolveEntity(ctx.flags.entity) y actor con resolveReviewer(entity.tenantId, ctx.flags.user) (src/ai/draft-service.ts:291). Imprime el diagnóstico previo, pide confirmación con la consecuencia explícita («Create N missing account(s) and map 31 accounting roles?», default true en entidad sin cuentas, default FALSE cuando la entidad ya trae catálogo propio), llama a ensureEntityAccounting y reporta accountsCreated/rolesInserted/unmapped. Si quedan roles sin mapear imprime la línea por rol con el código esperado y remite a `mnemosine accounts roles --fix`. En modo --yes (ctx.rl === null) NO pregunta y aplica los defaults.
  · verify(): devuelve un CheckResult 'Accounting roles' por delegación a la misma función que usa doctor (E1.1-e), para no duplicar criterio.

Registrarla en /Users/victor/projects/Accounting/src/cli/init/index.ts: export de la clase y `new ContabilidadSection()` en buildSections entre `new UsuariosSection()` y `new IaSection({cwd})`; actualizar el comentario de orden de index.ts:17-25 explicando por qué va ahí. Añadir a SECTION_ALIASES de /Users/victor/projects/Accounting/src/cli/init-command.ts:116-123 las claves `accounting: 'contabilidad'` y `contabilidad: 'contabilidad'`, y añadir 'accounting' al texto del error de sección desconocida (init-command.ts:182) y a la descripción de --section (init-command.ts:296).

(2) Alta de entidad. En /Users/victor/projects/Accounting/src/cli/init/s1-identity.ts, dentro de la MISMA withTransaction de createEntity (líneas 115-150), después del INSERT en legal_entities: resolver el actor con `SELECT id FROM users WHERE tenant_id=$1 AND is_active ORDER BY created_at ASC LIMIT 1` sobre el client. Si hay usuario → `await ensureEntityAccounting(entityId, tenantId, userId, { client })`, de modo que la entidad JAMÁS nace sin catálogo ni roles y el conjunto entero (tenant+org+entidad+cuentas+roles) commitea o revierte junto. Si NO hay usuario (caso legítimo: init corre S1 antes de S2), no se inventa un UUID centinela: se omite la siembra y configure() imprime «Chart of accounts pending: it will be created in the 'Chart of accounts and accounting roles' section, right after users», y la sección de (1) la completa. `resolveEntity` no se usa aquí porque el id de la entidad ya está en mano.

**Archivos**

- `/Users/victor/projects/Accounting/src/cli/init/s2b-accounting.ts` — crear: ContabilidadSection con status/configure/verify
- `/Users/victor/projects/Accounting/src/cli/init/index.ts` — modificar: importar y exportar ContabilidadSection; insertarla en buildSections tras UsuariosSection; actualizar el comentario de orden
- `/Users/victor/projects/Accounting/src/cli/init-command.ts` — modificar: alias 'accounting'/'contabilidad' en SECTION_ALIASES (línea 116), lista de secciones del mensaje de error (línea 182) y texto de la opción --section (línea 296)
- `/Users/victor/projects/Accounting/src/cli/init/s1-identity.ts` — modificar: dentro de createEntity, tras el INSERT en legal_entities, resolver actor y llamar ensureEntityAccounting con { client }; en configure, imprimir el mensaje de siembra diferida cuando no hubo actor

**Criterios de aceptación**

- Dado un tenant nuevo con un usuario ya creado, cuando corre `mnemosine init --yes --entity "Prueba SA" --rfc XAXX010101000 --country MX`, entonces `SELECT count(*) FROM account_roles WHERE entity_id = <nueva>` devuelve 31 y `SELECT count(*) FROM accounts WHERE entity_id = <nueva>` devuelve 52.
- Dado ese mismo escenario, cuando se llama postInvoiceEntry sobre una factura de esa entidad, entonces NO lanza MISSING_ROLE_ACCOUNT y crea el asiento vía createJournalEntry.
- Dado un tenant sin ningún usuario, cuando corre `mnemosine init --yes`, entonces S1 imprime el mensaje de siembra diferida, la sección de contabilidad corre después de usuarios y al terminar init hay 31 roles.
- Dado `mnemosine init --section accounting` sobre una entidad ya sembrada, entonces reporta 31/31, no crea ninguna cuenta y termina en código 0.
- Dado `mnemosine init --status`, entonces aparece la línea 'Chart of accounts and accounting roles' con su badge.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/cli/init/s2b-accounting.spec.ts` — con resolveEntity/resolveReviewer/ensureEntityAccounting mockeados (patrón de tests/cli/init/s4-policies.spec.ts): status devuelve missing/partial/ok según el diagnóstico; configure en modo --yes no pregunta y llama a ensureEntityAccounting una vez; con unmapped no vacío imprime la línea por rol y remite a `mnemosine accounts roles --fix`
- `/Users/victor/projects/Accounting/tests/cli/init/sections.spec.ts` — buildSections() devuelve 7 secciones y 'contabilidad' está exactamente después de 'usuarios'; resolveSectionId('accounting') === 'contabilidad'

**Riesgo.** Meter la siembra dentro de la transacción de createEntity alarga una transacción que hoy es corta y añade ~52 INSERTs. Es una operación de alta, no de camino caliente; el beneficio (imposible crear una entidad a medias) lo justifica.

##### `E1.1-e` Diagnóstico visible: check en `mnemosine doctor` y comando `mnemosine accounts roles` · **S**

(1) En /Users/victor/projects/Accounting/src/ai/doctor-service.ts añadir:

  export async function checkAccountRoles(): Promise<CheckResult>

Usa diagnoseAllEntities(). Niveles: si no hay entidades activas → devuelve ok con detail 'no active entities' (checkEntities ya reporta ese fallo y duplicarlo sería ruido). Si alguna entidad tiene missingCritical.length > 0 → level 'fail', detail `<N> entity(ies) cannot post AR/AP: <nombre> is missing <roles críticos>`, fix `mnemosine init --section accounting`. Si hay roles faltantes pero ninguno crítico → level 'warn', detail `<nombre>: <k>/31 roles mapped`, fix `mnemosine accounts roles --fix`. Si todas 31/31 → level 'ok', detail `31/31 roles mapped in <N> entity(ies)`. Registrarlo en runDoctor() justo después de `checks.push(await checkEntities())` (doctor-service.ts:44), dentro del bloque que sólo corre si hay base de datos.

(2) Crear /Users/victor/projects/Accounting/src/cli/accounts-command.ts con `export function registerAccountsCommand(program: Command, deps: { palette; shutdown; reportError }): void`, siguiendo el patrón de doctor-command.ts: `program.command('accounts').description(...)` con el subcomando `roles`:
  · `mnemosine accounts roles [--entity <id|nombre>] [--json]` imprime una tabla rol → código → nombre de cuenta para los mapeados, y una sección 'Not mapped' con rol, código esperado y si la cuenta existe; marca los críticos. Salida --json = RoleDiagnosis[] tal cual.
  · `--fix` llama a ensureEntityAccounting(entityId, tenantId, reviewer.userId) y reimprime el diagnóstico. Sin --fix no escribe nada.
  · Código de salida 1 cuando queda algún rol crítico sin mapear (para poder encadenarlo en un script), 0 en el resto.
Registrarlo en /Users/victor/projects/Accounting/src/cli/mnemosine.ts junto a las demás llamadas register*Command (líneas 1587-1598).

No se crea ninguna vista SQL: el catálogo de roles esperado vive en ROLE_MAP (TypeScript) y una vista tendría que duplicarlo. Ver decisión 4.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/doctor-service.ts` — modificar: añadir checkAccountRoles() y registrarla en runDoctor tras checkEntities()
- `/Users/victor/projects/Accounting/src/cli/accounts-command.ts` — crear: registerAccountsCommand con el subcomando `roles` (--entity, --json, --fix)
- `/Users/victor/projects/Accounting/src/cli/mnemosine.ts` — modificar: importar y llamar registerAccountsCommand(program, { palette: c, shutdown, reportError }) junto al resto de registros (~línea 1598)

**Criterios de aceptación**

- Dada una entidad sin ninguna fila en account_roles, cuando corre `mnemosine doctor`, entonces aparece la línea '✘ Accounting roles' con el fix 'mnemosine init --section accounting' y el comando sale con código 1.
- Dada una entidad con los 31 roles, cuando corre `mnemosine doctor`, entonces la línea es '✔ Accounting roles  31/31 roles mapped in 1 entity(ies)'.
- Dada una entidad a la que sólo le falta 'ieps_acreditable', entonces doctor reporta warn (no fail) porque no es un rol crítico, y `mnemosine accounts roles` sale con código 0.
- Dado `mnemosine accounts roles --json`, entonces la salida parsea como JSON y contiene entityId, mapped y missing.
- Dado `mnemosine accounts roles --fix` sobre una entidad sin roles, entonces al terminar el diagnóstico muestra 31/31 y una segunda ejecución de --fix no cambia nada.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/ai/doctor-account-roles.spec.ts` — checkAccountRoles con diagnoseAllEntities mockeado: fail con rol crítico faltante, warn con rol no crítico faltante, ok con 31/31, ok silencioso sin entidades
- `/Users/victor/projects/Accounting/tests/cli/accounts-command.spec.ts` — el renderizado marca los críticos, --json emite el diagnóstico y sin --fix no se invoca ensureEntityAccounting

##### `E1.1-f` Dejar de mentir en el mensaje MISSING_ROLE_ACCOUNT · **S**

En /Users/victor/projects/Accounting/src/services/accounting/ar-ap-posting.ts, requireRole (líneas 46-55) afirma hoy: 'seed the account roles first (mnemosine init runs seedAccountRoles)'. Eso es falso hasta que E1.1-d aterrice, y después seguirá siendo poco accionable porque no dice qué entidad ni qué hacer con una entidad ya existente.

Cambiar la firma a `function requireRole(map: Map<string,string>, role: string, entityId: string): string` y actualizar las cinco llamadas (líneas 71, 77, 87, 121, 128, 138, 168, 191, 214 según el rol) para pasar el entity_id del documento. Nuevo mensaje:

  `No account is mapped to role "${role}" for entity ${entityId}. Run: mnemosine accounts roles --entity ${entityId} --fix  (or mnemosine init --section accounting)`

Mantener el código de error 'MISSING_ROLE_ACCOUNT' y la clase AccountingError: cualquier consumidor que discrimine por código sigue funcionando. Actualizar también el comentario de cabecera del archivo (línea 17: 'Accounts resolve through account_roles (seeded per entity)') para nombrar el punto de siembra real: ensureEntityAccounting, invocado por el alta de entidad y por la sección 'accounting' de init.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/accounting/ar-ap-posting.ts` — modificar: requireRole recibe entityId y emite el mensaje con la entidad y el comando real; actualizar las llamadas y el comentario de cabecera (líneas 16-18)

**Criterios de aceptación**

- Dado un entity_id sin el rol 'cxc', cuando se llama postInvoiceEntry, entonces el error es AccountingError con code 'MISSING_ROLE_ACCOUNT' y su message contiene el UUID de la entidad y la cadena 'mnemosine accounts roles'.
- `grep -rn "init runs seedAccountRoles" src` no devuelve nada.
- `npx tsc --noEmit` termina en código 0 tras el cambio de firma.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/accounting/ar-ap-posting.spec.ts` — con un client falso que devuelve cero filas de account_roles, postInvoiceEntry lanza MISSING_ROLE_ACCOUNT y el mensaje incluye entityId y el comando correcto (primer test unitario del archivo; hoy no existe ninguno)

##### `E1.1-g` Backfill de entidades ya existentes en bases desplegadas · **M**

No hay migración SQL: ROLE_MAP vive en TypeScript y traducirlo a SQL duplicaría el catálogo con riesgo de deriva (justo el defecto que ya tiene period-close.ts con sus códigos literales). El backfill es un script idempotente y re-ejecutable.

Crear /Users/victor/projects/Accounting/scripts/backfill-account-roles.ts, ejecutable con `npx tsx scripts/backfill-account-roles.ts [--tenant <uuid>] [--entity <uuid>] [--create-missing] [--apply]`:
  1. enterTenant(--tenant ?? process.env.MNEMOSINE_TENANT); si no hay tenant y la conexión está sujeta a RLS, aborta con un mensaje que lo diga (mismo criterio que alcanceHint() en src/ai/context.ts).
  2. `SELECT id, name FROM legal_entities WHERE is_active` (+ filtro --entity).
  3. Por entidad, en SECO por defecto: diagnoseAccountRoles y reporte por pantalla. Sólo con `--apply` llama a ensureEntityAccounting con `strategy: '--create-missing' ? 'create_missing' : 'map_only'` y `withBaseChart: false`. El default NO crea cuentas: en una base desplegada el catálogo es del cliente y meterle 14 cuentas mexicanas sin aviso es una decisión suya, no del script (ver decisión 3).
  4. Cada entidad va en su propia withTransaction: una entidad problemática no aborta el lote.
  5. Resumen final: entidades procesadas, roles insertados, entidades que quedan con roles críticos sin mapear, y código de salida 1 si queda alguna.
Añadir a package.json el script `"backfill:account-roles": "tsx scripts/backfill-account-roles.ts"`.

Documentar en /Users/victor/projects/Accounting/README.md (sección de despliegue/actualización) el orden: `npm run migrate` → `npm run backfill:account-roles` (seco) → revisar unmapped → `npm run backfill:account-roles -- --apply [--create-missing]` → `mnemosine doctor`.

**Archivos**

- `/Users/victor/projects/Accounting/scripts/backfill-account-roles.ts` — crear: backfill idempotente por entidad, seco por defecto, --apply/--create-missing/--tenant/--entity
- `/Users/victor/projects/Accounting/package.json` — modificar: añadir el script npm 'backfill:account-roles'
- `/Users/victor/projects/Accounting/README.md` — modificar: documentar el paso de backfill en el procedimiento de actualización, después de npm run migrate

**Criterios de aceptación**

- Dada una base con 3 entidades sin roles, cuando corre el script sin --apply, entonces no escribe ninguna fila (count de account_roles sin cambios) e imprime el diagnóstico de las 3.
- Dada esa base, cuando corre con --apply --create-missing, entonces las 3 entidades quedan con 31 roles y una segunda ejecución reporta 0 insertados.
- Dada una entidad cuya cuenta 1120 no existe y sin --create-missing, entonces el script deja 'cxc' en unmapped, lo marca como crítico y sale con código 1 sin haber creado ninguna cuenta.
- Dado que una entidad lanza TENANT_MISMATCH, entonces las otras se procesan igual y el resumen la lista como fallida.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/accounting/backfill-account-roles.spec.ts` — la función exportada runBackfill(opts, deps) con diagnose/ensure inyectados: sin --apply no invoca ensureEntityAccounting; con --apply y sin --create-missing pasa strategy 'map_only' y withBaseChart false; el código de salida es 1 si queda algún missingCritical

**Riesgo.** Escribir sobre bases de clientes. Mitigación: seco por defecto, --apply explícito, --create-missing separado, una transacción por entidad y todo idempotente por los índices únicos parciales de 018.

##### `E1.1-h` Prueba de extremo a extremo contra base real: entidad recién creada que postea · **M**

El E2E actual (/Users/victor/projects/Accounting/scripts/e2e-arap.ts:19-24) hardcodea TENANT/ENTITY/USER/CUSTOMER/VENDOR/PERIOD de una base de desarrollo concreta y LEE (líneas 45-49) roles que alguien insertó a mano: por construcción no puede detectar este bug. Crear /Users/victor/projects/Accounting/scripts/e2e-entity-bootstrap.ts, ejecutable con `npx tsx scripts/e2e-entity-bootstrap.ts`, que no hardcodea nada:
  1. Crea tenant, organización, usuario y legal_entity efímeros con uuidv4; enterTenant sobre el tenant nuevo.
  2. Crea el año fiscal y sus 12 periodos reutilizando la misma lógica que IdentidadSection.ensureFiscalYear (extraerla si hace falta a un helper exportado, o replicarla en el script).
  3. Llama ensureEntityAccounting y afirma: 52 cuentas, 31 roles, unmapped vacío.
  4. Crea una factura (invoices + invoice_lines) y llama postInvoiceEntry dentro de una withTransaction, y tras el commit dispara attestEntryAsync/drainAttestations igual que hace e2e-arap.ts, afirmando que el asiento existe, cuadra y usa las cuentas de los roles cxc/ingreso/iva_trasladado.
  5. Repite con un bill y postBillEntry (cxp/gasto/iva_acreditable).
  6. Limpia todo lo creado (borra en orden inverso: líneas, asientos, documentos, roles, cuentas, periodos, año, entidad, organización, usuario, tenant) y cierra con closeDatabase().
Salida con conteo de aserciones y código 1 si falla alguna, igual que los E2E existentes.

Este script es la única evidencia repetible de que el paquete cierra: el resto de tests corre con `query` mockeado y no ve el esquema real.

**Archivos**

- `/Users/victor/projects/Accounting/scripts/e2e-entity-bootstrap.ts` — crear: E2E autocontenido de alta de entidad → catálogo → roles → factura y bill posteados → limpieza
- `/Users/victor/projects/Accounting/package.json` — modificar: añadir el script npm 'e2e:bootstrap' apuntando al archivo (primer script e2e en package.json; hoy ninguno de los dos E2E existentes está declarado)

**Criterios de aceptación**

- Dado `npm run e2e:bootstrap` contra una base migrada, entonces todas las aserciones pasan y el proceso sale con código 0.
- Dado que el script terminó (con éxito o con fallo), entonces `SELECT count(*) FROM legal_entities WHERE name LIKE 'E2E Bootstrap%'` devuelve 0: no deja residuo.
- Dado que se revierte E1.1-d (se quita la llamada a ensureEntityAccounting del alta), entonces el paso 4 falla con MISSING_ROLE_ACCOUNT: la prueba detecta exactamente el bug que este paquete cierra.

**Riesgo.** Necesita una base real, así que no entra en `npm test` (vitest corre con mocks). Queda como comando manual documentado hasta que exista CI con base efímera (paquete de pruebas del roadmap).

#### Cómo se sabe que cerró

- `grep -rn "seedAccountRoles\|ensureEntityAccounting" /Users/victor/projects/Accounting/src` devuelve llamadores reales en src/cli/init/s1-identity.ts, src/cli/init/s2b-accounting.ts y src/cli/accounts-command.ts, no sólo la definición.
- Dado un tenant nuevo, `npm run mnemosine -- init --yes --entity "Cierre E1.1" --rfc XAXX010101000 --country MX` termina en código 0 y `SELECT count(*) FROM account_roles WHERE entity_id=<nueva> AND qualifier IS NULL` devuelve 31 (o el total que fije la decisión 2).
- `npm run mnemosine -- doctor` muestra '✔ Accounting roles  31/31 roles mapped in N entity(ies)' y sale con código 0; sobre una entidad sin sembrar, muestra '✘' con el fix 'mnemosine init --section accounting' y sale con código 1.
- `npm run e2e:bootstrap` pasa todas sus aserciones: una entidad creada en la corrida postea una factura y un bill sin MISSING_ROLE_ACCOUNT, y no deja residuo en la base.
- `grep -rn "init runs seedAccountRoles" /Users/victor/projects/Accounting/src` no devuelve nada.
- `npm run mnemosine -- accounts roles --json` devuelve un arreglo con missing = [] para toda entidad activa.
- `npm run backfill:account-roles` (seco) sobre una base con entidades preexistentes reporta 0 roles críticos faltantes tras el --apply, y una segunda pasada reporta 0 insertados.
- `npm test` verde (incluidos los nuevos tests/accounting/chart-seed.spec.ts, account-roles-seed.spec.ts, entity-bootstrap.spec.ts, ar-ap-posting.spec.ts, tests/cli/init/s2b-accounting.spec.ts y tests/cli/accounts-command.spec.ts) y `npx tsc --noEmit` en código 0.


### E1.2 · Un solo cerebro fiscal para el CFDI: el clasificador declarativo gobierna la ingesta
**Objetivo.** Que toda escritura contable originada en un CFDI pase por la capa declarativa (cfdi-facts → cfdi-taxonomy → cfdi-decisions → cfdi-classifier), de modo que el IVA de un CFDI PPD se registre en las cuentas puente 1135 / 2125 y solo se acredite o se cause al llegar el REP. Que la ruta viva deje de decidir contabilidad, que quede rastro en cfdi_classifications, y que los CFDI ya ingeridos con IVA mal acreditado se corrijan por reversa.

**Por qué aquí.** Es el error fiscal sistemático más caro del repositorio y ya está resuelto en código probado sin llamador: solo falta cablearlo. Va después de E1.1 porque el clasificador resuelve cuentas por account_roles y sin la siembra devolvería missingRoles para los 31 roles, y va antes del puente de políticas (E1.3), de la consulta real de estatus al SAT y del descargador masivo, porque los tres alimentan a este clasificador y no tienen dónde enchufarse mientras no exista el punto de entrada.

**Depende de:** `E0.1`, `E1.1` · **Migraciones:** `035-039` · **10 tareas · 6.9 sem-persona**

**Precondiciones:**

- E1.1 cerrado: seedAccountRoles (src/services/xml-ingestion/account-roles-seed.ts:170) corre desde `mnemosine init` y account_roles tiene las 31 filas de ROLE_MAP para la entidad. Verificado: los 31 códigos de ROLE_MAP existen entre el catálogo de src/database/seed.ts:75-116 y los 14 REQUIRED_ACCOUNTS que la propia siembra crea, así que `unmapped` debe salir vacío.
- La base tiene aplicadas las migraciones hasta 030 y src/database/rls-policies.sql se reaplica tras cada migración nueva (cfdi_classifications y account_roles llevan tenant_id, así que el bucle genérico de rls-policies.sql las cubre sin necesidad de política hija).
- Existe al menos un fixture de CFDI PPD, uno PUE, uno REP (tipo P con complemento Pagos) y una nota de crédito en tests/fixtures/cfdi (hoy el directorio existe; si falta alguno, se crea en E1.2-j).

#### Decisiones a resolver

**Con el clasificador cableado, ¿el CFDI cuyo veredicto es 'ready' se contabiliza de forma determinista sin pasar por el modelo, o sigue generando un ai_draft para revisión humana?**

Hoy la ruta de `mnemosine ingest` manda al modelo todo lo que las reglas no auto-procesaron (ingest-service.ts:144-152) y el draft se aprueba por umbrales de confianza/importe (165-221). Con el clasificador, un CFDI 'ready' ya tiene caso, cuentas por rol y póliza cuadrada: el modelo no aporta criterio, solo latencia, costo y una fuente de discrepancia. Pero eliminar la revisión humana de un plumazo cambia el perfil de riesgo del producto, y los umbrales (FLOOR_MAX_AUTO_POST incluido, floor.ts) están diseñados alrededor del draft.

- A: 'ready' se postea directamente cuando processing_mode='auto' y no requiere aprobación; el modelo solo interviene en needs_input y para explicar. Los umbrales de importe se aplican igual al posteo determinista.
- B: 'ready' genera un ai_draft prellenado con las líneas del clasificador (confidence fija 1.0, reasoning = case.label + notes) y sigue el flujo actual de `mnemosine review`.
- C: híbrido por importe: por debajo del cap del piso se postea directo; por encima, draft.

_Recomendación:_ C. Conserva la garantía que el producto ya prometió (nada grande se contabiliza solo) sin pagar un turno de modelo por cada factura de luz, y reutiliza floorMaxAutoAmount tal cual. Si hay que elegir entre A y B, A: mantener un draft para algo que el sistema ya decidió de forma determinista genera revisiones que el humano aprueba sin mirar, que es peor que no tenerlas.

_Bloquea:_ E1.2-e (rama 'ready' de processXMLUpload), E1.2-f (recorte de ingest-service.classify) y E1.2-i (qué le pide el prompt al modelo)

**Un CFDI EMITIDO (la entidad es el emisor) que hoy se pre-registra siempre como factura de proveedor: ¿debe crear también la fila en `invoices`, o solo la póliza?**

createPreRegistration (pre-registration-service.ts:192-193) fija document_type 'bill' o 'credit_note' según tipoDeComprobante y matchVendor (210) siempre toma al EMISOR como proveedor. Con extractFacts la dirección ya se conoce. El módulo de ventas tiene su propia alta de invoices y su propio timbrado; crear invoices desde la ingesta puede duplicar documentos que el usuario ya capturó por la otra vía.

- A: solo póliza. El CFDI emitido se contabiliza y se registra en cfdi_classifications, pero no crea invoices; si el usuario ya facturó por el módulo de ventas, la ingesta detecta el duplicado por cfdi_uuid y no postea.
- B: crear invoices cuando no exista una con ese cfdi_uuid, con customer resuelto o creado desde el receptor.
- C: rechazar los emitidos en la ingesta (verdict blocked con razón explícita) hasta tener el módulo de ventas conciliado.

_Recomendación:_ A, con la comprobación previa de duplicado contra invoices.cfdi_uuid. Contabilizar la venta es correcto y necesario (hoy se contabiliza como compra, que es peor que cualquier opción); crear el documento auxiliar duplica el trabajo del módulo de ventas y ese enganche merece su propio paquete.

_Bloquea:_ E1.2-d (paso 3: qué documento auxiliar se crea) y E1.2-e

**En la remediación del histórico, ¿qué universo se corrige y con qué fecha se reversa?**

El detector encuentra pólizas de CFDI PPD con IVA cargado a 1130. Reversar y recontabilizar mueve saldos de periodos que pueden estar ya declarados ante el SAT (DIOT, pago mensual de IVA). E1.2-h excluye por defecto los periodos en hard_close o locked, pero un periodo soft-closed sigue siendo modificable y aun así ya pudo declararse.

- A: solo ejercicio fiscal en curso y periodos abiertos; el histórico anterior se lista pero no se toca.
- B: todo lo que no esté en hard_close/locked, con reversa en la fecha original.
- C: todo, incluidos periodos cerrados, reversando en el periodo abierto más antiguo (no en la fecha original) para no alterar meses ya declarados.

_Recomendación:_ A por defecto, con --desde para que el contador amplíe el universo conscientemente, y siempre reversando en la fecha del asiento original. La corrección de un periodo ya declarado implica presentar complementarias: eso lo decide el despacho, y el comando debe entregarle la cifra exacta de IVA movido por mes para que pueda hacerlo.

_Bloquea:_ E1.2-h (filtro del detector, fecha de la reversa y semántica de --desde)

**El rol 'gasto' apunta a 6100 'Gastos de Administración', que en el catálogo sembrado tiene hijos (6110-6140), y tres retenciones distintas (isr_retenido_por_pagar, iva_retenido_por_pagar, isr_nomina_por_pagar) comparten la cuenta 2140. ¿Se acepta para este paquete o se abre el soporte de qualifiers?**

ROLE_MAP (account-roles-seed.ts:119-157) es un mapeo 1-a-1 sin qualifier, aunque account_roles ya admite la columna. Con las tres retenciones en 2140 no se puede conciliar el entero de cada una por separado, y postear al padre 6100 degrada el estado de resultados por naturaleza. Ninguna de las dos cosas impide que el IVA de PPD quede bien registrado, que es el objetivo de este paquete.

- A: aceptar tal cual; abrir un paquete propio para desdoblar cuentas y qualifiers.
- B: desdoblar solo las retenciones (2141 ISR retenido por pagar, 2142 IVA retenido por pagar, 2143 ISR nómina por pagar) dentro de E1.1/E1.2, añadiéndolas a REQUIRED_ACCOUNTS.
- C: implementar qualifiers completos (rol + clave de producto / RFC de proveedor) en este paquete.

_Recomendación:_ B para las retenciones —son tres impuestos con enteros y plazos distintos, y separar es un cambio de tres filas en REQUIRED_ACCOUNTS más tres en ROLE_MAP— y A para el 6100 y los qualifiers. C infla este paquete sin tocar el error fiscal que motiva el trabajo.

_Bloquea:_ E1.2-d (qué cuenta recibe cada retención) y el criterio de aceptación de la póliza PUE con retenciones

**Cuando llega un REP sin ImpuestosDR y sin clasificación previa de la factura relacionada, ¿qué hace el sistema con el IVA?**

El prorrateo necesita el IVA y el total de la factura original. Si el REP llega antes que su factura —muy habitual cuando el descargador masivo del SAT trae un lote— no hay contra qué prorratear. Las opciones difieren en si el pago se contabiliza aunque el traspaso de IVA quede pendiente.

- A: contabilizar el pago (DR cxp / CR banco) y dejar el traspaso de IVA pendiente, con warning y una entrada en la cola de `mnemosine cfdi pendientes` que se resuelve sola cuando la factura se ingiera.
- B: verdict 'needs_input' y no contabilizar nada hasta tener la factura.
- C: preguntar al humano el monto del IVA pagado con una decisión nueva.

_Recomendación:_ A. El pago ocurrió y omitirlo distorsiona el banco y el saldo del proveedor; el IVA pendiente de traspasar es un dato recuperable y rastreable. Requiere un pequeño barrido: al clasificar una factura PPD, comprobar si ya existe un REP registrado que la referencie y, si lo hay, generar entonces el asiento de traspaso. Esa reconciliación diferida encaja de forma natural en el runtime de trabajos en segundo plano cuando exista.

_Bloquea:_ E1.2-g (paso 1c) y el criterio de aceptación 'REP contra factura sin clasificación previa'

#### Tareas

##### `E1.2-a` El parser emite los complementos que las capas superiores ya presuponen (ImpuestosLocales, Terceros, ImpuestosDR) · **S**

CFDIParser.parseComplementos (src/services/xml-ingestion/cfdi-parser.ts, método privado que hoy solo empuja TimbreFiscalDigital, Pagos y Nomina) descarta todo lo demás. Consecuencias verificadas: (1) extractImpuestosLocales (cfdi-facts.ts:237) busca `complementos.find(x => x.type === 'ImpuestosLocales')` y siempre devuelve {0,0}; (2) la decisión por_cuenta_terceros (cfdi-decisions.ts:245) evalúa `f.complementos.includes('Terceros')` y nunca dispara; (3) extractPagos (cfdi-facts.ts:248) lee IdDocumento/ImpPagado/ImpSaldoAnt pero NO lee ImpuestosDR, que es el dato exacto del IVA pagado que necesita el asiento del REP.

Cambios:
1. En parseComplementos, tras los tres bloques existentes, añadir el volcado genérico: para cada clave K de complementoNode que no sea 'TimbreFiscalDigital' | 'Pagos' | 'Nomina', empujar `{ type: K, data: complementoNode[K] as Record<string, unknown> }`. Con removeNSPrefix:true el nodo `implocal:ImpuestosLocales` llega como 'ImpuestosLocales' y `terceros:PorCuentadeTerceros` como 'PorCuentadeTerceros'.
2. Como el nombre real del complemento de terceros es 'PorCuentadeTerceros' (no 'Terceros'), corregir el predicado de la decisión: en cfdi-decisions.ts:256 sustituir `f.complementos.includes('Terceros')` por `f.complementos.some(c => c === 'Terceros' || c === 'PorCuentadeTerceros')`.
3. En cfdi-facts.ts, ampliar la interfaz DoctoRelacionado con `ivaTrasladadoDR?: number` y `monedaDRTipoCambio?: number`, y en extractPagos leer, por cada DoctoRelacionado, el nodo ImpuestosDR > TrasladosDR > TrasladoDR (uno o varios) sumando `@_ImporteDR` de los que tengan `@_ImpuestoDR` normalizado a '002' con la misma función clave(v,3) que ya existe en el archivo. Si no hay ImpuestosDR, dejar el campo en undefined (NO en 0: el asiento del REP distingue «no venía» de «venía en cero»).
4. extractImpuestosLocales sigue igual; ahora sí encuentra el complemento y devuelve TotaldeTraslados/TotaldeRetenciones.

Efecto colateral que hay que atender en la misma tarea: CFDIParser.validate (cfdi-parser.ts:289) calcula `subTotal − descuento + totalImpuestosTrasladados − totalImpuestosRetenidos` y compara contra Total con tolerancia 0.01. Un CFDI con ISH falla ahí ANTES de llegar al clasificador y processXMLUpload lo rechaza con ValidationError. Sumar los impuestos locales a ese cálculo: leer el complemento ya parseado y añadir `+ trasladados − retenidos`.

**Archivos**

- `src/services/xml-ingestion/cfdi-parser.ts` — modificar: parseComplementos vuelca los complementos restantes por nombre; validate() suma los impuestos locales al total calculado
- `src/services/xml-ingestion/cfdi-facts.ts` — modificar: DoctoRelacionado gana ivaTrasladadoDR; extractPagos lee ImpuestosDR/TrasladosDR/TrasladoDR
- `src/services/xml-ingestion/cfdi-decisions.ts` — modificar: el predicado applies de por_cuenta_terceros acepta 'PorCuentadeTerceros'

**Criterios de aceptación**

- Dado un CFDI con complemento implocal:ImpuestosLocales de 3.00 de ISH, cuando se parsea, entonces parsed.complementos contiene {type:'ImpuestosLocales'} y facts.impuestosLocalesTrasladados === 3
- Dado ese mismo CFDI, cuando corre CFDIParser.validate, entonces valid === true (hoy devuelve 'Total calculation mismatch')
- Dado un REP cuyo DoctoRelacionado trae ImpuestosDR con TrasladoDR ImpuestoDR='002' ImporteDR=160.00, cuando se extraen los hechos, entonces docsRelacionados[0].ivaTrasladadoDR === 160
- Dado un REP sin nodo ImpuestosDR, entonces docsRelacionados[0].ivaTrasladadoDR === undefined
- Dado un CFDI con complemento PorCuentadeTerceros, cuando se piden las decisiones aplicables, entonces la lista incluye por_cuenta_terceros

**Pruebas**

- `tests/xml-ingestion/cfdi-parser-validate.spec.ts` — CFDI con ImpuestosLocales: valid===true y el complemento aparece en parsed.complementos
- `tests/xml-ingestion/cfdi-facts.spec.ts` — extractPagos lee ImpuestosDR (uno y varios TrasladoDR); ausencia de ImpuestosDR deja undefined; ISH llega a impuestosLocalesTrasladados
- `tests/xml-ingestion/cfdi-taxonomy.spec.ts` — por_cuenta_terceros dispara con el complemento PorCuentadeTerceros

**Riesgo.** El volcado genérico de complementos mete en `complementos` nombres nuevos que el clasificador no espera; como solo se usan por `type` en dos sitios (extractImpuestosLocales y la decisión de terceros) el riesgo es nulo, pero conviene no serializar `data` completo hacia cfdi_classifications.facts (E1.2-c ya guarda solo CfdiFacts, que lleva únicamente los nombres).

##### `E1.2-b` Migración 031: el rastro de clasificación guarda el veredicto, las líneas propuestas y el vínculo con las preguntas · **S**

cfdi_classifications existe desde 015_account_roles.sql:37 y está vacía. Su CHECK de status admite ('pending','ready','blocked','posted','skipped'), que no cubre los cuatro veredictos del clasificador (ready | needs_input | no_posting | blocked) ni el resultado de la clasificación (líneas propuestas, roles faltantes, advertencias).

Crear src/database/migrations/031_cfdi_classification_trail.sql con, en una sola transacción:
1. ALTER TABLE cfdi_classifications ADD COLUMN verdict VARCHAR(20) CHECK (verdict IN ('ready','needs_input','no_posting','blocked'));
2. ADD COLUMN proposed_lines JSONB NOT NULL DEFAULT '[]' — las ProposedLine tal cual las devuelve el clasificador (role, accountCode, accountName, debit, credit, description).
3. ADD COLUMN missing_roles JSONB NOT NULL DEFAULT '[]', ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]', ADD COLUMN linkage JSONB NOT NULL DEFAULT '[]'.
4. ADD COLUMN pre_registration_id UUID REFERENCES pre_registrations(id), ADD COLUMN bill_id UUID REFERENCES bills(id).
5. ADD COLUMN sat_status VARCHAR(20), ADD COLUMN classifier_version VARCHAR(20) NOT NULL DEFAULT '1' — el número de versión de la taxonomía con que se clasificó, para poder reclasificar selectivamente en el futuro.
6. ADD COLUMN posted_at TIMESTAMPTZ, ADD COLUMN reclassified_from UUID REFERENCES cfdi_classifications(id) — apunta a la clasificación anterior cuando E1.2-h vuelve a clasificar un CFDI ya contabilizado mal.
7. Ampliar el CHECK de status: DROP CONSTRAINT del check existente (nombre generado por Postgres: localizarlo con `SELECT conname FROM pg_constraint WHERE conrelid='cfdi_classifications'::regclass AND contype='c'` y hacerlo por DO $$ dinámico, o directamente `ALTER TABLE cfdi_classifications DROP CONSTRAINT IF EXISTS cfdi_classifications_status_check`) y recrear con ('pending','ready','blocked','posted','skipped','needs_input','no_posting','superseded').
8. Índice nuevo: CREATE INDEX idx_cfdi_class_verdict ON cfdi_classifications(entity_id, verdict) WHERE verdict IN ('needs_input','blocked'); — es la cola de revisión humana.
9. Índice de idempotencia del REP: CREATE INDEX idx_cfdi_class_uuid ON cfdi_classifications(cfdi_uuid); (la UNIQUE existente es (entity_id, cfdi_uuid) y no sirve para buscar la factura relacionada sin conocer la entidad… aunque el buscador siempre pasa entity_id, el índice de la UNIQUE ya cubre ese caso; este índice adicional solo se crea si el plan de E1.2-g lo necesita — dejarlo fuera si no).
10. Tabla puente de decisiones→preguntas: CREATE TABLE cfdi_classification_questions ( id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID NOT NULL, entity_id UUID NOT NULL REFERENCES legal_entities(id), classification_id UUID NOT NULL REFERENCES cfdi_classifications(id) ON DELETE CASCADE, decision_id VARCHAR(60) NOT NULL, question_id UUID NOT NULL REFERENCES ai_questions(id), severity VARCHAR(10) NOT NULL CHECK (severity IN ('blocking','advisory')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (classification_id, decision_id) ). Lleva tenant_id, así que el bucle genérico de rls-policies.sql la cubre.

Tras aplicar la migración hay que reaplicar src/database/rls-policies.sql (convención del repo).

**Archivos**

- `src/database/migrations/031_cfdi_classification_trail.sql` — crear: columnas de veredicto/líneas/vínculos en cfdi_classifications, ampliación del CHECK de status, índice de cola humana y tabla cfdi_classification_questions

**Migración**

```sql
ALTER TABLE cfdi_classifications ADD COLUMN verdict VARCHAR(20) CHECK (verdict IN ('ready','needs_input','no_posting','blocked')), ADD COLUMN proposed_lines JSONB NOT NULL DEFAULT '[]', ADD COLUMN missing_roles JSONB NOT NULL DEFAULT '[]', ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]', ADD COLUMN linkage JSONB NOT NULL DEFAULT '[]', ADD COLUMN pre_registration_id UUID REFERENCES pre_registrations(id), ADD COLUMN bill_id UUID REFERENCES bills(id), ADD COLUMN sat_status VARCHAR(20), ADD COLUMN classifier_version VARCHAR(20) NOT NULL DEFAULT '1', ADD COLUMN posted_at TIMESTAMPTZ, ADD COLUMN reclassified_from UUID REFERENCES cfdi_classifications(id); ALTER TABLE cfdi_classifications DROP CONSTRAINT IF EXISTS cfdi_classifications_status_check; ALTER TABLE cfdi_classifications ADD CONSTRAINT cfdi_classifications_status_check CHECK (status IN ('pending','ready','blocked','posted','skipped','needs_input','no_posting','superseded')); CREATE INDEX idx_cfdi_class_verdict ON cfdi_classifications(entity_id, verdict) WHERE verdict IN ('needs_input','blocked'); CREATE TABLE cfdi_classification_questions (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID NOT NULL, entity_id UUID NOT NULL REFERENCES legal_entities(id), classification_id UUID NOT NULL REFERENCES cfdi_classifications(id) ON DELETE CASCADE, decision_id VARCHAR(60) NOT NULL, question_id UUID NOT NULL REFERENCES ai_questions(id), severity VARCHAR(10) NOT NULL CHECK (severity IN ('blocking','advisory')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (classification_id, decision_id));
```

**Criterios de aceptación**

- Dado `npm run migrate` sobre una base al día en 030, cuando termina, entonces `\d cfdi_classifications` muestra verdict, proposed_lines, missing_roles, warnings, linkage, pre_registration_id, bill_id, sat_status, classifier_version, posted_at y reclassified_from
- Dado un INSERT con status='needs_input', entonces no viola ningún CHECK
- Dado que se reaplica src/database/rls-policies.sql, cuando se consulta cfdi_classification_questions con un tenant distinto en el contexto, entonces devuelve cero filas

**Pruebas**

- `tests/database/migrations-contract.spec.ts` — las columnas y el CHECK de status de cfdi_classifications coinciden con los que consulta cfdi-classification-service.ts (si E1.4 aún no existe, dejar un test que lea el .sql y verifique la presencia de los nombres de columna)

**Riesgo.** El nombre del CHECK de status lo generó Postgres al crear la tabla en 015; si en alguna base no se llama cfdi_classifications_status_check el DROP IF EXISTS no hace nada y el INSERT de 'needs_input' falla en producción. Mitigación: hacer el DROP por DO $$ que busque en pg_constraint por conrelid y contype='c' con pg_get_constraintdef ILIKE '%status%'.

##### `E1.2-c` Servicio orquestador: reunir el contexto del clasificador, clasificar y persistir el rastro · **L**

Crear src/services/xml-ingestion/cfdi-classification-service.ts. Es la única puerta por la que el resto del sistema habla con el clasificador; classifyParsed/classifyXml (cfdi-classifier.ts:97/92) siguen siendo funciones puras que no escriben nada.

Firma principal:

  export interface ClassificationContext { entityId: string; tenantId: string; entityRfc: string; }
  export interface ClassifiedCfdi { classificationId: string; classification: Classification; answers: Record<string,string>; }
  export async function classifyAndRecord(ctx: ClassificationContext, parsed: CFDIParsed, opts: { xmlDocumentId: string; preRegistrationId?: string; client?: pg.PoolClient }): Promise<ClassifiedCfdi>

Orden de operaciones dentro de classifyAndRecord:
1. `const facts = extractFacts(parsed, ctx.entityRfc)` — se necesitan los hechos ANTES de clasificar para poder resolver el contexto. entityRfc sale de legal_entities.tax_id (AgentContext.taxId ya lo expone; en la ruta REST hay que leerlo con `SELECT tax_id FROM legal_entities WHERE id=$1`). Si tax_id_type !== 'rfc', lanzar AccountingError('ENTITY_NOT_MEXICAN', ...): sin RFC no hay dirección y todo CFDI saldría 'ajeno'.
2. roleMap: reutilizar la consulta de loadRoleMap (cfdi-classifier.ts:66) pasándola por opts.client si viene, o dejar que el clasificador la cargue.
3. vendorExists: `SELECT 1 FROM vendors WHERE entity_id=$1 AND tax_id=$2 AND is_active=true` con facts.emisorRfc, SOLO cuando facts.direction === 'recibido'.
4. periodOpen: `SELECT 1 FROM fiscal_periods WHERE entity_id=$1 AND start_date<=$2 AND end_date>=$2 AND status NOT IN ('hard_close','locked')` con facts.fecha. Es la misma condición que createJournalEntry (posting.ts:90-97): si aquí sale abierto y allá cerrado, el asiento reventaría después.
5. satStatus: leer xml_documents.sat_validation_status del documento (columna del CHECK 'pending'|'valid'|'cancelled'|'not_found'|'error', migración 005_xml_ingestion.sql:68) y mapear: valid→'vigente', cancelled→'cancelado', not_found→'no_encontrado', y pending|error|NULL→'sin_validar'. NOTA para quien implemente: SATValidationService.validate (sat-validation.ts:25) hoy devuelve 'valid' solo si PAC_ENVIRONMENT==='sandbox' y 'error' en cualquier otro caso; por tanto en producción satStatus será siempre 'sin_validar' y el clasificador emitirá su advertencia. Es lo correcto y no se disimula: la consulta real al SAT es otro paquete.
6. answers: resolver por precedente. Para cada DecisionPoint que `decisionsFor(facts, thresholds)` devuelva y que el caso incluya, calcular su `topic(facts)` y buscar en ai_questions `WHERE entity_id=$1 AND topic=$2 AND status='answered' AND is_precedent=true ORDER BY answered_at DESC LIMIT 1`. Si la respuesta coincide con alguno de los `options[].value` de esa decisión, entra en `answers[d.id]`. Si no coincide (respuesta en texto libre), NO se usa: la decisión queda pendiente. Esto es lo que cierra la brecha «las respuestas no se persisten como precedentes desde ningún sitio de este subsistema»: la respuesta ya la persiste answerQuestion (question-service.ts:60), lo que faltaba era leerla.
7. thresholds: parámetro opcional `opts.thresholds`. En este paquete se pasa DEFAULT_THRESHOLDS (cfdi-decisions.ts:62). El puente con getPolicy/getPolicyNumber es E1.3; dejar el parámetro en la firma y un comentario que lo nombre, no un TODO mudo.
8. `const classification = await classifyParsed(parsed, { entityId, entityRfc, roleMap, vendorExists, periodOpen, satStatus, answers, thresholds })`.
9. Ajuste de enlace PPD (implementa lo que la taxonomía documenta y no ejecuta, cfdi-taxonomy.ts:269-272): si el caso es 'egreso_recibido_nota_credito' o 'egreso_emitido_nota_credito' y hay linkage, buscar la clasificación de cada UUID relacionado (`SELECT facts, case_id FROM cfdi_classifications WHERE entity_id=$1 AND cfdi_uuid=$2`). Si la factura original fue PPD (facts->>'metodoPago' = 'PPD'), remapear en classification.lines el role 'iva_acreditable'→'iva_pendiente_acreditar' (recibido) o 'iva_trasladado'→'iva_trasladado_no_cobrado' (emitido), volviendo a resolver accountCode/accountName contra el roleMap. Si NO se encuentra la clasificación original, añadir a warnings: «No se localizó la clasificación de la factura relacionada <uuid>: el IVA de la nota de crédito se revierte contra la cuenta de IVA acreditable/trasladado; verifícalo si la original era PPD.» y NO cambiar el veredicto.
10. Persistir con UPSERT (idempotente frente a reintentos): INSERT INTO cfdi_classifications (tenant_id, entity_id, xml_document_id, pre_registration_id, cfdi_uuid, tipo_comprobante, direction, case_id, facts, decisions, proposed_lines, missing_roles, warnings, linkage, verdict, status, blocked_reason, sat_status, classifier_version) VALUES (...) ON CONFLICT (entity_id, cfdi_uuid) DO UPDATE SET ... RETURNING id. case_id cuando `classification.case` es null: usar la cadena 'sin_caso' (la columna es NOT NULL). El mapeo verdict→status es: ready→'ready', needs_input→'needs_input', no_posting→'no_posting', blocked→'blocked'. blocked_reason = classification.reason cuando el veredicto es blocked o needs_input.
11. Devolver { classificationId, classification, answers }.

Segunda función exportada, para la cola humana:

  export async function markClassificationPosted(client: pg.PoolClient, classificationId: string, journalEntryId: string, billId: string | null): Promise<void>

que hace UPDATE ... SET status='posted', journal_entry_id=$2, bill_id=$3, posted_at=NOW(), updated_at=NOW() y corre SIEMPRE sobre el cliente de la transacción que posteó el asiento.

**Archivos**

- `src/services/xml-ingestion/cfdi-classification-service.ts` — crear: classifyAndRecord, markClassificationPosted, resolución de contexto (vendorExists, periodOpen, satStatus, precedentes) y el ajuste de nota de crédito sobre factura PPD
- `src/services/xml-ingestion/cfdi-classifier.ts` — modificar: loadRoleMap acepta un pg.PoolClient opcional para poder correr dentro de la transacción del llamador (hoy usa siempre query())

**Criterios de aceptación**

- Dado un CFDI recibido tipo I con MetodoPago=PPD e IVA 16 de 1600, cuando corre classifyAndRecord, entonces classification.lines contiene una línea con role 'iva_pendiente_acreditar' y accountCode '1135', y ninguna con role 'iva_acreditable'
- Dado el mismo CFDI pero con MetodoPago=PUE, entonces la línea de IVA lleva role 'iva_acreditable' y accountCode '1130'
- Dado un CFDI emitido (emisorRfc === entityRfc) PPD, entonces hay una línea credit con role 'iva_trasladado_no_cobrado' y accountCode '2125'
- Dado un CFDI cuyo emisor no está en vendors, entonces classification.decisions incluye 'proveedor_nuevo' con severity 'blocking' y el veredicto es 'needs_input'
- Dado que existe en ai_questions una respuesta 'activo_fijo' con topic 'clasificacion_desembolso:<RFC>' marcada is_precedent, cuando llega otro CFDI de ese emisor por encima del umbral, entonces la decisión gasto_vs_activo NO aparece en decisions y la línea de gasto sale con role 'activo_fijo'
- Dado que se clasifica el mismo cfdi_uuid dos veces, entonces cfdi_classifications tiene exactamente una fila para (entity_id, cfdi_uuid) y su contenido es el de la segunda corrida
- Dada una nota de crédito recibida cuyo docsRelacionados apunta a una factura PPD ya clasificada, entonces la línea de reversión de IVA lleva role 'iva_pendiente_acreditar'

**Pruebas**

- `tests/xml-ingestion/cfdi-classification-service.spec.ts` — resolución de answers por precedente (coincide con option.value / no coincide); mapeo verdict→status; UPSERT idempotente; ajuste de nota de crédito con y sin clasificación original

**Riesgo.** La búsqueda de precedentes por topic exacto puede reutilizar una respuesta vieja que ya no refleje el criterio del despacho. Mitigación: la consulta ordena por answered_at DESC (el criterio más reciente gana, igual que searchPrecedents en question-service.ts:140) y la clasificación guarda en `decisions` qué respuesta se aplicó y de qué pregunta vino, de modo que la revisión humana lo ve.

##### `E1.2-d` postClassification: la póliza se arma con las líneas del clasificador, en una sola transacción y con reversa como única corrección · **L**

Crear src/services/xml-ingestion/cfdi-posting.ts con:

  export interface PostResult { journalEntry: JournalEntry; billId: string | null; attest: { tenantId: string; entityId: string; entryId: string } | null; }
  export async function postClassificationInTx(client: pg.PoolClient, ctx: ClassificationContext, c: ClassifiedCfdi, opts: { xmlDocumentId: string; preRegistrationId?: string; userId: string }): Promise<PostResult>
  export async function postClassification(ctx, c, opts): Promise<PostResult>   // abre withTransaction, llama a la anterior y dispara attestEntryAsync tras el commit

postClassificationInTx, en este orden:
1. Rechazar si `c.classification.verdict !== 'ready'` con AccountingError('CFDI_NOT_READY', `El CFDI ${uuid} no está listo para contabilizar: ${reason}`). El llamador nunca debe llegar aquí con otro veredicto.
2. Idempotencia: `SELECT journal_entry_id FROM cfdi_classifications WHERE id=$1 FOR UPDATE`; si ya tiene asiento, devolverlo sin escribir nada (misma disciplina que postInvoiceEntry, ar-ap-posting.ts:64).
3. Documento auxiliar. Solo cuando `facts.direction === 'recibido' && facts.tipo === 'I' && !facts.esAnticipo`: crear la fila en bills. El proveedor se resuelve por `SELECT id FROM vendors WHERE entity_id=$1 AND tax_id=$2` con facts.emisorRfc; si no existe y la respuesta a 'proveedor_nuevo' fue 'crear', insertarlo. Numeración: `nextEntityNumber(client, entityId, 'vendor', 'V')` y `nextEntityNumber(client, entityId, 'bill', 'BILL')` (src/utils/sequence.ts:12) — esto reemplaza los dos COUNT(*)+1 con carrera de pre-registration-service.ts:497-502 y 516-521. bills.status = 'posted', amount_due = total_amount. NO se insertan bill_lines con cuenta adivinada: las cuentas contables las decide el clasificador; bill_lines se llena con las líneas del CFDI (descripcion, cantidad, valor_unitario, importe) y account_id = la cuenta de la línea 'gasto'/'inventario'/'activo_fijo' que el clasificador ya resolvió (una sola, la que corresponda al roleOverride efectivo).
4. Póliza. Traducir c.classification.lines a JournalEntryLineInput: `account_id` se obtiene por código con un solo SELECT `SELECT id, code FROM accounts WHERE entity_id=$1 AND code = ANY($2)`; si algún accountCode es null (no debería, porque verdict='ready' exige missingRoles vacío) lanzar AccountingError('MISSING_ROLE_ACCOUNT', ...). debit_amount/credit_amount se pasan como string con toFixed(4) (es lo que espera createJournalEntry). description = ProposedLine.description.
5. `const entry = await createJournalEntry(entityId, facts.fecha, tipoDeAsiento, descripcion, jeLines, userId, { autoPost: true, client, sourceType, sourceId, reference })` donde:
   - tipoDeAsiento: JournalEntryType.AUTO_BILL para direction 'recibido', JournalEntryType.AUTO_INVOICE para 'emitido' (son los valores que el código ya usa; AUTO_PAYMENT para los CFDI tipo P de E1.2-g).
   - descripcion: `${case.label} · ${serieFolio} · ${emisorNombre}` recortada a 255.
   - sourceType/sourceId: 'bill'/billId si se creó bill; si no, 'cfdi'/xmlDocumentId.
   - reference: el UUID del CFDI. Es la clave que usará el detector de E1.2-h.
6. Si se creó bill: `UPDATE bills SET journal_entry_id=$1 WHERE id=$2`.
7. `await markClassificationPosted(client, classificationId, entry.id, billId)`.
8. Devolver también el descriptor de attest; postClassification (la variante que abre la transacción) llama a attestEntryAsync(tenantId, entityId, entry.id) DESPUÉS del commit, nunca dentro.

Esto sustituye funcionalmente a createBillFromPreReg (pre-registration-service.ts:480), que además de acreditar siempre el IVA corre entero en autocommit sin transacción. createBillFromPreReg se ELIMINA en E1.2-e; no se deja como fallback: dos rutas es exactamente el problema que este paquete cierra.

**Archivos**

- `src/services/xml-ingestion/cfdi-posting.ts` — crear: postClassificationInTx y postClassification
- `src/services/xml-ingestion/pre-registration-service.ts` — modificar: se elimina createBillFromPreReg (líneas 480-633) y su uso de los códigos literales '2110' y '1130'

**Criterios de aceptación**

- Dado un CFDI PPD recibido de 10 000 + 1 600 de IVA, cuando se contabiliza, entonces la póliza tiene débito 10 000 en 6100 (o la cuenta del rol efectivo), débito 1 600 en 1135 y crédito 11 600 en 2110, y NINGUNA línea toca 1130
- Dado un CFDI PUE recibido con ISR retenido de 1 000 e IVA retenido de 1 066.67, cuando se contabiliza, entonces la póliza cuadra y contiene las dos líneas de retención acreditadas contra el rol correspondiente (hoy esa póliza sale descuadrada y el validador la rechaza)
- Dado que se llama dos veces a postClassification con la misma clasificación, entonces solo existe una fila en journal_entries con ese reference y la segunda llamada devuelve la misma entrada
- Dado un fallo al insertar bill_lines, entonces no queda ni bill ni journal_entry ni cfdi_classifications.status='posted' (todo en una transacción)
- Dados dos posteos concurrentes en la misma entidad, entonces los bill_number generados son distintos (nextEntityNumber, no COUNT(*))
- Dado un CFDI de anticipo recibido, entonces NO se crea fila en bills y la póliza carga 1150 Anticipo a Proveedores

**Pruebas**

- `tests/xml-ingestion/cfdi-posting.spec.ts` — traducción líneas→JournalEntryLineInput; rechazo si verdict≠ready; idempotencia por journal_entry_id; que attestEntryAsync se invoca después del commit y no dentro (espía sobre posting.js)
- `tests/accounting/posting.spec.ts` — createJournalEntry con options.client no abre transacción propia ni dispara attest (si E1.5 no lo cubre ya)

**Riesgo.** El rol 'gasto' de ROLE_MAP apunta a 6100 'Gastos de Administración', que en el catálogo sembrado (seed.ts:110) TIENE hijos (6110-6140) aunque no esté marcado is_header. Postear al padre no rompe nada hoy, pero degrada los reportes por naturaleza. No es trabajo de este paquete cambiarlo; anotarlo en la decisión sobre qualifiers.

##### `E1.2-e` Cablear el clasificador dentro de processXMLUpload y reducir el motor de reglas a lo que sí le toca · **M**

processXMLUpload (pre-registration-service.ts:43) queda así — se conserva TODO lo que es registro y enrutamiento, se retira lo que es contabilidad:

SE CONSERVA sin cambios: parse + validate (55-59), hash y dedupe por cfdi_uuid/xml_hash con DuplicateError (61-71), el INSERT en xml_documents y en xml_document_lines (77-128), el disparo no bloqueante de satValidator.validateAndUpdate (135), createPreRegistration (140) y su emparejamiento de proveedor por RFC/trigram (matchVendor, 210).

SE CONSERVA CON MATIZ el motor de reglas (getRulesForEntity 351 + rulesEngine.evaluate 144 + applyRuleActions 367): sigue decidiendo processing_mode (auto|manual|batch), requires_approval, batch_priority, tags y reject/reject_reason. Lo que YA NO decide es la cuenta contable: la acción `set_account` deja de escribirse en pre_registrations.lines[].account_id como cuenta de la póliza y pasa a interpretarse como QUALIFIER del rol 'gasto' — es decir, se guarda en pre_registrations.default_account_id (como hoy) y postClassification, si esa columna trae una cuenta, la usa en lugar de la cuenta del rol 'gasto' para la línea de gasto, dejando intactas las demás líneas (IVA, retenciones, CxP). Esa es la única forma de que una regla del despacho («todo lo de CFE va a 6130») siga funcionando sin volver a decidir el tratamiento del IVA.

SE SUSTITUYE el bloque 152-166. Nuevo flujo tras applyRuleActions:
1. `const classified = await classifyAndRecord(ctx, parsed, { xmlDocumentId: xmlDocId, preRegistrationId: preReg.id })`.
2. Según classified.classification.verdict (el detalle de cada rama está en E1.2-f):
   - 'ready' y updated.processing_mode==='auto' y !updated.requires_approval y updated.status==='ready' → `postClassification(...)`; xml_documents.processing_status='completed'; pre_registrations.status='completed' con result_type/result_id/bill_id/journal_entry_id/processed_at/processed_by (el mismo UPDATE que ya existe en processToAccounting, 449-465).
   - 'ready' pero el modo no es auto → no se postea; pre_registrations.status='ready'; queda para `POST /pre-registrations/:id/process` o para la cola.
   - 'needs_input' → registrar preguntas (E1.2-f) y dejar pre_registrations.status='ready' con validation_status='pending'.
   - 'no_posting' → pre_registrations.status='completed', result_type='no_posting'; xml_documents.processing_status='completed'. El documento queda registrado y explicado, sin póliza.
   - 'blocked' → pre_registrations.status='rejected', validation_status='invalid', validation_errors=[{code:'CFDI_BLOCKED', message: classification.reason}]; xml_documents.processing_status='rejected'.
3. El tipo de retorno de processXMLUpload gana dos campos: `classification: Classification` y `classificationId: string`. El campo `autoProcessed` se conserva (lo consume ingest-service.ts:140 y la ruta REST en xml-ingestion.ts:100).

processToAccounting (432) se reescribe: en lugar del switch por document_type con createBillFromPreReg, lee la clasificación guardada (`SELECT * FROM cfdi_classifications WHERE pre_registration_id=$1`), y si su verdict es 'ready' llama a postClassification. Si el verdict es 'needs_input', lanza AccountingError('CFDI_NEEDS_INPUT', <lista de decisiones pendientes>) en vez de contabilizar a ciegas. Si la clasificación no existe (pre-registro anterior a este paquete), la recalcula desde xml_documents.xml_content con classifyAndRecord.

processBatch (638) no cambia: sigue llamando a processToAccounting.

**Archivos**

- `src/services/xml-ingestion/pre-registration-service.ts` — modificar: processXMLUpload llama a classifyAndRecord y decide por veredicto; processToAccounting delega en postClassification; applyRuleActions deja de escribir account_id en las líneas
- `src/api/rest/routes/xml-ingestion.ts` — modificar: la respuesta de POST /upload (líneas 100-110) añade classification_id, verdict, case_id y pending_decisions; POST /pre-registrations/:id/process propaga CFDI_NEEDS_INPUT como 409 con la lista de decisiones

**Criterios de aceptación**

- Dado un tenant con account_roles sembrada y una regla que fija processing_mode='auto', cuando se sube un CFDI PPD, entonces se crea la póliza con IVA en 1135 y cfdi_classifications tiene una fila con status='posted' y journal_entry_id no nulo
- Dado un CFDI cuyo emisor no está en vendors, cuando se sube, entonces no se crea póliza, el verdict guardado es 'needs_input' y la respuesta REST trae pending_decisions con id 'proveedor_nuevo'
- Dado un CFDI tipo T (traslado), entonces verdict='no_posting', pre_registrations.status='completed' y journal_entries no crece
- Dado un CFDI cuyo receptor y emisor no son el RFC de la entidad, entonces verdict='blocked' con reason que menciona 'ajeno' y pre_registrations.status='rejected'
- Dada una regla con set_account='6130' sobre un CFDI PUE, entonces la línea de gasto usa 6130 y la línea de IVA sigue usando 1130 por rol
- Dado un pre-registro con verdict='needs_input', cuando se llama POST /v1/pre-registrations/:id/process, entonces responde 409 y no se crea ninguna póliza

**Pruebas**

- `tests/xml-ingestion/pre-registration-service.spec.ts` — primer test del servicio (hoy tiene cero): las cinco ramas de veredicto, el matiz de set_account como qualifier, y que createBillFromPreReg ya no existe

**Riesgo.** Cambiar la semántica de set_account puede alterar en silencio el comportamiento de reglas ya configuradas en bases existentes. Mitigación: al aplicar una regla con set_account, añadir a classification.warnings «Regla <nombre>: la cuenta <código> se aplica a la línea de gasto; el tratamiento del IVA lo decide la taxonomía» y mostrarlo en la salida de `mnemosine ingest`.

##### `E1.2-f` Manejo de los cuatro veredictos: preguntas al humano, cola de revisión y superficie CLI/REST · **M**

Contrato explícito de cada veredicto, implementado en cfdi-classification-service.ts (función `handleVerdict`) y consumido por processXMLUpload, la CLI y REST.

ready — no hay decisión bloqueante, no falta ningún rol y la póliza propuesta cuadra. Camino: postClassification si el modo es auto y no requiere aprobación; si no, queda 'ready' en la cola de `mnemosine review`… con el matiz de la decisión D4 (¿draft de IA o posteo determinista?).

needs_input — hay decisiones bloqueantes sin responder, o faltan roles, o las líneas no cuadran. Camino:
1. Por CADA PendingDecision con severity==='blocking' que no tenga ya una pregunta abierta con el mismo topic (`SELECT 1 FROM ai_questions WHERE entity_id=$1 AND topic=$2 AND status='pending'`), crear una pregunta con createQuestion (src/ai/question-service.ts:39) pasando: question = d.question, context = d.context (que ya viene resuelto por el clasificador como string), options = d.options.map(o => `${o.value} — ${o.label}`), topic = d.topic, model = 'cfdi-classifier' (es el productor, y ai_questions.ai_model es NOT NULL), userRequest = `CFDI ${uuid} · ${serieFolio}`.
2. Insertar la fila puente en cfdi_classification_questions (classification_id, decision_id, question_id, severity) con ON CONFLICT (classification_id, decision_id) DO NOTHING.
3. La decisión 'cuenta_ambigua' tiene `options: []` con la nota «filled at runtime with candidate accounts» y ese código no existe. Implementarlo aquí: antes de crear la pregunta, si d.id==='cuenta_ambigua', poblar las opciones con `SELECT code, name FROM accounts WHERE entity_id=$1 AND account_type='expense' AND is_header=false AND is_active=true AND allow_manual_entries=true ORDER BY code LIMIT 12` y, si el emisor tiene historial, poner primero las cuentas con más bill_lines de ese vendor. Si la consulta devuelve cero cuentas, NO crear la pregunta (una pregunta sin opciones es ruido) y dejar solo la advertencia.
4. Si missingRoles no está vacío, no se crea pregunta: se emite un error accionable — «Faltan cuentas para los roles X, Y en esta entidad. Ejecuta `mnemosine init` (siembra account_roles) o mapea el rol a mano.» Es un fallo de configuración, no una decisión de negocio.
5. Las decisiones 'advisory' NO generan pregunta y NO bloquean: se guardan en cfdi_classifications.decisions y se muestran en la revisión. Excepción: si su `default` no existe (no es el caso hoy en ninguna advisory), se tratan como blocking.

no_posting — el caso tiene posting:null y no es un bloqueo (traslado, nómina recibida, sustitución emitida). Camino: registrar sin póliza, status='no_posting', y dejar `blocked_reason` con matched.notes, que es el texto que explica al humano por qué no hay asiento. No se crea pregunta ni draft.

blocked — CFDI ajeno, sin timbre, descuadrado, o tipo sin caso. Camino: cfdi_classifications.status='blocked', pre_registrations.status='rejected', xml_documents.processing_status='rejected'. Ninguna pregunta: no hay nada que el humano pueda decidir que lo arregle; hay que corregir el documento o cargarlo en otra entidad.

Superficie:
- CLI: en src/cli/mnemosine.ts, el comando `ingest` (línea 1067) gana en el reporte una línea por archivo con el case_id y el veredicto; y el resumen final añade, cuando cnt de needs_input > 0, la sugerencia ya existente `mnemosine questions`. Añadir además el mapeo de iconos para los veredictos nuevos.
- IngestStatus (src/ai/ingest-service.ts:32) gana dos valores: 'needs_input' y 'no_posting'; y `classify` (139) devuelve directamente el resultado del clasificador cuando el veredicto no es 'ready', sin gastar un turno de modelo. Esto es la mitad del ahorro del paquete: hoy TODO CFDI no auto-procesado por reglas se manda al modelo.
- Nuevo comando `mnemosine cfdi pendientes [--entity]`: lista `SELECT cfdi_uuid, case_id, verdict, blocked_reason FROM cfdi_classifications WHERE entity_id=$1 AND verdict IN ('needs_input','blocked') ORDER BY created_at` — usa el índice parcial idx_cfdi_class_verdict de E1.2-b.

**Archivos**

- `src/services/xml-ingestion/cfdi-classification-service.ts` — modificar: añadir handleVerdict, la creación de preguntas deduplicadas por topic y el llenado en runtime de las opciones de cuenta_ambigua
- `src/ai/ingest-service.ts` — modificar: IngestStatus gana 'needs_input' y 'no_posting'; classify() corta antes de llamar al modelo cuando el veredicto no es ready
- `src/cli/mnemosine.ts` — modificar: iconos y resumen del comando ingest; crear el subcomando `cfdi pendientes`

**Criterios de aceptación**

- Dado un CFDI de 45 000 de un proveedor sin precedente (umbral por defecto 20 000), cuando se ingiere, entonces existe una fila en ai_questions con topic 'clasificacion_desembolso:<RFC>' y status 'pending', y una fila en cfdi_classification_questions que la liga a la clasificación
- Dados dos CFDI del mismo emisor que disparan la misma decisión, entonces se crea UNA sola pregunta y dos filas puente
- Dado que el humano responde esa pregunta con 'activo_fijo' vía `mnemosine questions`, cuando se reclasifica el CFDI, entonces verdict pasa a 'ready' y la línea de gasto usa el rol activo_fijo
- Dado un CFDI con descripción 'servicios profesionales' y sin precedente, entonces la pregunta cuenta_ambigua se crea con al menos una opción de cuenta del catálogo (no con options vacío)
- Dado un CFDI tipo T, entonces no se crea ninguna fila en ai_questions ni en ai_drafts
- Dado un CFDI cuyo verdict es 'needs_input', cuando corre `mnemosine ingest`, entonces el modelo NO recibe ningún turno para ese archivo (espía sobre session.runTurn) y el estado reportado es 'needs_input'
- Dado `mnemosine cfdi pendientes`, entonces lista los CFDI con verdict needs_input y blocked y ninguno con verdict ready

**Pruebas**

- `tests/xml-ingestion/cfdi-verdicts.spec.ts` — una prueba por veredicto: efectos exactos sobre ai_questions, cfdi_classifications, pre_registrations y xml_documents
- `tests/ai/ingest-service.spec.ts` — needs_input y no_posting cortan antes de runTurn; los contadores del reporte cuadran

**Riesgo.** Deduplicar preguntas por topic puede silenciar una decisión legítima cuando el mismo emisor factura conceptos de naturaleza distinta (el topic de gasto_vs_activo es solo `clasificacion_desembolso:<RFC>`). Mitigación aceptada en este paquete: la deduplicación es solo contra preguntas PENDIENTES, no contra respondidas; una respondida sí se reutiliza como precedente, que es el comportamiento buscado. Afinar el topic por clave de producto es trabajo de la capa de qualifiers.

##### `E1.2-g` El REP cierra el ciclo: el asiento que cancela 1135 y 2125 · **M**

> **SUSTITUIDO por IVA-5 (commits 4b3b79c y f2fd789).** Este diseño postea el
> efectivo y las líneas de IVA en la póliza del REP y aplica el pago con un
> `UPDATE bills SET amount_due`, sin tocar `payments` ni `payment_applications`.
> Eso abona el banco dos veces cuando el pago también se capturó a mano, y
> traspasa el IVA dos veces — con `ivaStillParked` topando el exceso en
> silencio, de modo que la póliza cuadra y la declaración sale mal. La
> implementación vigente es `src/services/xml-ingestion/rep-linkage.ts`: el REP
> se liga al pago (o lo crea por la puerta de pagos), y la liberación del IVA
> sale de las aplicaciones del pago, sin una línea de impuesto en la ingesta.
> Lo que sigue se conserva como historia, no como especificación.


Es la mitad que da sentido a las cuentas puente: sin esto el IVA entra en 1135 y no sale nunca.

La taxonomía ya trae los casos 'pago_recibido' y 'pago_emitido' (cfdi-taxonomy.ts:307 y 323) con dos líneas: DR cxp / CR banco (recibido) y DR banco / CR cxc (emitido), por A.pagado = suma de docsRelacionados[].impPagado. Falta el traspaso del IVA. Se implementa en el orquestador, NO tocando la taxonomía, con una función nueva en cfdi-classification-service.ts:

  async function ampliarREPconIVA(client, ctx, facts, classification, roleMap): Promise<void>

que se llama desde classifyAndRecord cuando facts.tipo === 'P' y el caso resuelto es pago_recibido o pago_emitido. Para cada DoctoRelacionado dr:
1. Determinar el IVA pagado en esa parcialidad, por orden de preferencia:
   a) dr.ivaTrasladadoDR (viene del complemento Pagos 2.0, lo lee E1.2-a). Es el dato del propio SAT: gana siempre.
   b) Si no viene: buscar la clasificación de la factura original — `SELECT facts, case_id FROM cfdi_classifications WHERE entity_id=$1 AND cfdi_uuid=$2` — y prorratear: ivaPagado = (facts_original.ivaTrasladado16 + facts_original.ivaTrasladado8) × (dr.impPagado / facts_original.total), redondeado a 2 decimales con Decimal.
   c) Si tampoco: ver decisión D5.
2. Solo se traspasa si la factura original fue PPD (`facts_original.metodoPago === 'PPD'`) o si vino ivaTrasladadoDR y el caso b) no pudo comprobarse. Un REP contra una factura PUE no debe mover nada de IVA; si aparece, añadir warning y no generar las líneas.
3. Añadir a classification.lines, por cada dr con ivaPagado > 0.005:
   - recibido: { role:'iva_acreditable', side:'debit', amount: ivaPagado, description: `IVA acreditable al pago · ${dr.uuid}` } y { role:'iva_pendiente_acreditar', side:'credit', amount: ivaPagado, description: `Cancelación de IVA pendiente · ${dr.uuid}` }.
   - emitido: { role:'iva_trasladado_no_cobrado', side:'debit', ... } y { role:'iva_trasladado', side:'credit', ... }.
   Resolviendo accountCode/accountName contra el roleMap igual que hace el clasificador (cfdi-classifier.ts:180-190) y empujando a missingRoles si falta.
4. Van en LA MISMA póliza que el pago (DR cxp / CR banco / DR 1130 / CR 1135): son el mismo hecho económico y la póliza sigue cuadrando. El redondeo del prorrateo se ajusta a la última línea de IVA para que débitos y créditos coincidan al centavo — el clasificador ya comprueba el cuadre en 194-200 y degradaría el veredicto a needs_input si no cuadrase.
5. Enlace: el clasificador ya rellena `linkage` cuando el caso tiene requiresLinkage. postClassificationInTx, tras crear el asiento, aplica el pago a los documentos: por cada uuid del linkage, `UPDATE bills SET amount_due = amount_due - $1 WHERE id = (SELECT bill_id FROM cfdi_classifications WHERE entity_id=$2 AND cfdi_uuid=$3)` cuando existe bill_id, dentro de la misma transacción. Si no hay bill_id, warning y seguir: la póliza es correcta aunque el documento auxiliar no exista.
6. Idempotencia: la UNIQUE (entity_id, cfdi_uuid) de cfdi_classifications ya impide que el mismo REP se contabilice dos veces, y postClassificationInTx aborta si la clasificación ya tiene journal_entry_id.

**Archivos**

- `src/services/xml-ingestion/cfdi-classification-service.ts` — modificar: ampliarREPconIVA y su llamada desde classifyAndRecord para tipo P
- `src/services/xml-ingestion/cfdi-posting.ts` — modificar: aplicación del pago sobre bills.amount_due usando classification.linkage, dentro de la misma transacción

**Criterios de aceptación**

- Dada una factura PPD de 11 600 (IVA 1 600) ya contabilizada, cuando llega su REP por el total con ImpuestosDR de 1 600, entonces la póliza del REP es DR 2110 11 600 / CR 1110 11 600 / DR 1130 1 600 / CR 1135 1 600 y cuadra
- Dado el mismo caso pero con un pago parcial de 5 800 y SIN ImpuestosDR, entonces el IVA traspasado es 800.00 (prorrateo 5 800/11 600 × 1 600)
- Dado un REP contra una factura PUE, entonces no se generan líneas de IVA y la clasificación lleva un warning que lo explica
- Dado que se ingiere dos veces el mismo REP, entonces la segunda vez lanza DuplicateError en processXMLUpload y journal_entries no crece
- Dado que se contabilizó la factura PPD y luego su REP total, entonces el saldo de la cuenta 1135 para esa entidad y periodo vuelve a cero
- Dado un REP con dos DoctoRelacionado, entonces la póliza tiene dos pares de líneas de IVA, una por UUID, y la suma cuadra al centavo

**Pruebas**

- `tests/xml-ingestion/cfdi-rep.spec.ts` — ImpuestosDR presente vs prorrateo; pago parcial; dos DoctoRelacionado con ajuste de redondeo; REP contra PUE; REP contra factura sin clasificación previa

**Riesgo.** El prorrateo con dr.impSaldoAnt en moneda distinta (MonedaDR/EquivalenciaDR) da un IVA equivocado. Mitigación en este paquete: si dr.monedaDR existe y difiere de la moneda funcional de la entidad, no se generan líneas de IVA, se emite warning y el veredicto baja a needs_input; el multimoneda del REP es trabajo aparte y así queda visible en lugar de silencioso.

##### `E1.2-h` Remediación del histórico: detectar el IVA de PPD mal acreditado y corregirlo por reversa · **L**

Dos poblaciones afectadas, ambas con la misma causa (la ruta viva y el prompt enseñaban lo mismo):

P1 — pólizas creadas por createBillFromPreReg. Detector:

  SELECT pr.id AS pre_registration_id, pr.journal_entry_id, je.entry_number, je.entry_date,
         xd.id AS xml_document_id, xd.cfdi_uuid, (xd.total_iva_16 + xd.total_iva_8) AS iva
  FROM pre_registrations pr
  JOIN xml_documents  xd ON xd.id = pr.xml_document_id
  JOIN journal_entries je ON je.id = pr.journal_entry_id
  WHERE pr.entity_id = $1
    AND xd.metodo_pago = 'PPD'
    AND (xd.total_iva_16 + xd.total_iva_8) > 0
    AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
    AND EXISTS (SELECT 1 FROM journal_entry_lines jel
                JOIN account_roles ar ON ar.account_id = jel.account_id
                WHERE jel.journal_entry_id = je.id AND jel.debit_amount > 0
                  AND ar.entity_id = pr.entity_id AND ar.role = 'iva_acreditable' AND ar.qualifier IS NULL)

P2 — pólizas nacidas de un draft aprobado del agente. El draft lleva reference `<serieFolio> · <uuid>` (ingest-service.ts:413), que createJournalEntry copia a journal_entries.reference. Detector: el mismo EXISTS de arriba, uniendo `journal_entries je JOIN xml_documents xd ON je.reference LIKE '%' || xd.cfdi_uuid` con xd.metodo_pago='PPD', excluyendo las ya listadas en P1.

Comando nuevo `mnemosine cfdi remediar-iva --entity <e> [--desde YYYY-MM-DD] [--aplicar]` (por defecto ES dry-run; --aplicar es obligatorio para escribir). Por cada candidato, en UNA transacción:
1. `SELECT * FROM journal_entries WHERE id=$1 FOR UPDATE`.
2. `reverseWithinTransaction(client, entry, userId, 'Reversa E1.2: el IVA de un CFDI PPD se acreditó antes del pago (uuid <x>)', fechaReversa)` — es la función interna de posting.ts que corre sobre el cliente del llamador y ya deja reversed_by_entry_id enlazado. NO se edita la póliza original: NIF B-1.
3. Reclasificar desde el XML guardado: `SELECT xml_content FROM xml_documents WHERE id=$1`, `parser.parse(xml)`, `classifyAndRecord(...)` con `reclassified_from` apuntando a la clasificación anterior si existía (y marcando aquélla status='superseded').
4. Si el nuevo verdict es 'ready': `postClassificationInTx` con entry_date igual a la fecha del asiento original (para no mover el resultado de mes) y actualizar `UPDATE bills SET journal_entry_id=$1 WHERE id=$2` si había bill. Si el verdict NO es 'ready', hacer ROLLBACK de ese candidato (la reversa no se aplica sin su sustituta) y reportarlo como 'requiere_intervencion' con la razón.
5. Tras el commit, `attestEntryAsync` para la reversa y para la póliza nueva.

Fecha de la reversa y de la póliza corregida: la del asiento original si su periodo está abierto. Si el periodo está en hard_close o locked, ese candidato NO se toca y se reporta como 'periodo_cerrado' — reabrir un ejercicio cerrado es decisión humana (ver D3), nunca del script.

Salida del dry-run: tabla con entry_number, fecha, uuid, IVA mal acreditado, estado del periodo y acción prevista; y al final el total de IVA que se va a mover de 1130 a 1135. Ese total es la cifra que el contador necesita para conciliar su DIOT del periodo.

**Archivos**

- `src/services/xml-ingestion/cfdi-remediation.ts` — crear: detectAcreditamientoIndebido(entityId, desde?) y remediarAcreditamiento(entityId, userId, {aplicar})
- `src/cli/mnemosine.ts` — modificar: subcomando `cfdi remediar-iva` con --aplicar, --desde y --entity
- `scripts/e2e-cfdi-ppd.ts` — crear: E2E contra base real que siembra entidad+periodo+proveedor, ingiere PPD → REP, y luego fabrica una póliza con el patrón viejo y la remedia

**Criterios de aceptación**

- Dada una base con tres pólizas de CFDI PPD que cargan 1130, cuando corre `mnemosine cfdi remediar-iva` sin --aplicar, entonces se listan las tres, no se escribe nada y el conteo de journal_entries no cambia
- Dado lo mismo con --aplicar, entonces cada póliza original conserva status='posted' con reversed_by_entry_id apuntando a su reversa, existe una póliza nueva con el IVA en 1135, y el detector vuelve a devolver cero filas
- Dado un candidato cuya reclasificación sale 'needs_input', entonces ni la reversa ni la póliza nueva se persisten y el reporte lo marca 'requiere_intervencion'
- Dado un candidato cuyo periodo fiscal está en hard_close, entonces se reporta 'periodo_cerrado' y no se toca
- Dado que se ejecuta dos veces con --aplicar, entonces la segunda no encuentra candidatos (el filtro je.reversed_by_entry_id IS NULL lo garantiza)
- Dado el total reportado, entonces la suma de los movimientos DR 1135 / CR 1130 de las pólizas nuevas coincide con él al centavo

**Pruebas**

- `tests/xml-ingestion/cfdi-remediation.spec.ts` — el detector no marca PUE ni pólizas ya reversadas; el flujo aborta el candidato completo si la reclasificación no queda ready; idempotencia de la segunda corrida

**Riesgo.** Reversar en masa pólizas de periodos ya reportados al SAT altera declaraciones presentadas. Por eso el comando es dry-run por defecto, excluye periodos cerrados y publica el total de IVA movido: la decisión de presentar complementarias es del contador, no del sistema. El detector P2 depende de que journal_entries.reference contenga el UUID; si un draft se creó sin esa referencia, ese caso no se detecta — declararlo en la salida del comando («detectados por referencia: N; pólizas de CFDI PPD sin referencia rastreable: M»).

##### `E1.2-i` Reescribir la documentación del agente que hoy enseña lo contrario · **S**

Tres piezas mienten al modelo, verificadas:

1. src/ai/docs/mexico-cfdi.md línea 4: «PUE (single-payment) → the expense is credited against BANKS. PPD → against VENDORS (AP)». Es falso por partida doble: la taxonomía acredita PROVEEDORES en ambos casos y explica por qué (cfdi-taxonomy.ts:165-168: acreditar bancos directamente duplicaría la salida cuando llegue el movimiento bancario en la conciliación). Línea 5: «16% input VAT goes as a separate debit (input VAT account)» — sin distinguir PPD. Línea 15: «(expense+VAT vs banks/vendors per PUE/PPD)».
   Reescribir la sección «CFDI 4.0 essentials» con: PUE vs PPD determina el MOMENTO DEL IVA, no la contrapartida; la contrapartida es siempre proveedores/clientes y el banco entra por la conciliación; en PPD recibido el IVA va a 1135 IVA Pendiente de Acreditar y se acredita con el REP; en PPD emitido va a 2125 IVA Trasladado No Cobrado y se causa con el REP; anticipo (clave 84111506) es activo/pasivo, no gasto/ingreso; egreso con TipoRelacion 07 es aplicación de anticipo, no devolución; tipo P no es gasto ni ingreso; tipo T no genera póliza.
   Reescribir la sección «Ingestion of received CFDIs» describiendo el pipeline real tras este paquete: 1) registro determinista (dedupe, vendor match, reglas de enrutamiento), 2) CLASIFICADOR declarativo que decide el tratamiento por caso y roles —no lo decide el modelo—, 3) veredicto: ready → posteo o revisión, needs_input → `mnemosine questions`, no_posting → registrado sin póliza, blocked → rechazado. Y decir explícitamente qué le toca al modelo: responder decisiones cuando el humano lo pide, explicar el veredicto, y NO proponer el tratamiento del IVA por su cuenta.
2. src/ai/ingest-service.ts, buildCfdiPrompt (línea 370). Los puntos 2 y 4 de «Instructions» (líneas 411-415) repiten la regla equivocada: «debit to expense for the subtotal + debit to creditable VAT (IVA acreditable) + credit to vendors (PPD) or banks (PUE)», y la línea 404 glosa «PUE = paid, PPD = on credit → account payable». Con E1.2-f el prompt solo se usa para CFDI cuyo veredicto ya es 'ready' (o no se usa en absoluto, según D4): reescribirlo para que reciba la clasificación ya hecha —caso, líneas propuestas por rol con su cuenta, advertencias— y su tarea sea confirmar o señalar discrepancias, no inventar el asiento. Mantener intacto todo el andamiaje de contenido no confiable (UNTRUSTED_OPEN/CLOSE, scanImportedText, neutralizeMarkerDelimiters): es correcto y no se toca.
3. src/ai/tools/docs-tools.ts:22, descripción del tema: «CFDI 4.0 (PUE/PPD, VAT), multi-PAC stamping, XML ingestion» → añadir «cuentas puente de IVA y REP» para que el modelo sepa que ahí está la respuesta.

Además: src/ai/docs/nif-registro.md:14-18 y 176-179 YA enseñan lo correcto (IVA trasladado cobrado si PUE / no cobrado si PPD; cuentas puente). No tocarlos; sí añadir en mexico-cfdi.md una referencia cruzada a nif-registro para que los dos documentos no vuelvan a divergir.

Gobernanza mínima para que no se repita: añadir un test que verifique que mexico-cfdi.md no contiene las cadenas que enseñan la regla vieja («credited against BANKS», «vs banks/vendors») y que sí menciona 1135 y 2125. Es la versión barata del test de sincronía que el corpus NIIF ya tiene (tests/ai/niif-registry.spec.ts).

**Archivos**

- `src/ai/docs/mexico-cfdi.md` — modificar: reescribir 'CFDI 4.0 essentials' e 'Ingestion of received CFDIs'; añadir sección de cuentas puente y REP; referencia cruzada a nif-registro
- `src/ai/ingest-service.ts` — modificar: buildCfdiPrompt recibe la clasificación y pide confirmación en lugar de enseñar el asiento; se eliminan las instrucciones 2 y 4 actuales
- `src/ai/tools/docs-tools.ts` — modificar: descripción del tema mexico-cfdi

**Criterios de aceptación**

- Dado `grep -n 'credited against BANKS' src/ai/docs/mexico-cfdi.md`, entonces devuelve cero líneas
- Dado el documento actualizado, entonces contiene '1135' y '2125' y explica que el IVA de PPD se acredita con el REP
- Dado buildCfdiPrompt con una clasificación de verdict 'ready', entonces el texto generado incluye el case_id y las líneas propuestas con su código de cuenta y NO contiene la cadena 'IVA acreditable' como instrucción genérica
- Dado el test de doc, entonces falla si alguien reintroduce la regla vieja
- Dado `npm run build`, entonces dist/ai/docs/mexico-cfdi.md refleja el contenido nuevo (el script de build copia src/ai/docs/*.md)

**Pruebas**

- `tests/ai/docs-mexico-cfdi.spec.ts` — el doc no contiene las frases de la regla vieja; menciona 1135, 2125, REP y aplicación de anticipo con TipoRelacion 07
- `tests/ai/ingest-service.spec.ts` — buildCfdiPrompt con clasificación: incluye caso y líneas; conserva los marcadores UNTRUSTED y la neutralización de delimitadores

##### `E1.2-j` Fixtures y prueba de extremo a extremo del ciclo PPD → REP · **M**

El único test que ejerce el clasificador hoy es tests/xml-ingestion/cfdi-taxonomy.spec.ts, que construye el XML en memoria y le pasa un roleMap fijo (línea 109). Falta la prueba de que la cadena completa escribe lo correcto.

1. Fixtures en tests/fixtures/cfdi: ppd-recibido.xml (I, PPD, 10 000 + 1 600), pue-recibido.xml (I, PUE, con ISR e IVA retenidos), rep-recibido.xml (P con complemento Pagos 2.0, DoctoRelacionado apuntando al UUID del primero, con ImpuestosDR), rep-recibido-sin-impuestosdr.xml, nota-credito-ppd.xml (E, sin TipoRelacion, relacionado al PPD), anticipo-recibido.xml (clave 84111506), traslado.xml (T), ajeno.xml (ni emisor ni receptor son la entidad), ish.xml (con complemento implocal). Todos con RFC de prueba que pase el regex de cfdi-parser.ts:299 (`^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$`).
2. scripts/e2e-cfdi-ppd.ts: siembra su propia entidad, periodo fiscal abierto, usuario y catálogo (llamando a seedAccountRoles de E1.1), sin UUIDs hardcodeados — el defecto que la auditoría le señala a scripts/e2e-arap.ts:19-24. Secuencia: ingiere ppd-recibido → verifica 1135 con 1 600; ingiere rep-recibido → verifica 1135 en cero y 1130 con 1 600; ingiere nota-credito-ppd sobre otro PPD → verifica que revierte contra 1135; ingiere traslado → verifica que journal_entries no crece; ingiere ajeno → verifica rechazo. Limpieza al final por tenant_id, incluidas las filas de account_balances (el E2E existente las repara a mano; aquí se borran por entidad).
3. Añadir a package.json un script `"e2e:cfdi": "tsx scripts/e2e-cfdi-ppd.ts"` — hoy no existe ningún script 'e2e' y por eso ninguno corre en la suite.

**Archivos**

- `tests/fixtures/cfdi/` — crear: los nueve XML de fixture descritos
- `scripts/e2e-cfdi-ppd.ts` — crear: E2E autosembrado del ciclo PPD → REP → nota de crédito
- `package.json` — modificar: añadir el script e2e:cfdi

**Criterios de aceptación**

- Dado `npm run e2e:cfdi` contra una base limpia, entonces termina con código 0 y no deja filas de su tenant al finalizar
- Dado el paso del REP, entonces la consulta del saldo de 1135 para la entidad y periodo devuelve 0.00
- Dado el paso de la nota de crédito sobre PPD, entonces la línea de reversión de IVA apunta a 1135 y no a 1130
- Dado que el script se ejecuta dos veces seguidas, entonces la segunda también termina en 0 (no depende de estado previo)

**Pruebas**

- `scripts/e2e-cfdi-ppd.ts` — es el propio E2E; sus aserciones son las del criterio de aceptación

#### Cómo se sabe que cerró

- `npm test` en verde con las suites nuevas: tests/xml-ingestion/cfdi-classification-service.spec.ts, cfdi-posting.spec.ts, cfdi-verdicts.spec.ts, cfdi-rep.spec.ts, cfdi-remediation.spec.ts, cfdi-facts.spec.ts, tests/xml-ingestion/pre-registration-service.spec.ts y tests/ai/docs-mexico-cfdi.spec.ts; `npm run typecheck` con código 0.
- `npm run e2e:cfdi` termina en 0 dos veces seguidas contra una base limpia, y al finalizar el saldo de la cuenta 1135 de su entidad de prueba es 0.00 tras el REP.
- La consulta del detector de E1.2-h devuelve CERO filas para cada entidad tras correr `mnemosine cfdi remediar-iva --aplicar` (pólizas posteadas de CFDI con metodo_pago='PPD' que cargan la cuenta del rol iva_acreditable).
- Tras ingerir el lote de fixtures, `SELECT COUNT(*) FROM cfdi_classifications` es igual al número de CFDI ingeridos y ninguna fila tiene verdict NULL (hoy la tabla está permanentemente vacía).
- `grep -rn 'createBillFromPreReg' src/` devuelve cero resultados, y `grep -rn "code = '1130'\|code = '2110'" src/services/xml-ingestion/` también: ninguna ruta de ingesta resuelve cuentas por código literal.
- `grep -n 'credited against BANKS' src/ai/docs/mexico-cfdi.md` devuelve cero líneas y el documento menciona 1135, 2125 y el REP; el test de doc falla si se reintroduce la redacción antigua.
- Con auto-post activado y un CFDI PPD de fixture, `mnemosine ingest` reporta el archivo como contabilizado y `session.runTurn` no se invoca para los CFDI cuyo veredicto no es 'ready'.


### E1.3 · La capa de decisión que nadie lee: consumidores reales para las políticas y las aprobaciones
**Objetivo.** Que responder una política o conceder una aprobación cambie el comportamiento observable del sistema, o que el usuario vea con claridad que todavía no lo cambia. Al cerrar, cada clave de POLICY_CATALOG tiene un consumidor declarado y verificado, matchApproval tiene dos llamadores vivos (ingesta y outbox), y las cuatro invocaciones de approveDraft pasan expectedHash.

**Por qué aquí.** Es el paquete que convierte en producto lo que ya está construido y probado: ~350 líneas de motor de aprobaciones con 32 tests verdes y cero consumidores, y un servicio de políticas con catálogo, previsualización, asistente y CLI cuyos dos lectores (getPolicy/getPolicyNumber, /Users/victor/projects/Accounting/src/services/policy/policy-service.ts:102 y :132) no tienen un solo llamador — verificado con grep sobre src, scripts y tests. Va aquí y no después porque los dos consumidores que sí se pueden cablear hoy (la ingesta CFDI y el guardián de e.firma) no dependen de nada pendiente, y porque cada semana que `mnemosine approvals grant` y `mnemosine pending define` sigan aceptando decisiones inertes se acumulan usuarios que creen haber configurado el sistema. Va antes del cableado del clasificador CFDI porque el puente que aquí se construye es exactamente la pieza que ese paquete necesitará inyectar en classifyParsed.

**Depende de:** `E1.2` · **Migraciones:** `035-039` · **8 tareas · 4.5 sem-persona**

**Precondiciones:**

- Línea base verificada: `npm test` (80 archivos, 1155 pruebas) en verde y `npm run typecheck` con código 0.
- Migraciones 016_policy_decisions.sql y 017_fix_policy_unique.sql aplicadas (policy_decisions con los dos índices únicos parciales) y 020_ai_approval_policies.sql aplicada.
- NO depende de la siembra de account_roles ni del cableado del clasificador CFDI. El paquete entrega dos consumidores VIVOS hoy (ingesta y e.firma) y deja el tercero (clasificador) construido y probado, inerte hasta que aterrice su propio paquete. Esa independencia es deliberada: el atlas encadenaba el puente de políticas al clasificador y eso retrasaba sin necesidad los efectos que sí se pueden entregar ya.
- Tras cualquier migración de este paquete hay que reaplicar /Users/victor/projects/Accounting/src/database/rls-policies.sql; `npm run migrate` ya lo hace al final de cada corrida.

#### Decisiones a resolver

**D1 · ¿La política de aprobación de borradores puede autorizar un posteo cuando ingest_auto_post está en 'off'?**

El catálogo define ingest_auto_post='off' como 'todo pasa por tu revisión' y es el default. Una política concedida a mano con `mnemosine approvals grant` es, en cambio, una preautorización humana explícita y más específica. Si el switch gobierna, toda política de scope 'draft' nace inerte (y hay que advertirlo, cosa que E1.3-g hace). Si no gobierna, el usuario que dejó el auto-post apagado puede ver posteos automáticos que creía imposibles.

- El switch gobierna: sin ingest_auto_post='on' no se intenta ninguna política, y `approvals grant --scope draft` avisa de que la política no hará nada todavía.
- La política es independiente: una preautorización explícita basta aunque el switch esté apagado.
- Tercer valor en el catálogo: 'solo_politica' — nada se postea por umbrales, pero sí lo que una política cubra explícitamente.

_Recomendación:_ La primera. Es la doctrina que ya rige todo el módulo (el más estricto gana, nunca Math.max) y respeta literalmente lo que el catálogo le prometió al usuario. El coste —políticas inertes por defecto— se paga con el aviso explícito en `approvals grant`, que es precisamente lo que este paquete viene a arreglar. La tercera opción es la mejor a medio plazo, pero añade un valor de catálogo y una previsualización nuevos y no es necesaria para cerrar el hueco.

_Bloquea:_ E1.3-c (la condición exacta de la vía de política en ingest-service.ts) y el texto del aviso de E1.3-g.

**D2 · politica_restaurantes = 'split_85': ¿se implementa el prorrateo 8.5/91.5 en las líneas, o la política se declara sin consumidor?**

Verificado: RESTANT_DEDUCTIBLE_RATE (cfdi-decisions.ts) sólo se usa para redactar el texto de contexto de la decisión consumo_restaurante; ningún sitio parte la línea. La opción 'split_85' de esa decisión, además, no lleva `role`, así que auto-responderla eliminaría la pregunta sin cambiar ni una línea del asiento: el usuario definiría una política y el sistema dejaría de preguntar sin hacer nada distinto. La opción 'no_deducible' sí lleva role gasto_no_deducible y su efecto es real e inmediato.

- Implementar el prorrateo: partir la línea de gasto en dos (8.5% a `gasto` y 91.5% a `gasto_no_deducible`) dentro de la plantilla de posteo de la taxonomía.
- Auto-responder sólo cuando el valor sea 'no_deducible'; con 'split_85' mantener la pregunta visible y marcar la política como 'pending_wiring' con el motivo escrito.
- Marcar politica_restaurantes como 'record_only' hasta que exista el prorrateo.

_Recomendación:_ La segunda. Entrega hoy el efecto real de la mitad del catálogo de opciones sin tocar las plantillas de posteo de la taxonomía (que es trabajo del paquete del clasificador y tiene su propio riesgo contable), y no comete el pecado de este paquete: dejar de preguntar sin cambiar nada. El prorrateo debería ser un ítem propio del paquete del clasificador CFDI.

_Bloquea:_ El estado de politica_restaurantes en POLICY_CONSUMERS (E1.3-a) y el mapeo de answers en E1.3-h.

**D3 · lleva_inventarios: ¿hasta dónde llega su consumo?**

El `impact` promete que 'las compras de mercancía van a inventario y el costo se reconoce en la venta'. Eso es un cambio en la plantilla de posteo de la taxonomía, no un cambio de umbral. Lo único barato y verificable hoy es la decisión gasto_vs_activo, cuya tercera opción es 'inventario': con la política en 'directo', ofrecerla es ofrecerle al usuario algo que su propia política ya descartó.

- Consumo mínimo: filtrar la opción 'inventario' de gasto_vs_activo cuando la política definida sea 'directo' (función pura filterOptionsByPolicy, testeable sin base de datos).
- Consumo completo: la política decide la plantilla de posteo de las compras de mercancía en la taxonomía.
- No consumirla en este paquete: marcarla 'pending_wiring' con el motivo escrito.

_Recomendación:_ La primera. Es un cambio observable, pequeño y sin riesgo contable, y deja el consumo completo para el paquete que ya va a tocar la taxonomía. Registrar en POLICY_CONSUMERS que el consumo es parcial, para no volver a prometer de más.

_Bloquea:_ E1.3-h (si hay filterOptionsByPolicy) y el estado de lleva_inventarios en E1.3-a.

**D4 · expected_hash en POST /v1/ai/drafts/:id/approve: ¿obligatorio u opcional?**

Obligatorio cierra la protección anti-drift en toda la superficie HTTP, pero rompe el contrato /v1 para cualquier cliente externo. Verificado que dentro del repositorio no hay ningún consumidor de este endpoint (el CLI llama a los servicios directamente) y que no existe versionado de API más allá del prefijo /v1.

- Obligatorio ya, con content_hash expuesto en GET /v1/ai/drafts para que el cliente pueda echarlo.
- Opcional, documentado y recomendado; registrar en la documentación que la protección es opt-in por REST.
- Opcional durante una versión con un aviso en la respuesta (campo meta.warning), obligatorio en la siguiente.

_Recomendación:_ La primera. Es una escritura al mayor: la CLI ya se ata al hash desde `mnemosine review`, y dejar la vía HTTP como la única puerta sin cerrojo es exactamente el tipo de asimetría que este paquete corrige. Si existe algún cliente externo desconocido, la tercera es el plan B ordenado.

_Bloquea:_ E1.3-f (el `.optional()` del esquema y el código de estado del error de deriva).

**D5 · efirma_accion_anomalia ofrece 'bloquear_fuera_horario' y no existe ninguna ventana horaria en el sistema.**

Ni el catálogo ni fiscal_credentials ni la configuración definen un horario. La opción es, hoy, inimplementable: si alguien la elige, cualquier implementación honesta la degradaría a 'alertar' en silencio.

- Retirar la opción del catálogo hasta que exista una política de ventana horaria (una clave nueva, p.ej. efirma_ventana_horaria).
- Añadir ahora la política de ventana horaria y implementar las tres opciones.
- Dejar la opción y degradarla a 'alertar' con un aviso explícito cada vez que se lea.

_Recomendación:_ La primera. Retirar una opción no destruye nada: resolvePolicy acepta valores libres, una fila ya resuelta conserva su valor, y resolveEfirmaPolicy mapea cualquier literal desconocido a 'alertar' con aviso. Ofrecer una opción que el código no puede cumplir es la misma enfermedad que este paquete trata, sólo que un nivel más arriba.

_Bloquea:_ E1.3-d (el mapeo de resolveEfirmaPolicy) y el contenido del catálogo en E1.3-a.

**D6 · pac_ofrece_descarga no tiene ni puede tener consumidor en este horizonte. ¿Se queda?**

Su `impact` declara que determina 'si vale la pena implementar PacDownloadProvider', que es una decisión de hoja de ruta, no un parámetro de ejecución. El descargador masivo del SAT está en el horizonte de trimestre. Es la única clave del catálogo cuyo destino natural es 'record_only' permanente.

- Se queda marcada 'record_only', con el aviso explícito de que sólo registra un criterio.
- Se saca del catálogo de políticas y se convierte en una nota de onboarding sin fila en policy_decisions.
- Se queda sin marca, como hoy.

_Recomendación:_ La primera. La respuesta tiene valor real para el despacho (reduce la custodia de e.firma) y merece quedar registrada con autor y fecha; lo que no puede es aparentar que cambia el comportamiento del sistema. La tercera opción es el statu quo que este paquete existe para eliminar.

_Bloquea:_ El estado de pac_ofrece_descarga en POLICY_CONSUMERS (E1.3-a).

**D7 · Precedencia entre mnemosine.config.json y la política del tenant para los umbrales de ingesta.**

resolveIngestThresholds encadena hoy bandera > archivo > default del código. La política puede entrar encima del archivo o debajo. Si entra debajo, un tenant que tenga `ingest.auto_post: false` en su archivo no verá efecto alguno al definir la política, y volvemos al síntoma original.

- Bandera > archivo > política > default (el archivo gana sobre la política).
- Bandera > política > archivo > default (la política gana sobre el archivo).
- Más estricto gana entre archivo y política, distinguiendo 'ausente' de 'explícitamente false'.

_Recomendación:_ La primera, que es la implementada en E1.3-c. El archivo es una elección deliberada de un operador sobre esa instalación y debe poder acotar lo que el producto configura; y como el default del código es 'no auto-postear', insertar la política justo encima de los defaults ya basta para que definirla cambie el comportamiento del usuario típico, que nunca escribió un mnemosine.config.json. La tercera es más correcta en teoría pero exige distinguir ausencia de falsedad en el archivo, lo que hoy resolveIngestThresholds colapsa.

_Bloquea:_ E1.3-c (la firma de resolveIngestThresholds y el texto de origen que imprime la cabecera de `mnemosine ingest`).

#### Tareas

##### `E1.3-a` Registro de consumidores de política: quién lee cada clave, y claves tipadas · **S**

Crear la única fuente de verdad sobre el consumo de políticas. Hoy no existe: el catálogo declara `impact` en prosa y nada relaciona una clave con el código que la lee, así que ni el usuario ni el desarrollador pueden distinguir una política viva de una inerte.

1) Tipado de claves. En pending-catalog.ts, POLICY_CATALOG está anotado `: PolicySpec[]`, lo que borra los literales. Cambiar a `export const POLICY_CATALOG = [ ... ] as const satisfies readonly PolicySpec[];` y exportar `export type PolicyKey = (typeof POLICY_CATALOG)[number]['key'];`. Para que `as const` satisfaga el tipo hay que relajar PolicySpec a `readonly options: readonly PolicyOption[]` (todos los usos actuales sólo leen: seedPolicies hace JSON.stringify, s4-policies y pending-command hacen forEach/some). Añadir una sobrecarga tipada: `export function getPolicySpec(key: PolicyKey): PolicySpec; export function getPolicySpec(key: string): PolicySpec | undefined;` con la implementación actual.

2) Nuevo módulo policy-consumers.ts:
```ts
export type PolicyConsumerState = 'live' | 'pending_wiring' | 'record_only';
export interface PolicyConsumer {
  key: PolicyKey;
  state: PolicyConsumerState;
  /** módulo::símbolo que lee el valor; null si nadie lo lee */
  reader: string | null;
  /** comando o endpoint donde el efecto es observable */
  observableIn: string | null;
  /** qué cambia al resolverla, una frase en presente */
  effect: string;
  /** obligatorio si state != 'live': qué falta para que se aplique */
  blockedBy?: string;
}
export const POLICY_CONSUMERS: Record<PolicyKey, PolicyConsumer>;
export function consumerFor(key: string): PolicyConsumer | undefined;
```
Contenido inicial, con el estado que tendrá cada clave al cerrar este paquete (mapa verificado contra el código, no contra el atlas):
- ingest_auto_post → live · reader `providers/config.ts::resolveIngestThresholds(policyDefaults)` · observableIn `mnemosine ingest` · effect: activa el auto-posteo por umbrales y habilita la vía de política de aprobación.
- ingest_auto_post_max_monto → live · mismo reader · effect: tope duro del auto-posteo, aún acotado por FLOOR_MAX_AUTO_POST.
- efirma_max_accesos_diarios → live · reader `fiscal-credentials/service.ts::withCredential` · observableIn `mnemosine sat cred log` · effect: límite de descifrados en 24 h, combinado con la columna max_daily_access por el más estricto.
- efirma_accion_anomalia → live · mismo reader · effect: al agotarse el límite, sólo se registra la anomalía o además se bloquea la credencial.
- umbral_capitalizacion_mxn → pending_wiring · reader `cfdi-decisions.ts::PolicyThresholds.capitalizationThreshold` · blockedBy: classifyParsed no tiene llamador vivo (paquete del clasificador CFDI).
- tratamiento_ieps, cfdi_periodo_cerrado → pending_wiring · reader `policy-bridge.ts::buildClassifierPolicyInput` (respuestas implícitas) · mismo blockedBy.
- politica_restaurantes → según la decisión D2.
- lleva_inventarios → según la decisión D3.
- pac_ofrece_descarga → record_only · reader null · blockedBy: no existe PacDownloadProvider ni descargador SAT; la respuesta sólo queda registrada como criterio.

3) Ningún módulo de dominio importa policy-consumers.ts: es metadato para la interfaz de usuario y para el test de sincronía.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/policy/pending-catalog.ts` — modificar: POLICY_CATALOG pasa a `as const satisfies readonly PolicySpec[]`; PolicySpec.options pasa a readonly; se exporta el tipo PolicyKey y una sobrecarga tipada de getPolicySpec
- `/Users/victor/projects/Accounting/src/services/policy/policy-consumers.ts` — crear: PolicyConsumer, POLICY_CONSUMERS (10 entradas) y consumerFor
- `/Users/victor/projects/Accounting/tests/policy/policy-consumers.spec.ts` — crear: test de sincronía catálogo↔consumidores

**Criterios de aceptación**

- Dado el catálogo actual, cuando corre tests/policy/policy-consumers.spec.ts, entonces pasa: toda clave de POLICY_CATALOG tiene entrada en POLICY_CONSUMERS y toda entrada corresponde a una clave existente.
- Dado un consumidor con state 'live', cuando el test lo evalúa, entonces reader y observableIn no son null; dado uno con state distinto de 'live', entonces blockedBy es una cadena no vacía.
- Dado un `getPolicySpec('umbral_capitalizacio')` (con typo) en código nuevo tipado como PolicyKey, cuando corre `npm run typecheck`, entonces falla la compilación.
- Dado `npm run typecheck` sobre el repo completo tras el cambio a readonly, entonces devuelve código 0 sin modificar s4-policies.ts ni pending-command.ts.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/policy/policy-consumers.spec.ts` — sincronía en ambas direcciones catálogo↔POLICY_CONSUMERS, e invariantes de campos por estado

**Riesgo.** El `as const` vuelve readonly los arrays de `options` y puede romper llamadores que los muten. Verificado que hoy ninguno lo hace (los tres consumidores —seedPolicies, s4-policies.ts:137 y pending-command.ts:214— sólo leen). Mitigación: correr `npm run typecheck` inmediatamente después de este cambio, antes de seguir con el resto del paquete.

##### `E1.3-b` Puente de políticas y corrección del alcance por entidad en policy-service · **M**

Dos cosas: arreglar un defecto de alcance que hoy nadie nota porque nadie lee, y construir el lector que los motores usarán.

1) Defecto verificado en policy-service.ts. `getPolicy` (línea 102) recibe `PolicyContext { tenantId, entityId? }` pero su WHERE es `tenant_id = $1 AND key = $2`, sin filtrar por entidad; el `ORDER BY entity_id IS NULL ASC` hace ganar cualquier fila de alcance de entidad, incluso de OTRA entidad del mismo tenant. Con la tabla soportando alcance por entidad (migración 016) esto devuelve la política equivocada en cuanto exista una fila por entidad. Corregir a:
```sql
WHERE tenant_id = $1 AND key = $2 AND (entity_id = $3 OR entity_id IS NULL)
ORDER BY entity_id IS NULL ASC
LIMIT 1
```
con $3 = ctx.entityId ?? null (`entity_id = NULL` nunca es cierto, así que sin entidad sólo casan las filas de tenant). El mismo defecto está en resolvePolicy (142), dismissPolicy (167) y reopenPolicy (186), cuyos UPDATE tocarían las DOS filas si coexistieran alcance de tenant y de entidad: añadir `AND entity_id IS NOT DISTINCT FROM $n`. Como hoy todos los llamadores invocan seedPolicies con `{ tenantId }` (entity_id NULL), el cambio no altera ningún comportamiento existente.

2) Nuevo módulo policy-bridge.ts. Es el único sitio donde el resto del sistema lee políticas; nadie más importa policy-service para leer.
```ts
export class PolicyKeyUnknownError extends Error {}
export interface PolicySnapshot {
  /** resuelto > default de la fila > default del catálogo */
  get(key: PolicyKey): string;
  /** true = lo definió una persona; false = se está operando con el default */
  isDefined(key: PolicyKey): boolean;
  /** get() parseado; si no es finito, el default del catálogo */
  getNumber(key: PolicyKey): number;
  /** claves DEFINIDAS cuyo valor no se pudo interpretar */
  readonly invalid: readonly PolicyKey[];
}
export async function loadPolicySnapshot(
  ctx: PolicyContext, keys: readonly PolicyKey[]
): Promise<PolicySnapshot>;
```
loadPolicySnapshot hace UNA consulta con `key = ANY($2::text[])` y la misma cláusula de entidad corregida arriba, resolviendo empates en memoria (fila de entidad antes que fila de tenant). Una clave que no exista en POLICY_CATALOG lanza PolicyKeyUnknownError; una clave del catálogo sin fila en la base devuelve el default del catálogo con isDefined=false y NO lanza — la doctrina del servicio es que nunca bloquea por falta de definición.

3) Los cuatro resolutores que consumirán los motores, todos sobre loadPolicySnapshot:
```ts
export async function resolveIngestPolicyDefaults(ctx: PolicyContext):
  Promise<{ autoPost: boolean; maxAmount: number; definedAutoPost: boolean; definedMaxAmount: boolean }>;
export async function resolveEfirmaPolicy(ctx: PolicyContext):
  Promise<{ maxDailyAccess: number; anomalyAction: 'bloquear' | 'alertar'; raw: string }>;
export async function buildPolicyThresholds(ctx: PolicyContext): Promise<PolicyThresholds>;
export async function buildClassifierPolicyInput(ctx: PolicyContext):
  Promise<{ thresholds: PolicyThresholds; answers: Record<string, string> }>;
```
(los dos últimos se especifican en E1.3-h). resolveEfirmaPolicy mapea 'bloquear' a 'bloquear' y CUALQUIER otro valor a 'alertar', devolviendo el literal en `raw` para que el llamador pueda advertir de un valor fuera de catálogo: fallar a 'alertar' no debilita nada porque la denegación por límite diario ocurre igual (ver E1.3-d).

**Archivos**

- `/Users/victor/projects/Accounting/src/services/policy/policy-service.ts` — modificar: filtro de entidad en getPolicy (102) y guardas `entity_id IS NOT DISTINCT FROM` en resolvePolicy (142), dismissPolicy (167) y reopenPolicy (186)
- `/Users/victor/projects/Accounting/src/services/policy/policy-bridge.ts` — crear: PolicySnapshot, loadPolicySnapshot, resolveIngestPolicyDefaults, resolveEfirmaPolicy, PolicyKeyUnknownError
- `/Users/victor/projects/Accounting/tests/policy/policy-bridge.spec.ts` — crear: precedencia, alcance por entidad, claves desconocidas, valores no numéricos
- `/Users/victor/projects/Accounting/tests/policy/policy-service.spec.ts` — crear: primer spec propio del servicio (hoy sólo se ejercita mockeado desde s4-policies.spec.ts)

**Criterios de aceptación**

- Dada una fila resuelta con resolved_value '50000' y default_value '20000', cuando se llama a snapshot.getNumber('umbral_capitalizacion_mxn'), entonces devuelve 50000 y isDefined es true.
- Dada una fila pendiente sin default_value en la base, cuando se llama a get(), entonces devuelve el defaultValue del catálogo y isDefined es false.
- Dadas dos filas de la misma clave, una de alcance de tenant y otra de la entidad B, cuando se consulta con entityId = A, entonces gana la de tenant (la de B no se ve); cuando se consulta con entityId = B, entonces gana la de B.
- Dado loadPolicySnapshot con una clave que no está en POLICY_CATALOG, entonces lanza PolicyKeyUnknownError y no consulta la base.
- Dada una política definida con el valor libre '35000 pesos', cuando se llama a getNumber, entonces devuelve el default del catálogo (20000) y la clave aparece en snapshot.invalid.
- Dado un tenant con 10 políticas y una llamada a loadPolicySnapshot con las 10 claves, entonces se ejecuta exactamente una consulta SQL.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/policy/policy-bridge.spec.ts` — tabla de precedencia resuelto > default BD > default catálogo; desempate entidad vs tenant incluyendo entidad ajena; una sola consulta para N claves; clave desconocida lanza; valor no numérico cae al default y se lista en invalid
- `/Users/victor/projects/Accounting/tests/policy/policy-service.spec.ts` — idempotencia de seedPolicies (rowCount 0 en la segunda pasada), orden de listPolicies (pending primero, luego priority, luego key), y guardas rowCount de resolve/dismiss/reopen

**Riesgo.** Cambiar el WHERE de resolvePolicy/dismissPolicy/reopenPolicy podría dejar sin efecto un UPDATE si alguna instalación tuviera filas de alcance de entidad creadas fuera del código. Mitigación: la guarda `rowCount === 0` ya existente lanza un error explícito en vez de fallar en silencio; añadir a ese mensaje el alcance consultado (tenant o entidad).

##### `E1.3-c` La ingesta consume ingest_auto_post e ingest_auto_post_max_monto, y cablea autoApproveDraftByPolicy · **M**

Dos consumos en el mismo camino: los umbrales y el motor de aprobaciones.

1) Umbrales. resolveIngestThresholds (providers/config.ts:436) es puro y sin base de datos, y así debe seguir: buildStatusReport (status-command.ts:161) lo llama sin tenant. Añadir un tercer parámetro opcional:
```ts
export function resolveIngestThresholds(
  overrides: Partial<IngestThresholds> = {},
  cwd = process.cwd(),
  policyDefaults: Partial<IngestThresholds> = {}
): IngestThresholds
```
que sustituye INGEST_DEFAULTS campo a campo por `policyDefaults.x ?? INGEST_DEFAULTS.x`. La cadena de precedencia queda: bandera CLI > mnemosine.config.json > política > default del código. Se inserta la política JUSTO ANTES de los defaults, no encima del archivo, porque el archivo es una elección explícita del operador; y encima de los defaults porque si no, definir `ingest_auto_post = on` no cambiaría nada (INGEST_DEFAULTS.autoPost es false) y volveríamos a la enfermedad que este paquete cura.
En mnemosine.ts, el comando `ingest` (línea 1084) resuelve hoy los umbrales ANTES de la entidad: invertir el orden (resolveEntity primero) y llamar a `resolveIngestThresholds({flags}, process.cwd(), await resolveIngestPolicyDefaults(ctx))`. La cabecera impresa (línea 1113) debe decir de dónde sale cada valor, p.ej. `auto-post ≥0.95 hasta 10000 · switch: política · tope: mnemosine.config.json`.

2) Motor de aprobaciones. En ingest-service.ts, la capa 3 (líneas 165-221) mezcla hoy dos clases de compuerta. Separarlas:
- Compuertas de INTEGRIDAD, siempre y sin excepción, y ninguna política las salta: `drafts.length > 1` (línea 170), moneda distinta de la funcional (180) y `|draftTotal - total| > 0.01` (187). Si alguna falla, el resultado es 'draft' y NO se intenta política.
- Compuertas DISCRECIONALES: thresholds.autoPost, minConfidence, floorMaxAutoAmount(maxAmount) y proveedor conocido con confianza ≥ 0.9. Si todas pasan, se aprueba por umbrales como hoy.
- Si alguna discrecional falla, y sólo si `thresholds.autoPost === true` (ver decisión D1), se intenta la vía de política:
```ts
const autoByPolicy = opts.deps?.autoApproveByPolicy ?? autoApproveDraftByPolicy;
try {
  const r = await autoByPolicy(ctx, draft.draftId, {
    configuredMaxAmount: floorMaxAutoAmount(thresholds.maxAmount),
  });
  return { file: name, status: 'auto_post', draftId: draft.draftId,
           entryNumber: r.entryNumber, policyId: r.policyId,
           detail: `auto-post por política ${r.policyId}; el umbral no bastaba: ${motivoUmbral}` };
} catch (err) {
  if (err instanceof NoMatchingApprovalPolicyError) {
    return { file: name, status: 'draft', draftId: draft.draftId, detail: motivoUmbral };
  }
  return { file: name, status: 'draft', draftId: draft.draftId,
           detail: `${motivoUmbral} · la política casó pero falló al aplicarse: ${(err as Error).message}` };
}
```
Pasar `configuredMaxAmount` es obligatorio: es lo que hace que una política NUNCA autorice por encima del tope configurado (matchApproval combina política, configuración y FLOOR_MAX_AUTO_POST sólo con Math.min). No se pasa sessionId: `mnemosine ingest` no tiene sesión persistida (LlmSession, providers/types.ts:62, no expone id), así que las políticas de modo 'session' no casan por esta vía — es correcto y hay que advertirlo (E1.3-g).
Tipos: IngestFileResult gana `policyId?: string`; IngestDeps gana `autoApproveByPolicy?: typeof autoApproveDraftByPolicy`. El status sigue siendo 'auto_post' (no se añade uno nuevo) para no tocar el mapa de iconos ni el Record de conteos del CLI; la vía se distingue por policyId y por detail.

3) Corregir el docstring falso de draft-service.ts:474-477, que afirma que la ingesta ya llama a esta función 'en vez de umbrales crudos', por la descripción del cableado real: vía secundaria que se intenta cuando las compuertas discrecionales no bastan.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/providers/config.ts` — modificar: resolveIngestThresholds acepta policyDefaults como tercer parámetro; sin imports de base de datos
- `/Users/victor/projects/Accounting/src/ai/ingest-service.ts` — modificar: separar compuertas de integridad de las discrecionales, añadir la vía de política, ampliar IngestFileResult e IngestDeps
- `/Users/victor/projects/Accounting/src/cli/mnemosine.ts` — modificar: comando `ingest` (1084-1115) resuelve la entidad antes de los umbrales, inyecta los defaults de política y declara el origen de cada valor en la cabecera
- `/Users/victor/projects/Accounting/src/ai/draft-service.ts` — modificar: corregir el docstring de autoApproveDraftByPolicy (474-477)
- `/Users/victor/projects/Accounting/src/cli/status-command.ts` — modificar: la fila de umbrales aclara que no incluye las políticas del tenant y remite a `mnemosine pending`
- `/Users/victor/projects/Accounting/tests/ai/ingest-service.spec.ts` — modificar: añadir los casos de la vía de política sobre el arnés de deps ya existente
- `/Users/victor/projects/Accounting/tests/ai/providers/config.spec.ts` — modificar: precedencia bandera > archivo > política > default

**Criterios de aceptación**

- Dado un tenant sin mnemosine.config.json y con ingest_auto_post definido en 'on' e ingest_auto_post_max_monto en '5000', cuando corre `mnemosine ingest f.xml`, entonces la cabecera anuncia auto-post con tope 5000 y origen 'política'.
- Dado el mismo tenant y un mnemosine.config.json con ingest.auto_post=false, cuando corre `mnemosine ingest`, entonces el auto-post queda desactivado: el archivo gana sobre la política.
- Dado un borrador con confianza 0.80 (por debajo del umbral 0.95) y una política activa `--scope draft --kind journal_entry --max-amount 5000 --mode always`, con auto-post activado y CFDI de 1200 MXN de proveedor conocido, cuando corre la ingesta, entonces el resultado es status 'auto_post' con policyId poblado y detail que nombra la política y el motivo por el que el umbral no bastaba.
- Dado el mismo caso pero con la moneda del CFDI distinta de la funcional, entonces el resultado es 'draft', no se llama a autoApproveDraftByPolicy ni una sola vez, y detail cita la discrepancia de moneda.
- Dado un borrador de 60000 MXN y una política con max_amount 60000, cuando corre la ingesta, entonces no se aprueba: FLOOR_MAX_AUTO_POST (50000) y el tope configurado se combinan por Math.min.
- Dado que ninguna política casa, entonces el resultado es 'draft' con exactamente el mismo detail que producía el código anterior — la vía de política no puede cambiar el mensaje del camino de umbrales.
- Dado `grep -rn autoApproveDraftByPolicy /Users/victor/projects/Accounting/src`, entonces aparece al menos un llamador fuera de draft-service.ts.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/ai/ingest-service.spec.ts` — vía de política tras fallo de confianza; no se intenta tras fallo de integridad (moneda, descuadre con el CFDI, múltiples borradores); NoMatchingApprovalPolicyError deja el detail original; fallo real de la política se refleja en detail; configuredMaxAmount se pasa clampeado por floorMaxAutoAmount
- `/Users/victor/projects/Accounting/tests/ai/providers/config.spec.ts` — policyDefaults se usa sólo cuando no hay bandera ni archivo, y nunca por encima de ninguno de los dos

**Riesgo.** Una política 'once' que casa y cuya aprobación luego falla queda consumida (comportamiento documentado y deliberado: fallar cerrado). Riesgo mayor: si se implementara la vía de política SIN pasar configuredMaxAmount, un `--max-amount 50000` autorizaría posteos muy por encima del tope que el operador puso en su configuración. El criterio de aceptación del tope de 60000 existe precisamente para detectarlo.

##### `E1.3-d` El guardián de e.firma consume sus dos políticas de seguridad · **M**

Las políticas efirma_max_accesos_diarios y efirma_accion_anomalia describen en su campo `impact` un límite de denegación que el código no lee: withCredential (fiscal-credentials/service.ts:205) usa exclusivamente `row.max_daily_access`, una columna que se fija al dar de alta la credencial (`input.maxDailyAccess ?? 24`, línea 181).

1) Límite diario. Tras cargar `row` y antes del conteo de accesos (línea 241), obtener `const pol = await resolveEfirmaPolicy({ tenantId, entityId })` y usar `const limit = Math.min(row.max_daily_access, pol.maxDailyAccess)`. El más estricto gana, igual que en toda la doctrina del floor: la política nunca puede AMPLIAR el límite que el operador fijó al subir la credencial. El mensaje de denegación debe nombrar cuál de los dos mandó: `Se alcanzó el límite de N accesos en 24 h (origen: política del tenant | credencial).`

2) Acción ante anomalía. Al agotarse el límite, hoy siempre se deniega y se registra. Añadir, y sólo cuando `pol.anomalyAction === 'bloquear'`, el bloqueo de la credencial: dentro de un `withTransaction` que agrupe el INSERT del log de acceso denegado y `UPDATE fiscal_credentials SET status = 'blocked', updated_at = NOW() WHERE id = $1 AND status = 'active'`, para que no exista jamás una credencial bloqueada sin la fila de bitácora que lo explica. Con 'alertar' (el default del catálogo) el comportamiento es idéntico al de hoy: denegar el acceso y registrar. Un valor fuera de catálogo se trata como 'alertar' y se registra un aviso con el literal recibido; no se escala a bloqueo por un valor que nadie entiende.

3) Consecuencias del estado 'blocked' que hay que cerrar en la misma tarea, o el bloqueo deja al cliente sin servicio y sin salida:
- Migración 031: el CHECK actual (014_fiscal_credentials.sql:29-30) sólo admite active/expired/revoked/invalid. `ALTER TABLE fiscal_credentials DROP CONSTRAINT IF EXISTS fiscal_credentials_status_check; ALTER TABLE fiscal_credentials ADD CONSTRAINT fiscal_credentials_status_check CHECK (status IN ('active','expired','revoked','invalid','blocked'));`. El índice único parcial `WHERE status = 'active'` sigue siendo correcto.
- Diagnóstico: la SELECT de withCredential filtra por status='active', así que una credencial bloqueada produciría hoy el mensaje 'no hay e.firma activa … súbela con mnemosine sat cred add', que manda al usuario a hacer justo lo que no debe. Cuando no haya activa, consultar la última fila por created_at y, si su status es 'blocked', lanzar CredentialAccessDenied con motivo 'blocked' y el texto de reactivación.
- Reactivación: nuevo subcomando `mnemosine sat cred unblock` en sat-commands.ts que hace `UPDATE fiscal_credentials SET status='active' WHERE entity_id=$1 AND status='blocked'` e inserta una fila de bitácora con purpose 'validation', actor = el usuario y outcome 'success'. Sin esta vía, definir la política como 'bloquear' es una trampa.

4) `mnemosine sat cred status` (sat-commands.ts:186) debe mostrar el límite EFECTIVO (mínimo de columna y política) y de dónde sale, no sólo `row.max_daily_access`.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/fiscal-credentials/service.ts` — modificar: withCredential lee resolveEfirmaPolicy, combina el límite por Math.min, agrupa bitácora y bloqueo en una transacción, y distingue el caso 'blocked' cuando no hay credencial activa
- `/Users/victor/projects/Accounting/src/database/migrations/031_credential_blocked_status.sql` — crear: amplía el CHECK de fiscal_credentials.status con 'blocked'
- `/Users/victor/projects/Accounting/src/cli/sat-commands.ts` — modificar: nuevo `sat cred unblock`; `sat cred status` y el alta muestran el límite efectivo y su origen
- `/Users/victor/projects/Accounting/tests/fiscal-credentials/service.spec.ts` — crear o modificar: casos de límite combinado, bloqueo, y no-bloqueo con 'alertar'

**Migración**

```sql
ALTER TABLE fiscal_credentials DROP CONSTRAINT IF EXISTS fiscal_credentials_status_check;
ALTER TABLE fiscal_credentials ADD CONSTRAINT fiscal_credentials_status_check
  CHECK (status IN ('active','expired','revoked','invalid','blocked'));
```

**Criterios de aceptación**

- Dada una credencial con max_daily_access = 24 y efirma_max_accesos_diarios definida en '4', cuando se han registrado 4 accesos exitosos en 24 h, entonces withCredential deniega con denied_reason 'rate_limit' y el mensaje nombra la política como origen del límite.
- Dado el caso inverso (columna 4, política 96), cuando se han registrado 4 accesos, entonces también deniega: la política nunca amplía el límite de la credencial.
- Dada efirma_accion_anomalia en 'bloquear' y el límite agotado, cuando se intenta un acceso, entonces la credencial queda en status 'blocked' y existe exactamente una fila nueva en fiscal_credential_access_log con outcome 'denied'; si el UPDATE falla, tampoco se inserta la fila.
- Dada efirma_accion_anomalia en 'alertar' (default) y el límite agotado, entonces el status sigue siendo 'active' y el comportamiento es byte a byte el de antes de este paquete.
- Dada una credencial en status 'blocked', cuando se invoca withCredential, entonces lanza CredentialAccessDenied con motivo 'blocked' y el mensaje menciona `mnemosine sat cred unblock`, no `sat cred add`.
- Dado un valor de efirma_accion_anomalia fuera del catálogo, entonces se trata como 'alertar' y se emite un aviso que cita el literal recibido.
- Dado `npm run migrate` sobre una base con la 030 aplicada, entonces la 031 aplica sin error y rls-policies.sql se reaplica al final.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/fiscal-credentials/service.spec.ts` — límite efectivo por Math.min en ambas direcciones; bloqueo transaccional con 'bloquear'; no-regresión con 'alertar'; valor desconocido degradado a 'alertar'; mensaje correcto con status 'blocked'

**Riesgo.** Cablear la política sin cuidado convierte la denegación dura de hoy en un permiso: si se leyera efirma_accion_anomalia='alertar' como 'permitir y avisar', todos los tenants perderían el límite de 24 h en silencio. La especificación separa deliberadamente las dos políticas: el límite SIEMPRE deniega; la acción sólo decide si además se bloquea la credencial. El criterio de aceptación de 'alertar' comprueba exactamente esta no-regresión.

##### `E1.3-e` `mnemosine outbox` intenta la política antes de preguntarle al humano · **M**

autoExecuteOpByPolicy (external-service.ts:465) no tiene llamador, de modo que toda política de scope 'external_op' creada con `mnemosine approvals grant` es inerte.

1) Error tipado, prerequisito de todo lo demás. Hoy la distinción entre 'ninguna política autoriza esto' y 'la política casó y la ejecución falló' sólo existe en el texto del mensaje, y ningún llamador puede ramificar sobre eso sin comparar cadenas. En approval-policy.ts:
```ts
export class NoMatchingApprovalPolicyError extends Error {
  constructor(readonly scope: ApprovalScope, readonly subjectId: string, message: string) { super(message); this.name = 'NoMatchingApprovalPolicyError'; }
}
```
Lanzarla, conservando los textos actuales, en las cuatro ramas de 'no autorizado': draft-service.ts:512 (sin monto confiable) y :524 (sin política), external-service.ts:483 (sin monto derivable) y :491 (sin política). Ningún otro throw cambia.

2) Cableado en mnemosine.ts, comando `outbox` (1271). Nuevas banderas: `--no-policy` (desactiva la pasada de política) y `--policy-only` (ejecuta lo que las políticas autoricen y termina, sin abrir readline). Orden dentro de la acción, después de resolver las operaciones colgadas en 'executing' y ANTES del bucle interactivo:
```ts
const restantes: ExternalOpRow[] = [];
for (const op of pending) {
  if (opts.policy === false) { restantes.push(op); continue; }
  try {
    const { policyId } = await autoExecuteOpByPolicy(ctx, op.id);
    ejecutadas++;
    console.log(`✔ ${op.provider}/${op.operation} ejecutada por política ${policyId}`);
  } catch (err) {
    if (err instanceof NoMatchingApprovalPolicyError) { restantes.push(op); continue; }
    reportError(err); // p.ej. operación rancia rechazada por el floor
  }
}
```
No se pasa sessionId: el outbox no vive dentro de una sesión del modelo.
Con `--policy-only`, imprimir el resumen (`N ejecutadas por política, M siguen pendientes de revisión humana`) y salir con 0 sin crear la interfaz de readline — eso hace del outbox algo ejecutable desde cron sin runtime de trabajos, y le da por fin sentido a `--mode always` en scope 'external_op'. `--policy-only` no necesita `--user`: autoExecuteOpByPolicy atribuye la ejecución como `policy:<id>`, no a una persona.
Con `--list` NO se intenta ninguna política: matchApproval tiene efectos (consume las 'once' y toca last_used_at), y un listado nunca debe gastar una autorización.

3) Consecuencia verificada que hay que hacer visible: executeExternalOp rechaza (status='rejected') toda operación encolada hace más de FLOOR_MAX_OP_AGE_DAYS días. Por la vía de política eso ocurre sin humano delante, así que una operación rancia desaparecería de la cola sin que nadie lo viera. La pasada de política debe imprimir en rojo cada rechazo por antigüedad, con el id y el proveedor, y contarlos aparte en el resumen.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/approval-policy.ts` — crear: clase NoMatchingApprovalPolicyError exportada
- `/Users/victor/projects/Accounting/src/ai/external-service.ts` — modificar: lanzar NoMatchingApprovalPolicyError en las dos ramas de no-autorización de autoExecuteOpByPolicy (483 y 491)
- `/Users/victor/projects/Accounting/src/ai/draft-service.ts` — modificar: lo mismo en autoApproveDraftByPolicy (512 y 524)
- `/Users/victor/projects/Accounting/src/cli/mnemosine.ts` — modificar: comando `outbox` gana `--no-policy` y `--policy-only`, y una pasada de política previa al bucle interactivo
- `/Users/victor/projects/Accounting/tests/ai/external/external-service.spec.ts` — modificar: los rejects pasan a comprobar la clase del error, no sólo el mensaje
- `/Users/victor/projects/Accounting/tests/ai/draft-service.spec.ts` — modificar: idem para autoApproveDraftByPolicy

**Criterios de aceptación**

- Dada una operación pendiente 'contalink/create_policy' de 900 MXN y una política `--scope external_op --provider contalink --operation create_policy --max-amount 1000 --mode always`, cuando corre `mnemosine outbox --policy-only`, entonces la operación queda ejecutada, reviewed_by es 'policy:<id>' y el proceso termina con código 0 sin haber pedido ninguna entrada por teclado.
- Dado que ninguna política casa, cuando corre `mnemosine outbox --policy-only`, entonces no se ejecuta nada, el resumen dice cuántas siguen esperando revisión humana y el código de salida es 0.
- Dada la misma operación, cuando corre `mnemosine outbox --list`, entonces last_used_at de la política no cambia y ninguna política 'once' se consume.
- Dada una operación encolada hace 40 días y una política que la autoriza, cuando corre la pasada de política, entonces la operación queda en 'rejected' por el floor y la salida imprime en rojo el id, el proveedor y el motivo de antigüedad.
- Dado `mnemosine outbox --no-policy`, entonces no se llama a autoExecuteOpByPolicy y el comportamiento es idéntico al anterior a este paquete.
- Dado `grep -rn autoExecuteOpByPolicy /Users/victor/projects/Accounting/src`, entonces aparece un llamador en src/cli/mnemosine.ts.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/ai/external/external-service.spec.ts` — autoExecuteOpByPolicy lanza NoMatchingApprovalPolicyError cuando no hay política y cuando no hay monto derivable, y un Error corriente cuando la ejecución falla
- `/Users/victor/projects/Accounting/tests/cli/outbox-policy-pass.spec.ts` — la pasada de política sobre una lista de operaciones simuladas: separa ejecutadas de restantes, no consume nada en modo lista, y reporta los rechazos por antigüedad

**Riesgo.** `--policy-only` ejecuta ESCRITURAS reales contra el sistema externo sin humano delante. Mitigaciones ya presentes en el código y que la tarea no debe debilitar: matchApproval falla cerrado sin monto derivable, deriveOpAmount sólo acepta campos garantizados por el esquema del adaptador (nunca una clave libre del payload), executeExternalOp reclama de forma atómica pending→executing y ata la ejecución al hash del contenido. La tarea no introduce ningún camino nuevo de escritura: reutiliza executeExternalOp íntegro.

##### `E1.3-f` expectedHash en las tres rutas de aprobación que aún no lo pasan · **M**

canonicalDraftHash (draft-service.ts:57) cierra la ventana TOCTOU entre lo que un revisor vio y lo que se postea, y approveDraftInternal (352) la comprueba bajo el row lock — pero sólo si el llamador pasa expectedHash. De los cuatro llamadores, uno solo lo hace (mnemosine.ts:1024, el bucle de `mnemosine review`).

1) REST — POST /v1/ai/drafts/:id/approve (api/rest/routes/ai.ts:87). Es el hueco (c) del encargo: hoy pasa `req.body.notes` como cuarto argumento y nada como quinto, así que la protección anti-drift está desactivada en toda la superficie HTTP. Cambios:
- `reviewNotesSchema` pasa a `z.object({ notes: z.string().max(2000).optional(), expected_hash: z.string().regex(/^[0-9a-f]{64}$/) })`, con expected_hash OBLIGATORIO (ver decisión D4).
- La llamada pasa a `approveDraft(ctx, req.params.id, reviewer, req.body.notes, req.body.expected_hash)`.
- Para que el cliente pueda echarlo, GET /v1/ai/drafts (línea 72) devuelve cada borrador con `content_hash: canonicalDraftHash(d.payload)` añadido en el mapeo del handler; no se toca listDrafts ni la tabla.
- El error de deriva ('Draft content changed after review; approval invalidated') debe salir como 409, no como 500: mapearlo a ValidationError o a un ConflictError del catálogo de utils/errors.ts, igual que se hace con DraftValidationError en las líneas 90-93.

2) Ingesta. `approve(ctx, draft.draftId, reviewer, '...')` (ingest-service.ts:224) tampoco ata el hash. DraftCreatedInfo (tools/observer.ts:18) gana `contentHash: string`, que draft-tools.ts:61 calcula con canonicalDraftHash sobre el mismo objeto payload que acaba de construir (líneas 49-56, ya en alcance). La ingesta pasa `draft.contentHash` como quinto argumento. La vía de política ya se ata sola: autoApproveDraftByPolicy recalcula el hash del contenido que la política CASÓ (draft-service.ts:533).

3) Onboarding. onboarding-service.ts:239 tiene `payload` en alcance: `approveDraft(ctx, draft.id, reviewer, 'onboarding: opening balance approved in the wizard', canonicalDraftHash(payload))`.

**Archivos**

- `/Users/victor/projects/Accounting/src/api/rest/routes/ai.ts` — modificar: expected_hash obligatorio en el body de approve (61, 87), content_hash en la respuesta de GET /drafts (72-77), y mapeo del error de deriva a 409
- `/Users/victor/projects/Accounting/src/ai/tools/observer.ts` — modificar: DraftCreatedInfo gana contentHash
- `/Users/victor/projects/Accounting/src/ai/tools/draft-tools.ts` — modificar: calcular canonicalDraftHash del payload y emitirlo en onDraftCreated (61)
- `/Users/victor/projects/Accounting/src/ai/ingest-service.ts` — modificar: pasar draft.contentHash como quinto argumento de approve (224)
- `/Users/victor/projects/Accounting/src/ai/onboarding-service.ts` — modificar: pasar canonicalDraftHash(payload) en la aprobación del asiento de apertura (239)
- `/Users/victor/projects/Accounting/tests/api/ai-drafts-approve.spec.ts` — crear: contrato del endpoint de aprobación

**Criterios de aceptación**

- Dado un POST /v1/ai/drafts/:id/approve sin expected_hash, entonces responde 400 y no se crea ningún asiento.
- Dado un POST con expected_hash igual al content_hash devuelto por GET /v1/ai/drafts, entonces el borrador se aprueba y se postea.
- Dado que el payload del borrador cambia entre el GET y el POST, entonces la respuesta es 409, el borrador sigue en 'pending_review' y no existe asiento posteado.
- Dado GET /v1/ai/drafts, entonces cada elemento incluye content_hash de 64 caracteres hexadecimales que coincide con canonicalDraftHash(payload).
- Dada una ingesta con auto-post por umbrales, cuando el payload del borrador es modificado entre la creación y la aprobación, entonces la aprobación se invalida y el archivo queda con status 'draft'.
- Dado `grep -n 'approveDraft(' /Users/victor/projects/Accounting/src -r`, entonces las cuatro invocaciones pasan cinco argumentos.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/api/ai-drafts-approve.spec.ts` — 400 sin hash, 200 con hash correcto, 409 con hash desfasado, content_hash presente y correcto en el listado
- `/Users/victor/projects/Accounting/tests/ai/ingest-service.spec.ts` — la ingesta pasa contentHash como quinto argumento de approve

**Riesgo.** Hacer expected_hash obligatorio es un cambio incompatible del contrato /v1. Verificado que no hay ningún cliente de este endpoint dentro del repositorio (el CLI llama a los servicios directamente), pero un consumidor externo se rompería. Si la decisión D4 se resuelve por 'opcional', el resto de la tarea queda igual y sólo cambia el `.optional()` del esquema; en ese caso hay que registrar en policy-consumers/documentación que la protección anti-drift es opt-in en REST.

##### `E1.3-g` Lo que el usuario ve cuando define una política o concede una aprobación · **M**

Es el hueco (d) del encargo: hoy `mnemosine pending define` y `mnemosine approvals grant` confirman con un ✔ y nada distingue una decisión que cambia el sistema de una que no lo toca.

1) `mnemosine pending` — renderPolicies (pending-command.ts:99). Por cada fila, consultar consumerFor(p.key) y añadir una línea bajo la pregunta:
- state 'live': sólo en modo --verbose, `→ lo lee <reader>; se ve en <observableIn>`.
- state 'pending_wiring': siempre, `⏳ aún no se aplica: <blockedBy>`.
- state 'record_only': siempre, `⚠ nada lo lee todavía: <blockedBy>`.
Así el listado deja de prometer parejo lo que no cumple parejo.

2) `mnemosine pending define` (186). Tras el `✔ <key> = <valor>`:
- 'live': `Efecto: <effect>. Compruébalo con: <observableIn>.`
- distinto de 'live', en el flujo de error visible (ce): `Guardado como criterio, pero HOY nada lo lee: <blockedBy>. No cambia el comportamiento del sistema todavía.`
Además, si el valor guardado no es interpretable para una política numérica (snapshot.invalid de E1.3-b), avisar en el momento: `El valor '<v>' no es numérico; se seguirá operando con <default>.` — hoy un '35000 pesos' se guarda sin protesta.

3) init, sección S4 (s4-policies.ts:187). La misma línea tras cada `✔`, usando el mismo helper para no duplicar el texto. Exportar desde policy-consumers.ts una función pura `consumerNotice(key: string): { level: 'info'|'warn'; text: string } | null` y usarla en los tres sitios.

4) `mnemosine approvals grant` (approvals-command.ts:140-162). Tras imprimir el id y el patrón, y junto al aviso existente del cap del floor:
- scope 'draft': `La leerá \`mnemosine ingest\` cuando una compuerta de umbral no baste.` Y, leyendo la política con el puente, si ingest_auto_post no está en 'on': `⚠ ingest_auto_post = off: esta política no autorizará nada hasta que actives el auto-post (mnemosine pending define ingest_auto_post on).`
- scope 'external_op': `La leerá \`mnemosine outbox\` antes de preguntarte, y \`mnemosine outbox --policy-only\` sin preguntar.`
- `--mode session` en cualquier scope: `⚠ una política de sesión sólo casa dentro de la sesión <id>. Ni \`ingest\` ni \`outbox\` llevan id de sesión, así que esta política no se aplicará por ninguna de las dos vías.` — verificado: LlmSession (providers/types.ts:62) no expone id y el outbox no pasa opts.
- Validar en la CLI, antes de llamar a grantApproval, que `--mode session` venga con `--session <id>`: hoy esa comprobación sólo existe dentro de grantApproval y el usuario recibe el error después de resolver entidad y usuario.

5) `mnemosine approvals list` (88-104): añadir al final de cada fila el estado de consumo del scope, para que un listado de políticas viejas diga cuáles siguen siendo inertes.

6) Regenerar la referencia del CLI: `npx tsx scripts/generate-cli-reference.ts`, que reescribe src/ai/docs/cli-reference.md. Sin esto, el agente cita verbatim una ayuda sin `--policy-only` ni `--no-policy` ni `sat cred unblock`.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/policy/policy-consumers.ts` — modificar: añadir consumerNotice(key) como helper puro compartido por CLI e init
- `/Users/victor/projects/Accounting/src/cli/pending-command.ts` — modificar: renderPolicies (99) marca el estado de consumo; `define` (186) explica el efecto o la ausencia de efecto y avisa de valores no interpretables
- `/Users/victor/projects/Accounting/src/cli/init/s4-policies.ts` — modificar: askOne (187) imprime el mismo aviso tras resolver
- `/Users/victor/projects/Accounting/src/cli/approvals-command.ts` — modificar: `grant` (131-163) valida --session antes de llamar, y explica qué motor leerá la política; `list` (88) muestra el estado de consumo
- `/Users/victor/projects/Accounting/src/ai/docs/cli-reference.md` — modificar: regenerado con scripts/generate-cli-reference.ts
- `/Users/victor/projects/Accounting/tests/cli/pending-command.spec.ts` — crear: tests de los renderizadores puros, hoy sin cobertura
- `/Users/victor/projects/Accounting/tests/cli/approvals-command.spec.ts` — crear: buildPattern, parseScope, parseMode y los avisos de consumo, hoy sin cobertura

**Criterios de aceptación**

- Dado un tenant recién sembrado, cuando corre `mnemosine pending`, entonces pac_ofrece_descarga aparece con `⚠ nada lo lee todavía` y ingest_auto_post no lleva ninguna marca de advertencia.
- Dado `mnemosine pending define ingest_auto_post on`, entonces la salida incluye una línea que empieza por 'Efecto:' y nombra `mnemosine ingest`.
- Dado `mnemosine pending define pac_ofrece_descarga si_sin_efirma`, entonces la salida incluye 'nada lo lee' y el motivo, y el código de salida sigue siendo 0 (es un aviso, no un error).
- Dado `mnemosine pending define umbral_capitalizacion_mxn '35000 pesos'`, entonces avisa de que el valor no es numérico y nombra el default que se seguirá usando.
- Dado `mnemosine approvals grant --scope draft --mode always --max-amount 5000` con ingest_auto_post en 'off', entonces la salida contiene el aviso de que la política no autorizará nada y sugiere el comando exacto para activarlo.
- Dado `mnemosine approvals grant --scope draft --mode session` sin `--session`, entonces falla antes de tocar la base de datos, con el mensaje que nombra la bandera que falta.
- Dado `npx tsx scripts/generate-cli-reference.ts` tras el paquete, entonces `git diff --stat src/ai/docs/cli-reference.md` queda vacío (el doc ya está regenerado y versionado).

**Pruebas**

- `/Users/victor/projects/Accounting/tests/cli/pending-command.spec.ts` — renderPolicies marca correctamente los tres estados y sólo muestra el detalle 'live' en modo verbose
- `/Users/victor/projects/Accounting/tests/cli/approvals-command.spec.ts` — buildPattern rechaza patrón vacío; parseScope/parseMode rechazan valores fuera de catálogo; el aviso de ingest_auto_post=off aparece sólo con scope draft; el aviso de sesión aparece con --mode session

##### `E1.3-h` Puente al clasificador CFDI: umbral efectivo y respuestas implícitas por política · **M**

Construir y probar la pieza que el paquete del clasificador CFDI necesitará, sin depender de él. classifyParsed (cfdi-classifier.ts:97) ya acepta `thresholds` (139) y `answers` (158), y ya sabe convertir una respuesta en cambio de rol contable (resolveRoleOverride, 173): lo único que falta es quién arma esos dos objetos desde policy_decisions.

En policy-bridge.ts:
```ts
export async function buildPolicyThresholds(ctx: PolicyContext): Promise<PolicyThresholds>;
export async function buildClassifierPolicyInput(ctx: PolicyContext):
  Promise<{ thresholds: PolicyThresholds; answers: Record<string, string> }>;
```
buildPolicyThresholds: capitalizationThreshold = getNumber('umbral_capitalizacion_mxn'); restaurantPolicy = get('politica_restaurantes'); iepsTreatment = get('tratamiento_ieps'); inventoryPolicy = get('lleva_inventarios').

Hallazgo verificado que condiciona el diseño: de los cuatro campos de PolicyThresholds (cfdi-decisions.ts:55) sólo capitalizationThreshold se lee en algún `applies` (línea 99, decisión gasto_vs_activo). Los otros tres son inertes incluso dentro del clasificador. Por eso el consumo real de esas tres políticas NO va por `thresholds` sino por RESPUESTAS IMPLÍCITAS, que es el mecanismo que el clasificador ya tiene:
- answers['ieps_acreditable'] = get('tratamiento_ieps') si el valor es 'costo' o 'acreditable'. Efecto observable: la decisión advisory desaparece de `decisions[]` y, con 'acreditable', resolveRoleOverride cambia el rol de la línea a ieps_acreditable.
- answers['periodo_cerrado'] = get('cfdi_periodo_cerrado') si es 'periodo_actual' o 'reabrir'. El valor 'preguntar' (default del catálogo) NO produce respuesta: es literalmente la instrucción de seguir preguntando.
- answers['consumo_restaurante'] = get('politica_restaurantes'), según la decisión D2.

REGLA DURA, y es la propiedad que da sentido al paquete: sólo se auto-responde cuando `snapshot.isDefined(key)` es true. Un default del catálogo jamás silencia una decisión. Operar con un default y aplicar el criterio de un despacho son cosas distintas, y confundirlas haría que el sistema decidiera en nombre de alguien que no ha decidido.

Contrato para el llamador futuro (documentarlo en el docstring de buildClassifierPolicyInput):
```ts
const pol = await buildClassifierPolicyInput(ctx);
await classifyParsed(parsed, { ...opts, thresholds: pol.thresholds,
                               answers: { ...pol.answers, ...(opts.answers ?? {}) } });
```
Las respuestas explícitas del usuario ganan siempre sobre las implícitas de política.

Además, en cfdi-decisions.ts: dejar restaurantPolicy, iepsTreatment e inventoryPolicy en PolicyThresholds y añadir en su comentario (línea 52-60) que su consumo es por respuestas implícitas desde policy-bridge y no por `applies`, para que nadie vuelva a leer el tipo como si estuviera cableado. Si la decisión D3 se resuelve por el filtrado de opciones, añadir aquí la función pura `filterOptionsByPolicy(decision: DecisionPoint, t: PolicyThresholds): DecisionOption[]`.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/policy/policy-bridge.ts` — modificar: añadir buildPolicyThresholds y buildClassifierPolicyInput con la regla de sólo-si-definida
- `/Users/victor/projects/Accounting/src/services/xml-ingestion/cfdi-decisions.ts` — modificar: documentar en PolicyThresholds (52-60) que tres de sus cuatro campos se consumen por respuestas implícitas; opcionalmente filterOptionsByPolicy según D3
- `/Users/victor/projects/Accounting/tests/xml-ingestion/cfdi-policy-bridge.spec.ts` — crear: el efecto de cada política sobre la salida de classifyXml

**Criterios de aceptación**

- Dado umbral_capitalizacion_mxn definido en '50000' y un CFDI recibido tipo I de subtotal 30 000 sin clave de activo fijo, cuando se clasifica con los thresholds del puente, entonces la decisión gasto_vs_activo NO aparece en `decisions`; con el umbral en '5000', entonces sí aparece.
- Dado tratamiento_ieps DEFINIDO en 'acreditable' y un CFDI con IEPS trasladado, entonces la decisión ieps_acreditable no aparece en `decisions` y la línea del gasto sale con rol ieps_acreditable.
- Dado tratamiento_ieps NO definido (operando con el default 'costo'), entonces la decisión ieps_acreditable SÍ aparece: un default nunca auto-responde.
- Dado cfdi_periodo_cerrado definido en 'preguntar' y periodOpen=false, entonces la decisión periodo_cerrado aparece igual que hoy.
- Dadas respuestas explícitas y de política para la misma decisión, entonces gana la explícita.
- Dado `npm test`, entonces las 1155 pruebas previas siguen verdes: buildClassifierPolicyInput no tiene todavía llamador en producción y no puede alterar ningún camino vivo.

**Pruebas**

- `/Users/victor/projects/Accounting/tests/xml-ingestion/cfdi-policy-bridge.spec.ts` — umbral definido cambia qué decisiones dispara un mismo CFDI; política definida auto-responde y cambia el rol de la línea; política no definida no auto-responde; la respuesta explícita gana

**Riesgo.** Esta tarea entrega código sin llamador de producción, que es justo la enfermedad que el paquete trata. Se acepta porque (1) queda declarada como 'pending_wiring' en POLICY_CONSUMERS con su bloqueador nombrado, (2) el usuario lo ve en `mnemosine pending`, y (3) el paquete del clasificador recibe una interfaz probada en vez de tener que inventarla. Si esa condición no se cumple —si el registro de consumidores no la marca—, esta tarea debe posponerse hasta el paquete del clasificador.

#### Cómo se sabe que cerró

- `npm run typecheck` devuelve 0 y `npm test` pasa completo, con al menos 30 pruebas nuevas repartidas en tests/policy/, tests/cli/, tests/api/ y tests/fiscal-credentials/.
- `grep -rn 'loadPolicySnapshot\|resolveIngestPolicyDefaults\|resolveEfirmaPolicy\|buildClassifierPolicyInput' /Users/victor/projects/Accounting/src --include='*.ts' | grep -v '/services/policy/'` devuelve al menos un llamador en cada uno de: src/cli/mnemosine.ts, src/services/fiscal-credentials/service.ts y src/cli/approvals-command.ts. Hoy devuelve cero líneas para getPolicy/getPolicyNumber.
- `grep -rn 'autoApproveDraftByPolicy\|autoExecuteOpByPolicy' /Users/victor/projects/Accounting/src --include='*.ts'` devuelve llamadores en src/ai/ingest-service.ts y src/cli/mnemosine.ts, además de sus definiciones. Hoy devuelve sólo definiciones y un comentario.
- `grep -rn 'approveDraft(' /Users/victor/projects/Accounting/src --include='*.ts'` muestra cuatro invocaciones y las cuatro pasan cinco argumentos (expectedHash incluido).
- tests/policy/policy-consumers.spec.ts pasa: la sincronía catálogo↔consumidores está verificada por código, no por revisión humana.
- Escenario reproducible de extremo a extremo: en un tenant nuevo, `mnemosine pending define ingest_auto_post on`, `mnemosine pending define ingest_auto_post_max_monto 5000`, `mnemosine approvals grant --scope draft --kind journal_entry --max-amount 3000 --mode always`, e `mnemosine ingest factura.xml` con un CFDI de 1200 MXN clasificado con confianza 0.80 → el archivo sale con status auto_post y policyId poblado. Repitiendo con `mnemosine pending define ingest_auto_post off` → sale como draft. Ninguno de los dos resultados es alcanzable hoy.
- Escenario de outbox: con una operación pendiente y una política de external_op que la cubre, `mnemosine outbox --policy-only` la ejecuta sin pedir entrada por teclado y termina con código 0.
- `npx tsx scripts/generate-cli-reference.ts` no produce diff: src/ai/docs/cli-reference.md ya refleja `outbox --policy-only`, `outbox --no-policy` y `sat cred unblock`.
- `npm run migrate` aplica 031_credential_blocked_status.sql y reaplica rls-policies.sql sin error sobre una base con la 030.


### E1.4 · E1.4 · Módulos sin puerta de entrada y atestaciones simuladas: decidir, cablear o retirar
**Objetivo.** Cerrar el circuito de la depreciación (alta de datos maestros por CLI, corrida mensual correcta, enganche con el checklist de cierre) y eliminar toda superficie que aparente una capacidad inexistente: la capa blockchain deja de publicar datos simulados como reales y de persistir el valor en claro dentro de su propia "prueba"; inventarios y src/services/mexico/cfdi.ts quedan retirados de forma explícita en vez de seguir inflando el mapa de capacidades.

**Por qué aquí.** El motor ya tiene su capa semántica sembrada (E1.1), así que la depreciación puede resolver cuentas por account_roles en vez de por códigos literales. El item 4 del checklist de cierre (period-close.ts:79-95) es hoy insatisfacible por construcción: cada cierre de mes arrastra un warning permanente que enseña al usuario a ignorar el checklist. Y la purga de datos simulados es prerrequisito de credibilidad: no tiene sentido invertir en el clasificador CFDI o en el perímetro multi-tenant mientras /public/v1 devuelve verified:true con txHash inventados.

**Depende de:** `E1.1` · **Migraciones:** `035-039` · **11 tareas · 5.4 sem-persona**

**Precondiciones:**

- E1.1 cerrado: seedAccountRoles corre desde `mnemosine init` y account_roles tiene sus 31 filas por entidad. E1.4-e añade tres roles sobre ese mismo mecanismo; sin E1.1 el alta de activos no puede resolver cuentas por rol.
- El catálogo de src/database/seed.ts ya contiene 1290 'Depreciación Acumulada' (contra_asset, seed.ts:87), 6140 'Depreciación' (expense, seed.ts:114) y 1210/1220/1230 de activo fijo. Un catálogo importado por `mnemosine onboard` puede no tenerlos: E1.4-e debe crearlos si faltan, igual que account-roles-seed.ts hace con REQUIRED_ACCOUNTS.
- Decisiones D1..D6 resueltas por un humano antes de empezar. D1 y D3 bloquean el paquete entero; D2 y D4 bloquean solo sus tareas.
- Última migración aplicada: 030_webhook_token_rls.sql. Las nuevas van con prefijo 031/032. migrate.ts reaplica src/database/rls-policies.sql tras cada migración; ninguna tabla nueva se crea aquí, así que no hay que tocar ese archivo.

#### Decisiones a resolver

**D1 · Depreciación de activo fijo: ¿construir la puerta de entrada o retirar el módulo?**

src/services/assets/depreciation.ts (380 líneas, 6 métodos, MACRS con tablas completas) no tiene llamador. El checklist de cierre ya cuenta activos sin depreciar (period-close.ts:80-95) y emite warning — no bloquea, contra lo que afirma el atlas, pero el item nunca puede marcarse completo. El catálogo sembrado ya tiene las cuentas (1290/6140). Retirar significaría además borrar el item 4 del checklist y la mitad de las columnas de fixed_assets.

- Construir: CLI de alta (categorías + activos) + corrida mensual + enganche con `mnemosine close`
- Retirar: borrar depreciation.ts, el item 4 del checklist y las tablas asset_categories/fixed_assets/depreciation_schedules
- Congelar: dejar el código y quitar solo el item 4 del checklist para que el cierre deje de mentir

_Recomendación:_ Construir. Es la opción con mejor relación valor/esfuerzo del paquete: la aritmética ya está escrita y probada conceptualmente, las cuentas existen, y la depreciación es obligatoria en cualquier contabilidad mexicana real (NIF C-6). Lo que falta es alta de datos maestros y un comando — no una función nueva. Retirar dejaría al producto sin activo fijo, que es un requisito de cualquier despacho.

_Bloquea:_ E1.4-d, E1.4-e, E1.4-f, E1.4-g, E1.4-k

**D2 · Inventarios por capas (PEPS/UEPS/promedio): ¿construir o retirar?**

src/services/inventory/costing.ts no tiene llamador. Hay un conflicto contable duro que hace inviable cablearlo tal cual: recordInventorySale (costing.ts:178) crea un asiento DR CxC / CR Ingreso / DR COGS / CR Inventario, exactamente el mismo DR CxC / CR Ingreso que ya crea postInvoiceEntry (ar-ap-posting.ts:58). Si ambos corrieran sobre la misma venta, el ingreso se duplica. Además invoice_lines.item_id es un UUID sin FK (002_ap_ar_schema.sql:95): no hay ningún vínculo entre la facturación y el subledger de inventarios. Consecuencia colateral verificada: hoy el sistema no registra costo de ventas por ninguna vía.

- Construir completo ahora: CLI de items, entradas por compra, y sustituir la parte AR de recordInventorySale por un enganche de solo-COGS dentro de postInvoiceEntry
- Construir mínimo: conservar el subledger de capas y calculateFIFO/LIFO/WeightedAverage como funciones puras, borrar recordInventorySale, y dejar el asiento de COGS para un paquete posterior
- Retirar: borrar costing.ts y las tres tablas de inventario

_Recomendación:_ Opción 2 (construir mínimo, sin puerta de entrada todavía) ejecutada en este paquete como cuarentena: borrar recordInventorySale —que es el trozo peligroso, porque duplicaría ingresos si alguien lo cableara— y dejar el resto del módulo marcado como no productivo, con un chequeo de `mnemosine doctor` que lo declare. El COGS depende del clasificador CFDI y de una ruta de facturación por ítem que aún no existe; construirlo aquí es prematuro y retirarlo del todo tiraría 250 líneas de aritmética de capas correcta.

_Bloquea:_ E1.4-h

**D3 · Capa blockchain: ¿construir backends reales, dejarla como simulación etiquetada, o retirarla?**

EvmChainAdapter.submitAttestation (chain-adapters.ts:124-143) devuelve status:'confirmed' con txHash de crypto.createHash(...+Date.now()+Math.random()) y blockNumber de simulateBlockNumber(). zkverify-client.ts:40 tiene el bloque de producción literalmente vacío. bitcoin-anchor.ts:137-140 fabrica el txid con sha256(payload+Date.now()). No hay ningún import de ethers ni de bitcoinjs-lib en src/. Mitigante verificado: blockchain_config solo se escribe desde PUT /v1/admin/blockchain/config (blockchain.ts:112) y attestJournalEntry retorna null sin fila is_active, así que en una instalación CLI-first la capa está apagada — pero /public/v1 se monta siempre (index.ts:100).

- Construir backends reales (ethers.js + RPC + contrato desplegado + nodo Bitcoin o Blockstream API)
- Mantener como simulación explícitamente etiquetada, apagada por defecto y con la superficie pública desmontada salvo activación deliberada
- Retirar la capa entera: borrar src/services/blockchain, las rutas y las tablas de 006

_Recomendación:_ Opción 2. Construir backends reales es un proyecto propio (contratos, custodia de llaves, presupuesto de gas) que no cabe en esta etapa; retirar borraría el hash de asiento y el árbol de Merkle, que sí tienen valor de integridad interna aunque nunca toquen una cadena. Lo urgente y barato es que deje de mentir: modo explícito, `is_simulated` en la base, /public/v1 desmontado por defecto, y purga del secreto del range proof. La opción 1 queda como decisión de trimestre.

_Bloquea:_ E1.4-a, E1.4-b, E1.4-c

**D4 · src/services/mexico/cfdi.ts: ¿rescatar alguna pieza o retirar el archivo entero?**

Cero llamadores. Contiene cuatro cosas de valor desigual: (a) SAT_CATALOGS, catálogos SAT completos y correctos que no se duplican en ningún otro sitio (cfdi-facts.ts solo define su propia constante FORMA_PAGO_EFECTIVO='01'); (b) generateCfdiXml, que arma CFDI 4.0 sin sello ni certificado y que la ruta REST de timbrado ni siquiera usa (invoices.ts:396 admite en comentario que 'real implementation would use cfdi.ts generateCfdiXml' y arma un XML mínimo aparte); (c) stampWithPAC/cancelWithPAC, simuladores que duplican y contradicen a pac-router; (d) generateDIOT, que sí produce el archivo pipe-delimited pero con dos defectos: agrega sobre bills en base devengada (la DIOT es sobre operaciones PAGADAS) y no separa por tasa 16/8/0/exento, que son columnas distintas de la declaración.

- Retirar el archivo entero
- Retirar todo salvo SAT_CATALOGS, movido a src/services/xml-ingestion/sat-catalogs.ts
- Retirar todo salvo SAT_CATALOGS y además dar puerta de entrada a generateDIOT con un comando `mnemosine diot`

_Recomendación:_ Opción 2. SAT_CATALOGS es dato de referencia útil y sin coste; generateCfdiXml y los dos simuladores de PAC son deuda que confunde (hay tres adaptadores PAC más en src/services/integrations/mexico/pac/ y este archivo es un cuarto camino muerto). generateDIOT NO debe exponerse: publicar un archivo de declaración calculado en base devengada y sin desglose por tasa es exactamente el pecado que este paquete corrige. Se archiva y se reconstruye sobre base de efectivo cuando el clasificador CFDI esté cableado.

_Bloquea:_ E1.4-i

**D5 · Convención de inicio y prorrateo de la depreciación**

fixed_assets.depreciation_start_date es NOT NULL y hoy no hay nadie que la calcule: la fija quien inserte por SQL. calculateStraightLine genera cuotas mensuales completas desde esa fecha. Hace falta una regla por defecto para el alta.

- Mes completo desde el primer día del mes en que el activo queda disponible para uso
- Prorrateo por días desde la fecha exacta de disponibilidad
- Convención de medio año (half-year), habitual en MACRS fiscal de EE. UU.

_Recomendación:_ Opción 1 como valor por defecto, con --start-date para sobrescribirla. Es la convención habitual en México, es la que la aritmética actual ya implementa sin cambios (cuotas mensuales uniformes), y evita el prorrateo parcial que ninguno de los 6 métodos escritos contempla. Nota: calculateMACRS ya aplica su propia media anualidad internamente (6 meses el primer y el último año, depreciation.ts:174), así que la convención de alta no debe interferir con ese método.

_Bloquea:_ E1.4-d

**D6 · ¿La depreciación no posteada debe bloquear el cierre, o seguir siendo un warning?**

Hoy es warning (period-close.ts:95 hace warnings.push, no blocking_issues.push), de modo que el cierre suave procede con activos sin depreciar. hardClosePeriod no vuelve a evaluar el checklist: solo exige status='soft_close' (period-close.ts:178).

- Dejarlo como warning y añadir solo la sugerencia de remediación
- Convertirlo en blocking_issue del cierre suave
- Warning en el cierre suave, bloqueo en el duro (requiere que hardClosePeriod reevalúe el checklist)

_Recomendación:_ Opción 1 en este paquete. Convertirlo en bloqueo antes de que exista un histórico de activos dados de alta por la CLI dejaría a las entidades ya sembradas sin poder cerrar. La sugerencia de remediación ('mnemosine assets depreciate') convierte el item en accionable, que es lo que hoy falta. La opción 3 es la correcta a medio plazo y debe abrirse como paquete propio junto con la reevaluación del checklist en el cierre duro.

_Bloquea:_ E1.4-g

#### Tareas

##### `E1.4-a` Purgar el valor en claro y el blinding factor del range proof, y limpiar las filas ya escritas · **S**

En src/services/blockchain/crypto-service.ts, generateRangeProof (línea 106) construye proofData con los campos _test_value (el importe total_debits en claro) y _test_bf (el blinding factor del compromiso). Ese buffer se persiste DOS veces por atestación, no una: el orquestador lo escribe en blockchain_attestations.range_proof y, porque zkVerifyClient.verifyProof devuelve el mismo buffer que recibió (zkverify-client.ts:55, `proof: req.proof`), también en blockchain_attestations.zkverify_proof (orchestrator.ts:119, parámetros $3 y $4 son el mismo Buffer). Cualquiera con SELECT sobre esa tabla puede abrir el compromiso: la confidencialidad que el esquema Pedersen simulado pretende dar es nula. (1) Borrar las dos claves de proofData; el objeto queda {scheme,min,max,timestamp}. (2) verifyRangeProof (línea 137) solo comprueba data.scheme, así que no requiere cambios. (3) Buscar en tests cualquier aserción sobre _test_value/_test_bf y reescribirla contra verifyCommitment(commitment, value, blindingFactor) (crypto-service.ts:91), que es la vía legítima de verificación en pruebas y no exige persistir el secreto. (4) Migración 031 que purga las filas existentes en ambas columnas BYTEA.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/blockchain/crypto-service.ts` — modificar: eliminar las líneas 123-125 (comentario, _test_value, _test_bf) del objeto proofData en generateRangeProof
- `/Users/victor/projects/Accounting/src/database/migrations/031_purge_range_proof_secrets.sql` — crear: purga de _test_value/_test_bf en blockchain_attestations.range_proof y .zkverify_proof

**Migración**

```sql
-- 031: purga del valor en claro y del blinding factor persistidos dentro del range proof.
-- Ambas columnas son BYTEA y guardan el MISMO buffer JSON (orchestrator.ts:119),
-- porque zkVerifyClient devuelve el proof que recibe. Se purgan las dos.
UPDATE blockchain_attestations
   SET range_proof = convert_to(
         ((convert_from(range_proof, 'UTF8')::jsonb) - '_test_value' - '_test_bf')::text, 'UTF8')
 WHERE range_proof IS NOT NULL
   AND convert_from(range_proof, 'UTF8') LIKE '{%'
   AND (convert_from(range_proof, 'UTF8')::jsonb) ? '_test_value';

UPDATE blockchain_attestations
   SET zkverify_proof = convert_to(
         ((convert_from(zkverify_proof, 'UTF8')::jsonb) - '_test_value' - '_test_bf')::text, 'UTF8')
 WHERE zkverify_proof IS NOT NULL
   AND convert_from(zkverify_proof, 'UTF8') LIKE '{%'
   AND (convert_from(zkverify_proof, 'UTF8')::jsonb) ? '_test_value';
```

**Criterios de aceptación**

- Dado un asiento posteado con la atestación activa, cuando corre attestJournalEntry, entonces `SELECT convert_from(range_proof,'UTF8') FROM blockchain_attestations` no contiene la subcadena '_test_' en ninguna fila, y tampoco la contiene zkverify_proof.
- Dada una base con atestaciones previas al cambio, cuando se aplica la migración 031, entonces la consulta `SELECT count(*) FROM blockchain_attestations WHERE range_proof IS NOT NULL AND convert_from(range_proof,'UTF8') LIKE '%_test_%'` devuelve 0, y lo mismo para zkverify_proof.
- Dado un compromiso y su blinding factor, cuando se llama verifyCommitment con el valor correcto, entonces devuelve true; con un valor distinto, false. (La verificación en pruebas ya no depende de que el secreto esté en la base.)

**Pruebas**

- `tests/blockchain/crypto-service.spec.ts` — generateRangeProof: el JSON del buffer devuelto tiene exactamente las claves scheme/min/max/timestamp y no contiene el importe ni el blinding factor
- `tests/blockchain/crypto-service.spec.ts` — verifyRangeProof sigue devolviendo true sobre un proof sin los campos purgados, y false sobre un buffer que no es JSON

**Riesgo.** La migración usa el operador jsonb '?' dentro de un archivo .sql: si el runner de migraciones parte por ';' de forma ingenua no hay problema (no hay ';' embebidos), pero si usa parámetros con '?' podría confundirse. Verificar contra src/database/migrate.ts antes de dar por buena; alternativa sin '?': usar `convert_from(range_proof,'UTF8') LIKE '%_test_value%'` como único predicado.

##### `E1.4-b` Modo de atestación explícito, marca is_simulated en la base y desmontaje por defecto de /public/v1 · **M**

Introducir un único interruptor que gobierne toda la capa. (1) En src/config/index.ts añadir un bloque `attestation: { mode: (process.env.ATTESTATION_MODE ?? 'disabled') as 'disabled'|'simulated'|'live', publicSurface: process.env.PUBLIC_VERIFICATION_ENABLED === 'true' }` junto al bloque `pac` (línea 93). (2) Crear src/services/blockchain/mode.ts con `export function attestationMode(): 'disabled'|'simulated'|'live'` y `export function assertBackendAvailable(): void`, que lanza AccountingError('ATTESTATION_BACKEND_NOT_IMPLEMENTED', 'ATTESTATION_MODE=live requiere un adaptador de cadena real; hoy solo existen simuladores en chain-adapters.ts, zkverify-client.ts y bitcoin-anchor.ts') cuando el modo es 'live'. (3) En BlockchainOrchestrator.attestJournalEntry (orchestrator.ts:26), commitPeriod (:208) y anchorToBitcoin (:359), primera línea: `if (attestationMode() === 'disabled') return null;` — commitPeriod hoy devuelve un objeto no nulable, así que su firma pasa a `Promise<{...} | null>` y el handler REST de blockchain.ts:398 debe responder 409 con código ATTESTATION_DISABLED cuando reciba null. Segunda línea de las tres: `assertBackendAvailable();`. (4) Migración 032: añadir `is_simulated BOOLEAN NOT NULL DEFAULT true` a blockchain_attestations, period_commitments y bitcoin_anchors, y escribirlo desde el orquestador y desde bitcoinAnchorService.anchorToBitcoin con `attestationMode() === 'simulated'`. (5) En src/index.ts línea 100, condicionar el montaje: `if (config.attestation.publicSurface) app.use('/public/v1', rateLimiter, publicVerificationRouter); else logger.info('/public/v1 no montado (PUBLIC_VERIFICATION_ENABLED != true)')`. Nota: el comentario de public-verification.ts:13 afirma que la superficie ya está cubierta por el limitador global, lo cual es falso — rateLimiter solo cuelga de /v1 y /v1/ai/webhooks (index.ts:108 y :118).

**Archivos**

- `/Users/victor/projects/Accounting/src/config/index.ts` — modificar: añadir el bloque `attestation` con mode y publicSurface
- `/Users/victor/projects/Accounting/src/services/blockchain/mode.ts` — crear: attestationMode() y assertBackendAvailable()
- `/Users/victor/projects/Accounting/src/services/blockchain/orchestrator.ts` — modificar: gate de modo al inicio de attestJournalEntry, commitPeriod y anchorToBitcoin; commitPeriod pasa a devolver null cuando está deshabilitado; escribir is_simulated en los INSERT de blockchain_attestations (línea 83) y period_commitments (línea 249)
- `/Users/victor/projects/Accounting/src/services/blockchain/bitcoin-anchor.ts` — modificar: escribir is_simulated en el INSERT de bitcoin_anchors (línea 143)
- `/Users/victor/projects/Accounting/src/api/rest/routes/blockchain.ts` — modificar: los handlers de /commit-period (:398), /publish-aggregates (:412) y el de anclaje Bitcoin (:337) responden 409 ATTESTATION_DISABLED ante null
- `/Users/victor/projects/Accounting/src/index.ts` — modificar: línea 100, montaje condicional de publicVerificationRouter con rateLimiter delante
- `/Users/victor/projects/Accounting/src/database/migrations/032_attestation_simulated_flag.sql` — crear: columna is_simulated en las tres tablas

**Migración**

```sql
-- 032: marca explícita de atestación simulada.
-- DEFAULT true es deliberado: todo lo escrito hasta hoy salió de adaptadores
-- simulados (chain-adapters.ts:124, zkverify-client.ts:44, bitcoin-anchor.ts:137),
-- así que el retroactivo correcto es 'simulada', no 'real'.
ALTER TABLE blockchain_attestations ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE period_commitments      ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE bitcoin_anchors         ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT true;
```

**Criterios de aceptación**

- Dado ATTESTATION_MODE sin definir, cuando se postea un asiento con autoPost, entonces attestEntryAsync no crea ninguna fila en blockchain_attestations y el posteo termina sin error (attestEntryAsync ya captura y degrada a console.warn, posting.ts:41-47).
- Dado ATTESTATION_MODE=live, cuando se invoca attestJournalEntry, entonces lanza AccountingError con code 'ATTESTATION_BACKEND_NOT_IMPLEMENTED' y no escribe ninguna fila.
- Dado ATTESTATION_MODE=simulated, cuando se atesta un asiento, entonces la fila de blockchain_attestations tiene is_simulated = true.
- Dado PUBLIC_VERIFICATION_ENABLED sin definir, cuando el servidor arranca, entonces GET /public/v1/verify/0x<64 hex> devuelve 404 de Express (ruta no montada) y no toca la base.
- Dado PUBLIC_VERIFICATION_ENABLED=true, cuando se hacen 200 peticiones a /public/v1 desde la misma IP dentro de la ventana, entonces el limitador responde 429 antes de agotarlas (hoy no lo hace: rateLimiter no cuelga de /public/v1).

**Pruebas**

- `tests/blockchain/mode.spec.ts` — attestationMode() devuelve 'disabled' sin variable de entorno; assertBackendAvailable lanza solo en 'live'
- `tests/blockchain/orchestrator-gate.spec.ts` — attestJournalEntry devuelve null en modo disabled sin ejecutar ninguna query (mock de query con contador de llamadas en cero)
- `tests/api/public-surface-mount.spec.ts` — createApp() no expone /public/v1 cuando PUBLIC_VERIFICATION_ENABLED no es 'true'

**Riesgo.** Cambiar la firma de commitPeriod a nulable rompe la compilación de blockchain.ts si se olvida el handler; `npm run typecheck` lo detecta. Segundo riesgo: si alguna instalación ya tiene blockchain_config.is_active=true y depende de /public/v1, el desmontaje es un cambio observable — documentarlo en el mensaje de arranque y en docs/cli-command-catalog.md.

##### `E1.4-c` Sanear el router público: handlers que no cuelguen, y dejar de exponer tenant_id en un endpoint sin autenticación · **S**

Solo aplica cuando la superficie se activa deliberadamente (E1.4-b), pero debe quedar correcta antes de permitirlo. (1) Los siete handlers de src/api/rest/routes/public-verification.ts (líneas 20, 114, 152, 212, 238, 290, 308) son funciones async desnudas. Con Express 4.22.1 (verificado en node_modules), un throw dentro de un handler async produce una promesa rechazada que nunca llega al errorHandler: la petición se queda colgada hasta el timeout del cliente. Envolver los siete en asyncHandler, importado de '../middleware/async-handler.js' (mismo patrón que blockchain.ts:6). (2) El SELECT de la línea 39 pide tenant_id y entity_id de blockchain_attestations en un endpoint sin autenticación; tenant_id no se usa en la respuesta y entity_id sí se devuelve (línea 65). Quitar tenant_id de la proyección y devolver entity_id solo cuando legal_entities.is_active sea true para esa entidad, replicando la comprobación que ya hace GET /public/v1/entities/:entityId (línea 125). (3) Añadir a la respuesta de /verify/:entryHash los campos `simulated: a.is_simulated` y forzar `verified: a.status === 'confirmed' && !a.is_simulated`, más un campo `disclaimer` cuando simulated sea true con el texto: 'Esta atestación fue generada por adaptadores de simulación; el txHash y el número de bloque no corresponden a ninguna transacción real en cadena.' Mismo tratamiento en /bitcoin/verify/:txid y /bitcoin/proof/:entryHash. (4) En independentVerification.steps, no ofrecer los pasos 4 y 5 (verificar en el explorador de zkVerify y en los exploradores de cadena) cuando simulated sea true: son instrucciones que fallarán.

**Archivos**

- `/Users/victor/projects/Accounting/src/api/rest/routes/public-verification.ts` — modificar: envolver los 7 handlers en asyncHandler; quitar tenant_id de la proyección de la línea 39; añadir is_simulated a la proyección; simulated/disclaimer en las tres respuestas de verificación; podar los pasos de verificación inaplicables

**Criterios de aceptación**

- Dado PUBLIC_VERIFICATION_ENABLED=true y un entryHash con formato inválido, cuando se hace GET /public/v1/verify/abc, entonces la respuesta llega en menos de un segundo con código 400 y cuerpo {errors:[{code:'VALIDATION_ERROR',...}]} — hoy la petición se cuelga.
- Dado un txid inexistente, cuando se hace GET /public/v1/bitcoin/verify/<64 hex>, entonces responde 404 y no se cuelga.
- Dada una atestación con is_simulated = true, cuando se consulta /public/v1/verify/:entryHash, entonces la respuesta trae verified:false, simulated:true y el texto de disclaimer, y sus steps no mencionan exploradores de cadena.
- Dado cualquier entryHash, cuando se consulta el endpoint, entonces el cuerpo de la respuesta no contiene la clave tenantId ni el valor de tenant_id en ninguna forma.

**Pruebas**

- `tests/api/public-verification.spec.ts` — los 7 endpoints propagan errores al errorHandler y responden con status (no timeout): un caso por handler, con supertest sobre createApp()
- `tests/api/public-verification.spec.ts` — una atestación simulada devuelve verified:false + simulated:true; una no simulada con status confirmed devuelve verified:true
- `tests/api/public-verification.spec.ts` — la respuesta de /verify/:entryHash no incluye tenant_id

##### `E1.4-d` Alta de datos maestros de activo fijo desde la CLI: categorías y activos · **L**

Crear el servicio y el comando que hoy no existen (asset_categories y fixed_assets solo se pueblan por SQL directo; `grep -rn 'INSERT INTO fixed_assets|INSERT INTO asset_categories' src scripts` devuelve cero). Nuevo archivo src/services/assets/asset-registry.ts con cuatro funciones:

`export async function createAssetCategory(entityId: string, input: {name: string; parentId?: string; defaultUsefulLifeYears?: number; defaultDepreciationMethod?: DepreciationMethod; defaultAssetAccountId?: string; defaultDepreciationAccountId?: string; defaultExpenseAccountId?: string}): Promise<AssetCategory>` — INSERT simple, sin transacción propia (una sola sentencia).

`export async function listAssetCategories(entityId: string): Promise<AssetCategory[]>` — SELECT ... WHERE entity_id=$1 AND is_active ORDER BY name.

`export async function createFixedAsset(entityId: string, userId: string, input: {assetName: string; categoryId: string; acquisitionDate: Date; acquisitionCost: string; salvageValue?: string; usefulLifeYears?: number; depreciationMethod?: DepreciationMethod; macrsClass?: string; depreciationStartDate?: Date; vendorId?: string; serialNumber?: string; location?: string; description?: string}): Promise<FixedAsset>` — corre entera dentro de un único withTransaction(async (client) => ...). Orden de operaciones: (1) leer la categoría FOR SHARE y fallar con AccountingError('CATEGORY_NOT_FOUND') si no pertenece a entityId; (2) resolver las tres cuentas por precedencia explícito > default de la categoría > account_roles, usando la función roleAccounts que ya existe en ar-ap-posting.ts (líneas 28-35, exportarla si no lo está) con los roles 'activo_fijo', 'depreciacion_acumulada' y 'depreciacion_gasto' (E1.4-e los siembra), y lanzar AccountingError('MISSING_ROLE_ACCOUNT', 'No hay cuenta para el rol "<rol>" en esta entidad — ejecuta `mnemosine init`') si falta alguna; (3) asset_number = await nextEntityNumber(client, entityId, 'fixed_asset', 'AF') (src/utils/sequence.ts:12) — NUNCA COUNT(*)+1; (4) usefulLifeMonths = usefulLifeYears*12; (5) depreciationStartDate por defecto = primer día del mes de acquisitionDate, según la decisión D5; (6) current_book_value = acquisitionCost, accumulated_depreciation = 0, status='active'; (7) INSERT y RETURNING *.

`export async function listFixedAssets(entityId: string, opts?: {status?: AssetStatus}): Promise<FixedAsset[]>`.

Validaciones que deben fallar en el servicio y no en el CHECK de Postgres (la migración 003 impone acquisition_cost > 0, salvage_value >= 0, useful_life_* > 0 y acquisition_cost > salvage_value, y un error de CHECK es ilegible para el usuario de CLI): lanzar ValidationError con mensaje propio para cada uno de esos cuatro casos antes de intentar el INSERT.

CLI: nuevo src/cli/assets-command.ts que exporta `registerAssetsCommand(program: Command, deps: CloseCliDeps): void`, copiando la forma de src/cli/close-command.ts (bootstrapTenant(opts.tenant) → resolveEntity(opts.entity) → resolveReviewer(ctx.tenantId, opts.user) → deps.shutdown). Subcomandos: `assets categories list`, `assets categories add --name --life-years --method [--asset-account|--dep-account|--expense-account]`, `assets list [--status]`, `assets add --name --category --cost --life-years [--method --salvage --acquired --start-date --serial --location]`. Alias del comando raíz: 'activos'. Toda opción --entity/--tenant/--user/--json común, como en close-command. Registrar en src/cli/mnemosine.ts junto a los demás (línea 1598, tras registerCloseCommand).

**Archivos**

- `/Users/victor/projects/Accounting/src/services/assets/asset-registry.ts` — crear: createAssetCategory, listAssetCategories, createFixedAsset, listFixedAssets
- `/Users/victor/projects/Accounting/src/cli/assets-command.ts` — crear: registerAssetsCommand con los subcomandos categories/list/add y alias 'activos'
- `/Users/victor/projects/Accounting/src/cli/mnemosine.ts` — modificar: importar y llamar registerAssetsCommand(program, {palette: c, shutdown, reportError}) tras la línea 1598
- `/Users/victor/projects/Accounting/src/services/accounting/ar-ap-posting.ts` — modificar: exportar roleAccounts (hoy es interna) para reutilizarla desde asset-registry sin duplicar la consulta a account_roles
- `/Users/victor/projects/Accounting/docs/cli-command-catalog.md` — modificar: documentar `mnemosine assets` y su alias `activos`

**Criterios de aceptación**

- Dada una entidad recién inicializada con `mnemosine init`, cuando se ejecuta `mnemosine assets categories add --name 'Equipo de Cómputo' --life-years 3 --method straight_line`, entonces asset_categories tiene una fila para esa entidad y el comando sale con código 0.
- Dada esa categoría, cuando se ejecuta `mnemosine assets add --name 'MacBook Pro' --category 'Equipo de Cómputo' --cost 45000 --life-years 3`, entonces fixed_assets tiene una fila con asset_number 'AF-<año>-00001', useful_life_months 36, current_book_value 45000.0000, accumulated_depreciation 0, status 'active', y las tres cuentas resueltas a 1210/1290/6140 del catálogo sembrado.
- Dado un segundo alta concurrente en la misma entidad, cuando ambas transacciones commitean, entonces los asset_number son distintos (entity_sequences serializa el incremento) y ninguna viola UNIQUE(asset_number, entity_id).
- Dada una entidad SIN los roles de depreciación en account_roles, cuando se ejecuta `mnemosine assets add`, entonces falla con MISSING_ROLE_ACCOUNT y el mensaje nombra el rol concreto que falta — no con un error de constraint de Postgres.
- Dado --cost 1000 --salvage 2000, cuando se ejecuta el alta, entonces falla con ValidationError y mensaje legible antes de tocar la base (no con 'violates check constraint').
- Dado un tenant A y un activo del tenant B, cuando se ejecuta `mnemosine assets list --tenant A`, entonces el activo de B no aparece (RLS: fixed_assets lleva entity_id y entra en el bucle automático de rls-policies.sql).

**Pruebas**

- `tests/assets/asset-registry.spec.ts` — createFixedAsset: precedencia de resolución de cuentas (explícito > categoría > rol) con los tres escenarios
- `tests/assets/asset-registry.spec.ts` — createFixedAsset lanza MISSING_ROLE_ACCOUNT nombrando el rol cuando account_roles está vacía
- `tests/assets/asset-registry.spec.ts` — las cuatro validaciones de importe y vida útil lanzan ValidationError antes del INSERT
- `tests/cli/assets-command.spec.ts` — el render de `assets list` es una función pura testeable sin base ni terminal, al estilo de renderReadiness (close-command.ts:32)

**Riesgo.** Exportar roleAccounts desde ar-ap-posting.ts acopla el módulo de activos al de CxC/CxP. Alternativa más limpia si el acoplamiento molesta: mover roleAccounts y requireRole a src/services/accounting/account-roles.ts y que ambos la importen; es un refactor de dos archivos y no cambia comportamiento.

##### `E1.4-e` Tres roles de cuenta nuevos para depreciación y costo de ventas · **S**

ROLE_MAP (src/services/xml-ingestion/account-roles-seed.ts:119-156) tiene hoy exactamente 31 roles y ninguno cubre la depreciación: hay 'activo_fijo' → '1210' pero no la depreciación acumulada ni el gasto por depreciación; tampoco el costo de ventas. Añadir a la unión AccountRole (src/services/xml-ingestion/cfdi-taxonomy.ts:11-30, bloque 'Purchases, expenses and assets'): 'depreciacion_acumulada' | 'depreciacion_gasto' | 'costo_ventas'. Añadir a ROLE_MAP: depreciacion_acumulada: '1290', depreciacion_gasto: '6140', costo_ventas: '5100'. Los tres códigos ya existen en el catálogo sembrado (seed.ts:87, :114, :108) con los tipos correctos (contra_asset, expense, expense), así que NO hay que añadirlos a REQUIRED_ACCOUNTS para la ruta de seed; pero un catálogo importado por `mnemosine onboard` puede no tenerlos, y seedAccountRoles ya cubre ese caso: los códigos ausentes caen en `unmapped` (account-roles-seed.ts:205) sin romper. Añadir las tres cuentas a REQUIRED_ACCOUNTS con nombre, tipo y descripción en el mismo formato que las 15 existentes, para que se creen si faltan. La tabla account_roles no tiene CHECK sobre `role` (VARCHAR(60), migración 015): no hace falta migración. Ajustar el test existente tests/xml-ingestion/account-roles-seed.spec.ts, que afirma sobre las constantes: el conteo esperado pasa de 31 a 34.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/xml-ingestion/cfdi-taxonomy.ts` — modificar: añadir los tres literales a la unión AccountRole
- `/Users/victor/projects/Accounting/src/services/xml-ingestion/account-roles-seed.ts` — modificar: tres entradas nuevas en ROLE_MAP y tres en REQUIRED_ACCOUNTS (1290 contra_asset, 6140 expense, 5100 expense)
- `/Users/victor/projects/Accounting/tests/xml-ingestion/account-roles-seed.spec.ts` — modificar: el conteo esperado de roles pasa de 31 a 34 y se añaden las aserciones de los tres códigos

**Criterios de aceptación**

- Dado un tenant nuevo, cuando corre `mnemosine init`, entonces `SELECT count(*) FROM account_roles WHERE entity_id=$1 AND qualifier IS NULL` devuelve 34 y existen filas para 'depreciacion_acumulada', 'depreciacion_gasto' y 'costo_ventas'.
- Dado que ROLE_MAP y la unión AccountRole deben cubrirse mutuamente, cuando se compila con `npm run typecheck`, entonces Record<AccountRole,string> obliga a que los tres roles nuevos estén en ROLE_MAP (fallo de compilación si falta uno).
- Dada una entidad con catálogo importado sin la cuenta 1290, cuando corre seedAccountRoles, entonces la cuenta se crea a partir de REQUIRED_ACCOUNTS y el rol queda mapeado, sin aparecer en `unmapped`.

**Pruebas**

- `tests/xml-ingestion/account-roles-seed.spec.ts` — ROLE_MAP tiene 34 entradas y cubre exactamente la unión AccountRole
- `tests/xml-ingestion/account-roles-seed.spec.ts` — los tres códigos nuevos apuntan a cuentas del tipo correcto en REQUIRED_ACCOUNTS (1290 contra_asset, 6140 y 5100 expense)

**Riesgo.** Si E1.1 fijó '31 filas' como criterio de aceptación en su propio test o en su documentación, este paquete lo cambia a 34: coordinar el ajuste para que la suite no quede roja entre ambos.

##### `E1.4-f` Corregir runMonthlyDepreciation: índice de periodo por calendario, idempotencia real, enlace al asiento y estado del activo · **M**

src/services/assets/depreciation.ts:270 está escrita pero tiene cuatro defectos que la harían postear mal en cuanto se le diera puerta de entrada.

(1) ÍNDICE DE PERIODO ERRÓNEO. Las líneas 309-314 calculan monthsDiff dividiendo la diferencia en milisegundos entre 30.44 días. Contraejemplo verificado: depreciation_start_date = 2026-01-01, periodo de agosto con start_date = 2026-08-01 → 212 días / 30.44 = 6.96 → Math.floor = 6 → schedule[6], que es period_number 7 (julio). El activo recibe en agosto la cuota de julio y el último mes nunca se postea. Sustituir por aritmética de calendario: `function mesesTranscurridos(desde: Date, hasta: Date): number { return (hasta.getUTCFullYear()-desde.getUTCFullYear())*12 + (hasta.getUTCMonth()-desde.getUTCMonth()); }` y usar `schedule[mesesTranscurridos(depStart, periodStart)]`, con `if (idx < 0) continue;` para activos cuya depreciación empieza después del periodo.

(2) DESBORDE DE addMonths. addMonths (línea 28) hace `result.setMonth(result.getMonth()+months)` sin recortar el día: con fecha base 2026-01-31, +1 mes da 2026-03-03. Esa fecha es la que se usa como entry_date del asiento (línea 333), y createJournalEntry resuelve el periodo fiscal POR FECHA (posting.ts:90-97), de modo que el asiento aterrizaría en un periodo distinto del fiscal_period_id escrito en depreciation_schedules. Dos correcciones independientes y ambas necesarias: (a) recortar el día en addMonths al último día del mes destino cuando desborde; (b) fechar el asiento en el end_date del periodo fiscal que se está depreciando —no en entry.period_start_date—, que es la convención de una corrida de cierre mensual.

(3) IDEMPOTENCIA POR CARRERA. El SELECT previo (líneas 286-291) más el INSERT posterior no son atómicos. Existe UNIQUE(asset_id, fiscal_period_id, schedule_type) (migración 003:215), así que basta con INSERT ... ON CONFLICT (asset_id, fiscal_period_id, schedule_type) DO NOTHING RETURNING id y, si no devuelve fila, abortar la transacción de ese activo sin crear asiento. Mantener el SELECT previo como atajo barato, pero la garantía la da el ON CONFLICT.

(4) COLUMNA journal_entry_id SIN ESCRIBIR. depreciation_schedules tiene journal_entry_id UUID REFERENCES journal_entries(id) (migración 003:212) y el INSERT de la línea 320 no la incluye: la fila del subledger nunca queda ligada al asiento que produjo. Reordenar dentro de la transacción: crear el asiento primero con createJournalEntry(..., {sourceType:'depreciation', sourceId: asset.id, autoPost:true, client}), luego insertar la fila del schedule con journal_entry_id = je.id.

(5) ESTADO DEL ACTIVO. Tras el UPDATE de fixed_assets (línea 358), si ending_book_value <= salvage_value, poner status='fully_depreciated' (valor ya permitido por el CHECK de la migración 003:182). Sin esto el activo sigue apareciendo como 'active' en el checklist de cierre para siempre.

(6) FIRMA. Cambiar a `export async function runMonthlyDepreciation(entityId: string, fiscalPeriodId: string, userId: string, options?: { client?: pg.PoolClient; dryRun?: boolean }): Promise<{processed: number; skipped: number; errors: Array<{assetNumber: string; message: string}>; entries: Array<{assetId: string; entryId: string; amount: string}>}>`. Con dryRun se calcula todo y no se escribe nada. Con options.client todo corre en la transacción del llamador y NO se dispara attestEntryAsync (el llamador lo hace tras el commit), respetando la convención del repo. Sin él, se conserva el patrón actual: withTransaction por activo y attestEntryAsync después (líneas 367-371), que es correcto — un activo que falle no debe abortar la corrida entera.

(7) La consulta de la línea 278 debe validar antes que fiscalPeriodId pertenece a entityId y que su status no es 'hard_close' ni 'locked'; si no, lanzar AccountingError('PERIOD_CLOSED').

**Archivos**

- `/Users/victor/projects/Accounting/src/services/assets/depreciation.ts` — modificar: addMonths con recorte de día; nueva mesesTranscurridos; runMonthlyDepreciation con nueva firma, ON CONFLICT DO NOTHING, journal_entry_id, fecha del asiento = end_date del periodo, status fully_depreciated y validación de periodo

**Criterios de aceptación**

- Dado un activo con depreciation_start_date 2026-01-01, vida 36 meses, y una corrida sobre el periodo de agosto 2026, entonces la cuota posteada es la del period_number 8 del schedule — no la del 7 como hoy.
- Dado un activo con depreciation_start_date 2026-01-31, cuando se calcula el schedule, entonces ninguna period_start_date cae fuera del mes esperado (el mes 2 es febrero, no marzo).
- Dado un activo ya depreciado en el periodo P, cuando runMonthlyDepreciation se ejecuta dos veces seguidas sobre P, entonces la segunda corrida devuelve processed 0 y skipped 1, no crea un segundo asiento, y `SELECT count(*) FROM journal_entries WHERE source_type='depreciation' AND source_id=<asset>` sigue siendo 1.
- Dada una corrida exitosa, cuando se consulta depreciation_schedules, entonces journal_entry_id no es NULL y apunta a un asiento en estado 'posted' cuyo entry_date cae dentro del [start_date, end_date] del fiscal_period_id de la propia fila.
- Dado un activo cuya última cuota lo deja en el valor de salvamento, cuando corre la depreciación de ese mes, entonces fixed_assets.status pasa a 'fully_depreciated' y el activo deja de contarse en el item 4 del checklist de cierre.
- Dado dryRun true, cuando corre la función, entonces devuelve el detalle calculado y `SELECT count(*) FROM depreciation_schedules` no cambia.
- Dado un fiscalPeriodId de otra entidad, cuando se invoca la función, entonces lanza AccountingError y no escribe nada.

**Pruebas**

- `tests/assets/depreciation.spec.ts` — mesesTranscurridos devuelve 7 para (2026-01-01, 2026-08-01) y 0 para el mismo mes; el caso que hoy falla con el divisor 30.44
- `tests/assets/depreciation.spec.ts` — addMonths(2026-01-31, 1) devuelve el 28 de febrero, no el 3 de marzo
- `tests/assets/depreciation.spec.ts` — calculateStraightLine: la suma de las cuotas del schedule iguala exactamente (costo - salvamento) y el ending_book_value final es el salvamento
- `tests/assets/depreciation.spec.ts` — calculateMACRS 5-year: la suma de los porcentajes de la tabla es 100 y el schedule tiene 66 filas (6+12*4+6)
- `tests/assets/depreciation-run.spec.ts` — runMonthlyDepreciation con dryRun no ejecuta ningún INSERT/UPDATE (mock de client con contador por verbo SQL)
- `tests/assets/depreciation-run.spec.ts` — un activo que lanza no aborta la corrida: processed cuenta el resto y errors trae el asset_number del fallido

**Riesgo.** Cambiar la fecha del asiento de period_start_date a end_date del periodo cambia el periodo fiscal al que aterriza el asiento para activos con inicio a mitad de mes. Es la corrección deseada, pero si alguna base ya tuviera filas de depreciation_schedules (hoy no puede haberlas: nadie llama la función), habría que revisarlas.

##### `E1.4-g` Puerta de entrada de la depreciación: `mnemosine assets depreciate` y remediación en el checklist de cierre · **M**

(1) Subcomando `mnemosine assets depreciate [--period <nombre>] [--dry-run] [--json]` en src/cli/assets-command.ts. Resolución del periodo: si no se pasa --period, usar nextPeriodToClose(ctx) de src/ai/close-service.ts:64 (el más antiguo abierto), que es la misma semántica que ya usa `mnemosine close`; si se pasa, buscarlo entre listClosablePeriods(ctx). Llamar runMonthlyDepreciation(ctx.entityId, period.id, reviewer.userId, {dryRun: opts.dryRun}) y renderizar con una función pura `export function renderDepreciationRun(r, c): string[]` (testeable sin base ni terminal, al estilo de renderReadiness en close-command.ts:32) que liste por activo el número, el nombre, la cuota y el número de asiento, más un resumen 'N activos depreciados, M omitidos, K errores'. Exit code: 0 si errors está vacío, 1 en caso contrario. Confirmación interactiva antes de escribir, igual que close-command (líneas 131-146): la depreciación escribe al mayor. Con --dry-run no se pide confirmación. Si !stdin.isTTY y no es --dry-run, no escribir y avisar, replicando close-command.ts:133-136.

(2) REMEDIACIÓN EN EL CHECKLIST. Añadir un campo opcional `remediation?: string` a la interfaz PeriodCloseChecklist (src/services/accounting/period-close.ts:7-11) y poblarlo en el item 4 (línea 90-94) con 'mnemosine assets depreciate' cuando is_complete sea false. Propagarlo por CloseReadiness.checklist (src/ai/close-service.ts:39, que ya reexpone engine.checklist tal cual, línea 132: no requiere cambio) y renderizarlo en renderReadiness (close-command.ts:41-44) como una línea indentada en dim tras el item incompleto. Aprovechar para poblar remediation en los otros items que tienen remedio conocido: item 1 → 'mnemosine review', item 3 → 'mnemosine review'. Según la decisión D6 el item 4 sigue siendo warning y no blocking_issue.

(3) NO usar el runtime de ai_jobs para esto. Verificado: la migración 022 restringe ai_jobs.kind a ('close_verification','cfdi_reconciliation','ar_reminders') y su cabecera declara explícitamente que 'el job runner NUNCA escribe el mayor: cada corrida despierta una sesión de agente aislada cuyas únicas salidas son drafts/preguntas revisables'. La depreciación escribe al mayor, luego su automatización pertenece al runtime de trabajos en segundo plano que otro paquete introduce (bullmq), no a ai_jobs. Hasta entonces, la puerta de entrada es el comando manual, invocable desde cron.

**Archivos**

- `/Users/victor/projects/Accounting/src/cli/assets-command.ts` — modificar: subcomando depreciate y la función pura renderDepreciationRun
- `/Users/victor/projects/Accounting/src/services/accounting/period-close.ts` — modificar: campo remediation en PeriodCloseChecklist y su población en los items 1, 3 y 4
- `/Users/victor/projects/Accounting/src/cli/close-command.ts` — modificar: renderReadiness imprime la remediación de cada item incompleto
- `/Users/victor/projects/Accounting/docs/cli-command-catalog.md` — modificar: documentar `mnemosine assets depreciate`

**Criterios de aceptación**

- Dada una entidad con dos activos activos y ninguna fila en depreciation_schedules para el periodo, cuando se ejecuta `mnemosine assets depreciate --dry-run --json`, entonces la salida lista dos activos con su cuota, el exit code es 0 y depreciation_schedules sigue vacía.
- Dada la misma entidad, cuando se ejecuta `mnemosine assets depreciate` y se confirma, entonces se crean dos asientos posteados de entry_type 'auto_depreciation', dos filas de depreciation_schedules con is_posted true y journal_entry_id no nulo, y account_balances refleja el cargo a 6140 y el abono a 1290.
- Dado ese estado, cuando se ejecuta `mnemosine close --check`, entonces el item 'Depreciation calculated and posted' aparece con ✔ y el warning '<N> assets without depreciation posted' ya no está — es decir, el checklist deja de ser insatisfacible.
- Dado un activo sin depreciar, cuando se ejecuta `mnemosine close --check`, entonces bajo el item incompleto se imprime la línea de remediación 'mnemosine assets depreciate'.
- Dado que el comando corre desde cron sin TTY y sin --dry-run, cuando se ejecuta, entonces no escribe nada y sale con un mensaje explicando que hace falta un terminal (mismo comportamiento que `mnemosine close`).

**Pruebas**

- `tests/cli/assets-command.spec.ts` — renderDepreciationRun con 2 procesados y 1 error produce las líneas esperadas y marca el error en rojo
- `tests/accounting/period-close-checklist.spec.ts` — getPeriodCloseStatus devuelve remediation en los items 1, 3 y 4 cuando están incompletos, y undefined cuando están completos
- `tests/cli/close-command.spec.ts` — renderReadiness imprime la línea de remediación bajo cada item incompleto que la tenga

**Riesgo.** getPeriodCloseStatus no tiene hoy ningún test unitario (es una de las brechas del hueco 8), así que tocarlo va a ciegas. Mitigación: la propia tarea añade tests/accounting/period-close-checklist.spec.ts con las cinco consultas mockeadas, que es el primer test del archivo y deja terreno ganado para el paquete de pruebas del motor.

##### `E1.4-h` Cuarentena de inventarios: borrar recordInventorySale y declarar el módulo como no productivo · **S**

Ejecutar la decisión D2. (1) BORRAR recordInventorySale (src/services/inventory/costing.ts:178-255). Es el trozo peligroso: crea un asiento con DR CxC / CR Ingreso además del par COGS/Inventario, duplicando el ingreso que ya postea postInvoiceEntry (ar-ap-posting.ts:58). Al borrarla desaparecen los últimos usos de createJournalEntry, attestEntryAsync, withTransaction, currentTenant, JournalEntryType e InventoryItem en el archivo: eliminar también esos imports (líneas 3-7) dejando solo query, uuidv4, Decimal, AccountingError/ErrorCodes e InventoryLayer. Con esto el módulo deja de tener cualquier capacidad de escribir al mayor. (2) recordInventoryPurchase (línea 147) se queda, pero corre hoy en autocommit con dos statements independientes (INSERT en inventory_layers + UPDATE de inventory_items): envolverlo en withTransaction o marcarlo con un TODO explícito según lo que decida quien implemente; recomendado envolverlo, es una línea. (3) Añadir al inicio del archivo un bloque de cabecera que diga literalmente que el módulo NO está conectado a ninguna ruta ni comando, que inventory_items no tiene alta de producto (solo SQL directo), que invoice_lines.item_id es un UUID sin FK y no apunta a inventory_items, y que el sistema NO registra costo de ventas por ninguna vía hoy. (4) Registrar el hecho en el chequeo de superficies de E1.4-j para que `mnemosine doctor` lo diga en voz alta en vez de que el usuario lo descubra.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/inventory/costing.ts` — modificar: eliminar recordInventorySale y los imports que quedan huérfanos; envolver recordInventoryPurchase en withTransaction; cabecera de cuarentena

**Criterios de aceptación**

- Dado el repositorio tras el cambio, cuando se ejecuta `grep -rn 'createJournalEntry|attestEntryAsync' src/services/inventory/`, entonces no devuelve ninguna línea: ninguna ruta de inventarios puede escribir al mayor.
- Dado el cambio, cuando se ejecuta `npm run typecheck`, entonces compila sin errores de imports no usados ni de símbolos faltantes.
- Dado recordInventoryPurchase, cuando el UPDATE de inventory_items falla, entonces la fila de inventory_layers tampoco queda escrita (hoy sí quedaría, en autocommit).
- Dado `mnemosine doctor`, cuando corre, entonces informa que el subsistema de inventarios está en cuarentena y sin punto de entrada.

**Pruebas**

- `tests/inventory/costing.spec.ts` — consumeLayers en PEPS consume la capa más antigua primero y lanza INSUFFICIENT_INVENTORY cuando la existencia no alcanza
- `tests/inventory/costing.spec.ts` — calculateWeightedAverage reparte proporcionalmente y su total_cost iguala cantidad * costo promedio
- `tests/inventory/costing.spec.ts` — el módulo no exporta ninguna función que cree asientos (aserción sobre las claves del módulo importado)

##### `E1.4-i` Retirar src/services/mexico/cfdi.ts rescatando solo los catálogos SAT · **S**

Ejecutar la decisión D4. (1) Crear src/services/xml-ingestion/sat-catalogs.ts con el bloque SAT_CATALOGS tal cual está hoy (cfdi.ts:7-94): REGIMEN_FISCAL, USO_CFDI, METODO_PAGO, FORMA_PAGO, IVA_RATES y CANCELLATION_REASONS, con el mismo `as const`. Verificado que no se duplica en ninguna otra parte de src/: cfdi-facts.ts solo define su constante local FORMA_PAGO_EFECTIVO = '01' (línea 86). (2) BORRAR src/services/mexico/cfdi.ts entero y el directorio src/services/mexico/, que queda vacío. Se van con él: generateCfdiXml (CFDI 4.0 sin sello ni certificado, que ni siquiera usa la ruta de timbrado: invoices.ts:396 admite en comentario que 'real implementation would use cfdi.ts generateCfdiXml' y arma su propio XML mínimo aparte), stampWithPAC y cancelWithPAC (simuladores que duplican y contradicen a los tres adaptadores de src/services/integrations/mexico/pac/), y generateDIOT (que agrega sobre bills en base devengada cuando la DIOT es sobre operaciones pagadas, y no separa por tasa 16/8/0/exento, que son columnas distintas de la declaración). (3) Antes de borrar, dejar constancia de la deuda: añadir a docs/ —o al archivo de deuda que ya use el repo— una nota de dos párrafos con los dos defectos concretos de generateDIOT, para que quien la reconstruya sobre base de efectivo (cuando el clasificador CFDI esté cableado) no repita el error. skills/diot-checklist/SKILL.md ya enseña correctamente al agente que presentar la DIOT es una acción HUMANA en el portal del SAT: no requiere cambios y confirma que retirar generateDIOT no rompe ninguna promesa hecha al usuario. (4) `grep -rn 'mexico/cfdi' src scripts tests` devuelve hoy cero resultados, así que no hay ningún import que arreglar; volver a correrlo tras el borrado para confirmarlo.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/xml-ingestion/sat-catalogs.ts` — crear: SAT_CATALOGS movido literalmente desde cfdi.ts:7-94
- `/Users/victor/projects/Accounting/src/services/mexico/cfdi.ts` — eliminar: el archivo completo (y el directorio src/services/mexico/, que queda vacío)
- `/Users/victor/projects/Accounting/docs/cli-command-catalog.md` — modificar: nota de deuda con los dos defectos de generateDIOT (base devengada en vez de efectivo; sin desglose por tasa) para su reconstrucción futura

**Criterios de aceptación**

- Dado el repositorio tras el cambio, cuando se ejecuta `npm run typecheck` y `npm test`, entonces ambos pasan sin errores: el módulo no tenía llamadores.
- Dado el repositorio, cuando se ejecuta `ls src/services/mexico`, entonces el directorio no existe.
- Dado el repositorio, cuando se ejecuta `grep -rn 'SAT_CATALOGS' src`, entonces solo aparece en src/services/xml-ingestion/sat-catalogs.ts y en quien lo importe.
- Dado el sistema, cuando un usuario pide la DIOT al agente, entonces la skill diot-checklist sigue guiándolo y ninguna superficie ofrece generar el archivo automáticamente.

**Pruebas**

- `tests/xml-ingestion/sat-catalogs.spec.ts` — SAT_CATALOGS conserva las seis secciones y los conteos de claves de cada una (17 regímenes, 15 usos, 2 métodos, 21 formas de pago, 3 tasas, 4 motivos de cancelación)

##### `E1.4-j` Chequeo `mnemosine doctor` de superficies simuladas o sin puerta de entrada · **S**

Es la red que evita que este paquete se deshaga con el tiempo: el sistema debe declarar en voz alta qué partes de sí mismo no son productivas. Añadir a src/ai/doctor-service.ts una función `export function checkSimulatedSurfaces(): CheckResult` siguiendo el patrón de las existentes (checkConnectionTransport, línea 127, es el modelo por ser síncrona y sin base) y registrarla en runDoctor (línea 39). Lógica: nivel 'ok' cuando attestationMode() === 'disabled' y config.attestation.publicSurface es false; nivel 'warn' cuando el modo es 'simulated', con detail que nombre las tres piezas simuladas y sus ubicaciones exactas ('chain-adapters.ts:124 fabrica txHash y blockNumber; zkverify-client.ts:44 fabrica el attestationId; bitcoin-anchor.ts:137 fabrica el txid'); nivel 'fail' cuando publicSurface es true y el modo es 'simulated' a la vez, porque esa es justamente la combinación que publica datos inventados en un endpoint sin autenticación. Añadir además una segunda función `export function checkDormantModules(): CheckResult` de nivel 'warn' fijo que enumere lo que existe sin puerta de entrada tras este paquete: el subsistema de inventarios (src/services/inventory/costing.ts, sin alta de inventory_items ni registro de costo de ventas) y el alta de bank_accounts (que solo se puebla desde src/database/seed.ts:172, es decir solo en la base demo, pese a que el item 2 del checklist de cierre cuenta cuentas bancarias sin conciliar). Que ese warn sea permanente es correcto: desaparece cuando alguien les dé puerta de entrada, no antes.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/doctor-service.ts` — modificar: añadir checkSimulatedSurfaces y checkDormantModules, y registrarlas en runDoctor

**Criterios de aceptación**

- Dado ATTESTATION_MODE sin definir y PUBLIC_VERIFICATION_ENABLED sin definir, cuando corre `mnemosine doctor`, entonces el chequeo 'Simulated surfaces' sale en nivel ok.
- Dado ATTESTATION_MODE=simulated y PUBLIC_VERIFICATION_ENABLED=true, cuando corre `mnemosine doctor`, entonces el chequeo sale en nivel fail y el exit code del comando refleja el fallo.
- Dado cualquier entorno, cuando corre `mnemosine doctor`, entonces el chequeo 'Dormant modules' menciona inventarios y el alta de cuentas bancarias.
- Dado el chequeo, cuando se le llama sin conexión a base, entonces no lanza: es síncrono y solo lee configuración.

**Pruebas**

- `tests/cli/doctor-simulated-surfaces.spec.ts` — los tres niveles (ok / warn / fail) según las combinaciones de ATTESTATION_MODE y PUBLIC_VERIFICATION_ENABLED
- `tests/cli/doctor-simulated-surfaces.spec.ts` — checkDormantModules nombra inventarios y bank_accounts

##### `E1.4-k` E2E de depreciación contra base real, con fixtures sembradas y no UUIDs a mano · **M**

La suite mockea `query`, así que ningún test unitario ve el esquema real: es el patrón que ya dejó inejecutables cuatro subsistemas (nómina US, benefits, tax_form_filings, enums de blockchain). Crear scripts/e2e-depreciation.ts al estilo de scripts/e2e-arap.ts pero SIN su defecto: e2e-arap.ts hardcodea TENANT/ENTITY/USER/CUSTOMER/VENDOR/PERIOD (líneas 19-24) de una base concreta. Este script debe SEMBRAR su propio escenario y borrarlo al final. Secuencia: (1) crear tenant + legal_entity + user efímeros con uuidv4; (2) sembrar el catálogo mínimo llamando al mismo camino que usa `mnemosine init` (createChartOfAccounts o equivalente de seed.ts) y luego seedAccountRoles, para que los 34 roles existan; (3) crear un ejercicio y tres periodos fiscales mensuales; (4) `createAssetCategory` + `createFixedAsset` con costo 36000, salvamento 0, vida 36 meses, straight_line, inicio el primer día del primer periodo; (5) runMonthlyDepreciation sobre el periodo 1 y verificar: cuota 1000.0000, asiento posteado de tipo auto_depreciation, cargo a 6140 y abono a 1290 en account_balances, depreciation_schedules con journal_entry_id no nulo; (6) repetir sobre el periodo 1 y verificar idempotencia (processed 0, skipped 1); (7) correr sobre el periodo 2 y verificar que la cuota es la del period_number 2 y no la del 1 — es la regresión del bug del divisor 30.44; (8) getPeriodCloseStatus sobre el periodo 1 y verificar que el item 'Depreciation calculated and posted' viene is_complete true; (9) limpieza en orden inverso de FK. Añadir a package.json el script `"e2e:depreciation": "tsx scripts/e2e-depreciation.ts"` — hoy package.json no menciona 'e2e' en absoluto y ninguno de los dos scripts existentes corre en la suite.

**Archivos**

- `/Users/victor/projects/Accounting/scripts/e2e-depreciation.ts` — crear: E2E con siembra y limpieza propias, sin UUIDs hardcodeados
- `/Users/victor/projects/Accounting/package.json` — modificar: añadir el script e2e:depreciation

**Criterios de aceptación**

- Dado un Postgres limpio con las migraciones aplicadas, cuando se ejecuta `npm run e2e:depreciation`, entonces termina con código 0 e imprime los 8 pasos verificados.
- Dado que el script termina (con éxito o con fallo), cuando se consultan las tablas, entonces no quedan filas del tenant efímero: la limpieza corre en un finally.
- Dado que el script se ejecuta dos veces seguidas, entonces la segunda pasa igual que la primera (no depende de estado previo, a diferencia de scripts/e2e-arap.ts).
- Dado el paso 7, cuando se revierte la corrección del índice de periodo de E1.4-f, entonces el script falla: es la prueba de regresión del bug del divisor 30.44.

**Pruebas**

- `scripts/e2e-depreciation.ts` — es el test en sí: 8 aserciones sobre base real, invocable con npm run e2e:depreciation

**Riesgo.** Necesita un Postgres real con las migraciones aplicadas; no puede entrar en `npm test` hasta que exista base efímera en CI (no hay .github/ en el repo). Mientras tanto se corre a mano, pero a diferencia de e2e-arap.ts queda reproducible y sin dependencia de una base de desarrollo concreta.

#### Cómo se sabe que cerró

- `grep -rn 'runMonthlyDepreciation' src` devuelve al menos una línea fuera de src/services/assets/depreciation.ts (el subcomando de la CLI): el módulo deja de ser código muerto.
- En una entidad recién creada con `mnemosine init` + `mnemosine assets categories add` + `mnemosine assets add` + `mnemosine assets depreciate`, `mnemosine close --check --json` devuelve el item 'Depreciation calculated and posted' con is_complete true. Hoy es imposible.
- `SELECT count(*) FROM blockchain_attestations WHERE range_proof IS NOT NULL AND convert_from(range_proof,'UTF8') LIKE '%_test_%'` devuelve 0, y lo mismo sobre zkverify_proof.
- Con el entorno por defecto, `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/public/v1/verify/0x<64 hex>` devuelve 404 (ruta no montada). Con PUBLIC_VERIFICATION_ENABLED=true y una atestación simulada, el cuerpo trae verified:false y simulated:true, y la petición con un hash malformado responde 400 en menos de un segundo en vez de colgarse.
- `npm run e2e:depreciation` termina con código 0 sobre un Postgres limpio, dos veces seguidas.
- `ls src/services/mexico` falla (directorio inexistente) y `npm run typecheck` sigue en verde.
- `grep -rn 'createJournalEntry|attestEntryAsync' src/services/inventory/` no devuelve nada.
- `mnemosine doctor` incluye los chequeos 'Simulated surfaces' y 'Dormant modules', y sale en nivel ok para el primero con la configuración por defecto.
- `SELECT count(*) FROM account_roles WHERE entity_id=$1 AND qualifier IS NULL` devuelve 34 tras `mnemosine init`.
- `npm test` y `npm run typecheck` en verde, con al menos 6 archivos de test nuevos: tests/assets/*, tests/inventory/costing.spec.ts, tests/blockchain/*, tests/api/public-verification.spec.ts.


## E2 · Encender el perímetro

### E2.1 · Encender el perímetro multi-inquilino en la aplicación (REST, GraphQL y /public/v1)
**Objetivo.** Que toda petición HTTP corra dentro de un contexto de inquilino (withTenant) contra el rol mnemosine_app, de modo que la RLS —hoy construida, forzada y aplicada tras cada migración, pero inerte para quince de los diecisiete routers y para todo GraphQL— pase de defensa pagada a defensa activa. En el mismo paso se cierra el atajo de ?entity_id= en la query string, se aplican permisos y validación de entidad en GraphQL, se poda del schema lo que no tiene resolver, y se deja una batería de pruebas que falla si alguien reabre cualquiera de los cinco vectores.

**Por qué aquí.** La RLS ya está hecha y forzada (rls-policies.sql se reaplica tras cada migración: política tenant_isolation por catálogo más 19 políticas hijo por EXISTS) y los dos roles ya existen (scripts/provision-roles.sql, ambos NOBYPASSRLS). Lo único que falta es el llamador: un middleware. Verificado además que el .env de desarrollo YA apunta DATABASE_URL a mnemosine_app y MIGRATION_DATABASE_URL a mnemosine_owner — es decir, en ese entorno el servidor REST hoy no puede devolver una sola fila fuera de /v1/ai y /v1/ai/webhooks, que son los únicos dos routers que llaman withTenant. El perímetro no es una mejora futura: es lo que hace que el servidor vuelva a funcionar con el rol correcto. Va después de la comprobación por recurso en las rutas por :id porque la RLS aísla el INQUILINO y no la ENTIDAD: sin esa comprobación, encender RLS da una falsa sensación de cierre.

**Depende de:** `E0.1`, `E1.4` · **Migraciones:** `040-042` · **10 tareas · 5.4 sem-persona**

**Precondiciones:**

- scripts/provision-roles.sql ejecutado en el entorno destino (crea mnemosine_owner y mnemosine_app, ambos NOBYPASSRLS, y traspasa la propiedad de las tablas al owner para que FORCE ROW LEVEL SECURITY tenga a quién forzar).
- npm run migrate corrido al día con MIGRATION_DATABASE_URL apuntando a mnemosine_owner, de modo que rls-policies.sql esté aplicado sobre el esquema actual.
- Paquete previo de la etapa 1: la comprobación de propiedad por recurso en las rutas por :id de accounts, invoices, bills, customers, vendors, payroll y bank-reconciliation (patrón de src/api/rest/routes/journal-entries.ts:19-25 y :163). Si ese paquete no ha cerrado, la tarea E2.1-d de aquí lo cubre con el helper compartido; si ya cerró, E2.1-d se reduce a migrar esas rutas al helper y a añadir los tests.
- Redis disponible para rateLimiter (no cambia en este paquete, pero el orden de montaje sí).

#### Decisiones a resolver

**¿Qué se hace con /public/v1, que la RLS deja sin datos porque es anónimo y no puede tener contexto de inquilino?**

Los siete manejadores consultan tablas con tenant_id NOT NULL (blockchain_attestations, period_commitments, published_aggregates) y legal_entities. Bajo mnemosine_app sin contexto, las cuatro consultas devuelven cero filas. Además la auditoría adversarial constató que lo que publica es sintético: EvmChainAdapter fabrica el txHash localmente, el bloque de producción de zkverify-client.ts:40 está vacío, y GET /public/v1/verify/:entryHash selecciona hoy tenant_id y entity_id en un endpoint sin autenticación. Ninguno de los siete manejadores usa asyncHandler, así que bajo Express 4 un error deja la petición colgada.

- A. Retirarlo: bandera PUBLIC_VERIFICATION_ENABLED en false por defecto, /public/v1 responde 404 hasta que la capa blockchain deje de ser simulación.
- B. Mantenerlo con funciones SECURITY DEFINER de lectura acotada (migración 031) que nunca devuelvan tenant_id, entity_id ni el nombre de la entidad, más asyncHandler y rate limiting.
- C. Un tercer rol de base de datos con BYPASSRLS restringido a vistas de verificación.

_Recomendación:_ A, con la bandera implementada de modo que B sea un cambio de configuración más una migración cuando la atestación deje de ser simulada. C se descarta: introduce en el clúster un rol que ignora la RLS justo cuando el paquete entero consiste en quitarlos.

_Bloquea:_ E2.1-f. No bloquea el resto del paquete: sin decisión, la bandera queda apagada y /public/v1 responde 404.

**¿Se mantiene una transacción por consulta o se pasa a una conexión por petición?**

Con contexto activo, query() (connection.ts:159-172) toma un cliente del pool y ejecuta BEGIN, set_config, la consulta y COMMIT: cuatro viajes de ida y vuelta donde antes había uno. Un manejador REST hace entre dos y cinco consultas, y los resolvers de campo de GraphQL hacen una por nodo (N+1 ya señalado en el atlas). Con DATABASE_POOL_MAX en 20, encender el perímetro multiplica por cuatro la presión sobre el pool sin cambiar una línea de los manejadores.

- A. Dejarlo como está y medir: es correcto, no cambia semántica, y la latencia extra es de tres viajes contra la base.
- B. Un cliente por petición: reservarlo en tenantContext, fijar el inquilino una vez y liberarlo al terminar la respuesta. Menos viajes, pero cada petición retiene una conexión del pool durante toda su vida, incluidas las lecturas lentas de informes.
- C. SET a nivel de sesión con restablecimiento en el evento release del pool: el más barato y el más fácil de romper — una conexión mal restablecida sirve datos de otro inquilino.

_Recomendación:_ A ahora, con una métrica de duración de consulta por ruta antes y después del cambio de rol, y B sólo si esa métrica lo justifica. C se descarta: el propio comentario de connection.ts:86-90 explica por qué el ámbito local no es un detalle.

_Bloquea:_ Nada de este paquete; condiciona el dimensionado del pool en el paso 5 del despliegue.

**¿Se retira la rama HS256 de authenticate o basta con abortar el arranque si el secreto es el de desarrollo?**

config.jwt.secret cae por defecto en 'dev-secret-change-me' (src/config/index.ts:73) y no existe ningún emisor de esos tokens (no hay jwt.sign en src/). Con ese secreto, cualquiera firma un JWT con el tenant_id y los permisos que quiera, y entonces tenantContext abre el contexto del inquilino que el atacante eligió: la RLS obedece a un dato que no es de fiar. Es la condición sin la cual todo este paquete no protege nada.

- A. Abortar el arranque en producción si el secreto es el de desarrollo (incluido en E2.1-e) y dejar HS256 para desarrollo y pruebas.
- B. Retirar HS256 por completo y exigir OIDC siempre, lo que obliga a levantar un proveedor para correr las pruebas de integración.
- C. Aceptar HS256 sólo cuando config.auth.enabled es false Y config.env no es 'production'.

_Recomendación:_ C, que es A más una condición explícita: en cuanto hay proveedor OIDC configurado, un token simétrico deja de aceptarse aunque el secreto esté bien puesto. B es el destino correcto a plazo pero deja sin emisor a la batería de pruebas de E2.1-h, que firma sus propios tokens.

_Bloquea:_ El valor real de E2.1-a y E2.1-b: sin esto, el perímetro confía en un tenant_id falsificable.

**¿Se retiran los montajes duplicados de xml-ingestion y blockchain?**

src/index.ts monta xmlIngestionRouter en /v1/xml y otra vez en /v1 (líneas 132-133), y blockchainRouter en /v1/admin/blockchain y otra vez en /v1/admin (líneas 134-135). Cada endpoint es alcanzable por dos rutas: duplica la superficie que la batería del perímetro debe cubrir y descuadra las etiquetas de las métricas. No es accidental del todo: el router de XML define tanto /upload (que se lee bien como /v1/xml/upload) como /pre-registrations y /xml-documents (que se leen bien como /v1/pre-registrations).

- A. Dejarlo y probar ambas rutas en la batería del perímetro.
- B. Elegir un prefijo por router (/v1/xml y /v1/admin/blockchain), retirar el duplicado y devolver 308 desde el antiguo durante una versión.
- C. Partir el router de XML en dos según el prefijo que corresponde a cada familia de rutas.

_Recomendación:_ B con redirección temporal: el perímetro es más fácil de auditar cuando cada endpoint tiene una sola dirección. Es un cambio de contrato menor y hay que decirlo en la nota de versión.

_Bloquea:_ El alcance de la batería de E2.1-h: si se queda A, hay que duplicar los casos de esas dos familias.

**Cuando el recurso pertenece a otra entidad del MISMO inquilino, ¿403 o 404?**

Entre inquilinos la pregunta no se plantea: la RLS devuelve cero filas y el resultado es 404 sin que el código decida nada. Dentro del inquilino sí hay elección, y el código actual ya escogió 403 (assertEntityAccess lanza ForbiddenError, auth.ts:128). Un 403 confirma que el UUID existe dentro del inquilino; un 404 no filtra nada pero complica el diagnóstico a un usuario legítimo que se equivocó de entidad.

- A. 403 'Access denied to this entity' (lo que ya hace journal-entries.ts).
- B. 404 uniforme para no revelar existencia.
- C. 403 en las rutas de escritura y 404 en las de lectura.

_Recomendación:_ A, por coherencia con el único sitio donde el patrón ya está implementado y porque dentro de un mismo inquilino la existencia de un UUID no es un secreto que valga el coste de diagnóstico. C se descarta por incoherente.

_Bloquea:_ Los criterios de aceptación de E2.1-d y de los vectores V3 y V4 de E2.1-h.

#### Tareas

##### `E2.1-a` runInTenant() síncrono, middleware tenantContext y cierre de las dos fugas de enterWith · **S**

En src/database/connection.ts, junto a withTenant (línea 102), añadir:

  export function runInTenant<T>(tenantId: string, fn: () => T): T {
    return dbContext.run({ tenantId }, fn);
  }

Es la variante SÍNCRONA de withTenant y existe por una razón concreta: un middleware de Express llama next() y devuelve; envolver next() en una función async obliga a decidir qué hacer con la promesa colgante. AsyncLocalStorage.run() propaga el store a todo lo que se agende DENTRO del callback, así que next() invocado ahí deja el contexto puesto para todos los manejadores posteriores y sus continuaciones asíncronas. No inventes un patrón nuevo: withTenant sigue siendo la forma correcta para código async (ai.ts, ai-webhooks.ts la usan y no se tocan).

Endurecer getClient() (connection.ts:175), que hoy devuelve un cliente del pool SIN aplicar el tenant: si hay contexto activo, lanzar Error('getClient() no aplica contexto de inquilino: usa withTransaction()'). Verificado que getClient() no tiene un solo llamador en src/, así que el cambio no rompe nada y evita que alguien lo use como puerta trasera.

Crear src/api/rest/middleware/tenant.ts:

  import type { RequestHandler } from 'express';
  import { runInTenant } from '../../../database/connection.js';
  import { UnauthorizedError } from '../../../utils/errors.js';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Abre el contexto de inquilino de la petición. Debe ir DESPUÉS de authenticate. */
  export const tenantContext: RequestHandler = (req, _res, next) => {
    const tenantId = req.tenantId;
    if (!tenantId || !UUID_RE.test(tenantId)) {
      throw new UnauthorizedError('El token no porta un tenant válido');
    }
    runInTenant(tenantId, next);
  };

Lanzar de forma síncrona es correcto: Express captura las excepciones síncronas de un middleware y las enruta a errorHandler (que ya mapea UnauthorizedError a 401, src/utils/errors.ts:35).

Cerrar las dos fugas de enterWith en servidor:
(1) src/ai/context.ts:35, dentro de toContext(): cambiar `enterTenant(row.tenant_id);` por `if (!currentTenant()) enterTenant(row.tenant_id);`. Hoy /v1/ai/* llama resolveEntity() dentro de withTenant y ése hace enterWith sobre el mismo inquilino — inocuo por casualidad, no por diseño. Con la guarda, el servidor nunca ejecuta enterWith y la CLI conserva su comportamiento (sin contexto previo, sigue entrando).
(2) src/database/connection.ts:114, en enterTenant(): añadir al docstring existente que el servidor usa tenantContext, y dejar la función tal cual (la CLI la necesita).

**Archivos**

- `/Users/victor/projects/Accounting/src/database/connection.ts` — modificar: añadir export runInTenant<T>(tenantId, fn: () => T): T junto a withTenant; endurecer getClient() para que lance si dbContext.getStore() existe
- `/Users/victor/projects/Accounting/src/api/rest/middleware/tenant.ts` — crear: middleware tenantContext con validación UUID del tenant del token y runInTenant(tenantId, next)
- `/Users/victor/projects/Accounting/src/ai/context.ts` — modificar línea 35: enterTenant(row.tenant_id) pasa a ejecutarse sólo si !currentTenant()

**Criterios de aceptación**

- Dado un handler montado detrás de tenantContext con un token cuyo tenant_id es T, cuando el handler llama query('SELECT 1'), entonces el cliente recibe BEGIN, SELECT set_config('app.current_tenant', T, true) y COMMIT (comprobable con el mock de pg de tests/database/tenant-context.spec.ts).
- Dado un token sin tenant_id o con un tenant_id que no es UUID, cuando llega la petición, entonces la respuesta es 401 y ninguna consulta llega al pool.
- Dada una petición que ya terminó, cuando corre la siguiente en el mismo proceso, entonces currentTenant() es undefined antes de tenantContext (el contexto no sobrevive a la petición).
- Dado un contexto de inquilino activo, cuando alguien llama getClient(), entonces lanza Error con el mensaje que remite a withTransaction().
- Dado resolveEntity() ejecutado dentro de withTenant, cuando resuelve la entidad, entonces enterTenant NO se invoca (espiable con vi.mock del módulo de conexión).

**Pruebas**

- `tests/database/tenant-context.spec.ts` — runInTenant() deja currentTenant() puesto dentro del callback síncrono y lo restituye al salir; getClient() lanza con contexto activo y no lanza sin él
- `tests/api/middleware/tenant.spec.ts` — tenantContext llama next() dentro del contexto (currentTenant() === token.tenant_id vista desde el next espiado) y lanza UnauthorizedError con tenant ausente o malformado

**Riesgo.** Si runInTenant se monta ANTES de authenticate, req.tenantId es undefined y todo /v1 devuelve 401. Mitigación: el criterio de aceptación de E2.1-b fija el orden y el test de arranque lo comprueba.

##### `E2.1-b` Montar el perímetro en el arranque y extraer buildApp() para poder probarlo · **M**

src/index.ts hoy es un único bootstrap() que construye la app y llama listen(), lo que hace imposible ejercitarla desde un test. Partirlo en dos:

  export async function buildApp(): Promise<{ app: express.Express; apolloServer: ApolloServer<GraphqlContext> }>
  async function bootstrap(): Promise<void>   // llama buildApp() y hace listen() + apagado ordenado

buildApp() NO debe llamar initDatabase() ni listen(); bootstrap() sigue haciendo ambas cosas y conserva el bloque de apagado ordenado tal cual (líneas 191-218).

Orden de montaje definitivo bajo apiPrefix = '/v1' (sustituye a las líneas 116-119):
  app.use(apiPrefix, authenticate);            // fija req.user y req.tenantId
  app.use(apiPrefix, enrichLogContextMiddleware);
  app.use(apiPrefix, tenantContext);           // NUEVO: abre el contexto RLS
  app.use(apiPrefix, entityContext);           // NUEVO (E2.1-c): resuelve y valida la entidad
  app.use(apiPrefix, rateLimiter);
  app.use(apiPrefix, auditLogMiddleware);      // escribe audit_log: necesita contexto ya abierto

auditLogMiddleware inserta en audit_log, tabla con tenant_id NOT NULL y política tenant_isolation: si corriera antes de tenantContext, cada inserción fallaría con error 42501 y el .catch(console.error) de audit.ts:33 lo ocultaría. Por eso va después.

GraphQL (líneas 155-165): insertar tenantContext entre authenticate y expressMiddleware:
  app.use('/graphql', authenticate, tenantContext, expressMiddleware(apolloServer, { context: ... }));
Los resolvers corren dentro de la continuación asíncrona de la petición, así que heredan el store de AsyncLocalStorage.

/v1/ai/webhooks (línea 108) NO lleva tenantContext: se autentica con su propio token y el inquilino sólo se conoce tras verificar el token, por lo que abre su withTenant después (ai-webhooks.ts:95). Además la política webhook_token_auth de la migración 030 exige explícitamente que app.current_tenant esté SIN fijar para la lectura pre-auth: montar tenantContext ahí rompería la verificación del token. Dejar un comentario en index.ts diciéndolo, o alguien lo 'arreglará'.

/public/v1 (línea 100): ver E2.1-f.

Limpiezas del mismo archivo: quitar el import muerto de requireEntityAccess (línea 9) si tras E2.1-c no se usa en index.ts, y pasar `introspection: config.env !== 'production'` al constructor de ApolloServer (línea 148).

**Archivos**

- `/Users/victor/projects/Accounting/src/index.ts` — modificar: extraer buildApp() exportado; insertar tenantContext y entityContext en el orden indicado bajo /v1 y tenantContext en /graphql; introspection condicionada al entorno; retirar el import muerto de requireEntityAccess

**Criterios de aceptación**

- Dado un servidor construido con buildApp(), cuando se pide GET /v1/accounts con un token válido, entonces el contexto de inquilino está abierto en el handler y la consulta se ejecuta dentro de una transacción con set_config('app.current_tenant', ...).
- Dado NODE_ENV=production, cuando se lanza la query de introspección __schema contra /graphql, entonces Apollo responde con error de introspección deshabilitada.
- Dado POST /v1/ai/webhooks/:tokenName, cuando llega la petición, entonces currentTenant() es undefined en el momento de verificar el token y pasa a estar fijado sólo dentro del withTenant del propio router.
- Dada una mutación REST exitosa, cuando auditLogMiddleware inserta en audit_log, entonces la inserción no falla por política de RLS (comprobable en el test de integración de E2.1-h: la fila existe con el tenant del token).
- Dado `npm run typecheck`, cuando corre tras el cambio, entonces devuelve 0 y src/index.ts no importa símbolos sin usar.

**Pruebas**

- `tests/api/perimeter/montaje.spec.ts` — buildApp() monta los middlewares en el orden authenticate → tenantContext → entityContext → rateLimiter → auditLogMiddleware, y /v1/ai/webhooks no lleva tenantContext

**Riesgo.** Extraer buildApp() puede alterar el orden de efectos de los imports con efectos secundarios (src/services/integrations/index.js y register-all.js, líneas 37-38): mantenerlos en el tope del módulo, no dentro de buildApp().

##### `E2.1-c` Matar el atajo de ?entity_id=: un solo punto que resuelve y valida la entidad de la petición · **M**

Hoy authenticate (auth.ts:46) fija req.entityId desde la cabecera x-entity-id o desde el token, requireEntityAccess valida ESO, y 41 manejadores en 11 routers vuelven a leer la entidad del query string con el patrón `const entityId = entity_id as string || req.entityId`. El resultado es que la validación y el uso miran a sitios distintos.

1) Crear src/api/rest/middleware/entity.ts con:

  export const entityContext: RequestHandler = (req, _res, next) => {
    if (!req.user) throw new UnauthorizedError();
    const raw =
      (req.query?.entity_id as string | undefined) ??
      (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).entity_id as string | undefined : undefined) ??
      (req.headers['x-entity-id'] as string | undefined);
    if (raw !== undefined && raw !== '') {
      if (!UUID_RE.test(raw)) throw new ValidationError('entity_id must be a UUID');
      assertEntityAccess(req.user, raw);   // 403 si no pertenece
      req.entityId = raw;
      return next();
    }
    req.entityId = req.user.entities[0];   // por defecto la primera del token
    next();
  };

  Precedencia deliberada: query > cuerpo > cabecera > token. Es la misma que usan hoy los manejadores, así que ningún cliente cambia de comportamiento salvo que estuviera abusando del hueco. No se lee req.params.entity_id: montado a nivel de app, req.params está vacío, y ninguna ruta autenticada declara un parámetro :entity_id (verificado: sólo public-verification, que no está bajo /v1).

2) authenticate (auth.ts:33-47) deja de fijar req.entityId; conserva req.user y req.tenantId. Así hay un único escritor de req.entityId.

3) requireEntityAccess (auth.ts:104) cambia de significado y deja de fallar en silencio: la pertenencia ya la validó entityContext, así que ahora sólo declara que la ruta EXIGE entidad:

  export const requireEntityAccess: RequestHandler = (req, _res, next) => {
    if (!req.user) throw new UnauthorizedError();
    if (!req.entityId) throw new ValidationError('Missing entity: send entity_id or x-entity-id');
    next();
  };

  Se conservan sus 20 montajes actuales sin tocarlos.

4) Sustituir los 41 sitios por `const entityId = req.entityId!;` — accounts.ts:56, ai.ts (ya usa req.entityId), bills.ts:75, blockchain.ts:192 y :208, customers.ts:57, fiscal-periods.ts:23,45,58,69, invoices.ts:76, journal-entries.ts:82, payroll.ts (14 sitios: 107, 130, 166, 178, 262, 284, 292, 308, 315, 321, 335, 360, 389, 442), reports.ts:13,75,142,196,222,248,356, vendors.ts:46, xml-ingestion.ts:88,145,199,414,437 y los 3 restantes del mismo archivo. Retirar de la desestructuración de req.query/req.body la variable entity_id allí donde quede sin uso.

5) Prueba de regresión estructural (no de comportamiento): un test que lea todos los archivos de src/api/rest/routes/*.ts y falle si alguno contiene `req.query.entity_id`, `req.body.entity_id` o el literal `entity_id as string`. Es la única forma barata de que el hueco no se reabra en la siguiente ruta que alguien escriba.

**Archivos**

- `/Users/victor/projects/Accounting/src/api/rest/middleware/entity.ts` — crear: entityContext (resolución + validación de la entidad de la petición) y el helper assertResourceEntity de E2.1-d
- `/Users/victor/projects/Accounting/src/api/rest/middleware/auth.ts` — modificar: authenticate deja de fijar req.entityId (línea 46); requireEntityAccess pasa a exigir req.entityId ya validado en vez de retornar next() en silencio (líneas 104-116); assertEntityAccess se mantiene tal cual y se reexporta desde entity.ts
- `/Users/victor/projects/Accounting/src/api/rest/routes/reports.ts` — modificar: 7 sitios pasan a const entityId = req.entityId!
- `/Users/victor/projects/Accounting/src/api/rest/routes/payroll.ts` — modificar: 14 sitios pasan a req.entityId! (incluye los que hoy leen req.body.entity_id en las llamadas a generateSuaFile, generateForm941, generateForm940, generateW3, generateEfw2File, generateIdseBatch y submitW2sToSsa)
- `/Users/victor/projects/Accounting/src/api/rest/routes/xml-ingestion.ts` — modificar: 8 sitios pasan a req.entityId!
- `/Users/victor/projects/Accounting/src/api/rest/routes/fiscal-periods.ts` — modificar: 4 sitios pasan a req.entityId!
- `/Users/victor/projects/Accounting/src/api/rest/routes/blockchain.ts` — modificar: 2 sitios pasan a req.entityId!
- `/Users/victor/projects/Accounting/src/api/rest/routes/accounts.ts` — modificar: 1 sitio
- `/Users/victor/projects/Accounting/src/api/rest/routes/invoices.ts` — modificar: 1 sitio
- `/Users/victor/projects/Accounting/src/api/rest/routes/bills.ts` — modificar: 1 sitio (y el uso de entity_id en bills.ts:324)
- `/Users/victor/projects/Accounting/src/api/rest/routes/customers.ts` — modificar: 1 sitio
- `/Users/victor/projects/Accounting/src/api/rest/routes/vendors.ts` — modificar: 1 sitio
- `/Users/victor/projects/Accounting/src/api/rest/routes/journal-entries.ts` — modificar: 1 sitio

**Criterios de aceptación**

- Dado un usuario cuyo token lista sólo la entidad A, cuando pide GET /v1/reports/trial-balance?entity_id=<B>, entonces la respuesta es 403 'Access denied to this entity' y ninguna consulta al mayor de B llega a la base.
- Dado el mismo usuario, cuando pide GET /v1/reports/trial-balance?entity_id=<A>, entonces responde 200 y el informe es el de A.
- Dado un cuerpo POST /v1/payroll/... con entity_id de una entidad ajena, cuando llega la petición, entonces 403 antes de ejecutar el servicio de nómina.
- Dado entity_id="no-es-uuid", cuando llega la petición, entonces 400 ValidationError y no 500 de Postgres por uuid inválido.
- Dado `grep -rn "entity_id as string\\|req.query.entity_id\\|req.body.entity_id" src/api/rest/routes/`, cuando corre tras el cambio, entonces devuelve cero líneas.
- Dada una ruta montada con requireEntityAccess y una petición sin entidad resoluble (token sin entities y sin cabecera ni parámetro), cuando llega, entonces 400 y no un 200 con entityId undefined.

**Pruebas**

- `tests/api/middleware/entity-context.spec.ts` — precedencia query > cuerpo > cabecera > token; 403 con entidad ajena en cada una de las tres fuentes; 400 con UUID inválido; por defecto toma user.entities[0]
- `tests/api/perimeter/sin-atajos.spec.ts` — ningún archivo de src/api/rest/routes/ contiene req.query.entity_id, req.body.entity_id ni el literal 'entity_id as string'

**Riesgo.** Cambiar la precedencia por descuido (por ejemplo poner el token por delante de la query) rompería clientes que hoy conmutan de entidad legítimamente con ?entity_id=. Mantener el orden query > cuerpo > cabecera > token, que es exactamente el vigente, y cubrirlo con el criterio de aceptación 2.

##### `E2.1-d` assertResourceEntity(): comprobación de propiedad por recurso en las rutas por :id · **M**

La RLS aísla el INQUILINO, no la ENTIDAD. Con el perímetro encendido, GET /v1/accounts/<uuid-de-otro-tenant> devolverá 0 filas (404), pero GET /v1/accounts/<uuid-de-otra-entidad-del-mismo-tenant> seguiría devolviendo el recurso. El patrón correcto ya existe y está escrito en journal-entries.ts:19-25.

Generalizarlo en src/api/rest/middleware/entity.ts:

  const TABLAS_CON_ENTIDAD = {
    accounts: 'accounts', invoices: 'invoices', bills: 'bills',
    customers: 'customers', vendors: 'vendors', journal_entries: 'journal_entries',
    fiscal_periods: 'fiscal_periods', bank_accounts: 'bank_accounts',
    employees: 'employees', pay_runs: 'pay_runs',
    xml_documents: 'xml_documents', pre_registrations: 'pre_registrations',
  } as const;
  type TablaConEntidad = keyof typeof TABLAS_CON_ENTIDAD;

  /** Lee la entidad del recurso y exige pertenencia. Devuelve el entity_id. */
  export async function assertResourceEntity(
    req: Request, tabla: TablaConEntidad, id: string, recurso = tabla
  ): Promise<string> {
    const r = await query<{ entity_id: string }>(
      `SELECT entity_id FROM ${TABLAS_CON_ENTIDAD[tabla]} WHERE id = $1`, [id]
    );
    if (r.rows.length === 0) throw new NotFoundError(recurso, id);
    assertEntityAccess(req.user!, r.rows[0].entity_id);
    return r.rows[0].entity_id;
  }

El nombre de tabla NUNCA sale de la petición: sale del mapa cerrado, que es lo que hace segura la interpolación. Verificar contra las migraciones que cada tabla del mapa tiene columna entity_id antes de incluirla; si alguna no la tiene, no se añade al mapa.

Para los recursos que cuelgan de un padre (bank_transactions, reconciliation_matches, reconciliation_sessions en bank-reconciliation.ts:104, :157, :212 y :257) añadir:

  export async function assertBankAccountEntity(req: Request, transactionOrSessionId: string, via: 'transaction' | 'session'): Promise<string>

que resuelve la entidad por JOIN con bank_accounts y aplica assertEntityAccess.

Aplicarlo en las rutas por :id que hoy no comprueban nada: accounts.ts:119 (GET), :208 (PATCH), :250 (DELETE); invoices.ts:123, :237, :273, :358, :390, :430; bills.ts (rutas por :id); customers.ts:115, :126; vendors.ts (rutas por :id); fiscal-periods.ts:44, :57, :68; payroll.ts (rutas por :id de empleados y pay_runs); xml-ingestion.ts:243, :263, :295, :320, :336, :461, :491, :563, :573, :598, :649; bank-reconciliation.ts:104, :157, :212, :257. En journal-entries.ts sustituir la función local assertEntryAccess por el helper compartido para que haya un solo sitio que mantener.

Caso especial verificado: invoices.ts:361 hace `UPDATE invoices SET status='void' WHERE id=$1 AND status NOT IN ('paid','void')` sin filtrar por entidad ni inquilino. Con RLS activa el UPDATE ya no cruza inquilinos, pero sigue cruzando entidades: llamar assertResourceEntity(req, 'invoices', req.params.id) ANTES del UPDATE.

**Archivos**

- `/Users/victor/projects/Accounting/src/api/rest/middleware/entity.ts` — modificar: añadir TABLAS_CON_ENTIDAD, assertResourceEntity y assertBankAccountEntity
- `/Users/victor/projects/Accounting/src/api/rest/routes/accounts.ts` — modificar: assertResourceEntity en GET/PATCH/DELETE por :id (líneas 119, 208, 250)
- `/Users/victor/projects/Accounting/src/api/rest/routes/invoices.ts` — modificar: assertResourceEntity en las seis rutas por :id, incluida la de void antes del UPDATE de la línea 361
- `/Users/victor/projects/Accounting/src/api/rest/routes/bills.ts` — modificar: assertResourceEntity en las rutas por :id
- `/Users/victor/projects/Accounting/src/api/rest/routes/customers.ts` — modificar: assertResourceEntity en :id (líneas 115, 126)
- `/Users/victor/projects/Accounting/src/api/rest/routes/vendors.ts` — modificar: assertResourceEntity en las rutas por :id
- `/Users/victor/projects/Accounting/src/api/rest/routes/fiscal-periods.ts` — modificar: assertResourceEntity en close-status, soft-close y hard-close (líneas 44, 57, 68)
- `/Users/victor/projects/Accounting/src/api/rest/routes/payroll.ts` — modificar: assertResourceEntity en las rutas por :id de empleados y pay_runs
- `/Users/victor/projects/Accounting/src/api/rest/routes/xml-ingestion.ts` — modificar: assertResourceEntity en las rutas por :id de pre-registrations, processing-rules, processing-batches y xml-documents
- `/Users/victor/projects/Accounting/src/api/rest/routes/bank-reconciliation.ts` — modificar: assertBankAccountEntity en /transactions/:id/suggestions, /transactions/:id/match, /reconciliations/:id y /reconciliations/:id/complete
- `/Users/victor/projects/Accounting/src/api/rest/routes/journal-entries.ts` — modificar: sustituir la assertEntryAccess local (líneas 19-25) por assertResourceEntity

**Criterios de aceptación**

- Dado un usuario del inquilino T con acceso sólo a la entidad A, cuando pide GET /v1/accounts/<id de una cuenta de la entidad B del mismo inquilino T>, entonces responde 403 y no devuelve la cuenta.
- Dado el mismo usuario, cuando pide POST /v1/invoices/<id de factura de la entidad B>/void, entonces responde 403 y la fila de invoices de B conserva su status anterior.
- Dado un id inexistente, cuando se pide cualquiera de esas rutas, entonces 404 NotFoundError y no 403 (no se filtra la existencia de recursos ajenos por diferencia de código, porque bajo RLS lo ajeno de otro inquilino ya es indistinguible de lo inexistente).
- Dado `grep -rn "assertResourceEntity\\|assertBankAccountEntity" src/api/rest/routes/ | wc -l`, cuando corre, entonces cubre al menos las 30 rutas por :id enumeradas.

**Pruebas**

- `tests/api/perimeter/entidad-ajena.spec.ts` — para cada familia de rutas (accounts, invoices, bills, customers, vendors, fiscal-periods, payroll, xml, bank-reconciliation) un caso de entidad ajena del mismo inquilino que responde 403 y uno de id inexistente que responde 404

**Riesgo.** Añadir una consulta previa a cada ruta por :id encarece la petición. Es una lectura por id con índice de clave primaria y ya se hace en journal-entries; el coste real está en la transacción por consulta que abre withTenant (ver decisión sobre estrategia de conexión).

##### `E2.1-e` Conectar como mnemosine_app: configuración, siembra y arranque fail-closed · **M**

Hallazgo que contradice al atlas: el .env de este repositorio YA tiene DATABASE_URL=postgresql://mnemosine_app y MIGRATION_DATABASE_URL=postgresql://mnemosine_owner. Lo que falta no es cambiar la variable en desarrollo, sino (i) alinear los valores por defecto y la documentación, (ii) arreglar los caminos que quedan rotos al perder el bypass, y (iii) impedir que un despliegue arranque con un rol que ignora la RLS sin decirlo.

1) src/config/index.ts:12 — el valor por defecto de DATABASE_URL es 'postgresql://postgres:postgres@localhost:5432/accounting_core', un superusuario que ignora RLS. Cambiarlo a mnemosine_app y actualizar .env.example:8 en el mismo sentido, dejando la nota de que el superusuario es sólo para provision-roles.sql.

2) Arranque fail-closed en bootstrap() (src/index.ts), antes de listen():
   - Consultar `SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`.
   - Si bypass es true y config.env === 'production', abortar con logger.error('rls_bypass_role') y process.exit(1): un servidor que ignora la RLS en producción no debe levantarse en silencio.
   - Si bypass es true fuera de producción, logger.warn con el nombre del rol.
   - Si config.env === 'production' y config.jwt.secret === 'dev-secret-change-me', abortar: con ese secreto cualquiera firma un JWT con el tenant_id que quiera, y entonces la RLS protege exactamente nada. Es el eslabón del que cuelga todo este paquete.

3) src/database/seed.ts usa query() de connection.ts (sin contexto) y por tanto DATABASE_URL. Con mnemosine_app y FORCE RLS, el INSERT en organizations y legal_entities viola la política tenant_isolation. Arreglo mínimo y correcto: importar enterTenant y llamarlo con TENANT_ID (seed.ts:4) inmediatamente después del INSERT en public.tenants (línea 15), que está excluida de RLS. Los INSERT de users también son de tabla excluida. A partir de ahí toda la siembra corre dentro del inquilino y las políticas la dejan pasar.

4) scripts/e2e-arap.ts y scripts/e2e-reversal.ts ya llaman enterTenant (líneas 43 y 34): no requieren cambio.

5) Revocar el SELECT de mnemosine_app sobre vistas y vistas materializadas. provision-roles.sql:47 hace `GRANT SELECT ... ON ALL TABLES IN SCHEMA public`, que en Postgres incluye relkind 'v' y 'm'. Las vistas materializadas NO están sujetas a RLS: mv_trial_balance y mv_account_balance_summary contienen datos de todos los inquilinos y hoy serían legibles sin filtro por el rol de la aplicación. Verificado que ningún archivo de src/ las consulta (sólo se mencionan en un comentario de posting.ts:434), así que revocarlas no rompe nada, y sólo se refrescan desde refresh_materialized_views(), que es SECURITY DEFINER desde la migración 024. Añadir el bloque REVOKE al final de src/database/rls-policies.sql, que migrate.ts reaplica tras cada migración.

**Archivos**

- `/Users/victor/projects/Accounting/src/config/index.ts` — modificar línea 12: valor por defecto de DATABASE_URL apunta a mnemosine_app en lugar de postgres
- `/Users/victor/projects/Accounting/.env.example` — modificar líneas 8 y 99-103: DATABASE_URL de ejemplo con mnemosine_app y nota de que el superusuario sólo sirve para provision-roles.sql
- `/Users/victor/projects/Accounting/src/index.ts` — modificar bootstrap(): comprobaciones de arranque de rolbypassrls y de JWT_SECRET por defecto en producción, con salida por error antes de listen()
- `/Users/victor/projects/Accounting/src/database/seed.ts` — modificar: importar enterTenant y llamarlo con TENANT_ID tras el INSERT en public.tenants, para que la siembra pase las políticas bajo mnemosine_app
- `/Users/victor/projects/Accounting/src/database/rls-policies.sql` — modificar: bloque final que revoca SELECT sobre vistas y vistas materializadas del esquema public a mnemosine_app

**Migración**

```sql
-- al final de src/database/rls-policies.sql (idempotente, se reaplica tras cada migración)
DO $mvs$
DECLARE r record; n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_app') THEN RETURN; END IF;
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind = 'm'
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM mnemosine_app', r.relname);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'revocado acceso de la app a % vistas materializadas (no sujetas a RLS)', n;
END
$mvs$;
```

**Criterios de aceptación**

- Dado un entorno con DATABASE_URL apuntando a un rol con rolbypassrls y NODE_ENV=production, cuando arranca el servidor, entonces registra rls_bypass_role y sale con código 1 sin escuchar en el puerto.
- Dado NODE_ENV=production y JWT_SECRET sin definir, cuando arranca el servidor, entonces aborta antes de escuchar.
- Dada una base recién migrada y DATABASE_URL=mnemosine_app, cuando corre `npm run seed`, entonces termina sin errores y legal_entities contiene la entidad sembrada.
- Dado mnemosine_app tras `npm run migrate`, cuando ejecuta `SELECT count(*) FROM mv_trial_balance`, entonces Postgres responde permiso denegado (42501).
- Dado `npm run migrate` sobre una base ya migrada, cuando termina, entonces el REVOKE es idempotente y no falla.

**Pruebas**

- `tests/api/perimeter/arranque.spec.ts` — la comprobación de arranque aborta con rol bypassrls en producción, con JWT_SECRET por defecto en producción, y sólo advierte fuera de producción

**Riesgo.** El REVOKE sobre vistas alcanzaría también a vistas no materializadas que sí respetan la RLS del subyacente si alguien las añade después. Acotar el REVOKE a relkind = 'm' si se prefiere ser conservador; hoy no hay vistas ordinarias en el esquema (verificado: ninguna migración crea CREATE VIEW).

##### `E2.1-f` Decidir y ejecutar el destino de /public/v1 bajo RLS · **S**

/public/v1 se monta sin autenticación (src/index.ts:100) y consulta blockchain_attestations (tenant_id NOT NULL, migración 006:199), legal_entities, period_commitments (tenant_id NOT NULL, 006:248) y published_aggregates (tenant_id NOT NULL, 006:282). Todas quedan bajo tenant_isolation. Sin contexto de inquilino —y no puede haberlo: la petición es anónima— app_current_tenant() devuelve NULL y las cuatro consultas devuelven cero filas. Es decir: encender el perímetro APAGA /public/v1. Hay que decidirlo explícitamente, no descubrirlo en producción.

Trabajo que se hace en cualquiera de los caminos:
1) Bandera de configuración PUBLIC_VERIFICATION_ENABLED (config.features.publicVerification, por defecto false). En src/index.ts, montar publicVerificationRouter sólo si está activa; si no lo está, /public/v1/* responde 404 por el enrutador por defecto de Express.
2) Envolver los siete manejadores (public-verification.ts:20, 114, 152, 212, 238, 290, 308) en asyncHandler: hoy son funciones async desnudas que lanzan ValidationError y NotFoundError y, bajo Express 4, dejan la petición colgada en vez de responder. Sin esto, el endpoint no responde ni siquiera para decir que no hay datos.
3) Montar rateLimiter delante de /public/v1 (hoy sólo cuelga de /v1 y /v1/ai/webhooks, líneas 108 y 118, desmintiendo el comentario de public-verification.ts:13).

Si la decisión es mantenerlo vivo (opción B), además: crear la migración 031 con funciones SECURITY DEFINER de lectura acotada —una por endpoint— propiedad de mnemosine_owner, con search_path fijado, que NO devuelvan tenant_id, entity_id ni el nombre de la entidad, y sustituir en public-verification.ts las consultas directas por llamadas a esas funciones. La consulta de la línea 28-30, que hoy SELECCIONA tenant_id y entity_id en un endpoint anónimo, desaparece.

Si la decisión es retirarlo (opción A, recomendada), la bandera queda en false, se documenta en .env.example por qué, y no se escribe la migración 031.

**Archivos**

- `/Users/victor/projects/Accounting/src/config/index.ts` — modificar: añadir features.publicVerification leída de PUBLIC_VERIFICATION_ENABLED, por defecto false
- `/Users/victor/projects/Accounting/src/index.ts` — modificar línea 100: montar publicVerificationRouter sólo bajo la bandera y con rateLimiter delante
- `/Users/victor/projects/Accounting/src/api/rest/routes/public-verification.ts` — modificar: envolver los siete manejadores en asyncHandler; si se elige la opción B, sustituir las consultas directas por las funciones SECURITY DEFINER y dejar de seleccionar tenant_id/entity_id
- `/Users/victor/projects/Accounting/src/database/migrations/031_public_verification_reads.sql` — crear (SÓLO si la decisión es la opción B): funciones SECURITY DEFINER de lectura acotada para la verificación anónima
- `/Users/victor/projects/Accounting/.env.example` — modificar: documentar PUBLIC_VERIFICATION_ENABLED y por qué viene apagada

**Migración**

```sql
-- SÓLO en la opción B. Ejemplo del patrón para el endpoint principal:
-- CREATE OR REPLACE FUNCTION public.verificacion_publica_por_hash(p_entry_hash text)
-- RETURNS TABLE (entry_hash text, zkverify_merkle_root text, zkverify_confirmed_at timestamptz, status text, created_at timestamptz)
-- LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
--   SELECT entry_hash, zkverify_merkle_root, zkverify_confirmed_at, status, created_at
--   FROM public.blockchain_attestations WHERE entry_hash = p_entry_hash LIMIT 1;
-- $$;
-- REVOKE ALL ON FUNCTION public.verificacion_publica_por_hash(text) FROM PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.verificacion_publica_por_hash(text) TO mnemosine_app;
```

**Criterios de aceptación**

- Dado PUBLIC_VERIFICATION_ENABLED sin definir, cuando se pide GET /public/v1/verify/<hash>, entonces responde 404 y no toca la base.
- Dado un hash con formato inválido y la bandera activa, cuando se pide GET /public/v1/verify/<hash>, entonces responde 400 con el cuerpo de error estándar y NO se queda colgada (hoy sí lo hace).
- Dada la bandera activa y la opción B implementada, cuando se pide GET /public/v1/verify/<hash existente>, entonces la respuesta contiene el hash, la raíz de Merkle y el estado, y NO contiene tenant_id, entity_id ni el nombre de la entidad.
- Dada la bandera activa, cuando se superan las peticiones por minuto configuradas desde una misma IP, entonces responde 429.

**Pruebas**

- `tests/api/perimeter/public-v1.spec.ts` — con la bandera apagada /public/v1/* devuelve 404; con la bandera encendida un hash inválido responde 400 y no cuelga; la respuesta no contiene tenant_id ni entity_id

**Riesgo.** Si alguien tiene ya integrada la verificación pública, apagarla es un cambio de contrato visible. Por eso es una decisión y no una tarea silenciosa.

##### `E2.1-g` GraphQL: permisos, validación de entidad y poda del schema · **M**

Los resolvers (src/api/graphql/resolvers/index.ts) aplican assertEntityAccess sólo en las cinco mutaciones (líneas 143, 165, 170, 175, 180). Las ocho queries no comprueban nada: account(id), journalEntry(id) e invoice(id) devuelven la fila por UUID sin mirar quién pregunta, y accounts/journalEntries/invoices/trialBalance/fiscalPeriods aceptan cualquier entityId. Con tenantContext montado (E2.1-b) el cruce de inquilinos queda cerrado por RLS; falta el permiso y la entidad.

1) Añadir al principio del módulo de resolvers:

  interface GraphqlCtx { user?: JwtPayload; tenantId?: string; entityId?: string }

  function exigirUsuario(ctx: GraphqlCtx): JwtPayload {
    if (!ctx.user) throw new UnauthorizedError();
    return ctx.user;
  }

  /** Mismo criterio que requirePermission del REST, incluido el comodín '*'. */
  function exigirPermiso(ctx: GraphqlCtx, ...permisos: string[]): JwtPayload {
    const user = exigirUsuario(ctx);
    if (user.permissions.includes('*')) return user;
    const faltan = permisos.filter((p) => !user.permissions.includes(p));
    if (faltan.length > 0) throw new ForbiddenError('Insufficient permissions', { required: permisos, missing: faltan });
    return user;
  }

  Reutilizar assertEntityAccess de src/api/rest/middleware/auth.ts (ya importado en la línea 2) y assertResourceEntity de E2.1-d para las queries por id.

2) Mapa permiso→campo, alineado con el REST:
   account, accounts → 'accounts:read'
   journalEntry, journalEntries → 'journal_entries:read'
   invoice, invoices → 'invoices:read'
   trialBalance → 'reports:read'
   fiscalPeriods → 'accounts:read'
   createJournalEntry → 'journal_entries:create'; postJournalEntry → 'journal_entries:post'; voidJournalEntry → 'journal_entries:void'; softClosePeriod y hardClosePeriod → 'periods:close'.

3) Toda query con argumento entityId llama assertEntityAccess(user, args.entityId) antes de consultar. Toda query por id (account, journalEntry, invoice) llama assertResourceEntity con su tabla, que ya lanza NotFoundError si no existe y ForbiddenError si es de otra entidad. Los resolvers de campo (Account.parent/children, JournalEntry.lines, Invoice.lines/customer/payments/journalEntry, Customer.invoices, Vendor.bills) sólo se alcanzan desde una raíz ya autorizada, así que no repiten la comprobación; dejarlo escrito en un comentario para que nadie exponga una raíz nueva sin guardia.

4) Podar del schema (src/api/graphql/schemas/schema.ts) todo lo que no tiene resolver: de type Query, balanceSheet e incomeStatement; de type Mutation, createAccount, updateAccount, deleteAccount, reverseJournalEntry, createInvoice, sendInvoice, voidInvoice, recordInvoicePayment, stampCfdi y cancelCfdi; y el bloque type Subscription completo (cuatro campos, cero resolvers, y además no hay transporte de suscripciones montado: src/index.ts sólo usa expressMiddleware). Los tipos de entrada e interfaces que queden huérfanos tras la poda (CreateAccountInput, UpdateAccountInput, CreateInvoiceInput, InvoiceLineInput, BalanceSheet, IncomeStatement) se retiran también. reverseJournalEntry se reintroducirá con resolver en el paquete de superficie CLI del motor; hoy sale porque declarado sin implementación revienta al invocarse.

5) Test estructural: parsear typeDefs con graphql.parse, recoger los campos de Query y Mutation y comparar con Object.keys(resolvers.Query) y Object.keys(resolvers.Mutation). El test falla si sobra un campo sin resolver o un resolver sin campo.

**Archivos**

- `/Users/victor/projects/Accounting/src/api/graphql/resolvers/index.ts` — modificar: helpers exigirUsuario/exigirPermiso; permiso y assertEntityAccess en las ocho queries; assertResourceEntity en account, journalEntry e invoice; permiso en las cinco mutaciones existentes
- `/Users/victor/projects/Accounting/src/api/graphql/schemas/schema.ts` — modificar: retirar balanceSheet e incomeStatement de Query, las diez mutaciones sin resolver, el bloque type Subscription completo y los tipos que quedan huérfanos
- `/Users/victor/projects/Accounting/src/index.ts` — modificar: introspection: config.env !== 'production' en el constructor de ApolloServer (compartido con E2.1-b)

**Criterios de aceptación**

- Dado un token sin el permiso accounts:read, cuando ejecuta `{ accounts(entityId: "<propia>") { totalCount } }`, entonces la respuesta trae un error con extensiones de permiso y data.accounts nulo.
- Dado un token con acceso sólo a la entidad A, cuando ejecuta `{ journalEntries(entityId: "<B>") { id } }` siendo B del mismo inquilino, entonces error de acceso denegado y ninguna consulta al mayor de B.
- Dado un token del inquilino T1, cuando ejecuta `{ account(id: "<uuid de cuenta de T2>") { code } }`, entonces la respuesta es un error de no encontrado (RLS devuelve cero filas) y nunca el código de la cuenta.
- Dado el schema podado, cuando se parsea typeDefs y se comparan Query y Mutation con las claves de resolvers, entonces los conjuntos coinciden exactamente y no existe type Subscription.
- Dado NODE_ENV=production, cuando se ejecuta la introspección, entonces Apollo la rechaza.

**Pruebas**

- `tests/api/graphql/permisos.spec.ts` — cada query y mutación exige su permiso y valida la entidad; un token sin permiso recibe ForbiddenError; una entidad ajena del mismo inquilino recibe ForbiddenError
- `tests/api/graphql/schema-vs-resolvers.spec.ts` — todo campo de Query y Mutation del SDL tiene resolver y viceversa; no existe type Subscription

**Riesgo.** Podar campos del schema es un cambio incompatible para cualquier cliente que los invoque. Ninguno de ellos funciona hoy (los diez sin resolver lanzan al invocarse y las suscripciones no tienen transporte), así que la incompatibilidad es con código que ya estaba roto; conviene decirlo en la nota de versión.

##### `E2.1-h` Batería del perímetro: un test por vector, más el nivel de integración contra RLS real · **L**

Dos niveles, porque el repositorio no tiene ninguno de los dos y cada uno atrapa cosas distintas.

NIVEL 1 — perímetro en proceso, sin base de datos (corre siempre con `npm test`).
Añadir supertest ^7 como devDependency. Construir la app con buildApp() de E2.1-b y mockear src/database/connection.js con vi.mock, exponiendo un query() espiable y un withTenant/runInTenant reales (reimportando AsyncLocalStorage) para poder afirmar sobre el contexto. Firmar los tokens con jsonwebtoken y config.jwt.secret.

Cinco vectores, uno por archivo o cinco describe en tests/api/perimeter/vectores.spec.ts:
  V1 sin inquilino: token sin tenant_id → 401 en cualquier ruta /v1 y en /graphql; query() no se invoca.
  V2 inquilino ajeno: token del inquilino T2 pidiendo un recurso de T1 → el espía comprueba que set_config se llamó con T2, de modo que la consulta se ejecutó bajo el contexto del solicitante y no bajo el del recurso.
  V3 entidad ajena: token con entities=[A] pidiendo un recurso de la entidad B → 403, y para las rutas por :id, 403 tras la lectura de propiedad.
  V4 parámetro de consulta: GET /v1/reports/trial-balance?entity_id=<B> → 403; y el test estructural de E2.1-c que prohíbe el patrón en todo src/api/rest/routes/.
  V5 GraphQL: query por entityId ajena → error de acceso; query por id de otro inquilino → no encontrado; ausencia de permiso → error de permiso; introspección apagada en producción.

NIVEL 2 — integración contra Postgres real como mnemosine_app (tests/api/perimeter/rls.int.spec.ts), con describe.skipIf(!process.env.PERIMETER_DB_URL) para no romper la suite de quien no tenga base. Siembra dos inquilinos con dos entidades cada uno mediante SUPERUSER, y comprueba: (a) sin contexto, SELECT sobre legal_entities devuelve 0 filas; (b) con contexto T1, un SELECT de journal_entries de T2 devuelve 0 filas; (c) un INSERT con tenant_id de T2 bajo contexto T1 falla con SQLSTATE 42501; (d) una lectura sobre una tabla HIJA (journal_entry_lines, invoice_lines, paycheck_taxes) bajo contexto T1 no ve filas de T2 — es el flanco que verify-isolation.sh no cubre; (e) una mutación REST completa deja fila en audit_log con el tenant correcto. Limpieza en afterAll con el rol superusuario.

Añadir a package.json: "test:perimeter": "vitest run tests/api/perimeter".

**Archivos**

- `/Users/victor/projects/Accounting/package.json` — modificar: devDependency supertest ^7 y @types/supertest; script test:perimeter
- `/Users/victor/projects/Accounting/tests/api/perimeter/vectores.spec.ts` — crear: los cinco vectores del nivel 1
- `/Users/victor/projects/Accounting/tests/api/perimeter/rls.int.spec.ts` — crear: nivel 2 contra base real, condicionado a PERIMETER_DB_URL
- `/Users/victor/projects/Accounting/tests/fixtures/perimetro.ts` — crear: emisor de tokens de prueba (dos inquilinos, dos entidades, permisos configurables) y helper de siembra/limpieza para el nivel 2

**Criterios de aceptación**

- Dado `npm test`, cuando corre en una máquina sin base de datos, entonces los cinco vectores del nivel 1 pasan y el archivo de integración se salta con mensaje explícito.
- Dado que alguien revierte tenantContext del montaje, cuando corre `npm run test:perimeter`, entonces V1 y V2 fallan.
- Dado que alguien reintroduce `entity_id as string || req.entityId` en cualquier ruta, cuando corre la suite, entonces V4 falla nombrando el archivo.
- Dado PERIMETER_DB_URL apuntando a una base migrada, cuando corre el nivel 2, entonces los cinco casos (a)-(e) pasan y la base queda sin residuos de la siembra.

**Pruebas**

- `tests/api/perimeter/vectores.spec.ts` — V1 sin inquilino, V2 inquilino ajeno, V3 entidad ajena, V4 parámetro de consulta, V5 GraphQL
- `tests/api/perimeter/rls.int.spec.ts` — aislamiento real como mnemosine_app, incluidas las tablas hijas y la escritura cruzada que debe fallar con 42501

**Riesgo.** Mockear el módulo de conexión y a la vez querer afirmar sobre el contexto real es la parte delicada: usar el patrón ya establecido en tests/database/tenant-context.spec.ts, que intercepta pg (no connection.ts) y deja el módulo real intacto. Es más fiel y ya está probado en este repositorio.

##### `E2.1-i` verify-isolation.sh: tablas hijas, vistas materializadas y entrada por npm · **S**

scripts/verify-isolation.sh comprueba hoy tres fronteras y sólo sobre tablas CON columna de alcance. Añadir:
1) Un bloque que, bajo contexto del inquilino de prueba T2, cuente filas de tres tablas hijas representativas de las 19 de rls-policies.sql (journal_entry_lines vía journal_entries, invoice_lines vía invoices, paycheck_taxes vía paychecks) pertenecientes al otro inquilino y exija cero.
2) Una comprobación de cobertura: que toda tabla del esquema con columna tenant_id o entity_id, excluidas users, sessions, tenants y migrations, tenga política tenant_isolation en pg_policies, y que toda tabla de la lista de hijas tenga tenant_isolation_child. Es lo que convierte la lista escrita a mano del SQL en algo que avisa cuando se queda corta.
3) Que mnemosine_app NO pueda leer mv_trial_balance ni mv_account_balance_summary (contrapartida del REVOKE de E2.1-e).
4) Dejar de derivar APP_URL cortando la URL del superusuario con sed: aceptar APP_URL del entorno y usar la derivación sólo como respaldo.
5) package.json: "verify:isolation": "./scripts/verify-isolation.sh", para que exista una entrada estable a la que apunte la futura CI.

**Archivos**

- `/Users/victor/projects/Accounting/scripts/verify-isolation.sh` — modificar: comprobación de tablas hijas, comprobación de cobertura de políticas sobre pg_policies, comprobación de vistas materializadas inaccesibles, APP_URL configurable
- `/Users/victor/projects/Accounting/package.json` — modificar: script verify:isolation

**Criterios de aceptación**

- Dado un entorno migrado y provisionado, cuando corre `npm run verify:isolation`, entonces imprime cero fallos e incluye una línea por cada una de las tres tablas hijas comprobadas.
- Dado que alguien crea una tabla con tenant_id y olvida reaplicar rls-policies.sql, cuando corre el script, entonces falla nombrando la tabla sin política.
- Dado que alguien concede de nuevo SELECT sobre mv_trial_balance a mnemosine_app, cuando corre el script, entonces falla.

**Pruebas**

- `scripts/verify-isolation.sh` — el propio script es la prueba; su código de salida distinto de cero es el criterio

##### `E2.1-j` Orden de despliegue y reparación de la ventana de migración a medias · **S**

Defecto verificado en src/database/migrate.ts: el bucle ejecuta cada archivo de migración y sólo aplica rls-policies.sql UNA VEZ, al terminar todos (líneas 53-59). Si una migración intermedia falla, process.exit(1) deja las tablas ya creadas por las migraciones anteriores del mismo lote SIN política y SIN los GRANT que el bloque de auto-reparación de rls-policies.sql concede: para mnemosine_app esas tablas quedan invisibles con 'permission denied', mientras el resto del sistema sigue funcionando. Ésa es exactamente la 'media migración' que hay que evitar.

Arreglo: mover la aplicación de rls-policies.sql DENTRO del bucle, tras registrar cada archivo en public.migrations, conservando además la aplicación final. Es idempotente (DROP POLICY IF EXISTS + CREATE) y sólo corre por migración pendiente, así que el coste es despreciable. Añadir al mensaje de error el nombre del archivo que falló.

Escribir docs/despliegue-perimetro.md con el orden seguro, que es éste y no otro:
  1. psql "$SUPERUSER_URL" -f scripts/provision-roles.sql (idempotente; crea los roles, traspasa la propiedad al owner).
  2. MIGRATION_DATABASE_URL=<owner> npm run migrate. Comprobar el NOTICE 'RLS applied to N tables' y que `SELECT count(*) FROM pg_policies WHERE schemaname='public'` cubre las tablas con alcance más las 19 hijas.
  3. npm run verify:isolation contra ese entorno.
  4. Desplegar el CÓDIGO con el perímetro mientras DATABASE_URL siga apuntando al rol actual. Advertencia que hay que dejar escrita: mnemosine_owner NO es un rol intermedio seguro, porque las tablas llevan FORCE ROW LEVEL SECURITY y el dueño también queda sujeto a las políticas; el único rol que ignora la RLS es un superusuario. Es decir, o ya se está conectando como mnemosine_app (y entonces este paso es el que REPARA el servidor), o se está conectando como superusuario y el middleware es inocuo hasta el paso 5.
  5. Cambiar DATABASE_URL a mnemosine_app en UNA sola réplica (canario) y observar: /ready en 200, un GET /v1/accounts autenticado devolviendo filas distintas de cero, y ausencia de errores 42501 en el log. Sólo entonces el resto de réplicas.
  6. Reversión: devolver DATABASE_URL al rol anterior y reiniciar. El código con perímetro es correcto en ambos mundos: sin RLS, abrir contexto no cambia el resultado.
  7. Nota permanente: migrate y seed siguen usando MIGRATION_DATABASE_URL / el contexto sembrado (E2.1-e); nunca el rol de la aplicación para DDL.

**Archivos**

- `/Users/victor/projects/Accounting/src/database/migrate.ts` — modificar: aplicar rls-policies.sql tras cada archivo de migración dentro del bucle, además de la pasada final; incluir el nombre del archivo en el mensaje de fallo
- `/Users/victor/projects/Accounting/docs/despliegue-perimetro.md` — crear: los siete pasos del orden seguro, la advertencia sobre FORCE RLS y el owner, y el procedimiento de reversión

**Criterios de aceptación**

- Dadas tres migraciones pendientes de las que la segunda falla, cuando corre `npm run migrate`, entonces la primera queda registrada CON sus políticas y GRANT aplicados, el proceso sale con código 1 y el mensaje nombra el archivo que falló.
- Dado un lote de migraciones que crea una tabla nueva con tenant_id, cuando termina `npm run migrate`, entonces esa tabla tiene política tenant_isolation y mnemosine_app tiene SELECT/INSERT/UPDATE/DELETE sobre ella.
- Dado el documento de despliegue, cuando un operador lo sigue de arriba abajo en un entorno limpio, entonces el servidor queda conectado como mnemosine_app, /ready responde 200 y GET /v1/accounts devuelve filas.

**Pruebas**

- `tests/database/migrate.spec.ts` — con un directorio de migraciones simulado y pg interceptado, rls-policies.sql se ejecuta una vez por archivo aplicado y el fallo intermedio informa del archivo

**Riesgo.** Aplicar rls-policies.sql por cada migración multiplica su ejecución en un despliegue con muchas pendientes. El bloque recorre el catálogo y hace DROP/CREATE POLICY por tabla: en el orden de las decenas de milisegundos por pasada, irrelevante frente al riesgo que elimina.

#### Cómo se sabe que cerró

- `npm run typecheck` devuelve 0 y `npm test` pasa entero, incluidos los cinco vectores de tests/api/perimeter/vectores.spec.ts.
- `grep -rn "entity_id as string\\|req.query.entity_id\\|req.body.entity_id" src/api/rest/routes/ | wc -l` devuelve 0.
- `grep -rLn "tenantContext" src/index.ts` no encuentra el archivo (es decir, tenantContext está montado) y `grep -c "app.use(apiPrefix, tenantContext)" src/index.ts` devuelve 1.
- Con la base migrada y DATABASE_URL=mnemosine_app: el servidor arranca, GET /ready devuelve 200 y GET /v1/accounts con un token válido devuelve un número de filas distinto de cero — hoy, con ese mismo .env, devuelve cero.
- `SUPERUSER_URL=... MNEMOSINE_APP_PASSWORD=... npm run verify:isolation` termina con código 0 e incluye las comprobaciones de tablas hijas, de cobertura sobre pg_policies y de vistas materializadas inaccesibles.
- `PERIMETER_DB_URL=... npm run test:perimeter` pasa los cinco casos del nivel de integración, incluida la escritura cruzada que debe fallar con SQLSTATE 42501.
- Parsear src/api/graphql/schemas/schema.ts y comparar los campos de Query y Mutation con las claves de resolvers devuelve conjuntos idénticos, y `grep -c "type Subscription" src/api/graphql/schemas/schema.ts` devuelve 0.
- Revertir el montaje de tenantContext hace fallar los vectores V1 y V2; reintroducir el patrón `entity_id as string` hace fallar V4. La batería demuestra que cierra reabriendo cada hueco a mano una vez.
- `SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname IN ('tenant_isolation','tenant_isolation_child')` cubre las 89 tablas con columna de alcance más las 19 hijas tras `npm run migrate`.


### E2.2 · Un solo catálogo de autorización: roles, permisos que existen y segregación de funciones con efecto
**Objetivo.** Dejar un único catálogo de roles y permisos en src/auth/roles.ts, tipado, consumido por el middleware REST, por `mnemosine init`, por el doctor y por la documentación del agente, de modo que ningún permiso exigido por una ruta pueda quedar sin conceder y un error de dedo en un permiso rompa `tsc` en vez de producir un 403 en producción. Además: segregación de funciones invocada en puntos de entrada reales, y la rama HS256 resuelta (retirada por defecto, con arranque que falla si se configura mal).

**Por qué aquí.** Es lo que hace que el perímetro HTTP signifique algo. Cerrar el bypass de entity_id y montar withTenant protegen el aislamiento por tenant y por entidad, pero no evitan que un `contador` legítimo reciba 403 en los 36 endpoints de /v1/payroll ni que nadie salvo `owner` pueda anular una factura o un bill. Va después de la batería de tests del perímetro (E2.1) porque este paquete cambia cómo se calculan los permisos efectivos y sin esos tests el cambio es a ciegas; y antes del paquete de GraphQL, que necesita el mismo catálogo para aplicar autorización en sus resolvers. No requiere ninguna migración de esquema, lo que lo hace barato de revertir.

**Depende de:** `E0.1` · **Migraciones:** `040-042` · **7 tareas · 3.9 sem-persona**

**Precondiciones:**

- Existe la batería de tests del perímetro de autorización (E2.1): authenticate en sus dos ramas, requirePermission, requireEntityAccess/assertEntityAccess y resolveIdentity. Sin ella no hay red bajo el cambio del cálculo de permisos efectivos.
- `npx tsc --noEmit` sale en 0 y `npx vitest run` está verde en el árbol de partida (verificado por la auditoría: 80 archivos, 1155 tests).
- Decisiones 1, 2, 3 y 5 de decisiones_a_resolver tomadas antes de empezar E2.2-c, E2.2-d y E2.2-f.

#### Decisiones a resolver

**¿Cómo se cubren los permisos de nómina (payroll:read/create/update/approve), que hoy sólo puede ejercer owner en los 36 endpoints de /v1/payroll?**

Ninguno de los dos catálogos concede ningún permiso payroll:*. El catálogo vivo tiene cuatro roles pensados para un despacho contable mexicano (owner, contador, revisor, auditor) y la nómina es un ciclo con su propia separación natural: quien calcula la corrida no debería ser quien la aprueba y la paga.

- Ampliar los roles existentes: contador recibe payroll:read/create/update y revisor recibe payroll:read/approve
- Crear roles dedicados 'nomina' y 'nomina_aprobador', dejando intactos los cuatro actuales
- No conceder nada y dejar la nómina como prerrogativa exclusiva de owner (estado actual)

_Recomendación:_ Ampliar los roles existentes (opción 1). Mantiene cuatro roles memorizables, respeta la separación calcular/aprobar que ya existe entre contador y revisor, y la regla de SoD 'Cálculo frente a aprobación de nómina' de E2.2-e vigila el caso en que una sola persona acumule ambos. Crear roles dedicados es preferible sólo si un cliente real gestiona nómina con personal distinto del contable.

_Bloquea:_ E2.2-c (contenido definitivo de ROLES) y, en consecuencia, el test-censo y el doc generado de E2.2-g.

**¿Los permisos efectivos se derivan del catálogo a partir de users.roles en cada autenticación, o se siguen materializando como copia en users.permissions?**

Hoy son una copia congelada: sólo la escriben src/cli/init/s2-users.ts:140-149 y src/database/seed.ts:23. Ampliar el catálogo no cambia nada para los usuarios ya creados, y no existe ningún comando de resincronización.

- Derivar en resolveIdentity: permisos = permissionsForRoles(users.roles) ∪ users.permissions (esta última pasa a ser 'concesiones extra')
- Mantener la copia y añadir una migración de backfill más un comando `mnemosine users resync` que la reescriba en cada cambio de catálogo
- Mantener la copia tal cual y documentar que hay que recrear al usuario

_Recomendación:_ Derivar (opción 1). No necesita migración, no necesita comando nuevo, hace que el catálogo sea de verdad la autoridad y conserva la vía de escape para concesiones puntuales. El coste es que un cambio de catálogo tiene efecto inmediato sobre todo el mundo: por eso E2.2-d añade el check de deriva en el doctor y E2.2-g deja el catálogo escrito en la documentación.

_Bloquea:_ E2.2-d completa.

**¿Qué se hace con la rama HS256 de authenticate, cuyo secreto cae por defecto en 'dev-secret-change-me' y que no tiene ningún emisor legítimo detrás?**

`grep -rn 'jwt.sign' src/` devuelve cero resultados. El CLI guarda un token OIDC (src/auth/token-store.ts) y ni siquiera tiene cliente HTTP que lo envíe. Es decir: hoy la rama sólo puede aceptar tokens fabricados fuera del sistema, y con el secreto por defecto cualquiera puede firmarse uno con permissions ['*'].

- Retirarla del todo: verifyLocal siempre 401, borrar config.jwt
- Retirarla por defecto y dejarla tras la bandera explícita AUTH_LOCAL_TOKENS, prohibida en producción y con JWT_SECRET de 32+ caracteres obligatorio (lo que implementa E2.2-f)
- Conservarla y construir un emisor propio: endpoint POST /v1/auth/login con contraseña contra users.password_hash, refresco y revocación por sessions

_Recomendación:_ Opción 2. Cierra hoy el agujero sin romper el desarrollo local ni las pruebas manuales, y el arranque falla ruidosamente si alguien intenta activarla en producción. La opción 3 es un producto en sí misma (login, refresco, revocación, rotación) y compite con el camino OIDC que ya está construido y probado; sólo tiene sentido si el producto debe funcionar en despachos sin proveedor de identidad, lo que es una pregunta de mercado, no de ingeniería.

_Bloquea:_ E2.2-f.

**¿Cuál es el modo por defecto de la política 'segregacion_de_funciones' (maker-checker) y sobre qué documentos se aplica?**

El producto es CLI-first y su usuario típico es un despacho donde a menudo hay una sola persona operando. Exigir maker-checker por defecto la dejaría sin poder aprobar nada de lo que ella misma capturó. Las tres tablas implicadas ya guardan al creador (bills.created_by, pay_runs.created_by, journal_entries.created_by).

- ninguna — no comprobar
- advertir — registrar el caso y dejar continuar
- exigir — 403 cuando el aprobador es el creador

_Recomendación:_ 'advertir' por defecto, con 'exigir' como opción que el despacho activa cuando tiene dos personas, y aplicado a los tres documentos citados (bill, pay_run, journal_entry por la ruta HTTP de posteo, nunca dentro de posting.ts). Deja rastro desde el primer día sin bloquear al usuario de un solo operador, y convierte la política en algo que el asistente puede explicar y proponer.

_Bloquea:_ E2.2-e (valor de defaultValue en la entrada nueva de POLICY_CATALOG).

**¿Quién debe tener settings:manage, el permiso más exigido de todo el sistema (30 rutas)?**

Cubre /v1/admin/integrations, /v1/webhooks, /v1/admin/blockchain y las reglas de procesamiento de XML. Varias de esas rutas reciben credenciales de terceros en el cuerpo de la petición (el propio atlas señala que auditLogMiddleware puede llegar a persistirlas en claro). Hoy sólo lo tiene owner por comodín; contador tiene un 'settings:read' que ninguna ruta exige.

- Sólo owner
- owner y contador
- Partirlo: settings:read para lectura de configuración (y añadir esas rutas de lectura), settings:manage sólo para owner

_Recomendación:_ Sólo owner (opción 1), conservando 'settings:read' en RESERVED_PERMISSIONS para cuando existan rutas de lectura. Configurar PAC, blockchain, webhooks e integraciones es donde se introducen credenciales: es prerrogativa del dueño de la cuenta, y no es un permiso que un contador necesite para operar.

_Bloquea:_ E2.2-c.

#### Tareas

##### `E2.2-a` Crear el catálogo único en src/auth/roles.ts (módulo puro, sin express ni pg) · **S**

Crear /Users/victor/projects/Accounting/src/auth/roles.ts. Debe ser un módulo SIN dependencias de runtime (nada de express, nada de src/database/connection.js) porque lo importan tanto el middleware REST como la CLI y el generador de documentación; src/auth/ es el sitio natural (middleware/auth.ts ya importa de ahí: oidc.js y provisioning.js). Exporta exactamente:

1) `export const PERMISSIONS = [...] as const;` con los 23 permisos que HOY exige alguna ruta, extraídos con `grep -rhno "requirePermission([^)]*)" src/api/rest/routes/`: accounts:read, accounts:create, accounts:update, accounts:delete, journal_entries:read, journal_entries:create, journal_entries:post, journal_entries:void, invoices:read, invoices:create, invoices:send, invoices:void, bills:read, bills:create, bills:approve, bills:void, reports:read, periods:close, settings:manage, payroll:read, payroll:create, payroll:update, payroll:approve.
2) `export const RESERVED_PERMISSIONS: Readonly<Record<string,string>>` = permisos declarados que ninguna ruta exige todavía, cada uno con su motivo en texto: 'audit:read' (lo concede hoy auditor y lo afirma tests/cli/init/sections.spec.ts:192; se reserva para la ruta de consulta de audit_log), 'settings:read' (lo concede hoy contador; se reserva para las futuras rutas de lectura de configuración), 'periods:reopen' (se reserva para el comando `mnemosine periods reopen` y para la regla SoD homónima), 'users:manage' (se reserva para la futura ruta de alta/edición de usuarios, donde se invocará SoD). NO se conserva 'reports:export' ni 'audit_log:read': ninguna ruta los exige, ninguna hoja de ruta los menciona y su único uso era el catálogo muerto.
3) `export type Permission = typeof PERMISSIONS[number] | keyof typeof RESERVED_PERMISSIONS;`
4) `export const WILDCARD = '*' as const;`
5) `export interface RoleSpec { label: string; permissions: readonly Permission[] | readonly ['*']; }`
6) `export const ROLES: Record<RoleName, RoleSpec>` con exactamente los cuatro nombres VIVOS (owner, contador, revisor, auditor), conservando los `label` actuales de s2-users.ts:14-42 para no cambiar el texto que ve el usuario en `init`. Los permisos concretos de cada rol los fija E2.2-c.
7) `export type RoleName = 'owner' | 'contador' | 'revisor' | 'auditor';` y `export const ROLE_NAMES: readonly RoleName[]`.
8) `export const CATALOG_VERSION = 2;` (1 era el estado dividido; se incrementa a mano en cada cambio de ROLES o de PERMISSIONS y lo estampa el doc generado de E2.2-g).
9) `export function permissionsForRoles(roles: readonly string[]): string[]` — unión de los permisos de los roles conocidos; si alguno concede '*' devuelve exactamente `['*']`; ignora en silencio los nombres desconocidos (el aviso lo da el doctor de E2.2-d, no una excepción en el camino de autenticación).
10) `export function isKnownRole(r: string): r is RoleName` y `export function isKnownPermission(p: string): p is Permission`.
11) `export function hasPermission(user: { permissions: readonly string[] }, permission: Permission): boolean` — comodín primero, luego inclusión. requirePermission (E2.2-b) y los resolvers de GraphQL (otro paquete) lo comparten para que la semántica del comodín se defina una sola vez.

No mover todavía SOD_RULES: eso es E2.2-e.

**Archivos**

- `/Users/victor/projects/Accounting/src/auth/roles.ts` — crear: PERMISSIONS, RESERVED_PERMISSIONS, Permission, WILDCARD, RoleSpec, ROLES, RoleName, ROLE_NAMES, CATALOG_VERSION, permissionsForRoles, isKnownRole, isKnownPermission, hasPermission

**Criterios de aceptación**

- Dado el módulo compilado, cuando se ejecuta `node -e "import('./dist/auth/roles.js').then(m=>console.log(m.PERMISSIONS.length))"`, entonces imprime 23.
- Dado `permissionsForRoles(['owner','contador'])`, entonces devuelve exactamente `['*']` y no una lista concatenada.
- Dado `permissionsForRoles(['admin'])` (rol del catálogo muerto), entonces devuelve `[]` sin lanzar.
- Dado `grep -rn "import" /Users/victor/projects/Accounting/src/auth/roles.ts`, entonces no aparece ninguna importación de express, pg ni de src/database/.

**Pruebas**

- `tests/auth/roles.spec.ts` — permissionsForRoles: comodín absorbe, rol desconocido devuelve [], unión sin duplicados, orden estable
- `tests/auth/roles.spec.ts` — isKnownPermission acepta los 23 exigidos y los 4 reservados, y rechaza 'payrol:read' y 'audit_log:read'

##### `E2.2-b` Tipar requirePermission con Permission y borrar el catálogo muerto de middleware/auth.ts · **S**

En /Users/victor/projects/Accounting/src/api/rest/middleware/auth.ts:

1) Borrar el bloque `export const ROLES` (líneas 133-172). Verificado que no lo importa nadie: `grep -rn "from '.*middleware/auth" src/ tests/` sólo trae authenticate, requirePermission, requireEntityAccess y assertEntityAccess (los importan src/index.ts:9, los 17 routers y src/api/graphql/resolvers/index.ts:2).
2) Cambiar la firma a `export function requirePermission(...permissions: Permission[])` importando `Permission` y `hasPermission` de ../../../auth/roles.js. Este es el cierre estructural del paquete: a partir de aquí un permiso mal escrito en una ruta NO compila, y `npm run typecheck` se convierte en la barrera. El cuerpo usa `hasPermission(req.user, p)` en vez de la inclusión directa, y conserva la forma actual del 403 (ForbiddenError('Insufficient permissions', { required, missing, current })) para no romper contratos de cliente.
3) En /Users/victor/projects/Accounting/src/cli/init/s2-users.ts: borrar el `export const ROLES` local (líneas 14-42) y sustituirlo por `export { ROLES, ROLE_NAMES, type RoleName } from '../../auth/roles.js';` — el re-export es obligatorio porque tests/cli/init/sections.spec.ts:15 importa ROLES de ese módulo y src/cli/init/index.ts:12 lo reexporta a su vez. `configure()` sigue leyendo `ROLES[role].label` y `ROLES[role].permissions` sin cambios de forma.
4) En s2-users.configure(), sustituir el listado `Object.keys(ROLES) as RoleName[]` por `ROLE_NAMES` (mismo resultado, orden garantizado por el catálogo y no por el orden de inserción del objeto).

No tocar todavía qué se INSERTA en users.permissions: eso es E2.2-d.

**Archivos**

- `/Users/victor/projects/Accounting/src/api/rest/middleware/auth.ts` — eliminar el export const ROLES (133-172); modificar requirePermission para tipar sus argumentos como Permission y delegar en hasPermission
- `/Users/victor/projects/Accounting/src/cli/init/s2-users.ts` — eliminar el export const ROLES local (14-42) y reexportar el del catálogo; usar ROLE_NAMES en configure()
- `/Users/victor/projects/Accounting/src/cli/init/index.ts` — modificar: la línea 12 sigue reexportando ROLES, ahora indirectamente; añadir RoleName al reexport

**Criterios de aceptación**

- Dado `grep -rn "export const ROLES" /Users/victor/projects/Accounting/src`, entonces devuelve exactamente una línea, en src/auth/roles.ts.
- Dado que se cambia una ruta a `requirePermission('payrol:read')`, cuando corre `npx tsc --noEmit`, entonces falla con TS2345 señalando ese archivo y esa línea (demostración obligatoria en la PR).
- Dado el árbol sin ese cambio, cuando corre `npx tsc --noEmit`, entonces sale con código 0.
- Dado un usuario con permissions ['*'], cuando pasa por requirePermission('payroll:approve'), entonces llama a next() sin error.
- Dado un usuario con permissions ['bills:read'], cuando pasa por requirePermission('bills:void'), entonces lanza ForbiddenError con details.missing = ['bills:void'] y statusCode 403.

**Pruebas**

- `tests/api/middleware/authorization.spec.ts` — requirePermission: comodín pasa; permiso faltante lanza ForbiddenError 403 con required/missing/current; sin req.user lanza UnauthorizedError 401
- `tests/cli/init/sections.spec.ts` — actualizar: ROLES importado de s2-users sigue siendo el mismo objeto que el de src/auth/roles.js (toBe por identidad)

**Riesgo.** Si algún consumidor externo al repo importaba el ROLES muerto, se rompe. Mitigación: es un paquete privado y el grep confirma cero importadores dentro del repo.

##### `E2.2-c` Cerrar la brecha: censo de permisos exigidos contra concedidos, y test que la mantiene cerrada · **M**

Fijar el contenido de ROLES en src/auth/roles.ts de modo que todo permiso exigido por una ruta lo conceda al menos un rol distinto de owner. Inventario verificado con `grep -rhno "requirePermission([^)]*)" src/api/rest/routes/` (23 permisos distintos, 151 registros de ruta; los dos únicos endpoints autenticados sin requirePermission son GET /v1/payroll/me/paychecks y GET /v1/payroll/me/w2/:tax_year, autoservicio del propio empleado, y se dejan como están):

EXIGIDOS Y NO CONCEDIDOS HOY POR NINGÚN ROL SALVO owner (la brecha): payroll:read (9 rutas), payroll:create (7), payroll:update (3), payroll:approve (15), settings:manage (30), bills:void (1, xml-ingestion.ts:320), invoices:send (1), invoices:void (2), journal_entries:void (1), accounts:delete (1).
EXIGIDOS Y YA CONCEDIDOS: accounts:read/create/update, journal_entries:read/create/post, invoices:read/create, bills:read/create/approve, reports:read, periods:close.
CONCEDIDOS Y NO EXIGIDOS: settings:read (contador) y audit:read (auditor) — pasan a RESERVED_PERMISSIONS con motivo, no se borran.

Asignación a implementar (recomendación de la decisión 1 y la decisión 5; si el humano decide otra cosa, cambia solo esta tabla):
- owner: ['*'] (sin cambios).
- contador: accounts:read/create/update, journal_entries:read/create/post/void, invoices:read/create/send, bills:read/create/approve, reports:read, periods:close, payroll:read/create/update, settings:read.
- revisor: accounts:read, journal_entries:read/post, invoices:read/void, bills:read/approve/void, reports:read, payroll:read/approve.
- auditor: accounts:read, journal_entries:read, invoices:read, bills:read, reports:read, audit:read (sin cambios).
- accounts:delete y settings:manage quedan SOLO en owner, deliberadamente: borrar una cuenta del catálogo y configurar PAC, blockchain, webhooks e integraciones (donde se escriben credenciales) es prerrogativa del dueño.

Escribir el test-censo, que es la pieza que impide que la brecha reaparezca: lee con fs los archivos de src/api/rest/routes/*.ts, extrae con la expresión /requirePermission\(([^)]*)\)/g los literales entrecomillados, y afirma (i) que todo permiso extraído está en PERMISSIONS, (ii) que PERMISSIONS no contiene ninguno que no aparezca en ninguna ruta —salvo los de RESERVED_PERMISSIONS—, (iii) que para cada permiso extraído existe al menos un rol distinto de owner que lo concede, y (iv) que el conteo de permisos distintos es 23. Es un test estático: no arranca servidor ni base.

**Archivos**

- `/Users/victor/projects/Accounting/src/auth/roles.ts` — modificar: contenido definitivo de ROLES.contador, ROLES.revisor y RESERVED_PERMISSIONS
- `/Users/victor/projects/Accounting/tests/auth/roles-census.spec.ts` — crear: censo estático de requirePermission sobre src/api/rest/routes/ contra el catálogo

**Criterios de aceptación**

- Dado un usuario con rol contador y entidad accesible, cuando hace GET /v1/payroll/employees?entity_id=<suya>, entonces recibe 200 (hoy recibe 403 con missing ['payroll:read']).
- Dado un usuario con rol revisor, cuando hace POST /v1/payroll/pay-runs/:id/approve, entonces no recibe 403 por permisos.
- Dado un usuario con rol revisor, cuando hace POST /v1/xml/pre-registrations/:id/reject, entonces no recibe 403 por permisos (bills:void).
- Dado que alguien añade `requirePermission('cuentas:leer')` a una ruta, cuando corre `npx vitest run tests/auth/roles-census.spec.ts`, entonces falla nombrando el archivo, el permiso y la sugerencia de añadirlo a PERMISSIONS.
- Dado que alguien añade un permiso a PERMISSIONS que ninguna ruta exige y no lo declara en RESERVED_PERMISSIONS, entonces el censo falla.

**Pruebas**

- `tests/auth/roles-census.spec.ts` — todo permiso exigido por una ruta existe en el catálogo
- `tests/auth/roles-census.spec.ts` — todo permiso exigido lo concede al menos un rol distinto de owner
- `tests/auth/roles-census.spec.ts` — todo permiso del catálogo o lo exige una ruta o está en RESERVED_PERMISSIONS con motivo no vacío
- `tests/auth/roles-census.spec.ts` — el número de permisos distintos exigidos por las rutas es 23

**Riesgo.** Ampliar permisos es un cambio de superficie de privilegio: revisor pasa a poder anular facturas y aprobar nóminas. Mitigación: es exactamente la brecha que el atlas reporta (hoy todo eso solo lo puede hacer owner con comodín), la asignación se documenta en el doc generado de E2.2-g, y el maker-checker de E2.2-e limita el caso peligroso (aprobar lo que uno mismo creó).

##### `E2.2-d` Permisos efectivos derivados del catálogo, y detección de deriva en el doctor · **M**

Hoy users.permissions es una COPIA congelada que sólo escriben src/cli/init/s2-users.ts:140-149 y src/database/seed.ts:23. Cambiar el catálogo no cambia nada para los usuarios ya creados. Se corrige derivando en el momento de autenticar (recomendación de la decisión 2):

1) En /Users/victor/projects/Accounting/src/auth/roles.ts añadir `export function effectivePermissions(roles: readonly string[], extraGrants: readonly string[] = []): string[]` = unión de permissionsForRoles(roles) con extraGrants, con la misma absorción por comodín. Los extraGrants son la vía de escape para concesiones puntuales fuera de rol.
2) En /Users/victor/projects/Accounting/src/auth/provisioning.ts:85-95, dentro del objeto que devuelve resolveIdentity, sustituir `permissions: normalizeJsonArray(user.permissions)` por `permissions: effectivePermissions(normalizeJsonArray(user.roles), normalizeJsonArray(user.permissions))`. Es el único productor de JwtPayload en el camino vivo (verificado: la otra rama es la HS256 que E2.2-f retira). No abre transacción nueva; se ejecuta con los datos ya leídos.
3) En s2-users.configure(), el INSERT sigue escribiendo `permissions` con `ROLES[role].permissions` — la copia se mantiene como respaldo legible y como base de los extraGrants, pero ya no es la autoridad. Añadir un comentario que lo diga, para que nadie vuelva a tratarla como fuente.
4) Añadir en /Users/victor/projects/Accounting/src/ai/doctor-service.ts la función `export async function checkRoleCatalog(): Promise<CheckResult>`, imitando checkEncryptionKey (líneas 322-348) en forma y tono, y encolarla en runDoctor() junto a las demás comprobaciones que necesitan base (dentro del `if (checks[0].level !== 'fail')`, tras checkEntities). Consulta:
   SELECT u.email, r AS rol FROM users u, jsonb_array_elements_text(u.roles) r WHERE u.is_active AND r <> ALL($1::text[])
   con $1 = ROLE_NAMES. Si hay filas → level 'warn', detail `N usuario(s) con rol fuera del catálogo: admin, controller…`, fix `mnemosine init --section usuarios` (reasignar el rol). Si no hay filas → level 'ok', detail `4 roles · catálogo v${CATALOG_VERSION}`. NO reescribe nada automáticamente: cambiar el rol de una persona es una decisión con consecuencias de auditoría.

**Archivos**

- `/Users/victor/projects/Accounting/src/auth/roles.ts` — modificar: añadir effectivePermissions(roles, extraGrants)
- `/Users/victor/projects/Accounting/src/auth/provisioning.ts` — modificar la línea 90: derivar permissions del catálogo a partir de user.roles, uniendo users.permissions como concesiones extra
- `/Users/victor/projects/Accounting/src/cli/init/s2-users.ts` — modificar: comentario que declara users.permissions como copia y no como autoridad
- `/Users/victor/projects/Accounting/src/ai/doctor-service.ts` — crear checkRoleCatalog() y encolarla en runDoctor()

**Criterios de aceptación**

- Dado un usuario creado antes de este paquete con roles ['contador'] y permissions sin payroll:read, cuando se autentica por OIDC, entonces req.user.permissions incluye payroll:read sin haber tocado su fila.
- Dado un usuario con roles ['owner'] y permissions ['*'], cuando se autentica, entonces req.user.permissions es exactamente ['*'].
- Dado un usuario con roles ['contador'] y permissions ['audit:read'] (concesión puntual), cuando se autentica, entonces sus permisos son los del rol MÁS audit:read.
- Dado un tenant con un usuario cuyo rol es 'admin', cuando corre `mnemosine doctor`, entonces aparece un check 'Role catalog' en nivel warn nombrando ese email; dado que se corrige su rol, entonces el check pasa a ok.

**Pruebas**

- `tests/auth/roles.spec.ts` — effectivePermissions: unión con extras, absorción por comodín en cualquiera de los dos lados, sin duplicados
- `tests/auth/provisioning.spec.ts` — resolveIdentity devuelve los permisos del catálogo para el rol almacenado, no la copia congelada de users.permissions
- `tests/ai/doctor-service.spec.ts` — checkRoleCatalog: warn cuando hay roles fuera del catálogo (con query mockeada), ok cuando no los hay

**Riesgo.** Un usuario cuya fila tenía permisos concedidos a mano por encima de su rol los conserva (van como extraGrants); uno cuyo rol se amplió los gana de golpe. La deriva se hace visible en el doctor antes de sorprender a nadie.

##### `E2.2-e` Segregación de funciones con puntos de invocación reales: preventiva al asignar rol, y maker-checker al aprobar · **L**

Hoy `checkSoDViolations` (src/api/rest/middleware/auth.ts:208 — el atlas la llama checkSegregationOfDuties; el nombre real en el código es ese) no la invoca nadie y su primera regla referencia vendors:create y vendors:update, permisos que NINGUNA ruta exige y NINGÚN catálogo concede (verificado: las rutas de vendors usan bills:read y bills:create). Se hacen dos cosas distintas que hoy se confunden en una:

A) SoD ESTÁTICA (conflicto de permisos en una misma persona). Mover SoDRule, SOD_RULES y checkSoDViolations de middleware/auth.ts a src/auth/roles.ts, reescribiendo las reglas sobre permisos que existen y tipando `conflicting_permissions: [Permission[], Permission[]]` para que una regla sobre un permiso inventado no compile:
  · 'Alta de proveedor frente a aprobación de pago': [['bills:create'], ['bills:approve']] — severidad high.
  · 'Captura frente a posteo de asientos': [['journal_entries:create'], ['journal_entries:post']] — severidad medium.
  · 'Cierre frente a reapertura de periodo': [['periods:close'], ['periods:reopen']] — severidad low; queda latente hasta que exista el comando de reapertura.
  · 'Cálculo frente a aprobación de nómina': [['payroll:create'], ['payroll:approve']] — severidad high (nueva; es el conflicto que introduce E2.2-c).
  Invocarla en DOS sitios: (1) src/cli/init/s2-users.ts, en configure(), después de elegir el rol y ANTES de pedir la contraseña: `const v = checkSoDViolations([...ROLES[role].permissions])`; si v.length > 0, imprimir cada regla con su severidad y pedir `await ctx.confirm('  ¿Continuar de todas formas?', false)`; si el usuario dice que no, `ctx.print('  Sección incompleta.'); return;` sin insertar nada. En modo --yes, ctx.confirm devuelve el valor por defecto (false), así que un rol conflictivo NO se crea sin intervención. (2) src/cli/init/s2-users.ts, en verify(): añadir un CheckResult adicional de nivel 'warn' por cada usuario activo cuyos permisos efectivos violen una regla, con detail `email — regla (severidad)` y fix 'mnemosine init --section usuarios'. Como verify() lo comparte doctor, la violación aparece también en `mnemosine doctor` sin más cableado.

B) SoD DINÁMICA (maker-checker: quien aprueba no puede ser quien creó). Añadir en src/auth/roles.ts:
  `export type SoDMode = 'ninguna' | 'advertir' | 'exigir';`
  y en un módulo nuevo /Users/victor/projects/Accounting/src/services/accounting/segregation.ts:
  `export async function assertMakerChecker(input: { tenantId: string; entityId?: string; actorId: string; creatorId: string | null; subject: 'bill' | 'pay_run' | 'journal_entry'; subjectId: string; client?: PoolClient }): Promise<void>`
  Comportamiento: lee el modo con `getPolicy({ tenantId, entityId }, 'segregacion_de_funciones')` (src/services/policy/policy-service.ts:102 — existe y funciona; hoy sin llamadores). Si el modo es 'ninguna', o creatorId es null, o creatorId !== actorId → retorna. Si coinciden: en 'advertir' registra `logger.warn('sod_maker_checker', { subject, subjectId, actorId })` y retorna; en 'exigir' lanza `new ForbiddenError('Segregation of duties: whoever created this document cannot approve it', { subject, subjectId, rule: 'maker_checker' })` (403, mismo formato de error que el resto del perímetro). Si recibe `client`, cualquier lectura auxiliar usa ese cliente para no abrir conexión fuera de la transacción en curso.
  Añadir al catálogo de políticas /Users/victor/projects/Accounting/src/services/policy/pending-catalog.ts una entrada nueva junto a las dos de 'seguridad' (líneas 150-190): key 'segregacion_de_funciones', category 'seguridad', question '¿Puede la misma persona crear y aprobar un documento?', options ninguna/advertir/exigir con etiquetas explicativas, defaultValue 'advertir', defaultRationale 'En un despacho de una sola persona exigirlo bloquearía el trabajo; advertir deja rastro sin detener la operación', priority 20, más whyAsking/whatIDo/ifSkipped en el mismo registro que las demás.
  Invocar en los TRES puntos donde la base ya guarda al creador (verificado: bills.created_by en 002_ap_ar_schema.sql:81, pay_runs.created_by en 008_payroll.sql:190, journal_entries.created_by en 001_core_schema.sql:248):
   · src/api/rest/routes/bills.ts:197 — dentro del withTransaction, después del SELECT/UPDATE que devuelve la fila y ANTES de llamar a postBillEntry, pasando options client y creatorId = fila.created_by. Como se lanza dentro de la transacción, el rollback deja el bill sin aprobar y sin asiento.
   · src/api/rest/routes/payroll.ts:218 (POST /pay-runs/:id/approve) — leer created_by del pay_run e invocar antes de approvePayRun; alternativamente dentro de approvePayRun (src/services/payroll/common/pay-run-service.ts:108), tras el SELECT ... FOR UPDATE de la línea 111, ampliándolo para traer created_by y pasando el client. Preferir esta segunda opción: cubre también a cualquier futuro llamador desde la CLI.
   · src/api/rest/routes/journal-entries.ts:227 (POST /:id/post) — leer created_by del asiento e invocar antes de postJournalEntry. NO meterlo dentro de posting.ts: postJournalEntry lo llaman la CLI, el aprobador de drafts de IA y los flujos AR/AP, donde el mismo usuario crea y postea por diseño; el punto de control es la ruta HTTP, y la política 'exigir' es lo que un despacho activa cuando tiene dos personas.
  Registrar el evento en audit_log NO requiere migración si se usa una acción del CHECK existente (001_core_schema.sql:460 admite create/update/delete/post/void/approve/close/reopen): el rechazo no se audita como fila propia, se observa por el log estructurado y por el 403; la aceptación con override en modo 'advertir' sí se anota como action='approve' con reason='sod_override'.

**Archivos**

- `/Users/victor/projects/Accounting/src/auth/roles.ts` — modificar: mover SoDRule/SOD_RULES/checkSoDViolations desde middleware/auth.ts, reescribir las reglas sobre permisos existentes, tipar con Permission, añadir SoDMode
- `/Users/victor/projects/Accounting/src/api/rest/middleware/auth.ts` — eliminar SoDRule, SOD_RULES y checkSoDViolations (líneas 174-221)
- `/Users/victor/projects/Accounting/src/services/accounting/segregation.ts` — crear: assertMakerChecker con lectura de la política y soporte de options.client
- `/Users/victor/projects/Accounting/src/services/policy/pending-catalog.ts` — modificar: añadir la política 'segregacion_de_funciones' en la sección de seguridad
- `/Users/victor/projects/Accounting/src/cli/init/s2-users.ts` — modificar: configure() confirma antes de crear un rol con conflicto; verify() reporta violaciones de los usuarios activos
- `/Users/victor/projects/Accounting/src/api/rest/routes/bills.ts` — modificar la ruta :id/approve: invocar assertMakerChecker dentro de la transacción, antes de postBillEntry
- `/Users/victor/projects/Accounting/src/services/payroll/common/pay-run-service.ts` — modificar approvePayRun: ampliar el SELECT FOR UPDATE a created_by e invocar assertMakerChecker con el client antes del UPDATE
- `/Users/victor/projects/Accounting/src/api/rest/routes/journal-entries.ts` — modificar la ruta :id/post: leer created_by e invocar assertMakerChecker antes de postJournalEntry

**Criterios de aceptación**

- Dado `grep -rn "checkSoDViolations\|assertMakerChecker" /Users/victor/projects/Accounting/src`, entonces aparecen al menos cuatro llamadores fuera de su propio archivo de definición (hoy aparecen cero).
- Dado que ninguna regla de SOD_RULES menciona vendors:create ni vendors:update, y dado que se intenta añadir una regla con un permiso inexistente, entonces `npx tsc --noEmit` falla.
- Dado un tenant con la política 'segregacion_de_funciones' en 'exigir', cuando el usuario que creó un bill hace POST /v1/bills/:id/approve, entonces recibe 403 con details.rule = 'maker_checker' y el bill sigue en status 'draft' y sin journal_entry_id.
- Dado el mismo caso con la política en 'advertir' (valor por defecto), entonces el bill se aprueba, se contabiliza, y el log contiene una entrada sod_maker_checker con el subjectId.
- Dado un usuario distinto del creador, cuando aprueba en modo 'exigir', entonces la aprobación procede normalmente.
- Dado `mnemosine init --section usuarios --yes` eligiendo un rol con conflicto de severidad high, entonces no se inserta ningún usuario y la salida dice qué regla se violó.

**Pruebas**

- `tests/auth/roles.spec.ts` — checkSoDViolations: contador dispara 'captura frente a posteo' y 'cálculo frente a aprobación'; auditor no dispara ninguna; comodín se evalúa como conflicto máximo
- `tests/accounting/segregation.spec.ts` — assertMakerChecker: 'ninguna' no lanza; 'advertir' registra y no lanza; 'exigir' lanza ForbiddenError sólo cuando actorId === creatorId; creatorId null nunca lanza
- `tests/cli/init/sections.spec.ts` — configure() con rol conflictivo y confirm=false no llama a query() con el INSERT de users

**Riesgo.** Poner el modo por defecto en 'exigir' bloquearía al despacho unipersonal, que es el caso de uso principal del producto CLI-first. Por eso el defecto es 'advertir' y la política es explícita. Segundo riesgo: invocar el maker-checker dentro de posting.ts rompería la CLI y el aprobador de drafts; la especificación lo prohíbe expresamente.

##### `E2.2-f` Rama HS256: retirada por defecto, activación explícita imposible en producción, y arranque que falla · **M**

Verificado: `grep -rn "jwt.sign" src/ tests/ scripts/` devuelve cero resultados — no existe emisor de tokens HS256; el CLI guarda un token OIDC en src/auth/token-store.ts y ni siquiera tiene cliente HTTP que lo envíe. La rama verifyLocal (src/api/rest/middleware/auth.ts:49-55) sólo puede aceptar tokens que fabrique alguien de fuera, y config.jwt.secret cae en 'dev-secret-change-me' (src/config/index.ts:73). Implementar la recomendación de la decisión 3:

1) En /Users/victor/projects/Accounting/src/config/index.ts añadir dentro del bloque `auth`: `localTokens: process.env.AUTH_LOCAL_TOKENS === 'true'`. Mantener `jwt.secret` sin valor por defecto: `secret: process.env.JWT_SECRET || ''` (quitar la cadena 'dev-secret-change-me', que es el defecto peligroso).
2) Crear /Users/victor/projects/Accounting/src/config/assert-auth.ts con `export function assertAuthConfig(cfg = config): void`, que lanza Error (no AppError: esto ocurre antes de que exista petición) cuando:
   · cfg.auth.localTokens === true && cfg.env === 'production' → 'AUTH_LOCAL_TOKENS no puede activarse en producción: los tokens HS256 no tienen emisor y conceden lo que digan.'
   · cfg.auth.localTokens === true && (!cfg.jwt.secret || cfg.jwt.secret.length < 32) → 'AUTH_LOCAL_TOKENS requiere JWT_SECRET de al menos 32 caracteres (openssl rand -hex 32).'
   · !cfg.auth.enabled && !cfg.auth.localTokens → 'No hay forma de autenticar: define AUTH_OIDC_ISSUER y AUTH_OIDC_AUDIENCE, o activa AUTH_LOCAL_TOKENS en desarrollo.'
   Invocarla en /Users/victor/projects/Accounting/src/index.ts, dentro de bootstrap(), como PRIMERA línea, antes de initDatabase(): un arranque mal configurado debe morir antes de abrir el pool y antes de escuchar en el puerto. El proceso sale con código distinto de 0 porque el rechazo de bootstrap() ya no se captura.
3) En src/api/rest/middleware/auth.ts, verifyLocal pasa a: `if (!config.auth.localTokens) throw new UnauthorizedError('This deployment only accepts tokens from the identity provider (OIDC)'); ...` y el resto igual. Con la bandera apagada —el defecto— la rama HS256 está cerrada y el mensaje dice por qué, en vez de un genérico 'Invalid or expired token'.
4) Añadir a /Users/victor/projects/Accounting/src/ai/doctor-service.ts la función `export function checkAuthMode(): CheckResult`, encolada en runDoctor() junto a checkEncryptionKey (no necesita base): 'fail' si AUTH_LOCAL_TOKENS está activo con NODE_ENV=production; 'fail' si JWT_SECRET es literalmente 'dev-secret-change-me'; 'warn' si AUTH_LOCAL_TOKENS está activo fuera de producción (detail: 'tokens locales HS256 activos: sólo para desarrollo'); 'ok' con detail 'OIDC · <issuer>' en el caso normal. Imitar el formato y el tono de checkEncryptionKey (doctor-service.ts:322-348), incluido el campo fix accionable.
5) Actualizar /Users/victor/projects/Accounting/src/ai/docs/identity-access.md, sección 'OIDC sign-in (CLI)': decir que la API sólo acepta tokens del proveedor de identidad y que AUTH_LOCAL_TOKENS es exclusivamente de desarrollo. Es lo que el agente responderá cuando alguien pregunte por qué su token no funciona.

**Archivos**

- `/Users/victor/projects/Accounting/src/config/index.ts` — modificar: añadir auth.localTokens; quitar el valor por defecto 'dev-secret-change-me' de jwt.secret (línea 73)
- `/Users/victor/projects/Accounting/src/config/assert-auth.ts` — crear: assertAuthConfig con las tres condiciones de fallo
- `/Users/victor/projects/Accounting/src/index.ts` — modificar bootstrap(): invocar assertAuthConfig() como primera sentencia, antes de initDatabase()
- `/Users/victor/projects/Accounting/src/api/rest/middleware/auth.ts` — modificar verifyLocal: rechazar con 401 explicativo salvo que auth.localTokens esté activo
- `/Users/victor/projects/Accounting/src/ai/doctor-service.ts` — crear checkAuthMode() y encolarla en runDoctor()
- `/Users/victor/projects/Accounting/src/ai/docs/identity-access.md` — modificar: la API sólo acepta tokens OIDC; AUTH_LOCAL_TOKENS es de desarrollo

**Criterios de aceptación**

- Dado NODE_ENV=production, AUTH_LOCAL_TOKENS=true y cualquier JWT_SECRET, cuando arranca `node dist/index.js`, entonces el proceso sale con código distinto de 0 imprimiendo el motivo, sin abrir el pool de Postgres ni escuchar en el puerto.
- Dado NODE_ENV=production sin AUTH_OIDC_ISSUER ni AUTH_OIDC_AUDIENCE y sin AUTH_LOCAL_TOKENS, cuando arranca, entonces falla diciendo que no hay forma de autenticar.
- Dado el despliegue por defecto (AUTH_LOCAL_TOKENS ausente), cuando llega una petición con un token HS256 firmado con cualquier secreto, entonces la respuesta es 401 con el mensaje que nombra a OIDC, y no 200.
- Dado `grep -rn "dev-secret-change-me" /Users/victor/projects/Accounting/src`, entonces devuelve cero líneas.
- Dado AUTH_LOCAL_TOKENS=true con JWT_SECRET de 20 caracteres, cuando corre `mnemosine doctor`, entonces aparece un check 'Authentication mode' en nivel fail con el fix 'openssl rand -hex 32'.

**Pruebas**

- `tests/config/assert-auth.spec.ts` — assertAuthConfig: las tres condiciones de fallo lanzan con su mensaje; la configuración OIDC válida no lanza; localTokens con secreto de 32+ fuera de producción no lanza
- `tests/api/middleware/authorization.spec.ts` — authenticate con token HS256 y localTokens apagado responde 401 nombrando OIDC
- `tests/ai/doctor-service.spec.ts` — checkAuthMode: fail en producción con tokens locales, fail con el secreto de ejemplo, warn en desarrollo, ok con OIDC

**Riesgo.** Si algún entorno de desarrollo dependía tácitamente del secreto por defecto, deja de arrancar. Es deseado y el mensaje dice exactamente qué variable definir. Mitigación adicional: `mnemosine init --section infra` ya genera claves (patrón de s0-infra.ts:139-145); puede generar JWT_SECRET del mismo modo si se opta por conservar la rama local.

##### `E2.2-g` Gobierno documental del catálogo: sección generada en identity-access.md con test de sincronía · **S**

El agente responde sobre roles y permisos desde /Users/victor/projects/Accounting/src/ai/docs/identity-access.md, que hoy no enumera ninguno: cualquier respuesta suya sobre 'qué puede hacer un contador' es invención. Replicar el patrón ya implementado para el corpus NIIF (scripts/build-niif-indice.ts + tests/ai/niif-registry.spec.ts:59, 'regenerar no cambia nada'):

1) Crear /Users/victor/projects/Accounting/scripts/build-roles-doc.ts que exporte `export function regenerateRolesSection(docPath?: string): boolean` (devuelve true si el archivo cambió, igual que regenerateIndice) y, ejecutado directamente, reescriba en identity-access.md el bloque delimitado por los marcadores literales `<!-- BEGIN roles (generado: no editar a mano) -->` y `<!-- END roles -->`. El bloque contiene: la versión del catálogo (CATALOG_VERSION), una tabla markdown rol → etiqueta → permisos, la lista de permisos reservados con su motivo, y las reglas de SoD con su severidad. Todo se lee de src/auth/roles.ts: el script no repite ni un literal.
2) Insertar esos marcadores en identity-access.md en una sección nueva '## Roles y permisos', antes de '## Database roles'.
3) Añadir a package.json el script `"docs:roles": "tsx scripts/build-roles-doc.ts"`.
4) Test de sincronía en tests/ai/roles-doc.spec.ts: llama a regenerateRolesSection() y afirma que devuelve false, con el mensaje de fallo 'corre: npm run docs:roles' — misma redacción que niif-registry.spec.ts:61.

**Archivos**

- `/Users/victor/projects/Accounting/scripts/build-roles-doc.ts` — crear: generador del bloque de roles a partir de src/auth/roles.ts, con regenerateRolesSection() exportada
- `/Users/victor/projects/Accounting/src/ai/docs/identity-access.md` — modificar: sección '## Roles y permisos' con los marcadores BEGIN/END roles
- `/Users/victor/projects/Accounting/package.json` — modificar: añadir el script docs:roles
- `/Users/victor/projects/Accounting/tests/ai/roles-doc.spec.ts` — crear: test de sincronía doc↔catálogo

**Criterios de aceptación**

- Dado que se añade un permiso a un rol en src/auth/roles.ts y no se regenera el doc, cuando corre `npx vitest run tests/ai/roles-doc.spec.ts`, entonces falla indicando `npm run docs:roles`.
- Dado que se ejecuta `npm run docs:roles`, cuando se vuelve a ejecutar inmediatamente, entonces el archivo no cambia (idempotencia) y el test pasa.
- Dado el doc regenerado, cuando se busca 'payroll:approve' en identity-access.md, entonces aparece bajo el rol que lo concede y bajo la regla de SoD que lo menciona.

**Pruebas**

- `tests/ai/roles-doc.spec.ts` — identity-access.md está en sincronía con el catálogo (regenerar no cambia nada)
- `tests/ai/roles-doc.spec.ts` — el bloque generado contiene los 4 roles, los 23 permisos exigidos y las 4 reglas de SoD

#### Cómo se sabe que cerró

- `grep -rn "export const ROLES" /Users/victor/projects/Accounting/src` devuelve exactamente una línea (src/auth/roles.ts). Hoy devuelve dos.
- `grep -rn "checkSoDViolations\|assertMakerChecker" /Users/victor/projects/Accounting/src` devuelve al menos cuatro llamadores fuera del archivo de definición. Hoy: cero.
- `grep -rn "dev-secret-change-me" /Users/victor/projects/Accounting/src` devuelve cero líneas.
- `npx vitest run tests/auth/ tests/api/middleware/ tests/ai/roles-doc.spec.ts tests/accounting/segregation.spec.ts tests/config/assert-auth.spec.ts` en verde, y `npx tsc --noEmit` en 0.
- Demostración de la barrera de tipos: introducir `requirePermission('payrol:read')` en cualquier ruta hace fallar `npx tsc --noEmit`; revertirlo lo devuelve a 0.
- El test-censo afirma 23 permisos distintos exigidos por src/api/rest/routes/, todos presentes en PERMISSIONS y todos concedidos por al menos un rol distinto de owner.
- Contra una base de prueba: `SELECT count(*) FROM users u, jsonb_array_elements_text(u.roles) r WHERE u.is_active AND r NOT IN ('owner','contador','revisor','auditor')` devuelve 0, o el doctor lo reporta en nivel warn nombrando los emails.
- Prueba de humo del cierre de la brecha de nómina: un usuario con rol contador recibe 200 en GET /v1/payroll/employees (hoy 403 con missing ['payroll:read']).
- `NODE_ENV=production AUTH_LOCAL_TOKENS=true node dist/index.js` sale con código distinto de 0 sin abrir el pool ni escuchar en el puerto.
- `mnemosine doctor` muestra los dos checks nuevos, 'Role catalog' y 'Authentication mode', ambos en ok en una instalación bien configurada.


## E3 · Fiscal real

### E3.1 · Timbrado fiscal real: cerrojo antisimulación, sellado con CSD propio, timbrado idempotente y cancelación encadenada al void
**Objetivo.** Que ningún folio fiscal inventado pueda volver a escribirse en la base como si fuera real, y que a partir de ahí exista un camino verdadero: armar el CFDI 4.0 desde la factura, sellarlo con el CSD custodiado en la bóveda, timbrarlo contra un PAC real de forma idempotente, persistir el XML timbrado y encadenar la cancelación ante el SAT con la reversa contable, incluido el CFDI de nómina 1.2.

**Por qué aquí.** Es el único hallazgo de la auditoría donde el sistema no está incompleto sino que miente activamente: `POST /v1/invoices/:id/cfdi/stamp` escribe hoy `cfdi_uuid` fabricado con `crypto.randomBytes` y `cfdi_status='stamped'` sin ningún gate por entorno (finkok-adapter.ts:74-102, sw-sapien-adapter.ts:64-92, edicom-adapter.ts:51-78; el único `environment === 'sandbox'` del directorio está en `healthCheck`, finkok-adapter.ts:44). Un dato falso marcado como fiscal es peor que una función ausente, y contamina la base de forma que después no se distingue. El cerrojo (tarea -a) es de horas y detiene el daño hoy; lo demás sólo puede construirse encima de él. Va después de la etapa de perímetro/esquema porque el timbrado escribe en facturas y nóminas cuyo aislamiento y cuyas consultas rotas se arreglan antes, y antes del descargador masivo del SAT porque comparte la custodia de credenciales que aquí se extiende al CSD.

**Depende de:** `E1.1`, `E1.2` · **Migraciones:** `043-046` · **9 tareas · 6.9 sem-persona**

**Precondiciones:**

- Un CSD de pruebas del SAT (par .cer/.key con su contraseña) para el entorno de desarrollo. El repo ya tiene tests/fixtures/certs/csd.cer y csd.key generados con openssl y PBE-SHA1-3DES, que sirven para los tests unitarios de sellado; para el E2E contra el PAC de pruebas hace falta el CSD de demo que publica el propio PAC.
- Credenciales de sandbox de un PAC real (usuario y contraseña de Finkok demo, o el token de SW Sapien de pruebas). Sin esto la tarea E3.1-e sólo puede cerrarse contra un doble del cliente SOAP.
- Al menos un CFDI 4.0 timbrado por un tercero, guardado como tests/fixtures/cfdi/timbrado-real.xml, para poder demostrar que la cadena original que calculamos reproduce un sello ajeno verificable. Sin esa pieza el sellado sólo se puede probar contra sí mismo.
- La desalineación `entities` vs `legal_entities` del subsistema de nómina se corrige dentro de este paquete para cfdi-nomina-generator.ts:65 (es un bloqueo duro de la entrega -e); los otros seis archivos que la sufren pertenecen al paquete de contrato SQL↔migraciones.

#### Decisiones a resolver

**¿El sellado se hace con nuestro CSD custodiado en la bóveda, o se delega al PAC subiéndole el CSD?**

Varios PAC ofrecen sellar por ti si les entregas el CSD (Finkok tiene sign_stamp, SW tiene emisión con CSD almacenado). Delegar elimina toda la tarea E3.1-c —la cadena original es la parte más delicada del paquete— pero contradice la tesis de custodia que el repositorio ya construyó para la e.firma: el material sale de nuestra bóveda y pasa a un tercero, y el CFDI queda sellado por quien nosotros no auditamos.

- Sellado local con CSD en la bóveda: implementar cadena original y firma RSA-SHA256 (tareas E3.1-b y E3.1-c completas).
- Delegar el sellado al PAC subiendo el CSD a su portal: se elimina E3.1-c y se simplifica E3.1-b a no custodiar el CSD.
- Híbrido: sellado local por omisión, con la delegación como opción de configuración por tenant para quien ya tenga su CSD en el PAC.

_Recomendación:_ Sellado local. El sistema ya sabe custodiar material del SAT, ya tiene bóveda, bitácora de accesos y límite diario, y el CSD es una credencial menos peligrosa que la e.firma que ya guarda. Delegar rompería la promesa que el texto de consentimiento ya le hace al usuario y dejaría el sello fuera de nuestra cadena de auditoría. La cadena original es cara una vez y gratis después, y el fixture de un CFDI ajeno la vuelve demostrable.

_Bloquea:_ E3.1-b y E3.1-c completas; el resto del paquete puede avanzar en paralelo.

**¿Se conservan los adaptadores simulados detrás del cerrojo, o se eliminan?**

El cerrojo de E3.1-a deja la simulación apagada por omisión y marcada en la fila. Aun así, un modo simulado que existe puede encenderse por error en un entorno equivocado, y la marca sólo sirve si alguien la mira. Eliminarlo obliga a que las pruebas y las demos usen el sandbox real del PAC o un doble en los tests.

- Conservar la simulación tras el triple cerrojo (NODE_ENV, environment sandbox, bandera explícita) más la columna cfdi_simulated y el check de doctor.
- Eliminar por completo el código simulado de los adaptadores: sin bandera, sin columna; los tests usan dobles y el desarrollo usa el sandbox del PAC.
- Conservarla pero moviéndola a un adaptador aparte llamado 'mock' que sólo se registra cuando la bandera está activa, para que ningún adaptador con nombre de proveedor real pueda simular jamás.

_Recomendación:_ La tercera. Es la que hace imposible el escenario que provocó el hallazgo: si el simulador se llama 'mock' y sólo se registra bajo bandera, ningún tenant puede tener 'finkok' como primario y recibir un folio inventado, ni por error de configuración ni por un despliegue con NODE_ENV mal puesto. Mantiene la columna cfdi_simulated como red de seguridad para los datos ya escritos.

_Bloquea:_ Cierra el diseño de E3.1-a y E3.1-i.

**Cuando la cancelación queda 'En proceso' (comprobante cancelable con aceptación del receptor), ¿se anula el asiento contable de inmediato o se espera al acuse definitivo?**

El SAT da hasta 72 horas al receptor para aceptar o rechazar. Durante esa ventana el CFDI sigue vigente. Si anulamos en libros de inmediato y el receptor rechaza, tenemos una factura viva ante el SAT y reversada en contabilidad: exactamente la divergencia que este paquete existe para eliminar. Si esperamos, el usuario ve una cancelación que 'no hizo nada' y puede reintentarla.

- Esperar siempre: cfdi_stamps queda en 'cancel_pending' y la reversa contable se dispara cuando la consulta del estatus ante el SAT confirme la cancelación.
- Anular en libros de inmediato y revertir la reversa si el receptor rechaza (una segunda reversa, nunca una edición).
- Esperar por omisión y permitir forzar la anulación contable con una bandera explícita que quede registrada en el asiento y en la bitácora.

_Recomendación:_ La tercera. La espera es lo correcto contablemente, pero hay cierres de mes que no pueden quedarse esperando 72 horas; una bandera explícita, auditada, deja la decisión en manos de quien firma los estados financieros en vez de imponerla desde el código. Nota de dependencia: la resolución automática del 'cancel_pending' necesita la consulta real del estatus ante el SAT, que pertenece a otro paquete; mientras tanto la resolución es manual.

_Bloquea:_ La fase 3 de E3.1-g.

**¿Dónde vive el XML timbrado: en Postgres o en un almacén de objetos?**

El SAT exige conservar el XML cinco años. La columna invoices.cfdi_xml_url y paychecks.cfdi_xml_path sugieren un almacén externo, pero el único adaptador de almacenamiento del repo (s3-adapter.ts) también es un simulador: su upload() no llama a ningún SDK, calcula un etag con md5 y devuelve una URL que no apunta a nada. Un CFDI pesa entre 5 y 15 KB.

- Guardar el XML en cfdi_stamps.xml_timbrado (TEXT) y hacer que cfdi_xml_url apunte a un endpoint propio que lo sirve desde la base. Precedente: xml_documents.xml_content ya guarda CFDI completos en TEXT.
- Implementar de verdad el adaptador S3 en este paquete y subir ahí el XML.
- Ambos: base como fuente de verdad y copia en el almacén cuando exista.

_Recomendación:_ La primera. Es la única que no arrastra a este paquete la implementación de otro simulador, mantiene el XML dentro del perímetro de RLS y de los respaldos de la base, y sigue el precedente que el propio repositorio estableció con xml_documents. El almacén de objetos puede añadirse después sin migrar nada, porque la fuente de verdad ya está donde debe.

_Bloquea:_ El DDL de cfdi_stamps en E3.1-f.

**¿Se implementa ahora el motor de exenciones del artículo 93 de la LISR, o se capturan los importes exentos como dato de entrada?**

Hoy todo se timbra con ImporteExento 0.00, lo que sobredeclara el gravado del trabajador. Calcularlo bien exige reglas por concepto (aguinaldo, prima vacacional, PTU, prima dominical, horas extra, previsión social) con topes en UMA y algunas que dependen del salario mínimo de la zona. Capturarlo a mano traslada al usuario un cálculo que se equivoca fácil.

- Motor de exenciones para los conceptos del catálogo actual de earning_type, con cualquier concepto desconocido íntegramente gravado.
- Columnas capturables por el usuario, con el CFDI limitándose a reflejar lo que se capturó.
- Motor con posibilidad de sobreescritura manual por línea, auditada.

_Recomendación:_ La primera, con el CHECK de cuadre en base que impide que gravado más exento difiera del importe. El catálogo de earning_type del repositorio es corto y las reglas de esos conceptos son estables; dejarlo en manos del usuario reproduce el problema en otra capa. La sobreescritura manual puede añadirse después sin cambiar el esquema, porque las columnas ya existirán.

_Bloquea:_ E3.1-h.

**¿El UUID fiscal debe quedar registrado en el asiento contable, o basta el enlace a través de la factura?**

Hoy la única traza del UUID está en invoices.cfdi_uuid. Un auditor que parta del mayor llega al asiento, del asiento a la factura por source_type/source_id y de ahí al UUID: son dos saltos. journal_entries tiene una columna `reference VARCHAR(255)` que hoy lleva el invoice_number.

- No tocar el asiento: el enlace por source_type/source_id es suficiente y evita escribir en un asiento ya posteado.
- Escribir el UUID en journal_entries.notes al timbrar, como línea añadida con fecha y usuario.
- Añadir una columna cfdi_uuid a journal_entries y llenarla al timbrar.

_Recomendación:_ La primera. Escribir en un asiento posteado, aunque sea en notes, contradice la disciplina de que un asiento no se edita, y el timbrado ocurre después del posteo. La trazabilidad se resuelve mejor con una vista o con el reporte que une journal_entries, invoices y cfdi_stamps, sin tocar el libro.

_Bloquea:_ Un detalle de E3.1-f; no bloquea la implementación.

**¿Con qué PAC se hace la integración real primero y quién consigue las credenciales de su sandbox?**

El paquete especifica Finkok por ser el primario configurado por omisión (pac-router.ts:49) y porque su SOAP está documentado, pero SW Sapien es REST y sería más barato de implementar y de probar. La tarea E3.1-e no puede cerrarse contra el sandbox real sin credenciales de demo, que requieren dar de alta una cuenta.

- Finkok por SOAP, respetando el orden de preferencia por omisión que ya está en el código.
- SW Sapien por REST primero (más simple, sin WSDL) y Finkok después.
- Ambos en este paquete.

_Recomendación:_ Finkok, tal como está especificado: es el primario por omisión en pac_preferences y es el que la configuración de config.pac ya asume (config/index.ts:94). Implementar SW Sapien primero obligaría además a cambiar la preferencia por omisión de todos los tenants. Lo que sí hace falta es que alguien dé de alta la cuenta de demo antes de empezar E3.1-e; sin ella, esa tarea sólo cierra contra dobles.

_Bloquea:_ El cierre de E3.1-e y los dos scripts E2E.

#### Tareas

##### `E3.1-a` Cerrojo de simulación: ningún adaptador simulado puede escribir un folio como real · **M**

Crear `src/services/integrations/mexico/pac/simulation-guard.ts` con:

  export const FLAG_SIMULACION = 'PAC_ALLOW_SIMULATED_STAMP';
  export function simulacionPermitida(environment?: string): boolean
  export function assertSimulacionPermitida(providerId: string, environment?: string): void

`simulacionPermitida` devuelve true SÓLO si se cumplen las tres condiciones a la vez: `config.env !== 'production'`, `environment === 'sandbox'` y `process.env[FLAG_SIMULACION] === 'true'`. `assertSimulacionPermitida` lanza `new AccountingError('PAC_SIMULATED_STAMP_FORBIDDEN', ...)` cuando devuelve false, con un mensaje que nombre el proveedor y enumere las tres condiciones que faltan (nunca un mensaje genérico: quien lo vea en producción tiene que entender de inmediato que el sistema se negó a inventar un folio).

Cambiar el contrato en `src/services/integrations/base/adapter.interface.ts:54-72`: `IPacAdapter.stamp` devuelve además `simulated: boolean`, y `cancel` devuelve además `simulated: boolean`. Añadir también `readonly implemented: boolean` a `IPacAdapter` (true sólo cuando el adaptador tiene transporte real; ver E3.1-e y E3.1-i).

En los TRES adaptadores, la primera instrucción de `stamp()` y de `cancel()` — inmediatamente después de cargar credenciales y antes de generar nada — pasa a ser `assertSimulacionPermitida(this.providerId, (creds as {environment?: string}).environment)` en la rama simulada, y el retorno lleva `simulated: true`. Concretamente: finkok-adapter.ts línea 74 (antes de `this.generateSandboxUuid()`) y línea 118; sw-sapien-adapter.ts línea 64 y línea 105; edicom-adapter.ts línea 51 y línea 85.

`pac-router.ts` propaga `simulated` en el objeto de retorno de `stamp` (línea 153: `return { ...result, provider_used: providerId }` ya lo arrastra, pero hay que declararlo en la firma de la línea 127-135) y en `cancel` (línea 185). Añadir la etiqueta `simulated` a `cfdiStampOutcomes` en `src/api/rest/middleware/metrics.ts:34-38` (`labelNames: ['provider','outcome','simulated']`) y pasarla en las tres llamadas `.inc(...)` del router (líneas 152, 157, 160).

Marca en la fila: el UPDATE que escribe `cfdi_uuid` escribe SIEMPRE `cfdi_simulated` en la misma sentencia (columnas creadas en la migración de E3.1-f). No debe existir ningún camino que escriba uno sin el otro.

Check de diagnóstico: añadir `checkCfdiSimulado(): Promise<CheckResult>` a `src/ai/doctor-service.ts` siguiendo la forma de `checkTenantIsolation` (doctor-service.ts:174), y registrarla en `runDoctor` (línea 40-48). Nivel `error` si `SELECT count(*) FROM invoices WHERE cfdi_simulated` o el equivalente en `paychecks` es > 0, con `fix` explicando que esos folios no existen ante el SAT y hay que re-timbrarlos; nivel `warn` si `process.env.PAC_ALLOW_SIMULATED_STAMP === 'true'`; `ok` en otro caso.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/integrations/mexico/pac/simulation-guard.ts` — crear: FLAG_SIMULACION, simulacionPermitida, assertSimulacionPermitida
- `/Users/victor/projects/Accounting/src/services/integrations/base/adapter.interface.ts` — modificar: IPacAdapter.stamp y .cancel devuelven `simulated: boolean`; añadir `readonly implemented: boolean`
- `/Users/victor/projects/Accounting/src/services/integrations/mexico/pac/finkok-adapter.ts` — modificar: assertSimulacionPermitida al inicio de la rama simulada de stamp() (línea 74) y cancel() (línea 118); devolver simulated:true
- `/Users/victor/projects/Accounting/src/services/integrations/mexico/pac/sw-sapien-adapter.ts` — modificar: mismo cerrojo en stamp() (línea 64) y cancel() (línea 105)
- `/Users/victor/projects/Accounting/src/services/integrations/mexico/pac/edicom-adapter.ts` — modificar: mismo cerrojo en stamp() (línea 51) y cancel() (línea 85)
- `/Users/victor/projects/Accounting/src/services/integrations/mexico/pac/pac-router.ts` — modificar: declarar y propagar `simulated` en stamp y cancel; etiqueta simulated en cfdiStampOutcomes
- `/Users/victor/projects/Accounting/src/api/rest/middleware/metrics.ts` — modificar: labelNames de cfdiStampOutcomes gana 'simulated'
- `/Users/victor/projects/Accounting/src/ai/doctor-service.ts` — modificar: añadir checkCfdiSimulado y registrarla en runDoctor

**Criterios de aceptación**

- Dado NODE_ENV=production, cuando se invoca pacRouter.stamp con un adaptador sin transporte real, entonces lanza PAC_SIMULATED_STAMP_FORBIDDEN y ninguna fila de invoices cambia de cfdi_status.
- Dado NODE_ENV=development, environment='sandbox' y PAC_ALLOW_SIMULATED_STAMP sin definir, cuando se invoca stamp(), entonces lanza PAC_SIMULATED_STAMP_FORBIDDEN (la simulación está apagada por omisión, no encendida por omisión).
- Dado NODE_ENV=development, environment='sandbox' y PAC_ALLOW_SIMULATED_STAMP='true', cuando se timbra una factura, entonces el resultado trae simulated:true y la fila queda con cfdi_simulated = true.
- Dado que existe una factura con cfdi_simulated = true, cuando corre `mnemosine doctor`, entonces aparece un check en nivel error que la cuenta y explica que ese folio no existe ante el SAT.
- `grep -rn "randomBytes\|randomUUID" src/services/integrations/mexico/pac/` no devuelve ninguna línea que no esté precedida en la misma función por assertSimulacionPermitida.

**Pruebas**

- `tests/integrations/pac/simulation-guard.spec.ts` — las tres condiciones por separado: producción, entorno no sandbox y bandera ausente producen cada una PAC_SIMULATED_STAMP_FORBIDDEN; sólo las tres juntas permiten simular
- `tests/integrations/pac/adapters-gate.spec.ts` — para cada uno de los tres adaptadores, stamp() y cancel() lanzan con NODE_ENV=production aunque las credenciales existan y el XML sea válido

**Riesgo.** El cerrojo rompe cualquier flujo de desarrollo o demo que hoy dependa del timbrado simulado, incluidos posibles scripts manuales. Mitigación: la variable PAC_ALLOW_SIMULATED_STAMP documentada en el README y en el mensaje de error, y el check de doctor que la señala como warn para que nadie la deje encendida sin darse cuenta.

##### `E3.1-b` Extender la custodia de credenciales fiscales al CSD · **M**

Hoy `storeCredential` (fiscal-credentials/service.ts:106-111) rechaza incondicionalmente un CSD y el CLI aborta antes (sat-commands.ts:98-103). Sin CSD custodiado no hay sellado posible. El esquema ya lo admite: `fiscal_credentials.credential_type CHECK (credential_type IN ('efirma','csd'))` y el índice parcial `uq_fiscal_credentials_active` es por (entity_id, credential_type), de modo que una entidad puede tener e.firma y CSD activos a la vez. No hace falta migración.

En `src/services/fiscal-credentials/certificate.ts` añadir:
  export function certificadoBase64(cer: Buffer): string   // DER → base64 en una sola línea, sin cabeceras PEM
  export function numeroDeCertificado(info: CertificateInfo): string
`numeroDeCertificado` convierte el serial hexadecimal que entrega node-forge a los 20 dígitos ASCII que exige el atributo NoCertificado del CFDI: `Buffer.from(info.serial, 'hex').toString('latin1')`. Si el resultado no cumple /^[0-9]{20}$/ lanza `CertificateParseError` diciendo que el certificado no parece emitido por el SAT.

En `src/services/fiscal-credentials/service.ts`:
  - `StoreCredentialInput` gana `credentialType?: 'efirma' | 'csd'` (por omisión 'efirma').
  - `storeCredential`: sustituir el rechazo actual por una comprobación cruzada — si `credentialType==='efirma'` e `info.type==='csd'` se conserva el mensaje de hoy; si `credentialType==='csd'` e `info.type==='efirma'` se lanza CredentialError explicando que una e.firma no debe usarse para sellar; si `info.type==='unknown'` se acepta con advertencia. El `SecretContext.kind`, el UPDATE de revocación previa y el INSERT pasan a parametrizar `credential_type` en vez del literal 'efirma' (líneas 149, 164 y 172).
  - `AccessOptions.purpose` amplía la unión a `'sat_auth' | 'validation' | 'healthcheck' | 'export' | 'sellado' | 'cancelacion'` (la columna es VARCHAR(50) sin CHECK, no hace falta migración).
  - `withCredential` gana `opts.credentialType?: 'efirma'|'csd'` (por omisión 'efirma') y lo usa en el WHERE de la línea 213. El mensaje de "no hay credencial activa" debe nombrar el tipo pedido y el comando exacto para cargarlo.
  - Añadir `export function withCsd<T>(entityId, tenantId, opts: Omit<AccessOptions,'credentialType'>, fn)` que delega en withCredential con credentialType:'csd'. Es el único punto por el que el sellado toca el material.
  - `getCredentialStatus` y `revokeCredential` aceptan un tipo opcional; `revokeCredential` sin tipo revoca todas las activas de la entidad y falla si hay más de una y no se especificó cuál (hoy la consulta de la línea 322 asume una sola).
  - Añadir `CONSENT_TEXT_CSD`: mismo formato y tono que CONSENT_TEXT pero describiendo lo que de verdad hace un CSD — sellar y cancelar CFDI a nombre de la entidad, sin poder firmar declaraciones — y el aviso de que quien lo tenga puede emitir facturas a nombre del contribuyente.

En `src/cli/sat-commands.ts`: el subcomando `add` gana `--tipo <efirma|csd>`; si no se pasa, se infiere de `info.type` y se pide confirmación explícita antes de continuar. Sustituir el bloque de las líneas 98-103 por: si el tipo inferido o pedido es 'csd', continuar mostrando `CONSENT_TEXT_CSD`; si el usuario pidió 'efirma' y el certificado es CSD, conservar el aborte actual. La descripción del subárbol `cred` pasa a 'Credenciales fiscales (e.firma y CSD)'.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/fiscal-credentials/certificate.ts` — modificar: añadir certificadoBase64 y numeroDeCertificado
- `/Users/victor/projects/Accounting/src/services/fiscal-credentials/service.ts` — modificar: credentialType parametrizado en storeCredential/withCredential/getCredentialStatus/revokeCredential, purposes 'sellado' y 'cancelacion', helper withCsd, CONSENT_TEXT_CSD
- `/Users/victor/projects/Accounting/src/cli/sat-commands.ts` — modificar: opción --tipo, consentimiento específico de CSD, quitar el aborte incondicional de las líneas 98-103

**Criterios de aceptación**

- Dado el par tests/fixtures/certs/csd.cer + csd.key, cuando se ejecuta `mnemosine sat cred add --tipo csd --cer csd.cer --key csd.key` y se acepta el consentimiento, entonces fiscal_credentials tiene una fila credential_type='csd' status='active' y el material está en la bóveda bajo kind='csd'.
- Dada una entidad con e.firma activa, cuando se registra además un CSD, entonces ambas filas quedan activas (el índice parcial uq_fiscal_credentials_active no se viola).
- Dado un CSD activo, cuando `withCsd` ejecuta una función con purpose:'sellado', entonces fiscal_credential_access_log recibe exactamente una fila con purpose='sellado' y outcome='success', y el material queda a cero en memoria al salir.
- Dado que sólo hay e.firma, cuando se llama withCsd, entonces lanza CredentialError nombrando el tipo faltante y el comando `mnemosine sat cred add --tipo csd`.
- Dado numeroDeCertificado sobre un certificado del SAT, entonces devuelve exactamente 20 dígitos; sobre un certificado autofirmado con serial arbitrario lanza CertificateParseError.

**Pruebas**

- `tests/fiscal-credentials/service.spec.ts` — storeCredential con credentialType 'csd' acepta csd.cer y rechaza fiel.cer; withCsd no encuentra la e.firma y viceversa
- `tests/fiscal-credentials/certificate.spec.ts` — numeroDeCertificado y certificadoBase64 sobre los fixtures; el base64 vuelve a parsear a un X.509 idéntico

**Riesgo.** Un usuario podría cargar su e.firma creyendo que sirve para sellar (funcionalmente puede, pero el SAT rechaza el CFDI). La comprobación cruzada por keyUsage lo impide antes de pedir la contraseña.

##### `E3.1-c` Cadena original y sellado del CFDI 4.0 con el CSD · **L**

Crear `src/services/mexico/cfdi-sellado.ts`. Es la pieza que hoy no existe en ninguna forma y sin la cual todo PAC rechaza el comprobante.

  export function construirCadenaOriginal(xml: string): string
  export function sellarCfdi(xml: string, material: EfirmaMaterial): { xml: string; sello: string; noCertificado: string; certificado: string; cadenaOriginal: string }
  export function verificarSello(xml: string): boolean

`construirCadenaOriginal` reproduce la transformación que el SAT publica como cadenaoriginal_4_0.xslt, sin XSLT (Node no trae procesador y no vamos a añadir SaxonJS): se parsea con fast-xml-parser — ya es dependencia — usando `{ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, trimValues: false }` y se recorre el árbol emitiendo los valores de atributo separados por '|', con '||' al inicio y al final. Reglas, todas verificables:
  · El orden NO es el del documento sino el del XSD. Definir en el módulo `const ORDEN_ATRIBUTOS: Record<string,string[]>` con la lista ordenada por nodo (cfdi:Comprobante, cfdi:CfdiRelacionados, cfdi:CfdiRelacionado, cfdi:Emisor, cfdi:Receptor, cfdi:Concepto, cfdi:Traslado, cfdi:Retencion, cfdi:Impuestos, nomina12:Nomina y sus hijos). Recorrer los nodos hijos en el orden que fija el XSD, no en el de aparición.
  · Se INCLUYE NoCertificado. Se EXCLUYEN Sello y Certificado. Se excluyen los atributos de espacio de nombres y xsi:schemaLocation.
  · Un atributo opcional ausente o cuyo valor normalizado quede vacío NO aporta separador: simplemente no se emite.
  · `normalizarValor(v)`: recortar extremos, colapsar toda secuencia de espacios/tabuladores/saltos de línea en un solo espacio, y sustituir cada '|' interior por un espacio.

`sellarCfdi` opera en este orden estricto, porque NoCertificado forma parte de la cadena: (1) escribe en cfdi:Comprobante los atributos `NoCertificado` = numeroDeCertificado(parseCertificate(material.cer)) y `Certificado` = certificadoBase64(material.cer); (2) calcula la cadena original sobre ese XML; (3) firma con `crypto.createSign('RSA-SHA256')` alimentado con la cadena en UTF-8 y `privateKeyToPem(material.key, material.password)` (certificate.ts:131), y toma el resultado en base64; (4) escribe el atributo `Sello`. Devuelve el XML resultante y las piezas intermedias para poder auditar.

`verificarSello` hace el camino inverso con `crypto.createVerify('RSA-SHA256')` y la clave pública del atributo Certificado. Es la herramienta que convierte la corrección de la cadena en algo demostrable.

No introducir dependencias nuevas: crypto y fast-xml-parser bastan.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/mexico/cfdi-sellado.ts` — crear: ORDEN_ATRIBUTOS, normalizarValor, construirCadenaOriginal, sellarCfdi, verificarSello
- `/Users/victor/projects/Accounting/tests/fixtures/cfdi/timbrado-real.xml` — crear: un CFDI 4.0 timbrado por un tercero, con su Sello y su Certificado, como ancla de conformidad

**Criterios de aceptación**

- Dado tests/fixtures/cfdi/timbrado-real.xml, cuando se calcula construirCadenaOriginal sobre él y se verifica su atributo Sello contra su atributo Certificado, entonces verificarSello devuelve true. Es la prueba de que nuestra cadena coincide con la del emisor y no sólo consigo misma.
- Dado un CFDI armado por nosotros y sellado con tests/fixtures/certs/csd.key, cuando se pasa por verificarSello, entonces devuelve true; si se altera un solo carácter de cualquier atributo del comprobante, devuelve false.
- Dada una descripción de concepto que contiene el carácter '|' y saltos de línea, cuando se construye la cadena, entonces el '|' aparece sustituido por un espacio y los saltos colapsados, y el número total de separadores no cambia respecto de la misma descripción sin esos caracteres.
- Dado un comprobante sin atributos opcionales (sin Serie, sin Descuento, sin CfdiRelacionados), cuando se construye la cadena, entonces no aparecen separadores vacíos consecutivos para esos atributos.
- sellarCfdi escribe NoCertificado antes de calcular la cadena: si se invierte el orden en el código, el test de verificación contra el fixture real falla.

**Pruebas**

- `tests/mexico/cfdi-sellado.spec.ts` — verificación contra el CFDI real de terceros; ida y vuelta con el CSD de fixtures; casos de normalización (pipe, espacios, saltos); ausencia de atributos opcionales; detección de manipulación

**Riesgo.** La cadena original es el punto donde fallan casi todas las implementaciones propias, y el error se manifiesta como un rechazo genérico del PAC (código 302, sello mal formado). El anclaje contra un CFDI timbrado por un tercero es lo que separa una implementación correcta de una que sólo se valida a sí misma: sin ese fixture, no dar la tarea por cerrada.

##### `E3.1-d` Armar el CFDI 4.0 de ingreso desde la factura, con los datos fiscales que hoy no existen en el esquema · **M**

La ruta arma hoy cuatro atributos a mano (invoices.ts:397-401) y `generateCfdiXml` (src/services/mexico/cfdi.ts:118) es código muerto y además incorrecto: usa `receptor.domicilio_fiscal` como LugarExpedicion, fija 0.160000 en el bloque de totales, no emite Sello/NoCertificado/Certificado y no contempla Descuento ni retenciones.

Faltan datos en la base. `legal_entities` no tiene régimen fiscal ni código postal; `customers` tampoco tiene régimen ni CP ni uso de CFDI; `invoices` no guarda serie, forma de pago, método de pago ni uso. La migración de E3.1-f los añade.

Crear `src/services/mexico/cfdi-builder.ts`:

  export interface DatosCfdiFactura { invoice; lines; emisor: {rfc,nombre,regimenFiscal,codigoPostal}; receptor: {rfc,nombre,regimenFiscal,codigoPostal,usoCfdi}; }
  export async function cargarDatosCfdiFactura(client: pg.PoolClient, invoiceId: string): Promise<DatosCfdiFactura>
  export function construirCfdiIngreso(datos: DatosCfdiFactura): string

`cargarDatosCfdiFactura` hace un solo SELECT con JOIN a legal_entities, customers e invoice_lines y valida ANTES de armar nada, lanzando AccountingError con código propio por cada dato ausente, para que el usuario sepa exactamente qué capturar: CFDI_FALTA_REGIMEN_EMISOR, CFDI_FALTA_CP_EMISOR, CFDI_FALTA_RFC_RECEPTOR, CFDI_FALTA_REGIMEN_RECEPTOR, CFDI_FALTA_CP_RECEPTOR, CFDI_FALTA_USO, CFDI_FALTA_FORMA_PAGO. Valida también que `legal_entities.tax_id_type = 'rfc'` y que `incorporation_country = 'MX'`, si no CFDI_ENTIDAD_NO_MEXICANA.

`construirCfdiIngreso` emite un cfdi:Comprobante Version=4.0 con: Serie (si existe), Folio = invoice_number, Fecha = fecha de emisión en hora local del CP de expedición sin zona (formato AAAA-MM-DDThh:mm:ss), FormaPago, MetodoPago, Moneda = currency_code, TipoCambio sólo si Moneda != MXN, SubTotal, Descuento (sólo si > 0), Total, TipoDeComprobante='I', Exportacion='01', LugarExpedicion = CP del EMISOR (no del receptor: es el error actual de cfdi.ts:158). Emisor con Rfc/Nombre/RegimenFiscal; Receptor con Rfc/Nombre/DomicilioFiscalReceptor/RegimenFiscalReceptor/UsoCFDI. Un cfdi:Concepto por línea con ClaveProdServ, Cantidad, ClaveUnidad, Descripcion, ValorUnitario, Importe, ObjetoImp y su bloque de Impuestos/Traslados cuando ObjetoImp='02'. Bloque cfdi:Impuestos de totales agregando los traslados por (Impuesto, TipoFactor, TasaOCuota) — nunca con la tasa fija de hoy. Todos los importes con `Decimal` (decimal.js ya es dependencia) y exactamente dos decimales para MXN.

Límite de alcance explícito de la v1: si alguna línea trae retención (ISR o IVA retenido) el builder lanza `CFDI_RETENCIONES_NO_SOPORTADAS`, porque `invoice_lines` no tiene columnas para desglosarlas. Es preferible negarse a emitir un comprobante incompleto.

Retirar de `src/services/mexico/cfdi.ts` la función `generateCfdiXml`; conservar SAT_CATALOGS (que el builder importa para validar FormaPago, UsoCFDI y RegimenFiscal contra el catálogo) y generateDIOT.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/mexico/cfdi-builder.ts` — crear: cargarDatosCfdiFactura y construirCfdiIngreso
- `/Users/victor/projects/Accounting/src/services/mexico/cfdi.ts` — modificar: eliminar generateCfdiXml (sustituida por el builder); conservar SAT_CATALOGS y generateDIOT
- `/Users/victor/projects/Accounting/src/api/rest/routes/invoices.ts` — modificar: el esquema zod de creación/actualización acepta cfdi_serie, cfdi_forma_pago, cfdi_metodo_pago, cfdi_uso; las líneas aceptan cfdi_objeto_imp

**Criterios de aceptación**

- Dada una factura de una entidad mexicana con todos los datos fiscales capturados, cuando se llama construirCfdiIngreso, entonces el XML resultante valida contra el XSD cfdv40 (comprobar en el test con una validación estructural de atributos obligatorios y del catálogo, ya que no hay validador XSD en el proyecto) y su LugarExpedicion es el CP del emisor.
- Dada una factura cuyo cliente no tiene régimen fiscal capturado, cuando se llama cargarDatosCfdiFactura, entonces lanza AccountingError con código CFDI_FALTA_REGIMEN_RECEPTOR y el mensaje nombra al cliente.
- Dada una factura con tres líneas al 16% y una exenta, cuando se arma el CFDI, entonces el bloque cfdi:Impuestos agrupa un solo Traslado por (002, Tasa, 0.160000) cuyo Importe es la suma exacta de los importes de línea, y la línea exenta no aporta traslado.
- Dada una factura en USD, cuando se arma el CFDI, entonces aparece TipoCambio con el exchange_rate de la factura; en MXN el atributo no aparece.
- Dada una factura con una línea con retención, cuando se arma el CFDI, entonces lanza CFDI_RETENCIONES_NO_SOPORTADAS y no se emite ningún XML parcial.

**Pruebas**

- `tests/mexico/cfdi-builder.spec.ts` — armado feliz con dos líneas; agregación de traslados; TipoCambio condicional; los siete errores de dato faltante; rechazo por retenciones

**Riesgo.** Capturar régimen fiscal y CP de cada cliente es trabajo de datos que el usuario aún no ha hecho: el sistema debe fallar con un mensaje que diga exactamente qué campo y de quién, no con un rechazo del PAC tres pasos más adelante.

##### `E3.1-e` Interfaz del PAC real e implementación de Finkok por SOAP, con clasificación de errores del SAT · **L**

Hoy no hay un solo `import ... from 'soap'` en src/ pese a que la dependencia está declarada (package.json:47). Implementar el transporte real en el adaptador primario.

Crear `src/services/integrations/mexico/pac/finkok-errors.ts`:
  export type ClasePacError = 'permanente' | 'transitorio' | 'duplicado';
  export function clasificarErrorPac(codigo: string): ClasePacError;
  export function mensajeErrorPac(codigo: string, mensajeSat?: string): string;
Mapa mínimo: 301 (XML mal formado), 302 (sello mal formado o inválido), 303 (el certificado no corresponde al emisor), 304 (certificado revocado o caduco), 305 (fecha fuera del rango permitido), 306 (el certificado no es un CSD), 401/402 (comprobante duplicado en el PAC), 702 (sin timbres disponibles) → todos `permanente` salvo 702 que también es permanente pero con mensaje accionable; 307 (CFDI previamente timbrado) → `duplicado`; ausencia de respuesta, timeout, HTTP 5xx y fallos de red → `transitorio`. Cualquier código desconocido → `permanente` (negarse antes que reintentar contra tres PAC con el mismo XML inválido).

Reescribir `FinkokAdapter.stamp` (finkok-adapter.ts:66):
  · WSDL por entorno: sandbox `https://demo-facturacion.finkok.com/servicios/soap/stamp.wsdl`, producción `https://facturacion.finkok.com/servicios/soap/stamp.wsdl`; cancelación en `.../cancel.wsdl`; saldo en `.../utilities.wsdl`.
  · Cliente perezoso y memorizado por (providerId, environment): `soap.createClientAsync(wsdl)` con timeout de 20 s; guardarlo en un Map de módulo para no descargar el WSDL en cada timbrado.
  · Llamada: `client.stampAsync({ xml: Buffer.from(xmlSellado,'utf8').toString('base64'), username: creds.username, password: creds.password })`.
  · Respuesta: leer `stampResult` con `xml` (el timbrado), `UUID`, `Fecha`, `CodEstatus`, `SatSeal`, `NoCertificadoSAT` e `Incidencias.Incidencia[]` con `CodigoError`, `MensajeIncidencia` y `ExtraInfo`.
  · Si hay incidencias: clasificar la primera. `duplicado` (307) NO es un fallo — el UUID previo viene en ExtraInfo; recuperar el XML timbrado con `client.stampedAsync({ uuid, taxpayer_id: rfcEmisor, username, password })` y devolverlo como éxito con `simulated:false`. `permanente` → `AccountingError('PAC_REJECTED', mensajeErrorPac(...), { codigo, provider:'finkok', permanente:true })`. `transitorio` → `AccountingError('PAC_UNAVAILABLE', ...)`.
  · Éxito: devolver { uuid, xml_timbrado, cadena_original, fecha_timbrado, no_certificado_sat, sello_sat, simulated:false } y `integrationRegistry.recordSuccess`. En fallo, `recordFailure`. La rama simulada actual sólo se ejecuta si `simulacionPermitida(creds.environment)`; en caso contrario ni siquiera se construye.
  · `implemented = true`.

Reescribir `FinkokAdapter.cancel` (línea 109) contra `cancel.wsdl`, operación `cancelAsync({ UUIDS: { uuid: [{ UUID, Motivo, FolioSustitucion }] }, username, password, taxpayer_id: rfcEmisor, cer, key, store_pending: false })`, donde `cer` y `key` van en base64 y provienen del CSD (los pasa el llamador en `params`, ver E3.1-g; el adaptador NUNCA lee la bóveda por su cuenta). Devolver `{ status, acuse_xml, estatus_uuid, simulated:false }` mapeando EstatusUUID: 201 cancelado, 202 previamente cancelado (idempotente, éxito), 203/204 error, y el estado "En proceso" cuando la cancelación requiere aceptación del receptor.

`getRemainingStamps` pasa a llamar `ObtenerSaldo`/`get_credit` en utilities.wsdl y `healthCheck` a la misma operación, en vez de devolver un número fijo.

En `pac-router.stamp` (línea 142-171): NO hacer failover cuando el error es `permanente` — hoy el bucle reintenta con los tres PAC y abre tres circuitos por un XML que ninguno va a aceptar. Sólo se pasa al siguiente candidato con errores transitorios o circuito abierto. Añadir además el filtro `adapter.implemented` en `selectPac` y en el bucle de `stamp`, para que un adaptador sin transporte no entre en el failover.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/integrations/mexico/pac/finkok-errors.ts` — crear: clasificarErrorPac y mensajeErrorPac
- `/Users/victor/projects/Accounting/src/services/integrations/mexico/pac/finkok-adapter.ts` — modificar: stamp/cancel/getRemainingStamps/healthCheck por SOAP real; cliente memorizado; rama simulada tras simulacionPermitida; implemented=true
- `/Users/victor/projects/Accounting/src/services/integrations/mexico/pac/pac-router.ts` — modificar: no hacer failover ante errores permanentes; excluir adaptadores con implemented=false

**Criterios de aceptación**

- `grep -rn "from 'soap'" src/` devuelve al menos finkok-adapter.ts.
- Dado un doble del cliente SOAP que responde con Incidencia CodigoError='302', cuando se timbra, entonces pacRouter lanza PAC_REJECTED, NO intenta con sw_sapien ni edicom, y el circuito de finkok no se abre por un rechazo de contenido.
- Dado un doble que responde con Incidencia '307' y el UUID previo en ExtraInfo, cuando se timbra, entonces el adaptador devuelve ese mismo UUID como éxito y no genera uno nuevo.
- Dado un doble que lanza ETIMEDOUT, cuando auto_failover está activo, entonces se intenta con el siguiente PAC configurado y la métrica registra outcome='failure' para finkok y 'fallback' para el que resuelva.
- Dado el sandbox real de Finkok con credenciales de demo y un CFDI sellado con el CSD de pruebas, cuando se ejecuta el script E2E, entonces devuelve un UUID que verifica contra el SelloSAT y `simulated` es false.

**Pruebas**

- `tests/integrations/pac/finkok-adapter.spec.ts` — con soap mockeado: éxito, incidencia 302 permanente, incidencia 307 duplicada que recupera el UUID previo, timeout transitorio; el cliente SOAP se crea una sola vez para dos timbrados seguidos
- `tests/integrations/pac/pac-router.spec.ts` — un error permanente no dispara failover; uno transitorio sí; un adaptador con implemented=false nunca es candidato

**Riesgo.** El WSDL se descarga en el primer uso: si el arranque es en frío durante un pico, el primer timbrado paga varios segundos. Mitigación: cliente memorizado por entorno y timeout explícito. Segundo riesgo: los nombres exactos de los campos de respuesta de Finkok deben confirmarse contra el WSDL vigente en el momento de implementar; el test contra el sandbox real es el que cierra esa incertidumbre, no el doble.

##### `E3.1-f` Servicio de timbrado idempotente, persistencia del XML y reescritura de la ruta REST · **M**

Hoy `POST /v1/invoices/:id/cfdi/stamp` (invoices.ts:390-427) lee la factura sin filtrar por entidad, arma XML falso, llama al router y hace un UPDATE que sobreescribe cualquier UUID previo. Sustituirlo por un servicio con estado propio.

Migración `031_cfdi_stamping.sql` (siguiente número libre; la más alta hoy es 030_webhook_token_rls.sql):
  · Datos fiscales que faltan: `ALTER TABLE legal_entities ADD COLUMN regimen_fiscal_sat VARCHAR(3), ADD COLUMN codigo_postal_fiscal VARCHAR(5), ADD COLUMN imss_registro_patronal VARCHAR(20);` · `ALTER TABLE customers ADD COLUMN regimen_fiscal_sat VARCHAR(3), ADD COLUMN codigo_postal_fiscal VARCHAR(5), ADD COLUMN uso_cfdi_default VARCHAR(5);` · `ALTER TABLE invoices ADD COLUMN cfdi_serie VARCHAR(25), ADD COLUMN cfdi_forma_pago VARCHAR(2), ADD COLUMN cfdi_metodo_pago VARCHAR(3), ADD COLUMN cfdi_uso VARCHAR(5), ADD COLUMN cfdi_simulated BOOLEAN NOT NULL DEFAULT false;` · `ALTER TABLE invoice_lines ADD COLUMN cfdi_objeto_imp VARCHAR(2) NOT NULL DEFAULT '02';` · `ALTER TABLE paychecks ADD COLUMN cfdi_simulated BOOLEAN NOT NULL DEFAULT false;`
  · Tabla de timbres:
    CREATE TABLE cfdi_stamps (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID NOT NULL, entity_id UUID NOT NULL REFERENCES legal_entities(id), document_type VARCHAR(20) NOT NULL CHECK (document_type IN ('invoice','paycheck')), document_id UUID NOT NULL, tipo_comprobante CHAR(1) NOT NULL CHECK (tipo_comprobante IN ('I','E','T','N','P')), status VARCHAR(20) NOT NULL DEFAULT 'in_flight' CHECK (status IN ('in_flight','stamped','failed','cancel_requested','cancel_pending','cancelled')), uuid VARCHAR(36), no_certificado VARCHAR(20), no_certificado_sat VARCHAR(20), sello_cfd TEXT, sello_sat TEXT, cadena_original TEXT, fecha_timbrado TIMESTAMPTZ, xml_sellado TEXT NOT NULL, xml_timbrado TEXT, xml_hash VARCHAR(64) NOT NULL, pac_provider VARCHAR(50), is_simulated BOOLEAN NOT NULL DEFAULT false, cancel_reason VARCHAR(2) CHECK (cancel_reason IN ('01','02','03','04')), cancel_replacement_uuid VARCHAR(36), cancel_acuse_xml TEXT, cancel_estatus VARCHAR(40), cancelled_at TIMESTAMPTZ, pac_error_code VARCHAR(20), pac_error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by UUID NOT NULL, CHECK (status <> 'stamped' OR (uuid IS NOT NULL AND xml_timbrado IS NOT NULL)));
    CREATE UNIQUE INDEX uq_cfdi_stamps_document_vivo ON cfdi_stamps(document_type, document_id) WHERE status <> 'failed';
    CREATE UNIQUE INDEX uq_cfdi_stamps_uuid ON cfdi_stamps(uuid) WHERE uuid IS NOT NULL;
    CREATE INDEX idx_cfdi_stamps_entity_status ON cfdi_stamps(entity_id, status);
  La tabla lleva tenant_id, así que `npm run migrate` le aplica sola la política `tenant_isolation` al reejecutar src/database/rls-policies.sql; no hay que escribir política a mano.

Crear `src/services/mexico/cfdi-stamping-service.ts`:
  export interface ResultadoTimbre { uuid: string; provider: string; simulated: boolean; fechaTimbrado: Date; yaEstabaTimbrado: boolean; }
  export async function timbrarFactura(invoiceId: string, ctx: { tenantId: string; userId: string; requestId?: string }): Promise<ResultadoTimbre>

Orden de operaciones — la llamada al PAC es irreversible y por tanto NO puede correr dentro de una transacción abierta:
  Fase 1 (transacción): `SELECT ... FROM invoices WHERE id=$1 FOR UPDATE`, comprobar que existe, que `entity_id` pertenece al tenant, que `status <> 'void'` y que `journal_entry_id IS NOT NULL` (una factura que no está en libros no se timbra: CFDI_FACTURA_NO_CONTABILIZADA). Si ya hay una fila de cfdi_stamps con status='stamped' para ese documento → devolver `{ ...datos, yaEstabaTimbrado: true }` sin llamar al PAC. Si hay una 'in_flight' con menos de 15 minutos → lanzar `CFDI_TIMBRADO_EN_CURSO`. Si la hay con más de 15 minutos → marcarla 'failed' y continuar (el recobro por 307 del adaptador cubre el caso de que el PAC sí la hubiera timbrado). Armar el XML con `cargarDatosCfdiFactura` + `construirCfdiIngreso`, sellarlo dentro de `withCsd(entityId, tenantId, { purpose:'sellado', actor: userId, unattended:false, requestId }, ...)`, calcular `xml_hash = sha256(xmlSellado)` e INSERTar la fila 'in_flight' con el XML sellado. Commit.
  Fase 2 (fuera de transacción): `pacRouter.stamp(xmlSellado, { tenantId, userId, requestId })`.
  Fase 3 (transacción): UPDATE cfdi_stamps SET status='stamped', uuid, sello_sat, no_certificado_sat, cadena_original, fecha_timbrado, xml_timbrado, pac_provider, is_simulated WHERE id=$1; y `UPDATE invoices SET cfdi_uuid=$1, cfdi_status='stamped', pac_provider=$2, stamped_at=$3, cfdi_simulated=$4, cfdi_xml_url=$5 WHERE id=$6 AND cfdi_uuid IS NULL` — la guarda `AND cfdi_uuid IS NULL` es la que impide para siempre el sobreescrito de hoy; si afecta 0 filas, ROLLBACK y lanzar `CFDI_ALREADY_STAMPED`. Commit.
  En fallo del PAC: UPDATE cfdi_stamps SET status='failed', pac_error_code, pac_error_message, attempts = attempts + 1, y propagar el error. La factura NO cambia de estado.

El timbrado no crea ni modifica asientos: el asiento de la factura ya existe por `postInvoiceEntry`. La relación es de precondición (hay que estar contabilizado para timbrar) y de trazabilidad (ver decisión sobre estampar el UUID en el asiento).

Reescribir la ruta `POST /v1/invoices/:id/cfdi/stamp` para que sólo llame a `timbrarFactura` y devuelva `{ cfdi_uuid, cfdi_status, provider_used, simulated, fecha_timbrado, already_stamped }`. Responder 200 cuando `yaEstabaTimbrado` y 201 cuando se timbró.

**Archivos**

- `/Users/victor/projects/Accounting/src/database/migrations/031_cfdi_stamping.sql` — crear: columnas fiscales en legal_entities/customers/invoices/invoice_lines/paychecks y tabla cfdi_stamps con sus índices
- `/Users/victor/projects/Accounting/src/services/mexico/cfdi-stamping-service.ts` — crear: timbrarFactura con las tres fases y la guarda de idempotencia
- `/Users/victor/projects/Accounting/src/api/rest/routes/invoices.ts` — modificar: la ruta /:id/cfdi/stamp (líneas 389-427) delega en timbrarFactura; se elimina el XML falso y el UPDATE sin guarda

**Migración**

```sql
031_cfdi_stamping.sql — ver la especificación para el DDL completo. Tras aplicarla, `npm run migrate` reaplica src/database/rls-policies.sql y cfdi_stamps queda con política tenant_isolation por llevar tenant_id NOT NULL.
```

**Criterios de aceptación**

- Dada una factura contabilizada y sin timbrar, cuando se llama dos veces seguidas a timbrarFactura, entonces el PAC se invoca una sola vez, el segundo retorno trae yaEstabaTimbrado:true con el mismo UUID, y cfdi_stamps tiene exactamente una fila con status='stamped'.
- Dada una factura ya timbrada, cuando se fuerza un UPDATE del servicio, entonces la guarda `AND cfdi_uuid IS NULL` deja 0 filas afectadas y se lanza CFDI_ALREADY_STAMPED sin tocar la base.
- Dada una factura sin journal_entry_id, cuando se intenta timbrar, entonces lanza CFDI_FACTURA_NO_CONTABILIZADA y no se llama al PAC.
- Dado que el PAC falla con PAC_REJECTED, cuando termina timbrarFactura, entonces cfdi_stamps queda en 'failed' con pac_error_code y la factura conserva cfdi_status NULL o el valor previo.
- Dada una factura timbrada, entonces cfdi_stamps.xml_timbrado contiene el TimbreFiscalDigital con el UUID e invoices.cfdi_xml_url apunta al recurso desde el que se recupera; `SELECT count(*) FROM invoices WHERE cfdi_uuid IS NOT NULL AND cfdi_xml_url IS NULL` devuelve 0.
- Dos peticiones concurrentes de timbrado sobre la misma factura: una gana, la otra recibe CFDI_TIMBRADO_EN_CURSO o CFDI_ALREADY_STAMPED; nunca se emiten dos UUID (garantizado por el FOR UPDATE y por uq_cfdi_stamps_document_vivo).

**Pruebas**

- `tests/mexico/cfdi-stamping-service.spec.ts` — idempotencia con doble llamada; rechazo de factura no contabilizada; fallo del PAC que no ensucia la factura; guarda cfdi_uuid IS NULL
- `scripts/e2e-cfdi.ts` — E2E con base real: sembrar entidad MX con datos fiscales y CSD, crear y contabilizar factura, timbrar, verificar UUID y XML persistido, re-timbrar y comprobar que devuelve el mismo UUID

**Riesgo.** La ventana entre la fase 2 y la fase 3 es el punto de pérdida: si el proceso muere después de que el PAC timbró y antes del commit, la fila queda 'in_flight'. El recobro está cubierto por el código 307 del adaptador (E3.1-e), que devuelve el UUID ya emitido en el siguiente intento; por eso la caducidad de 15 minutos marca 'failed' y permite reintentar en vez de bloquear.

##### `E3.1-g` Cancelación fiscal encadenada al void contable · **M**

Hoy son dos caminos independientes que pueden divergir: `POST /:id/void` (invoices.ts:358) revierte el asiento y deja el CFDI vivo ante el SAT; `POST /:id/cfdi/cancel` (invoices.ts:430) tiene un `// TODO: Send cancellation request to PAC provider` y sólo escribe `cfdi_status='cancelled'` y una nota en `memo`. Una factura puede quedar anulada en libros con su comprobante vigente, que es exactamente el riesgo fiscal que el paquete debe cerrar.

En `src/services/mexico/cfdi-stamping-service.ts` añadir:
  export async function cancelarCfdiFactura(invoiceId: string, params: { motivo: '01'|'02'|'03'|'04'; sustitucionUuid?: string; anularEnLibros: boolean }, ctx: { tenantId; userId; requestId? }): Promise<{ estatus: string; acuseXml: string; reversalId: string | null }>

Orden, otra vez en tres fases porque la llamada al SAT es irreversible:
  Fase 1 (transacción): SELECT de la factura y de su cfdi_stamps FOR UPDATE. Validar: existe timbre en status 'stamped' (si no, CFDI_NO_TIMBRADO); motivo en el catálogo; si motivo='01' entonces sustitucionUuid obligatorio (ValidationError, como hoy en la línea 456); la factura no está ya en 'void'. Marcar cfdi_stamps.status='cancel_requested' con cancel_reason y cancel_replacement_uuid. Commit.
  Fase 2 (fuera de transacción): abrir `withCsd(entityId, tenantId, { purpose:'cancelacion', actor:userId, unattended:false, requestId }, async (material) => pacRouter.cancel(stamp.pac_provider, { uuid, rfcEmisor, reason: motivo, replacementUuid, cerBase64, keyBase64, password }, adapterCtx))`. El material del CSD lo aporta el llamador; el adaptador no toca la bóveda.
  Fase 3 (transacción): según el EstatusUUID del acuse —
    · 201 (cancelado) o 202 (previamente cancelado): cfdi_stamps.status='cancelled', cancel_acuse_xml, cancel_estatus, cancelled_at=NOW(); `UPDATE invoices SET cfdi_status='cancelled'`; y si `anularEnLibros` es true y la factura tiene journal_entry_id, llamar `voidJournalEntryInTx(client, invoice.journal_entry_id, userId, 'CFDI ' + uuid + ' cancelado ante el SAT, motivo ' + motivo)` y `UPDATE invoices SET status='void'`. Guardar el id de la reversa para disparar `attestEntryAsync(tenantId, entityId, reversal.id)` DESPUÉS del commit, como hace la ruta actual en la línea 380. La corrección es por reversa, nunca por edición (NIF B-1).
    · "En proceso" (cancelación que requiere aceptación del receptor): cfdi_stamps.status='cancel_pending', cancel_estatus con el texto del acuse, y NO se anula en libros; devolver el estado al llamador. La resolución de esos casos se cierra cuando la consulta real del estatus ante el SAT esté disponible.
    · 203/204 u otro error: revertir cfdi_stamps a 'stamped', registrar pac_error_code/message y lanzar `CFDI_CANCEL_FAILED`. Nada cambia en libros.

Reescribir `POST /:id/cfdi/cancel` para delegar en `cancelarCfdiFactura` con `anularEnLibros` tomado del cuerpo (por omisión true) y devolver el acuse.

Blindar `POST /:id/void` (invoices.ts:358): antes del UPDATE, leer la factura; si `cfdi_status='stamped'`, lanzar `AccountingError('CFDI_VIVO_REQUIERE_CANCELACION', ...)` indicando que hay que usar la ruta de cancelación con su motivo. Una factura con CFDI vivo deja de poder anularse a espaldas del SAT. Aprovechar para arreglar de paso el UPDATE de la línea 361, que no filtra por entity_id (el paquete de perímetro se ocupa del patrón general; aquí basta con leer la fila y usar su entity_id).

Consulta de reconciliación, que es la que demuestra que el hueco quedó cerrado y debe formar parte de `mnemosine doctor`: facturas con `status='void'` cuyo `cfdi_status='stamped'` (CFDI vivo con libros anulados) o con `cfdi_status='cancelled'` y asiento sin reversa. Ambas deben devolver cero.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/mexico/cfdi-stamping-service.ts` — modificar: añadir cancelarCfdiFactura con las tres fases y el enlace a voidJournalEntryInTx
- `/Users/victor/projects/Accounting/src/api/rest/routes/invoices.ts` — modificar: /:id/cfdi/cancel delega en el servicio (se elimina el TODO de la línea 460 y el UPDATE a memo); /:id/void rechaza facturas con CFDI vivo y lee la fila antes de anular
- `/Users/victor/projects/Accounting/src/ai/doctor-service.ts` — modificar: añadir checkCfdiVsLibros con las dos consultas de reconciliación

**Criterios de aceptación**

- Dada una factura timbrada y contabilizada, cuando se cancela con motivo '02' y anularEnLibros, entonces el acuse queda en cfdi_stamps.cancel_acuse_xml, invoices.cfdi_status='cancelled', invoices.status='void', existe un asiento de reversa enlazado por reversed_by_entry_id y se disparó attestEntryAsync una sola vez, después del commit.
- Dada una factura timbrada, cuando se llama POST /:id/void sin pasar por la cancelación, entonces responde error CFDI_VIVO_REQUIERE_CANCELACION y ni el asiento ni la factura cambian.
- Dado que el PAC devuelve error en la cancelación, cuando termina la operación, entonces cfdi_stamps vuelve a 'stamped', no hay reversa y la factura sigue viva en libros.
- Dado un acuse 'En proceso', entonces cfdi_stamps queda en 'cancel_pending' y NO se genera reversa contable.
- Dada la cancelación con motivo '01' sin sustitucionUuid, entonces responde ValidationError antes de llamar al PAC.
- `SELECT count(*) FROM invoices WHERE status='void' AND cfdi_status='stamped'` devuelve 0, y `mnemosine doctor` incluye ese check.

**Pruebas**

- `tests/mexico/cfdi-cancel.spec.ts` — cancelación 201 que encadena reversa; 202 idempotente; error del PAC que no toca libros; 'En proceso' sin reversa; void bloqueado con CFDI vivo; motivo 01 sin sustitución

**Riesgo.** El caso 'cancelable con aceptación' puede tardar hasta 72 horas y deja la factura en un limbo deliberado (fiscalmente viva, contablemente viva). Es el comportamiento correcto, pero hay que decidir explícitamente si se permite forzar la anulación contable antes del acuse definitivo: ver decisión sobre cancelación en proceso.

##### `E3.1-h` CFDI de nómina 1.2 utilizable: esquema, TipoNomina real, periodicidad, registro patronal, gravado/exento y XML persistido · **L**

`generateAndStampCfdiNomina` (cfdi-nomina-generator.ts:17) no ha podido ejecutarse nunca: la línea 65 hace `JOIN entities ent ON ent.id = e.entity_id` y esa tabla no existe (001_core_schema.sql:76 define `legal_entities`). Además, aunque corriera, emitiría un comprobante inválido. Reescribir el generador entero.

Migración `032_cfdi_nomina.sql`:
  ALTER TABLE paycheck_earnings ADD COLUMN importe_gravado NUMERIC(14,2), ADD COLUMN importe_exento NUMERIC(14,2);
  UPDATE paycheck_earnings SET importe_gravado = amount, importe_exento = 0 WHERE importe_gravado IS NULL;
  ALTER TABLE paycheck_earnings ALTER COLUMN importe_gravado SET NOT NULL, ALTER COLUMN importe_exento SET NOT NULL, ALTER COLUMN importe_gravado SET DEFAULT 0, ALTER COLUMN importe_exento SET DEFAULT 0;
  ALTER TABLE paycheck_earnings ADD CONSTRAINT ck_earnings_gravado_exento CHECK (importe_gravado + importe_exento = amount);
  (el registro patronal se añade a legal_entities en la migración 031).

Crear `src/services/payroll/mx/exenciones-lisr.ts`:
  export interface Exencion { gravado: number; exento: number; }
  export function calcularExencion(earningType: string, importe: number, ctx: { umaDiaria: number; diasPeriodo: number; salarioDiario: number; salarioMinimoZona: number }): Exencion
Cubre los conceptos que el catálogo `earning_type` ya contempla: aguinaldo (exento hasta 30 UMA anuales), prima_vacacional (hasta 15 UMA), ptu (hasta 15 UMA), prima_dominical (1 UMA por domingo), horas extra (según art. 93 fr. I LISR y el tope de la LFT), fondo de ahorro y previsión social con sus topes; cualquier otro concepto → gravado íntegro, exento 0. La UMA se lee con `getTaxParameters('MX', taxYear)` (tax-tables.ts:66), que ya devuelve `uma_daily`. El cálculo lo consume `paycheck-service` al crear las líneas, y persiste importe_gravado/importe_exento; el generador de CFDI ya sólo lee columnas.

Reescribir `generateAndStampCfdiNomina`:
  · `JOIN legal_entities ent ON ent.id = e.entity_id`, añadiendo al SELECT `ent.imss_registro_patronal`, `ent.regimen_fiscal_sat`, `ent.codigo_postal_fiscal`, `pr.run_type`, `ps.frequency` (JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id) y `e.sbc`.
  · TipoNomina: `pr.run_type === 'regular' ? 'O' : 'E'` — no el apellido materno (línea 112). El mapa es explícito: regular→'O'; bonus, correction, final y off_cycle→'E'.
  · PeriodicidadPago del catálogo c_PeriodicidadPago derivado de `ps.frequency`: weekly→'02', biweekly→'03', semimonthly→'04', quincenal→'04', monthly→'05'; y '99' cuando TipoNomina='E'.
  · RegistroPatronal: `ent.imss_registro_patronal`; si es NULL lanzar `CFDI_NOMINA_FALTA_REGISTRO_PATRONAL` en vez de emitir 'B0000000000' (línea 116).
  · LugarExpedicion = `ent.codigo_postal_fiscal`, RegimenFiscal del emisor = `ent.regimen_fiscal_sat` (hoy '00000' y '601' fijos, líneas 103-104); DomicilioFiscalReceptor = `e.postal_code` del trabajador; si falta alguno, error con el dato nombrado.
  · Percepciones: `ImporteGravado` e `ImporteExento` de las columnas nuevas; los agregados `TotalGravado`, `TotalExento` y `TotalSueldos` del nodo nomina12:Percepciones se calculan sumando, no con el literal '0.00' de la línea 123. Si el subsidio al empleo excede al ISR, el remanente entregado en efectivo se emite como percepción tipo 'e' (SubsidioAlEmpleo) — hoy se trunca con Math.max(0,...) en la línea 83.
  · Deducciones: nodos propios para IMSS (TipoDeduccion '001'), INFONAVIT ('010') e ISR ('002'), en vez de meter imss_employee e infonavit_withheld dentro de TotalOtrasDeducciones sin nodo (líneas 85-86).
  · Emitir el XML, sellarlo con `sellarCfdi` y el CSD (`withCsd`, purpose 'sellado'), y timbrarlo a través de una función hermana `timbrarNomina(paycheckId, ctx)` en cfdi-stamping-service.ts que reutiliza las tres fases y la tabla cfdi_stamps con `document_type='paycheck'` y `tipo_comprobante='N'`. Persistir el XML timbrado y escribir `paychecks.cfdi_xml_path`, `cfdi_uuid`, `cfdi_status='stamped'`, `cfdi_provider`, `cfdi_stamped_at`, `cfdi_simulated`, con la misma guarda `AND cfdi_uuid IS NULL`.
  · Añadir `cancelarCfdiNomina(paycheckId, params, ctx)` análoga a la de factura, que escribe `paychecks.cfdi_status='cancelled'` (valor que la columna ya admite) y, si el recibo estaba contabilizado, encadena la reversa del asiento de nómina por el mismo camino que E3.1-g.
  · La ruta `POST /v1/payroll/paychecks/:id/cfdi-nomina` (payroll.ts:253) pasa a llamar `timbrarNomina`; añadir `POST /v1/payroll/paychecks/:id/cfdi-nomina/cancel`.

**Archivos**

- `/Users/victor/projects/Accounting/src/database/migrations/032_cfdi_nomina.sql` — crear: importe_gravado/importe_exento en paycheck_earnings con backfill y CHECK de cuadre
- `/Users/victor/projects/Accounting/src/services/payroll/mx/exenciones-lisr.ts` — crear: calcularExencion por tipo de percepción con la UMA del año
- `/Users/victor/projects/Accounting/src/services/payroll/mx/cfdi-nomina-generator.ts` — modificar: legal_entities en vez de entities; TipoNomina desde pay_runs.run_type; PeriodicidadPago desde pay_schedules.frequency; registro patronal, régimen y CP de la entidad; gravado/exento reales; nodos de deducción IMSS/INFONAVIT/ISR; sellado y persistencia del XML
- `/Users/victor/projects/Accounting/src/services/payroll/common/paycheck-service.ts` — modificar: al crear paycheck_earnings, poblar importe_gravado e importe_exento con calcularExencion; entregar en efectivo el subsidio al empleo excedente
- `/Users/victor/projects/Accounting/src/services/mexico/cfdi-stamping-service.ts` — modificar: añadir timbrarNomina y cancelarCfdiNomina sobre la misma máquina de estados de cfdi_stamps
- `/Users/victor/projects/Accounting/src/api/rest/routes/payroll.ts` — modificar: la ruta de cfdi-nomina delega en timbrarNomina; añadir la ruta de cancelación

**Migración**

```sql
032_cfdi_nomina.sql — importe_gravado e importe_exento en paycheck_earnings, backfill conservador (todo gravado) y CHECK de cuadre. El registro patronal viaja en 031.
```

**Criterios de aceptación**

- Dado un recibo de un trabajador MX con la entidad completa, cuando se ejecuta el timbrado de nómina contra el PAC de pruebas, entonces devuelve UUID y no lanza ningún error de esquema: la consulta ya no menciona la tabla inexistente `entities`.
- Dado un pay_run con run_type='bonus', entonces el XML lleva TipoNomina='E' y PeriodicidadPago='99', y el apellido materno del trabajador no interviene en ninguna decisión (grep de `emp_second_last` no aparece fuera del nombre del receptor).
- Dada una entidad sin imss_registro_patronal, cuando se intenta timbrar, entonces lanza CFDI_NOMINA_FALTA_REGISTRO_PATRONAL y no se emite ningún XML con 'B0000000000'.
- Dado un recibo con aguinaldo de 30 días y salario diario tal que 30 días superan 30 UMA, entonces la percepción se emite con ImporteExento = 30 × UMA diaria e ImporteGravado el resto, y TotalExento del nodo Percepciones es la suma de los exentos, no '0.00'.
- Dado un recibo donde el subsidio al empleo excede al ISR, entonces el remanente aparece como percepción de subsidio y el neto pagado lo incluye; ninguna resta queda truncada con Math.max(0, ...).
- Dado un recibo timbrado, entonces paychecks.cfdi_xml_path apunta al XML timbrado persistido y `SELECT count(*) FROM paychecks WHERE cfdi_uuid IS NOT NULL AND cfdi_xml_path IS NULL` devuelve 0.
- El CHECK ck_earnings_gravado_exento impide insertar una percepción cuyo desglose no sume el importe.

**Pruebas**

- `tests/payroll/mx/exenciones-lisr.spec.ts` — aguinaldo por encima y por debajo de 30 UMA, prima vacacional, PTU, prima dominical, horas extra, y concepto desconocido íntegramente gravado
- `tests/payroll/mx/cfdi-nomina.spec.ts` — TipoNomina por run_type, PeriodicidadPago por frequency, error por registro patronal ausente, totales gravado/exento que cuadran con las líneas, nodos de deducción IMSS/INFONAVIT/ISR presentes
- `scripts/e2e-nomina-cfdi.ts` — E2E contra base real: entidad MX con registro patronal, trabajador, periodo quincenal, cálculo, aprobación, timbrado y verificación del XML persistido

**Riesgo.** El backfill deja los recibos históricos con exento 0, que es lo que hoy se timbra; no se pueden reconstruir hacia atrás sin recalcular. Dejarlo explícito en el comentario de la migración. Segundo riesgo: las reglas de exención del art. 93 son numerosas; cubrir los conceptos del catálogo actual de earning_type y hacer que cualquier concepto desconocido caiga en gravado íntegro, que es el lado conservador.

##### `E3.1-i` Retirar el simulador paralelo y degradar los adaptadores sin transporte real · **S**

Queda un segundo simulador que nadie llama pero que sigue disponible para que alguien lo cablee: `stampWithPAC` (src/services/mexico/cfdi.ts:194) y `cancelWithPAC` (línea 220) fabrican UUID con Date.now()/Math.random() y devuelven éxito cuando `config.pac.environment === 'sandbox'`. Eliminarlos. El archivo conserva SAT_CATALOGS y generateDIOT.

sw-sapien y edicom quedan con `implemented = false` mientras no tengan transporte real: su `stamp()` y `cancel()`, fuera del modo simulación explícitamente autorizado, lanzan `AccountingError('PAC_NOT_IMPLEMENTED', ...)` nombrando el proveedor y diciendo que sólo finkok tiene integración real. El router los excluye del failover por el filtro de `implemented` (E3.1-e), de modo que un tenant que los tenga configurados como secundario no obtiene un folio falso cuando el primario falla: obtiene ALL_PACS_FAILED, que es la verdad.

`SATValidationService.validate` (sat-validation.ts:34-43) devuelve hoy 'Vigente' simulado cuando `PAC_ENVIRONMENT === 'sandbox'`. La implementación real de la consulta pertenece a otro paquete, pero aquí hay que aplicarle el mismo cerrojo: la rama simulada pasa por `simulacionPermitida(process.env.PAC_ENVIRONMENT)` y, si no está autorizada, devuelve `status:'error'` con `estado:'SAT validation not configured'` en vez de afirmar que el comprobante está vigente. Un 'Vigente' inventado es la entrada por la que el clasificador nunca verá un CFDI cancelado.

Actualizar `src/ai/docs/cli-reference.md` y el README en lo que describa el timbrado, y documentar en el README la variable PAC_ALLOW_SIMULATED_STAMP con su advertencia.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/mexico/cfdi.ts` — modificar: eliminar stampWithPAC y cancelWithPAC; conservar SAT_CATALOGS y generateDIOT
- `/Users/victor/projects/Accounting/src/services/integrations/mexico/pac/sw-sapien-adapter.ts` — modificar: implemented=false y PAC_NOT_IMPLEMENTED fuera de la simulación autorizada
- `/Users/victor/projects/Accounting/src/services/integrations/mexico/pac/edicom-adapter.ts` — modificar: implemented=false y PAC_NOT_IMPLEMENTED fuera de la simulación autorizada
- `/Users/victor/projects/Accounting/src/services/xml-ingestion/sat-validation.ts` — modificar: la rama 'Vigente' simulada pasa por simulacionPermitida; si no, devuelve status 'error'
- `/Users/victor/projects/Accounting/README.md` — modificar: documentar PAC_ALLOW_SIMULATED_STAMP y el estado real de cada adaptador PAC

**Criterios de aceptación**

- `grep -rn "stampWithPAC\|cancelWithPAC" src/` no devuelve nada.
- Dado un tenant con pac_primary='sw_sapien', cuando se timbra sin la bandera de simulación, entonces lanza PAC_NOT_IMPLEMENTED (o ALL_PACS_FAILED si hay failover) y nunca escribe un cfdi_uuid.
- Dado PAC_ENVIRONMENT='sandbox' sin PAC_ALLOW_SIMULATED_STAMP, cuando SATValidationService.validate consulta un UUID, entonces devuelve status 'error' y no 'valid'/'Vigente'.
- El README enumera qué adaptadores PAC tienen transporte real y cuáles no.

**Pruebas**

- `tests/xml-ingestion/sat-validation.spec.ts` — sin la bandera devuelve 'error'; con la bandera y sandbox devuelve el 'Vigente' simulado marcado como simulado

**Riesgo.** Cambiar el valor por omisión de SATValidationService puede alterar el comportamiento de la ingesta que hoy asume 'Vigente'. Revisar los llamadores en pre-registration-service.ts antes de mezclar.

#### Cómo se sabe que cerró

- `npm run typecheck` termina en código 0 y `npm test` pasa con los nuevos specs: tests/integrations/pac/simulation-guard.spec.ts, adapters-gate.spec.ts, finkok-adapter.spec.ts, pac-router.spec.ts, tests/mexico/cfdi-sellado.spec.ts, cfdi-builder.spec.ts, cfdi-stamping-service.spec.ts, cfdi-cancel.spec.ts, tests/payroll/mx/exenciones-lisr.spec.ts y cfdi-nomina.spec.ts.
- `grep -rn "from 'soap'" src/` devuelve al menos src/services/integrations/mexico/pac/finkok-adapter.ts (hoy devuelve cero).
- `grep -rn "stampWithPAC\|cancelWithPAC" src/` devuelve cero.
- En los tres adaptadores PAC, toda aparición de crypto.randomUUID o crypto.randomBytes está dentro de una rama precedida por assertSimulacionPermitida en la misma función.
- Con NODE_ENV=production, el test de integración que intenta timbrar sin transporte real recibe PAC_SIMULATED_STAMP_FORBIDDEN y la tabla invoices no registra ningún cambio.
- El test de sellado verifica el atributo Sello de tests/fixtures/cfdi/timbrado-real.xml contra su propio Certificado usando nuestra cadena original: verificarSello devuelve true.
- `SELECT count(*) FROM invoices WHERE cfdi_uuid IS NOT NULL AND cfdi_xml_url IS NULL` devuelve 0 y `SELECT count(*) FROM paychecks WHERE cfdi_uuid IS NOT NULL AND cfdi_xml_path IS NULL` devuelve 0.
- `SELECT count(*) FROM invoices WHERE status='void' AND cfdi_status='stamped'` devuelve 0 (ninguna factura anulada en libros con su CFDI vivo ante el SAT), y la misma consulta forma parte de `mnemosine doctor`.
- `SELECT count(*) FROM cfdi_stamps WHERE status='stamped' GROUP BY document_type, document_id HAVING count(*) > 1` devuelve cero filas: un solo timbre vivo por documento, respaldado por el índice uq_cfdi_stamps_document_vivo.
- `tsx scripts/e2e-cfdi.ts` contra el sandbox del PAC: siembra entidad MX con datos fiscales y CSD, contabiliza una factura, la timbra, la re-timbra y obtiene el MISMO UUID sin segunda llamada al PAC, la cancela con motivo '02' y comprueba que existe el asiento de reversa enlazado.
- `tsx scripts/e2e-nomina-cfdi.ts` timbra un recibo quincenal MX de punta a punta: la consulta ya no menciona la tabla inexistente `entities`, el TipoNomina proviene de pay_runs.run_type, el RegistroPatronal de legal_entities y TotalExento del nodo Percepciones es distinto de 0.00 cuando hay aguinaldo.
- `mnemosine doctor` incluye los checks 'CFDI simulados' y 'CFDI vs libros', ambos en nivel ok sobre una base recién migrada y sembrada.


### E3.2 · Traer los CFDI del SAT y saber si siguen vivos
**Objetivo.** Dar consumidor real a la custodia de la e.firma: descarga masiva de CFDI (SolicitaDescarga → VerificaSolicitud → Descargar) con token SOAP firmado con XML-DSig sobre withCredential, ingesta con import_source='sat_download', y consulta de estatus del CFDI ante el SAT que sustituye el "Vigente" simulado, alimenta satStatus del clasificador y detecta la factura ya contabilizada que el emisor canceló después, proponiendo la corrección por reversa.

**Por qué aquí.** La bóveda, parseCertificate/verifyKeyPair, withCredential, el propósito 'sat_auth', el actor desatendido y privateKeyToPem ya están escritos y probados: falta exactamente el consumidor, y sin él el texto de consentimiento de src/services/fiscal-credentials/service.ts:26 ("Authenticate with the SAT to download your issued and received CFDIs") promete algo que el producto no puede cumplir. Del otro lado, cfdi-classifier.ts:150 ya activa la decisión cfdi_cancelado con satStatus='cancelado' y hoy nadie puede dárselo: SATValidationService.validate devuelve 'Vigente' inventado cuando PAC_ENVIRONMENT=sandbox (sat-validation.ts:34-43) y 'error' en cualquier otro caso. Va después del cableado del clasificador (E3.1) porque el dato de estatus sólo vale si alguien lo consume, y antes de cualquier trabajo de conciliación fiscal porque hoy el sistema sólo ve los CFDI que un humano le sube a mano.

**Depende de:** `E3.1`, `E1.2` · **Migraciones:** `043-046` · **11 tareas · 7.2 sem-persona**

**Precondiciones:**

- Una e.firma vigente registrada con `mnemosine sat cred add` para la entidad de prueba (el flujo entero cuelga de withCredential y no hay ruta alternativa de descifrado).
- Node >= 20 (se usa fetch global, ya usado en src/services/webhooks/webhook-service.ts:97 y src/cli/init/s3-ai.ts:282). NO se usa el paquete `soap` de package.json: los sobres van construidos a mano porque la firma XML-DSig exige controlar los bytes canónicos exactos.
- Salida a Internet hacia los dominios *.clouda.sat.gob.mx y consultaqr.facturaelectronica.sat.gob.mx desde la máquina donde corre la CLI o el cron.
- account_roles sembrado y clasificador cableado (E3.1) para que la propagación de satStatus tenga a quién alimentar; la descarga y la consulta de estatus funcionan sin eso, sólo queda inerte la tarea E3.2-h.

#### Decisiones a resolver

**¿Qué hace el sistema cuando detecta el patrón anómalo de acceso a la e.firma (la política efirma_accion_anomalia, hoy sin lector)?**

pending-catalog.ts:174 ofrece 'bloquear', 'alertar' y 'bloquear_fuera_horario', con 'alertar' por defecto. La descarga desatendida es justo el consumidor que puede disparar rachas de denegaciones por rate_limit. 'Bloquear' significa poner fiscal_credentials.status en 'invalid', y eso deja al cliente sin sincronización hasta que alguien vuelva a cargar la e.firma: es una decisión de operación, no de ingeniería.

- Implementar las tres acciones en withCredential dentro de este paquete
- Implementar sólo 'alertar' (crear pregunta al detectar N denegaciones seguidas) y dejar el bloqueo para el paquete de políticas
- No tocarlo aquí: este paquete se limita a respetar el tope diario resuelto por política

_Recomendación:_ La segunda. El tope diario resuelto por política sí entra aquí (E3.2-c), porque sin él la descarga desatendida podría agotar el cupo sin control; el bloqueo automático de una credencial es una acción destructiva que merece el mismo cuidado que `sat cred revoke` y encaja mejor con el paquete que cierra el hueco general de políticas inertes.

_Bloquea:_ El alcance final de E3.2-c.

**¿Se guarda el ZIP crudo que devuelve el SAT?**

El XML íntegro de cada CFDI ya queda en xml_documents.xml_content (TEXT NOT NULL) con su hash. Guardar además el ZIP duplica el almacenamiento, pero es la evidencia literal de lo que el SAT entregó en esa fecha, que en una revisión puede valer más que la copia reprocesada.

- No guardarlo: sólo sha256, tamaño y conteos en sat_download_packages
- Guardarlo en disco bajo un directorio configurable (SAT_PACKAGE_DIR)
- Guardarlo en S3 con el adaptador ya existente (src/services/integrations/storage/s3-adapter.ts) y dejar la URL en la fila del paquete

_Recomendación:_ La primera por defecto, con la tercera como opción activable por configuración. El sha256 del paquete ya permite demostrar integridad si alguien conserva el ZIP por su cuenta, y no se introduce un almacén de archivos nuevo sin necesidad. Si el despacho tiene obligación documental propia, se activa S3 sin cambiar el modelo.

_Bloquea:_ El cierre de la fase 3 de E3.2-f (las columnas ya soportan las tres opciones).

**¿Se soporta tipoSolicitud='Metadata' en este paquete?**

El SAT permite pedir metadatos en vez de los XML: un archivo de texto delimitado, mucho más ligero, ideal para detectar qué CFDI existen en el SAT y no están en el sistema. Pero es otro formato de paquete y otra tabla de destino; no pasa por processXMLUpload.

- Soportar sólo 'CFDI' y rechazar 'Metadata' con un mensaje claro
- Soportar ambos, añadiendo una tabla sat_metadata_rows y su conciliación
- Soportar Metadata primero y descargar los XML sólo de lo que falte

_Recomendación:_ La primera ahora, la tercera como paquete siguiente. La opción tres es la forma correcta de conciliar a largo plazo —y de no gastar cupo trayendo lo que ya se tiene—, pero mezclarla aquí duplica el orquestador antes de que el camino de XML esté probado en producción. El esquema ya deja el hueco: tipo_solicitud está en sat_download_requests con su CHECK.

_Bloquea:_ Nada; define el alcance de E3.2-f y del CLI.

**¿Cómo se corrige una factura cancelada por el emisor que ya fue pagada?**

La reversa simple deja un pago sin documento que lo soporte. Hay al menos tres tratamientos legítimos y son de criterio contable-fiscal, no de código: reclamar la sustitución al proveedor y mantener el registro mientras tanto; revertir y reconocer una cuenta por cobrar al proveedor; o reclasificar el gasto como no deducible.

- Rechazar la corrección automática y escalar siempre como pregunta (comportamiento propuesto)
- Ofrecer las tres alternativas como opciones de la pregunta y generar el asiento correspondiente a la elegida
- Revertir siempre y dejar la diferencia en una cuenta puente de aclaraciones

_Recomendación:_ La primera en este paquete y la segunda como evolución, una vez que la taxonomía tenga casos escritos para cada tratamiento. Generar hoy un asiento por una regla que nadie ha acordado sería repetir el patrón que este atlas denuncia: aparentar capacidad sin sustancia.

_Bloquea:_ El alcance de applyCorrection en E3.2-i.

**¿Lector de ZIP propio o dependencia (yauzl/adm-zip)?**

Node no trae descompresión de ZIP. El repositorio tiene el precedente explícito de escribir lo mínimo (matcher de cron propio, 'no dependency, fully unit-tested'), pero un lector de ZIP tiene más superficie de error que un matcher de cron.

- Lector propio acotado (~150 líneas) con cotas y ZIP64 rechazado explícitamente
- Añadir yauzl (streaming, muy probado) a package.json
- Añadir adm-zip (API más simple, historial de CVE peor)

_Recomendación:_ La primera, tal como está especificada en E3.2-e: el paquete ya suma código criptográfico propio (XML-DSig) que nadie va a delegar, las cotas importan más que la cobertura de formatos exóticos, y el fixture de test fija el comportamiento. Si el equipo prefiere no mantenerlo, yauzl es la sustitución de una tarea, no del diseño.

_Bloquea:_ E3.2-e.

**¿La descarga desatendida deja que el motor de reglas auto-contabilice lo que trae?**

processXMLUpload contabiliza solo cuando las reglas dejan el pre-registro en processing_mode='auto' y validation_status='valid' (pre-registration-service.ts:152-160). Una descarga masiva puede traer cientos de CFDI de golpe, de meses distintos, sin nadie mirando.

- La descarga sólo ingiere: se añade options.autoProcess=false para esta ruta y toda contabilización queda a `mnemosine ingest`, a la revisión de borradores o al job cfdi_reconciliation
- Dejar que las reglas actúen igual que en la carga manual
- Dejar que actúen sólo para CFDI de los últimos N días

_Recomendación:_ La primera. La descarga es un acto de recolección, no de contabilización; separarlas hace que un mes traído de golpe no genere doscientas pólizas sin revisión, y encaja con la frontera que el runner ya defiende (todo lo que sale de una corrida desatendida debe ser revisable). Requiere añadir options.autoProcess al mismo cambio de firma de E3.2-f.

_Bloquea:_ La firma final de processXMLUpload en E3.2-f.

#### Tareas

##### `E3.2-a` Esquema: solicitudes, cupo permanente de la huella, paquetes e índices de re-validación · **S**

Crear la migración 031_sat_bulk_download.sql (el máximo actual es 030_webhook_token_rls.sql). Tres tablas nuevas, todas con tenant_id UUID NOT NULL y entity_id: rls-policies.sql descubre por columna, así que la política tenant_isolation aparece sola al reaplicarse tras la migración; no hay que escribir política a mano.

1) sat_download_requests — una fila por solicitud enviada al SAT: id, tenant_id, entity_id, rfc_solicitante VARCHAR(13), request_kind CHECK IN ('emitidos','recibidos'), tipo_solicitud CHECK IN ('CFDI','Metadata') DEFAULT 'CFDI', fecha_inicial/fecha_final TIMESTAMPTZ con CHECK (fecha_inicial < fecha_final), filters JSONB NOT NULL DEFAULT '{}', fingerprint CHAR(64) NOT NULL, id_solicitud VARCHAR(60), cod_estatus VARCHAR(10), mensaje TEXT, estado_solicitud SMALLINT, codigo_estado_solicitud VARCHAR(10), numero_cfdis INTEGER, status CHECK IN ('submitted','accepted','in_progress','ready','downloaded','completed','no_data','rejected','expired','failed') DEFAULT 'submitted', attempts SMALLINT NOT NULL DEFAULT 0, last_error TEXT, actor VARCHAR(255) NOT NULL, unattended BOOLEAN NOT NULL DEFAULT false, requested_at DEFAULT NOW(), ready_at, packages_expire_at, completed_at.

2) sat_download_quota — el guard permanente del 5002. PRIMARY KEY (entity_id, fingerprint); tenant_id, descriptor JSONB (los campos legibles de la huella, para poder explicarle al humano qué rango se agotó), attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2), exhausted BOOLEAN NOT NULL DEFAULT false, exhausted_at, first_at, last_at. Esta tabla NO se limpia nunca: el límite del SAT es de por vida por combinación idéntica.

3) sat_download_packages — id, tenant_id, entity_id, request_id REFERENCES sat_download_requests(id) ON DELETE CASCADE, package_id VARCHAR(120), status CHECK IN ('pending','downloaded','ingested','expired','failed'), size_bytes BIGINT, sha256 CHAR(64), cfdi_count/ingested_count/duplicate_count/error_count INTEGER NOT NULL DEFAULT 0, errors JSONB, expires_at TIMESTAMPTZ, downloaded_at, ingested_at, UNIQUE (request_id, package_id).

Índices: idx_sat_req_entity(entity_id, requested_at DESC); idx_sat_req_open(entity_id, status) WHERE status IN ('submitted','accepted','in_progress','ready'); UNIQUE idx uq_sat_req_id_solicitud(entity_id, id_solicitud) WHERE id_solicitud IS NOT NULL; idx_sat_pkg_pending(entity_id, status) WHERE status IN ('pending','downloaded').

Dos índices más, sobre tablas existentes: (i) idx_xml_docs_sat_recheck ON xml_documents(entity_id, sat_validated_at NULLS FIRST) WHERE sat_validation_status IS DISTINCT FROM 'cancelled' — hoy el barrido de re-validación no tiene índice y el atlas ya señala que idx_fiscal_credentials_expiry existe sin lector; (ii) idx_je_reference_uuid ON journal_entries(right(reference, 36)) WHERE reference IS NOT NULL — es la única forma barata de localizar el asiento que la ruta de IA generó, porque buildCfdiPrompt (src/ai/ingest-service.ts:412) ordena escribir la referencia como "<serie><folio> · <uuid>" y el UUID queda en los últimos 36 caracteres; right(text,int) es IMMUTABLE, así que el índice funcional es válido.

No tocar xml_documents.import_source: 'sat_download' ya está en su CHECK (005_xml_ingestion.sql:79-81). import_batch_id ya existe y se reutilizará como puntero al paquete.

**Archivos**

- `/Users/victor/projects/Accounting/src/database/migrations/031_sat_bulk_download.sql` — crear: las tres tablas, sus índices y los dos índices sobre xml_documents y journal_entries

**Migración**

```sql
CREATE TABLE sat_download_requests (...); CREATE TABLE sat_download_quota (entity_id UUID NOT NULL REFERENCES legal_entities(id), tenant_id UUID NOT NULL, fingerprint CHAR(64) NOT NULL, descriptor JSONB NOT NULL, attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2), exhausted BOOLEAN NOT NULL DEFAULT false, exhausted_at TIMESTAMPTZ, first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (entity_id, fingerprint)); CREATE TABLE sat_download_packages (...); CREATE INDEX idx_xml_docs_sat_recheck ON xml_documents(entity_id, sat_validated_at NULLS FIRST) WHERE sat_validation_status IS DISTINCT FROM 'cancelled'; CREATE INDEX idx_je_reference_uuid ON journal_entries(right(reference, 36)) WHERE reference IS NOT NULL;
```

**Criterios de aceptación**

- Dado un esquema en 030, cuando corre `npm run migrate`, entonces las tres tablas existen y la salida imprime 'Applying isolation policies...'.
- Dado que la migración corrió, cuando se consulta pg_policies WHERE tablename IN ('sat_download_requests','sat_download_quota','sat_download_packages'), entonces las tres tienen la política tenant_isolation y relforcerowsecurity = true en pg_class.
- Dado un INSERT en sat_download_quota con attempts=3, entonces el CHECK lo rechaza.
- Dado dos filas en sat_download_requests de la misma entidad con el mismo id_solicitud, entonces el índice único uq_sat_req_id_solicitud rechaza la segunda.

**Pruebas**

- `tests/database/sat-download-schema.spec.ts` — lee el archivo 031 y verifica que toda tabla nueva declara tenant_id UUID NOT NULL (es la condición que hace que rls-policies.sql use el predicado barato tenant_id = app_current_tenant())

**Riesgo.** Si alguna tabla nace sin tenant_id, rls-policies.sql cae al predicado por legal_entities y el aislamiento sigue existiendo, pero es más caro; si nace sin ninguna de las dos columnas, la tabla queda SIN política (el hueco documentado con ai_external_ops). El test de esquema lo cierra.

##### `E3.2-b` Firma XML-DSig y transporte SOAP: los bytes canónicos se emiten, nunca se re-serializan · **L**

Crear src/services/sat/xmldsig.ts y src/services/sat/soap-client.ts.

xmldsig.ts — firma enveloped con node-forge (ya es dependencia; nada de xml-crypto). Regla estructural que hay que respetar y comentar en el archivo: NO se parsea ni se re-serializa XML para canonicalizar. Cada fragmento que se firma se EMITE ya en forma canónica exc-c14n (sin comentarios, atributos en orden de aparición, todas las declaraciones de namespace en alcance escritas explícitamente sobre el elemento firmado, sin espacio entre atributos ni saltos de línea) y se digiere exactamente esa misma cadena de bytes. Es la única forma de que el digest coincida sin implementar c14n completo.

API:
  export interface SignerMaterial { keyPem: string; certDerBase64: string; issuerName: string; serialDecimal: string; rfc: string; }
  export function buildSigner(cer: Buffer, key: Buffer, password: string): SignerMaterial
     — usa privateKeyToPem(key, password) de src/services/fiscal-credentials/certificate.ts:131 (hoy sin llamadores; éste es su primer consumidor) y parseCertificate para el RFC. certDerBase64 = cer.toString('base64') sin saltos. issuerName = atributos de cert.issuer en formato RFC 2253 y en ORDEN INVERSO al de forge. serialDecimal = BigInt('0x' + cert.serialNumber).toString(): el X509SerialNumber va en DECIMAL, y forge entrega el serial en hexadecimal — es el error clásico que hace que el SAT rechace la firma.
  export function sha1Base64(canonical: string): string  — forge.md.sha1 sobre los bytes utf-8.
  export function signSignedInfo(signedInfoCanonical: string, keyPem: string): string  — RSA-SHA1, salida base64 en una sola línea.
  export function buildSignature(opts: { referenceUri: string; referencedCanonical: string; transforms: 'exc-c14n' | 'enveloped'; keyInfo: 'x509-data' | 'wsse-reference'; wsseTokenId?: string; signer: SignerMaterial }): string
     — arma <Signature xmlns="http://www.w3.org/2000/09/xmldsig#"> con CanonicalizationMethod exc-c14n (http://www.w3.org/2001/10/xml-exc-c14n#), SignatureMethod rsa-sha1, DigestMethod sha1; DigestValue = sha1Base64(referencedCanonical); SignedInfo se emite canónico (con su xmlns heredado escrito explícitamente) y se firma tal cual. keyInfo 'wsse-reference' emite <KeyInfo><wsse:SecurityTokenReference><wsse:Reference URI="#<wsseTokenId>" ValueType="...#X509v3"/></...> (para el sobre de autenticación, donde el certificado viaja en el BinarySecurityToken); keyInfo 'x509-data' emite <KeyInfo><X509Data><X509IssuerSerial><X509IssuerName>…</X509IssuerName><X509SerialNumber>…</X509SerialNumber></X509IssuerSerial><X509Certificate>…</X509Certificate></X509Data></KeyInfo> (para solicitud/verificación/descarga).

soap-client.ts — un solo POST tipado:
  export interface SoapCall { url: string; soapAction: string; envelope: string; token?: string; timeoutMs?: number; }
  export class SatSoapError extends Error { constructor(message: string, readonly httpStatus: number | null, readonly faultCode?: string, readonly body?: string) }
  export async function postSoap(call: SoapCall): Promise<string>
     — fetch con headers 'Content-Type: text/xml; charset=utf-8', SOAPAction entre comillas, y Authorization: `WRAP access_token="<token>"` cuando hay token (el token se inserta VERBATIM tal como lo devolvió el SAT, sin url-encode). AbortSignal.timeout(config.sat.httpTimeoutMs). Si !res.ok o el cuerpo contiene <s:Fault>/<soap:Fault>, lanza SatSoapError con el faultstring. Reintentos: withRetry de src/services/integrations/base/retry.ts con maxAttempts 3, initialDelayMs 2000, backoffMultiplier 2 y retryableErrors = (e) => e instanceof SatSoapError && (e.httpStatus === null || e.httpStatus >= 500 || e.httpStatus === 429). Un 4xx distinto de 429 NO se reintenta.
     — PROHIBIDO registrar el envelope completo o el header Authorization en cualquier log: el sobre de autenticación lleva la firma y el token da acceso al SAT. Sólo se registran url, soapAction, httpStatus y longitud del cuerpo.
  export function extractTagText(xml: string, localName: string): string | null y export function extractAttr(xml: string, localName: string, attr: string): string | null — lectura de respuesta con fast-xml-parser (ya es dependencia, removeNSPrefix: true, como hace CFDIParser en cfdi-parser.ts:98).

Añadir a src/config/index.ts un bloque `sat` con authUrl, solicitaUrl, verificaUrl, descargaUrl, consultaUrl, statusMode ('live'|'off'), downloadEnabled, httpTimeoutMs (60000), maxPackageBytes (256 MiB), sessionMaxMs (600000), todos leídos de env con los valores por defecto de producción. Los endpoints van en configuración justamente porque el SAT los ha movido antes.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/sat/xmldsig.ts` — crear: buildSigner, sha1Base64, signSignedInfo, buildSignature
- `/Users/victor/projects/Accounting/src/services/sat/soap-client.ts` — crear: postSoap, SatSoapError, helpers de lectura
- `/Users/victor/projects/Accounting/src/config/index.ts` — modificar: añadir el bloque `sat` junto al bloque `pac` existente (línea 93)

**Criterios de aceptación**

- Dado un par .cer/.key de prueba, cuando se llama buildSigner, entonces serialDecimal es la conversión decimal del serial hexadecimal de forge (p. ej. '30001000000500003416' y no su hex) y issuerName lleva los RDN en orden inverso al de cert.issuer.attributes.
- Dada una cadena canónica conocida, cuando se firma con buildSignature y se verifica el SignatureValue con la clave pública del certificado sobre el SignedInfo emitido, entonces la verificación pasa.
- Dado un endpoint que responde 500, cuando se llama postSoap, entonces se reintenta 3 veces con backoff; dado un 403, entonces se lanza SatSoapError sin reintento.
- Dado cualquier flujo de firma, cuando se inspeccionan los logs de la corrida, entonces no aparece ni el envelope ni el valor del token.

**Pruebas**

- `tests/sat/xmldsig.spec.ts` — buildSigner sobre el certificado de prueba de tests/fiscal-credentials/certificate.spec.ts: serial en decimal, issuerName invertido, certDerBase64 sin saltos
- `tests/sat/xmldsig.spec.ts` — buildSignature: el DigestValue es sha1 de la cadena referenciada tal cual, y el SignatureValue verifica contra la clave pública
- `tests/sat/soap-client.spec.ts` — postSoap con fetch mockeado: 500 reintenta, 403 no, y un cuerpo con <s:Fault> lanza SatSoapError con el faultstring

**Riesgo.** La canonicalización es donde fallan todas las implementaciones. Mitigación: no re-serializar nunca; emitir los fragmentos con funciones que devuelven string y digerir esa misma variable. Si el SAT rechaza con 'La firma no es válida', el sospechoso número uno es el serial en hex y el número dos un namespace no declarado en el elemento firmado.

##### `E3.2-c` Sesión SAT: una sola desencriptación por corrida, con el propósito sat_auth y el límite de la política · **M**

Crear src/services/sat/auth.ts. Problema de diseño que hay que resolver explícitamente: las cuatro operaciones del SAT necesitan la clave privada (el token caduca a ~5 minutos y cada llamada de solicitud/verificación/descarga lleva su propia firma), pero withCredential cuenta cada invocación contra max_daily_access (service.ts:241-251). Si cada firma abriera su propio withCredential, una corrida normal agotaría el cupo diario. La solución es la sesión:

  export interface SatSession { rfc: string; token(): Promise<string>; sign(opts: Omit<Parameters<typeof buildSignature>[0],'signer'>): string; }
  export async function withSatSession<T>(entityId: string, tenantId: string, access: { actor: string; unattended: boolean; requestId?: string; maxMs?: number }, fn: (s: SatSession) => Promise<T>): Promise<T>

withSatSession envuelve UNA llamada a withCredential(entityId, tenantId, { purpose: 'sat_auth', actor, unattended, requestId }, async (material) => …) — primer uso en producción del propósito 'sat_auth' del enum de 014_fiscal_credentials.sql:74. Dentro: signer = buildSigner(material.cer, material.key, material.password); el token se obtiene perezosamente y se guarda en una variable local con su expiración; token() lo renueva si faltan menos de 30 s. La sesión tiene un tope de vida (access.maxMs ?? config.sat.sessionMaxMs, 10 min por defecto): al vencer, sign() y token() lanzan SatSessionExpired en vez de seguir usando material vivo. Es lo que obliga a que el orquestador (E3.2-f) parta la corrida en fases cortas en vez de tener la e.firma descifrada en memoria durante la media hora que el SAT puede tardar en preparar un paquete.

Autenticación (dentro de token()):
  · Sobre SOAP a config.sat.authUrl, SOAPAction "http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica".
  · Header wsse:Security con <u:Timestamp u:Id="_0"><u:Created>…Z</u:Created><u:Expires>…Z</u:Expires></u:Timestamp> (Created = ahora - 1 min por tolerancia de reloj, Expires = Created + 5 min, formato ISO con milisegundos truncados) y <o:BinarySecurityToken u:Id="BST" ValueType="…#X509v3" EncodingType="…#Base64Binary">certDerBase64</o:BinarySecurityToken>.
  · Firma con referenceUri '#_0', referencedCanonical = la MISMA cadena del Timestamp que se emitió (con sus xmlns declarados sobre el propio <u:Timestamp>), keyInfo 'wsse-reference' apuntando a '#BST'.
  · Cuerpo: <Autentica xmlns="http://DescargaMasivaTerceros.gob.mx"/>.
  · Respuesta: AutenticaResult es el token. Se devuelve tal cual; la expiración se toma del u:Expires del Timestamp de la respuesta y, si no viene, se asume Created + 5 min.
  · El token NUNCA se persiste ni se escribe a disco ni al log.

Política de acceso (la que ya existe en src/services/policy/pending-catalog.ts:152, key 'efirma_max_accesos_diarios'): antes de withCredential, resolver getPolicyNumber({ tenantId, entityId }, 'efirma_max_accesos_diarios') y pasarlo a withCredential como límite efectivo. Para eso hay que ampliar AccessOptions en src/services/fiscal-credentials/service.ts:192 con `maxDailyOverride?: number` y cambiar la comparación de la línea 246 a `const cap = Math.min(row.max_daily_access, opts.maxDailyOverride ?? Infinity)`; el mensaje de denegación cita el cap efectivo y de dónde salió. Es la primera vez que esa política deja de ser inerte.

Cuando withCredential deniega por 'rate_limit', withSatSession no lo traduce ni lo traga: deja subir CredentialAccessDenied (la denegación ya quedó en fiscal_credential_access_log por la propia service.ts:224) y el llamador la reporta con el texto de la política.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/sat/auth.ts` — crear: withSatSession, SatSession, SatSessionExpired, construcción del sobre Autentica
- `/Users/victor/projects/Accounting/src/services/fiscal-credentials/service.ts` — modificar: AccessOptions gana maxDailyOverride?: number; la comprobación de tope diario usa el mínimo entre la columna y el override

**Criterios de aceptación**

- Dada una entidad con e.firma activa, cuando corre una descarga completa (solicitud + verificación + descarga de 2 paquetes), entonces fiscal_credential_access_log tiene como máximo 2 filas con purpose='sat_auth' para esa corrida, no una por firma.
- Dada una credencial con unattended_access=false, cuando withSatSession se invoca con unattended: true, entonces se lanza CredentialAccessDenied con reason 'unattended_disabled' y queda registrada la denegación.
- Dada la política efirma_max_accesos_diarios resuelta en 4 y una credencial con max_daily_access=24, cuando ya hay 4 accesos exitosos en 24 h, entonces el quinto se deniega con reason 'rate_limit'.
- Dada una sesión abierta hace más de sessionMaxMs, cuando se llama sign(), entonces lanza SatSessionExpired y no se firma nada.
- Dado cualquier fallo de red durante la sesión, cuando termina withSatSession, entonces zeroize corrió sobre el material (verificable porque el finally de withCredential ya lo garantiza) y no queda el PEM en ninguna variable de módulo.

**Pruebas**

- `tests/sat/auth.spec.ts` — withSatSession con la connection y el vault mockeados (mismo patrón de tests/fiscal-credentials/service.spec.ts): una sola desencriptación aunque fn llame token() y sign() varias veces
- `tests/sat/auth.spec.ts` — token() renueva cuando faltan menos de 30 s para Expires y reutiliza cuando falta más
- `tests/sat/auth.spec.ts` — sign() tras vencer maxMs lanza SatSessionExpired
- `tests/fiscal-credentials/service.spec.ts` — añadir: maxDailyOverride menor que max_daily_access deniega antes que la columna

**Riesgo.** El PEM es un string de JS y no se puede sobrescribir en memoria como el Buffer que zeroize limpia. Documentarlo en el archivo con honestidad en vez de fingir que se borra; la mitigación real es la vida corta de la sesión.

##### `E3.2-d` Las tres operaciones de descarga masiva y el mapa de códigos del SAT · **M**

Crear src/services/sat/bulk-download.ts con las tres operaciones puras (reciben SatSession, no tocan base de datos):

  export type RequestKind = 'emitidos' | 'recibidos';
  export interface SolicitaInput { rfcSolicitante: string; kind: RequestKind; tipoSolicitud: 'CFDI' | 'Metadata'; fechaInicial: string; fechaFinal: string; /* 'YYYY-MM-DDTHH:mm:ss' hora del centro */ rfcEmisor?: string; rfcReceptores?: string[]; complemento?: string; estadoComprobante?: 'Vigente'|'Cancelado'|'Todos'; }
  export interface SolicitaResult { idSolicitud: string | null; codEstatus: string; mensaje: string; }
  export async function solicitaDescarga(s: SatSession, input: SolicitaInput): Promise<SolicitaResult>
  export interface VerificaResult { codEstatus: string; mensaje: string; estadoSolicitud: number; codigoEstadoSolicitud: string; numeroCFDIs: number; idsPaquetes: string[]; }
  export async function verificaSolicitud(s: SatSession, rfcSolicitante: string, idSolicitud: string): Promise<VerificaResult>
  export async function descargaPaquete(s: SatSession, rfcSolicitante: string, idPaquete: string): Promise<{ codEstatus: string; mensaje: string; zip: Buffer | null }>

Detalles obligatorios:
 · Solicitud: nodo <des:solicitud> con los atributos RfcSolicitante, TipoSolicitud, FechaInicial, FechaFinal y, según kind, RfcEmisor (recibidos) o RfcReceptor/RfcReceptores (emitidos). El elemento se emite PRIMERO vacío y autocerrado, con todos sus xmlns explícitos; esa cadena exacta es el referencedCanonical del digest (referenceUri '', transforms 'enveloped'); la <Signature> se inserta después como hijo. Es el único orden que produce un digest que el SAT acepta.
 · Verificación y descarga: mismo patrón, sobre <des:VerificaSolicitudDescarga><des:solicitud IdSolicitud RfcSolicitante/> y <des:PeticionDescargaMasivaTercerosEntrada><des:peticionDescarga IdPaquete RfcSolicitante/>.
 · SOAPAction y URL de cada operación salen de config.sat; los nombres de operación se declaran en constantes exportadas SAT_OPERATIONS para que un cambio del SAT sea una línea.
 · Descarga: el paquete llega como contenido base64 en el header/cuerpo de la respuesta; se decodifica a Buffer y se valida que empiece con 'PK' (0x50 0x4B). Si no, se devuelve zip: null y el mensaje del SAT.

  export const SAT_CODES: Record<string, { meaning: string; terminal: boolean; consumesQuota: boolean }> — al menos: '5000' recibida con éxito (no terminal, consume cupo), '5002' se agotaron las solicitudes de por vida para esa combinación (TERMINAL Y PERMANENTE), '5003' tope máximo de elementos, '5004' no se encontró la información, '5005' solicitud duplicada aún en proceso (terminal para esta llamada, NO consume cupo: hay que reengancharse a la que ya existe), '404' error no controlado. Todo código desconocido se trata como no terminal la primera vez y terminal a la segunda, y se guarda tal cual en cod_estatus para que un humano pueda leerlo.
  export const ESTADO_SOLICITUD: Record<number, string> — 1 aceptada, 2 en proceso, 3 terminada, 4 error, 5 rechazada, 6 vencida.

Ninguna función de este archivo escribe en base de datos ni decide reintentos de negocio: eso es del orquestador. Los códigos concretos son los publicados por el SAT y pueden cambiar; por eso viven en una tabla exportada y no dispersos en ifs.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/sat/bulk-download.ts` — crear: solicitaDescarga, verificaSolicitud, descargaPaquete, SAT_CODES, ESTADO_SOLICITUD, SAT_OPERATIONS

**Criterios de aceptación**

- Dado un SatSession de prueba, cuando se llama solicitaDescarga, entonces el envelope enviado contiene un <des:solicitud> con Signature hija y el DigestValue calculado sobre la versión autocerrada del mismo elemento.
- Dada una respuesta con CodEstatus '5002', entonces SAT_CODES['5002'].terminal es true y consumesQuota es true.
- Dada una respuesta de verificación con EstadoSolicitud 3 y dos IdsPaquetes, entonces VerificaResult.idsPaquetes tiene los dos identificadores en orden.
- Dado un paquete cuya decodificación no empieza con 'PK', entonces descargaPaquete devuelve zip: null y no lanza.

**Pruebas**

- `tests/sat/bulk-download.spec.ts` — con postSoap mockeado, las tres operaciones parsean respuestas de ejemplo (fixtures XML) y devuelven las estructuras tipadas
- `tests/sat/bulk-download.spec.ts` — el envelope de solicitud firma el elemento vacío: el digest coincide con sha1 del <des:solicitud …/> autocerrado y no con el que ya lleva la Signature dentro

**Riesgo.** El SAT partió SolicitaDescarga en variantes por emitidos/recibidos y añadió filtros nuevos en revisiones sucesivas. SAT_OPERATIONS y los atributos opcionales aíslan ese cambio; los fixtures de test documentan la versión contra la que se implementó.

##### `E3.2-e` Lector de ZIP mínimo y acotado, sin dependencia nueva · **M**

Crear src/services/sat/unzip.ts. Node no trae lector de ZIP y el repositorio tiene la costumbre de escribir lo mínimo antes que sumar dependencia (el matcher de cron de job-store.ts es el precedente explícito).

  export interface ZipEntry { name: string; data: Buffer; }
  export class ZipError extends Error {}
  export function readZip(buf: Buffer, limits?: { maxEntries?: number; maxTotalBytes?: number }): ZipEntry[]

Algoritmo: buscar hacia atrás la firma EOCD 0x06054b50 en los últimos 65 557 bytes; leer número de entradas y offset del directorio central; recorrer las entradas 0x02014b50 tomando método de compresión, tamaños y offset del encabezado local; por cada una, leer el encabezado local 0x04034b50 para saltar nombre y extra, y luego método 0 = slice directo, método 8 = zlib.inflateRawSync. Cualquier otro método lanza ZipError con el número.

Cotas obligatorias (el archivo viene de un tercero, aunque ese tercero sea el SAT): maxEntries por defecto 20 000; maxTotalBytes por defecto config.sat.maxPackageBytes; si el EOCD trae 0xFFFF entradas o 0xFFFFFFFF de tamaño se lanza ZipError('ZIP64 no soportado') en lugar de leer basura; los nombres se normalizan y se rechaza cualquiera con '..' o que empiece por '/' (aunque nunca se escriban a disco, el nombre acaba en logs y en errors JSONB); la suma de tamaños descomprimidos se verifica contra maxTotalBytes ANTES de inflar cada entrada, usando el tamaño declarado, y también después, para no confiar en el declarado.

readZip no toca disco ni red y es puro: entra Buffer, salen Buffers.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/sat/unzip.ts` — crear: readZip, ZipError
- `/Users/victor/projects/Accounting/tests/fixtures/sat/paquete-demo.zip` — crear: ZIP con dos CFDI de tests/fixtures/cfdi y un archivo almacenado sin comprimir

**Criterios de aceptación**

- Dado tests/fixtures/sat/paquete-demo.zip, cuando corre readZip, entonces devuelve las entradas con los mismos bytes que los XML originales (comparación por hash).
- Dado un ZIP con 3 entradas y maxEntries: 2, entonces lanza ZipError sin inflar nada.
- Dado un ZIP cuyo tamaño descomprimido declarado excede maxTotalBytes, entonces lanza ZipError antes de llamar a inflateRawSync.
- Dado un ZIP con una entrada llamada '../evil.xml', entonces lanza ZipError.

**Pruebas**

- `tests/sat/unzip.spec.ts` — round-trip sobre el fixture: nombres, tamaños y hashes
- `tests/sat/unzip.spec.ts` — las cuatro cotas (entradas, bytes, zip64, nombre con ..) lanzan ZipError

**Riesgo.** Un ZIP del SAT con más de 65 535 entradas o mayor de 4 GiB sería ZIP64 y aquí falla ruidosamente en vez de en silencio; el mensaje debe decirle al operador que parta el rango. Alternativa si el equipo prefiere no mantener esto: ver decisión sobre la dependencia de descompresión.

##### `E3.2-f` Orquestador: cupo de por vida, ciclo de la solicitud, 72 h de los paquetes e ingesta marcada · **L**

Crear src/services/sat/download-service.ts. Es el único archivo del paquete que escribe en base de datos para la descarga.

  export interface DownloadInput { ctx: AgentContext; kind: RequestKind | 'ambos'; from: Date; to: Date; tipoSolicitud?: 'CFDI'; importedBy: string; actor: string; unattended: boolean; waitMs?: number; onProgress?: (m: string) => void; dryRun?: boolean; }
  export interface DownloadReport { requests: Array<{ id: string; kind: RequestKind; status: string; idSolicitud: string | null; codEstatus: string | null; mensaje: string | null; packages: number; ingested: number; duplicates: number; errors: number }>; }
  export async function runSatDownload(input: DownloadInput): Promise<DownloadReport>
  export async function resumePendingDownloads(ctx: AgentContext, opts: { actor: string; unattended: boolean; waitMs?: number; importedBy: string; onProgress?: (m: string) => void }): Promise<DownloadReport>
  export function requestFingerprint(d: { rfc: string; kind: RequestKind; tipoSolicitud: string; fechaInicial: string; fechaFinal: string; filters: Record<string, unknown> }): string

requestFingerprint = sha256 hex de un JSON con claves ordenadas alfabéticamente; misma combinación ⇒ misma huella. Los rangos se normalizan a segundo entero antes de calcularla, para que dos ejecuciones del mismo mes no produzcan huellas distintas por un milisegundo.

FASE 1 — solicitar (una withSatSession corta):
  1. Si !config.sat.downloadEnabled, error inmediato con instrucción de configuración.
  2. reserveQuota, en withTransaction, ANTES de tocar el SAT:
     INSERT INTO sat_download_quota (entity_id, tenant_id, fingerprint, descriptor, attempts) VALUES ($1,$2,$3,$4::jsonb,1)
     ON CONFLICT (entity_id, fingerprint) DO UPDATE SET attempts = sat_download_quota.attempts + 1, last_at = NOW()
     WHERE sat_download_quota.attempts < 2 AND NOT sat_download_quota.exhausted
     RETURNING attempts;
     Cero filas ⇒ throw new AccountingError('SAT_REQUEST_QUOTA_EXHAUSTED', …) con un mensaje que diga qué rango exacto está agotado y que la salida NO es reintentar sino cambiar la combinación (partir el mes en quincenas, o pedir sólo emitidos). Este guard es la razón de ser de la tabla: el límite del SAT es de por vida y un reintento a ciegas quema la única bala que queda.
     Nota sobre el ON CONFLICT: en el camino sin conflicto el INSERT devuelve attempts = 1; en el camino con conflicto, el WHERE del DO UPDATE hace que no se devuelva fila cuando ya se llegó a 2 o cuando exhausted. Esa es exactamente la semántica que se quiere, y es atómica frente a dos corridas simultáneas.
  3. INSERT en sat_download_requests con status 'submitted', la huella, el actor y unattended.
  4. solicitaDescarga. Según codEstatus:
     · '5000' ⇒ status 'accepted', id_solicitud guardado.
     · '5002' ⇒ en una transacción: UPDATE sat_download_quota SET exhausted = true, exhausted_at = NOW(), attempts = 2 WHERE …; UPDATE de la solicitud a 'rejected'; y throw AccountingError('SAT_REQUEST_QUOTA_EXHAUSTED'). A partir de aquí esa huella no se vuelve a intentar jamás, ni por cron ni a mano.
     · '5005' (duplicada) ⇒ devolver el cupo (UPDATE … SET attempts = GREATEST(attempts - 1, 0)) porque el SAT no la contó, marcar esta fila 'rejected' con el mensaje, y reengancharse a la solicitud abierta con la misma huella para seguir en la fase 2.
     · '5004' ⇒ status 'no_data', fin limpio (no es error).
     · resto ⇒ status 'failed' con last_error.
  5. dryRun: calcula huella, consulta el cupo consumido y devuelve el reporte SIN llamar al SAT ni consumir cupo.

FASE 2 — verificar y descargar (otra withSatSession corta, con tope de vida):
  Bucle sobre las solicitudes 'accepted'/'in_progress'/'ready' de la entidad. Espera con backoff: primer sondeo a los 30 s, multiplicador 1.5, tope 5 min por sondeo, y límite duro waitMs ?? 600000 (10 min) que además nunca supera la vida de la sesión. Si se acaba el tiempo, la fila queda 'in_progress' y la corrida termina con éxito parcial: la siguiente invocación (`--resume` o el cron) la retoma. Esto es deliberado: no se sostiene la e.firma descifrada durante la media hora que el SAT puede tardar.
  estadoSolicitud 3 ⇒ status 'ready', ready_at = NOW(), packages_expire_at = NOW() + INTERVAL '72 hours', numero_cfdis, e INSERT de una fila en sat_download_packages por cada IdPaquete. 1 o 2 ⇒ seguir. 4 ⇒ 'failed'. 5 ⇒ 'rejected'. 6 ⇒ 'expired'.
  Descarga de cada paquete 'pending' cuyo expires_at > NOW(): descargaPaquete, sha256 y tamaño a la fila, status 'downloaded'. Si expires_at <= NOW(): status 'expired' y un mensaje que advierta que recuperar ese periodo consumirá el cupo restante de la huella.

FASE 3 — ingesta (sin credencial):
  readZip sobre el paquete. Por cada entrada .xml: processXMLUpload(entityId, xml, 'sat_download', importedBy, { importBatchId: packageRow.id }). DuplicateError NO es error: cuenta como duplicate (es el caso normal cuando el mismo CFDI ya entró por `mnemosine ingest`). ValidationError y cualquier otra excepción se acumulan en errors JSONB por nombre de entrada y suben error_count, sin abortar el resto del paquete. Al terminar: status 'ingested', ingested_at, y los tres contadores. Cuando todos los paquetes de una solicitud quedan 'ingested' o 'expired', la solicitud pasa a 'completed'.
  El ZIP crudo NO se persiste (ver decisión): quedan sha256, tamaño y conteos como rastro auditable, y el XML íntegro ya vive en xml_documents.xml_content.

Cambio en el consumidor: ampliar la firma de PreRegistrationService.processXMLUpload (src/services/xml-ingestion/pre-registration-service.ts:43) — el tipo del parámetro `source` hoy es 'manual_upload' | 'email' | 'api' | 'sftp' y deja fuera 'sat_download', que el CHECK de la base sí admite. Extraer `export type XmlImportSource = 'manual_upload'|'email'|'api'|'sftp'|'sat_download'` y añadir un cuarto parámetro `options?: { importBatchId?: string }` que se pase al INSERT (columna import_batch_id, ya existente y hoy nunca escrita).

**Archivos**

- `/Users/victor/projects/Accounting/src/services/sat/download-service.ts` — crear: runSatDownload, resumePendingDownloads, requestFingerprint, reserveQuota
- `/Users/victor/projects/Accounting/src/services/xml-ingestion/pre-registration-service.ts` — modificar: exportar XmlImportSource con 'sat_download', añadir options.importBatchId y escribirlo en el INSERT de xml_documents
- `/Users/victor/projects/Accounting/src/api/rest/routes/xml-ingestion.ts` — modificar: validar `source` contra XmlImportSource en vez de z.string() (línea 18)

**Criterios de aceptación**

- Dada una huella con attempts=2, cuando se pide la misma combinación, entonces se lanza SAT_REQUEST_QUOTA_EXHAUSTED sin que se emita ninguna petición HTTP al SAT.
- Dada una respuesta 5002 del SAT, cuando termina la fase 1, entonces sat_download_quota.exhausted = true para esa huella y cualquier intento posterior falla en el guard local, no en el SAT.
- Dadas dos corridas concurrentes con la misma huella partiendo de attempts=1, entonces exactamente una obtiene cupo y la otra recibe SAT_REQUEST_QUOTA_EXHAUSTED.
- Dado un paquete listo, cuando se ingiere, entonces cada xml_documents insertado tiene import_source='sat_download' e import_batch_id igual al id de la fila de sat_download_packages.
- Dado un paquete cuyo expires_at ya pasó, cuando corre la fase 2, entonces la fila queda 'expired' y el reporte incluye la advertencia de cupo, sin intentar la descarga.
- Dado un ZIP con un XML corrupto y dos válidos, entonces ingested_count=2, error_count=1 y errors trae el nombre de la entrada fallida, y la solicitud igualmente llega a 'completed'.
- Dado un CFDI que ya existía por carga manual, cuando llega por descarga, entonces cuenta como duplicate y no se lanza excepción.

**Pruebas**

- `tests/sat/download-service.spec.ts` — reserveQuota: 1ª y 2ª pasan, 3ª lanza; con exhausted=true lanza desde la primera
- `tests/sat/download-service.spec.ts` — 5002 marca exhausted y deja la solicitud 'rejected'; 5005 devuelve el cupo y se reengancha a la solicitud abierta
- `tests/sat/download-service.spec.ts` — requestFingerprint es estable ante reordenamiento de claves de filters y cambia al cambiar el rango en un segundo
- `tests/sat/download-service.spec.ts` — fase 3 con processXMLUpload mockeado: DuplicateError cuenta como duplicado, ValidationError como error, y ninguno aborta el paquete
- `tests/sat/download-service.spec.ts` — paquete vencido (expires_at en el pasado) no se descarga y queda 'expired'

**Riesgo.** El error de este paquete que no se puede deshacer es quemar las dos solicitudes de por vida de un periodo. Mitigación en capas: guard local transaccional antes de la llamada, 5005 tratado como reenganche y no como intento nuevo, y --dry-run para que el operador vea el consumo antes de gastarlo.

##### `E3.2-g` Consulta real del estatus del CFDI: se acabó el 'Vigente' simulado · **M**

Crear src/services/sat/cfdi-status.ts y reescribir el cuerpo de SATValidationService sin cambiar su superficie (tiene dos llamadores vivos: pre-registration-service.ts:135 y su propio validateAndUpdate).

  export interface CfdiSatStatus { uuid: string; codigoEstatus: string; estado: string; esCancelable: string; estatusCancelacion: string | null; validacionEFOS: string | null; consultedAt: Date; }
  export async function consultaCfdi(input: { emisorRfc: string; receptorRfc: string; total: string; uuid: string }): Promise<CfdiSatStatus>

Este servicio NO usa la e.firma: la ConsultaCFDIService del SAT es anónima. Por tanto no pasa por withCredential y no consume cupo de credencial — decirlo en el encabezado del archivo, porque es contraintuitivo respecto del resto del paquete.

 · Endpoint config.sat.consultaUrl, SOAPAction "http://tempuri.org/IConsultaCFDIService/Consulta", cuerpo <Consulta xmlns="http://tempuri.org/"><expresionImpresa>?re=RE&rr=RR&tt=TT&id=UUID</expresionImpresa></Consulta>.
 · TT se formatea con Decimal(total).toFixed(6). Si la respuesta trae un CodigoEstatus que indica expresión impresa mal formada, se reintenta UNA vez con el total sin decimales de relleno (tal como aparece en el CFDI) y se registra cuál de las dos formas funcionó. Es un punto donde el SAT ha cambiado de criterio y conviene no ser dogmático.
 · Reintentos: withRetry(maxAttempts 3, initialDelayMs 1000) sólo para fallos de transporte. Concurrencia máxima 5 y 200 ms entre lotes en el barrido masivo.
 · config.sat.statusMode === 'off' ⇒ devuelve estado 'Consulta SAT deshabilitada' con codigoEstatus 'DISABLED'. NUNCA se devuelve 'Vigente' inventado: eliminar el bloque `if (process.env.PAC_ENVIRONMENT === 'sandbox')` de sat-validation.ts:34-43, que hoy fabrica un estatus favorable y es la razón por la que la capa fiscal cree que valida.

  export function toValidationStatus(s: CfdiSatStatus): 'valid'|'cancelled'|'not_found'|'error' — 'Vigente'→valid, 'Cancelado'→cancelled, 'No Encontrado'→not_found, resto→error.
  export function toClassifierStatus(s: 'valid'|'cancelled'|'not_found'|'error'|null): 'vigente'|'cancelado'|'no_encontrado'|'sin_validar' — el vocabulario exacto de ClassifyOptions.satStatus (cfdi-classifier.ts:86).

SATValidationService.validate delega en consultaCfdi y mapea con toValidationStatus. validateAndUpdate añade a su UPDATE la columna sat_validation_status ya existente y guarda estatusCancelacion/fechaCancelacion cuando vienen.

Barrido de re-validación:
  export async function revalidateEntityCfdis(ctx: AgentContext, opts: { limit?: number; staleHours?: number; sinceMonths?: number }): Promise<{ checked: number; changed: Array<{ uuid: string; from: string | null; to: string }>; errors: number }>
  Selecciona de xml_documents de la entidad, usando idx_xml_docs_sat_recheck: los que tienen sat_validation_status NULL/'pending'/'error', más los 'valid' con sat_validated_at < NOW() - staleHours (168 h por defecto), limitando a cfdi_fecha > NOW() - sinceMonths (24 por defecto). Los 'cancelled' son terminales y no se vuelven a consultar. ORDER BY sat_validated_at NULLS FIRST LIMIT opts.limit ?? 200.

Y el hilo suelto que el atlas señala: en pre-registration-service.ts:135 la validación en segundo plano sólo hace console.error. Cambiar dos cosas: (i) el INSERT de xml_documents fija sat_validation_status = 'pending' explícitamente (hoy queda NULL y el barrido no tendría forma barata de encontrarlo); (ii) el .catch escribe UPDATE xml_documents SET sat_validation_status='error', sat_estado = <mensaje truncado a 50>, sat_validated_at = NOW(), de modo que un fallo quede como dato re-intentable por el barrido y no como una línea perdida en la consola.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/sat/cfdi-status.ts` — crear: consultaCfdi, toValidationStatus, toClassifierStatus, revalidateEntityCfdis
- `/Users/victor/projects/Accounting/src/services/xml-ingestion/sat-validation.ts` — modificar: eliminar la simulación por PAC_ENVIRONMENT, delegar validate en consultaCfdi, persistir sat_validation_status en validateAndUpdate
- `/Users/victor/projects/Accounting/src/services/xml-ingestion/pre-registration-service.ts` — modificar: sat_validation_status='pending' en el INSERT; el catch de la validación en segundo plano persiste el error en vez de sólo console.error

**Criterios de aceptación**

- Dado PAC_ENVIRONMENT=sandbox, cuando se valida cualquier CFDI, entonces NO se devuelve 'Vigente': o se consulta de verdad, o se devuelve 'DISABLED' si statusMode='off'.
- Dada una respuesta del SAT con Estado 'Cancelado' y EstatusCancelacion 'Cancelado sin aceptación', entonces xml_documents queda con sat_validation_status='cancelled', sat_estado='Cancelado', sat_efecto_cancelacion poblado y sat_validated_at reciente.
- Dado un CFDI recién ingerido, cuando falla la consulta de fondo, entonces su sat_validation_status es 'error' (no NULL) y el barrido lo vuelve a tomar en la siguiente pasada.
- Dado un CFDI ya 'cancelled', cuando corre revalidateEntityCfdis, entonces no se vuelve a consultar.
- Dado un lote de 50 CFDI, cuando corre el barrido, entonces se emiten como mucho 5 consultas simultáneas.

**Pruebas**

- `tests/sat/cfdi-status.spec.ts` — consultaCfdi parsea las tres respuestas típicas (Vigente, Cancelado, No Encontrado) y mapea a los dos vocabularios
- `tests/sat/cfdi-status.spec.ts` — statusMode='off' nunca devuelve 'valid'
- `tests/sat/cfdi-status.spec.ts` — revalidateEntityCfdis excluye los 'cancelled' y ordena por sat_validated_at NULLS FIRST
- `tests/xml-ingestion/sat-validation.spec.ts` — validateAndUpdate escribe sat_validation_status y no inventa estatus cuando la consulta falla

**Riesgo.** El formato de expresionImpresa (relleno del total) es el punto histórico de fricción; por eso el reintento con la forma alternativa y el registro de cuál funcionó.

##### `E3.2-h` Propagar el estatus al clasificador y activar de verdad la decisión cfdi_cancelado · **S**

El clasificador ya tiene el hueco abierto: classifyParsed empuja getDecision('cfdi_cancelado') cuando opts.satStatus === 'cancelado' (cfdi-classifier.ts:150-153) y avisa 'no validado' cuando llega undefined o 'sin_validar' (líneas 154-156). La decisión cfdi_cancelado declara applies: () => false con el comentario 'activated by the SAT validation' (cfdi-decisions.ts:308). Falta el proveedor del dato.

Añadir en src/services/sat/cfdi-status.ts:
  export async function loadSatStatus(entityId: string, uuid: string): Promise<'vigente'|'cancelado'|'no_encontrado'|'sin_validar'>
  — SELECT sat_validation_status FROM xml_documents WHERE entity_id = $1 AND cfdi_uuid = $2, mapeado con toClassifierStatus; NULL/'pending' ⇒ 'sin_validar'. Es una lectura local: no consulta al SAT en línea (el clasificador no debe depender de la latencia ni la disponibilidad del SAT).
  export async function loadSatStatusMap(entityId: string, uuids: string[]): Promise<Map<string, …>> para el lote.

En el punto donde E3.1 llama a classifyParsed/classifyXml, pasar satStatus: await loadSatStatus(ctx.entityId, uuid) dentro de ClassifyOptions. Si E3.1 aún no ha aterrizado, dejar la función exportada y probada y cablearla en el mismo commit en que exista el llamador — pero NO dar el paquete por cerrado con loadSatStatus sin consumidor, que es exactamente la patología que este atlas viene señalando.

Segundo cableado, en la ruta viva: el prompt de ingesta (buildCfdiPrompt, src/ai/ingest-service.ts:370) no menciona el estatus. Añadir una línea al bloque CFDI: `- Estatus ante el SAT: <vigente|cancelado|no encontrado|sin validar>` y, cuando sea 'cancelado', una instrucción explícita de NO crear borrador y usar ask_user. Un CFDI cancelado no soporta deducción (CFF 29-A, la base que ya cita la decisión) y el modelo no tiene por qué deducirlo por su cuenta.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/sat/cfdi-status.ts` — modificar: añadir loadSatStatus y loadSatStatusMap
- `/Users/victor/projects/Accounting/src/ai/ingest-service.ts` — modificar: buildCfdiPrompt incluye el estatus SAT y la instrucción de bloqueo cuando es 'cancelado'
- `/Users/victor/projects/Accounting/src/services/xml-ingestion/cfdi-decisions.ts` — modificar: sustituir el comentario 'activated by the SAT validation' por la referencia concreta a loadSatStatus, para que el próximo lector encuentre al proveedor

**Criterios de aceptación**

- Dado un CFDI con sat_validation_status='cancelled', cuando se clasifica, entonces Classification.decisions incluye 'cfdi_cancelado' con severity 'blocking' y el veredicto es 'needs_input'.
- Dado un CFDI con sat_validation_status='valid', cuando se clasifica, entonces warnings NO contiene el aviso 'no ha sido validado ante el SAT'.
- Dado un CFDI sin validar, cuando se clasifica, entonces sí aparece ese aviso (comportamiento actual preservado).
- Dado un CFDI cancelado, cuando corre `mnemosine ingest` sobre él, entonces el prompt enviado al modelo contiene el estatus y la instrucción de no crear borrador.

**Pruebas**

- `tests/sat/cfdi-status.spec.ts` — loadSatStatus mapea los cinco valores de columna a los cuatro del clasificador
- `tests/xml-ingestion/cfdi-classifier-sat.spec.ts` — classifyParsed con satStatus 'cancelado' incorpora la decisión bloqueante; con 'vigente' desaparece el warning
- `tests/ai/ingest-service.spec.ts` — buildCfdiPrompt incluye la línea de estatus y, si es cancelado, la instrucción de bloqueo

**Riesgo.** Si E3.1 no ha cableado el clasificador, esta tarea queda a medias. Está declarada como dependencia del paquete precisamente por eso.

##### `E3.2-i` La factura ya contabilizada que el emisor canceló después: detección y corrección por reversa · **M**

Crear src/services/sat/status-reconciler.ts. Es la parte contable del paquete y la que más criterio exige: se propone, no se ejecuta sola.

  export interface CancelledAfterPosting { xmlDocumentId: string; uuid: string; emisorRfc: string; emisorNombre: string | null; total: string; cancelledAt: Date | null; journalEntryId: string; entryNumber: string; entryDate: Date; billId: string | null; billAmountPaid: string | null; via: 'pre_registration' | 'reference'; }
  export async function findCancelledAfterPosting(ctx: AgentContext): Promise<CancelledAfterPosting[]>

Dos vías de enlace, porque hay dos rutas de contabilización y ninguna comparte tabla:
  (i) la ruta de reglas: xml_documents JOIN pre_registrations p ON p.xml_document_id = x.id JOIN journal_entries je ON je.id = p.journal_entry_id;
  (ii) la ruta de IA: journal_entries je ON right(je.reference, 36) = x.cfdi_uuid — usa idx_je_reference_uuid de E3.2-a y funciona porque buildCfdiPrompt obliga a que la referencia termine en el UUID.
Filtros comunes: x.entity_id = ctx.entityId, x.sat_validation_status = 'cancelled', je.status = 'posted', je.reversed_by_entry_id IS NULL. UNION de las dos vías deduplicando por journal_entry_id.

  export async function proposeCorrection(ctx: AgentContext, item: CancelledAfterPosting, model?: string): Promise<{ questionId: string; alreadyOpen: boolean }>
  — Crea una pregunta con createQuestion(ctx, { question, context, options: ['revertir','conservar','investigar'], topic: 'cfdi_cancelado', model: model ?? 'sat-status-reconciler' }). ai_model es NOT NULL en ai_questions; se usa un identificador de productor determinista y se documenta que esta pregunta no la generó un modelo. Idempotencia: antes de insertar, buscar una pregunta pending con topic='cfdi_cancelado' cuyo context contenga el UUID; si existe, devolver alreadyOpen: true sin crear otra. El contexto debe traer UUID, emisor, importe, número de póliza, fecha del asiento y fecha de cancelación: quien responda tiene que poder decidir sin abrir otra herramienta.

  export async function applyCorrection(ctx: AgentContext, item: CancelledAfterPosting, user: Reviewer, opts?: { reversalDate?: Date; questionId?: string }): Promise<{ reversalEntryNumber: string }>
  — Rechaza de entrada si item.billAmountPaid > 0: una factura cancelada que ya se pagó no se arregla con una reversa (queda un pago sin documento que lo soporte y hay que decidir si se reclama al proveedor o se reclasifica); en ese caso lanza AccountingError('CFDI_CANCELLED_ALREADY_PAID', …) y deja la pregunta abierta.
  — Todo lo demás corre en UNA withTransaction, respetando la convención del repositorio: la corrección es por reversa (NIF B-1), nunca edición.
      1. SELECT … FROM bills WHERE id = $1 FOR UPDATE (si hay bill).
      2. const { reversal } = await voidJournalEntryInTx(client, item.journalEntryId, user.userId, `CFDI ${uuid} cancelado ante el SAT el ${fecha}`, opts?.reversalDate) — hay que añadir a voidJournalEntryInTx (src/services/accounting/posting.ts:438) un quinto parámetro opcional `reversalDate?: Date` que se pase a reverseWithinTransaction, que ya lo acepta; hoy está fijado a new Date() en la línea 467 y sin eso no se puede fechar la corrección en el periodo correcto.
      3. UPDATE bills SET status='cancelled', amount_due = 0 WHERE id = $1 (sólo si amount_paid = 0).
      4. UPDATE pre_registrations SET status='rejected', error_message = … WHERE xml_document_id = $1; UPDATE xml_documents SET processing_status='rejected' WHERE id = $1. Ambos valores están en los CHECK de 005_xml_ingestion.sql.
      5. Si opts.questionId, answerQuestion(ctx, questionId, 'revertir', user.email, false) para que el tablero no quede con una duda ya resuelta.
  — Tras el commit, y sólo entonces: attestEntryAsync(ctx.tenantId, ctx.entityId, reversal.id). Es la regla que el docstring de voidJournalEntryInTx exige (posting.ts:429-430) y la razón de usar la variante InTx en vez de voidJournalEntry.
  — Si createJournalEntry lanza PERIOD_CLOSED al construir la reversa, se propaga con un mensaje que diga que hay que abrir el periodo o pasar otra fecha; no se busca un periodo alternativo por cuenta propia.

**Archivos**

- `/Users/victor/projects/Accounting/src/services/sat/status-reconciler.ts` — crear: findCancelledAfterPosting, proposeCorrection, applyCorrection
- `/Users/victor/projects/Accounting/src/services/accounting/posting.ts` — modificar: voidJournalEntryInTx acepta reversalDate?: Date y lo pasa a reverseWithinTransaction (hoy fijo en new Date(), línea 467)

**Criterios de aceptación**

- Dado un CFDI contabilizado por la ruta de reglas que el SAT reporta cancelado, cuando corre findCancelledAfterPosting, entonces aparece una fila con via='pre_registration' y el número de póliza correcto.
- Dado un CFDI contabilizado por la ruta de IA (referencia '<serie><folio> · <uuid>'), entonces aparece con via='reference'.
- Dado un asiento ya revertido (reversed_by_entry_id NO nulo), entonces NO aparece en la lista.
- Dado un caso detectado y sin confirmación humana, cuando corre proposeCorrection, entonces existe exactamente una pregunta pending con topic 'cfdi_cancelado' para ese UUID, y una segunda ejecución devuelve alreadyOpen sin duplicarla.
- Dado un caso con bills.amount_paid > 0, cuando se llama applyCorrection, entonces lanza CFDI_CANCELLED_ALREADY_PAID y no se crea ningún asiento.
- Dado un caso confirmado, cuando corre applyCorrection, entonces el asiento original sigue 'posted' con reversed_by_entry_id apuntando al espejo, existe una póliza de reversa con importes invertidos, la factura queda 'cancelled' con amount_due=0 y la atestación se dispara UNA sola vez y después del commit.
- Dado que el periodo de la fecha de reversa está cerrado, entonces se propaga PERIOD_CLOSED con instrucción explícita y nada se escribe.

**Pruebas**

- `tests/sat/status-reconciler.spec.ts` — findCancelledAfterPosting arma la UNION de las dos vías y deduplica por journal_entry_id
- `tests/sat/status-reconciler.spec.ts` — proposeCorrection es idempotente por UUID
- `tests/sat/status-reconciler.spec.ts` — applyCorrection rechaza cuando amount_paid > 0
- `tests/sat/status-reconciler.spec.ts` — applyCorrection llama attestEntryAsync una vez y después de que la transacción confirmó (orden verificable con mocks)
- `tests/accounting/posting-reversal-date.spec.ts` — voidJournalEntryInTx con reversalDate fecha la reversa en esa fecha y no en hoy

**Riesgo.** Es la única parte del paquete que escribe en el mayor. Dos salvaguardas: nunca corre sin confirmación explícita (o queda como pregunta), y nunca corre si la factura tiene pagos aplicados. La tercera salvaguarda ya existe y es la reversa: no se edita ni se borra nada.

##### `E3.2-j` CLI: `mnemosine sat download` y `mnemosine sat verify` · **M**

Ampliar src/cli/sat-commands.ts, que hoy declara `sat` como 'SAT services (credentials and CFDI download)' (línea 64) y sólo cuelga `cred`. Reutilizar SatCommandDeps tal cual está.

`sat download` (alias `descarga`):
  -e, --entity <idOrName>; --from <YYYY-MM-DD>; --to <YYYY-MM-DD> (por defecto, el mes calendario anterior completo); --type <emitidos|recibidos|ambos> (por defecto ambos); --resume (sólo continúa solicitudes abiertas, no crea ninguna nueva ni consume cupo); --unattended (actor 'scheduler', sin ningún prompt, pensado para cron); -u, --user <email> (a quién se atribuye la importación); --wait <min> (por defecto 10); --dry-run.
  Flujo: resolveEntity → resolveReviewer (con la regla de importedBy de abajo) → runSatDownload/resumePendingDownloads → tabla de resultados por solicitud con id_solicitud, estado, CFDI encontrados, ingeridos, duplicados y errores. Códigos de salida: 0 éxito o éxito parcial ('in_progress' es éxito parcial legítimo), 1 error o cupo agotado.
  importedBy en modo desatendido: no hay operador que resolver. Se toma consent_by de la credencial activa (fiscal_credentials.consent_by, un email) y se resuelve a users.id; quien autorizó la e.firma es quien responde por las descargas hechas con ella. Si ese usuario no existe o está inactivo, se falla con un mensaje que pida --user; no se inventa un UUID.
  Antes de emitir una solicitud nueva en modo atendido, imprimir la huella y el cupo restante ('esta combinación ha usado 1 de 2 solicitudes de por vida') y, si el cupo restante es 1, pedir confirmación explícita salvo --unattended.

`sat verify` (alias `verificar`) — el nombre evita chocar con `sat cred status|estado`, que ya existe:
  -e, --entity; --uuid <uuid> (uno solo); --stale <horas> (por defecto 168); --limit <n> (por defecto 200); --reconcile (busca cancelados ya contabilizados); --confirm (aplica la reversa; sin él sólo propone y deja pregunta); -u, --user <email>.
  Sin --reconcile: corre revalidateEntityCfdis y lista los cambios de estatus. Con --reconcile: además corre findCancelledAfterPosting y, por cada caso, proposeCorrection; con --confirm, pide confirmación por caso (escribir el número de póliza, mismo patrón que `sat cred revoke` pide el RFC) y llama applyCorrection.

Bilingüismo: tests/cli/bilingual-matrix.spec.ts fija la política de que todo nombre canónico es inglés y toda diferencia tiene alias español. Añadir un mapa SAT_SUB = { cred: '', download: 'descarga', verify: 'verificar' } y una prueba sobre help('sat') análoga a la de sat cred.

Regenerar la referencia que lee el agente: `npx tsx scripts/generate-cli-reference.ts` reescribe src/ai/docs/cli-reference.md desde el propio árbol de commander. Y añadir la descarga a los dos documentos que hoy describen el flujo de e.firma sin poder cerrarlo: src/ai/docs/playbooks.md:67-69 y src/ai/docs/mnemosine.md:24.

**Archivos**

- `/Users/victor/projects/Accounting/src/cli/sat-commands.ts` — modificar: registrar los subcomandos download y verify bajo el comando `sat` existente
- `/Users/victor/projects/Accounting/tests/cli/bilingual-matrix.spec.ts` — modificar: añadir SAT_SUB y la prueba sobre help('sat')
- `/Users/victor/projects/Accounting/src/ai/docs/cli-reference.md` — modificar: regenerar con scripts/generate-cli-reference.ts (no editar a mano)
- `/Users/victor/projects/Accounting/src/ai/docs/playbooks.md` — modificar: cerrar el playbook de e.firma con el paso de descarga y el de verificación
- `/Users/victor/projects/Accounting/src/ai/docs/mnemosine.md` — modificar: añadir `sat download` y `sat verify` a la lista de comandos

**Criterios de aceptación**

- Dado `mnemosine sat --help`, entonces aparecen download|descarga y verify|verificar junto a cred.
- Dado `mnemosine sat download --dry-run --from 2026-07-01 --to 2026-07-31`, entonces imprime la huella y el cupo consumido, no emite ninguna petición al SAT y sat_download_quota queda intacta.
- Dado un cupo agotado, cuando se corre `sat download` sobre ese rango, entonces el mensaje dice qué rango está agotado y sugiere partirlo, y el código de salida es 1.
- Dado `--unattended` sin --user y con una credencial cuyo consent_by no corresponde a un usuario activo, entonces falla pidiendo --user en vez de continuar.
- Dado `mnemosine sat verify --reconcile` sin --confirm sobre un CFDI cancelado y contabilizado, entonces se crea la pregunta, no se escribe ningún asiento y `mnemosine questions` la muestra.
- Dado el mismo caso con --confirm y confirmación del número de póliza, entonces se crea la reversa y `mnemosine sat verify --reconcile` deja de listarlo.
- Dado que se corre scripts/generate-cli-reference.ts, entonces cli-reference.md contiene la ayuda de los dos comandos nuevos y el test bilingüe pasa.

**Pruebas**

- `tests/cli/bilingual-matrix.spec.ts` — los subcomandos de sat muestran su alias español
- `tests/cli/sat-commands.spec.ts` — download en --dry-run no llama al servicio de descarga y sí imprime el cupo; verify sin --confirm nunca llama applyCorrection

##### `E3.2-k` Modo desatendido: dos tipos de tarea deterministas en el planificador que ya existe · **M**

El repositorio ya tiene planificador propio: ai_jobs + claimDueJobs (reclamo atómico por UPDATE guardado, job-store.ts) + `mnemosine jobs run-due`, que jobs-command.ts:164 describe como 'call this from cron/launchd'. Colgar de ahí la descarga y no de una línea suelta de crontab da tres cosas que aquí valen mucho: reclamo atómico (dos hosts no pueden lanzar la misma descarga y quemar cupo), historial en ai_job_runs y auto-desactivación tras N fallos consecutivos.

Pero runDueJobs sólo sabe despertar al agente. Hay que abrirle una segunda vía, DETERMINISTA:
  1. Migración 032_sat_jobs.sql: ALTER TABLE ai_jobs DROP CONSTRAINT ai_jobs_kind_check; ADD CONSTRAINT ai_jobs_kind_check CHECK (kind IN ('close_verification','cfdi_reconciliation','ar_reminders','sat_download','sat_status_refresh')).
  2. job-store.ts: añadir los dos valores a JobKind y a JOB_KINDS.
  3. wake-gate.ts: checkForWork tiene un `const never: never = kind` en el default (línea 41), así que ampliar JobKind rompe la compilación hasta que se añadan casos. Añadir `case 'sat_download': case 'sat_status_refresh': throw new Error('deterministic kinds do not use the wake gate')` — el error es inalcanzable en producción y deja el exhaustive check vivo.
  4. runner.ts: registro `const DETERMINISTIC_EXECUTORS: Partial<Record<JobKind, (ctx: AgentContext, job: JobRow) => Promise<{ status: 'ok'|'skipped_no_work'|'error'; detail: string; payload: Record<string, unknown> }>>>` con sat_download → resumePendingDownloads seguido de runSatDownload del periodo por defecto, y sat_status_refresh → revalidateEntityCfdis + findCancelledAfterPosting + proposeCorrection por cada hallazgo. En runDueJobs, tras reclamar el trabajo: si su kind está en el registro, se ejecuta el ejecutor y se registra con recordRun por el mismo safeRecord, SIN pasar por checkForWork ni por runAgentTurn (el LLM no se invoca nunca en estos dos tipos, coste de tokens cero por diseño).
  5. Actualizar el comentario de cabecera de runner.ts: hoy afirma 'The runner itself NEVER writes the ledger or external systems'. Sigue siendo cierto para el mayor —estas tareas escriben xml_documents/pre_registrations y preguntas, nunca pólizas— pero ya no lo es para 'external systems'. Escribir la frase nueva con precisión: los tipos deterministas hablan con el SAT y registran documentos; toda consecuencia contable sigue saliendo como borrador o pregunta revisable.

Parámetros del trabajo: actor 'scheduler', unattended: true (es el actor que 014_fiscal_credentials.sql:75 ya contemplaba y que withCredential comprueba contra unattended_access). Cadencia sugerida en la documentación: sat_download '0 7 * * *' y sat_status_refresh '0 5 * * 1'. Con la política efirma_max_accesos_diarios por defecto en 24, una descarga diaria de dos fases consume 2 de 24.

Si una credencial tiene unattended_access = false, el ejecutor recibe CredentialAccessDenied y debe registrar el run como 'error' con un detalle legible ('la credencial no permite uso desatendido: corre `mnemosine sat download` con un operador presente'), no como una excepción cruda. Tres fallos así desactivan el trabajo por el mecanismo que ya existe, que es el comportamiento correcto.

**Archivos**

- `/Users/victor/projects/Accounting/src/database/migrations/032_sat_jobs.sql` — crear: ampliar el CHECK de ai_jobs.kind con sat_download y sat_status_refresh
- `/Users/victor/projects/Accounting/src/ai/jobs/job-store.ts` — modificar: JobKind y JOB_KINDS ganan los dos tipos
- `/Users/victor/projects/Accounting/src/ai/jobs/wake-gate.ts` — modificar: casos explícitos para los tipos deterministas, preservando el exhaustive check
- `/Users/victor/projects/Accounting/src/ai/jobs/runner.ts` — modificar: registro DETERMINISTIC_EXECUTORS, rama previa al wake-gate y corrección del comentario de cabecera

**Criterios de aceptación**

- Dado `mnemosine jobs create --kind sat_download --schedule '0 7 * * *'`, entonces la fila se inserta y el CHECK la acepta.
- Dado un trabajo sat_download vencido, cuando corre `mnemosine jobs run-due`, entonces se ejecuta la descarga, NO se invoca checkForWork ni runAgentTurn, y ai_job_runs registra el resultado con el detalle de solicitudes y paquetes.
- Dados dos `jobs run-due` simultáneos, entonces sólo uno reclama el trabajo (garantía ya existente de claimDueJobs) y sólo se emite una solicitud al SAT.
- Dada una credencial con unattended_access=false, entonces el run queda 'error' con mensaje accionable y al tercer fallo consecutivo el trabajo se auto-desactiva.
- Dado que se añadieron los tipos, entonces `npm run typecheck` pasa (el exhaustive check de wake-gate obliga a declararlos).

**Pruebas**

- `tests/ai/jobs/runner.spec.ts` — añadir: un kind determinista se ejecuta por su ejecutor y jamás llama gate ni runAgentTurn
- `tests/ai/jobs/runner.spec.ts` — un ejecutor determinista que lanza CredentialAccessDenied produce un run 'error' con detalle legible y no tumba el resto del tick
- `tests/ai/jobs/job-store.spec.ts` — JOB_KINDS contiene los cinco tipos

**Riesgo.** Se ensancha el contrato del runner, que era deliberadamente estrecho. Mitigación: el ensanchamiento es explícito (registro nombrado, comentario reescrito, test que fija que el LLM no se invoca) y la frontera contable se mantiene: estas tareas no escriben en el mayor.

#### Cómo se sabe que cerró

- `npm run migrate` corre limpio desde 030 y `SELECT tablename FROM pg_policies WHERE policyname='tenant_isolation'` incluye sat_download_requests, sat_download_quota y sat_download_packages.
- `npm test` pasa e incluye los archivos nuevos tests/sat/{xmldsig,soap-client,auth,bulk-download,unzip,download-service,cfdi-status,status-reconciler}.spec.ts.
- `npm run typecheck` pasa tras ampliar JobKind (el exhaustive check de wake-gate.ts es el detector).
- Contra el entorno de pruebas del SAT con una e.firma real: `mnemosine sat download --from <mes> --to <mes> --type recibidos` termina con al menos una fila en sat_download_requests con status 'completed' y `SELECT count(*) FROM xml_documents WHERE import_source='sat_download'` devuelve un número mayor que cero.
- `SELECT count(*) FROM fiscal_credential_access_log WHERE purpose='sat_auth'` es mayor que cero y no supera 2 por corrida de descarga: el propósito del enum deja de ser teórico y la sesión no multiplica desencriptaciones.
- Repetir tres veces la misma combinación de rango: la tercera falla con SAT_REQUEST_QUOTA_EXHAUSTED sin emitir tráfico al SAT (verificable porque no aparece una tercera fila con cod_estatus poblado).
- `grep -rn "PAC_ENVIRONMENT" src/services/xml-ingestion/sat-validation.ts` no devuelve nada: no queda ninguna ruta que fabrique un 'Vigente'.
- `SELECT count(*) FROM xml_documents WHERE sat_validation_status IS NULL` es cero para las entidades con descarga activa, y `mnemosine sat verify` reporta al menos una consulta real con su estado.
- Con un CFDI cancelado que ya estaba contabilizado: `mnemosine sat verify --reconcile` crea la pregunta, y con --confirm existe una póliza de reversa cuyo reverses_entry_id apunta al asiento original, que sigue 'posted' con reversed_by_entry_id poblado.
- `mnemosine jobs create --kind sat_download --schedule '0 7 * * *'` seguido de `mnemosine jobs run-due` deja una fila en ai_job_runs con status 'ok' y drafts_created = 0, y el registro de uso de tokens (mnemosine usage) no crece: el LLM no se invocó.
- `npx tsx scripts/generate-cli-reference.ts` no deja diff pendiente y tests/cli/bilingual-matrix.spec.ts pasa con los dos subcomandos nuevos.


## E4 · Cerrar los ciclos

### E4.1 · Cerrar el ciclo contable de banca y de nómina
**Objetivo.** Que conciliar y correr nómina dejen huella contable comprobable: cada match queda ligado a una sesión y marca la línea del mayor como conciliada una sola vez, las comisiones e intereses del estado de cuenta llegan al libro por asiento posteado, 'balanced' pasa a ser una variancia calculada dentro de tolerancia, y una corrida de nómina persiste su desglose fiscal (paycheck_taxes), genera sus pasivos de entero (employer_tax_liabilities) y entrega en efectivo el subsidio al empleo que hoy se trunca.

**Por qué aquí.** Va después de que account_roles se siembre desde `mnemosine init` (E1.1) porque los asientos de comisiones/intereses y el mapeo de nómina se resuelven por rol, no por código literal; y después del test de contrato SQL↔migraciones (E1.4) porque este paquete toca cinco consultas que hoy referencian columnas inexistentes (form-940 pide `p.futa_employer` cuando la columna es `futa`) y sin ese test la regresión vuelve. Va antes del runtime de trabajos en segundo plano: el barrido de vencimientos de employer_tax_liabilities y el auto-match programado necesitan que el efecto contable ya exista y sea idempotente, no al revés. Y no puede esperar más porque hoy `POST /reconciliations/:id/complete` estampa 'balanced' sin comprobar nada y `POST /pay-runs/:id/post-to-gl` puede postear dos veces la misma corrida.

**Depende de:** `E0.2`, `E1.1`, `E1.4` · **Migraciones:** `047-050` · **13 tareas · 8.4 sem-persona**

**Precondiciones:**

- E1.1 cerrado: seedAccountRoles se ejecuta desde `mnemosine init` y una entidad nueva tiene las 31 filas de account_roles. Verificable con: SELECT COUNT(*) FROM account_roles WHERE entity_id = $1 → 31 antes de empezar E4.1-d.
- E1.4 cerrado: existe el test de contrato SQL↔migraciones. Este paquete corrige una desalineación que ese test debe detectar (form-940-generator.ts:41-45 usa p.futa_employer; la columna real es paychecks.futa).
- Base de desarrollo migrada hasta 030 y con las políticas RLS reaplicadas desde src/database/rls-policies.sql (el runner de migraciones ya lo hace; confirmar tras aplicar 031).
- tax_tables tiene las tarifas MX 2026 sembradas por 009_tax_tables_2026.sql (ISR mensual y quincenal, y la tabla de subsidio al empleo, líneas 183-194) y tax_parameters tiene uma_daily e imss_employee/imss_employer para 'MX'.

#### Decisiones a resolver

**¿Qué régimen del subsidio al empleo aplica para el año fiscal que el sistema va a calcular: el tabular con entrega en efectivo del excedente, o el de porcentaje fijo de UMA en el que el subsidio no puede exceder al ISR ni entregarse en efectivo?**

La base tiene sembrada la tabla clásica del subsidio (009_tax_tables_2026.sql:183-194, con 407.02 / 406.83 / 406.62 …), que es la del régimen tabular con entrega en efectivo, y el comentario del código (paycheck-service.ts:246) afirma esa mecánica mientras la línea siguiente la trunca. Si el régimen aplicable es el de porcentaje fijo de UMA, la respuesta correcta no es entregar el excedente sino que nunca haya excedente. La diferencia se ve en el neto del trabajador y en un saldo a favor del patrón; equivocarla en cualquiera de los dos sentidos es un error de nómina real.

- Tabular con entrega en efectivo: subsidio_entregado = max(0, subsidio − ISR), sale en el neto y genera saldo a favor del patrón (cuenta 1145).
- Porcentaje fijo de UMA sin entrega: subsidio_aplicado = min(subsidio, ISR) y subsidio_entregado siempre 0; la tabla sembrada se sustituye por un parámetro en tax_parameters.
- Conmutable por año: un parámetro `subsidio_regimen` en tax_parameters ('tabular' | 'uma_fijo') decide, y ambos caminos quedan implementados y probados.

_Recomendación:_ La tercera. Implementar el reparto aplicado/entregado tal como lo especifica E4.1-i (que es correcto en ambos regímenes: en el de UMA fijo simplemente entregado sale 0) y leer el régimen de tax_parameters por año, nunca de una constante en TypeScript. Así el cambio de régimen es un UPDATE de una fila, no un despliegue, y el E2E puede probar los dos casos.

_Bloquea:_ E4.1-i (la fórmula) y, por dependencia, E4.1-j (la línea de subsidio_empleo_receivable) y el caso 5 del E2E de E4.1-m. El resto del paquete no depende de esto.

**¿El asiento de nómina abona el neto directamente a banco, o a un pasivo 'Sueldos por Pagar' que se cancela con un segundo asiento al dispersar?**

El bucket se llama cash_payroll y hoy nadie lo mapea, así que la pregunta nunca se ha respondido. El catálogo sembrado tiene 2160 Sueldos por Pagar (creada por REQUIRED_ACCOUNTS, account-roles-seed.ts) y 1110 Caja y Bancos. markPayRunPaid (pay-run-service.ts:129) hoy sólo cambia un status y no genera ningún asiento.

- Banco directo: cash_payroll → rol 'banco' (1110). Un solo asiento; el devengo y el pago coinciden en fecha.
- Pasivo y dispersión: cash_payroll → rol 'sueldos_por_pagar' (2160), y markPayRunPaid emite DR Sueldos por Pagar / CR Banco (tarea E4.1-l).

_Recomendación:_ La segunda. La nómina se devenga en la fecha de pago del periodo y se dispersa después (SPEI/NACHA), a veces al día siguiente y desde una cuenta distinta; abonar banco en el devengo hace imposible conciliar la dispersión contra el estado de cuenta, que es justamente la otra mitad de este paquete. Con el pasivo, la transferencia real aparece como una transacción bancaria que concilia contra el asiento de dispersión.

_Bloquea:_ El valor de cash_payroll en PAYROLL_BUCKET_ROLE_MAP (E4.1-g) y la existencia misma de E4.1-l.

**¿El calendario de entero de los pasivos fiscales se toma como una constante por jurisdicción o se configura por entidad?**

employer_tax_liabilities.due_date y deposit_frequency son NOT NULL y nadie los escribe. En EE. UU. la frecuencia de depósito federal depende del historial de obligaciones del patrón (mensual o semi-semanal), y hay reglas de depósito al día siguiente por umbral; en México los enteros de retenciones y las cuotas IMSS tienen su propio día del mes siguiente. Poner una constante equivocada produce enteros tardíos con recargos reales.

- Constante por jurisdicción en depositDueDate: mensual, día 15 para US-FEDERAL y día 17 para MX.
- Configurable por entidad: una columna o fila de configuración con deposit_frequency por jurisdicción, que depositDueDate consulta.
- Configurable por entidad y con la regla completa del calendario federal estadounidense (semi-semanal y depósito al día siguiente por umbral).

_Recomendación:_ La primera para cerrar E4.1-j, con la función depositDueDate aislada, pura y probada, y una nota en su docstring de que es una aproximación. La segunda como sucesor inmediato cuando exista la primera entidad estadounidense real. La tercera sólo con un cliente estadounidense en producción: implementarla antes es adivinar un calendario que nadie está usando.

_Bloquea:_ E4.1-j (el valor de due_date y deposit_frequency de cada fila).

**¿El asiento de ajuste de la conciliación desglosa el IVA de las comisiones bancarias?**

Las comisiones bancarias mexicanas llevan IVA y el banco emite su propio CFDI. Si el ajuste registra el importe bruto contra Gastos Financieros, el gasto queda inflado y el IVA no se acredita hasta que se ingiera el CFDI del banco; si el ajuste desglosa el IVA, se acredita un impuesto sin comprobante fiscal en la mano, que es justo lo que el clasificador CFDI existe para evitar.

- Bruto contra Gastos Financieros; el IVA se acredita cuando se ingiera el CFDI del banco, y ese asiento reclasifica.
- Desglosar IVA en el ajuste con la tasa configurada de la entidad, y conciliar después contra el CFDI del banco.
- No contabilizar comisiones desde la conciliación: exigir siempre el CFDI del banco por la vía de ingesta.

_Recomendación:_ La primera, que es lo que especifica E4.1-d. Es conservadora fiscalmente (no adelanta acreditamiento sin comprobante), no bloquea el cierre de la conciliación, y la línea deja el identificador del movimiento del estado en la descripción para poder ligarla al CFDI cuando llegue. La tercera es la más pura pero deja la conciliación descuadrada hasta que el CFDI aparezca, que es semanas después.

_Bloquea:_ E4.1-d (la forma del asiento de ajuste) y el caso 4 del E2E de E4.1-f.

**¿Los intereses bancarios se registran por su importe bruto con la retención de ISR desglosada, o por el neto abonado en el estado de cuenta?**

Los bancos mexicanos retienen ISR sobre los intereses pagados a personas morales, así que el importe que aparece en el estado de cuenta es el neto. Registrar el neto subestima el ingreso y pierde el ISR retenido a favor, que es acreditable (el rol isr_retenido_a_favor y la cuenta 1145 ya existen).

- Neto tal como llega en el estado de cuenta, sin desglose.
- Bruto con retención desglosada, cuando el importe retenido venga en el raw_data de la transacción importada.
- Bruto con retención calculada por la tasa vigente sobre el capital promedio.

_Recomendación:_ La segunda, degradando a la primera cuando el dato no venga: si bank_transactions.raw_data trae el ISR retenido, el ajuste emite DR banco (neto) + DR isr_retenido_a_favor (retención) / CR productos_financieros (bruto); si no lo trae, se registra el neto y la nota de la línea lo dice explícitamente. La tercera inventa un dato fiscal a partir de un promedio, que es peor que registrar el neto.

_Bloquea:_ El armado de las líneas de tipo 'interest' en E4.1-d.

**¿Se permite conciliar un documento parcialmente (varias transacciones bancarias contra la misma factura) desde el primer día?**

reconciliation_matches.is_partial existe desde 003 y nadie lo escribe. El índice uq_recon_match_entity de E4.1-a excluye del control de unicidad los matches marcados como parciales, así que la mecánica está disponible, pero sin una regla de saldo un match parcial puede exceder el importe del documento y nadie lo notaría.

- Prohibirlo por ahora: is_partial siempre false y un documento se concilia una sola vez, completo.
- Permitirlo con control de saldo: la suma de los matched_amount vivos de un documento no puede superar su total_amount, comprobado dentro de recordMatch.
- Permitirlo sin control, confiando en el criterio del operador.

_Recomendación:_ La segunda, si el despacho recibe pagos parciales habitualmente (es lo normal en CxC mexicana). La comprobación son cinco líneas dentro de recordMatch y evita el único modo de fallo serio de la parcialidad. La tercera queda descartada: reintroduce por otra puerta el problema que este paquete cierra.

_Bloquea:_ E4.1-c (si se elige la segunda, recordMatch necesita el control de saldo y el criterio de aceptación correspondiente).

#### Tareas

##### `E4.1-a` Migración 031: integridad de la conciliación y columnas que faltan en nómina · **S**

Crear src/database/migrations/031_banking_payroll_closure.sql con SOLO DDL (sin backfill de datos de negocio) y en este orden.

BANCA:
1) `ALTER TABLE reconciliation_matches ADD COLUMN unmatched_at TIMESTAMPTZ, ADD COLUMN unmatched_by UUID, ADD COLUMN unmatch_reason TEXT;` — deshacer un match es una anulación con rastro, no un DELETE.
2) `CREATE UNIQUE INDEX uq_recon_match_bank_tx ON reconciliation_matches (bank_transaction_id) WHERE unmatched_at IS NULL;` — una transacción bancaria viva concilia contra un solo documento.
3) `CREATE UNIQUE INDEX uq_recon_match_entity ON reconciliation_matches (matched_entity_type, matched_entity_id) WHERE unmatched_at IS NULL AND is_partial = false;` — el mismo documento no se concilia dos veces salvo que el match se declare parcial.
4) `ALTER TABLE journal_entry_lines ADD CONSTRAINT fk_jel_reconciliation FOREIGN KEY (reconciliation_id) REFERENCES reconciliation_sessions(id);` — la columna existe desde 001_core_schema.sql:280 y nunca se usó.
5) `CREATE INDEX idx_jel_reconciliation ON journal_entry_lines(reconciliation_id) WHERE reconciliation_id IS NOT NULL;`
6) `ALTER TABLE reconciliation_sessions ADD COLUMN adjustment_journal_entry_id UUID REFERENCES journal_entries(id), ADD COLUMN variance_tolerance NUMERIC(19,4) NOT NULL DEFAULT 0.01, ADD COLUMN computed_at TIMESTAMPTZ;`

NÓMINA:
7) `ALTER TABLE paychecks ADD COLUMN subsidio_aplicado NUMERIC(14,2) NOT NULL DEFAULT 0, ADD COLUMN subsidio_entregado NUMERIC(14,2) NOT NULL DEFAULT 0;` — se conserva subsidio_empleo como el subsidio TOTAL determinado (lo que el CFDI de nómina debe timbrar); los dos nuevos lo parten en la porción que absorbió al ISR y la que se paga en efectivo.
8) `CREATE UNIQUE INDEX uq_employer_tax_liab_run ON employer_tax_liabilities (pay_run_id, tax_type, jurisdiction) WHERE pay_run_id IS NOT NULL;` — respaldo de idempotencia del posteo.
9) `ALTER TABLE employer_tax_liabilities ADD COLUMN deposited_by UUID;`

No tocar el CHECK de reconciliation_sessions.status: los cuatro estados actuales bastan; una conciliación fuera de tolerancia se queda en 'in_progress' con su variancia persistida (ver E4.1-e).

Tras aplicar, el runner debe reaplicar src/database/rls-policies.sql sin cambios: las tablas afectadas ya están cubiertas (bank_transactions y reconciliation_matches por el bloque de tablas hijas, líneas 136-137; paychecks y employer_tax_liabilities por entity_id/tenant_id).

**Archivos**

- `src/database/migrations/031_banking_payroll_closure.sql` — crear — el DDL descrito, con un encabezado en comentario que explique POR QUÉ cada índice único existe (el patrón de 025_ledger_hardening.sql)

**Migración**

```sql
Ver especificación: es íntegramente la migración 031_banking_payroll_closure.sql.
```

**Criterios de aceptación**

- Dado el esquema en 030, cuando corre `npm run migrate`, entonces termina en código 0 y `\d reconciliation_matches` muestra unmatched_at, unmatched_by y unmatch_reason.
- Dada una fila viva en reconciliation_matches para una bank_transaction, cuando se intenta insertar una segunda para la misma bank_transaction_id con unmatched_at NULL, entonces Postgres rechaza con violación de uq_recon_match_bank_tx.
- Dado un match cuyo unmatched_at ya no es NULL, cuando se inserta uno nuevo para la misma bank_transaction_id, entonces el INSERT tiene éxito.
- Dado journal_entry_lines.reconciliation_id con un UUID que no existe en reconciliation_sessions, cuando se intenta el UPDATE, entonces falla por fk_jel_reconciliation.
- Dado el pipeline completo de migración, cuando termina, entonces `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='reconciliation_matches'` devuelve (true, true).

**Pruebas**

- `tests/database/migration-031.spec.ts` — El archivo 031 declara uq_recon_match_bank_tx, uq_recon_match_entity, fk_jel_reconciliation y uq_employer_tax_liab_run (lectura del .sql, al estilo del test de sincronía del corpus NIIF), y no contiene DELETE ni UPDATE sobre tablas de negocio

**Riesgo.** Si alguna base de desarrollo ya tiene matches duplicados sobre la misma bank_transaction_id (el auto-match actual los permite: matching.ts:356 no comprueba nada), la creación del índice único falla. Mitigación: incluir antes del CREATE INDEX un bloque que marque como anulados los duplicados más viejos — `UPDATE reconciliation_matches SET unmatched_at = NOW(), unmatch_reason = 'duplicado previo a la migración 031' WHERE id NOT IN (SELECT DISTINCT ON (bank_transaction_id) id FROM reconciliation_matches ORDER BY bank_transaction_id, matched_at DESC)` — y dejarlo documentado en el encabezado.

##### `E4.1-b` Alta y consulta de cuentas bancarias (hoy sólo existen por SQL directo) · **M**

Crear src/services/banking/bank-accounts.ts con tres funciones:

`export async function createBankAccount(input: CreateBankAccountInput, userId: string): Promise<BankAccount>` donde CreateBankAccountInput = { entity_id, account_name, bank_name, gl_account_id, currency_code?, account_number?, routing_number?, clabe?, iban?, swift_code?, bank_branch? }. Corre en withTransaction y en este orden:
1. Verifica que gl_account_id pertenece a entity_id, está activa, no es is_header y su account_type es 'asset'. Si no: `ValidationError('gl_account_id no es una cuenta de activo activa de la entidad')`.
2. Si viene account_number: guarda `encrypt(account_number)` (src/utils/encryption.ts) en account_number_encrypted y los últimos 4 dígitos en account_number_last4. Nunca persistir el número en claro ni devolverlo en la respuesta.
3. Si viene routing_number: `encrypt(...)` en routing_number_encrypted.
4. Si viene clabe: validar 18 dígitos y dígito verificador (algoritmo CLABE: pesos 3,7,1 cíclicos sobre los 17 primeros dígitos, suma de (dígito*peso) mod 10 de cada producto, y el verificador es (10 − suma mod 10) mod 10). Si no cuadra: `ValidationError('CLABE inválida: dígito verificador')`.
5. INSERT en bank_accounts y devuelve la fila SIN los campos *_encrypted.

`export async function listBankAccounts(entityId: string): Promise<BankAccountPublic[]>` — omite los campos cifrados, incluye el código y nombre de la cuenta contable ligada (JOIN accounts).

`export async function getBankAccount(id: string): Promise<BankAccountPublic | null>`.

Definir `export type BankAccountPublic = Omit<BankAccount, 'account_number_encrypted' | 'routing_number_encrypted'>` en el mismo módulo.

En src/api/rest/routes/bank-reconciliation.ts añadir, ANTES de las rutas con parámetro:
- `POST /` con requirePermission('accounts:create'), requireEntityAccess y validateBody(createBankAccountSchema) — zod con entity_id uuid opcional (cae a req.entityId), account_name 1..255, bank_name 1..255, gl_account_id uuid, currency_code length 3 opcional, account_number/routing_number/clabe/iban/swift_code strings opcionales. Responde 201.
- `GET /` con requirePermission('accounts:read') y requireEntityAccess.
- `GET /:account_id` con requirePermission('accounts:read'); lee la cuenta, y si existe llama `assertEntityAccess(req.user!, cuenta.entity_id)` (el patrón exacto de journal-entries.ts:19-26). NotFoundError si no existe.
Además, añadir el mismo `assertEntityAccess` sobre bank_accounts.entity_id a las rutas ya existentes /:account_id/import, /:account_id/transactions/unmatched, /:account_id/reconciliations y /:account_id/auto-match, mediante un helper local `async function assertBankAccountAccess(req, accountId): Promise<{ entity_id: string; gl_account_id: string }>`.

Corregir en la misma pasada los dos enums desalineados de la ruta:
- bankTransactionSchema.transaction_type: `z.enum(['debit','credit','fee','interest','adjustment'])` (los cinco valores del CHECK de 003:50). Sin esto no hay forma de importar una comisión.
- matchTransactionSchema.matched_entity_type: `z.enum(['journal_entry_line','invoice','bill','customer_payment','vendor_payment'])` — quitar 'payment', que viola el CHECK de 003:107.

Y hacer transaccional la importación: envolver el bucle de /import completo en un `withTransaction` y usar `INSERT ... ON CONFLICT (bank_account_id, bank_transaction_id) DO NOTHING RETURNING id` en lugar del SELECT-previo-e-INSERT (que es una condición de carrera contra el UNIQUE de 003:61). imported = filas con RETURNING; skipped = el resto.

**Archivos**

- `src/services/banking/bank-accounts.ts` — crear — createBankAccount, listBankAccounts, getBankAccount, validación de CLABE y el tipo BankAccountPublic
- `src/api/rest/routes/bank-reconciliation.ts` — modificar — añadir POST /, GET /, GET /:account_id y el helper assertBankAccountAccess; corregir los enums de bankTransactionSchema y matchTransactionSchema; hacer /import transaccional con ON CONFLICT DO NOTHING
- `src/types/index.ts` — modificar — sólo si BankTransactionType no incluye ya los cinco valores del CHECK; verificarlo antes de tocarlo

**Criterios de aceptación**

- Dado un usuario con accounts:create y una cuenta contable de activo de su entidad, cuando POST /v1/bank-accounts con account_name, bank_name, gl_account_id y account_number '012180001234567890', entonces responde 201, la fila tiene account_number_last4='7890', account_number_encrypted distinto del número en claro, y el cuerpo de la respuesta NO contiene account_number_encrypted.
- Dado un gl_account_id que pertenece a otra entidad, cuando POST /v1/bank-accounts, entonces responde 400 con 'gl_account_id no es una cuenta de activo activa de la entidad' y no se crea ninguna fila.
- Dada una CLABE de 18 dígitos con verificador incorrecto, cuando POST /v1/bank-accounts, entonces responde 400 y no se crea la cuenta.
- Dado un usuario sin membresía en la entidad de una cuenta bancaria, cuando GET /v1/bank-accounts/:id con ese UUID, entonces responde 403 y no expone bank_name ni clabe.
- Dado un lote de importación con transaction_type='fee', cuando POST /v1/bank-accounts/:id/import, entonces la fila se inserta (hoy el zod la rechaza) y transaction_type queda en 'fee'.
- Dado un lote donde una transacción tiene un bank_transaction_id ya existente, cuando se importa el lote dos veces, entonces la segunda corrida devuelve imported=0, skipped=N y el conteo de bank_transactions no cambia.

**Pruebas**

- `tests/banking/bank-accounts.spec.ts` — validateClabe acepta una CLABE real de 18 dígitos y rechaza la misma con el último dígito alterado; createBankAccount rechaza un gl_account_id de otra entidad (con `query` mockeado)
- `tests/banking/bank-accounts.spec.ts` — createBankAccount nunca incluye account_number ni account_number_encrypted en el objeto devuelto

**Riesgo.** El enum de importación es hoy la única defensa contra que llegue una comisión sin clasificar; ampliarlo a cinco valores traslada la responsabilidad al importador. Mitigación: el criterio de aceptación exige que una transacción sin transaction_type siga cayendo a 'debit' (comportamiento actual, bank-reconciliation.ts:70).

##### `E4.1-c` Ligar el match a su sesión y marcar la línea del mayor como conciliada (una sola vez) · **L**

Crear src/services/banking/reconciliation.ts, único punto de escritura de reconciliation_matches. Todo corre sobre el client de la transacción del llamador.

```ts
export type MatchedEntityType = 'journal_entry_line' | 'invoice' | 'bill' | 'customer_payment' | 'vendor_payment';

export interface RecordMatchInput {
  bankTransactionId: string;
  /** null = resolver la sesión abierta que cubre la fecha de la transacción. */
  sessionId: string | null;
  matchedEntityType: MatchedEntityType;
  matchedEntityId: string;
  matchedAmount: string;
  matchType: 'automatic' | 'manual' | 'suggested';
  confidence?: number | null;
  isPartial?: boolean;
  userId: string;
}

export async function recordMatch(
  client: pg.PoolClient,
  input: RecordMatchInput
): Promise<{ matchId: string; sessionId: string; reconciledLineIds: string[] }>
```

Orden de operaciones, sin excepción:
1. `SELECT bt.*, ba.entity_id, ba.gl_account_id FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id WHERE bt.id = $1 FOR UPDATE OF bt`. Si no hay fila: `NotFoundError('Bank Transaction', id)`. Si bt.is_matched: `AccountingError('BANK_TX_ALREADY_MATCHED', 'La transacción bancaria ya está conciliada; deshaz el match antes de rehacerlo')`.
2. Resolver la sesión. Si input.sessionId viene, verificar que existe, que su bank_account_id coincide con el de la transacción, que status='in_progress' y que bt.transaction_date cae entre start_date y end_date; si no, `AccountingError('SESSION_MISMATCH', ...)`. Si viene null: `SELECT id FROM reconciliation_sessions WHERE bank_account_id = $1 AND status = 'in_progress' AND $2 BETWEEN start_date AND end_date ORDER BY created_at DESC LIMIT 1`; si no hay ninguna, `AccountingError('NO_OPEN_RECONCILIATION', 'No hay sesión de conciliación abierta que cubra la fecha ' + fecha + ' para esta cuenta; abre una con POST /v1/bank-accounts/:id/reconciliations')`. Esto es lo que hace estructuralmente imposible un match huérfano.
3. Resolver las líneas del mayor a marcar (`lineIds`):
   - matchedEntityType === 'journal_entry_line': esa línea, si su asiento está posted; si no, `AccountingError('LINE_NOT_POSTED', ...)`.
   - los otros cuatro tipos: leer el journal_entry_id del documento (invoices/bills/customer_payments/vendor_payments) — si es NULL, `AccountingError('DOCUMENT_NOT_POSTED', 'El documento no tiene asiento; postéalo antes de conciliar')` — y de ese asiento tomar las líneas cuyo account_id sea el gl_account_id de la cuenta bancaria. Si son cero, `AccountingError('NO_BANK_LINE', 'El asiento del documento no toca la cuenta contable de este banco')`.
4. `UPDATE journal_entry_lines SET is_reconciled = true, reconciled_at = NOW(), reconciliation_id = $sessionId WHERE id = ANY($lineIds) AND is_reconciled = false` — si `rowCount !== lineIds.length`, `AccountingError('LINE_ALREADY_RECONCILED', 'Una de las líneas ya estaba conciliada en otra sesión')`. Ésta es la comprobación que hoy no existe.
5. INSERT en reconciliation_matches con reconciliation_session_id, match_type, matched_entity_type, matched_entity_id, matched_amount, confidence_score, is_partial y matched_by. El índice uq_recon_match_bank_tx de E4.1-a es el respaldo si dos transacciones concurrentes esquivan el FOR UPDATE.
6. `UPDATE bank_transactions SET is_matched = true, matched_at = NOW(), matched_by = $userId, confidence_score = $confidence WHERE id = $1`.

```ts
export async function undoMatch(
  client: pg.PoolClient,
  matchId: string,
  userId: string,
  reason: string
): Promise<void>
```
Bloquea el match FOR UPDATE; si unmatched_at ya no es NULL: `AccountingError('MATCH_ALREADY_UNDONE', ...)`. Lee la sesión: si su status no es 'in_progress', `AccountingError('RECONCILIATION_LOCKED', 'La sesión ya está cerrada; reabrirla exige reversar el ajuste')`. Si la entidad conciliada es una línea de un asiento con source_type='reconciliation_session' (el ajuste de E4.1-d): `AccountingError('ADJUSTMENT_MATCH_IMMUTABLE', 'Este match respalda el asiento de ajuste bancario; corrígelo reversando el asiento (NIF B-1), no deshaciendo el match')`. Después: marca unmatched_at/unmatched_by/unmatch_reason, pone is_reconciled=false, reconciled_at=NULL y reconciliation_id=NULL en las líneas ligadas, y is_matched=false, matched_at=NULL, matched_by=NULL, confidence_score=NULL en la transacción bancaria.

Cablear los dos llamadores existentes:
- src/api/rest/routes/bank-reconciliation.ts, POST /transactions/:id/match: sustituir el bloque de withTransaction (líneas 160-173) por `withTransaction((client) => recordMatch(client, {...}))`, aceptando en el body un `reconciliation_session_id` uuid opcional. Antes, assertBankAccountAccess sobre la cuenta de la transacción.
- Nueva ruta `POST /transactions/:id/unmatch` con requirePermission('journal_entries:create'), body { reason: z.string().min(3) }; resuelve el match vivo de esa transacción y llama undoMatch.
- src/services/banking/matching.ts, autoMatchUnreconciled: cambiar la firma a `autoMatchUnreconciled(bankAccountId: string, opts: { sessionId?: string; userId: string; minConfidence?: number })`. Cada match de confianza >= (opts.minConfidence ?? 0.85) pasa por `withTransaction((client) => recordMatch(client, { ..., matchType: 'automatic', sessionId: opts.sessionId ?? null }))`, capturando AccountingError con code en ('LINE_ALREADY_RECONCILED','BANK_TX_ALREADY_MATCHED','DOCUMENT_NOT_POSTED','NO_BANK_LINE') para saltar esa transacción y seguir con la siguiente, acumulándolas en `skipped: Array<{ transaction_id: string; reason: string }>` del resultado. Borrar los dos `query(...)` sueltos de matching.ts:351-362.
- Corregir de paso getCandidates (matching.ts:277-296): las dos consultas filtran por `ABS(amount_due) BETWEEN $2 AND $3` pero proyectan `total_amount as amount`, de modo que en un pago parcial las cuatro reglas comparan contra el importe equivocado. Proyectar `amount_due as amount` en ambas.

**Archivos**

- `src/services/banking/reconciliation.ts` — crear — recordMatch y undoMatch, únicos escritores de reconciliation_matches y de journal_entry_lines.is_reconciled
- `src/services/banking/matching.ts` — modificar — autoMatchUnreconciled delega en recordMatch, nueva firma con { sessionId, userId, minConfidence }, resultado con skipped[]; getCandidates proyecta amount_due en lugar de total_amount
- `src/api/rest/routes/bank-reconciliation.ts` — modificar — POST /transactions/:id/match usa recordMatch; nueva POST /transactions/:id/unmatch; POST /:account_id/auto-match pasa session_id y user_id

**Criterios de aceptación**

- Dada una transacción bancaria y una sesión abierta que cubre su fecha, cuando POST /v1/bank-accounts/transactions/:id/match contra una invoice posteada, entonces reconciliation_matches.reconciliation_session_id queda con el id de la sesión (hoy queda NULL) y GET /v1/reconciliations/:id devuelve matched_count = 1.
- Dada esa misma línea del mayor ya conciliada, cuando se intenta conciliarla desde otra transacción bancaria, entonces la petición falla con LINE_ALREADY_RECONCILED y journal_entry_lines.reconciliation_id sigue apuntando a la primera sesión.
- Dada una transacción bancaria fuera de toda sesión abierta, cuando se intenta el match sin session_id, entonces falla con NO_OPEN_RECONCILIATION y no se crea ninguna fila en reconciliation_matches.
- Dado un auto-match sobre una cuenta con 10 transacciones de las que 3 apuntan a líneas ya conciliadas, cuando corre POST /:account_id/auto-match, entonces responde matched=7, skipped tiene 3 entradas con su motivo, y no lanza.
- Dado un match manual recién creado en una sesión 'in_progress', cuando POST /transactions/:id/unmatch con reason, entonces bank_transactions.is_matched=false, journal_entry_lines.is_reconciled=false, reconciliation_id=NULL y la fila de reconciliation_matches conserva unmatched_at y unmatch_reason.
- Dado un pago parcial (invoice con total_amount 1160 y amount_due 500) y una transacción bancaria de 500, cuando corre findBestMatch, entonces la regla 1 la empareja por importe exacto (hoy compara 500 contra 1160 y no empareja).

**Pruebas**

- `tests/banking/matching.spec.ts` — Las cuatro reglas con sus umbrales: exactAmountDateRule devuelve confianza 1.0 sólo con un candidato único; exactAmountNearDateRule empareja a ±3 días y devuelve null con dos candidatos ambiguos; fuzzyDescriptionRule exige similitud > 0.85 y candidato único; mlPredictionRule dispara sobre 0.75 con la ponderación 0.45/0.25/0.30
- `tests/banking/matching.spec.ts` — descriptionSimilarity de dos cadenas idénticas es 1.0; jaccardSimilarity de conjuntos disjuntos es 0; extractKeywords elimina las stopwords de matching.ts:62-66
- `tests/banking/reconciliation.spec.ts` — recordMatch lanza NO_OPEN_RECONCILIATION cuando la consulta de sesión devuelve cero filas, y BANK_TX_ALREADY_MATCHED cuando is_matched viene en true (con el client mockeado)
- `tests/banking/reconciliation.spec.ts` — recordMatch lanza LINE_ALREADY_RECONCILED cuando el UPDATE de journal_entry_lines devuelve rowCount menor al número de líneas resueltas

**Riesgo.** Marcar is_reconciled convierte en irrepetible una operación que hoy es libre; sin undoMatch, un match automático erróneo dejaría la línea bloqueada para siempre. Por eso undoMatch va en la misma tarea y no en una posterior.

##### `E4.1-d` Comisiones e intereses del estado de cuenta al libro mayor · **M**

Dos roles nuevos y un servicio.

1) Vocabulario de roles. En src/services/xml-ingestion/cfdi-taxonomy.ts añadir a la unión AccountRole (bloque nuevo '// Banking') `| 'comisiones_bancarias' | 'productos_financieros'`. En src/services/xml-ingestion/account-roles-seed.ts añadir a ROLE_MAP `comisiones_bancarias: '6300'` (Gastos Financieros, ya existe en el catálogo sembrado, seed.ts:116) y `productos_financieros: '4300'` (Otros Ingresos, seed.ts:105). No hacen falta cuentas nuevas en REQUIRED_ACCOUNTS. ROLE_MAP pasa de 31 a 33 entradas: actualizar la métrica de cierre de E1.1 si la cita.

2) Exportar los dos ayudantes que hoy son privados en src/services/accounting/ar-ap-posting.ts: `roleAccounts` (línea 24) y `requireRole` (línea 46) pasan a `export`. Sin más cambios en su cuerpo.

3) Crear en src/services/banking/reconciliation.ts:
```ts
export async function postStatementAdjustments(
  client: pg.PoolClient,
  sessionId: string,
  userId: string
): Promise<{ entryId: string | null; feeTotal: string; interestTotal: string; adjustmentTotal: string; matched: number; entityId: string }>
```
Comportamiento:
a. `SELECT rs.*, ba.gl_account_id, ba.entity_id FROM reconciliation_sessions rs JOIN bank_accounts ba ON ba.id = rs.bank_account_id WHERE rs.id = $1 FOR UPDATE`.
b. Idempotencia: si rs.adjustment_journal_entry_id no es NULL, devolver ese entryId con los totales recalculados de sus líneas y matched=0, sin crear nada.
c. Leer las transacciones a contabilizar: `SELECT * FROM bank_transactions WHERE bank_account_id = $1 AND is_matched = false AND transaction_type IN ('fee','interest','adjustment') AND transaction_date BETWEEN $2 AND $3 ORDER BY transaction_date, id`. Si son cero, devolver { entryId: null, totales en '0.00', matched: 0 }.
d. Resolver cuentas: `const roles = await roleAccounts(client, entityId, ['comisiones_bancarias','productos_financieros'])`; usar requireRole sólo del rol que efectivamente se necesita (si no hay intereses no se exige productos_financieros). La cuenta de banco es rs.gl_account_id, NO el rol 'banco': el asiento debe tocar la cuenta contable de ESA cuenta bancaria.
e. Construir las líneas emitiendo DOS por transacción, de modo que cada movimiento del estado tenga su propia línea sobre la cuenta de banco y pueda conciliarse individualmente:
   - 'fee': DR comisiones_bancarias |amount| · CR banco |amount|, descripción `Comisión bancaria ${tx.description ?? tx.bank_transaction_id} (${fecha})`.
   - 'interest': DR banco |amount| · CR productos_financieros |amount|, descripción `Intereses ganados ...`.
   - 'adjustment': el signo de tx.amount decide el lado del banco; la contrapartida es comisiones_bancarias si amount < 0 y productos_financieros si amount > 0.
   Guardar, por transacción, el índice de su línea de banco dentro del arreglo.
f. `createJournalEntry(entityId, new Date(rs.end_date), JournalEntryType.AUTO_RECONCILIATION, `Ajustes de conciliación ${rs.start_date}–${rs.end_date}`, lines, userId, { autoPost: true, client, sourceType: 'reconciliation_session', sourceId: sessionId, reference: rs.id })`. El tipo 'auto_reconciliation' ya está en el CHECK de journal_entries (025_ledger_hardening.sql). El asiento cuadra por construcción; validateJournalEntry lo comprueba igual dentro de createJournalEntry.
g. Para cada transacción, `recordMatch(client, { bankTransactionId: tx.id, sessionId, matchedEntityType: 'journal_entry_line', matchedEntityId: entry.lines[idx].id, matchedAmount: |tx.amount|, matchType: 'automatic', confidence: 1.0, userId })` usando el índice guardado en (e). entry.lines viene ordenado por line_number desde createJournalEntry (posting.ts:151-154), así que el índice del arreglo de entrada es el índice del resultado.
h. `UPDATE reconciliation_sessions SET adjustment_journal_entry_id = $entryId WHERE id = $sessionId`.
i. Devolver los totales por tipo, con Decimal, en toFixed(2).

El llamador (E4.1-e) es quien abre la transacción y quien dispara `attestEntryAsync(tenantId, entityId, entryId)` DESPUÉS del commit — postStatementAdjustments nunca la dispara, como manda la convención del repo (posting.ts:75-80).

**Archivos**

- `src/services/xml-ingestion/cfdi-taxonomy.ts` — modificar — añadir 'comisiones_bancarias' y 'productos_financieros' a la unión AccountRole
- `src/services/xml-ingestion/account-roles-seed.ts` — modificar — dos entradas nuevas en ROLE_MAP: comisiones_bancarias → '6300', productos_financieros → '4300'
- `src/services/accounting/ar-ap-posting.ts` — modificar — exportar roleAccounts y requireRole (sin cambiar su cuerpo)
- `src/services/banking/reconciliation.ts` — modificar — añadir postStatementAdjustments

**Criterios de aceptación**

- Dada una sesión abierta con dos transacciones type='fee' de 150.00 y 80.00 y una type='interest' de 12.50, cuando corre postStatementAdjustments, entonces se crea UN asiento posteado de tipo auto_reconciliation con 6 líneas, DR Gastos Financieros suma 230.00, CR Otros Ingresos 12.50 y el neto sobre la cuenta de banco es un abono de 217.50.
- Dado ese mismo asiento, cuando termina la función, entonces las tres bank_transactions tienen is_matched=true, existen tres filas en reconciliation_matches con reconciliation_session_id de la sesión y matched_entity_type='journal_entry_line', y las tres líneas de banco tienen is_reconciled=true.
- Dada una sesión cuyo adjustment_journal_entry_id ya no es NULL, cuando se vuelve a llamar postStatementAdjustments, entonces devuelve el mismo entryId, matched=0 y el conteo de journal_entries no cambia.
- Dada una entidad sin la fila de account_roles para 'comisiones_bancarias' y una sesión con una comisión, cuando corre postStatementAdjustments, entonces lanza MISSING_ROLE_ACCOUNT nombrando el rol y no crea asiento parcial (la transacción del llamador hace rollback).
- Dado un tenant nuevo, cuando corre `mnemosine init`, entonces account_roles tiene 33 filas e incluye comisiones_bancarias y productos_financieros.

**Pruebas**

- `tests/xml-ingestion/account-roles-seed.spec.ts` — Ampliar el test existente: ROLE_MAP cubre todas las claves de la unión AccountRole (comprobación exhaustiva sobre el objeto), incluidas las dos nuevas de banca
- `tests/banking/reconciliation.spec.ts` — postStatementAdjustments arma las líneas correctas por tipo de transacción: 'fee' produce DR comisiones/CR banco y 'interest' el par inverso; con amount negativo en 'adjustment' el banco va al haber
- `tests/banking/reconciliation.spec.ts` — Con adjustment_journal_entry_id ya poblado, postStatementAdjustments no llama a createJournalEntry (spy) y devuelve matched=0

**Riesgo.** Las comisiones bancarias mexicanas llevan IVA y aquí se contabilizan por su importe bruto contra Gastos Financieros; si el despacho espera el IVA acreditable desglosado, el gasto queda inflado y el IVA sin acreditar hasta que se ingiera el CFDI del banco. Ver la decisión 'IVA de las comisiones bancarias'. Mitigación mientras se decide: la descripción de la línea deja el identificador del movimiento del estado para poder ligarlo después al CFDI.

##### `E4.1-e` La variancia que valida el cierre: 'balanced' deja de ser una etiqueta · **M**

En src/services/banking/reconciliation.ts añadir:

```ts
export interface ReconciliationSummary {
  ending_balance_per_bank: string;
  ending_balance_per_books: string;
  deposits_in_transit: string;
  outstanding_checks: string;
  bank_charges: string;
  bank_interest: string;
  other_adjustments: string;
  variance: string;
  unmatched_bank_count: number;
  unreconciled_book_count: number;
}

export async function computeReconciliation(
  client: pg.PoolClient,
  sessionId: string
): Promise<ReconciliationSummary>
```
Definiciones, todas sobre la cuenta contable ba.gl_account_id de la cuenta bancaria de la sesión y con Decimal (nunca parseFloat):
- ending_balance_per_books = SUM(COALESCE(debit_amount,0) − COALESCE(credit_amount,0)) de journal_entry_lines de asientos con status='posted' y je.entry_date <= rs.end_date.
- deposits_in_transit = SUM(COALESCE(debit_amount,0)) de esas mismas líneas con is_reconciled = false (cargos en libros que el banco todavía no refleja).
- outstanding_checks = SUM(COALESCE(credit_amount,0)) de esas mismas líneas con is_reconciled = false.
- bank_charges = SUM(ABS(amount)) de bank_transactions type='fee' de la cuenta entre start_date y end_date; bank_interest ídem con 'interest'; other_adjustments ídem con 'adjustment'. Son informativos: tras E4.1-d ya están en libros y conciliados, así que NO entran en la ecuación.
- unmatched_bank_count = bank_transactions de la cuenta en el rango con is_matched=false; unreconciled_book_count = las líneas de libro del rango con is_reconciled=false.
- variance = ending_balance_per_bank + deposits_in_transit − outstanding_checks − ending_balance_per_books.

```ts
export async function completeReconciliation(
  sessionId: string,
  userId: string,
  options?: { tolerance?: string }
): Promise<{ status: 'balanced' | 'out_of_balance'; summary: ReconciliationSummary; adjustmentEntryId: string | null }>
```
Abre withTransaction y, en orden:
1. Bloquea la sesión FOR UPDATE; si status !== 'in_progress': `AccountingError('RECONCILIATION_NOT_OPEN', ...)`.
2. `const adj = await postStatementAdjustments(client, sessionId, userId)` — las comisiones e intereses tienen que estar en libros ANTES de medir la variancia, o aparecerían como partidas en tránsito falsas.
3. `const summary = await computeReconciliation(client, sessionId)`.
4. Persiste SIEMPRE: `UPDATE reconciliation_sessions SET ending_balance_per_books=$, outstanding_checks=$, deposits_in_transit=$, bank_charges=$, bank_interest=$, other_adjustments=$, variance=$, computed_at=NOW() WHERE id=$`.
5. tolerancia = options?.tolerance ?? rs.variance_tolerance. Si `|variance| <= tolerancia`: además `status='balanced', completed_at=NOW(), completed_by=$userId`. Si no: la sesión SE QUEDA en 'in_progress' con su variancia persistida. Nunca se hace rollback por descuadre — el asiento de ajuste del paso 2 es legítimo y debe sobrevivir.
6. Fuera de la transacción, si adj.entryId no es null, `attestEntryAsync(tenantId, adj.entityId, adj.entryId)` (importado de src/services/accounting/posting.ts), resolviendo tenantId con `currentTenant()` y, si no está, con un SELECT sobre legal_entities — el mismo patrón de posting.ts:300-312.

Rutas en src/api/rest/routes/bank-reconciliation.ts:
- POST /reconciliations/:id/complete: sustituir el UPDATE de la línea 259 por `completeReconciliation(...)`, aceptando body opcional { tolerance }. Si el resultado es 'balanced' responde 200 con { data: sesión actualizada, summary }; si es 'out_of_balance' responde 409 con `new ConflictError('La conciliación no cuadra')` llevando el summary completo en el cuerpo, para que el usuario vea los cuatro términos de la ecuación y no un booleano.
- GET /reconciliations/:id: añadir `summary` al cuerpo, calculado con computeReconciliation dentro de una transacción de sólo lectura, además de matches y unmatched_count que ya devuelve.
- Ambas rutas pasan primero por assertBankAccountAccess (E4.1-b) sobre rs.bank_account_id.

**Archivos**

- `src/services/banking/reconciliation.ts` — modificar — añadir ReconciliationSummary, computeReconciliation y completeReconciliation
- `src/api/rest/routes/bank-reconciliation.ts` — modificar — POST /reconciliations/:id/complete delega en completeReconciliation y responde 409 con el summary si descuadra; GET /reconciliations/:id devuelve summary

**Criterios de aceptación**

- Dada una sesión donde todo movimiento del estado está conciliado y no hay partidas en tránsito, cuando POST /v1/reconciliations/:id/complete, entonces responde 200, status='balanced', variance='0.0000' y ending_balance_per_books deja de ser 0.
- Dada una sesión con un cheque emitido y no cobrado por 500.00, cuando se completa, entonces outstanding_checks=500.00 y variance sigue en 0 (la ecuación lo absorbe), y la sesión queda 'balanced'.
- Dada una sesión donde el saldo del estado difiere en 340.00 sin partida que lo explique, cuando POST /complete, entonces responde 409, reconciliation_sessions.status sigue siendo 'in_progress', variance quedó persistida en 340.0000 y computed_at no es NULL.
- Dada esa misma sesión con una comisión de 340.00 importada y sin conciliar, cuando POST /complete, entonces se crea el asiento de ajuste, la comisión queda conciliada, variance vuelve a 0 y la sesión pasa a 'balanced' en la MISMA llamada.
- Dada una sesión ya 'balanced', cuando se llama de nuevo a /complete, entonces responde error RECONCILIATION_NOT_OPEN y no se crea un segundo asiento de ajuste.
- Dado que el asiento de ajuste se creó, cuando termina la petición, entonces attestEntryAsync se disparó exactamente una vez y después del commit (verificable con un spy en el E2E).

**Pruebas**

- `tests/banking/reconciliation.spec.ts` — computeReconciliation calcula variance = banco + tránsito − circulación − libros con Decimal, y devuelve 0 exacto en el caso cuadrado (sin errores de coma flotante con importes tipo 0.1 + 0.2)
- `tests/banking/reconciliation.spec.ts` — completeReconciliation con variancia 0.005 y tolerancia por defecto 0.01 devuelve 'balanced'; con 0.02 devuelve 'out_of_balance' y no escribe status ni completed_at
- `tests/banking/reconciliation.spec.ts` — completeReconciliation sobre una sesión en status 'balanced' lanza RECONCILIATION_NOT_OPEN antes de llamar a postStatementAdjustments (spy)

**Riesgo.** La definición de ending_balance_per_books usa entry_date <= end_date, no la fecha de posteo: un asiento con fecha dentro del periodo capturado después del cierre de la conciliación cambiaría retroactivamente el saldo en libros de una sesión ya 'balanced'. Mitigación: computed_at deja constancia del momento del cálculo y el E2E incluye un caso que lo comprueba; si el despacho necesita inmutabilidad, la vía es el cierre del periodo fiscal, no la conciliación.

##### `E4.1-f` E2E de banca contra base real · **M**

Crear scripts/e2e-banco.ts siguiendo la estructura de scripts/e2e-arap.ts (contador pass/fail, helper `ok(cond, label)`, limpieza al final, `closeDatabase()` y `process.exit(fail ? 1 : 0)`) pero SIN UUIDs hardcodeados — ése es el defecto que la auditoría le señaló al E2E existente. El script descubre su contexto:
```ts
const tenant = (await query<{id:string}>(`SELECT id FROM tenants ORDER BY created_at LIMIT 1`)).rows[0];
enterTenant(tenant.id);
const entity = (await query(`SELECT id FROM legal_entities WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tenant.id])).rows[0];
const user = (await query(`SELECT id FROM users WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tenant.id])).rows[0];
```
Si falta cualquiera, aborta con un mensaje que diga que hay que correr `mnemosine init` primero. Comprueba que account_roles tiene comisiones_bancarias y productos_financieros y, si no, llama a seedAccountRoles(entity.id, tenant.id, user.id).

Pasos, cada uno con sus aserciones:
1. Crea una bank_accounts con createBankAccount ligada a la cuenta del rol 'banco'; comprueba que account_number_last4 se derivó y que el número no viaja en claro.
2. Abre una sesión de conciliación del mes en curso con ending_balance_per_bank conocido.
3. Crea un asiento manual DR banco 1000 / CR ingreso 1000 con createJournalEntry(..., { autoPost: true }); importa una bank_transaction credit de 1000 con la misma fecha; corre autoMatchUnreconciled y comprueba matched=1, que la línea de banco quedó is_reconciled=true, que reconciliation_matches tiene reconciliation_session_id y que un segundo auto-match devuelve matched=0.
4. Importa una comisión de 150 (type='fee') y un interés de 12.50 (type='interest'); llama completeReconciliation y comprueba: se creó el asiento auto_reconciliation, las dos transacciones quedaron conciliadas, bank_charges=150.00, bank_interest=12.50 y status='balanced'.
5. Caso de descuadre: importa una segunda comisión de 99 SIN volver a completar, abre una sesión nueva del mes siguiente con un saldo bancario que no cuadra, llama completeReconciliation y comprueba status='out_of_balance', variance persistida y sesión todavía en 'in_progress'.
6. undoMatch sobre el match del paso 3: comprueba que la línea vuelve a is_reconciled=false y que el match conserva unmatch_reason. Comprueba también que undoMatch sobre uno de los matches del ajuste lanza ADJUSTMENT_MATCH_IMMUTABLE.
7. `await drainAttestations(2000)`.

Limpieza: reversar el efecto en account_balances con el mismo bloque de e2e-arap.ts:219-228 sobre los asientos creados, borrar reconciliation_matches, bank_transactions, reconciliation_sessions, journal_entries y la bank_accounts creada, en ese orden (respetando las FK).

Añadir a package.json: `"e2e:arap": "tsx scripts/e2e-arap.ts"`, `"e2e:banco": "tsx scripts/e2e-banco.ts"`, `"e2e:nomina": "tsx scripts/e2e-nomina.ts"` y `"e2e": "npm run e2e:arap && npm run e2e:banco && npm run e2e:nomina"`.

**Archivos**

- `scripts/e2e-banco.ts` — crear — el guion descrito, con descubrimiento de fixtures y limpieza completa
- `package.json` — modificar — añadir los scripts e2e:arap, e2e:banco, e2e:nomina y el agregado e2e

**Criterios de aceptación**

- Dado un entorno con la base migrada y `mnemosine init` corrido, cuando se ejecuta `npm run e2e:banco`, entonces imprime RESULTADO con 0 ✗ y sale con código 0.
- Dada una segunda ejecución consecutiva de `npm run e2e:banco`, entonces vuelve a salir en 0 (la limpieza es completa y el script no depende de estado previo).
- Dado un entorno sin tenants, cuando se ejecuta el script, entonces aborta con un mensaje que nombra `mnemosine init` y sale con código 2, sin dejar filas.
- Terminada la ejecución, `SELECT COUNT(*) FROM reconciliation_matches WHERE notes LIKE 'E2E%' OR bank_transaction_id IN (...)` devuelve 0 y account_balances vuelve a sus valores previos.

**Riesgo.** El script escribe en la base de desarrollo real. Mitigación: todos los identificadores llevan el prefijo 'E2E-BANCO-' y la limpieza corre en un finally, no en el camino feliz.

##### `E4.1-g` Sembrar payroll_account_mapping desde account_roles y cablearlo a `mnemosine init` · **S**

Hoy postPayRunToGL lanza `Missing payroll_account_mapping for bucket: wages_expense` en toda entidad nueva porque nadie puebla payroll_account_mapping (008_payroll.sql:508). Es el mismo agujero que account_roles, y se cierra igual.

Crear src/services/payroll/common/account-mapping-seed.ts:
```ts
export const PAYROLL_BUCKET_ROLE_MAP: Record<string, AccountRole> = {
  wages_expense: 'sueldos_gasto',            // 6110
  payroll_tax_expense: 'sueldos_gasto',      // 6110 (ver decisión sobre cuenta propia)
  cash_payroll: 'sueldos_por_pagar',         // 2160 (ver decisión sobre banco vs pasivo)
  isr_payable: 'isr_nomina_por_pagar',       // 2140
  imss_payable_employee: 'imss_por_pagar',   // 2170
  imss_payable_employer: 'imss_por_pagar',   // 2170
  infonavit_payable: 'imss_por_pagar',       // 2170 (ver decisión)
  subsidio_empleo_receivable: 'isr_retenido_a_favor', // 1145
};

export async function seedPayrollAccountMapping(
  entityId: string,
  tenantId: string
): Promise<{ mapped: number; skipped: Array<{ bucket: string; role: string }> }>
```
Corre en withTransaction, lee `SELECT role, account_id FROM account_roles WHERE entity_id = $1 AND qualifier IS NULL` y por cada bucket cuyo rol exista hace `INSERT INTO payroll_account_mapping (tenant_id, entity_id, bucket, account_id) VALUES (...) ON CONFLICT (tenant_id, entity_id, bucket) DO NOTHING` — idempotente y sin pisar una elección manual, exactamente como seedAccountRoles. Los buckets cuyo rol falte se devuelven en skipped, nunca se inventan.

Los buckets estadounidenses (fit_payable, fica_payable_*, futa_payable, suta_payable, state_tax_payable, garnishment_payable, benefits_payable) NO se siembran: el catálogo mexicano sembrado no tiene cuentas equivalentes. Se documenta que una entidad US los mapea a mano o por una siembra propia, y postPayRunToGL falla con un error nombrado si falta uno con importe distinto de cero (E4.1-i).

Cableado a init: E1.1 introduce la sección de contabilidad (SectionId 'contabilidad' ya está declarado en src/cli/init/section.ts:14-16 y no lo usa nadie). Añadir la siembra de payroll_account_mapping como un paso más de esa sección, después de seedAccountRoles y con el mismo texto de resultado. Si al implementar E4.1 esa sección todavía no existe, crearla en src/cli/init/s6-contabilidad.ts implementando SetupSection (id 'contabilidad', required true), registrarla en buildSections() de src/cli/init/index.ts entre PoliciesSection e ImportSection, y hacer que su `verify()` compruebe las 33 filas de account_roles y las 8 de payroll_account_mapping para que `mnemosine doctor` lo vea.

**Archivos**

- `src/services/payroll/common/account-mapping-seed.ts` — crear — PAYROLL_BUCKET_ROLE_MAP y seedPayrollAccountMapping
- `src/cli/init/s6-contabilidad.ts` — modificar (o crear si E1.1 no la dejó) — llamar a seedPayrollAccountMapping tras seedAccountRoles y reportar mapped/skipped
- `src/cli/init/index.ts` — modificar — registrar y reexportar la sección de contabilidad si hubo que crearla

**Criterios de aceptación**

- Dado un tenant nuevo sin cuentas, cuando corre `mnemosine init`, entonces payroll_account_mapping tiene 8 filas para la entidad y postPayRunToGL ya no lanza 'Missing payroll_account_mapping for bucket: wages_expense'.
- Dado un init ya corrido, cuando se corre `mnemosine init` otra vez, entonces payroll_account_mapping sigue con 8 filas y ninguna account_id cambió (idempotencia probada con un mapeo alterado a mano antes de reejecutar).
- Dada una entidad cuyo account_roles carece del rol 'sueldos_por_pagar', cuando corre seedPayrollAccountMapping, entonces devuelve skipped con { bucket:'cash_payroll', role:'sueldos_por_pagar' } y no inventa ninguna cuenta.
- Dado `mnemosine doctor`, cuando la sección de contabilidad verifica, entonces reporta 'ok' sólo si están las 33 filas de account_roles y las 8 de payroll_account_mapping.

**Pruebas**

- `tests/payroll/account-mapping-seed.spec.ts` — Todo valor de PAYROLL_BUCKET_ROLE_MAP es una clave existente de ROLE_MAP (la desalineación entre los dos catálogos se detecta en CI, no en producción)
- `tests/payroll/account-mapping-seed.spec.ts` — seedPayrollAccountMapping con un account_roles incompleto (client mockeado) devuelve los buckets faltantes en skipped y emite tantos INSERT como roles resueltos

**Riesgo.** Mapear cash_payroll a 'Sueldos por Pagar' en vez de a banco cambia la forma del asiento de nómina respecto de lo que hoy produce cualquier mapeo manual existente. Está formulado como decisión; si se elige banco, sólo cambia una entrada del mapa y sobra la tarea E4.1-k.

##### `E4.1-h` Persistir paycheck_taxes y las columnas del recibo que hoy quedan en cero · **M**

En src/services/payroll/common/paycheck-service.ts, dentro de calculatePaycheck:

1. Declarar junto a `breakdown` (línea 137) un acumulador:
```ts
interface TaxRow { tax_type: string; jurisdiction: string; ee_er: 'EE' | 'ER'; taxable_wages: number; rate: number | null; tax_amount: number; is_credit: boolean; notes: string | null; }
const taxRows: TaxRow[] = [];
const pushTax = (out: TaxOutput, side: 'EE' | 'ER', overrideType?: string) => { if (out.tax_amount === 0 && !out.is_credit) return; taxRows.push({ tax_type: overrideType ?? out.tax_type, jurisdiction: out.jurisdiction, ee_er: side, taxable_wages: out.taxable_wages_used, rate: out.rate_applied ?? null, tax_amount: out.tax_amount, is_credit: out.is_credit ?? false, notes: out.notes ?? null }); };
```
2. Llamar a pushTax detrás de cada calculadora existente, sin alterar la aritmética: US → fit(EE), fica_ss(EE), fica_ss_employer(ER), fica_medicare(EE), fica_medicare_employer(ER), additional_medicare(EE), futa(ER), sit(EE), suta(ER), sdi(EE), local(EE). MX → isr(EE), subsidio_empleo(EE, is_credit), infonavit_employer(ER), infonavit_credit(EE).
3. Para IMSS, en vez de una fila por calculadora, expandir el `breakdown` que MexicoImssEmployeeCalculator (imss-calculator.ts:69) y MexicoImssEmployerCalculator (línea 116) ya devuelven y hoy se descarta, con este mapa de ramo → tax_type (paycheck_taxes.tax_type es VARCHAR(40) sin CHECK; los nombres siguen el comentario de 008_payroll.sql:312):
   em_fija y em_excedente → 'imss_em'; prestaciones_dinero → 'imss_prestaciones'; gmp → 'imss_gmp'; invalidez_vida y cesantia_vejez → 'imss_ivcm'; riesgo_trabajo → 'imss_rt'; guarderias → 'imss_guarderias'; retiro → 'imss_retiro'.
   Los ramos que comparten tax_type se suman en una sola fila. taxable_wages = out.taxable_wages_used; rate = null; notes = out.notes.
   Comprobación obligatoria: la suma de las filas IMSS de un lado debe igualar out.tax_amount con tolerancia 0.01; si no, lanzar `Error('Desglose IMSS no cuadra con el total: ...')`, porque un desglose que no suma es peor que ninguno.
4. Dentro de la withTransaction que ya existe (línea 324), después del INSERT de paychecks y antes de paycheck_earnings, insertar las filas:
```sql
INSERT INTO paycheck_taxes (paycheck_id, tax_type, jurisdiction, employee_employer, taxable_wages, rate, tax_amount, is_credit, calculation_notes)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
```
5. Corregir tres columnas del INSERT de paychecks que hoy quedan siempre en su DEFAULT aunque el valor esté calculado:
   - `garnishments` = garnishmentTotal (hoy sólo se acumula dentro de post_tax_deductions, línea 313).
   - `local_tax_withheld` = breakdown.local || 0 (hoy breakdown.local se calcula en la línea 230 y se tira).
   - `post_tax_deductions` sigue siendo totalPostTax (incluye embargos), pero ahora `garnishments` permite separarlos en el asiento (E4.1-i).

No cambiar ni una fórmula fiscal en esta tarea: es persistencia de lo que ya se calcula.

**Archivos**

- `src/services/payroll/common/paycheck-service.ts` — modificar — acumulador taxRows con pushTax, expansión del breakdown de IMSS por ramo, INSERT en paycheck_taxes dentro de la transacción existente, y las columnas garnishments y local_tax_withheld en el INSERT de paychecks

**Criterios de aceptación**

- Dado un trabajador MX con SBC de 500 diarios en una quincena, cuando corre calculatePaycheck, entonces paycheck_taxes tiene filas EE para imss_em, imss_prestaciones, imss_gmp e imss_ivcm y filas ER para imss_em, imss_prestaciones, imss_gmp, imss_ivcm, imss_rt, imss_guarderias e imss_retiro, más isr (EE) y subsidio_empleo (EE, is_credit=true).
- Dada esa misma corrida, cuando se consulta SUM(tax_amount) de las filas ER con tax_type LIKE 'imss_%', entonces coincide con paychecks.imss_employer con diferencia menor a 0.01.
- Dado GET /v1/payroll/paychecks/:id, cuando el recibo ya se calculó, entonces taxes deja de ser [] (hoy siempre lo es).
- Dado un trabajador US en NY con embargo activo, cuando corre calculatePaycheck, entonces paychecks.garnishments deja de ser 0 y coincide con la suma de las deducciones cuyo garnishment_id no es NULL.
- Dado que el desglose por ramo del IMSS se altera artificialmente para que no sume el total, cuando corre calculatePaycheck, entonces lanza 'Desglose IMSS no cuadra con el total' y la transacción hace rollback sin dejar el recibo a medias.

**Pruebas**

- `tests/payroll/paycheck-taxes.spec.ts` — El mapa de ramo → tax_type cubre las cinco claves que devuelve MexicoImssEmployeeCalculator y las nueve de MexicoImssEmployerCalculator (comprobación exhaustiva contra los objetos breakdown reales, con getTaxParameters mockeado como en tests/payroll/usa/fica.spec.ts)
- `tests/payroll/paycheck-taxes.spec.ts` — pushTax omite las filas con importe 0 salvo los créditos (subsidio_empleo con 0 sí se registra, para dejar constancia de que se evaluó)

**Riesgo.** Un recibo de nómina pasa de 3 INSERT a ~15; con corridas de cientos de empleados el tiempo por recibo sube. Mitigación: un solo INSERT multi-fila con UNNEST en lugar de un INSERT por fila, y medirlo en el E2E con 3 empleados.

##### `E4.1-i` Subsidio al empleo: entregar el remanente en vez de truncarlo · **M**

src/services/payroll/common/paycheck-service.ts, líneas 242-248. El código actual calcula el subsidio, lo compara con el ISR y descarta el excedente con `Math.max(0, isr.tax_amount - sub.tax_amount)` — el propio comentario de la línea 246 afirma que el trabajador lo recibe en efectivo, y el código lo pierde.

Sustituir por:
```ts
const round2 = (n: number) => Math.round(n * 100) / 100;
const subsidioTotal = sub.tax_amount;
const subsidioAplicado = round2(Math.min(subsidioTotal, isr.tax_amount));
const subsidioEntregado = round2(subsidioTotal - subsidioAplicado);
const netIsr = round2(isr.tax_amount - subsidioAplicado); // >= 0 por construcción
breakdown.isr = isr.tax_amount;
breakdown.subsidio_empleo = subsidioTotal;
breakdown.subsidio_aplicado = subsidioAplicado;
breakdown.subsidio_entregado = subsidioEntregado;
employeeTaxes += netIsr;
```
El neto (línea 316-320) suma el subsidio entregado, que es dinero que el patrón pone y el trabajador recibe:
```ts
const netPay = new Decimal(grossEarnings)
  .minus(preTaxDeductions).minus(employeeTaxes).minus(totalPostTax)
  .plus(subsidioEntregado)   // 0 para trabajadores US
  .toNumber();
```
Declarar `let subsidioEntregado = 0` fuera del bloque MX para que la rama US lo deje en 0.

Persistencia: en el INSERT de paychecks añadir `subsidio_aplicado` y `subsidio_entregado` (columnas de E4.1-a) y dejar `subsidio_empleo` con el TOTAL determinado — es lo que el complemento de Nómina 1.2 debe timbrar. En paycheck_taxes, la fila 'subsidio_empleo' lleva is_credit=true, tax_amount = subsidioTotal y calculation_notes = `aplicado ${subsidioAplicado} / entregado ${subsidioEntregado}`.

Consecuencia obligatoria en el mayor (se implementa en E4.1-j, se documenta aquí): el asiento de nómina abona el neto INCLUYENDO el subsidio entregado, y necesita un cargo por ese mismo importe al bucket `subsidio_empleo_receivable` (rol isr_retenido_a_favor, cuenta 1145), que es el saldo a favor que el patrón acredita contra su propio ISR. Y el abono a isr_payable pasa a ser `SUM(isr_withheld − subsidio_aplicado)`, nunca `SUM(isr_withheld − subsidio_empleo)`, que con subsidio entregado da un importe NEGATIVO y viola el CHECK `credit_amount > 0` de journal_entry_lines (001_core_schema.sql:289).

**Archivos**

- `src/services/payroll/common/paycheck-service.ts` — modificar — partir el subsidio en aplicado/entregado, sumar el entregado al neto, persistir las dos columnas nuevas y la nota en paycheck_taxes

**Criterios de aceptación**

- Dado un trabajador MX cuya base quincenal da ISR de 120.00 y subsidio de 203.51, cuando corre calculatePaycheck, entonces subsidio_aplicado=120.00, subsidio_entregado=83.51, isr_withheld=120.00, los impuestos del trabajador por ISR son 0 y net_pay es 83.51 mayor que el bruto menos deducciones (hoy el excedente desaparece).
- Dado un trabajador MX cuyo ISR (900.00) supera al subsidio (203.51), cuando corre calculatePaycheck, entonces subsidio_aplicado=203.51, subsidio_entregado=0.00 y el ISR neto retenido es 696.49 — el mismo número que produce el código actual (no hay regresión en el caso común).
- Dado un trabajador US, cuando corre calculatePaycheck, entonces subsidio_aplicado y subsidio_entregado quedan en 0.00 y net_pay no cambia respecto del comportamiento previo.
- Dada una corrida con subsidio entregado, cuando se consulta SUM(isr_withheld − subsidio_aplicado) sobre sus paychecks, entonces el resultado es >= 0 en todos los casos.

**Pruebas**

- `tests/payroll/mx/subsidio.spec.ts` — Los tres casos de la mecánica: subsidio < ISR (se aplica todo, entregado 0), subsidio > ISR (aplicado = ISR, entregado = diferencia, ISR neto 0) y subsidio = ISR (ambos absorben, entregado 0)
- `tests/payroll/mx/subsidio.spec.ts` — MexicoSubsidioEmpleoCalculator convierte la base quincenal a mensual (×2) para buscar el renglón y divide el subsidio entre 2 al volver — con las tarifas sembradas en 009_tax_tables_2026.sql:183-194 y getBrackets mockeado
- `tests/payroll/mx/isr.spec.ts` — MexicoIsrCalculator aplica la tarifa quincenal cuando pay_frequency='quincenal' y la mensual en cualquier otro caso, y lanza si no hay renglones para el año

**Riesgo.** La mecánica de entrega en efectivo corresponde al régimen tabular del subsidio, que es exactamente el que la base tiene sembrado (009_tax_tables_2026.sql:183-194, con los 407.02 / 406.83 / … de la tabla histórica). Si el año fiscal a aplicar se rige por el esquema de porcentaje fijo de UMA, en el que el subsidio no puede exceder al ISR ni entregarse en efectivo, el resultado correcto es entregado=0 siempre. Está formulado como decisión y la implementación debe dejarlo conmutable por año, leyendo un parámetro de tax_parameters, no por una constante en TypeScript.

##### `E4.1-j` Posteo de la corrida al mayor: una transacción, idempotente, con pasivos de entero · **L**

Reescribir src/services/payroll/common/gl-posting-service.ts. Hoy corre en tres transacciones distintas (createJournalEntry sin autoPost → postJournalEntry → UPDATE pay_runs), no valida el estado, no es idempotente, omite en silencio los buckets no mapeados y nunca dispara la atestación.

Nueva firma y comportamiento:
```ts
export async function postPayRunToGL(payRunId: string, userId: string): Promise<string>
```
1. Todo dentro de un único `withTransaction(async (client) => { ... })`.
2. `SELECT pr.*, ps.entity_id, pp.pay_date, pp.period_start, pp.period_end FROM pay_runs pr JOIN pay_periods pp ON pp.id = pr.pay_period_id JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id WHERE pr.id = $1 FOR UPDATE OF pr`. Si no hay fila: `AccountingError('PAY_RUN_NOT_FOUND', ...)`.
3. Idempotencia: si pr.journal_entry_id no es NULL, devolverlo tal cual sin crear nada.
4. Guarda de estado: si pr.status no está en ('approved','paid'): `AccountingError('PAY_RUN_NOT_APPROVED', \`No se puede postear una corrida en estado '${pr.status}'; apruébala primero\`)`. Hoy se puede postear un 'draft'.
5. Agregado sobre paychecks (el mismo SELECT actual, ahora con client) con dos cambios: `SUM(isr_withheld - subsidio_aplicado) AS isr` (no `- subsidio_empleo`), y dos columnas nuevas `SUM(subsidio_entregado) AS subsidio_entregado` y `SUM(garnishments) AS garnishments`.
6. resolveAccounts pasa a recibir el client. Sustituir `creditIfPresent` por `creditRequired(bucket, amount, desc)`: si amount > 0.005 y el bucket no está mapeado, lanzar `AccountingError('MISSING_PAYROLL_BUCKET', \`Falta el mapeo de payroll_account_mapping para el bucket '${bucket}' (importe ${amount.toFixed(2)}); siémbralo con mnemosine init o mapéalo a mano\`)`. Hoy se omite y el síntoma aparece como un descuadre críptico 60 líneas después.
7. Separar porción obrera y patronal, con retrocompatibilidad: `fica_payable_employee`/`fica_payable_employer` e `imss_payable_employee`/`imss_payable_employer`; si el bucket separado no existe pero sí el legado (`fica_payable`, `imss_payable`), usar el legado sumando ambas porciones y registrar un console.warn nombrando el bucket recomendado.
8. Embargos: `garnishment_payable` recibe `SUM(garnishments)` (columna ya poblada por E4.1-h), no post_tax_deductions completo. El resto (`post_tax_deductions − garnishments`) va a `benefits_payable`.
9. Subsidio entregado: si es > 0, añadir una línea de CARGO al bucket `subsidio_empleo_receivable` por ese importe. Sin ella el asiento no cuadra, porque el neto abonado ya lo incluye.
10. Mantener la comprobación de cuadre por Decimal (no parseFloat) con tolerancia 0.01 antes de llamar a createJournalEntry: es una red barata que localiza el error en el bucket, no en la validación genérica.
11. `createJournalEntry(entityId, new Date(pr.pay_date), JournalEntryType.PAYROLL, ..., { autoPost: true, client, sourceType: 'pay_run', sourceId: payRunId, reference: payRunId })` — un solo paso, dentro de la transacción, en lugar de createJournalEntry + postJournalEntry.
12. `UPDATE pay_runs SET journal_entry_id = $1 WHERE id = $2` en la MISMA transacción.
13. Generar los pasivos de entero antes de cerrar la transacción, con la función nueva descrita abajo.
14. Tras el commit, `attestEntryAsync(pr.tenant_id, entityId, entryId)` — hoy la nómina es el único asiento del sistema que no se atesta.

Función nueva en el mismo módulo:
```ts
export async function createEmployerTaxLiabilities(
  client: pg.PoolClient,
  args: { payRunId: string; tenantId: string; entityId: string; periodStart: string; periodEnd: string; totals: Record<string, number> }
): Promise<number>
```
Emite una fila por concepto con importe > 0, `status='pending'`, `deposited_at = NULL` y `ON CONFLICT DO NOTHING` (respaldado por uq_employer_tax_liab_run de E4.1-a):
- US: tax_type '941_federal' / jurisdiction 'US-FEDERAL' con fit + fica_ss_ee + fica_med_ee + addl_med + fica_ss_er + fica_med_er; 'futa' / 'US-FEDERAL'; 'suta_<estado>' y 'sit_<estado>' / 'US-<estado>'.
- MX: 'isr' / 'MX' con SUM(isr_withheld − subsidio_aplicado); 'imss' / 'MX' con obrera + patronal; 'infonavit' / 'MX'.
- due_date: se calcula con `depositDueDate(taxType, periodEnd, frequency)`, una función pura exportada del módulo. Por defecto, frecuencia 'monthly': para US-FEDERAL el día 15 del mes siguiente al de periodEnd; para MX el día 17 del mes siguiente. deposit_frequency se guarda tal cual. Los umbrales reales del calendario del IRS y los supuestos mexicanos están en la decisión correspondiente; la función debe estar aislada y probada para que cambiar la regla no toque el posteo.

Y una corrección de esquema en el mismo paso: src/services/payroll/usa/forms/form-940-generator.ts líneas 41-45 consultan `p.futa_employer`, columna que no existe — la real es `paychecks.futa` (008_payroll.sql:236). Reemplazar las cinco apariciones.

**Archivos**

- `src/services/payroll/common/gl-posting-service.ts` — modificar — reescritura de postPayRunToGL en una sola transacción con guardas, idempotencia, creditRequired, separación EE/ER, línea de subsidio entregado, atestación tras el commit; añadir createEmployerTaxLiabilities y depositDueDate
- `src/services/payroll/usa/forms/form-940-generator.ts` — modificar — p.futa_employer → p.futa en las cinco apariciones (líneas 41-45)
- `src/api/rest/routes/payroll.ts` — modificar — POST /pay-runs/:id/post-to-gl devuelve también liabilities_created

**Criterios de aceptación**

- Dada una corrida en estado 'draft', cuando POST /v1/payroll/pay-runs/:id/post-to-gl, entonces falla con PAY_RUN_NOT_APPROVED y no se crea ningún asiento (hoy lo crea).
- Dada una corrida ya posteada, cuando se llama otra vez a post-to-gl, entonces devuelve el MISMO journal_entry_id, el conteo de journal_entries no cambia y pay_runs.journal_entry_id conserva su valor (hoy se pisa y quedan asientos duplicados).
- Dada una entidad a la que le falta el bucket 'isr_payable' y una corrida MX con ISR retenido, cuando se postea, entonces falla con MISSING_PAYROLL_BUCKET nombrando 'isr_payable' y su importe, en vez de un error de descuadre.
- Dada una corrida MX con subsidio entregado de 83.51, cuando se postea, entonces el asiento tiene una línea de cargo por 83.51 a la cuenta del bucket subsidio_empleo_receivable, el abono a isr_payable es >= 0 y el asiento cuadra.
- Dada una corrida MX aprobada, cuando se postea, entonces employer_tax_liabilities tiene tres filas (isr, imss, infonavit) con status='pending', deposited_at NULL, period_start/period_end del periodo y due_date el día 17 del mes siguiente.
- Dada esa misma corrida posteada dos veces, entonces employer_tax_liabilities sigue teniendo tres filas.
- Dado un asiento de nómina posteado, cuando termina la petición, entonces attestEntryAsync se disparó una vez con el tenant_id de la corrida (hoy no se dispara nunca).
- Dado un tenant con recibos US, cuando corre generateForm940, entonces la consulta se ejecuta sin error de columna inexistente (hoy revienta con 'column p.futa_employer does not exist').

**Pruebas**

- `tests/payroll/gl-posting.spec.ts` — depositDueDate('941_federal','2026-03-31','monthly') devuelve '2026-04-15' y depositDueDate('imss','2026-03-31','monthly') devuelve '2026-04-17'; el cambio de año (periodEnd en diciembre) devuelve enero del año siguiente
- `tests/payroll/gl-posting.spec.ts` — Con un mapeo al que le falta 'isr_payable' y un ISR de 500, postPayRunToGL lanza MISSING_PAYROLL_BUCKET y nunca llama a createJournalEntry (spy)
- `tests/payroll/gl-posting.spec.ts` — El armado de líneas para una corrida MX con subsidio entregado cuadra: suma de cargos = suma de abonos, y la línea del bucket subsidio_empleo_receivable existe con el importe entregado
- `tests/payroll/gl-posting.spec.ts` — Con pay_runs.journal_entry_id ya poblado, postPayRunToGL devuelve ese id sin emitir ningún INSERT

**Riesgo.** Los buckets separados EE/ER cambian el catálogo esperado de payroll_account_mapping; una entidad con mapeos manuales previos seguiría funcionando por el camino de retrocompatibilidad, pero el console.warn debe ser explícito para que no se normalice. Mitigación adicional: `mnemosine doctor` lista los buckets legados en uso.

##### `E4.1-k` Marcar depositado un pasivo fiscal (lo que hace que 941 y 940 dejen de reportar cero) · **S**

Los dos generadores leen los depósitos con `AND deposited_at IS NOT NULL` (form-941-generator.ts:66, form-940-generator.ts:48). Con E4.1-j las filas ya existen, pero nacen 'pending': sin un camino que las marque depositadas, line_13 sigue en cero. Falta la mitad del circuito.

Crear src/services/payroll/common/tax-liability-service.ts:
```ts
export async function listTaxLiabilities(
  tenantId: string,
  filters: { entityId?: string; status?: 'pending'|'deposited'|'late'|'waived'; dueBefore?: string }
): Promise<TaxLiabilityRow[]>
```
Ordena por due_date ascendente y marca en el resultado un campo derivado `is_overdue = status='pending' AND due_date < CURRENT_DATE`.

```ts
export async function markTaxLiabilityDeposited(
  id: string,
  args: { depositedAt: string; reference: string; userId: string }
): Promise<TaxLiabilityRow>
```
Corre en withTransaction: bloquea la fila FOR UPDATE; si status !== 'pending', `AccountingError('LIABILITY_NOT_PENDING', ...)`; actualiza `deposited_at`, `deposit_reference`, `deposited_by = userId` y `status = (depositedAt::date > due_date ? 'late' : 'deposited')` — la propia base clasifica el entero tardío, sin criterio humano. Devuelve la fila.

Rutas en src/api/rest/routes/payroll.ts:
- `GET /v1/payroll/tax-liabilities` con requirePermission('payroll:read') y requireEntityAccess; query status, due_before, entity_id.
- `POST /v1/payroll/tax-liabilities/:id/deposit` con requirePermission('payroll:approve') y validateBody(z.object({ deposited_at: z.string().regex(/^\d{4}-\d{2}-\d{2}/), reference: z.string().min(1).max(100) })); antes de actuar, lee entity_id de la fila y llama assertEntityAccess (el patrón de journal-entries.ts:19-26) — hoy ninguna ruta de nómina comprueba propiedad por recurso.

No se genera asiento contable al marcar el depósito: el pasivo ya está abonado por el asiento de nómina y su cancelación contra banco es un pago que corresponde al ciclo de tesorería. Si al implementar se decide que el depósito debe cargar el pasivo y abonar banco, va por createJournalEntry como todo lo demás y se documenta como tarea aparte; no se cuela aquí.

**Archivos**

- `src/services/payroll/common/tax-liability-service.ts` — crear — listTaxLiabilities, markTaxLiabilityDeposited y el tipo TaxLiabilityRow
- `src/api/rest/routes/payroll.ts` — modificar — GET /tax-liabilities y POST /tax-liabilities/:id/deposit, ambas con comprobación de entidad por recurso

**Criterios de aceptación**

- Dada una corrida US posteada del primer trimestre y su pasivo '941_federal' marcado como depositado, cuando corre generateForm941 para ese trimestre, entonces line_13_total_deposits es igual al importe depositado (hoy es 0 siempre).
- Dada la misma corrida sin marcar el depósito, cuando corre generateForm941, entonces line_13_total_deposits es 0 — el formato refleja la realidad, no el devengo.
- Dado un pasivo con due_date 2026-04-15 y deposited_at 2026-04-20, cuando se marca depositado, entonces status queda en 'late', no en 'deposited'.
- Dado un pasivo ya depositado, cuando se llama otra vez a /deposit, entonces responde error LIABILITY_NOT_PENDING y deposit_reference no cambia.
- Dado un usuario sin membresía en la entidad del pasivo, cuando llama a POST /tax-liabilities/:id/deposit, entonces responde 403 y la fila no se modifica.
- Dado GET /v1/payroll/tax-liabilities?status=pending&due_before=hoy, entonces devuelve las filas vencidas ordenadas por due_date con is_overdue=true.

**Pruebas**

- `tests/payroll/tax-liability.spec.ts` — markTaxLiabilityDeposited clasifica 'late' cuando deposited_at supera due_date y 'deposited' cuando no, y lanza LIABILITY_NOT_PENDING sobre una fila ya depositada (client mockeado)

**Riesgo.** Sin recordatorio, los pasivos se quedan en 'pending' y los formatos vuelven a reportar cero — el mismo síntoma por otra causa. Mitigación: el barrido de vencidos es una de las seis necesidades del runtime de trabajos en segundo plano; dejar listTaxLiabilities con el filtro dueBefore preparado para que ese paquete sólo tenga que llamarla.

##### `E4.1-l` Asiento de dispersión al marcar la corrida como pagada · **S**

Condicionada a que la decisión sobre cash_payroll se resuelva por la opción de pasivo. Si se resuelve por banco directo, esta tarea no se hace y el asiento de nómina ya abona banco.

En src/services/payroll/common/gl-posting-service.ts añadir:
```ts
export async function postPayRunDisbursement(
  client: pg.PoolClient,
  payRunId: string,
  userId: string,
  bankAccountId: string | null
): Promise<string | null>
```
DR bucket `cash_payroll` (Sueldos por Pagar) por total_net_pay · CR la cuenta contable de la bank_accounts indicada, o el rol 'banco' si viene null — reusando `bankGlAccount` de src/services/accounting/ar-ap-posting.ts (línea 160), que ya implementa exactamente esa resolución y hay que exportar. entry_type JournalEntryType.PAYROLL, sourceType 'pay_run_disbursement', sourceId payRunId, autoPost true, sobre el client del llamador. Idempotente: si ya existe un journal_entries con ese source_type/source_id para la entidad, devolver null.

En src/services/payroll/common/pay-run-service.ts, markPayRunPaid (línea 129) pasa a correr en withTransaction: bloquea la corrida FOR UPDATE, exige status='approved' y journal_entry_id NOT NULL (`AccountingError('PAY_RUN_NOT_POSTED', 'Postea la corrida al mayor antes de marcarla pagada')`), llama a postPayRunDisbursement, actualiza status='paid' y paid_at, y fuera de la transacción dispara dispatchEvent, la métrica y attestEntryAsync del asiento de dispersión si se creó. Añadir `bank_account_id` opcional al body de POST /v1/payroll/pay-runs/:id/mark-paid.

**Archivos**

- `src/services/accounting/ar-ap-posting.ts` — modificar — exportar bankGlAccount
- `src/services/payroll/common/gl-posting-service.ts` — modificar — añadir postPayRunDisbursement
- `src/services/payroll/common/pay-run-service.ts` — modificar — markPayRunPaid en transacción, con guarda de estado y llamada a postPayRunDisbursement
- `src/api/rest/routes/payroll.ts` — modificar — mark-paid acepta bank_account_id y devuelve disbursement_entry_id

**Criterios de aceptación**

- Dada una corrida aprobada y posteada al mayor, cuando POST /v1/payroll/pay-runs/:id/mark-paid, entonces se crea un asiento posteado DR Sueldos por Pagar / CR Banco por el neto total, y pay_runs.status='paid'.
- Dada una corrida aprobada pero sin postear al mayor, cuando se marca pagada, entonces falla con PAY_RUN_NOT_POSTED y el status sigue en 'approved'.
- Dada una corrida ya pagada, cuando se vuelve a marcar pagada, entonces no se crea un segundo asiento de dispersión.
- Dado el asiento de nómina y el de dispersión, cuando se consulta el saldo de la cuenta Sueldos por Pagar del periodo, entonces vuelve a cero.

**Pruebas**

- `tests/payroll/gl-posting.spec.ts` — postPayRunDisbursement devuelve null y no llama a createJournalEntry cuando ya existe un asiento con source_type='pay_run_disbursement' para esa corrida

**Riesgo.** Depende de la decisión sobre cash_payroll; si se resuelve tarde, se implementa el resto del paquete y esta tarea queda pendiente sin bloquear a las demás.

##### `E4.1-m` E2E de nómina contra base real, al estilo de e2e-arap · **L**

Crear scripts/e2e-nomina.ts con la estructura de scripts/e2e-arap.ts y el descubrimiento de fixtures descrito en E4.1-f (nada de UUIDs hardcodeados). Es la única forma de detectar los errores de esquema que los tests con `query` mockeado nunca ven.

Pasos:
1. Descubre tenant, legal_entity y user; `enterTenant(tenant.id)`. Verifica account_roles y payroll_account_mapping y, si faltan, llama a seedAccountRoles y seedPayrollAccountMapping. Aserción: los 8 buckets existen.
2. Crea un pay_schedules quincenal MX (frequency='quincenal', country_code='MX', first_period_start el día 1 del mes en curso) y genera sus periodos con generatePayPeriods; toma el periodo cuya pay_date caiga dentro de un fiscal_period abierto de la entidad — si no lo hay, aborta con un mensaje que lo diga (createJournalEntry lanza PERIOD_CLOSED, posting.ts:99-104).
3. Crea un empleado MX con createEmployee: country_code='MX', sbc conocido (p. ej. 500.00 diarios), riesgo_puesto='01', sin crédito INFONAVIT.
4. `createPayRun({ tenant_id, pay_period_id, run_type:'regular', employee_inputs:[...], created_by })` con una percepción 'salary' de 7500.00 quincenales, y `calculatePayRun`.
   Aserciones: paychecks tiene 1 fila; paycheck_taxes tiene filas EE y ER de IMSS por ramo, más isr y subsidio_empleo; SUM(tax_amount) de las filas ER 'imss_%' = paychecks.imss_employer ±0.01; subsidio_aplicado + subsidio_entregado = subsidio_empleo; net_pay = gross − pre_tax − impuestos EE − post_tax + subsidio_entregado.
5. Segundo caso, el que hoy se pierde: un empleado con base baja (p. ej. 1500.00 quincenales) donde el subsidio supera al ISR. Aserciones: subsidio_entregado > 0, ISR neto retenido 0 y el neto por encima del bruto menos deducciones.
6. `approvePayRun` y comprobación de que postear en 'draft' falla: intenta postPayRunToGL antes de aprobar y espera PAY_RUN_NOT_APPROVED.
7. `postPayRunToGL`. Aserciones sobre el asiento: entry_type='payroll', status='posted', cuadra (SUM debit = SUM credit), tiene la línea de cargo a Sueldos y Salarios por el bruto total, la de abono a Sueldos por Pagar por el neto total, la de abono a isr_payable por SUM(isr_withheld − subsidio_aplicado), y la de cargo a subsidio_empleo_receivable por el subsidio entregado. pay_runs.journal_entry_id quedó ligado.
8. Idempotencia: segunda llamada a postPayRunToGL devuelve el mismo id y no crea asiento nuevo.
9. employer_tax_liabilities: tres filas MX ('isr','imss','infonavit'), status='pending', due_date el 17 del mes siguiente al period_end. Marca 'isr' como depositada con markTaxLiabilityDeposited y comprueba el status resultante.
10. `markPayRunPaid` con la cuenta bancaria del rol 'banco' y comprobación de que el saldo del periodo en Sueldos por Pagar vuelve a 0 (sólo si la tarea E4.1-l se implementó).
11. `await drainAttestations(2000)`.

Limpieza en un finally, en orden de FK: paycheck_taxes, paycheck_earnings, paycheck_deductions, paychecks, employer_tax_liabilities, pay_runs, pay_periods, pay_schedules, employees, y luego los asientos con el mismo bloque de reversión de account_balances de e2e-arap.ts:219-228 antes del DELETE de journal_entries.

**Archivos**

- `scripts/e2e-nomina.ts` — crear — el guion descrito
- `package.json` — modificar — si E4.1-f no lo hizo ya, añadir el script e2e:nomina

**Criterios de aceptación**

- Dado un entorno con `mnemosine init` corrido, cuando se ejecuta `npm run e2e:nomina`, entonces imprime RESULTADO con 0 ✗ y sale con código 0.
- Dada una segunda ejecución consecutiva, entonces vuelve a salir en 0 y no quedan filas de prueba en paychecks, pay_runs ni employer_tax_liabilities.
- Dado el caso de subsidio mayor que ISR, cuando el script lo evalúa, entonces la aserción de subsidio_entregado > 0 pasa (contra el código actual falla, que es exactamente lo que el script debe demostrar antes del arreglo).
- Dado que la entidad no tiene un fiscal_period abierto que cubra la pay_date, cuando corre el script, entonces aborta con un mensaje que nombra el periodo faltante y sale con código 2, en lugar de fallar con PERIOD_CLOSED sin contexto.

**Riesgo.** createPayRunSchema de la ruta REST admite run_type='finiquito', valor que el CHECK de pay_runs (008_payroll.sql:159) no acepta; el script usa 'regular' y no lo tropieza, pero el desajuste sigue vivo y debe quedar registrado como hallazgo del test de contrato de E1.4. Segundo riesgo: calculatePayRun no borra los recibos previos, así que recalcular una corrida choca contra UNIQUE(pay_run_id, employee_id); el script no recalcula, y el arreglo pertenece al paquete del ciclo de vida del pay run.

#### Cómo se sabe que cerró

- `npm run typecheck` sale en 0 y `npm test` pasa con las suites nuevas: tests/banking/matching.spec.ts, tests/banking/reconciliation.spec.ts, tests/banking/bank-accounts.spec.ts, tests/payroll/paycheck-taxes.spec.ts, tests/payroll/mx/subsidio.spec.ts, tests/payroll/mx/isr.spec.ts, tests/payroll/gl-posting.spec.ts, tests/payroll/tax-liability.spec.ts, tests/payroll/account-mapping-seed.spec.ts y tests/database/migration-031.spec.ts.
- `npm run e2e:banco` sale en 0 dos veces seguidas sobre la misma base.
- `npm run e2e:nomina` sale en 0 dos veces seguidas sobre la misma base.
- Cero matches huérfanos: `SELECT COUNT(*) FROM reconciliation_matches WHERE reconciliation_session_id IS NULL AND matched_at > (fecha de despliegue)` devuelve 0.
- Ninguna línea conciliada dos veces: `SELECT matched_entity_id, COUNT(*) FROM reconciliation_matches WHERE unmatched_at IS NULL AND is_partial = false GROUP BY 1 HAVING COUNT(*) > 1` devuelve cero filas, y el intento de provocarlo falla por índice único.
- Ninguna sesión 'balanced' sin comprobación: `SELECT COUNT(*) FROM reconciliation_sessions WHERE status = 'balanced' AND (computed_at IS NULL OR ending_balance_per_books = 0)` devuelve 0.
- Comisiones e intereses en el mayor: para toda sesión cerrada, `SELECT COUNT(*) FROM bank_transactions bt JOIN reconciliation_sessions rs ON rs.bank_account_id = bt.bank_account_id AND bt.transaction_date BETWEEN rs.start_date AND rs.end_date WHERE rs.status = 'balanced' AND bt.transaction_type IN ('fee','interest','adjustment') AND bt.is_matched = false` devuelve 0.
- Alta de cuentas bancarias por producto: `POST /v1/bank-accounts` crea una cuenta utilizable por el flujo completo (importar, conciliar, cerrar) sin un solo INSERT manual, demostrado por el paso 1 de e2e-banco.ts.
- Tablas huérfanas pobladas: tras una corrida de nómina, `SELECT COUNT(*) FROM paycheck_taxes WHERE paycheck_id = $1` es > 0 y `SELECT COUNT(*) FROM employer_tax_liabilities WHERE pay_run_id = $1` es igual al número de conceptos con importe.
- 941 y 940 dejan de reportar cero: con el pasivo '941_federal' marcado depositado, generateForm941 devuelve line_13_total_deposits igual al importe depositado; y generateForm940 se ejecuta sin el error 'column p.futa_employer does not exist'.
- Subsidio al empleo: `SELECT COUNT(*) FROM paychecks WHERE subsidio_empleo > 0 AND subsidio_aplicado + subsidio_entregado <> subsidio_empleo` devuelve 0.
- Nada de posteo doble de nómina: `SELECT source_id, COUNT(*) FROM journal_entries WHERE source_type = 'pay_run' GROUP BY 1 HAVING COUNT(*) > 1` devuelve cero filas.
- Entidad nueva operativa de punta a punta: tras `mnemosine init` en un tenant limpio, account_roles tiene 33 filas, payroll_account_mapping tiene 8, y ni postPayRunToGL ni postStatementAdjustments lanzan MISSING_ROLE_ACCOUNT ni MISSING_PAYROLL_BUCKET.


### E4.2 · Trabajos en segundo plano, semántica de saldos y unificación de reportes
**Objetivo.** Dar al sistema un lugar donde ejecutar trabajo diferido (un runtime de tareas persistidas en Postgres, con reclamo atómico, historial, métricas y despliegue propio), sacar del camino crítico del posteo los dos REFRESH completos de vistas materializadas que hoy dispara cada asiento, y colapsar las cuatro copias divergentes del SQL de reportes en una sola capa de consulta con un test que impida que vuelvan a separarse. En el camino se documenta y se hace comprobable la semántica de account_balances (beginning_balance / ending_balance).

**Por qué aquí.** El trigger de refresco es el único cuello de botella medible del motor: cada fila que pasa a 'posted' ejecuta DOS `REFRESH MATERIALIZED VIEW CONCURRENTLY` dentro de la transacción del posteo, sobre vistas que hacen `accounts CROSS JOIN fiscal_periods` de TODOS los tenants — y que, verificado, no tienen un solo lector en src/, scripts/ ni tests/. Es coste puro. Al mismo tiempo hay seis necesidades (reintento de webhooks salientes, drenaje de entregas entrantes, depreciación mensual, revalidación de CFDI, presupuesto de IA, y el propio refresco si se conserva) que ya tienen tabla, índice o función escrita y sólo les falta dónde correr. El paquete va después de la auditoría desde el motor (E4.1) porque la depreciación y la reversa por CFDI cancelado deben quedar auditadas, y antes del descargador masivo del SAT, que el propio atlas declara dependiente de este runtime. La unificación de reportes entra aquí y no antes porque el worker necesita leer saldos (presupuesto, invariantes) y sería la quinta copia del mismo SQL.

**Depende de:** `E4.1`, `E3.2` · **Migraciones:** `047-050` · **12 tareas · 8.4 sem-persona**

**Precondiciones:**

- E4.1 cerrado: audit_log se escribe desde el motor (posting.ts / period-close.ts), de modo que lo que el worker postee quede auditado sin depender del middleware REST.
- El runner de migraciones sigue ejecutando cada archivo .sql como UNA sola llamada a client.query (src/database/migrate.ts:43) y reaplica src/database/rls-policies.sql después (migrate.ts:53-58). Ninguna migración de este paquete puede contener sentencias que exijan estar fuera de bloque de transacción.
- Existen los dos roles de base: mnemosine_owner (config.database.migrationUrl) y mnemosine_app (config.database.url). El refresco de vistas materializadas SOLO puede correr como propietario — es exactamente el fallo que documenta 024_mv_refresh_security_definer.sql.
- Hay una entidad con periodos fiscales y al menos un asiento posteado, para poder medir el antes/después del posteo.

#### Decisiones a resolver

**¿El runtime de trabajos se construye sobre bullmq + Redis, o se extiende el patrón de tareas persistidas en Postgres que ya existe (ai_jobs + claim atómico + `mnemosine jobs run-due`)?**

bullmq está en package.json:31 y no se importa en ningún punto de src/. El único uso de Redis es src/services/cache/redis.ts, que además falla suave: si Redis no está, getRedis() se anula y todo sigue funcionando ('Redis not available, caching disabled'). En cambio ya existe un runtime de tareas programadas COMPLETO y probado: tabla ai_jobs con reclamo atómico por UPDATE guardado, auto-desactivación por fallos consecutivos, historial en ai_job_runs, matcher de cron propio sin dependencias, y un comando `mnemosine jobs run-due` pensado para cron/launchd. Adoptar bullmq convertiría Redis en dependencia DURA de un producto CLI-first que hoy funciona sin él, y obligaría a mantener dos modelos de trabajo diferido en el mismo repositorio.

- Postgres: extender el patrón de ai_jobs a system_tasks y RETIRAR bullmq de package.json.
- bullmq: colas en Redis, workers con concurrencia y backoff nativos; ai_jobs se mantiene aparte o se migra también.
- Híbrido: Postgres para lo programado (cron) y bullmq sólo para lo encolado por evento (entregas de webhook).

_Recomendación:_ Postgres. El paquete está especificado sobre esa base. Las seis necesidades son periódicas, no de alto caudal por evento; el reclamo atómico ya está escrito y probado; Redis dejaría de ser opcional; y dos modelos de trabajo diferido en un repositorio de este tamaño es exactamente la clase de duplicación que este mismo paquete está corrigiendo en los reportes. Si se elige esto, retirar bullmq de package.json es parte del cierre: una dependencia declarada y no usada es una promesa falsa en el mapa de capacidades.

_Bloquea:_ E4.2-a y E4.2-b por completo; todas las demás tareas dependen de ellas.

**¿Qué se hace con mv_trial_balance y mv_account_balance_summary, que no tienen un solo lector?**

Verificado: fuera de src/database/migrations/, las dos vistas sólo aparecen en dos comentarios de posting.ts:434-435. Ninguna consulta del producto las lee — todo reporte se calcula desde journal_entry_lines. Aun así, cada asiento posteado paga dos REFRESH CONCURRENTLY completos dentro de su transacción, sobre vistas que cruzan accounts × fiscal_periods de TODOS los tenants. Además no están cubiertas por RLS (rls-policies.sql sólo recorre relkind 'r'/'p'), así que cualquier lector futuro depende de filtrar por entity_id a mano.

- Retirarlas: DROP de los dos triggers, las dos funciones y las dos vistas en la migración 032.
- Conservarlas y refrescarlas desde el worker cada 15 minutos, sin que nadie las lea todavía.
- Conservarlas y hacer que la capa unificada de reportes las use como camino rápido para la balanza histórica, aceptando frescura de 15 minutos.

_Recomendación:_ Retirarlas. account_balances ya es la denormalización por (cuenta, periodo) y se mantiene transaccionalmente en el mismo posteo; las vistas son una segunda denormalización redundante, más cara, sin RLS y sin consumidores. Si más adelante aparece una necesidad real de balanza pre-agregada, reconstruirla con lectores desde el primer día es más barato que arrastrar dos artefactos que hoy sólo cuestan. Nota: si algún consumidor externo al repositorio (BI, consultas del despacho) las lee, esta decisión cambia y hay que elegir la opción 2.

_Bloquea:_ E4.2-c (contenido exacto de la migración 032 y existencia del manejador reporting_views_refresh).

**¿Cómo se despliega el worker: proceso propio de larga vida, `worker tick` desde cron externo, o dentro del proceso HTTP?**

El repositorio ya tiene el precedente del cron externo: `mnemosine jobs run-due` está pensado para que cron/launchd lo invoque (jobs-command.ts:11-14,130). El servidor HTTP arranca en src/index.ts y no tiene hoy ningún bucle de fondo. El drenaje de webhooks entrantes implica turnos de modelo, que no deben ocurrir dentro de una petición HTTP.

- Proceso propio `mnemosine worker run` (contenedor/servicio aparte), con --metrics-port.
- `mnemosine worker tick` disparado por cron/launchd/Kubernetes CronJob.
- Bucle de fondo dentro del proceso del servidor HTTP.

_Recomendación:_ Soportar las dos primeras y prohibir la tercera. `worker run` como servicio en docker-compose para despliegues con contenedores, `worker tick` (con exit code 1 si alguna tarea falló) para despachos que sólo tienen cron. El proceso HTTP no debe hacer llamadas al modelo ni sostener bucles: mezclar ambos hace que escalar el API multiplique el trabajo de fondo. El reclamo atómico ya hace inofensivo que corran varias réplicas.

_Bloquea:_ E4.2-b (subcomandos de la CLI y servicio de docker-compose).

**¿Se puede persistir el cuerpo crudo de los webhooks entrantes, y por cuánto tiempo?**

ai_webhook_deliveries (028_ai_webhooks.sql:68-87) no guarda el cuerpo. processDelivery (reader-agent.ts:213) lo exige. Sin persistirlo, drenar una entrega ya registrada es literalmente imposible y toda entrega recibida sin runReaderTurn queda muerta para siempre. El cuerpo es dato de un tercero y puede contener información sensible del cliente (movimientos bancarios, notificaciones del buzón del SAT).

- Persistir raw_body y borrarlo (NULL) en cuanto la entrega deja 'received' — retención acotada por el ciclo de vida, sin tarea de purga.
- Persistir raw_body con retención fija (p. ej. 30 días) y una tarea de purga.
- No persistir: cablear runReaderTurn en el router y procesar dentro de la petición HTTP; las entregas fallidas se pierden.

_Recomendación:_ Opción 1, más un plazo máximo: toda entrega que lleve más de 7 días en 'received' se marca 'rejected' y se vacía su raw_body. Da retención mínima, hace posible el reintento y no mete llamadas al modelo dentro de una petición HTTP. La opción 3 es la peor: convierte una caída del modelo en pérdida definitiva del documento.

_Bloquea:_ E4.2-e por completo (migración 033 y el manejador de drenaje).

**En la balanza filtrada por periodo fiscal, ¿el importe devuelto debe incluir el saldo de apertura arrastrado?**

Hoy GET /v1/reports/trial-balance?fiscal_period_id=X devuelve una columna llamada `ending_balance` que en realidad es sólo la actividad del periodo: ignora account_balances.beginning_balance, que carryForwardBalances sí escribe al cierre duro. Para una cuenta de balance en un periodo posterior a un arrastre, el saldo verdadero es beginning_balance + actividad. Lo mismo ocurre en mv_trial_balance.net_balance y en el resolver GraphQL. Corregirlo cambia la salida de una API que ya está publicada.

- Devolver opening_balance, period_debits, period_credits y closing_balance (= opening + débitos − créditos), retirando el nombre `ending_balance`.
- Mantener la salida actual y limitarse a renombrar la columna a `period_activity`.
- Devolver ambas: la actual como está y las nuevas columnas al lado.

_Recomendación:_ Opción 1. Una columna llamada `ending_balance` que no es el saldo final es una trampa para el consumidor y para el propio agente, que lee estas salidas y razona sobre ellas. La balanza de comprobación mexicana se presenta precisamente como saldo inicial, cargos, abonos y saldo final, así que la forma correcta es también la esperada por un contador. La ruptura de contrato debe anunciarse en el CHANGELOG y en cli-reference.

_Bloquea:_ E4.2-j (forma de TrialBalanceAccount) y E4.2-k (respuestas de REST y GraphQL).

**Al unificar, ¿qué se hace con las divergencias reales entre las copias actuales (HAVING del estado de resultados, orden de la antigüedad, 2 vs 4 decimales, account_level obligatorio, only_with_balance)?**

Las dos copias NO son idénticas hoy: el estado de resultados REST descarta con HAVING sobre el neto (una cuenta con débitos y créditos iguales desaparece) mientras la del agente la conserva; la antigüedad REST ordena por nombre de cliente y la del agente por days_overdue; REST formatea a 4 decimales y el agente a 2; REST aplica siempre account_level <= 5 y el agente no tiene ese filtro; only_with_balance sólo existe en el agente.

- Superconjunto: todos los filtros son opcionales en la capa, y cada superficie conserva sus valores por defecto y su formateo actuales (cero cambio observable).
- Converger a una sola semántica y aceptar que ambas superficies cambien.
- Congelar dos perfiles nombrados ('rest' y 'agent') dentro de la capa.

_Recomendación:_ Opción 1. La unificación debe eliminar la duplicación de SQL, no aprovechar para cambiar en silencio lo que ven usuarios y agente. Excepciones que sí deben converger porque son defectos y no preferencias: el HAVING del estado de resultados (la variante REST oculta cuentas con movimiento neto cero, que un contador necesita ver), account_level (deja de aplicarse por defecto), y la fuga de asientos draft/void del resolver GraphQL. Cada una debe quedar enumerada en el PR con el antes y el después.

_Bloquea:_ E4.2-j y E4.2-k (los golden files de comparación).

**Cuando la revalidación descubre que un CFDI ya contabilizado fue cancelado por el emisor, ¿qué hace el sistema?**

El clasificador ya prevé satStatus='cancelado' y tiene escrita la decisión cfdi_cancelado. La corrección contable de un documento ya posteado sólo puede hacerse por reversa (NIF B-1), nunca por edición. Pero decidir reversar una factura de un proveedor por lo que reporta un servicio externo es una decisión de negocio con efectos fiscales.

- Sólo alertar: pregunta pendiente para revisión humana, ningún efecto contable.
- Alertar y dejar preparado un borrador de asiento de reversa que un humano aprueba.
- Reversar automáticamente.

_Recomendación:_ Opción 1 en este paquete y opción 2 cuando el clasificador declarativo esté cableado al pipeline vivo. La reversa automática queda descartada: una consulta al SAT con un fallo transitorio no puede mover el mayor sin intervención, y el sistema ya tiene el canal correcto para esto (ai_questions, visible en `mnemosine questions`).

_Bloquea:_ E4.2-g (qué escribe el manejador ante una transición valid→cancelled).

**El presupuesto de IA, ¿es por entidad o por tenant, y alerta o corta?**

ai_usage tiene tenant_id y entity_id, y summarizeUsage agrega por entidad (usage-ledger.ts:168: `WHERE entity_id = $1`). En un despacho que atiende varias empresas, el gasto que importa puede ser el del despacho (tenant) o el imputable a cada cliente (entidad). Cortar el gasto exige una compuerta en createLlmSessionWithFailover, que no está en el alcance de este paquete.

- Por entidad, sólo alerta.
- Por tenant, sólo alerta.
- Por entidad y por tenant, con corte duro al 100% del presupuesto.

_Recomendación:_ Por entidad y sólo alerta en este paquete: la entidad es la unidad de imputación que el despacho factura a su cliente, y summarizeUsage ya funciona así. El corte duro debe ir en el paquete del agente, junto al failover a mitad de sesión, porque comparte la misma compuerta de creación de sesión. Añadir el presupuesto por tenant después es sumar una tarea con entity_id NULL, no rehacer nada.

_Bloquea:_ E4.2-h (alcance de checkBudget y del manejador).

#### Tareas

##### `E4.2-a` Tabla system_tasks / system_task_runs y su almacén con reclamo atómico · **M**

Crear el sustrato de persistencia del worker replicando EXACTAMENTE el patrón ya probado de ai_jobs (022_ai_jobs.sql) y src/ai/jobs/job-store.ts. No se inventa nada nuevo: reclamo por UPDATE guardado con RETURNING, contador de fallos consecutivos con auto-desactivación, e historial de ejecuciones.

Migración 031_system_tasks.sql (todo en sentencias normales; nada que exija estar fuera de transacción, porque migrate.ts:43 ejecuta el archivo entero en una sola llamada):

CREATE TABLE system_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  entity_id UUID REFERENCES legal_entities(id),
  kind VARCHAR(60) NOT NULL CHECK (kind IN ('webhook_retry_sweep','webhook_reader_drain','depreciation_monthly','cfdi_revalidation','ai_budget_alert','reporting_views_refresh')),
  schedule VARCHAR(100) NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  max_failures INTEGER NOT NULL DEFAULT 5 CHECK (max_failures > 0),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_system_tasks_scope ON system_tasks (kind, tenant_id, COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_system_tasks_due ON system_tasks (enabled, next_run_at);

CREATE TABLE system_task_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES system_tasks(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL CHECK (status IN ('ok','noop','error')),
  processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),
  detail JSONB
);
CREATE INDEX idx_system_task_runs_task ON system_task_runs (task_id, started_at DESC);

tenant_id es NOT NULL a propósito: así el bucle de catálogo de rls-policies.sql (que selecciona por presencia de tenant_id/entity_id) genera la política tenant_isolation sin tocar el archivo, y el worker queda obligado a operar dentro de withTenant. No se añaden filas a mano en la lista de tablas hijas.

src/worker/task-store.ts exporta:
  export type SystemTaskKind = 'webhook_retry_sweep' | 'webhook_reader_drain' | 'depreciation_monthly' | 'cfdi_revalidation' | 'ai_budget_alert' | 'reporting_views_refresh';
  export const SYSTEM_TASK_KINDS: SystemTaskKind[];
  export interface SystemTaskRow { id; tenant_id; entity_id: string|null; kind: SystemTaskKind; schedule: string; params: Record<string,unknown>; enabled: boolean; consecutive_failures: number; max_failures: number; last_run_at: Date|null; next_run_at: Date|null; }
  export async function upsertSystemTask(tenantId: string, input: { kind: SystemTaskKind; entityId?: string; schedule: string; params?: Record<string,unknown>; maxFailures?: number; createdBy?: string }): Promise<SystemTaskRow>  // ON CONFLICT sobre ux_system_tasks_scope: actualiza schedule/params y recalcula next_run_at
  export async function listSystemTasks(tenantId: string): Promise<SystemTaskRow[]>
  export async function setSystemTaskEnabled(tenantId: string, taskId: string, enabled: boolean): Promise<SystemTaskRow>  // habilitar resetea consecutive_failures y recalcula next_run_at, igual que setEnabled (job-store.ts:200)
  export async function claimDueSystemTasks(tenantId: string, now?: Date): Promise<SystemTaskRow[]>
  export async function recordSystemRun(tenantId: string, taskId: string, input: { status: 'ok'|'noop'|'error'; processed?: number; detail?: Record<string,unknown>; startedAt: Date; finishedAt?: Date }): Promise<{ runId: string; autoDisabled: boolean }>

claimDueSystemTasks es una transcripción literal de claimDueJobs (job-store.ts:235-266): SELECT de las debidas, y por cada una un UPDATE guardado por `WHERE id=$ AND tenant_id=$ AND enabled=true AND next_run_at <= NOW() AND next_run_at = $expected` con `next_run_at = GREATEST($next::timestamptz, date_trunc('minute', NOW()) + interval '1 minute')`. rowCount 0 significa que otro worker la reclamó. La expresión cron se parsea con nextRunAt() importado de src/ai/jobs/job-store.ts — NO se duplica el matcher.

recordSystemRun replica recordRun (job-store.ts:294-345) con la misma semántica del contador: 'error' incrementa y auto-desactiva al llegar a max_failures en un solo UPDATE guardado por enabled=true; 'ok' resetea; 'noop' NO toca el contador (un ciclo vacío no dice nada sobre la salud de la tarea).

**Archivos**

- `src/database/migrations/031_system_tasks.sql` — crear: DDL de system_tasks y system_task_runs con sus índices
- `src/worker/task-store.ts` — crear: tipos, CRUD, claimDueSystemTasks y recordSystemRun (patrón de src/ai/jobs/job-store.ts)
- `src/ai/jobs/job-store.ts` — modificar: ninguna firma cambia; sólo se reutilizan nextRunAt/parseCronSchedule desde el nuevo módulo

**Migración**

```sql
src/database/migrations/031_system_tasks.sql (ver especificación). Sin backfill: las filas las siembra la tarea E4.2-b vía `mnemosine worker install`.
```

**Criterios de aceptación**

- Dado `npm run migrate` sobre una base ya migrada, cuando termina, entonces existen system_tasks y system_task_runs y `SELECT polname FROM pg_policies WHERE tablename='system_tasks'` devuelve 'tenant_isolation' (la generó el bucle de catálogo, sin editar rls-policies.sql).
- Dadas dos llamadas concurrentes a claimDueSystemTasks para el mismo tenant con una tarea debida, cuando ambas terminan, entonces exactamente una devuelve la fila y la otra devuelve [].
- Dada una tarea con max_failures=2 y consecutive_failures=1, cuando recordSystemRun registra status 'error', entonces devuelve autoDisabled=true y la fila queda enabled=false.
- Dada una tarea con consecutive_failures=1, cuando recordSystemRun registra 'noop', entonces consecutive_failures sigue siendo 1.
- Dada una tarea con schedule inválido editada a mano, cuando corre claimDueSystemTasks, entonces la tarea se omite sin lanzar y las demás sí se reclaman.

**Pruebas**

- `tests/worker/task-store.spec.ts` — claimDueSystemTasks: reclamo exclusivo (segundo llamador recibe []), clamp de next_run_at al futuro del reloj de la BD, y omisión silenciosa de una schedule inválida
- `tests/worker/task-store.spec.ts` — recordSystemRun: 'error' incrementa y auto-desactiva en el umbral, 'ok' resetea, 'noop' no toca el contador; una tarea ya deshabilitada devuelve autoDisabled=false
- `tests/worker/task-store.spec.ts` — upsertSystemTask dos veces con el mismo (kind, tenant, entity=NULL) produce UNA fila y actualiza schedule

**Riesgo.** El índice único con COALESCE sobre entity_id es la única pieza no copiada del original; si se escribe como UNIQUE(kind, tenant_id, entity_id) las filas con entity_id NULL dejan de deduplicarse y se pueden crear N tareas globales del mismo kind. El test de duplicado lo cubre.

##### `E4.2-b` Runtime del worker: registro de manejadores, tick por tenant, CLI y observabilidad · **L**

Construir el proceso que ejecuta las tareas. Es un proceso de CLI, no un modo del servidor HTTP: mnemosine es CLI-first y el servidor no debe hacer llamadas al modelo dentro de una petición.

src/worker/registry.ts:
  export interface TaskDeps { makeRunReaderTurn?: (ctx: AgentContext) => RunReaderTurn; }  // inyección, mismo patrón que RunnerDeps (jobs/runner.ts:32)
  export interface TaskContext { tenantId: string; task: SystemTaskRow; deps: TaskDeps; onProgress?: (m: string) => void; }
  export interface TaskResult { status: 'ok' | 'noop'; processed: number; detail?: Record<string, unknown>; }
  export type TaskHandler = (ctx: TaskContext) => Promise<TaskResult>;
  export const TASK_HANDLERS: Record<SystemTaskKind, TaskHandler>;
El registro es un objeto plano: cada tarea de este paquete registra su manejador aquí y el módulo NO importa nada de src/api ni de src/cli.

src/worker/runtime.ts:
  export interface TickSummary { tenants: number; claimed: number; ok: number; noop: number; error: number; autoDisabled: string[]; }
  export async function runWorkerTick(opts: { deps: TaskDeps; tenantIds?: string[]; kinds?: SystemTaskKind[]; onProgress?: (m: string) => void }): Promise<TickSummary>
  export async function startWorker(opts: { deps: TaskDeps; intervalMs?: number; signal: AbortSignal; onProgress?: (m: string) => void }): Promise<void>

runWorkerTick:
 1. Resuelve los tenants FUERA de contexto de tenant: `SELECT id FROM tenants WHERE is_active = true` (tenants está en la lista `excluded` de rls-policies.sql:20, así que no tiene política; mnemosine_app tiene SELECT por el bloque de grants). Si se pasa opts.tenantIds se usa esa lista tal cual.
 2. Por cada tenant: `await withTenant(tenantId, async () => { ... })`. Es obligatorio: app_current_tenant() devuelve NULL sin contexto y las políticas RLS no devuelven fila alguna (014_rls_tenant_isolation.sql:26-38). Nunca enterTenant() — el worker es un proceso de larga vida y enterWith no tiene ámbito (connection.ts:106-116).
 3. Dentro del contexto: claimDueSystemTasks(tenantId) y, por cada tarea reclamada, `TASK_HANDLERS[task.kind]({ tenantId, task, deps, onProgress })` dentro de try/catch. El fallo de una tarea NUNCA detiene el tick, ni el fallo de recordSystemRun (envolver el registro igual que safeRecord en runner.ts:103-115).
 4. Cada resultado se persiste con recordSystemRun y se refleja en métricas.

startWorker: bucle `while (!signal.aborted)` con intervalo por defecto 60_000 ms y jitter ±10% (para que dos réplicas no ticken al unísono; el reclamo atómico ya garantiza corrección, el jitter sólo evita contención). Al abortar: espera a que termine el tick en curso, llama a drainAttestations(10_000) y closeDatabase(). SIGINT/SIGTERM disparan el abort.

src/observability/worker-metrics.ts (prom-client, sin express — src/api/rest/middleware/metrics.ts arrastra express y no debe importarse desde la CLI):
  export const workerTaskRuns = new client.Counter({ name: 'accounting_worker_task_runs_total', labelNames: ['kind','status'] });
  export const workerTaskDuration = new client.Histogram({ name: 'accounting_worker_task_duration_seconds', labelNames: ['kind'], buckets: [0.05,0.25,1,5,15,60,300] });
  export const workerTaskItems = new client.Counter({ name: 'accounting_worker_task_items_total', labelNames: ['kind'] });
  export function startMetricsServer(port: number): http.Server  // node:http, responde 'GET /metrics' con client.register.metrics()
collectDefaultMetrics se invoca aquí envuelto en try/catch: metrics.ts ya lo llama con el mismo prefijo 'accounting_' y registrar dos veces lanza.

src/cli/worker-command.ts: registerWorkerCommand(program, deps) con la MISMA forma que registerJobsCommand (jobs-command.ts:77): opciones -e/--entity y -t/--tenant, helper run() que resuelve contexto, ejecuta y llama a deps.shutdown. Subcomandos:
  worker run [--interval <segundos>] [--metrics-port <p>] [--tenant <id>] [--kinds <lista>]  → startWorker
  worker tick                                                                                → un solo runWorkerTick; exit code 1 si alguna tarea terminó en 'error' (contrato para cron)
  worker install [--kinds <lista>]                                                           → upsertSystemTask con los horarios por defecto de la entidad/tenant actual
  worker list | worker enable <id> | worker disable <id> | worker history [--limit n]
El mensaje de `worker install` debe decir explícitamente cómo se dispara el tick, igual que hace jobs-command.ts:130.

Despliegue: añadir a docker/docker-compose.yml un servicio `worker` que reutiliza la misma imagen con `command: npx tsx src/cli/mnemosine.ts worker run --metrics-port 9101`, las mismas variables de entorno que `app` más MIGRATION_DATABASE_URL, y `depends_on: postgres`. No depende de redis.

**Archivos**

- `src/worker/registry.ts` — crear: TaskHandler, TaskContext, TaskResult y el mapa TASK_HANDLERS
- `src/worker/runtime.ts` — crear: runWorkerTick (bucle por tenant con withTenant) y startWorker (bucle con jitter, abort y drenaje)
- `src/observability/worker-metrics.ts` — crear: contadores/histograma prom-client del worker y servidor http mínimo de /metrics
- `src/cli/worker-command.ts` — crear: subcomandos run/tick/install/list/enable/disable/history
- `src/cli/mnemosine.ts` — modificar: importar y llamar registerWorkerCommand(program, {...}) junto a registerJobsCommand (línea 46)
- `docker/docker-compose.yml` — modificar: añadir el servicio `worker`
- `README.md` — modificar: sección de despliegue del worker (proceso propio o `worker tick` desde cron/launchd)

**Criterios de aceptación**

- Dado un despliegue sin tareas sembradas, cuando corre `mnemosine worker tick`, entonces imprime 0 tareas debidas y termina con código 0.
- Dado un tenant A con una tarea debida y un tenant B sin tareas, cuando corre un tick, entonces la tarea de A se ejecuta y ninguna consulta del manejador ve filas de B (verificable porque el manejador corre bajo withTenant(A) y RLS filtra).
- Dados dos procesos `worker run` simultáneos contra la misma base, cuando ambos tickean sobre la misma tarea debida, entonces system_task_runs registra exactamente una ejecución para ese slot.
- Dado un manejador que lanza, cuando corre el tick con otras dos tareas debidas, entonces las otras dos se ejecutan igualmente y la fallida queda con status 'error' y consecutive_failures+1.
- Dado `worker run --metrics-port 9101`, cuando se hace GET http://localhost:9101/metrics, entonces la respuesta contiene accounting_worker_task_runs_total.
- Dado un `worker run` en curso, cuando recibe SIGTERM, entonces termina el tick actual, drena las atestaciones pendientes, cierra el pool y sale con código 0 sin dejar filas huérfanas en system_task_runs (finished_at siempre poblado).

**Pruebas**

- `tests/worker/runtime.spec.ts` — runWorkerTick con claim y record inyectados: un manejador que lanza no impide que los otros dos corran, y su fallo queda como 'error' en el resumen
- `tests/worker/runtime.spec.ts` — El tick entra en withTenant una vez por tenant devuelto por la consulta de tenants y no llama a enterTenant
- `tests/worker/runtime.spec.ts` — startWorker con AbortSignal ya abortado no ejecuta ningún tick; abortado a mitad, espera al tick en curso antes de resolver
- `tests/worker/registry.spec.ts` — TASK_HANDLERS tiene exactamente una entrada por cada valor de SYSTEM_TASK_KINDS (inventario cerrado, mismo patrón que el test de nombres de tools)
- `tests/observability/metrics-registry.spec.ts` — Importar src/observability/worker-metrics.ts y src/api/rest/middleware/metrics.ts en el mismo proceso no lanza por doble registro

**Riesgo.** Dos riesgos concretos. (1) Olvidar withTenant deja al worker viendo cero filas y las tareas parecerán 'noop' para siempre en vez de fallar — mitigación: el test de aislamiento por tenant y un log explícito del tenant en cada tick. (2) Llamar a collectDefaultMetrics dos veces (una en metrics.ts, otra aquí) lanza en cualquier proceso que importe ambos; el try/catch y un test que importe los dos módulos lo cubren.

##### `E4.2-c` Retirar el trigger de refresco de vistas materializadas del camino del posteo · **M**

Hoy, migración 004_partitioning_and_views.sql:102-106, existe:
  CREATE TRIGGER trg_refresh_materialized_views AFTER INSERT OR UPDATE ON journal_entries FOR EACH ROW WHEN (NEW.status='posted') EXECUTE FUNCTION refresh_materialized_views();
y la función (reescrita en 024 como SECURITY DEFINER) ejecuta `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_trial_balance` y `... mv_account_balance_summary`. Eso ocurre DENTRO de la transacción de posteo, por cada fila: postJournalEntry (posting.ts:269) y el autoPost de createJournalEntry (posting.ts:171) lo disparan una vez cada uno, y runMonthlyDepreciation (depreciation.ts) lo dispara una vez por activo. mv_trial_balance es `accounts CROSS JOIN fiscal_periods` sin filtro de tenant (010_fix_mv_trial_balance.sql:33-42): el coste de cada refresco es proporcional al tamaño TOTAL de la instalación, no al del asiento.

Hecho verificado que decide el diseño: `grep -rn 'mv_trial_balance\|mv_account_balance_summary' src/ scripts/ tests/` fuera de src/database/migrations/ devuelve SOLO dos comentarios en posting.ts:434-435. Ninguna consulta del producto lee las vistas. Todo reporte se calcula desde journal_entry_lines.

Trabajo:
1. Migración 032_drop_mv_refresh_trigger.sql:
   DROP TRIGGER IF EXISTS trg_refresh_materialized_views ON journal_entries;
   DROP TRIGGER IF EXISTS trg_refresh_trial_balance ON journal_entries;   -- el de 001_core_schema.sql:533, por si sobrevivió
   DROP FUNCTION IF EXISTS refresh_materialized_views();
   DROP FUNCTION IF EXISTS refresh_trial_balance();
   El destino de las dos vistas lo fija la decisión D2; la migración incluye el DROP MATERIALIZED VIEW sólo si la decisión es retirarlas. Nada de `REFRESH ... CONCURRENTLY` dentro de la migración.
2. Si D2 = conservarlas: crear src/worker/tasks/refresh-views.ts con
     export async function refreshReportingViews(): Promise<Array<{ view: string; ms: number }>>
   que abre su PROPIO pg.Pool contra config.database.migrationUrl (max: 1) porque sólo el propietario puede refrescar — es literalmente el fallo que documenta 024_mv_refresh_security_definer.sql:3-7 — y emite cada `REFRESH MATERIALIZED VIEW CONCURRENTLY <vista>` como sentencia suelta sobre ese cliente. NO puede pasar por query() de connection.ts: con contexto de tenant activo, query() envuelve toda sentencia en BEGIN/COMMIT (connection.ts:159-165). El pool se cierra al terminar. Se registra en TASK_HANDLERS como 'reporting_views_refresh' con horario por defecto '*/15 * * * *', tenant_id del tenant que la ejecuta pero sin entity (es global; la primera tarea que gane el reclamo en el tick hace el trabajo de todos, y las demás devuelven 'noop' si otra la refrescó en los últimos 5 minutos).
3. Métrica accounting_mv_refresh_duration_seconds{view} y un comando manual `mnemosine worker tick --kinds reporting_views_refresh`, que cierra la brecha 'no hay forma manual de forzar el refresco'.
4. Documentar en src/ai/docs/accounting.md que las vistas materializadas son un artefacto de reporte diferido y que NINGUNA lectura contable debe basarse en ellas sin filtrar por entity_id, porque no están cubiertas por RLS (rls-policies.sql sólo recorre relkind 'r'/'p').

**Archivos**

- `src/database/migrations/032_drop_mv_refresh_trigger.sql` — crear: DROP de los dos triggers y las dos funciones de refresco; DROP de las vistas sólo si D2 lo decide
- `src/worker/tasks/refresh-views.ts` — crear (sólo si D2 = conservar): refreshReportingViews() sobre un pool propio con migrationUrl
- `src/worker/registry.ts` — modificar: registrar el manejador 'reporting_views_refresh'
- `src/services/accounting/posting.ts` — modificar: actualizar el comentario de voidJournalEntryInTx (líneas 433-436) que hoy describe las vistas como si se refrescaran solas
- `src/ai/docs/accounting.md` — modificar: nota sobre el refresco diferido y la ausencia de RLS en las vistas

**Migración**

```sql
src/database/migrations/032_drop_mv_refresh_trigger.sql — DROP TRIGGER IF EXISTS trg_refresh_materialized_views ON journal_entries; DROP TRIGGER IF EXISTS trg_refresh_trial_balance ON journal_entries; DROP FUNCTION IF EXISTS refresh_materialized_views(); DROP FUNCTION IF EXISTS refresh_trial_balance(); (más DROP MATERIALIZED VIEW mv_trial_balance, mv_account_balance_summary si D2 = retirar).
```

**Criterios de aceptación**

- Dado un asiento posteado, cuando termina postJournalEntry, entonces `SELECT tgname FROM pg_trigger WHERE tgrelid='journal_entries'::regclass AND NOT tgisinternal` no contiene ningún nombre que empiece por 'trg_refresh'.
- Dado un script que postea 100 asientos de 2 líneas en una base con 200 cuentas y 24 periodos, cuando se mide antes y después de la migración 032, entonces el tiempo total cae al menos un orden de magnitud y queda registrado en el PR.
- Dado que D2 = conservar las vistas, cuando corre `mnemosine worker tick --kinds reporting_views_refresh` con el rol de aplicación configurado, entonces las dos vistas quedan refrescadas y NO se produce el error 'must be owner of materialized view' (la tarea conecta como propietario).
- Dado que el refresco falla (por ejemplo, vista inexistente), cuando termina el tick, entonces la tarea queda 'error' en system_task_runs con el mensaje de Postgres en detail y el posteo de asientos sigue funcionando sin verse afectado.

**Pruebas**

- `tests/database/mv-trigger.spec.ts` — Análisis estático de src/database/migrations/: ninguna migración posterior a 032 vuelve a crear un trigger sobre journal_entries que ejecute un REFRESH (mismo patrón de test de fuente que tests/accounting/period-close-accounts.spec.ts)
- `tests/worker/refresh-views.spec.ts` — refreshReportingViews emite REFRESH ... CONCURRENTLY como sentencias sueltas y nunca dentro de un BEGIN, y usa config.database.migrationUrl (pool inyectado como seam)

**Riesgo.** Si algún consumidor externo al repositorio (un BI, una consulta ad hoc del despacho) lee mv_trial_balance, retirarla lo rompe sin aviso. Mitigación: la decisión D2 debe tomarla una persona, y si se conservan, la tarea de refresco entra en el mismo PR para que la frescura máxima quede acotada y documentada (15 minutos).

##### `E4.2-d` Barredor de entregas salientes pendientes (webhook_retry_sweep) · **M**

webhook-service.ts calcula next_retry_at con backoff exponencial (markFailed, líneas 141-151) y existe el índice parcial idx_webhook_deliveries_retry (003:316), pero nadie barre. Sólo se reintenta si un humano llama a retryDelivery (línea 154). Además, dispatchEvent (línea 74) inserta la entrega con next_retry_at NULL y luego lanza deliverWebhook fire-and-forget: si el proceso muere entre el INSERT y la respuesta HTTP, la fila queda 'pending' con attempt_count=0 y next_retry_at NULL, invisible para cualquier barredor futuro.

Cambios en src/services/webhooks/webhook-service.ts:
1. En dispatchEvent, el INSERT pasa a poblar next_retry_at:
   INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, next_retry_at) VALUES ($1,$2,$3,$4,'pending', NOW())
   Así el barredor es la red de seguridad de todo envío, incluido el que se perdió por caída del proceso.
2. Nueva función exportada:
   export async function sweepPendingDeliveries(opts?: { limit?: number }): Promise<{ claimed: number; succeeded: number; failed: number; exhausted: number }>
   Debe correr DENTRO de withTenant: webhook_deliveries no tiene tenant_id y su política es tenant_isolation_child vía webhook_subscriptions (rls-policies.sql, lista de tablas hijas, línea del par ('webhook_deliveries','webhook_id','webhook_subscriptions')).
   Reclamo en UN solo UPDATE, empujando next_retry_at hacia adelante para que un barredor concurrente no tome la misma fila:
     UPDATE webhook_deliveries d
        SET next_retry_at = NOW() + interval '5 minutes'
      WHERE d.id IN (
        SELECT d2.id FROM webhook_deliveries d2
        JOIN webhook_subscriptions s ON s.id = d2.webhook_id
        WHERE d2.status = 'pending' AND d2.next_retry_at IS NOT NULL AND d2.next_retry_at <= NOW()
          AND d2.attempt_count < $1 AND s.is_active = true
        ORDER BY d2.next_retry_at ASC
        LIMIT $2
        FOR UPDATE OF d2 SKIP LOCKED)
      RETURNING d.id, d.webhook_id, d.payload
   con $1 = config.webhooks.maxRetries y $2 = opts.limit ?? 50. La consulta corre dentro de withTransaction para que FOR UPDATE tenga ámbito.
3. Por cada fila reclamada, reutilizar la ruta de entrega ya existente: leer la suscripción y llamar a deliverWebhook (que ya actualiza a 'success' o delega en markFailed). No se duplica la lógica de firma ni de backoff.
4. Extraer el contador de resultados a la métrica accounting_webhook_delivery_total{outcome=success|retry|exhausted} en src/observability/worker-metrics.ts, cerrando la brecha 'no hay contadores de entregas de webhook'.

Manejador src/worker/tasks/webhook-retry.ts: `webhookRetrySweep(ctx)` llama a sweepPendingDeliveries y devuelve status 'noop' con processed 0 cuando no reclamó nada, 'ok' en otro caso. Horario por defecto '*/5 * * * *'.

**Archivos**

- `src/services/webhooks/webhook-service.ts` — modificar: dispatchEvent puebla next_retry_at = NOW() en el INSERT; nueva sweepPendingDeliveries; deliverWebhook pasa a exportarse para reutilizarla; retirar el comentario 'in production use BullMQ' (línea 80)
- `src/worker/tasks/webhook-retry.ts` — crear: manejador webhookRetrySweep
- `src/worker/registry.ts` — modificar: registrar 'webhook_retry_sweep'
- `src/observability/worker-metrics.ts` — modificar: contador accounting_webhook_delivery_total{outcome}

**Criterios de aceptación**

- Dada una entrega en 'pending' con next_retry_at en el pasado y attempt_count menor que maxRetries, cuando corre el barrido y el endpoint responde 200, entonces la fila queda status='success', delivered_at poblado y attempt_count incrementado.
- Dada la misma entrega y un endpoint que responde 500, cuando corre el barrido, entonces attempt_count sube en 1 y next_retry_at queda recalculado por markFailed con el backoff exponencial (no con los 5 minutos del reclamo).
- Dada una entrega con attempt_count = config.webhooks.maxRetries, cuando corre el barrido, entonces NO se reclama y su status permanece en 'failed'.
- Dada una entrega cuya suscripción está is_active=false, cuando corre el barrido, entonces no se reclama.
- Dado un dispatchEvent cuyo proceso muere justo después del INSERT, cuando corre el barrido siguiente, entonces la entrega se reclama y se intenta (hoy quedaría con next_retry_at NULL para siempre).
- Dados dos barredores concurrentes sobre la misma entrega debida, cuando ambos terminan, entonces attempt_count sube exactamente 1.

**Pruebas**

- `tests/webhooks/sweep.spec.ts` — Reclama sólo pending con next_retry_at vencido, attempt_count < maxRetries y suscripción activa; ignora las agotadas y las de suscripción inactiva
- `tests/webhooks/sweep.spec.ts` — Éxito marca 'success'; fallo delega en markFailed y el backoff resultante NO es el clamp de 5 minutos del reclamo
- `tests/webhooks/sweep.spec.ts` — dispatchEvent inserta con next_retry_at no nulo (el barredor puede rescatar entregas huérfanas)

**Riesgo.** El reclamo empuja next_retry_at 5 minutos; si el proceso muere entre el reclamo y la entrega, la fila se reintenta 5 minutos después — pérdida de puntualidad, nunca de la entrega. Riesgo real: SKIP LOCKED requiere que la subconsulta esté dentro de la transacción; si se saca a un query() suelto bajo contexto de tenant el bloqueo se libera al COMMIT inmediato y dos barredores pueden duplicar el envío. Cubierto por el test de concurrencia.

##### `E4.2-e` Persistir el cuerpo entrante y drenar las entregas en 'received' con el lector restringido · **L**

BLOQUEO VERIFICADO QUE HAY QUE RESOLVER PRIMERO: processDelivery (reader-agent.ts:213) exige `rawBody`, pero ai_webhook_deliveries (028_ai_webhooks.sql:68-87) NO guarda el cuerpo — sus columnas son id, token_id, tenant_id, entity_id, document_key, received_at, status, suspicion, drafts_created. Por tanto, hoy es IMPOSIBLE drenar una entrega ya registrada: el payload sólo existe en la memoria de la petición HTTP. Y el router se monta sin runReaderTurn (ai-webhooks.ts:143 exporta createAiWebhooksRouter() sin dependencias; src/index.ts:108 lo monta así), de modo que toda entrega queda en 'received' para siempre.

1. Migración 033_ai_webhook_delivery_body.sql:
   ALTER TABLE ai_webhook_deliveries ADD COLUMN raw_body TEXT;
   COMMENT ON COLUMN ai_webhook_deliveries.raw_body IS 'Cuerpo crudo del tercero, conservado SOLO mientras status = ''received''. Se pone a NULL al finalizar la entrega: es dato no confiable y no debe acumularse.';
   No se añade índice: la selección es por (status, received_at) — añadir CREATE INDEX idx_ai_webhook_deliveries_pending ON ai_webhook_deliveries (status, received_at) WHERE status = 'received'.
2. src/ai/webhooks/intake.ts:
   - recordDelivery acepta `rawBody: string` en su input y lo persiste en la columna nueva.
   - markDeliveryOutcome añade `raw_body = NULL` a su UPDATE guardado: en cuanto la entrega deja 'received', el cuerpo desaparece. Esto acota la retención sin necesidad de una tarea de purga.
   - Nueva función:
     export async function claimPendingDeliveries(tenantId: string, limit = 10): Promise<Array<{ token: WebhookTokenRow; delivery: WebhookDeliveryRow; rawBody: string }>>
     SELECT de d.status='received' y d.raw_body IS NOT NULL, JOIN a ai_webhook_tokens t (t.enabled = true), ORDER BY d.received_at ASC LIMIT $, dentro de withTransaction con FOR UPDATE OF d SKIP LOCKED. No cambia el status (processDelivery exige verlo en 'received', reader-agent.ts:217): la exclusión mutua la da SKIP LOCKED durante el turno.
3. src/worker/tasks/webhook-drain.ts:
     export const webhookReaderDrain: TaskHandler
   Requiere ctx.deps.makeRunReaderTurn; si no está inyectado devuelve status 'noop' con detail { reason: 'sin proveedor de modelo configurado' } — nunca falla abierto hacia un agente sin restringir. Por cada entrega reclamada: resuelve el AgentContext de la entidad (resolveEntity por delivery.entity_id), construye el turno lector y llama a processDelivery({ token, delivery, rawBody, runReaderTurn }). La sesión se resuelve por terminal_key = webhookSessionKey(document_key), de modo que un reintento reanuda la MISMA transcripción (reader-agent.ts:129-136).
4. La CLI inyecta makeRunReaderTurn en src/cli/worker-command.ts con el mismo patrón que makeRunAgentTurn (mnemosine.ts:241-252): sesión de un solo turno, grounding desactivado, drafts capturados, usage registrado sin sesión. La única diferencia es el toolset: buildReaderTools (reader-agent.ts:78), NUNCA buildTools.
5. src/index.ts NO se toca: el proceso HTTP sigue montando el router sin runReaderTurn. Un turno de modelo dentro de una petición HTTP es exactamente lo que este diseño evita.

Horario por defecto: '*/2 * * * *'.

**Archivos**

- `src/database/migrations/033_ai_webhook_delivery_body.sql` — crear: columna raw_body, su comentario y el índice parcial de pendientes
- `src/ai/webhooks/intake.ts` — modificar: recordDelivery persiste rawBody; markDeliveryOutcome pone raw_body a NULL; nueva claimPendingDeliveries
- `src/api/rest/routes/ai-webhooks.ts` — modificar: pasar rawBody a recordDelivery (línea 100)
- `src/worker/tasks/webhook-drain.ts` — crear: manejador webhookReaderDrain
- `src/worker/registry.ts` — modificar: registrar 'webhook_reader_drain'
- `src/cli/worker-command.ts` — modificar: inyectar makeRunReaderTurn sobre buildReaderTools

**Migración**

```sql
src/database/migrations/033_ai_webhook_delivery_body.sql — ALTER TABLE ai_webhook_deliveries ADD COLUMN raw_body TEXT; CREATE INDEX idx_ai_webhook_deliveries_pending ON ai_webhook_deliveries (status, received_at) WHERE status = 'received'; más el COMMENT.
```

**Criterios de aceptación**

- Dada una entrega nueva por POST /v1/ai/webhooks/:tokenName, cuando el proceso HTTP responde, entonces la fila queda status='received' con raw_body poblado.
- Dada esa entrega y un worker con makeRunReaderTurn inyectado, cuando corre el tick, entonces la entrega pasa a 'processed', drafts_created refleja los borradores creados y raw_body queda NULL.
- Dado un worker SIN proveedor de modelo configurado, cuando corre el tick, entonces la tarea termina 'noop' y ninguna entrega cambia de estado.
- Dada una entrega ya 'processed', cuando corre el drenaje, entonces no se reclama (raw_body es NULL) y el modelo no se invoca.
- Dados dos workers concurrentes, cuando ambos drenan, entonces cada entrega despierta al lector exactamente una vez (SKIP LOCKED).
- Dado un turno del lector que lanza, cuando termina el drenaje, entonces la entrega sigue en 'received' con su raw_body y el siguiente tick la reanuda sobre la misma sesión (mismo terminal_key).

**Pruebas**

- `tests/ai/webhooks/drain.spec.ts` — claimPendingDeliveries devuelve sólo 'received' con raw_body no nulo y token habilitado, y no altera el status
- `tests/ai/webhooks/drain.spec.ts` — El manejador sin makeRunReaderTurn devuelve 'noop' y no llama a processDelivery
- `tests/ai/webhooks/drain.spec.ts` — Tras un turno exitoso, markDeliveryOutcome se llama con 'processed' y el UPDATE incluye raw_body = NULL
- `tests/ai/webhooks/drain.spec.ts` — Entrega con más de N días en 'received' se marca 'rejected' sin invocar el modelo

**Riesgo.** Guardar el cuerpo de un tercero introduce dato no confiable en reposo. Mitigación en el propio diseño: sólo vive mientras la entrega está en 'received' y markDeliveryOutcome lo borra en el mismo UPDATE guardado; una entrega abandonada indefinidamente conservaría el cuerpo, así que la tarea debe además marcar 'rejected' (y por tanto vaciar raw_body) toda entrega con más de N días en 'received', con N=7 por defecto en params.

##### `E4.2-f` Corrida mensual de depreciación como tarea del worker · **M**

runMonthlyDepreciation(entityId, fiscalPeriodId, userId) existe y es correcta en su forma (depreciation.ts:270-379): crea la fila de depreciation_schedules y el asiento con createJournalEntry({ autoPost: true, client }) en la MISMA transacción, y dispara attestEntryAsync después del commit — respeta la convención del repo. Lo que no existe es quien la llame: ni ruta, ni comando, ni job. Y el checklist de cierre la exige (period-close.ts:79-95), así que hoy ese punto es insatisfacible.

src/worker/tasks/depreciation.ts:
  export const depreciationMonthly: TaskHandler
  1. entity_id de la tarea es OBLIGATORIO para este kind (la corrida es por entidad). Si task.entity_id es NULL, la tarea termina 'error' con un mensaje explícito, no en silencio.
  2. Resuelve el periodo objetivo: params.period_id si viene; en otro caso el periodo fiscal de la entidad que contiene `date_trunc('month', NOW() - interval '1 month')` y cuyo status NOT IN ('hard_close','locked'). Si no hay ninguno, 'noop' con detail { reason }.
  3. Ejecuta dentro de withTenant (ya lo está: el runtime lo garantiza) para que currentTenant() sea válido en la línea de atestación (depreciation.ts:369) — hoy, sin contexto, la atestación se salta en silencio.
  4. userId: la corrida es desatendida; usar el usuario de sistema de la entidad. Si el repositorio no tiene aún un usuario de sistema, pasar params.user_id y fallar ruidosamente si falta.
  5. Devuelve { status: processed > 0 ? 'ok' : 'noop', processed, detail: { errors } }. Si errors.length > 0 el resultado es 'error' aunque processed > 0: una corrida parcial no debe resetear el contador de fallos.
  Horario por defecto: '0 3 2 * *' (día 2 de cada mes a las 03:00, ya cerrado el mes anterior).

Defecto verificado que se corrige en la misma pasada: el índice del renglón se calcula con `monthsDiff = floor((periodStart - depreciation_start_date) / (30.44 días))` (depreciation.ts:~306). Con calendarios reales eso puede saltarse o repetir un renglón. Sustituir por aritmética de meses de calendario:
  monthsDiff = (periodStart.getUTCFullYear() - start.getUTCFullYear()) * 12 + (periodStart.getUTCMonth() - start.getUTCMonth())
y mantener la guarda `if (!entry) continue`.

Límite conocido y explícito: no existe alta de fixed_assets ni de asset_categories por ninguna vía del producto, así que en una instalación real la tarea será 'noop' hasta que ese alta exista. Se registra en el detalle del run ('0 activos activos') para que el operador entienda por qué el checklist sigue sin satisfacerse. El alta de activos NO entra en este paquete (ver decisión D7 del atlas sobre el destino de inventarios y activos fijos).

**Archivos**

- `src/worker/tasks/depreciation.ts` — crear: manejador depreciationMonthly con resolución de periodo y propagación de errores
- `src/services/assets/depreciation.ts` — modificar: sustituir el cálculo de monthsDiff por aritmética de meses de calendario
- `src/worker/registry.ts` — modificar: registrar 'depreciation_monthly'

**Criterios de aceptación**

- Dada una entidad sin fixed_assets activos, cuando corre la tarea, entonces termina 'noop' con processed=0 y detail explicando que no hay activos, sin tocar el mayor.
- Dado un activo activo con depreciation_start_date en enero y un periodo objetivo de marzo, cuando corre la tarea, entonces se toma el renglón 3 del calendario (índice 2) y no el que resultaba del divisor de 30.44 días.
- Dado un activo ya depreciado en ese periodo (fila en depreciation_schedules), cuando la tarea vuelve a correr, entonces no crea un segundo asiento (idempotencia por la comprobación existente).
- Dada una corrida exitosa, cuando termina, entonces existe un journal_entry de tipo auto_depreciation posteado, la fila de depreciation_schedules, el fixed_assets actualizado — los tres en la misma transacción — y se disparó attestEntryAsync con el tenant correcto.
- Dada una corrida con 5 activos donde 1 falla, cuando termina, entonces system_task_runs registra status 'error' con los mensajes en detail y processed=4, y el contador de fallos consecutivos NO se resetea.
- Dado ese estado, cuando se consulta getPeriodCloseStatus del periodo, entonces el punto 'Depreciation calculated and posted' pasa a is_complete=true para los activos procesados.

**Pruebas**

- `tests/worker/depreciation-task.spec.ts` — Sin activos activos devuelve 'noop'; con un error por activo devuelve 'error' con processed correcto
- `tests/worker/depreciation-task.spec.ts` — Resolución del periodo objetivo: usa params.period_id cuando viene; si no, el del mes anterior; 'noop' si ese periodo está en hard_close
- `tests/assets/depreciation-months.spec.ts` — monthsDiff por meses de calendario: enero→marzo da 2 en años bisiestos y no bisiestos (el divisor de 30.44 días fallaba en al menos un caso)

**Riesgo.** Es la única tarea de este paquete que ESCRIBE en el mayor. Debe pasar sí o sí por createJournalEntry con options.client y disparar attestEntryAsync tras el commit (ya lo hace); cualquier atajo rompería la convención del repositorio. Riesgo secundario: si la tarea se siembra con un periodo ya en hard_close, createJournalEntry lanzará PERIOD_CLOSED — el manejador debe traducirlo a un 'error' legible y no a un stack trace.

##### `E4.2-g` Revalidación periódica del estatus del CFDI ante el SAT · **M**

Hoy SATValidationService.validateAndUpdate (sat-validation.ts:99) sólo se invoca una vez, fire-and-forget, durante la ingesta (pre-registration-service.ts:135). Un CFDI que el emisor cancela DESPUÉS de contabilizado nunca se detecta. Las columnas ya existen (005_xml_ingestion.sql:69-76: sat_validation_status, sat_validated_at, sat_estado, sat_efecto_cancelacion, sat_fecha_cancelacion).

src/worker/tasks/cfdi-revalidation.ts:
  export const cfdiRevalidation: TaskHandler
  1. Selecciona candidatos:
     SELECT id, cfdi_uuid, emisor_rfc, receptor_rfc, total, sat_validation_status
       FROM xml_documents
      WHERE entity_id = $1 AND cfdi_uuid IS NOT NULL
        AND COALESCE(sat_validation_status, 'pending') <> 'cancelled'
        AND (sat_validated_at IS NULL OR sat_validated_at < NOW() - ($2 || ' days')::interval)
      ORDER BY sat_validated_at NULLS FIRST
      LIMIT $3
     con $2 = params.revalidate_after_days ?? 7 y $3 = params.batch ?? 50. Un documento ya 'cancelled' no se revalida: la cancelación es terminal.
  2. Llama a validateBatch (sat-validation.ts:69), que ya trocea de 10 en 10 con 1 segundo entre lotes.
  3. GUARDA IMPRESCINDIBLE: mientras no exista el cliente SOAP real, validate() devuelve status 'error' con estado 'SAT validation not configured' fuera de PAC_ENVIRONMENT=sandbox (sat-validation.ts:50-56). El manejador NO debe escribir esa respuesta como si fuera una validación: si TODOS los resultados son ese error, la tarea termina 'noop' con detail { reason: 'consulta SAT no configurada' } y no toca ninguna fila. Así el ledger no se llena de sat_validation_status='error' y la brecha queda visible en vez de disfrazada.
  4. Cuando un documento pasa de 'valid' a 'cancelled', la tarea NO revierte nada por su cuenta. Crea una pregunta con createQuestion (question-service.ts:39) — topic 'cfdi_cancelado', model 'system', context con el UUID, el emisor, el importe y el número del asiento que lo contabilizó — para que un humano decida la reversa. Corregir por reversa es política del sistema (NIF B-1) y la decisión de reversar una factura ya contabilizada no puede ser automática (ver D7).
  5. Devuelve processed = documentos cuyo estatus efectivamente cambió.
  Horario por defecto: '0 5 * * *'.

**Archivos**

- `src/worker/tasks/cfdi-revalidation.ts` — crear: manejador cfdiRevalidation con la guarda de 'no configurado' y la creación de pregunta ante cancelación
- `src/services/xml-ingestion/sat-validation.ts` — modificar: distinguir explícitamente 'no configurado' de 'error de consulta' en el resultado (campo `configured: boolean` en SATValidationResult) para que el manejador no tenga que comparar cadenas
- `src/worker/registry.ts` — modificar: registrar 'cfdi_revalidation'

**Criterios de aceptación**

- Dado un entorno sin consulta SAT configurada, cuando corre la tarea sobre 50 CFDI, entonces ninguna fila de xml_documents se modifica y la tarea termina 'noop' con el motivo en detail.
- Dado PAC_ENVIRONMENT=sandbox y un CFDI sin validar, cuando corre la tarea, entonces sat_validation_status queda 'valid' y sat_validated_at poblado.
- Dado un CFDI que el servicio reporta como cancelado y que ya tiene asiento contabilizado, cuando corre la tarea, entonces sat_validation_status='cancelled', se crea UNA pregunta pendiente con topic 'cfdi_cancelado' y NO se crea ningún asiento ni reversa.
- Dado un CFDI ya marcado 'cancelled', cuando la tarea vuelve a correr, entonces no se vuelve a consultar ni se crea una segunda pregunta.
- Dado un CFDI validado hace 2 días con revalidate_after_days=7, cuando corre la tarea, entonces no se selecciona.

**Pruebas**

- `tests/worker/cfdi-revalidation.spec.ts` — Con el servicio no configurado no se ejecuta ningún UPDATE y el resultado es 'noop'
- `tests/worker/cfdi-revalidation.spec.ts` — Transición valid→cancelled crea exactamente una pregunta y no escribe en journal_entries
- `tests/worker/cfdi-revalidation.spec.ts` — La selección respeta revalidate_after_days y excluye los ya cancelados

**Riesgo.** La consulta al SAT es un servicio externo con límites de tasa; validateBatch ya trocea, pero el tamaño de lote debe quedar en params y no fijo en el código. Riesgo de producto: si la guarda de 'no configurado' se omite, la tarea marcará miles de documentos como 'error' y borrará la señal útil.

##### `E4.2-h` Presupuesto y alerta sobre ai_usage · **S**

El ledger ai_usage (021_ai_usage.sql) registra tokens y costo estimado por turno, y summarizeUsage (usage-ledger.ts:158) ya agrega por modelo, proveedor, día o sesión. Falta el umbral.

1. src/config/index.ts: nuevo bloque
     ai: { budget: { monthlyUsd: Number(process.env.MNEMOSINE_AI_BUDGET_USD || 0), warnAtPct: Number(process.env.MNEMOSINE_AI_BUDGET_WARN_PCT || 0.8) } }
   monthlyUsd = 0 significa sin presupuesto (comportamiento actual).
2. src/ai/usage-ledger.ts añade:
     export interface BudgetStatus { monthUsd: number; budgetUsd: number; pct: number; level: 'ok' | 'warn' | 'over'; unpricedTurns: number; }
     export async function checkBudget(ctx: AgentContext, budgetUsd: number, warnAtPct: number): Promise<BudgetStatus>
   Calcula el gasto del mes en curso con summarizeUsage(ctx, { since: primer día del mes UTC, groupBy: 'day' }) y devuelve totals.costUsd. unpricedTurns se propaga: un presupuesto calculado sobre turnos sin precio es una subestimación y hay que decirlo.
3. src/worker/tasks/ai-budget.ts: manejador aiBudgetAlert. budgetUsd = params.monthly_usd ?? config.ai.budget.monthlyUsd; si es 0, 'noop'. En 'warn' y en 'over' crea una pregunta con createQuestion (topic 'presupuesto_ia', model 'system') con el gasto del mes, el presupuesto y el desglose por modelo. Idempotencia: antes de crear, comprueba que no exista ya una pregunta pendiente con el mismo topic y el mismo nivel dentro del mes en curso — una alerta por nivel y por mes, no una por tick. Métrica accounting_ai_budget_usd{entity} como Gauge.
   Horario por defecto: '0 * * * *'.
4. NO se corta nada en este paquete: el corte requiere una compuerta en la creación de la sesión (createLlmSessionWithFailover) y es una decisión de producto separada (D5).

**Archivos**

- `src/config/index.ts` — modificar: bloque ai.budget con MNEMOSINE_AI_BUDGET_USD y MNEMOSINE_AI_BUDGET_WARN_PCT
- `src/ai/usage-ledger.ts` — modificar: BudgetStatus y checkBudget sobre summarizeUsage
- `src/worker/tasks/ai-budget.ts` — crear: manejador aiBudgetAlert con idempotencia por nivel y mes
- `src/worker/registry.ts` — modificar: registrar 'ai_budget_alert'
- `src/observability/worker-metrics.ts` — modificar: Gauge accounting_ai_budget_usd

**Criterios de aceptación**

- Dado MNEMOSINE_AI_BUDGET_USD sin definir, cuando corre la tarea, entonces termina 'noop' y no crea preguntas.
- Dado un presupuesto de 100 USD y un gasto del mes de 85 USD con warnAtPct 0.8, cuando corre la tarea, entonces level='warn' y se crea UNA pregunta pendiente con topic 'presupuesto_ia'.
- Dado ese mismo estado, cuando la tarea vuelve a correr en el mismo mes sin cambiar de nivel, entonces NO se crea una segunda pregunta.
- Dado que el gasto sube a 105 USD, cuando corre la tarea, entonces level='over' y se crea una segunda pregunta (nivel distinto).
- Dado un mes con turnos sin precio en la tabla local, cuando se consulta checkBudget, entonces unpricedTurns es mayor que cero y el texto de la alerta advierte que el gasto real es mayor que el estimado.

**Pruebas**

- `tests/ai/budget.spec.ts` — checkBudget clasifica ok/warn/over en los tres lados de los umbrales y propaga unpricedTurns
- `tests/worker/ai-budget-task.spec.ts` — Idempotencia: dos ticks consecutivos en el mismo nivel crean una sola pregunta; un cambio de nivel crea otra

**Riesgo.** El costo es una estimación local (prices.ts, con fecha de corte manual) y nunca la factura del proveedor. El texto de la alerta debe decirlo, o el usuario tomará una decisión de gasto sobre un número que no es el que le cobrarán.

##### `E4.2-i` Semántica de account_balances: documentarla, hacerla comprobable y dejar de mentir en la columna · **M**

AUDITORÍA HECHA SOBRE EL CÓDIGO, con estos resultados:
 · Escritores de account_balances: exactamente tres. posting.ts:178 (autoPost), posting.ts:279 (postJournalEntry) y period-close.ts:265 (carryForwardBalances). Los dos primeros sólo tocan debit_total/credit_total/ending_balance; el tercero es el ÚNICO que escribe beginning_balance.
 · Lectores de beginning_balance en src/: NINGUNO. La única lectura del repositorio está en scripts/e2e-arap.ts:192-199, que verifica nb.beginning_balance = ab.ending_balance. Es decir: el arrastre se escribe y nadie lo consume.
 · Lectores de account_balances en src/: dos. accounts.ts:141-148, que deliberadamente NO usa ending_balance y suma actividad (`SUM(debit_total - credit_total)`) con un comentario correcto explicando por qué sumar ending_balance duplicaría el arrastre; y period-close.ts:98-103, cuyo control de balanza usa `SUM(debit_total) - SUM(credit_total)` — actividad, también.
 · Signo: ending_balance es DEBE-POSITIVO (ending = Σdébitos − Σcréditos), independiente de accounts.normal_balance. Para pasivos, capital e ingresos es NEGATIVO por diseño. Cada superficie de reporte hace la conversión por su cuenta (naturalSign en reports.ts:100 y en report-tools.ts:115). No hay incoherencia de signo; hay ausencia de un único lugar que lo declare.
 · MALINTERPRETACIÓN REAL ENCONTRADA: GET /v1/reports/trial-balance?fiscal_period_id=X (reports.ts:26-28) devuelve una columna llamada `ending_balance` que en realidad es la ACTIVIDAD DEL PERIODO — ignora account_balances.beginning_balance. Para una cuenta de balance en un periodo posterior a un arrastre, el saldo verdadero es beginning_balance + actividad. El mismo defecto tiene mv_trial_balance.net_balance (010:31-32) y el resolver GraphQL trialBalance (resolvers/index.ts:102), que además acepta fiscalPeriodId, asOfDate y accountLevel (schema.ts:482) y los IGNORA los tres.

Trabajo:
1. Crear src/services/accounting/balances.ts con la declaración canónica en el encabezado (en español, estilo de los demás encabezados del repo): convenio de signo debe-positivo; beginning_balance sólo lo escribe el arrastre y sólo para cuentas de balance; invariante ending = beginning + debit_total − credit_total; y la advertencia de que la actividad del periodo NO es el saldo del periodo. Exporta:
     export function normalSign(accountType: string): 1 | -1   // única fuente de verdad; hoy duplicada como naturalSign en dos archivos
     export interface BalanceInvariantOffender { account_id: string; account_code: string; expected: string; actual: string; }
     export async function checkBalanceInvariant(entityId: string, fiscalPeriodId: string): Promise<BalanceInvariantOffender[]>
   La consulta:
     SELECT ab.account_id, a.code AS account_code,
            (ab.beginning_balance + ab.debit_total - ab.credit_total) AS expected, ab.ending_balance AS actual
       FROM account_balances ab JOIN accounts a ON a.id = ab.account_id
      WHERE ab.entity_id = $1 AND ab.fiscal_period_id = $2
        AND ABS(ab.ending_balance - (ab.beginning_balance + ab.debit_total - ab.credit_total)) > 0.005
2. Añadir el punto 6 al checklist de getPeriodCloseStatus (period-close.ts, tras el bloque de la línea 97): 'Saldos denormalizados coherentes con sus componentes'. Si checkBalanceInvariant devuelve filas, va a blocking_issues (no a warnings): un ending_balance que no cuadra con sus propios componentes significa que alguien escribió la tabla fuera de posting.ts, y cerrar sobre eso es cerrar sobre datos corruptos.
3. Reemplazar naturalSign en reports.ts:100 y report-tools.ts:115 por normalSign importado — queda un solo sitio donde vive el convenio (y desaparece cuando esos archivos se vacíen en E4.2-k, pero la capa compartida lo importará).
4. Documentar en src/ai/docs/accounting.md (la línea 8 ya menciona account_balances) las tres frases que el agente necesita: ending_balance es debe-positivo; un saldo filtrado por periodo requiere sumar beginning_balance; y las vistas materializadas no son fuente de verdad.
5. La corrección del nombre de la columna se implementa en E4.2-j: la capa compartida devuelve opening_balance / period_debits / period_credits / closing_balance, con closing = opening + debits − credits.

**Archivos**

- `src/services/accounting/balances.ts` — crear: encabezado con la semántica canónica, normalSign y checkBalanceInvariant
- `src/services/accounting/period-close.ts` — modificar: añadir el punto 6 del checklist con checkBalanceInvariant, alimentando blocking_issues
- `src/services/accounting/index.ts` — modificar: exportar balances.ts y carryForwardBalances (hoy no exportada, sólo alcanzable desde period-close y el E2E)
- `src/api/rest/routes/reports.ts` — modificar: buildSection usa normalSign importado en lugar del naturalSign local
- `src/ai/tools/report-tools.ts` — modificar: la función section usa normalSign importado
- `src/ai/docs/accounting.md` — modificar: párrafo sobre el convenio de signo y el arrastre

**Criterios de aceptación**

- Dado un periodo cuyas filas de account_balances cumplen ending = beginning + débitos − créditos, cuando corre checkBalanceInvariant, entonces devuelve [].
- Dada una fila alterada a mano (por ejemplo, la reparación que hace scripts/e2e-arap.ts:226), cuando corre checkBalanceInvariant, entonces devuelve esa cuenta con expected y actual, y getPeriodCloseStatus devuelve can_close=false con el motivo.
- Dado un pasivo con saldo acreedor, cuando se consulta account_balances, entonces ending_balance es negativo, y normalSign('liability') devuelve -1 de modo que el reporte lo muestre positivo.
- Dado `grep -rn 'naturalSign' src/`, cuando se ejecuta tras la tarea, entonces no hay ninguna definición local: sólo importaciones de normalSign.
- Dada la documentación del agente, cuando se lee accounting.md, entonces afirma explícitamente que ending_balance es debe-positivo y que el saldo por periodo exige sumar beginning_balance.

**Pruebas**

- `tests/accounting/balances.spec.ts` — normalSign cubre los seis tipos de cuenta más los contra (asset/contra_asset → 1 y -1 según corresponda) y lanza ante un tipo desconocido en vez de asumir 1
- `tests/accounting/balances.spec.ts` — checkBalanceInvariant detecta una fila desincronizada y respeta la tolerancia de 0.005
- `tests/accounting/period-close-checklist.spec.ts` — Un offender de saldos hace can_close=false y aparece en blocking_issues, no en warnings

**Riesgo.** Convertir la incoherencia en bloqueo del cierre puede impedir cerrar periodos en bases de desarrollo que fueron 'reparadas' a mano por los scripts E2E (e2e-arap.ts:226, e2e-reversal.ts:91 hacen exactamente ese UPDATE). Es el comportamiento deseado, pero hay que avisarlo en el mensaje de error y ofrecer el recálculo desde journal_entry_lines como remedio documentado.

##### `E4.2-j` Capa de consulta compartida de reportes (src/services/reporting/queries.ts) · **L**

El directorio src/services/reporting/ existe y está VACÍO — es el hueco previsto. Hoy el mismo SQL vive en CUATRO sitios, y ya divergen:
 · src/ai/tools/report-tools.ts (6 tools): balanza sin account_level ni fiscal_period_id, con only_with_balance, formatea a 2 decimales, antigüedad ordenada por days_overdue DESC, mayor por account_code con LIMIT 101.
 · src/api/rest/routes/reports.ts (7 rutas): balanza con account_level y fiscal_period_id, 4 decimales, balance general con subsecciones por fs_category, estado de resultados con HAVING sobre el NETO (descarta una cuenta con débitos y créditos iguales, cosa que la versión del agente conserva), antigüedad ordenada por company_name, mayor por account_id con paginación, y cash-flow que no existe en la otra copia.
 · src/api/graphql/resolvers/index.ts:102 (trialBalance): TERCERA copia, con el defecto de los dos LEFT JOIN encadenados que las migraciones 010 y 012 corrigieron en todas partes — incluye líneas de asientos en draft/void — e isBalanced hardcodeado a true, e ignora los tres argumentos que declara schema.ts:482.
 · src/ai/external-service.ts:34 (fetchLocalBalances): CUARTA copia de la balanza, usada por el diff contra contabilidad externa.

Crear src/services/reporting/queries.ts como único lugar con SQL de reporte. Reglas del módulo: no importa express, ni zod, ni el SDK del modelo; no formatea para presentación; no resuelve permisos ni acceso a entidad (eso sigue en los llamadores); recibe siempre entityId explícito y JAMÁS lo lee de una query string. Importa normalSign de src/services/accounting/balances.ts.

Firmas:
  export interface TrialBalanceParams { entityId: string; asOfDate?: string; fiscalPeriodId?: string; maxAccountLevel?: number; includeInactive?: boolean; onlyWithBalance?: boolean; }
  export interface TrialBalanceAccount { account_id: string; account_code: string; account_name: string; account_type: string; opening_balance: string; period_debits: string; period_credits: string; closing_balance: string; }
  export interface TrialBalanceResult { accounts: TrialBalanceAccount[]; totals: { total_debits: string; total_credits: string; is_balanced: boolean } }
  export async function getTrialBalance(p: TrialBalanceParams): Promise<TrialBalanceResult>
  export async function getBalanceSheet(p: { entityId: string; asOfDate: string }): Promise<BalanceSheetResult>
  export async function getIncomeStatement(p: { entityId: string; startDate: string; endDate: string }): Promise<IncomeStatementResult>
  export async function getAgedReceivables(p: { entityId: string; asOfDate?: string }): Promise<AgingResult>
  export async function getAgedPayables(p: { entityId: string; asOfDate?: string }): Promise<AgingResult>
  export async function getGeneralLedger(p: { entityId: string; accountId?: string; accountCode?: string; startDate?: string; endDate?: string; limit: number; offset: number }): Promise<{ rows: LedgerRow[]; total: number }>
  export async function getCashFlow(p: { entityId: string; startDate: string; endDate: string }): Promise<CashFlowResult>
  export async function getAccountBalances(entityId: string, asOfDate: string): Promise<Map<string, { name: string; balance: Decimal }>>   // sustituye fetchLocalBalances
  export const REPORT_NAMES = ['trial_balance','balance_sheet','income_statement','aged_receivables','aged_payables','general_ledger','cash_flow'] as const;

SQL de la balanza (unifica las dos variantes y corrige el nombre mentiroso de la columna, ver E4.2-i):
  · Modo periodo (fiscalPeriodId dado):
    SELECT a.id, a.code, a.name, a.account_type,
           COALESCE(ab.beginning_balance, 0) AS opening_balance,
           COALESCE(SUM(COALESCE(jel.debit_amount,0)),0)  AS period_debits,
           COALESCE(SUM(COALESCE(jel.credit_amount,0)),0) AS period_credits
      FROM accounts a
      LEFT JOIN account_balances ab ON ab.account_id = a.id AND ab.fiscal_period_id = $2
      LEFT JOIN (journal_entry_lines jel
                 JOIN journal_entries je ON je.id = jel.journal_entry_id
                                        AND je.status = 'posted'
                                        AND je.fiscal_period_id = $2)
             ON jel.account_id = a.id
     WHERE a.entity_id = $1 AND (a.is_active = true OR $3::boolean)
     GROUP BY a.id, a.code, a.name, a.account_type, ab.beginning_balance
     ORDER BY a.code
    closing_balance = opening_balance + period_debits − period_credits, calculado en TypeScript con Decimal.
  · Modo as-of-date (o sin filtro): idéntico al de hoy — el paréntesis del join pre-filtrado, opening_balance = '0.0000' y closing_balance = neto histórico. El paréntesis NO es cosmético: encadenar dos LEFT JOIN es exactamente el defecto que corrigieron 010 y 012 y que el resolver GraphQL todavía tiene.
  · maxAccountLevel añade `AND a.account_level <= $n` sólo cuando viene (hoy la ruta REST lo aplica SIEMPRE con default '5'; el parámetro pasa a ser opcional y su ausencia no filtra — cambio de comportamiento a validar en D6).
  · includeInactive por defecto false: se preserva el `a.is_active = true` que todas las copias tienen hoy y que oculta cuentas desactivadas con saldo histórico. Se expone la bandera para poder verlas.

El resto de reportes se traslada literalmente desde reports.ts (que es la versión más completa) añadiendo lo que sólo tiene la versión del agente: total_due en las antigüedades, only_with_balance en la balanza, búsqueda por account_code en el mayor. Cubetas de antigüedad: getAgedReceivables/getAgedPayables devuelven, además del detalle crudo que hoy devuelven ambas copias, `buckets: { d0_30, d31_60, d61_90, d90_plus, total }` calculadas en TypeScript sobre days_overdue con Decimal — cierra la brecha señalada por la auditoría sin cambiar la forma de los datos existentes.

cash-flow: se traslada tal cual, PERO el ILIKE '%receivable%' / '%payable%' (reports.ts:285,297) se sustituye por resolución vía account_roles (rol 'accounts_receivable' / 'accounts_payable'), que es lo que E1 siembra. Si account_roles no tiene la fila, la sección correspondiente se devuelve como null con un campo `unavailable_reason`, en vez de devolver cero en silencio como hoy.

**Archivos**

- `src/services/reporting/queries.ts` — crear: única capa con SQL de reporte, con las nueve funciones exportadas y REPORT_NAMES
- `src/services/reporting/types.ts` — crear: interfaces de resultado (TrialBalanceResult, BalanceSheetResult, IncomeStatementResult, AgingResult, LedgerRow, CashFlowResult)

**Criterios de aceptación**

- Dada una entidad con un asiento en draft y otro posteado sobre la misma cuenta, cuando se llama a getTrialBalance sin filtro, entonces sólo el posteado aparece en los totales.
- Dado un periodo con arrastre (beginning_balance distinto de cero) y actividad, cuando se llama a getTrialBalance con fiscalPeriodId, entonces closing_balance = opening_balance + period_debits − period_credits y opening_balance coincide con account_balances.beginning_balance.
- Dada la misma entidad y el modo as-of-date, cuando se llama a getTrialBalance con asOfDate, entonces opening_balance es 0 y closing_balance es el neto histórico hasta esa fecha (idéntico al valor que devuelve hoy la ruta REST).
- Dadas facturas con 10, 45, 75 y 200 días de vencimiento, cuando se llama a getAgedReceivables, entonces buckets.d0_30, d31_60, d61_90 y d90_plus contienen una factura cada uno y su suma es igual a total.
- Dado un catálogo en español sin filas en account_roles, cuando se llama a getCashFlow, entonces las secciones de AR y AP vienen con unavailable_reason y no con 0.0000 fingido.
- Dadas dos llamadas a getTrialBalance con includeInactive true y false sobre una entidad con una cuenta desactivada con saldo, entonces la primera la incluye y la segunda no.

**Pruebas**

- `tests/reporting/queries.spec.ts` — getTrialBalance en modo periodo: el paréntesis del join impide que líneas de asientos draft/void entren en los totales, y closing = opening + débitos − créditos
- `tests/reporting/queries.spec.ts` — getIncomeStatement: ingresos en signo natural positivo, gastos positivos, net_income = ingresos − gastos, con normalSign importado
- `tests/reporting/queries.spec.ts` — getBalanceSheet: una cuenta contra_asset resta de la sección de activos en vez de inflarla
- `tests/reporting/queries.spec.ts` — getAgedReceivables/getAgedPayables: cubetas por days_overdue y total_due igual a la suma de amount_due
- `tests/reporting/queries.spec.ts` — getCashFlow devuelve unavailable_reason cuando faltan los roles de cuenta, y usa los roles cuando existen
- `tests/reporting/queries.spec.ts` — getGeneralLedger: filtro por account_code y por account_id producen el mismo conjunto para la misma cuenta; paginación total/offset correcta

**Riesgo.** Es una reescritura de SQL que sostiene los estados financieros. Debe hacerse con las salidas actuales congeladas como golden files: capturar la respuesta JSON de las 7 rutas REST y de las 6 tools contra la base de demo ANTES del cambio, y compararlas después. Toda diferencia debe ser una de las decididas en D5/D6, nunca una sorpresa.

##### `E4.2-k` Recablear las cuatro superficies a la capa compartida · **M**

Vaciar de SQL las cuatro copias y dejarlas como adaptadores de presentación. Ninguna de ellas debe conservar una sola cadena SQL sobre journal_entry_lines, accounts, invoices o bills.

1. src/ai/tools/report-tools.ts: se conservan intactos los nombres de tool, las descripciones, los inputSchema de zod y las llamadas a observe?.() — son contrato con el modelo y romperlos cambia el comportamiento del agente. El cuerpo de cada `run` pasa a: llamar a la función compartida y serializar con JSON.stringify, aplicando el formateo actual (.toFixed(2)) en el borde de presentación. get_trial_balance mapea only_with_balance a TrialBalanceParams.onlyWithBalance; get_general_ledger mapea account_code y mantiene su LIMIT 101 con la bandera truncated.
2. src/api/rest/routes/reports.ts: cada uno de los 7 handlers queda como parseo de query + llamada compartida + el sobre { data, meta } actual, con el formateo a 4 decimales tal cual está hoy. IMPORTANTE: se conserva el patrón `entity_id as string || req.entityId` de hoy porque cerrarlo es trabajo de E2 (bypass de entity_id por query string); esta tarea NO lo toca para no mezclar dos cambios, pero deja un comentario apuntando al paquete que lo cierra.
3. src/api/graphql/resolvers/index.ts:102: trialBalance pasa a `getTrialBalance({ entityId: args.entityId as string, asOfDate: args.asOfDate as string|undefined, fiscalPeriodId: args.fiscalPeriodId as string|undefined, maxAccountLevel: args.accountLevel as number|undefined })`. Esto corrige de un golpe tres defectos verificados: la fuga de asientos draft/void por los dos LEFT JOIN encadenados, el isBalanced hardcodeado a true, y los tres argumentos declarados en schema.ts:482 que el resolver ignoraba.
4. src/ai/external-service.ts: se elimina fetchLocalBalances (líneas 34-52) y diffTrialBalance llama a getAccountBalances(ctx.entityId, endDate). Su comportamiento observable no cambia: la consulta que se borra es idéntica a la del modo as-of-date de la capa compartida.
5. src/services/cache/redis.ts: invalidateReportCache (línea 110) lista patrones de caché de reportes que hoy nadie escribe (getCachedReport no tiene llamadores). O se cablea la caché en la capa compartida o se retira; en este paquete se deja como está y se anota, para no ampliar el alcance.

**Archivos**

- `src/ai/tools/report-tools.ts` — modificar: los 6 run pasan a delegar en src/services/reporting/queries.ts; se elimina todo SQL del archivo
- `src/api/rest/routes/reports.ts` — modificar: los 7 handlers pasan a delegar; se elimina todo SQL del archivo
- `src/api/graphql/resolvers/index.ts` — modificar: el resolver trialBalance delega y deja de ignorar fiscalPeriodId, asOfDate y accountLevel; isBalanced deja de estar hardcodeado
- `src/ai/external-service.ts` — modificar: eliminar fetchLocalBalances y usar getAccountBalances

**Criterios de aceptación**

- Dado `grep -rn "FROM journal_entry_lines\|FROM accounts a" src/ai/tools/report-tools.ts src/api/rest/routes/reports.ts src/api/graphql/resolvers/index.ts src/ai/external-service.ts`, cuando se ejecuta, entonces devuelve cero líneas.
- Dada una entidad con un asiento en draft, cuando se ejecuta la query GraphQL trialBalance, entonces ese asiento NO aparece en los totales (hoy sí aparece).
- Dada esa misma query con totales que no cuadran, cuando se lee la respuesta, entonces totals.isBalanced es false (hoy siempre true).
- Dada la query GraphQL trialBalance con fiscalPeriodId, cuando se ejecuta, entonces el resultado se limita a ese periodo (hoy el argumento se ignora).
- Dadas las salidas JSON congeladas de las 7 rutas REST y las 6 tools antes del cambio, cuando se comparan con las de después, entonces las únicas diferencias son las aprobadas en D5 y D6 y están enumeradas en el PR.
- Dado external_diff_trial_balance, cuando se ejecuta contra el adaptador de pruebas, entonces produce exactamente el mismo diff que antes del recableado (external-service.spec.ts pasa sin cambios).

**Pruebas**

- `tests/ai/tools/tools.spec.ts` — Actualizar los mocks: se mockea src/services/reporting/queries.ts (no `query`) y se afirma que cada tool llama a su función compartida con los parámetros mapeados
- `tests/api/graphql/trial-balance.spec.ts` — El resolver pasa fiscalPeriodId/asOfDate/accountLevel a getTrialBalance y devuelve isBalanced calculado
- `tests/ai/external/external-service.spec.ts` — diffTrialBalance sigue produciendo el mismo diff usando getAccountBalances

**Riesgo.** Los tests actuales de tools (tests/ai/tools/tools.spec.ts:177-192) mockean `query` y afirman sobre filas con las columnas de hoy (debit_total, credit_total, ending_balance). Al cambiar la forma que devuelve la capa compartida esos mocks dejan de representar la realidad; deben reescribirse para mockear la capa de reporting, no `query`, o el test seguirá verde mientras la producción falla — que es el patrón de falso verde que la auditoría ya señaló en nómina.

##### `E4.2-l` Test que impide que los reportes vuelvan a divergir · **S**

Tres capas de defensa, en un solo archivo tests/reporting/single-source.spec.ts. El repositorio ya tiene precedente de test estático sobre el fuente (tests/accounting/period-close-accounts.spec.ts lee period-close.ts y afirma sobre su contenido); se sigue ese estilo.

1. Prohibición de SQL fuera de la capa. Se define la lista de archivos que consumen reportes:
   const CONSUMERS = ['src/ai/tools/report-tools.ts','src/api/rest/routes/reports.ts','src/api/graphql/resolvers/index.ts','src/ai/external-service.ts'];
   Para cada uno se afirma que su contenido NO contiene ninguno de estos patrones: /FROM\s+journal_entry_lines/i, /JOIN\s+journal_entry_lines/i, /FROM\s+accounts\s+a/i, /mv_trial_balance/i, /mv_account_balance_summary/i. El mensaje de fallo debe nombrar el archivo y decir 'el SQL de reportes vive en src/services/reporting/queries.ts'.
2. Inventario cerrado. Se afirma que REPORT_NAMES tiene exactamente una función exportada por nombre en queries.ts, que el router de reports.ts registra exactamente 7 rutas GET, y que buildReportTools devuelve exactamente 6 tools cuyos nombres están en una lista literal del test. Una octava ruta o una séptima tool sin su función compartida rompe el test — que es el punto: la próxima persona no puede añadir un reporte sin pasar por la capa.
3. Paridad de fuente. Con la capa compartida mockeada (vi.mock('../../src/services/reporting/queries.js')), se invoca la balanza por las TRES superficies (handler REST, tool del agente, resolver GraphQL) contra el mismo conjunto de filas y se afirma que las tres llamaron a getTrialBalance y que los tres importes resultantes, normalizados a 4 decimales, son idénticos. Divergencias legítimas de presentación (envolturas, nombres de campo) se permiten; divergencias de IMPORTE no.

Además, un test de disciplina en tests/reporting/no-new-copies.spec.ts: recorre todo src/ buscando los patrones del punto 1 y afirma que sólo aparecen en una lista blanca explícita (src/services/reporting/queries.ts, src/services/accounting/*.ts, src/database/migrations/*.sql, src/ai/onboarding-service.ts). Un archivo nuevo con SQL de balanza falla el test y obliga a decidir conscientemente si va a la lista blanca.

**Archivos**

- `tests/reporting/single-source.spec.ts` — crear: prohibición de SQL en consumidores, inventario cerrado y paridad de importes entre las tres superficies
- `tests/reporting/no-new-copies.spec.ts` — crear: barrido de src/ con lista blanca explícita

**Criterios de aceptación**

- Dado el estado tras E4.2-k, cuando corre `npm test`, entonces los dos archivos nuevos pasan.
- Dado que alguien reintroduce una consulta SELECT ... FROM journal_entry_lines en src/api/rest/routes/reports.ts, cuando corre `npm test`, entonces falla con un mensaje que nombra el archivo y apunta a src/services/reporting/queries.ts.
- Dado que alguien añade una octava ruta GET a reports.ts sin función correspondiente en la capa, cuando corre `npm test`, entonces el test de inventario falla.
- Dado que la ruta REST y la tool del agente devuelven importes distintos para el mismo conjunto de filas, cuando corre `npm test`, entonces el test de paridad falla nombrando la cuenta y los dos importes.

**Riesgo.** Un test estático sobre el fuente es frágil ante reformateos. Mitigación: las expresiones regulares apuntan a fragmentos de SQL, no a espaciado ni a nombres de variable, y el mensaje de fallo explica qué hacer, para que quien lo rompa sepa si debe recablear o ampliar la lista blanca.

#### Cómo se sabe que cerró

- `SELECT tgname FROM pg_trigger WHERE tgrelid='journal_entries'::regclass AND NOT tgisinternal` no devuelve ningún nombre que empiece por 'trg_refresh'.
- Un script que postea 100 asientos de 2 líneas contra una base con 200 cuentas y 24 periodos tarda al menos un orden de magnitud menos que antes de la migración 032; el número medido antes y después queda en el PR.
- `grep -rn "FROM journal_entry_lines\|FROM accounts a\|mv_trial_balance" src/ | grep -v 'src/services/reporting/\|src/services/accounting/\|src/database/'` devuelve cero líneas.
- `npm test` verde con las suites nuevas: tests/worker/*, tests/reporting/*, tests/accounting/balances.spec.ts, tests/ai/webhooks/drain.spec.ts, tests/webhooks/sweep.spec.ts.
- `npx tsc --noEmit` termina con código 0.
- En una instalación limpia, `mnemosine worker tick` sale con código 0 e informa 0 tareas debidas; tras `mnemosine worker install`, un segundo tick ejecuta las tareas sembradas y `mnemosine worker history` las lista con su status.
- `SELECT count(*) FROM webhook_deliveries WHERE status='pending' AND next_retry_at IS NULL` devuelve 0 tras el primer despliegue con el barredor activo (ninguna entrega queda invisible).
- `SELECT count(*) FROM ai_webhook_deliveries WHERE status='received' AND received_at < NOW() - interval '1 day'` devuelve 0 con el drenaje activo.
- `SELECT count(*) FROM account_balances ab WHERE ABS(ab.ending_balance - (ab.beginning_balance + ab.debit_total - ab.credit_total)) > 0.005` devuelve 0, y un periodo con una fila alterada a mano no puede cerrarse.
- La query GraphQL `trialBalance` sobre una entidad con un asiento en draft ya no incluye ese asiento y devuelve `isBalanced` calculado, no true fijo.
- `grep -n bullmq package.json` no devuelve nada (si se adopta la decisión D1 recomendada).
- GET a `/metrics` del worker devuelve accounting_worker_task_runs_total, accounting_worker_task_duration_seconds y accounting_webhook_delivery_total con al menos una muestra tras un tick con trabajo.


## E5 · Madurez del agente

### E5.1 · Madurar al agente y su gobierno documental: rehidratación, backstop de importes, failover portable, presupuesto, lazo de skills y sincronía documental
**Objetivo.** Cerrar los seis circuitos abiertos del subsistema de IA: que reanudar una sesión devuelva contexto al modelo, que ningún importe se pierda en la compactación, que el failover funcione después del primer turno, que el gasto tenga tope y la tabla de precios tenga fecha auditada, que exista una entrada real que cree skill_drafts sobre una raíz de skills única, y que los corpus NIF y cli-reference queden bajo el mismo gobierno maquinable que ya tiene el corpus NIIF.

**Por qué aquí.** Todas las piezas caras ya están escritas y probadas (compactView, el resumidor sin herramientas, planCompaction, el escáner de confianza, skill_drafts con diff LCS y aprobación con --accept-risk/--override-drift, ai_usage con costo estimado, el registro NIIF con generador y test de sincronía). Lo que falta en los seis casos es cableado y una primitiva pequeña, no arquitectura. Además, la compactación es la dependencia común: vuelve la historia portable (habilita el failover a mitad de sesión) y es la que rehidrata al reanudar, así que conviene tocarla una sola vez y con el backstop de importes ya dentro. Nada de este paquete escribe al mayor ni toca account_roles, así que corre en paralelo a los paquetes contables sin bloquearlos.

**Depende de:** `E0.1` · **Migraciones:** `051-053` · **11 tareas · 5.1 sem-persona**

**Precondiciones:**

- Base con las 30 migraciones aplicadas (ai_sessions 018, ai_usage 021, skill_drafts 027) y `npm test` verde en su estado actual (80 archivos, 1155 pruebas).
- Un perfil de proveedor resoluble (`mnemosine providers`) para los tests manuales de rehidratación y failover; los tests automatizados usan dobles, no red.
- Acordadas las decisiones 1 (forma de los importes), 3 (rehidratación por defecto) y 6 (quién puede proponer skills) antes de empezar las tareas -c, -b y -h respectivamente.

#### Decisiones a resolver

**¿Qué cuenta como IMPORTE para el backstop determinista, y qué formato numérico se asume?**

El backstop compara importes del origen contra el resumen por valor canónico. Si la regla es demasiado laxa, cualquier número (folios internos, cantidades, números de cuenta) acaba en la línea `Amounts (verbatim)` e infla el resumen; si es demasiado estricta, un monto sin símbolo de moneda —muy común en una transcripción contable— se pierde igual que hoy. Además el sistema es mexicano pero los CFDI y los reportes usan punto decimal y coma de miles.

- (A) Solo tokens con marca de moneda explícita ($, MXN, USD, EUR): mínimo ruido, máxima pérdida.
- (B) Marca de moneda O separador de miles O exactamente dos decimales, con exclusión de fechas ISO, porcentajes y coincidencias de UUID/RFC/folio (lo especificado en E5.1-c).
- (C) Cualquier número de 3 o más dígitos: máxima cobertura, ruido inaceptable.
- (D) (B) más soporte de coma decimal estilo europeo (1.234,56).

_Recomendación:_ (B). Cubre los tres modos en que un importe aparece de verdad en estas transcripciones, y las tres exclusiones más el tope de 60 acotan el ruido. Descarto (D) porque mezclar ambos convenios vuelve ambigua la canonicalización de `1.234` y el sistema es MXN/USD, ambos con punto decimal.

_Bloquea:_ E5.1-c (extractAmounts/canonicalAmount) y, por herencia, el modo 'summary' de la rehidratación (E5.1-a).

**¿El presupuesto de IA viene apagado por defecto o con un tope duro, y bloquea o solo avisa en las rutas desatendidas?**

El ledger ai_usage ya registra tokens y costo estimado, pero nada corta. Las rutas desatendidas (`mnemosine jobs run`, `mnemosine ingest`, la importación del init) pueden encadenar muchas llamadas sin humano mirando. Un tope por defecto protege de la factura sorpresa pero puede detener un cierre a media noche; un default apagado deja la brecha abierta para quien no configure nada.

- (A) Apagado por defecto (opt-in con la sección `budget` del config), on_exceed 'warn' por defecto.
- (B) Apagado para chat (interactivo, hay humano mirando) pero un tope duro por defecto para las rutas desatendidas.
- (C) Tope mensual por defecto para todo (p. ej. 50 USD/entidad) con on_exceed 'block'.
- (D) Apagado por defecto, pero `mnemosine init` pregunta el tope y lo escribe en el config.

_Recomendación:_ (A) para esta entrega, más (D) como seguimiento en la sección de init. Un bloqueo por defecto que nadie configuró rompería instalaciones existentes sin aviso; el aviso al 80% y `mnemosine usage` con el estado hacen visible el gasto de inmediato, y el opt-in a 'block' queda a un cambio de config.

_Bloquea:_ E5.1-e (valores por defecto de resolveBudgetLimits y comportamiento de assertWithinBudget en jobs/ingest).

**¿`--continue` rehidrata por defecto, aunque cueste una llamada al modelo al arrancar?**

La rehidratación es gratis para transcripciones cortas (modo verbatim, sin llamada) pero cuesta una llamada de resumen en las largas, y esa llamada tarda unos segundos antes del primer prompt. Hoy la promesa de `--continue` es explícitamente que el modelo arranca en frío.

- (A) Rehidratar siempre por defecto, con `--no-rehydrate` para saltarlo.
- (B) No rehidratar por defecto, con `--rehydrate` explícito.
- (C) Rehidratar por defecto solo en modo verbatim (transcripciones cortas) y pedir confirmación antes de gastar una llamada de resumen.
- (D) Configurable en mnemosine.config.json con default (A).

_Recomendación:_ (A). Es la brecha funcional más visible del subsistema y quien escribe `--continue` está pidiendo continuar, no releer. El modo verbatim ya hace gratis el caso común y la bandera de escape queda a un flag.

_Bloquea:_ E5.1-b (nombre y semántica de la bandera, y el texto de la ayuda que luego se congela en cli-reference.md).

**¿Qué hacer cuando un turno falla en el proveedor vivo DESPUÉS de haber ejecutado una herramienta de escritura?**

El failover a mitad de sesión re-ejecuta el turno en otro proveedor, y con él las herramientas. draft_journal_entry, ask_user y external_push crean filas; solo la ingesta tiene una restricción única (migración 012) que atraparía el duplicado. Un borrador o una pregunta duplicados son ruido de revisión, no corrupción contable, pero erosionan la cola de trabajo humana.

- (A) Rehusar el failover y devolver un error accionable que nombre la herramienta ya ejecutada (lo especificado en E5.1-d).
- (B) Reintentar igualmente y avisar de posibles duplicados.
- (C) Reintentar solo si las herramientas ejecutadas son de lectura o `ask_user` (la más inocua) y rehusar con las demás.
- (D) Reintentar sobre una transacción de compensación que anule las escrituras del intento fallido.

_Recomendación:_ (A). Es la única opción que no duplica nada sin decidir por el humano, y encaja con la doctrina del repositorio (fail closed en todo lo que el modelo pudo influir). (D) es desproporcionado: no existe hoy una noción de turno transaccional.

_Bloquea:_ E5.1-d (WRITE_TOOLS y MidSessionFailoverBlockedError).

**¿Cuál es la ventana de frescura de la tabla de precios antes de que el test de gobierno falle?**

PRICE_TABLE_AS_OF es hoy un comentario. Un test que falla por antigüedad convierte el desfase en trabajo visible, pero también rompe CI en una fecha en la que nadie tocó código. El corpus NIIF ya acepta ese contrato con su test de sincronía.

- (A) 90 días.
- (B) 180 días.
- (C) 365 días.
- (D) Sin test: solo un aviso 'warn' en `mnemosine doctor` y en `mnemosine usage`.

_Recomendación:_ (B) 180 días, más el aviso de doctor de (D). Es un ciclo razonable de repricing de los proveedores y no convierte el mantenimiento en tarea trimestral. Si el equipo prefiere no romper CI por el reloj, (D) sola sigue cerrando el 80% de la brecha.

_Bloquea:_ E5.1-f (PRICE_TABLE_MAX_AGE_DAYS y el test de gobierno).

**¿Puede el AGENTE proponer cambios a skills (herramienta propose_skill), o solo el humano por `mnemosine skills stage`?**

Las skills son configuración ejecutable que el propio agente lee cada sesión. Dejar que proponga sus propias skills es lo que lo convierte en algo que aprende del despacho, pero abre un lazo de auto-modificación: contenido de skills de terceros ya se trata como no confiable (fenced) y podría inducir una propuesta. Toda propuesta queda en cola, escaneada, y solo un humano la materializa.

- (A) Ambas entradas: comando `stage` + herramienta propose_skill (lo especificado en E5.1-h).
- (B) Solo el comando humano `stage`; la herramienta queda para más adelante.
- (C) Ambas, pero propose_skill solo habilitada si el perfil la incluye en su allowlist de herramientas.
- (D) Ambas, y además exigir que toda skill propuesta por el modelo entre siempre con --accept-risk (tratarla como no confiable por origen).

_Recomendación:_ (A) con la salvaguarda de (D) atenuada: la revisión ya muestra el modelo proponente en la cabecera del draft y el diff completo, así que basta con que el escáner corra siempre —como ya hace— y con que la descripción de la herramienta diga que solo encola. Si hay incomodidad con el lazo, (B) entrega igualmente el valor de desbloquear skill_drafts.

_Bloquea:_ E5.1-h (si se elige (B), se entrega solo el subcomando `stage` y no se añade nada a WRITE_TOOLS).

**¿Qué alcance tiene el registro NIF: solo lo que el corpus ya cubre, o el catálogo completo del CINIF?**

ifrs-registry.json cubre 72 fichas porque el corpus NIIF son 10 documentos de detalle. El corpus NIF son 3 documentos operativos (marco, registro, validaciones) que citan del orden de 20 normas. Un registro con 60 fichas prometería una cobertura documental que los 3 docs no tienen; uno con 20 deja fuera normas vigentes sobre las que el agente podría ser preguntado.

- (A) Solo las NIF efectivamente tratadas en nif-marco/nif-registro/nif-validaciones (~20 fichas), con un campo `covered: true`.
- (B) Catálogo completo del CINIF (series A-E), marcando por ficha si el corpus la trata o no (`covered: boolean`), de modo que el agente sepa cuándo debe remitir al contador.
- (C) Catálogo completo sin distinguir cobertura.

_Recomendación:_ (B). Es lo que hace útil el registro para el protocolo de fundamentación del agente: saber que una norma existe y que el corpus NO la cubre es información accionable (remite al contador en vez de improvisar), y el test puede exigir sección propia en el doc solo para las `covered`.

_Bloquea:_ E5.1-i (tamaño del registro, esquema de la ficha y severidad del test de cobertura documental).

#### Tareas

##### `E5.1-a` Primitivas portables de rehidratación en compaction.ts y en los dos runners · **M**

En src/ai/compaction.ts añade la contraparte de compactView para SEMBRAR contexto en una sesión vacía.

1) Mueve `transcriptView(rows: MessageRow[]): CompactableMessage[]` desde src/cli/compact-command.ts:34 a compaction.ts (usa un tipo estructural `{role, content, tool_calls}` para no importar session-store) y re-expórtala desde compact-command.ts para no romper tests/ai/compaction.spec.ts:29.

2) Constantes y funciones nuevas:
- `export const RESUME_VERBATIM_MAX_TOKENS = 8000;`
- `export const RESUME_SOURCE_MAX_CHARS = 200_000;`
- `export const REHYDRATION_ACK = 'Contexto recuperado. Continúo desde ahí.';`
- `export function renderTranscriptVerbatim(view: readonly CompactableMessage[]): string` — líneas `${role}: ${neutralizeFlushMarker(text)}`.
- `export function resumeSourceText(view): string` — igual que la anterior pero recorriendo DESDE EL FINAL y acumulando hasta RESUME_SOURCE_MAX_CHARS (se conserva la cola, lo más reciente), devuelto en orden cronológico.
- `export function resumeMessageText(body: string, mode: 'verbatim' | 'summary'): string` — prefijo `[CONTEXTO RECUPERADO] Esta conversación se reanuda; abajo va {la transcripción previa | un resumen de la transcripción previa}. La transcripción completa vive en `mnemosine sessions`. Trátalo como contexto ya ocurrido, no como una petición nueva.`
- `export interface RehydrationResult { mode: 'verbatim' | 'summary' | 'deferred'; sourceMessages: number; sourceTokens: number; seedChars: number; }`
- `export async function buildSeedText(args: { view: readonly CompactableMessage[]; complete: (instruction: string, sourceText: string) => Promise<string>; identifierPolicy?: IdentifierPolicy }): Promise<{ text: string; result: RehydrationResult } | null>` — devuelve null si view está vacía; si `estimateViewTokens(view) <= RESUME_VERBATIM_MAX_TOKENS` usa renderTranscriptVerbatim SIN llamar a `complete` (cero costo, fidelidad total, mode 'verbatim'); si no, llama a `summarizeForCompaction(resumeSourceText(view), complete, {identifierPolicy})` (mode 'summary'), con lo que hereda los backstops de identificadores e importes.

3) En src/ai/providers/types.ts amplía LlmSession con dos métodos OPCIONALES: `snapshot?(): CompactableMessage[]` y `rehydrate?(view: readonly CompactableMessage[], signal?: AbortSignal): Promise<RehydrationResult | null>`.

4) MnemosineAgent (src/ai/agent.ts): `snapshot()` devuelve `anthropicView(this.messages)`; `rehydrate()` devuelve null si `this.messages.length > 0` (solo siembra historia vacía), llama a buildSeedText con `complete: (i, s) => this.summarize(i, s, signal)` y empuja DOS mensajes: `{role:'user', content:[{type:'text', text: seed.text}]}` y `{role:'assistant', content:[{type:'text', text: REHYDRATION_ACK}]}`. Los dos mensajes preservan la alternancia de roles para el siguiente turno real y evitan el problema de dos mensajes 'user' consecutivos. No pongas cache_control en la semilla: stripCacheMarks/runLoop ya mueven el breakpoint al último turno.

5) OpenAiCompatSession (src/ai/providers/openai-compat.ts): idéntico sobre `this.history` con `{role:'user', content: seed.text}` y `{role:'assistant', content: REHYDRATION_ACK}`; `snapshot()` devuelve `openAiView(this.history)`.

6) `reset()` ya vacía la historia en ambos; no requiere cambios, pero documenta que tras un `/new` la semilla desaparece y `rehydrate` vuelve a estar disponible.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/compaction.ts` — modificar: añadir transcriptView (movida), RESUME_VERBATIM_MAX_TOKENS, RESUME_SOURCE_MAX_CHARS, REHYDRATION_ACK, renderTranscriptVerbatim, resumeSourceText, resumeMessageText, RehydrationResult y buildSeedText
- `/Users/victor/projects/Accounting/src/cli/compact-command.ts` — modificar: eliminar la definición local de transcriptView y re-exportarla desde ../ai/compaction.js
- `/Users/victor/projects/Accounting/src/ai/providers/types.ts` — modificar: LlmSession gana snapshot?() y rehydrate?(); importar CompactableMessage y RehydrationResult de ../compaction.js
- `/Users/victor/projects/Accounting/src/ai/agent.ts` — modificar: implementar snapshot() y rehydrate() en MnemosineAgent
- `/Users/victor/projects/Accounting/src/ai/providers/openai-compat.ts` — modificar: implementar snapshot() y rehydrate() en OpenAiCompatSession

**Criterios de aceptación**

- Dada una vista de transcripción de ~2 000 tokens estimados, cuando se llama buildSeedText, entonces devuelve mode 'verbatim' y la función `complete` NO se invoca ni una vez.
- Dada una vista de ~60 000 tokens, cuando se llama buildSeedText, entonces `complete` se invoca exactamente una vez, el sourceText recibido no supera RESUME_SOURCE_MAX_CHARS y contiene el ÚLTIMO mensaje de la vista.
- Dada una sesión OpenAiCompatSession recién construida, cuando se llama rehydrate(view) y luego runTurn('sigue'), entonces el arreglo de mensajes enviado al endpoint empieza con user(seed)+assistant(REHYDRATION_ACK) antes del user del turno.
- Dada una sesión con historia no vacía, cuando se llama rehydrate(view), entonces devuelve null y la historia queda intacta.
- Dada una vista vacía, cuando se llama rehydrate, entonces devuelve null sin llamadas al modelo.
- `npx tsc --noEmit` en código 0 y tests/ai/compaction.spec.ts sigue verde tras mover transcriptView.

**Pruebas**

- `tests/ai/compaction.spec.ts` — buildSeedText: modo verbatim sin llamadas al modelo bajo el umbral; modo summary con una llamada por encima; recorte por cola respetando RESUME_SOURCE_MAX_CHARS; null con vista vacía
- `tests/ai/providers/openai-compat.spec.ts` — rehydrate siembra user+assistant, el siguiente runTurn los envía, y una segunda llamada a rehydrate devuelve null

**Riesgo.** Dos mensajes 'user' consecutivos son aceptados hoy por la ruta Anthropic (compactView ya puede producirlos), pero la semilla los evita añadiendo el ack sintético; si algún endpoint OpenAI-compat rechazara el ack, degrada a un solo mensaje user y cúbrelo con un test del perfil afectado.

##### `E5.1-b` Rehidratar de verdad en `mnemosine chat --continue/--resume` · **S**

En src/cli/mnemosine.ts, comando `chat`:

1) Mueve `const ac = new AbortController();` (hoy línea 742) a ANTES del bloque try de reanudación (hoy línea 681); el listener `rl.on('SIGINT')` se sigue registrando después de crear readline.

2) Añade la opción `--no-rehydrate` con descripción «No reinyectar el contexto de la sesión reanudada (arranque en frío)» y cambia el texto de `--continue` (hoy afirma «the model context starts fresh», que dejará de ser cierto) por «Reanuda la última sesión de esta terminal/entidad reinyectando su contexto».

3) Dentro de `if (resumed) { … }`, tras imprimir el eco de los últimos 6 mensajes, sustituye la línea «(reminder only — the model starts with a fresh context)» por la rehidratación real:
```ts
let notice: string;
if (opts.rehydrate === false || !session.rehydrate) {
  notice = renderResumeNotice({ kind: 'skipped' });
} else {
  try {
    const r = await session.rehydrate(transcriptView(transcript), ac.signal);
    notice = renderResumeNotice(r ? { kind: 'ok', result: r } : { kind: 'empty' });
  } catch (err) {
    notice = renderResumeNotice({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) });
  }
}
console.log(c.dim(notice));
```
Un fallo de rehidratación NUNCA aborta el chat (misma doctrina que transcriptOff): se avisa y se sigue en frío. Si el usuario interrumpió (signal abortado) re-lanza para no tragarse el Ctrl+C.

4) Exporta desde mnemosine.ts la función pura `export function renderResumeNotice(state: {kind:'ok'; result: RehydrationResult} | {kind:'skipped'|'empty'} | {kind:'failed'; reason:string}): string`, que devuelve textos como «Contexto recuperado: 42 mensajes (~31 200 tokens) resumidos en 2 810 caracteres.», «Contexto recuperado: 12 mensajes replicados literalmente.», «Contexto se rehidratará en el primer turno (el proveedor se elige entonces).» para mode 'deferred', «Sin contexto que recuperar.», «Rehidratación desactivada (--no-rehydrate): el modelo arranca en frío.» y «No se pudo rehidratar (<motivo>); el modelo arranca en frío.». Es la única parte testeable sin TTY, así que vive exportada y pura, como isAffirmative/shouldShowBanner.

5) Actualiza el mensaje de salida (hoy `Resume this conversation:  mnemosine --continue`) para decir que la conversación se reanuda CON su contexto.

Esta tarea cambia la ayuda del CLI, así que obliga a regenerar cli-reference.md (tarea -j).

**Archivos**

- `/Users/victor/projects/Accounting/src/cli/mnemosine.ts` — modificar: opción --no-rehydrate, texto de --continue, AbortController adelantado, llamada a session.rehydrate en el bloque de reanudación, export de renderResumeNotice, mensaje de salida
- `/Users/victor/projects/Accounting/src/ai/docs/mnemosine.md` — modificar: la sección que describe --continue debe dejar de decir que el modelo arranca sin contexto
- `/Users/victor/projects/Accounting/src/ai/docs/cli-reference.md` — modificar: regenerar con npx tsx scripts/generate-cli-reference.ts

**Criterios de aceptación**

- Dada una sesión previa con transcripción, cuando se corre `mnemosine chat --continue` y se pregunta algo que solo se dijo en la sesión anterior, entonces el modelo responde con ese dato sin volver a preguntarlo.
- Dada la misma sesión con `--no-rehydrate`, cuando arranca el chat, entonces se imprime «Rehidratación desactivada» y no se hace ninguna llamada de resumen.
- Dado un proveedor caído al reanudar, cuando la rehidratación lanza, entonces el chat abre igualmente e imprime «No se pudo rehidratar (…); el modelo arranca en frío.» y el proceso no termina con código distinto de 0.
- Dado Ctrl+C durante la rehidratación, cuando el signal aborta, entonces el proceso sale con 130 y no imprime el aviso de fallo.
- renderResumeNotice cubre los cinco estados con textos distintos y sin lanzar.

**Pruebas**

- `tests/cli/entry-flow.spec.ts` — renderResumeNotice: un caso por estado (ok/verbatim, ok/summary, deferred, skipped, empty, failed) verificando que el texto nombra el modo y no promete contexto que no hay

**Riesgo.** Reanudar pasa a costar una llamada al modelo en transcripciones largas; el modo verbatim la evita en las cortas y --no-rehydrate da la salida. Ver decisión 3.

##### `E5.1-c` Backstop determinista de importes en la compactación (y folios en minúscula) · **M**

En src/ai/compaction.ts, junto a extractIdentifiers/ensureIdentifiersSurvive:

1) `export const MAX_BACKSTOPPED_AMOUNTS = 60;`

2) `export function canonicalAmount(raw: string): string` — normaliza a una clave comparable: quita símbolo y código de moneda ($, MXN, USD, EUR), quita separadores de miles, colapsa la parte decimal quitando ceros no significativos (`980.00` → `980`, `1,234.50` → `1234.5`) y quita ceros a la izquierda. Devuelve '' si no queda un número.

3) `export function extractAmounts(text: string): Array<{ raw: string; canonical: string }>` — en orden de aparición, deduplicado por `canonical`. Formas aceptadas (formato es-MX/en-US: coma para miles, punto para decimales — ver decisión 1):
   a. número con marca de moneda pegada o adyacente: `$1,234.56`, `1,234.56 MXN`, `USD 980`;
   b. número con separador de miles: `1,234` / `1,234.5`;
   c. número con EXACTAMENTE dos decimales: `980.00`.
   Exclusiones obligatorias, todas verificables: (i) cualquier subcadena que caiga dentro de una coincidencia de UUID_RE, RFC_RE o FOLIO_RE (calcula primero esos rangos y descarta solapes), (ii) fechas ISO `\d{4}-\d{2}-\d{2}`, (iii) números seguidos de `%`.

4) `export function ensureAmountsSurvive(summary: string, sourceText: string): string` — construye el conjunto de `canonical` presentes en el resumen (aplicando extractAmounts sobre el resumen), y para cada importe del origen cuyo canonical falte, lo acumula. Si no falta ninguno devuelve `summary` tal cual. Si faltan, añade `\n\nAmounts (verbatim): ` con los `raw` separados por coma, truncando a MAX_BACKSTOPPED_AMOUNTS y cerrando con ` (+N more — full transcript in \`mnemosine sessions\`)`.

5) En `summarizeForCompaction`, cuando la política es 'strict', aplica `ensureAmountsSurvive(ensureIdentifiersSurvive(summary, sourceText), sourceText)` — identificadores primero para que la línea `Identifiers:` no se compare como origen de importes.

6) Corrige FOLIO_RE para aceptar minúsculas: añade la bandera `i` (el dedupe de extractIdentifiers ya normaliza con toUpperCase) y verifica que la exclusión por guion sigue impidiendo que muerda segmentos internos de un UUID.

7) Actualiza el bloque de comentario de cabecera (líneas 13-19, que hoy afirma que los importes NO tienen backstop), el comentario previo a STRICT_IDENTIFIER_RULE (líneas 292-295) y el texto de STRICT_IDENTIFIER_RULE si hace falta.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/compaction.ts` — modificar: MAX_BACKSTOPPED_AMOUNTS, canonicalAmount, extractAmounts, ensureAmountsSurvive; enganche en summarizeForCompaction; FOLIO_RE case-insensitive; comentarios de cabecera actualizados

**Criterios de aceptación**

- Dado un origen con `$1,234.56` y un resumen que dice «alrededor de 1,200 pesos», cuando corre summarizeForCompaction en modo strict, entonces el resumen devuelto termina con `Amounts (verbatim): $1,234.56`.
- Dado un origen con `980.00` y un resumen que escribe `980`, entonces NO se añade línea de importes (canonical coincide).
- Dado un origen con la fecha `2026-08-24`, el porcentaje `16%` y el UUID `A1B2C3D4-...`, entonces extractAmounts devuelve vacío para esos tres.
- Dado un origen con 200 importes distintos ausentes del resumen, entonces la línea añadida lista 60 y termina con `(+140 more …)`.
- Dado un folio en minúsculas `f-2041` ausente del resumen, entonces ensureIdentifiersSurvive lo añade a la línea `Identifiers:`.
- El comentario de cabecera de compaction.ts ya no afirma que los importes dependen solo de la instrucción.

**Pruebas**

- `tests/ai/compaction.spec.ts` — canonicalAmount (equivalencias 980.00/980/$980.00 MXN), extractAmounts (formas aceptadas, exclusión de fechas/porcentajes/UUID/RFC/folio), ensureAmountsSurvive (falta, no falta, tope de 60), FOLIO_RE en minúsculas

**Riesgo.** Falsos positivos (números que no son dinero) inflarían el resumen; se mitigan con el tope de 60, el dedupe por canonical y las tres exclusiones. Si el corpus real de sesiones muestra ruido, endurece la forma (c) exigiendo marca de moneda — es un cambio de una constante y su test.

##### `E5.1-d` Failover a mitad de sesión usando la historia compactada como puente portable · **M**

Reescribe el objeto que devuelve `createLlmSessionWithFailover` (src/ai/providers/index.ts:175-191) para que deje de ser mono-proveedor tras el primer turno.

Estado interno nuevo: `live: LlmSession | null`, `liveName: string | null`, `pendingSeed: CompactableMessage[] | null`, `turnTools: Set<string>`.

1) SEMILLA DIFERIDA: implementa `rehydrate(view, signal)`: si hay `live`, delega; si no, guarda `pendingSeed = view` y devuelve `{ mode: 'deferred', sourceMessages: view.length, sourceTokens: estimateViewTokens(view), seedChars: 0 }`. En el cierre de intento de `firstTurn`, después de `make(resolved, …)` y ANTES de `session.runTurn(...)`, ejecuta `if (pendingSeed) await session.rehydrate?.(pendingSeed, signal)`: así un proveedor que falle al resumir la semilla cuenta como intento fallido y la cadena sigue caminando.

2) DETECCIÓN DE EFECTOS: envuelve `callbacks.onToolUse` antes de pasarlo a `make()` para registrar cada nombre de herramienta en `turnTools`; limpia `turnTools` al inicio de cada `runTurn`.
`export const WRITE_TOOLS: ReadonlySet<string> = new Set(['draft_journal_entry', 'ask_user', 'external_push', 'propose_skill']);`

3) FAILOVER TARDÍO: en `runTurn`, cuando existe `live`:
```ts
try { return await live.runTurn(userInput, signal); }
catch (err) {
  if (signal?.aborted) throw err;
  const category = classifyProviderError(err);
  if (!isFailoverEligible(category)) throw err;
  const wrote = [...turnTools].some((t) => WRITE_TOOLS.has(t));
  if (wrote) throw new MidSessionFailoverBlockedError(liveName!, category, [...turnTools], err);
  const rest = chain.filter((p) => p.name !== liveName);
  if (rest.length === 0) throw err;
  cooldowns.trip(liveName!, Date.now());
  const snapshot = live.snapshot?.() ?? [];
  const { result } = await runWithFailover(rest as NamedProfile[], async (candidate) => {
    const resolved = resolveProfile(candidate.name, undefined, cwd);
    const session = await make(resolved, ctx, wrappedCallbacks, sessionOpts);
    if (snapshot.length > 0) await session.rehydrate?.(snapshot, signal);
    const text = await session.runTurn(userInput, signal);
    return { session, text };
  }, { onFailover: onFailoverEvent, cooldowns: opts.cooldowns, signal });
  live = result.session; liveName = result.session.label.split(' · ')[0]; liveLabel = result.session.label;
  return result.text;
}
```
Avisa siempre por `opts.onFailover(liveName, category, siguiente)` para que el humano vea la costura (el chat ya imprime esa línea).

4) `MidSessionFailoverBlockedError extends Error` con `code = 'MIDSESSION_FAILOVER_BLOCKED'` y mensaje accionable: «El proveedor X falló (rate_limit) DESPUÉS de ejecutar draft_journal_entry; no se reintenta en otro proveedor para no duplicar la escritura. Revisa `mnemosine drafts` y vuelve a pedirlo, o cambia con /provider.» Es la salvaguarda que evita duplicar borradores/preguntas por un reintento (ver decisión 4).

5) `snapshot()` del envoltorio delega en `live?.snapshot?.()`; `compact()` y `reset()` siguen delegando como hoy.

Deja explícito en el comentario de cabecera (hoy líneas 83-92, que declara el failover tardío como trabajo futuro) qué lo hizo posible: snapshot + rehydrate.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/providers/index.ts` — modificar: envoltorio con failover tardío, semilla diferida, WRITE_TOOLS, MidSessionFailoverBlockedError; actualizar el comentario de la sección FAILOVER-AWARE SESSION FACTORY
- `/Users/victor/projects/Accounting/src/cli/mnemosine.ts` — modificar: reportError debe imprimir el mensaje de MidSessionFailoverBlockedError sin stack, y provenance.onFailover ya cubre la reatribución del proveedor

**Criterios de aceptación**

- Dada una cadena a→b, cuando el turno 3 falla en `a` con un error 429 y el turno no usó herramientas de escritura, entonces se construye una sesión de `b`, se le siembra el snapshot y devuelve la respuesta; `session.label` pasa a nombrar a `b`.
- Dado ese mismo failover, cuando se inspecciona la sesión de `b`, entonces su primer mensaje es la semilla `[CONTEXTO RECUPERADO]` derivada del snapshot de `a`.
- Dado un turno que ya llamó a draft_journal_entry y luego falla con 500, entonces se lanza MidSessionFailoverBlockedError, NO se construye ninguna sesión nueva y el mensaje nombra la herramienta ejecutada.
- Dado un error no elegible (refusal), entonces se re-lanza sin tocar la cadena ni los cooldowns.
- Dado un abort del usuario a mitad de turno, entonces el error se re-lanza tal cual y no se intenta failover.
- Dada una sesión con `rehydrate` diferido y una cadena a→b donde `a` falla al sembrar la semilla, entonces `b` recibe la misma semilla y produce el primer turno.

**Pruebas**

- `tests/ai/providers/failover-session.spec.ts` — failover en el turno N: la sesión nueva recibe rehydrate con el snapshot de la anterior; bloqueo por herramienta de escritura; error no elegible re-lanzado; abort re-lanzado; semilla diferida aplicada al ganador del primer turno

**Riesgo.** Un reintento en otro proveedor re-ejecuta las herramientas del turno; la lista WRITE_TOOLS es la única barrera y debe crecer con cada herramienta de escritura nueva. Añade un test que falle si buildTools expone una herramienta cuyo nombre empiece por draft_/queue_/propose_ y no esté en WRITE_TOOLS.

##### `E5.1-e` Presupuesto y alerta sobre ai_usage, aplicados en el único punto donde nace toda sesión · **M**

Módulo nuevo src/ai/budget.ts (sin dependencias de UI, al estilo de floor.ts):

```ts
export interface BudgetLimits { dailyUsd?: number; monthlyUsd?: number; onExceed: 'warn' | 'block'; }
export const BUDGET_WARN_RATIO = 0.8;
export function resolveBudgetLimits(cwd?: string): BudgetLimits
export interface BudgetSpend { dailyUsd: number; monthlyUsd: number; unpricedTurns: number; }
export async function currentSpend(ctx: AgentContext): Promise<BudgetSpend>
export type BudgetState = 'ok' | 'warn' | 'exceeded';
export interface BudgetStatus { state: BudgetState; window: 'daily' | 'monthly' | null; spentUsd: number; limitUsd: number | null; unpricedTurns: number; message: string | null; }
export function evaluateBudget(spend: BudgetSpend, limits: BudgetLimits): BudgetStatus
export class BudgetExceededError extends Error { readonly code = 'AI_BUDGET_EXCEEDED'; }
export class BudgetGuard { constructor(status: BudgetStatus, limits: BudgetLimits); addSpend(usd: number): void; check(): void; get status(): BudgetStatus; }
export async function assertWithinBudget(ctx: AgentContext, cwd?: string): Promise<{ guard: BudgetGuard; limits: BudgetLimits }>
```
`currentSpend` con UNA consulta, apoyada en el índice existente idx_ai_usage_entity_created:
```sql
SELECT COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0) AS daily,
       COALESCE(SUM(estimated_cost_usd), 0) AS monthly,
       COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS unpriced
FROM ai_usage WHERE entity_id = $1 AND created_at >= date_trunc('month', NOW())
```
`evaluateBudget`: 'exceeded' si algún límite definido se supera; 'warn' si algún límite definido se supera en su BUDGET_WARN_RATIO; ventana = la que disparó (diaria primero). Sin límites definidos → siempre 'ok' (opt-in, ver decisión 2). `message` menciona el gasto, el límite, la ventana y —si unpricedTurns > 0— que N turnos no tienen precio en la tabla local y el estimado va por debajo.

`BudgetGuard.check()` lanza BudgetExceededError cuando `state === 'exceeded' && limits.onExceed === 'block'`; `addSpend` acumula en memoria el costo estimado de cada llamada del proceso y recalcula el estado sin volver a la BD.

Cableado (un solo punto de estrangulamiento): en `createLlmSession` (src/ai/providers/index.ts:52), antes de construir el runner:
```ts
const { guard } = await assertWithinBudget(ctx, opts.cwd);
guard.check();
if (guard.status.state === 'warn') opts.onBudgetWarning?.(guard.status);
const budgeted: SessionCallbacks = { ...callbacks, onUsage: (u) => { guard.addSpend(estimateCostUsd(u) ?? 0); callbacks.onUsage?.(u); } };
```
y envuelve la sesión resultante con `withBudgetGuard(session, guard)` — un decorador que llama `guard.check()` al entrar en cada `runTurn` y delega todo lo demás (label, reset, compact, snapshot, rehydrate). Como `createLlmSessionWithFailover` construye a través de `make = createLlmSession`, hereda el guardián sin código extra; los tests que inyectan `sessionFactory` lo saltan a propósito.

Configuración: en src/ai/providers/config.ts añade `budgetSchema = z.object({ daily_usd: z.number().positive().optional(), monthly_usd: z.number().positive().optional(), on_exceed: z.enum(['warn','block']).optional() }).strict()` y la clave `budget` al `configFileSchema` (que es `.strict()`, así que sin esto un config con budget se rechaza).

Superficie: `CreateLlmSessionOptions.onBudgetWarning?: (s: BudgetStatus) => void` (el chat lo imprime en amarillo tras el banner), y `mnemosine usage` (src/cli/usage-command.ts) gana un pie con el estado del presupuesto cuando hay límites definidos.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/budget.ts` — crear: límites, gasto, evaluación, BudgetExceededError, BudgetGuard, assertWithinBudget, withBudgetGuard
- `/Users/victor/projects/Accounting/src/ai/providers/config.ts` — modificar: budgetSchema y clave `budget` en configFileSchema
- `/Users/victor/projects/Accounting/src/ai/providers/index.ts` — modificar: assertWithinBudget + composición de onUsage + withBudgetGuard en createLlmSession; onBudgetWarning en CreateLlmSessionOptions
- `/Users/victor/projects/Accounting/src/cli/usage-command.ts` — modificar: pie con el estado del presupuesto cuando hay límites
- `/Users/victor/projects/Accounting/src/cli/mnemosine.ts` — modificar: pasar onBudgetWarning en buildSession y en makeRunAgentTurn; reportError imprime BudgetExceededError sin stack
- `/Users/victor/projects/Accounting/src/ai/docs/connectivity.md` — modificar: documentar la sección `budget` del config

**Criterios de aceptación**

- Dado un config con `budget: { monthly_usd: 20, on_exceed: 'block' }` y 21 USD estimados en el mes para la entidad, cuando se corre `mnemosine chat`, entonces falla con BudgetExceededError, el mensaje nombra el gasto y el límite, y no se realiza ninguna llamada al proveedor.
- Dado el mismo config con 17 USD gastados (85%), cuando arranca el chat, entonces se imprime una advertencia y la sesión funciona.
- Dado `on_exceed: 'warn'`, cuando se supera el límite, entonces solo advierte y no bloquea.
- Dado un config sin sección `budget`, entonces evaluateBudget devuelve 'ok' y no se ejecuta ninguna consulta de gasto adicional por turno.
- Dada una sesión larga que cruza el límite a mitad, cuando empieza el siguiente turno, entonces BudgetGuard.check() lanza sin consultar la BD (el acumulador en memoria basta).
- Dado un mes con 5 turnos sin precio en la tabla local, entonces BudgetStatus.unpricedTurns = 5 y el mensaje advierte que el estimado va por debajo.

**Pruebas**

- `tests/ai/budget.spec.ts` — evaluateBudget (ok/warn/exceeded, ventana diaria antes que mensual, sin límites), BudgetGuard.addSpend cruzando el umbral a mitad de sesión, BudgetExceededError en modo block y silencio en modo warn, mensaje con unpricedTurns
- `tests/ai/providers/config.spec.ts` — el esquema acepta la sección budget y rechaza claves desconocidas dentro de ella

**Riesgo.** createLlmSession pasa a tocar la base de datos: rutas que hoy construyen sesión sin BD viva empezarían a fallar. Verificado que todas (chat, ingest, jobs, init s5-import) ya resuelven AgentContext contra la BD antes, así que no hay ruta nueva expuesta; aun así, si currentSpend falla por BD caída, `assertWithinBudget` debe FALLAR ABIERTO (estado 'ok' con message de diagnóstico) salvo que on_exceed sea 'block', donde falla cerrado.

##### `E5.1-f` Fecha de corte auditada de la tabla de precios y aviso de obsolescencia · **S**

En src/ai/providers/prices.ts la fecha de corte vive hoy solo en un comentario (línea 8). Conviértela en dato:

1) `export const PRICE_TABLE_AS_OF = '2026-08-24';` y `export function priceTableAgeDays(now: Date = new Date()): number`.
2) `export const PRICE_TABLE_MAX_AGE_DAYS = 180;` y `export function isPriceTableStale(now?: Date): boolean`.
3) Nuevo check en src/ai/doctor-service.ts: `export function checkPriceTable(now: Date): CheckResult` — 'ok' con `verificada hace N días`, 'warn' cuando supera PRICE_TABLE_MAX_AGE_DAYS con detalle «revisa las tarifas publicadas, actualiza PRICE_TABLE y sube PRICE_TABLE_AS_OF». Añádelo a `runDoctor` (no depende de BD: va junto a checkModelProvider/checkEncryptionKey).
4) Test de gobierno, mismo espíritu que el de sincronía del corpus NIIF: falla cuando la tabla lleva más de PRICE_TABLE_MAX_AGE_DAYS sin verificar, con mensaje accionable. Es el único mecanismo que evita que el ledger estime con precios de hace un año en silencio.
5) `mnemosine usage` imprime, cuando `isPriceTableStale()`, una línea al pie: «Precios verificados el AAAA-MM-DD (hace N días): los estimados pueden estar desfasados.»

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/providers/prices.ts` — modificar: PRICE_TABLE_AS_OF, PRICE_TABLE_MAX_AGE_DAYS, priceTableAgeDays, isPriceTableStale
- `/Users/victor/projects/Accounting/src/ai/doctor-service.ts` — modificar: checkPriceTable y su inclusión en runDoctor
- `/Users/victor/projects/Accounting/src/cli/usage-command.ts` — modificar: pie de obsolescencia de precios

**Criterios de aceptación**

- Dado PRICE_TABLE_AS_OF con 200 días de antigüedad, cuando corre `mnemosine doctor`, entonces aparece un check 'warn' que nombra la fecha y qué hacer.
- Dada una fecha de corte de 30 días, entonces el check es 'ok' y `mnemosine usage` no imprime el pie de obsolescencia.
- El test de gobierno falla con un mensaje que dice exactamente qué actualizar cuando la tabla supera los 180 días respecto de la fecha real de ejecución.

**Pruebas**

- `tests/ai/providers/prices.spec.ts` — priceTableAgeDays con `now` inyectado; isPriceTableStale en ambos lados del umbral; el test de gobierno sin `now` inyectado que falla si la tabla real está vencida
- `tests/ai/doctor-service.spec.ts` — checkPriceTable devuelve ok/warn según la antigüedad y runDoctor lo incluye

**Riesgo.** Un test que depende del reloj de pared falla algún día sin que nadie cambie código — eso es exactamente lo que se busca (el mismo contrato que el test de sincronía del corpus), pero debe traer instrucciones en el mensaje para que la reparación sea de un minuto. Ver decisión 5 para la ventana.

##### `E5.1-g` Unificar la raíz del árbol de skills entre el store y skill-drafts · **S**

Hoy el store descubre en `path.join(cwd, 'skills')` (store.ts:198-200) y skill-drafts resuelve `<projectRoot>/skills` desde su propio __dirname (skill-drafts.ts:78-83). Correr `mnemosine` desde otro directorio hace que la skill servida y la base del diff sean archivos distintos — es el pendiente anotado en skill-drafts.ts:62 y la precondición para habilitar la creación de drafts.

1) Módulo nuevo src/ai/skills/roots.ts, único dueño de la resolución:
```ts
export const SKILLS_ROOT_ENV = 'MNEMOSINE_SKILLS_ROOT';
export function resolveSkillsRoot(opts?: { override?: string; env?: NodeJS.ProcessEnv }): string   // override > env[SKILLS_ROOT_ENV] > <projectRoot>/skills (findProjectRoot desde __dirname, cacheado)
export function skillRoots(opts: { override?: string; homeDir: string; env?: NodeJS.ProcessEnv }): string[]  // [resolveSkillsRoot(...), <home>/.mnemosine/skills]
export function clearSkillsRootCache(): void  // seam de tests
```
Mueve aquí `findProjectRoot` y el caché de skill-drafts.ts; skill-drafts.ts pasa a importar `resolveSkillsRoot` de roots.ts y borra su copia (mantén `export { resolveSkillsRoot }` desde skill-drafts.ts si algún llamador la importa desde ahí).

2) En store.ts: `SkillStoreOptions` gana `skillsRoot?: string`. `skillDirs(cwd, homeDir)` se sustituye por `skillRoots({ override: opts.skillsRoot, homeDir, env })`; `discover()` recibe los roots ya resueltos. El parámetro `cwd` de listSkills/visibleSkills/viewSkill/readSkillReference/skillsPromptIndex SE CONSERVA, pero pasa a servir solo para `loadConfigFile(cwd)` (el archivo de configuración del proyecto sí es legítimamente relativo al cwd); documenta ese cambio de semántica en el comentario de cabecera del store, que hoy dice «Locations: ./skills/ (project)…».

3) Actualiza tests/ai/skills/store.spec.ts y tests/ai/skills/skills-tools.spec.ts: en el `beforeEach`, `opts = { homeDir, env: {}, config: {}, skillsRoot: path.join(projectDir, 'skills') }`; las llamadas `listSkills(projectDir, opts)` siguen igual pero ahora descubren por skillsRoot.

4) Añade a tests/ai/skills/skill-drafts.spec.ts un caso de identidad: con `MNEMOSINE_SKILLS_ROOT` apuntando a un temporal, `resolveSkillsRoot()` y el root que usa el store coinciden byte a byte.

5) Documenta en src/ai/docs/mnemosine.md dónde vive el árbol de skills y cómo moverlo con la variable de entorno.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/skills/roots.ts` — crear: resolveSkillsRoot, skillRoots, clearSkillsRootCache, SKILLS_ROOT_ENV
- `/Users/victor/projects/Accounting/src/ai/skills/store.ts` — modificar: SkillStoreOptions.skillsRoot, discover() sobre skillRoots(), eliminar skillDirs(cwd, homeDir), actualizar comentario de cabecera
- `/Users/victor/projects/Accounting/src/ai/skills/skill-drafts.ts` — modificar: importar resolveSkillsRoot de roots.ts, borrar findProjectRoot/caché local y la nota INTEGRATION de la línea 62
- `/Users/victor/projects/Accounting/tests/ai/skills/store.spec.ts` — modificar: inyectar skillsRoot en opts
- `/Users/victor/projects/Accounting/tests/ai/skills/skills-tools.spec.ts` — modificar: inyectar skillsRoot donde hoy se apoya en cwd
- `/Users/victor/projects/Accounting/src/ai/docs/mnemosine.md` — modificar: sección de skills — ubicación del árbol y MNEMOSINE_SKILLS_ROOT

**Criterios de aceptación**

- Dado un proceso cuyo cwd es /tmp, cuando se llama `visibleSkills()` sin argumentos, entonces descubre las skills de <projectRoot>/skills, las mismas que `resolveSkillsRoot()` devuelve para el diff.
- Dado MNEMOSINE_SKILLS_ROOT apuntando a un directorio temporal con una skill, entonces `mnemosine skills list` la lista y un draft sobre ella calcula previous_content contra ESE archivo.
- La cadena `skillDirs(` ya no aparece en src/ (grep vacío) y el pendiente de integración de skill-drafts.ts:62 queda borrado.
- Toda la suite de tests/ai/skills sigue verde tras la migración de opts.

**Pruebas**

- `tests/ai/skills/skill-drafts.spec.ts` — identidad de raíces: el root que usa el store y resolveSkillsRoot() coinciden con y sin MNEMOSINE_SKILLS_ROOT; un draft creado desde otro cwd toma como base el archivo realmente servido

**Riesgo.** En un despliegue empaquetado (dist/ o node_modules) findProjectRoot podría apuntar al paquete instalado en vez del directorio del despacho; MNEMOSINE_SKILLS_ROOT es la válvula de escape y debe quedar documentada en connectivity.md/mnemosine.md.

##### `E5.1-h` Cerrar el lazo: dos entradas que crean skill_drafts (comando humano y herramienta del agente) · **M**

Con la raíz unificada (-g), habilita la creación de drafts. Ninguna de las dos entradas escribe en disco: la única ruta de escritura sigue siendo approveSkillDraft.

1) COMANDO HUMANO — en src/cli/skills-command.ts añade el subcomando `stage`:
`mnemosine skills stage <nombre> [--file <ruta>] [--delete] [-e|--entity] [-t|--tenant] [--json]`.
Comportamiento: valida que `--file` y `--delete` sean mutuamente excluyentes y que exactamente uno esté presente; lee el archivo con fs.readFileSync (utf-8) y lo VALIDA con `parseSkillMarkdown` antes de encolar — si `parsed.valid === false` aborta con el `invalidReason` y no crea fila (encolar un SKILL.md que el store luego marcará inválido solo desperdicia una revisión); llama a `createSkillDraft(ctx, { skillName, action: existeEnDisco ? 'update' : 'create', content })` o `{ action: 'delete' }`; imprime el veredicto del escáner con `formatScanReportCard` y el diff con `formatDraftDiff`, y termina con «Revísalo y apruébalo con: mnemosine skills drafts». Guardia de no-TTY innecesaria (no es interactivo).

2) HERRAMIENTA DEL AGENTE — en src/ai/tools/skills-tools.ts añade `propose_skill` (sujeta a la decisión 6):
```
inputSchema: z.object({
  name: z.string().min(1),
  action: z.enum(['create','update','delete']),
  content: z.string().min(1).optional(),   // SKILL.md completo; ausente en delete
  reasoning: z.string().min(1),
})
```
`run`: `deps.observe?.('propose_skill', input)`; rechaza (como RESULTADO de herramienta, no excepción) si action != 'delete' y falta content, o si `parseSkillMarkdown(content).valid === false` devolviendo el motivo para que el modelo corrija; llama a `createSkillDraft(ctx, { skillName: input.name, action: input.action, content, model: deps.model })`; devuelve `{ staged: true, draft_id, scan_threats: n, next: 'mnemosine skills drafts' }` y NUNCA afirma que la skill ya está activa. Registra la herramienta en buildSkillsTools y añádela a WRITE_TOOLS (tarea -d).
Descripción de la herramienta: debe decir explícitamente que el cambio queda en cola de revisión humana, que un humano lo aprueba y que el contenido pasa por un escáner de confianza.

3) `mnemosine skills list` ya avisa de los drafts pendientes; añade el mismo recordatorio al `pending`/banner reutilizando `fetchPendingCounts` si el conteo de skill_drafts pendientes es > 0.

4) Documenta el flujo completo (proponer → revisar → aprobar con --accept-risk/--override-drift) en src/ai/docs/mnemosine.md.

**Archivos**

- `/Users/victor/projects/Accounting/src/cli/skills-command.ts` — modificar: subcomando `stage` con validación previa por parseSkillMarkdown y render del escáner + diff
- `/Users/victor/projects/Accounting/src/ai/tools/skills-tools.ts` — modificar: herramienta propose_skill que solo encola en skill_drafts
- `/Users/victor/projects/Accounting/src/ai/providers/index.ts` — modificar: añadir 'propose_skill' a WRITE_TOOLS
- `/Users/victor/projects/Accounting/src/cli/mnemosine.ts` — modificar: conteo de skill_drafts pendientes en el aviso de pendientes
- `/Users/victor/projects/Accounting/src/ai/docs/mnemosine.md` — modificar: documentar proponer/revisar/aprobar skills
- `/Users/victor/projects/Accounting/src/ai/docs/cli-reference.md` — modificar: regenerar tras añadir `skills stage`

**Criterios de aceptación**

- Dado un SKILL.md válido en /tmp/x.md y ninguna skill llamada `cierre`, cuando corre `mnemosine skills stage cierre --file /tmp/x.md`, entonces skill_drafts tiene una fila pending_review con action='create', previous_content NULL y scan_report poblado, y nada se escribió en el árbol de skills.
- Dado el mismo comando sobre una skill existente, entonces action='update' y previous_content es el contenido actual del archivo que el store realmente sirve.
- Dado un SKILL.md con una clave de frontmatter desconocida, entonces el comando falla nombrando la clave y NO crea fila.
- Dado un contenido con una amenaza del escáner, cuando se aprueba sin --accept-risk desde `mnemosine skills drafts`, entonces se rechaza con el mensaje existente y el archivo no cambia.
- Dada la herramienta propose_skill invocada por el agente, entonces devuelve draft_id y estado pendiente, y `mnemosine skills drafts` muestra ese draft con su modelo en la cabecera.
- Tras aprobar el draft, `mnemosine skills view <nombre>` imprime exactamente el contenido propuesto.

**Pruebas**

- `tests/cli/skills-command.spec.ts` — `stage`: create vs update según exista el archivo; rechazo por frontmatter inválido; exclusión mutua de --file/--delete
- `tests/ai/skills/skills-tools.spec.ts` — propose_skill: encola con model, devuelve draft_id, rechaza contenido inválido como resultado (no excepción), y jamás toca el filesystem

**Riesgo.** Las skills son configuración ejecutable: la superficie de auto-modificación del agente. Mitigado porque propose_skill solo encola, el escáner corre siempre, la aprobación exige humano + --accept-risk y el guardia anti-drift compara contra el archivo realmente servido (posible solo tras la tarea -g). Si la decisión 6 se resuelve en contra, entrega únicamente el comando `stage`.

##### `E5.1-i` Registro maquinable del corpus NIF, generador de índice y test de vigencias · **M**

Replica para NIF el patrón ya probado en NIIF (ifrs-registry.json + scripts/build-niif-indice.ts + tests/ai/niif-registry.spec.ts).

1) src/ai/docs/nif-registry.json con la misma forma: `{ name, scope, verified_at, verification, sources_of_truth, update_playbook, standards[] }`. Cada ficha: `{ code, title_es, status: 'vigente'|'sustituida_pendiente'|'futura'|'derogada', effective (prosa), effective_date (ISO AAAA-MM-DD, OBLIGATORIO para 'futura' y 'sustituida_pendiente'), topic, confidence, sources[], replaced_by? }`. `topic` debe ser una clave existente de DOC_TOPICS. Incluye obligatoriamente las fichas NIF B-1 y NIF B-3 nuevas del CINIF con `status: 'futura'` y `effective_date: '2028-01-01'`, y NIF A-1 con la nota de consolidación de la Serie A (2023) que ya explica nif-marco.md. Alcance del catálogo: ver decisión 8.

2) Doc nuevo src/ai/docs/nif-indice.md con prosa de encabezado (jerarquía de series, supletoriedad hacia NIIF, cómo mantener el corpus) y los marcadores `<!-- REGISTRY:BEGIN -->` / `<!-- REGISTRY:END -->`. Regístralo en DOC_TOPICS (src/ai/tools/docs-tools.ts) como `'nif-indice': 'índice maestro NIF: series A-E, estado y vigencia de cada norma, supletoriedad NIIF y cómo actualizar el corpus'`.

3) scripts/build-nif-indice.ts, calcado de build-niif-indice.ts: `export function buildNifRegistryBlock(registry)`, `export function regenerateNifIndice(): { content: string; changed: boolean }`, agrupación por serie (A, B, C, D, E) con la tabla `| Norma | Nombre | Estado | Vigencia |`, pie `_N fichas · verificado AAAA-MM-DD_`, y el mismo guardia de ejecución `if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))`.

4) tests/ai/nif-registry.spec.ts:
   - registro completo: verified_at parseable, cada ficha con code/status válido/effective/topic registrado en DOC_TOPICS y con archivo .md existente, sources no vacío;
   - SINCRONÍA: `expect(regenerateNifIndice().changed).toBe(false)` con mensaje «corre: npx tsx scripts/build-nif-indice.ts»;
   - VIGENCIAS ALCANZADAS (la brecha de 2028): para cada ficha con `status === 'futura'` y `effective_date <= hoy`, falla con «NIF B-1 entró en vigor el 2028-01-01: actualiza el corpus (nif-marco/nif-registro/nif-validaciones) y cambia su status a vigente»;
   - CLAVES DE VALIDACIÓN: extrae con regex las claves en backticks de la primera columna de las dos tablas de src/ai/docs/nif-validaciones.md y compáralas con los nombres reales de las reglas del motor. Para esto exporta desde src/services/accounting/validation.ts `export const RULE_NAMES = ALL_RULES.map(r => r.name);` (hoy ALL_RULES es privada) y asegura igualdad de conjuntos en ambos sentidos: una regla nueva sin fila en el doc falla, y una fila del doc que nombre una regla inexistente también.

5) Añade nif-indice a la lista de docs con contenido mínimo verificado, al estilo de la prueba equivalente del corpus NIIF.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/docs/nif-registry.json` — crear: registro maquinable del corpus NIF con effective_date y las fichas B-1/B-3 de 2028
- `/Users/victor/projects/Accounting/src/ai/docs/nif-indice.md` — crear: prosa de gobierno + marcadores REGISTRY:BEGIN/END
- `/Users/victor/projects/Accounting/scripts/build-nif-indice.ts` — crear: generador con buildNifRegistryBlock/regenerateNifIndice y guardia de ejecución
- `/Users/victor/projects/Accounting/src/ai/tools/docs-tools.ts` — modificar: registrar el topic 'nif-indice' en DOC_TOPICS
- `/Users/victor/projects/Accounting/src/services/accounting/validation.ts` — modificar: exportar RULE_NAMES derivado de ALL_RULES
- `/Users/victor/projects/Accounting/src/ai/docs/nif-marco.md` — modificar: enlazar a `nif-indice` como índice maestro, igual que hace hacia niif-indice

**Criterios de aceptación**

- Dado nif-registry.json y nif-indice.md sincronizados, cuando corre `npx vitest run tests/ai/nif-registry.spec.ts`, entonces pasa; si se edita a mano la tabla del índice, falla indicando el comando del generador.
- Dada una ficha con status 'futura' y effective_date pasada, entonces el test falla nombrando la norma y la fecha.
- Dada una regla nueva añadida a ALL_RULES sin fila en nif-validaciones.md, entonces el test de claves falla nombrando la regla ausente del doc.
- Dada una fila de nif-validaciones.md que nombre una regla inexistente, entonces el test falla nombrando esa clave huérfana.
- `mnemosine` con read_docs topic='nif-indice' devuelve el índice, y el topic aparece en el índice de docs del system prompt.

**Pruebas**

- `tests/ai/nif-registry.spec.ts` — completitud del registro; sincronía índice↔registro; vigencias futuras alcanzadas; igualdad de conjuntos entre RULE_NAMES y las claves de nif-validaciones.md; nif-indice.md con contenido mínimo

**Riesgo.** El contenido normativo del registro exige verificación humana contra el CINIF: márcalo con `confidence` por ficha y con `verified_at`, y no dejes que el generador invente vigencias. El test de vigencias avisa del desfase, no lo corrige.

##### `E5.1-j` cli-reference: generador importable sin efectos y test de sincronía · **S**

scripts/generate-cli-reference.ts ejecuta HOY su cuerpo al importarse: escribe el archivo y llama a `process.exit(0)` (líneas 48-61). Importarlo desde un test mataría el proceso de vitest, así que primero hay que aislarlo, exactamente como está hecho en scripts/build-niif-indice.ts.

1) Refactor sin cambiar la salida byte a byte:
```ts
export function buildCliReference(): string          // HEADER + secciones recorriendo `program`
export function cliReferencePath(): string           // <root>/src/ai/docs/cli-reference.md
export function regenerateCliReference(): { content: string; changed: boolean }
```
El cuerpo de nivel superior se sustituye por el guardia `if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) { … escribe si changed, imprime el conteo de secciones … }` y se elimina el `process.exit(0)`.

2) `buildCliReference` debe terminar el contenido con salto de línea final (hoy `out.join('\n') + '\n'`) para que la comparación con el archivo en disco sea estable.

3) Test nuevo tests/ai/cli-reference.spec.ts:
   - `expect(regenerateCliReference().changed, 'corre: npx tsx scripts/generate-cli-reference.ts').toBe(false)`;
   - toda opción larga declarada en el árbol de comandos (recorrido de `program.commands` recursivo leyendo `cmd.options`) aparece literalmente en cli-reference.md — atrapa el caso concreto de la brecha: añadir una bandera y olvidar regenerar;
   - el doc empieza con la cabecera «auto-generated — do not edit by hand».
   Importar src/cli/mnemosine.js desde el test ya es seguro: `program.parseAsync` está tras el guardia de `require.main` y el pool de BD es perezoso (así lo hace hoy tests/cli/entry-flow.spec.ts).

4) Regenera cli-reference.md al final del paquete, cuando ya estén dentro `--no-rehydrate` (tarea -b) y `skills stage` (tarea -h). Deja escrito en el README del CLI que regenerar es parte de cualquier cambio de banderas.

**Archivos**

- `/Users/victor/projects/Accounting/scripts/generate-cli-reference.ts` — modificar: exportar buildCliReference/cliReferencePath/regenerateCliReference, guardia de ejecución, quitar process.exit
- `/Users/victor/projects/Accounting/src/ai/docs/cli-reference.md` — modificar: regenerar tras -b y -h
- `/Users/victor/projects/Accounting/src/cli/README.md` — modificar: nota de que cualquier bandera nueva exige regenerar cli-reference.md (el test lo verifica)

**Criterios de aceptación**

- Dado el repositorio sincronizado, cuando corre `npx vitest run tests/ai/cli-reference.spec.ts`, entonces pasa y NO modifica ningún archivo.
- Dada una opción nueva añadida a cualquier comando sin regenerar el doc, entonces el test falla nombrando la opción ausente e indicando el comando del generador.
- Importar scripts/generate-cli-reference.ts desde un test no escribe archivos ni termina el proceso.
- `npx tsx scripts/generate-cli-reference.ts` sigue produciendo el mismo archivo que antes del refactor (diff vacío en un repositorio ya sincronizado).

**Pruebas**

- `tests/ai/cli-reference.spec.ts` — sincronía doc↔program; toda opción larga presente en el doc; cabecera de auto-generado; importar el script no tiene efectos

**Riesgo.** Ninguno relevante: el refactor es de forma, no de contenido; el criterio de diff vacío lo prueba.

##### `E5.1-k` Coherencia interna del registro NIIF: conteo de fichas y vigencias maquinables · **S**

Dos deudas menores del corpus NIIF, baratas ahora que -i deja el patrón afinado.

1) CONTEO: el campo `verification` de src/ai/docs/ifrs-registry.json afirma «69 fichas» y niif-indice.md repite «69 fichas verificadas contra fuentes primarias» (línea 181, prosa hand-maintained), mientras el array tiene 72 y el bloque generado imprime «_72 fichas_». Corrige ambos textos a 72 y añade al test una regla que impida que vuelva a desviarse: extrae con `/(\d+)\s+fichas/g` todas las apariciones en ifrs-registry.json (campo verification) y en niif-indice.md completo, y exige que TODOS los números capturados sean iguales a `registry.standards.length`.

2) VIGENCIAS: añade `effective_date` (ISO) a las fichas de ifrs-registry.json con status 'futura' o 'sustituida_pendiente' — hoy solo hay prosa en `effective` (NIIF 18 y 19 → 2027-01-01, NIIF para PyMEs 3a ed. → 2027-01-01, NIIF 20 → 2029-01-01, NIC 1 y NIIF 14 con la fecha de su sustitución) — y replica en tests/ai/niif-registry.spec.ts el test de «vigencia futura ya alcanzada» especificado en la tarea -i, con el mismo mensaje accionable.

3) Aprovecha para verificar que `confidence` toma solo valores de un conjunto cerrado ('high'|'medium'|'low'): hoy se almacena y no se valida en ninguna parte.

**Archivos**

- `/Users/victor/projects/Accounting/src/ai/docs/ifrs-registry.json` — modificar: corregir el conteo en `verification`, añadir effective_date a las fichas futuras/sustituidas
- `/Users/victor/projects/Accounting/src/ai/docs/niif-indice.md` — modificar: corregir la prosa de '69 fichas' fuera del bloque generado
- `/Users/victor/projects/Accounting/tests/ai/niif-registry.spec.ts` — modificar: test de coherencia del conteo, test de vigencia futura alcanzada, validación del conjunto cerrado de confidence

**Criterios de aceptación**

- Dado que se añade una ficha al registro sin actualizar la prosa, cuando corre el test, entonces falla nombrando el número desviado y el esperado.
- Dada una ficha 'futura' con effective_date pasada, entonces el test falla nombrando la norma y la fecha.
- Dado un `confidence` fuera del conjunto cerrado, entonces el test falla.
- Todos los tests de tests/ai/niif-registry.spec.ts pasan con el registro corregido.

**Pruebas**

- `tests/ai/niif-registry.spec.ts` — coherencia de '(N) fichas' entre prosa, registro y bloque generado; vigencias futuras alcanzadas; conjunto cerrado de confidence

#### Cómo se sabe que cerró

- `npm test` verde con al menos 6 archivos de prueba nuevos o ampliados: tests/ai/compaction.spec.ts, tests/ai/providers/failover-session.spec.ts, tests/ai/budget.spec.ts, tests/ai/skills/skill-drafts.spec.ts, tests/ai/nif-registry.spec.ts y tests/ai/cli-reference.spec.ts.
- `npx tsc --noEmit` termina en código 0.
- `npx vitest run tests/ai/cli-reference.spec.ts` y `npx vitest run tests/ai/nif-registry.spec.ts` pasan sin modificar archivos; tras añadir a mano una bandera al CLI o una fila a la tabla del índice NIF, ambos fallan indicando el generador exacto que hay que correr.
- `npx tsx scripts/build-nif-indice.ts` imprime «ya está sincronizado» y `npx tsx scripts/generate-cli-reference.ts` deja el árbol de git sin cambios.
- `grep -rn "skillDirs(" src/` devuelve cero resultados, y la nota de integración pendiente de src/ai/skills/skill-drafts.ts:62 ya no existe.
- Prueba manual reproducible: en una sesión con transcripción previa, `mnemosine chat --continue` imprime «Contexto recuperado: N mensajes …» y el modelo responde correctamente a una pregunta cuya respuesta solo existe en la sesión anterior.
- Prueba manual reproducible: `mnemosine skills stage demo --file <SKILL.md>` deja una fila pending_review; `SELECT count(*) FROM skill_drafts WHERE status='pending_review'` deja de ser 0 por primera vez; `mnemosine skills drafts` la aprueba y `mnemosine skills view demo` imprime el contenido propuesto.
- Con `budget.monthly_usd` por debajo del gasto acumulado y `on_exceed: 'block'`, `mnemosine chat` falla con AI_BUDGET_EXCEEDED antes de contactar al proveedor; con `on_exceed: 'warn'` arranca e imprime la advertencia.
- `mnemosine doctor` incluye el check «Price table» con la antigüedad en días.
- El comentario de cabecera de src/ai/compaction.ts ya no afirma que los importes carecen de backstop, y el de src/ai/providers/index.ts ya no declara el failover a mitad de sesión como trabajo futuro.


---

## Correcciones aplicadas al plan

Un revisor adversarial encontró 13 problemas graves antes de publicarlo. Ya están resueltos:

- Se añadió el paquete E0.0: el repositorio no está bajo control de versiones (verificado: no existe .git), no hay vitest.config.ts ni .github/.
- Nueve paquetes creaban cada uno un archivo 031_*.sql. Se reparten rangos de numeración por etapa y se añade una comprobación que rechaza prefijos duplicados.
- Dos paquetes creaban .github/workflows/ci.yml. Ahora lo crea E0.0 y los demás solo añaden jobs.
- E0.1 y E1.1 extraían el mismo catálogo de cuentas a módulos distintos: queda uno solo, en src/services/accounting/chart-seed.ts, y el fixture de integración lo consume.
- E4.2-h y E5.1-e implementaban dos veces el mismo presupuesto sobre ai_usage: se unifica en E5.1 y E4.2 solo programa la tarea que lo evalúa.
- E1.4-i y E3.1 se disputaban src/services/mexico/cfdi.ts: E1.4 rescata los catálogos SAT y E3.1 construye sobre el módulo ya rescatado.
- El destino de /public/v1 lo decidían E1.4 y E2.1 en direcciones opuestas: la decisión queda en E1.4 y E2.1 la consume.
- Dependencias corregidas: E1.3 depende de E1.2; E3.2 depende también de E1.2; E4.1 depende también de E0.2; E4.2 depende también de E3.2.

## Cabos que ningún paquete recoge

Asuntos reales que ninguno de los paquetes cubre. No están planificados: decidir si entran o se aceptan como deuda.

- generateClosingEntries sigue devolviendo [] en silencio si faltan las cuentas de sistema (period-close.ts:305-311) y las resuelve por código literal en vez de por account_roles. El bug del 3100 ya está corregido en el código (hoy usa 3200 con su prueba), pero el fallo silencioso —el hard close reporta éxito sin haber cerrado el ejercicio— no lo toca ningún paquete: E1.1 no entra a period-close, E0.1-g sólo prueba, E4.2-i sólo saldos.
- validateJournalEntry usa el helper global query() en vez del client de la transacción: sus cuatro lecturas abren conexiones aparte, no ven el estado sin commitear y añaden round-trips a cada posteo. Ningún paquete lo corrige (E0.1 sólo lo prueba).
- Numeración de folios por año fiscal: sequence.ts usa new Date().getFullYear() en vez de entry_date, así que un asiento de diciembre capturado en enero recibe el año equivocado. E0.1-f y E0.1-k sólo prueban el comportamiento actual.
- Reapertura de periodo: el permiso 'periods:reopen' (auth.ts:147,202) y el status 'locked' se leen en tres sitios (validation.ts:134, posting.ts:94, policy-preview.ts:171) y no se escriben en ninguno; fiscal_years.status nunca pasa a 'closed'. Ningún paquete lo implementa ni lo retira.
- Superficie CLI del motor: no existe `mnemosine reverse`, `void` ni `reopen` (mnemosine.ts sólo registra entities, providers, ask, chat, sessions, drafts, review, ingest, lang, onboard, outbox, questions, login, logout, whoami más los subárboles). El resolver GraphQL de reverseJournalEntry está declarado en schema.ts:501 sin implementación y revienta al invocarse; E2.1-g sólo contempla podarlo del schema.
- Verificación de consistencia de account_balances contra la suma real de journal_entry_lines posteadas por cuenta y periodo. E4.2-i documenta la semántica pero no añade el script/job de reconciliación.
- Endurecimiento de las rutas de pago: FOR UPDATE sobre la factura dentro de la transacción antes de validar el sobrepago, y validación de que la suma de applications[] cuadre con payment_amount y de que cada bill pertenezca a la entidad y al proveedor. Ningún paquete lo toca.
- Flujo de aprobación de bills que el esquema promete: transición explícita a 'pending_approval', umbrales por monto y ruta de void con reversa. E2.2-e sólo aporta el maker-checker genérico.
- Webhooks salientes: 27 de los 30 eventos del catálogo nunca se disparan (journal_entry.posted, invoice.*, cfdi.stamped, period.hard_closed). E4.2-d añade sólo el barredor de reintentos de las entregas que ya existen; nadie las emite.
- Ciclo de vida de la sesión HTTP: se inserta una fila en sessions por petición, no se lee para revocar, no hay refresco por refresh_token ni cliente HTTP en el CLI, de modo que el token que `mnemosine login` guarda no sirve para hablar con la API. Ningún paquete lo aborda (E2.1 y E2.2 sólo cubren autorización).
- Endurecimiento del borde HTTP: allowlist explícita de CORS, CSP de helmet también fuera de producción, /metrics sin protección, etiqueta de ruta acotada para los 404, y rate limiter propio y más estricto para /public/v1 (E1.4-c sólo envuelve los handlers en asyncHandler). El doble montaje de xml-ingestion y blockchain aparece únicamente como decisión de E2.1, sin tarea.
- Parser del CFDI de Retenciones (esquema retenciones:Retenciones), que hoy hace estallar al parser y deja inalcanzable un caso ya escrito y probado de la taxonomía; tampoco Comercio Exterior ni Carta Porte. E1.2-a sólo cubre ImpuestosLocales, Terceros e ImpuestosDR.
- El operador 'regex' del rules-engine compila una expresión almacenada en base de datos sin límite de tiempo (ReDoS con entrada controlada por el tenant). E1.2-e 'reduce el motor de reglas' pero no acota el operador.
- Ciclo de vida del pay run: voidPayRun con reverso del asiento, idempotencia del recálculo (borrar recibos previos dentro de la transacción) y try/catch para no dejar corridas atoradas en 'calculating'. E4.1 postea y dispersa pero no anula ni recalcula.
- Puertas de entrada de nómina que siguen sin existir: CRUD de órdenes de embargo (E0.2-f sólo alinea el motor con la tabla), dispersión SPEI para México sobre direct_deposit_batches, cancelación del CFDI de nómina (E3.1-g sólo encadena la de ingresos) y transición de estado de los lotes de dispersión.
- Beneficios en la corrida: calculateBenefitsForPaycheck no se llama desde calculatePaycheck, y pretax_401k / employer_401k quedan hardcodeados en cero, lo que rompe la casilla 12 del W-2. E0.2-g alinea el esquema pero no cablea el motor a la corrida.
- tax_tables sólo cubre 2026 y cuatro jurisdicciones, y clearCache existe sin llamadores: un cambio de tarifas exige reiniciar el proceso. Ningún paquete lo aborda.
- Pruebas de los calculadores fiscales (ISR, subsidio, IMSS, INFONAVIT, FIT, FUTA, estatales) con cifras publicadas, y del motor de matching bancario (levenshteinDistance, jaccardSimilarity, extractKeywords, descriptionSimilarity y los umbrales 0.70/0.75/0.85/0.90). E0.2-f/-g sólo prueban embargos y beneficios.
- Credenciales de Contalink en process.env en vez de integration_credentials cifrado por tenant, y el adaptador contable sin circuit breaker ni withRetry (que los PACs sí tienen).
- Cálculo del flujo de efectivo por ILIKE '%receivable%' / '%payable%', que en un catálogo en español devuelve cero: E4.2-j/-k unifica el SQL de reportes pero ningún paquete cambia la identificación a account_roles o account_subtype, ni expone el flujo de efectivo como herramienta del agente.
- Columna de IEPS en xml_documents —sin ella la política tratamiento_ieps no puede tener consumidor, pese al criterio de cierre de E1.3— y las dos previsualizaciones de política faltantes (efirma_accion_anomalia, pac_ofrece_descarga).
- Higiene de la CLI, entera: guardia de stdin no-TTY en review/questions/outbox (que `skills drafts` ya tiene), extracción del bucle de cola interactiva triplicado, pruebas de renderBoard/renderPolicies/renderAll/renderMemory/renderDoctor y de shutdown(), un NO_DB_COMMANDS más fino para diagnosticar con la BD caída, y borrado/edición de jobs con validación de --max-failures (hoy parseInt sin validar deja pasar NaN al store).
- usage_hint declarado en MemoryEntry y nunca calculado por ninguna consulta, y caducidad/revisión periódica de las políticas de aprobación en modo 'always', que hoy no expiran.
- DIOT: generateDIOT vive en src/services/mexico/cfdi.ts, el archivo que E1.4-i borra rescatando 'sólo los catálogos SAT'. Ningún paquete lo re-hoga ni declara que se retira la capacidad.

## Riesgos del plan

- **El proyecto NO está bajo control de versiones (`git status` responde 'not a git repository'). Se pretende ejecutar 14 paquetes, ~130 tareas y ~85 semanas-persona sobre 41.847 líneas, con decenas de archivos compartidos entre paquetes, sin historial, sin ramas, sin revisión, sin poder revertir una remediación destructiva y sin poder tener CI: dos tareas del plan (E0.1-l y E0.2-l) escriben .github/workflows/ci.yml y no tienen dónde vivir.** — `git init`, repositorio remoto y CI vacía en verde ANTES de tocar código: es el paso cero absoluto, por delante incluso de los quick wins. Decidir en el mismo acto dónde vive la CI (decisión ya declarada en E0.1) y añadir un .gitignore que excluya node_modules, dist, files.zip y cualquier credencial fiscal. Sin esto el plan no es ejecutable en paralelo por más de una persona.
- **Colisión masiva de numeración de migraciones. Diez paquetes (E0.2, E0.3, E1.2, E1.3, E1.4, E2.1, E3.1, E3.2, E4.1, E4.2) declaran crear un archivo 031_*.sql y tres declaran 032_*.sql; ya hay cuatro números duplicados heredados (012, 014, 015, 018). El primer día de trabajo paralelo produce bases divergentes y migraciones que se aplican en orden distinto según la máquina.** — E0.2-k es la primerísima tarea del plan, antes que cualquier otra migración. Adoptar numeración por marca de tiempo (o un registro central de reservas con dueño único), la guarda en migrate.ts que rechaza duplicados, la huella en `mnemosine doctor` y el test migration-naming.spec.ts. Renumerar los nueve archivos duplicados en el mismo movimiento, mientras el histórico es pequeño y sólo hay una base desplegada.
- **Trabajo que se invalida por orden: E2.1 cambia la forma en que TODO el código obtiene su conexión (withTenant + rol mnemosine_app). Si E1, E3 y E4 se escriben antes contra pool.query() directo, son tres etapas de código nuevo —el grueso del plan— que hay que revisar archivo por archivo cuando llegue el perímetro, y cada omisión es un agujero de aislamiento entre inquilinos que la RLS ya no perdona.** — Adelantar E2.1-a (firma de runInTenant, S) y la decisión del rol de base de datos de E2.1-e a la etapa E0, y usar ese mismo rol en la suite de integración de E0.1-h. Prohibir en revisión cualquier consulta fuera de contexto de inquilino desde el día 1, aunque el middleware aún no esté montado. Coste: una tarea S adelantada; beneficio: no repasar tres etapas.
- **Trabajo duplicado con dueño ambiguo: E4.2-h y E5.1-e implementan LO MISMO (presupuesto y alerta sobre ai_usage); E0.1-l y E0.2-l escriben ambos .github/workflows/ci.yml; E1.1-b mueve account-roles-seed.ts mientras E1.4-e y E4.1-d lo editan; E1.2-a y E1.3-h editan ambos cfdi-decisions.ts; E1.3-d, E3.1-b y E3.2-c editan los tres fiscal-credentials/service.ts; E3.1-d y E1.4-i tocan ambos src/services/mexico/cfdi.ts, uno para usarlo y otro para retirarlo.** — Antes de arrancar cada etapa, publicar una tabla de dueño único por archivo compartido y resolver los solapes: el presupuesto de IA lo implementa E5.1-e y E4.2-h se reduce a registrar la tarea en el worker; el ci.yml lo crea E0.1-l y E0.2-l sólo le añade el paso de contrato; E1.1-b se cierra antes de que E1.4 y E4.1 empiecen; E1.3-h se secuencia después del núcleo de E1.2; E1.4-i se pospone hasta que E3.1-d haya rescatado lo que necesita de mexico/cfdi.ts.
- **Dependencia externa de terceros en la etapa E3: sin credenciales de sandbox de un PAC (Finkok) y sin un CSD y una e.firma de prueba del SAT, ni el timbrado real ni la descarga masiva se pueden probar, y el resultado sería otra simulación —exactamente lo que el paquete existe para eliminar. El plazo no depende del equipo.** — Iniciar el trámite del PAC y de los certificados de prueba durante la etapa E0, con dueño nombrado, tratándolo como hito de calendario y no como tarea. Tomar antes la decisión 'sellado con CSD propio vs. delegar al PAC' porque cambia qué credenciales hay que pedir. Plan B si el plazo se estira: entregar igualmente E3.1-a (cerrojo antisimulación) y E3.1-i, que impiden el daño —que se escriba un folio inventado como real— aunque el camino real aún no exista, y desplazar el resto de E3 detrás de E4.
- **Decisiones fiscales de fondo que, si se retrasan, invalidan trabajo ya hecho. El régimen del subsidio al empleo (tabular con entrega en efectivo vs. porcentaje fijo de UMA sin entrega) determina el cálculo de E4.1-i y las columnas de E4.1-h; el destino de la depreciación (D1 de E1.4) determina si E4.2-f existe; el runtime de tareas (bullmq+Redis —ambos ya están en package.json— vs. extender el patrón Postgres de ai_jobs, que ya existe en src/ai/jobs con job-store, wake-gate y runner) determina toda la arquitectura de E4.2.** — Cada decisión bloqueante tiene fecha límite igual a la fecha de inicio de su etapa menos una semana, y dueño nombrado. Las tres citadas se resuelven por escrito y con fuente (la del subsidio, con la referencia legal del ejercicio fiscal que el sistema va a calcular). Regla de desempate para el runtime: extender lo que ya existe salvo que alguien demuestre un requisito que Postgres no cubre; añadir Redis a la topología es un coste operativo permanente.
- **Remediaciones destructivas sobre datos ya escritos, concentradas en tres tareas: E1.2-h (reversas del histórico de CFDI PPD mal acreditados), E1.4-a (purga de secretos ya persistidos) y E3.2-i (corrección de facturas canceladas por el emisor). Si alguna se ejecuta mal, corrompe el mayor de una entidad viva y —hoy— sin rastro de quién lo hizo ni forma de revertirlo.** — Ninguna remediación se ejecuta antes de que E0.3 esté cerrada: la bitácora append-only es precondición, no complemento. Toda remediación se entrega con modo dry-run que produce el reporte del universo afectado, se ejecuta primero contra una copia de la base, exige respaldo verificado, y corrige exclusivamente por reversa —nunca por UPDATE— para que el error sea a su vez reversible.
- **Riesgo de despliegue del perímetro (E2.1): encender withTenant y cambiar al rol mnemosine_app puede dejar sin datos a los diecisiete routers a la vez si una política RLS está incompleta, y existe una ventana de migración a medias en la que la aplicación ya usa el rol restringido pero las políticas aún no están aplicadas.** — E2.1-j (orden de despliegue) se escribe y se ensaya ANTES de E2.1-b, no después. Desplegar en dos fases: primero crear rol y políticas y verificar con verify-isolation.sh ampliado a tablas hijas y vistas materializadas; sólo después cambiar la cadena de conexión de la aplicación, con arranque fail-closed y capacidad de volver al rol anterior sin migración inversa.
- **Escala del plan frente a su percepción: ≈85 semanas-persona en total, de las cuales ≈19 (más del 20%) son la etapa E0, que no entrega ninguna funcionalidad visible. Es el punto donde históricamente se recorta, y recortarlo deja al resto del plan sin forma de demostrar nada.** — Comprometer E0 como entregable con criterio de salida objetivo y medible (CI en verde, contrato fallando ante divergencias, cero duplicados de numeración) y comunicarlo así desde el inicio. Si hay que comprimir, el orden de recorte es E0.1-k primero (integración de cierre y concurrencia) y nunca E0.2-k ni E0.1-a/-h, que son los que sostienen todo lo demás.

---
---

# ESTADO DE ESTE PLAN · 2026-09-01

> Esta sección se añade al final a propósito: **el documento de arriba no se
> edita**. Es el registro de lo que se creía en su momento, y buena parte de lo
> que decía era cierto entonces y falso ahora. Lo que sigue dice cuánto de él
> sobrevive, quién heredó cada cosa, y qué nunca se dispuso.
>
> El estado **no se lee aquí**: se pregunta con `npm run plan:status` y
> `npm run catalogo:estado`. Este apéndice sólo reparte propiedad.

## Qué es hoy este documento

Las secciones **prospectivas** de este plan las sustituyó el Plan Maestro. Lo que
sigue vivo y sólo vive aquí son dos cosas:

1. **El inventario de las 147 tareas** (`E0.0-a` … `E5.1-k`), que es el censo más
   completo que se ha hecho de la deuda de este sistema.
2. **Los 24 cabos** de «Asuntos reales que ninguno de los paquetes cubre»
   (líneas 8204-8232), que hasta hoy nadie había dispuesto.

## La re-medición de las 147

Auditoría integral II, `HEAD 689458a`, informe
[cierre-cobertura](auditorias/2026-09-01-integral-ii/cierre-cobertura.md):

| Disposición | Auditoría I (2026-08-31) | Hoy | Δ |
|---|---:|---:|---:|
| HECHA | 83 | **97** | +14 |
| ABSORBIDA por una fase del Plan Maestro | 34 | **28** | −6 |
| PENDIENTE, con rojo en el tablero | 18 | **15** | −3 |
| PENDIENTE†, sin dueño | 4 | **4** | 0 |
| CAÍDA→RESCATADA, aún abierta | 8 | **3** | −5 |
| **Total** | 147 | **147** | — |

Catorce partidas cambiaron de estado y **todas resistieron la verificación**: no
hay ninguna que la prosa de un commit dé por hecha y el código desmienta.

## La clase peligrosa: absorbida por una fase que corrió y no la entregó

Una partida marcada ABSORBIDA se da por muerta cuando su fase se cierra. Si la
fase corre y no la entrega, la deuda desaparece del inventario sin haberse
pagado. La auditoría buscó exactamente eso y encontró tres:

- **`E1.2-i` · La documentación del agente.** Absorbida por F02; F02 corrió y el
  único `.md` que tocó fue el auto-generado. Los **trece** manuales que el agente
  lee siguen en la línea base de agosto — y dos de ellos no están
  desactualizados, están **equivocados**: `mexico-cfdi.md:5` le enseña el
  tratamiento de IVA que `iva-ppd-reclass.ts` existe para reparar, y
  `accounting.md:5` promete una anulación con auto-posteo que R1 y F01 hicieron
  imposible y que además violaría la regla «el agente propone, el humano
  dispone». Es la partida más peligrosa del inventario: su consumidor no es un
  humano que pueda dudar.
- **`E4.2-g` · Revalidación periódica del estatus CFDI.** F02 entregó el barrido
  y su puerta manual; **la periodicidad no existe** y su dueño real (el worker de
  la familia `job`) está en F09–F12.
- **`E3.2-i` · Corrección de facturas canceladas por el emisor.** F02 construyó
  el detector y no la respuesta: se sabe que un CFDI contabilizado fue cancelado,
  se escribe en la base, y no se hace nada. Después de F02 el riesgo **subió de
  categoría**: un dato de incumplimiento conocido y no atendido es peor que uno
  ignorado.

## Los 24 cabos, dispuestos por fin — partidas 148 a 171

«147/147» fue un conteo completo de **lo numerado** y un conteo incompleto **del
documento**. Los 24 cabos de la línea 8204 nunca entraron al inventario. Su
disposición, re-medida hoy:

| | |
|---|---:|
| **HECHA** por efecto colateral, sin que nadie los planificara | **6** |
| **MUTÓ** — dejó de reventar, la capacidad sigue ausente | **1** |
| **ABSORBIDA** — DIOT, que sí tiene dueño en F07 | **1** |
| **PENDIENTE, sin dueño** | **16** |

Los seis que cerraron solos: la serie del folio por fecha del documento (R3), la
reconciliación de `account_balances` (R1), la superficie CLI de `entry reverse` y
`entry void` (F01), el CSP fuera de producción y el CORS explícito, el consumidor
real de `tratamiento_ieps` (F02), y el `FOR UPDATE` en la ruta de pago de
facturas.

El que mutó: el parser de constancias de retenciones. Ya no revienta —F02 lo
rechaza con explicación— pero la capacidad sigue ausente. Rojo honesto, no cierre.

**Los dieciséis restantes no tienen fase.** Esa es la deuda que este apéndice
saca a la luz: hasta hoy no figuraban en ningún inventario, así que ningún
tablero podía ponerse rojo por ellos.

## Qué pasó con los «Riesgos del plan» de la última sección

El documento cierra con nueve riesgos escritos cuando el proyecto **no estaba
bajo control de versiones**. Su suerte:

- **«No está en git»** — resuelto. Hay repositorio, ramas, CI y revisión.
- **«Colisión masiva de numeración de migraciones»** — resuelto:
  `assertNumeracionUnica` en `src/database/migrate.ts` rechaza duplicados, y la
  cadena va por la 047 sin colisiones.
- **«Trabajo que se invalida por orden (E2.1 primero)»** — se cumplió el consejo:
  el perímetro llegó en R2, antes de las fases de flujo.
- **«Remediaciones destructivas»** — el consejo era «ninguna antes de que la
  bitácora append-only esté cerrada, y **exige respaldo verificado**». La
  bitácora se cerró; **el respaldo nunca se construyó**, y la auditoría II lo
  eleva a bloqueo de fase 1: hoy no hay una sola línea de respaldo o
  restauración en el árbol.
- **«Dependencia externa del PAC»** — sigue viva pero es **más pequeña de lo que
  se creía**: el único adaptador no simulado del repositorio ya está escrito y
  es inalcanzable por una línea que falta en el registro.
- **«Escala del plan: ≈19 semanas-persona de E0 que no entregan funcionalidad
  visible»** — el riesgo se materializó y se manejó bien: S0 se ejecutó entero.
  La re-medición del coste lo confirma desde otro ángulo: hoy **el 49 % de cada
  fila entregada es garantía**, no entrega.

## Una advertencia sobre este apéndice

La auditoría II encontró que la compuerta que debía impedir exactamente este tipo
de deriva —`FLUJOS_CERRADOS` en `src/plan/criterios.ts`, que exige registro de
auditoría antes de declarar cerrado un flujo— **está vacía**, con su único
renglón comentado. F01, F02 y A3–A4 se declararon hechos sin registro.

Este apéndice existe porque una auditoría lo buscó a mano. Que no haga falta
buscarlo a mano la próxima vez es trabajo del Plan Maestro v3.
