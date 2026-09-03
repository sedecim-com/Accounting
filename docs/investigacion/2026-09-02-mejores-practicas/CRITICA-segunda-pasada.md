# Crítica de completitud — segunda pasada, 2026-09-02 (tarde)

Este documento no resume las seis entregas. Las audita. Se escribió después de leerlas y **antes
de creerles**: cada afirmación que aquí se contradice o se confirma se comprobó contra el árbol de
trabajo (`/Users/victor/projects/Accounting-sux`, rama `docs/brechas-para-la-perfeccion`, HEAD
`637bad4`) o contra la fuente oficial, en la tarde del 2026-09-02.

**Sobre el contenido web:** ninguna de las páginas que consulté hoy traía texto dirigido a un
asistente. La pasada de la mañana anotó dos de AWS que sí; no volví a esas URLs. Todo lo que sigue
trata el contenido web como dato.

---

## 0. El veredicto, en una página

Las seis entregas son **buenas y están mal calibradas**. Verifiqué seis de sus afirmaciones más
cargadas y **las seis se sostienen** (§2.0) — eso es un porcentaje de acierto que la primera pasada
no tuvo. El problema no es la exactitud. Es el encuadre, y viene del encargo del dueño, no de los
agentes:

1. **El encargo fijó seis temas y ninguno es la contabilidad fiscal mexicana de un mes normal.** Hay
   un tema de PACs, uno de IA, uno de migración, uno de interfaz, uno de canales y uno experimental.
   No hay uno de nómina, ni de declaraciones, ni de la contabilidad electrónica que se *envía*. Los
   números lo dicen sin ambigüedad: en los seis documentos, «DIOT» aparece **0 veces**, «pago
   provisional» **0 veces**, «contabilidad electrónica» **1 vez** (y como formato de *importación*),
   «IMSS» **2 veces incidentales**, «no contador» **0 veces**.

2. **Nadie miró el módulo más grande del árbol.** `src/services/payroll/` tiene 31 archivos, timbra
   CFDI, calcula IMSS, INFONAVIT, ISR y finiquito — y aparece en la investigación sólo como nota al
   pie del router de PACs. En cuarenta minutos de lectura encontré ahí **cuatro defectos que ya
   producen cifras falsas hoy** (§1.1). Ninguna de las ~60 brechas de las seis listas es un defecto
   activo; todas son capacidad que falta. Eso invierte la prioridad de todo el conjunto.

3. **Cinco de seis agentes llegaron independientemente a la misma respuesta —«súbelo al panel de
   políticas»— y ninguno preguntó si el panel aguanta.** Entre los seis proponen crecer un
   cuestionario de 39 claves (verificado) en 40-50 %, antes de que nadie haya medido lo que cuesta
   contestar las 39 que ya hay (§2.5).

4. **Tres documentos declaran, cada uno por su lado, «una excepción explícita» a la misma invariante
   de autorización.** Tres excepciones a una regla dejan de ser excepciones (§3.1).

Y la respuesta a la pregunta que el dueño hizo: **«perfecto» es la pregunta equivocada**, y lo es
por una razón que el propio árbol demuestra, no por prudencia retórica. Está en §5.

---

## 1. Lo que no se miró

### 1.1 La nómina — el módulo más grande del árbol, y el único que ya emite cifras falsas

`src/services/payroll/` tiene submódulos `mx/` (IMSS, INFONAVIT, ISR, subsidio, SUA, finiquito,
CFDI de nómina), `usa/` (FICA, FIT, FUTA, W-2, W-3, 940, 941, NACHA, embargos), `common/`,
`tax-engine/` e `integrations/imss-idse-adapter.ts`. Timbra por el mismo `pacRouter` que las
facturas. **Ninguno de los seis documentos lo auditó.** `pacs.md` lo menciona cuatro veces, siempre
como consumidor del router; `tablero.md` tres, como pantalla futura.

Lo que hay dentro, con archivo y línea:

**(a) Todo el CFDI de nómina declara cero ingreso exento.**
`src/services/payroll/mx/cfdi-nomina-generator.ts:95` construye cada percepción con
`ImporteExento="0.00"` literal, y la línea `:124` cierra el bloque con
`TotalExento="0.00" TotalGravado="${totalPercepciones}"` — es decir, **el importe gravado es
siempre el total**. El art. 93 de la LISR (verificado hoy en el PDF oficial de la Cámara de
Diputados, https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf) exenta, entre otras: fracción I
tiempo extraordinario, VIII previsión social, XI fondos de ahorro, XIII primas de antigüedad e
indemnizaciones, y XIV —cito el texto oficial— gratificaciones «hasta el equivalente del salario
mínimo general del área geográfica del trabajador elevado a 30 días», más primas vacacionales y
PTU «hasta por el equivalente a 15 días de salario mínimo general […] por cada uno de los conceptos
señalados».

Consecuencia, y es la peor de todo este informe: el CFDI de nómina es la fuente con la que el SAT
prellena la declaración anual del trabajador. Un aguinaldo timbrado íntegramente como gravado
**sube la base anual de ISR de cada empleado** de un cliente del despacho. No es una brecha; es un
número equivocado que ya sale del edificio con folio fiscal encima. Ninguna brecha [XL] de las seis
listas tiene esta propiedad.

**(b) El tipo de nómina se decide con el apellido materno del empleado.**
`cfdi-nomina-generator.ts:113`:
`TipoNomina="${r.emp_second_last === 'EXTRAORDINARIA' ? 'E' : 'O'}"`.
`emp_second_last` es `employees.second_last_name` (véase el SELECT en `:55`). No existe ningún
camino para emitir una nómina extraordinaria —finiquito, aguinaldo, PTU— salvo que el apellido
materno del trabajador sea la cadena literal `EXTRAORDINARIA`. Es un marcador de prueba que se
quedó puesto.

**(c) Nueve valores fiscales quemados que un PAC real rechaza o que falsean el dato.**
Mismo archivo: `RegistroPatronal="B0000000000"` (`:117` — el registro patronal es por entidad y es
la llave de la liquidación del IMSS), `LugarExpedicion="00000"` (`:104`),
`DomicilioFiscalReceptor="00000"` (`:107`), `RegimenFiscal="601"` y `RegimenFiscalReceptor="605"`
(`:105-106`), `Antiguedad="P0W"` (`:119` — cero semanas para todo el mundo),
`PeriodicidadPago="04"` y `ClaveEntFed="MEX"` (`:123` — la entidad federativa determina el impuesto
sobre nóminas estatal), y el RFC genérico `XAXX010101000` como respaldo del emisor **y** del
receptor (`:105-106`). El respaldo de RFC del emisor es el más grave: un CFDI emitido a nombre de
`XAXX010101000` no identifica al patrón.

**(d) Los parámetros de 2026 son los de 2025.**
`src/database/migrations/009_tax_tables_2026.sql:36` se titula «Mexico 2026 (estimated UMA + IMSS
rates)» y siembra `"uma_daily": 113.14` (`:39`), `"salario_minimo_general_diario": 278.80` (`:42`) y
`"salario_minimo_frontera_diario": 419.88` (`:43`). Esos son los valores de 2025. El INEGI publicó
la UMA vigente desde el 1-feb-2026 en **117.31** diarios (comunicado 1/26; su PDF
https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2026/uma/uma2026.pdf **responde** pero
WebFetch no lo decodifica, así que la cifra viene de fuentes secundarias concordantes, no del
boletín leído). La CONASAMI fijó el salario mínimo 2026 en **315.04** general y **440.87** en la
Zona Libre de la Frontera Norte desde el 1-ene-2026: la página oficial
https://www.gob.mx/conasami/documentos/tabla-de-salarios-minimos-generales-y-profesionales-por-areas-geograficas
**responde y confirma** que existen «Salarios mínimos vigentes a partir del 01 de enero de 2026»,
pero las cifras viven en un PDF adjunto; el URL de adjunto que probé devolvió **HTTP 404**. Lo digo
así de crudo porque la regla de esta investigación lo exige: la vigencia está verificada en fuente
oficial, las cifras exactas no.

Consecuencia: la UMA gobierna el tope de 25 UMA del SBC (`imss-calculator.ts:63,111`,
`infonavit-calculator.ts:33,63`), el excedente de 3 UMA (`imss-calculator.ts:65,113`) y el tope del
finiquito (`finiquito-math.ts:200`). Con la UMA de 2025 sembrada como 2026, **toda cuota obrero-
patronal de un trabajador por encima del tope y todo finiquito de un salario alto salen mal**, todo
el año, sin que nada avise. Y los respaldos en código repiten el error: `|| 113.14` aparece
literalmente en `imss-calculator.ts:62,110` e `infonavit-calculator.ts:31,62`, y `|| 278.80` en
`infonavit-calculator.ts:61` — así que borrar la fila mala de la base no basta.

**(e) No existe el impuesto sobre nóminas estatal.** Cero referencias en el árbol. Es una
declaración mensual que presenta *todo* patrón mexicano, con tasa y calendario por estado.

### 1.2 La contabilidad electrónica que se ENVÍA

`onboarding.md` leyó el Anexo 24 como formato de **entrada** —«el formato de intercambio de facto»—
y ese hallazgo es bueno y correcto. Pero el Anexo 24 es, antes que nada, una **obligación de
salida**. Lo dice su primer párrafo, que extraje del PDF: «Para los efectos del artículo 28,
fracción IV del CFF, en relación con las reglas 1.4., fracción XXIV, 2.8.1.6., 2.8.1.7. y 2.8.1.10.,
se da a conocer la obligación de envío de contabilidad electrónica». Ocho apartados: A catálogo de
cuentas (con su código agrupador), B balanza de comprobación, C pólizas del periodo, D auxiliar de
folios de comprobantes fiscales, E auxiliares de cuenta y subcuenta, F catálogo de monedas, G
catálogo de bancos, H catálogo de métodos de pago.

En el árbol: **cero código.** No hay `src/services/e-accounting`, no hay XSD versionado, y —esto es
lo que ninguno de los seis notó— **no hay criterio**: `grep -in "contabilidad electr"
src/plan/criterios.ts` devuelve **0 resultados**. Es decir, el instrumento que mide el avance del
plan no sabe que esta obligación existe, así que su ausencia no puede ponerse roja.

Y sin embargo el diseño ya está escrito y detallado: `docs/cli-command-catalog.md:2056-2067` lleva
las doce filas de la familia `e-accounting`·`contabilidad-electronica` (`catalog match/apply/
generate/diff/file`, `balance generate/check/file`, `voucher generate`, `subledger generate`,
`acuse download`, `status`), todas marcadas «❌ hay que construirlo», con la nota de honestidad de
`:1863`: «las únicas transmisiones reales a la autoridad son `e-accounting catalog file` y
`e-accounting balance file`, y ambas son ✗ para la IA». `docs/plan-catalogo.md:145` la cuenta como
el flujo 7, diez filas, sin marca de estado.

O sea: el diseño existe, el catálogo lo enumera, el criterio no lo mide, y los seis documentos que
se escribieron para encontrar lo que falta no lo nombraron. **Un sistema contable mexicano que no
puede enviar su balanza mensual no es un sistema contable mexicano; es un mayor con adornos.**

### 1.3 Las declaraciones

Rastreo en el árbol, con palabra completa: `coeficiente` de utilidad → 0. `cufin` → 0. `cuca` → 0.
`ajuste anual por inflación` → 0. `PTU` → 0. `reparto de utilidades` → 0. `reserva legal` → sólo
como pregunta en `pending-catalog.ts`. `DIOT` → sólo prosa en `vendor-service.ts:24,227` y
`vendor-command.ts:108,178,347`, donde sirve para listar proveedores sin RFC.

El catálogo declara la frontera con honestidad (`cli-command-catalog.md:1863`: «este catálogo **no
incluye ningún comando que presente una declaración de impuestos ante el SAT**; `filing record`
registra que un humano ya la presentó»). Esa es una decisión de alcance defendible. Lo que **nadie
en los seis** planteó es la pregunta comercial que la acompaña: un despacho no compra por lo que el
sistema registra, compra por lo que le calcula. Hoy no calcula ninguna de las cifras que efectiva-
mente presenta cada mes y cada marzo.

Dato de deriva que además envejece cualquier diseño previo de DIOT: desde el **1-ago-2025** el SAT
sólo acepta la DIOT por la nueva plataforma electrónica. Cualquier layout `.txt` heredado del
esquema anterior está muerto. (Fuente: varias secundarias concordantes; la página del SAT
`wwwmat.sat.gob.mx/declaracion/74295/...` aparece en el buscador y no la abrí.)

### 1.4 El papel de trabajo que se entrega en una revisión

`onboarding.md` lo toca dos veces, y sólo para la migración («diffTrialBalance no deja constancia
[S]»). El hueco grande es otro: cuando llega un requerimiento o una revisión electrónica (art. 53-B
CFF), el despacho entrega un **paquete definido** —balanza del periodo, auxiliares, pólizas con
UUID, los CFDI, los acuses— y hoy los ingredientes están dispersos sin un acto que los junte,
congele y deje constancia de qué se entregó y cuándo. En el árbol: `compulsa` → 0, `requerimiento`
→ 1 coincidencia no relacionada. Lo notable es que **este repositorio es excepcionalmente bueno en
lo que hace falta para eso** (bitácora append-only, la instantánea sellada de la 055, la tolerancia
persistida) y nadie propuso el acto que lo cosecha.

### 1.5 Dos ejercicios abiertos a la vez

El esquema lo permite: `001_core_schema.sql:180-191` da `fiscal_years` con
`status IN ('open','closed')` y `UNIQUE(entity_id, year_number)`; `:193-212` da `fiscal_periods` con
cinco estados. Lo que ninguno de los seis planteó es el problema **operativo** que un despacho vive
cada marzo: 2025 sigue abierto esperando la anual y la asamblea, 2026 se está posteando a diario, y
un ajuste de 2025 tiene que **volver a fluir** al saldo inicial de 2026 sin reescribir el cierre.
`onboarding.md` rozó el borde —su contradicción entre `onboarding.cuenta_puente` y
`destino_del_resultado_del_ejercicio`— pero la enmarcó como asunto de migración, que es una vez, en
vez de como asunto de convivencia de ejercicios, que es todos los años.

### 1.6 El usuario que no es contador (y el que no lee inglés)

«no contador» aparece **0 veces** en los seis. `tablero.md` es el único que se acerca, con 11
menciones de i18n, y su propuesta es un catálogo i18next **generado de `vocabulary.ts`** — es decir,
las etiquetas de comando (142 líneas de verbos). El corpus de mensajes es otro animal y hoy está
partido por la mitad sin regla: `fiscal-credentials/service.ts` lanza `'There is no active e.firma
for this entity. Upload it with: mnemosine sat cred add'` mientras `pac/simulacion.ts:55` explica en
castellano. No hay `i18n`, no hay `locale`, no hay conmutador; lo único es
`toLocaleString('es-MX')` para formatear números (`cli/kernel/output.ts:155`). **El producto es
bilingüe por accidente**: cada mensaje habla el idioma del autor de esa línea. Un catálogo generado
de los verbos no arregla eso, y `tablero.md` lo presenta como si lo arreglara.

---

## 2. Qué afirmación no se sostiene

### 2.0 Primero, lo que sí se sostiene (seis comprobaciones, seis aciertos)

Lo digo antes que las objeciones porque es información y porque calibra lo que sigue:

| Afirmación | De | Cómo la comprobé | Resultado |
|---|---|---|---|
| `gpt-5.1` ya no lo lista OpenAI; la familia es GPT-5.6 | ia.md | WebFetch a developers.openai.com/api/docs/models | **Se sostiene.** La página lista `gpt-5.6-sol/terra/luna/cyber`, ningún `gpt-5.1`, ventana 1.05M |
| La Cloud API no admite `application/xml` ni `text/xml` como documento | canales.md | WebFetch a la referencia de medios de Meta | **Se sostiene.** La tabla es txt/xls/xlsx/doc/docx/ppt/pptx/pdf y nada más |
| zod es 3.25.76 y `zod/v4.toJSONSchema` ya es función | tablero.md | Ejecutado en el worktree | **Se sostiene.** `zod 3.25.76`, `typeof … === 'function'` |
| El publicador sella `total` y publica `rounded`, y sobrescribe con `ON CONFLICT DO UPDATE` | experimental.md | Lectura de `orchestrator.ts:445-452` y del INSERT | **Se sostiene, literal** |
| El Anexo 24 RMF 2026 vive en un HTTPS que responde y trae el catálogo entero | onboarding.md | Descargué el PDF (610 KB, 37 pp., DOF 13-ene-2026) y conté | **Se sostiene y lo afino:** 139 códigos de nivel 1 + 932 de nivel 2 = **1 066 renglones exactos**. La cifra de onboarding.md (1 066) es exacta; la de experimental.md (~1 067) sobra por uno |
| El panel tiene 39 claves | pacs.md, onboarding.md, experimental.md | `grep -cE "^\s*key: '"` sobre `pending-catalog.ts` | **Se sostiene: 39** |

### 2.1 `pacs.md` diagnostica bien el sellador y mal la nómina, y la diferencia invierte el orden de trabajo

`pacs.md` escribe: «La nomina timbra por el router (cfdi-nomina-generator.ts:136) y hereda el mismo
hueco». **Medio falso, y el medio que falla importa.** El XML de nómina no es el muñón de cuatro
atributos que arma `invoices.ts:250-253`. Lleva `Emisor`, `Receptor`, `Conceptos`, `Complemento`
con `nomina12:Nomina`, `Percepciones` y `Deducciones` completos (`cfdi-nomina-generator.ts:99-134`).
Le falta **exactamente y sólo**: `Serie`, `NoCertificado`, `Certificado`, `Sello` y una cadena
original de verdad.

Por qué importa el matiz: sellar el muñón de `invoices.ts` produce un CFDI **rechazado** —el PAC lo
tira y nadie se hace daño. Sellar el XML de nómina produce un CFDI **aceptado y equivocado** (por
el `ImporteExento="0.00"` de §1.1a), que se va al SAT, entra al prellenado del trabajador y sólo se
corrige cancelando y resustituyendo. `pacs.md` presenta la nómina como el caso derivado y fácil
cuando es el caso peligroso, y su Tramo implícito —«construir el sellador»— apuntado a la nómina sin
corregir antes el exento **acelera el daño en vez de repararlo**. El orden correcto es: exento
primero, sellador después.

### 2.2 `pacs.md` acierta la conclusión sobre la bóveda por la razón equivocada, y la razón verdadera es peor

Escribe: «Toda la regla de la boveda —el eje de esta investigacion desde agosto— hoy no protege nada
porque no hay firma que hacer».

Comprobado: **la bóveda no tiene consumidor de producción, y no es porque falte el sellador.**
`withCredential` (`src/services/fiscal-credentials/service.ts:207`) es el único camino auditado a la
e.firma. Sus únicos invocadores en todo el árbol son `tests/fiscal-credentials/service.spec.ts` y
una mención en `tests/integrations/sovos-reachcore-adapter.spec.ts:235`. **Cero en `src/`.** Dos
archivos de producción se desvían explícitamente para decir que *no* pasan por ahí
(`src/config/index.ts:151`, `src/services/sat/cfdi-status.ts:11`). Y `privateKeyToPem`
(`certificate.ts:137`, comentado «Key as PEM, ready for signing (XML-DSig of the SAT token)») lo
llama sólo `tests/fiscal-credentials/certificate.spec.ts:58`.

Es decir: la bóveda no está esperando un sellador de CFDI. **Nunca se conectó a nada**, ni siquiera
a la firma del token del SAT que su propio comentario nombra. Es capacidad huérfana de punta a
punta.

Y hay un corolario que muerde al instrumento: la casa tiene un detector de capacidad huérfana
(`src/ai/orphan-scan.ts`, consumido en `doctor-service.ts:716`) y **no lo cazó**, porque el símbolo
sí tiene consumidores… en `tests/`. El detector de huecos comparte el punto ciego de los seis
agentes: un módulo con pruebas excelentes y ningún llamador parece vivo. Eso es una brecha del
instrumento, no de un tramo, y por eso vale más que varias de las [M] de las listas.

### 2.3 `ia.md` plantea bien la residencia y la deja inaccionable

`ia.md` concluye —correctamente— que no hay residencia de datos en México en ninguna nube, que el
único perfil que cumple si los XML no pueden salir del país es `ollama`, y que el `init` debe
preguntarlo. El problema es el alcance: **la misma respuesta prohíbe todo `canales.md`.** WhatsApp
Cloud API (Meta), Slack, Telegram y SES/Postmark son todos procesadores estadounidenses. Un
despacho que conteste «no» se queda sin nueve de doce perfiles de modelo **y sin ningún canal**, y
ni `ia.md` ni `canales.md` se lo dicen. Una pregunta de `init` cuya respuesta «no» deja al producto
sin funciones que nadie ha diseñado no es una recomendación: es una trampa. Véase §3.3.

### 2.4 `onboarding.md` cita como doctrina de competidor algo que hoy no se puede releer

Su sección de Xero descansa en cinco URLs de Xero Central que —el propio documento lo declara con
honestidad— hoy devuelven documento vacío por WebFetch, incluidas dos que la mañana dio por
verificadas. La declaración es correcta y ejemplar. La **conclusión** no se ajustó: la doctrina
«corte a primero de mes, día siguiente al cuadre, sólo documentos impagos» sigue redactada como
práctica acreditada de Xero, y de ahí pasó ya a `docs/wiki/Onboarding-de-contabilidad.md`. Regla que
propongo y que este caso justifica: **una afirmación cuya fuente dejó de rendir se degrada a
«criterio nuestro» en el mismo commit en que se declara muerta la liga**, o desaparece. Si no, la
wiki acumula autoridad prestada de páginas que ya no existen.

### 2.5 Las «39 claves» son ciertas y la inferencia que tres documentos sacan de ellas es floja

Confirmé las 39. Pero `pacs.md`, `onboarding.md` y `experimental.md` leen cada uno «39 claves y
ninguna de lo mío» como prueba de que *su* tema fue desatendido. Sumados, los seis proponen añadir:
`pac_preferences` migrado al panel (pacs), cinco claves `onboarding.*` (onboarding), lo vivo de
`disclosure_config` (experimental), la constancia NOM-151 y el consentimiento por persona (canales),
y presupuesto + residencia (ia). Eso es un crecimiento del 40-50 % de un cuestionario **cuya
longitud nadie midió**.

Nadie preguntó: ¿cuánto tarda un despacho en contestar 39 preguntas antes de postear su primer
asiento? ¿Cuántas de las 39 tienen un default defendible y cuántas exigen decisión? ¿Qué pasa
cuando son 60? «Al panel» es la respuesta ambiental de la casa a toda bifurcación de criterio, y
**cinco de seis agentes la alcanzaron por separado sin que uno solo cuestionara su escalabilidad**.
Eso no es un fallo de un documento: es un fallo metodológico de la pasada, y es exactamente la clase
de cosa que seis agentes en paralelo producen y ninguno detecta.

---

## 3. Dónde se contradicen entre sí

### 3.1 Tres excepciones a una sola invariante de autorización — la más grave

- `tablero.md`: la cartera del despacho exige «un endpoint que **NO lea `x-entity-id`** y recorra
  `payload.entities` dentro del SQL, **declarado como excepción explícita** a la invariante de
  `auth.ts`».
- `experimental.md`: el experimento exige lectores **anónimos** en `/public/v1` (ya existen:
  `public-verification.ts:246,368`) más un acceso nominal tipo data room, separados.
- `canales.md`: una sesión de canal no tiene stdin, no trae cabecera de entidad de un navegador, y
  «declara su superficie de herramientas explícitamente y queda bajo el cerrojo desatendido».

La regla de la casa es «una petición actúa sobre UNA entidad». Cada documento pide su excepción y
ninguno sabe de las otras dos. **Tres excepciones a una invariante no son tres excepciones: son la
desaparición de la invariante**, y peor, desaparecida en tres commits distintos que ninguna revisión
verá juntos.

Lo que nadie propuso, y es la única salida que sostiene las tres: **un alcance tipado en la
petición** —una entidad · una cartera nombrada · público anónimo— que consuman tanto RLS como los
routers, de modo que los tres casos sean *casos de una regla* en vez de tres agujeros. Es
prerequisito de tres tramos y no está en ninguna de las seis listas.

### 3.2 Dos contratos de salida, y cuatro tramos que no eligen cuál hablan

`tablero.md` lo diagnostica con precisión —S-UX le dio al CLI `SCHEMA_VERSION=1` («el dinero nunca
es número JSON», «la truncación siempre se reporta») frente a ocho routers de `/v1` que copian su
propio `meta` y nueve que no envuelven nada— y luego lo trata como problema *suyo*. No lo es.
`onboarding.md` (puerta de carga), `pacs.md` (`PacProviderSpec`), `experimental.md` (auditar el
publicador) y la familia `e-accounting` entera —diseñada CLI-first en
`cli-command-catalog.md:2056-2067`— aterrizan cada uno en una superficie distinta sin decir qué
sobre emiten. Alguien tiene que decidir **una vez** si `/v1` adopta el sobre del CLI o si el CLI se
vuelve cliente de `/v1`. Mientras no se decida, cada capacidad nueva se construye dos veces, y las
doce filas de `e-accounting` son las próximas doce.

### 3.3 La residencia de datos contra los canales

`ia.md`: si los XML no pueden salir del país, el único perfil que cumple es `ollama`, y el `init`
debe preguntarlo. `canales.md`: WhatsApp/Slack/Telegram llevan la conversación, el correo (SES o
Postmark) lleva los CFDI, y su marco legal es atribución (CCom 90 y 90 bis), conservación (CCom 49 +
NOM-151) y **consentimiento expreso para datos patrimoniales bajo la nueva LFPDPPP**. Y ahí está la
grieta: `canales.md` exige el consentimiento y **nunca pregunta si enrutar datos fiscales de un
cliente por un procesador estadounidense es compatible con el consentimiento que exige**. Los dos
documentos contestan distinto a la misma pregunta y ninguno nota que se contradicen.

### 3.4 El código agrupador tiene tres pretendientes y ningún dueño

- `onboarding.md` lo quiere para importar el catálogo con `CodAgrup` de un golpe.
- `experimental.md` lo quiere como **corte público**, en sustitución de `account_level`.
- `cli-command-catalog.md:2056-2058` (`e-accounting catalog match/apply/generate`) lo quiere para
  presentar el catálogo ante el SAT.

Los tres necesitan **el mismo artefacto**: la tabla de 1 066 renglones que extraje hoy del PDF del
Anexo 24, cargada una vez, más la consolidación de las dos columnas (`mx_nif_code` tiene lectores y
escritores; `codigo_agrupador_sat` sigue con cero referencias en TypeScript, sólo la 037). Ninguno
reclama la propiedad y dos proponen su propio camino de carga. **Es el prerequisito más barato de
toda la pasada y va camino de construirse dos veces.**

### 3.5 El default de PACs vive en tres sitios y uno de ellos es un comentario

`pacs.md` pide retirar `edicom` de los defaults (`pac-router.ts:68-73`, repetido en el COALESCE de
`savePreferences` en `:93-95`). Falta el tercero:
`cfdi-nomina-generator.ts:136` lo lleva escrito en prosa — «reuses existing integration — failover
Finkok → SW Sapien → Edicom». Un comentario que documenta un default se convierte en mentira el día
que el default cambia, y es el único de los tres que ninguna prueba puede sujetar.

---

## 4. Las brechas, ordenadas por consecuencia

El criterio de orden no es tamaño ni tema. Es este, y va explícito porque cambia el resultado:
**primero lo que hoy produce una cifra falsa, después lo que bloquea a otras cosas, después lo que
impide operar el mes, después lo que impide cerrar el año, y al final lo grande que no bloquea a
nadie.**

### Nivel 0 — Ya está mal. No son brechas, son defectos corriendo

Ninguna de las ~60 brechas de las seis listas está en este nivel. Las cuatro que siguen sí.

| # | Qué | Dónde | Talla del arreglo |
|---|---|---|---|
| 0.1 | Todo CFDI de nómina declara `ImporteExento="0.00"` y `TotalExento="0.00"` | `cfdi-nomina-generator.ts:95,124` | **S** de arreglo, **XL** de consecuencia |
| 0.2 | UMA y salario mínimo de 2025 sembrados como 2026, con respaldos quemados en cuatro archivos | `009_tax_tables_2026.sql:39,42,43`; `imss-calculator.ts:62,110`; `infonavit-calculator.ts:31,61,62` | **S** |
| 0.3 | `TipoNomina` se decide con el apellido materno | `cfdi-nomina-generator.ts:113` | **S** |
| 0.4 | El publicador de agregados: sella `total` y publica `rounded`, en **float** (`parseFloat` + `Math.round`), signo invertido en ingresos y pasivos, descarte silencioso bajo el mínimo, y `ON CONFLICT DO UPDATE` que sobrescribe la cifra publicada en su sitio | `orchestrator.ts:445-452` y su INSERT | **M** |

Sobre 0.4 añado lo que `experimental.md` no dijo teniendo razón en los otros cuatro puntos: la
aritmética de la única cifra que un tercero llega a ver está hecha en **coma flotante**, en un
repositorio que embarca `decimal.js` y cuya propia doctrina de salida es «el dinero nunca es número
JSON».

### Nivel 1 — Prerequisitos. Cada uno desbloquea varios de los de abajo

| # | Qué | Desbloquea a | Talla |
|---|---|---|---|
| 1.1 | Cargar `c_CodAgrup` una vez (ya está extraído y contado: 139 + 932 = 1 066) y consolidar las dos columnas del agrupador | onboarding capa 1 · corte público de X · `e-accounting catalog` **(3)** | **S** |
| 1.2 | Alcance tipado de la petición (entidad · cartera · público) en vez de tres excepciones a `auth.ts` | cartera del tablero · `/public/v1` del experimento · sesión de canal **(3)** | **M** |
| 1.3 | Un solo sobre de salida entre CLI y `/v1` | tablero entero · e-accounting · puerta de migración · `PacProviderSpec` **(4)** | **L** |
| 1.4 | El sellador de CFDI: cadena original, `Sello`, `NoCertificado`, `Certificado`, sobre `withCredential` | facturación · nómina timbrada de verdad · cancelación firmada · REP · y convierte la bóveda en capacidad **(5)** | **XL** |
| 1.5 | Darle a `withCredential` su primer consumidor de producción, y enseñar a `orphan-scan` que consumo-sólo-en-tests no es consumo | toda transmisión a la autoridad · el propio detector de huecos **(2)** | **S** tras 1.4 |

**Orden forzoso dentro del nivel 1:** 0.1 va **antes** que 1.4. Sellar la nómina antes de corregir el
exento no arregla nada; multiplica un documento aceptado y equivocado.

### Nivel 2 — Sin esto un despacho mexicano no opera el mes

2.1 Contabilidad electrónica de salida completa: catálogo, balanza mensual, pólizas, auxiliares,
acuse, con sus XSD versionados dentro del repositorio porque `omawww.sat.gob.mx` no responde **[XL]**
· 2.2 Descarga masiva del SAT — ya en rojo honesto en `criterios.ts:2341`; sin ella el despacho no
puede afirmar completitud, que es lo que vende **[L]** · 2.3 Cancelación de CFDI completa, con acuse
archivado y la máquina de tres días **[L]** · 2.4 El REP como emisión, con el plazo del quinto día
natural **[L]** · 2.5 Failover de PAC que no produzca dos folios: consultar al primero antes de
reenviar (la RMF 2026 hace la deduplicación *por PAC*) — prerequisito de cualquier facturación
desatendida **[M]** · 2.6 Buzón tributario y su reloj de tres días del art. 17-K CFF **[L]** · 2.7
Nómina: el resto de §1.1c, y el impuesto sobre nóminas estatal **[M]**.

### Nivel 3 — Sin esto no se cierra el año

3.1 Estado de variaciones en el capital contable — **falta y nadie lo notó**: `experimental.md`
cazó las notas del art. 172 LGSM pero no este, y `report-service.ts` tiene balanza, balance,
resultados, mayor y antigüedad de saldos, ninguno de variaciones en el capital **[M]** · 3.2 Las
notas a los estados financieros **[L]** · 3.3 Pagos provisionales, coeficiente de utilidad, ajuste
anual por inflación, CUFIN, CUCA, PTU y reserva legal — cero en el árbol y cero en los seis **[XL]**
· 3.4 Dos ejercicios abiertos con reflujo del ajuste al saldo inicial del siguiente **[M]** · 3.5 El
paquete de revisión: el acto que junta, congela y deja constancia de lo que se entregó **[M]**.

### Nivel 4 — El resto, agrupado

CxC/CxP documento a documento (las tablas ya llegaron con la 049/050, falta la puerta) · depreciación
acumulada de activos migrados · deshacer una migración · el lote de cuarenta clientes · la retícula
de captura de pólizas · el cierre de mes guiado · `tokens.css` derivado de `palette.ts`/`risk.ts`/
`exit.ts` · hoja de impresión · precios de IA y los cinco perfiles sin precio · el detector de deriva
de modelo · el cuerpo del webhook en `ai_webhook_deliveries` · el `CHECK` de `send_message` ·
`canal_vinculos` y el consentimiento · i18n de verdad (§1.6).

### Lo grande que no bloquea a nadie y debería esperar

**La aritmética del grupo** [XL, experimental.md] y **el cierre de mes como proceso guiado** [XL,
tablero.md]. Ambos son buenos y ambos van detrás de 1.2 y 1.3. Y una recomendación más dura: **el
tramo experimental debería pausarse, no extenderse.** Su propio agente concluyó que X2 «no es obra
nueva: es auditoría», y hoy el módulo publica a terceros una cifra en float que puede sobrescribirse
en su sitio. Publicar hacia afuera antes de que exista el sellador y la contabilidad electrónica es
hacer la undécima cosa antes que la primera.

---

## 5. La pregunta honesta: ¿sería perfecto?

No. Y sostengo algo más incómodo: **«perfecto» es la pregunta equivocada para este sistema**, no por
modestia sino por una razón que el propio árbol acaba de demostrar en §1.1d.

**Primero.** La corrección de un sistema contable no es una propiedad del código. Es una propiedad
del par (código, ley fiscal del año). La UMA cambia cada 1 de febrero. El salario mínimo cada 1 de
enero. Las tarifas del art. 96 cuando el Congreso quiere. La RMF cada diciembre, con su Anexo 24 en
enero. La versión del CFDI cuando el SAT decide. La DIOT cambió de plataforma en agosto de 2025 sin
avisarle a nadie. **La mitad de los defectos que encontré hoy no son errores: es código que era
correcto en 2025.** De modo que la meta alcanzable no es la perfección, es un **tiempo-a-la-verdad
corto**: cuántos días pasan entre que una regla cambia y el sistema se lo dice a su usuario en voz
alta.

Hoy ese número no tiene tope, y hay un motivo estructural concreto: `tax_parameters`
(`008_payroll.sql:375`) se indexa por `tax_year` y **no tiene vigencia**. La UMA cambia el 1 de
febrero, no el 1 de enero: una fila por año **no puede ni siquiera expresar** el dato correcto.
Ese —una columna de vigencia con fecha, un aviso cuando un parámetro vigente venció, y un criterio
que lo mida— es el cambio de diseño que haría más por la corrección que cualquier tramo de las seis
listas, y no está en ninguna.

**Segundo.** La propiedad más valiosa de este sistema en un despacho mexicano no es tener razón: es
ser **defendible**. Cuando el SAT discrepa, el despacho no necesita haber acertado; necesita poder
mostrar qué hizo, cuándo, por instrucción de quién y con qué regla vigente. Y resulta que este
repositorio es inusualmente bueno justo en eso —`audit_log` append-only, la instantánea sellada con
hash de la 055, la tolerancia persistida porque sin ella la instantánea mentía, los criterios en
rojo honesto, `simulado` que jamás se persiste como timbrado. **Esa es su tesis real y ninguno de
los seis documentos la nombró.** Todo tramo debería juzgarse por si fortalece o diluye eso; y por
esa vara, el publicador de agregados es lo peor del árbol: no por estar mal, sino por ser la única
cifra que un tercero ve y a la vez la única que se puede sobrescribir en silencio.

**Tercero, y es el que menos gusta.** Aun cerradas las sesenta y tantas brechas, el sistema no sería
usable por un despacho, porque **nadie lo ha probado contra el año real de un cliente real**. Cada
número de estos seis documentos es un hecho del repositorio o un hecho de la web. **Cero son un
hecho sobre un despacho.** 121 ligas verificadas y sesenta brechas nombradas no equivalen a un
ejercicio 2026 cerrado y presentado. La distancia entre ambas cosas no aparece en ninguna de las
seis listas y es más grande que todas ellas juntas.

Así que la pregunta que yo le devolvería al dueño no es «¿qué falta para ser perfecto?» sino estas
tres, en orden:

1. **¿Qué cifra falsa está saliendo hoy del edificio?** (Respuesta de esta tarde: cuatro. Nivel 0.
   Ninguna estaba en las seis listas.)
2. **¿Cuánto tarda el sistema en enterarse de que una regla cambió?** (Hoy: nunca, por diseño de
   esquema.)
3. **¿Qué es lo primero que el sistema tendría que hacer bien de punta a punta para un cliente real,
   una vez?** (Y hacerlo, en vez de ampliar la superficie.)

Un informe que dijera que las seis entregas están bien no valdría nada. Están bien **hechas**: seis
de seis afirmaciones cargadas resistieron mi comprobación, y eso es raro. Lo que está mal es lo que
las seis, juntas, dejaron fuera del encuadre — y lo que dejaron fuera es la contabilidad fiscal
mexicana de un mes normal.
