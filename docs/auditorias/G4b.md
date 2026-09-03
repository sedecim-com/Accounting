# Auditoría adversarial de G4b «El contrato que se pregunta, y la entrega que se reintenta»

**Objeto:** el commit del tramo G4b, segunda mitad de G4.
**Fecha:** 2026-09-02.
**Método:** dos agentes de motor → dos verificadores adversariales. El
adversarial escribió 19 ataques y confirmó **tres defectos de gravedad 2**, que
arregló, y nombró otros tres.

## Nota de procedencia, primero

**El motor de este tramo viajó dentro de un commit ajeno.** La sesión que
trabaja en paralelo en el Anexo 24 commiteó `9434dd6` («F07b: la balanza del
Anexo 24…», 55 archivos, 23 196 inserciones) y dentro iban `openapi.ts`,
`zod-a-json-schema.ts`, `barrido-entregas.ts`, `politica-reintento.ts`,
`webhook-sweep-command.ts` y `docs/openapi.json` — todo G4b, bajo un mensaje
que sólo habla de la balanza. No se puede deshacer sin reescribir historia
ajena; queda dicho aquí para que quien lea el registro sepa dónde buscar el
motor. Este commit trae el cierre: el registro en el binario, la fila del
catálogo, el criterio con sus mutantes y este documento.

## El contrato se pregunta, no se escribe

Había 50 esquemas Zod validando cuerpos y **ninguna especificación**: quien
integra leía el código o adivinaba. La decisión de CÓMO se tomó midiendo, que
es lo que se le pidió: se instrumentó `validateBody` para que el esquema
viajara colgado del manejador, se montó la superficie real y se recorrieron los
árboles. **44 esquemas raíz, 980 nodos, profundidad 9, y sólo 13 constructores
de Zod escritos a mano** — cero tuplas, intersecciones, uniones discriminadas,
`lazy`, fechas o literales. Con ese número la respuesta fue conversor propio, y
sin dependencia nueva.

Y la especificación **deriva del censo de G4a**: `censarRutas` ya recorre la
pila real de Express, así que el documento sale de preguntarle a la app y no de
una lista escrita al lado, que se desincroniza el primer martes. Publica
además lo que G4a estableció: la clase de riesgo de cada ruta y cuáles exigen
`Idempotency-Key`. Un contrato que no dice cuál de sus rutas es irreversible no
sirve para integrar con cuidado.

## Lo que el esquema llevaba años pidiendo

`webhook_deliveries` (003) traía `attempt_count`, `next_retry_at` **y hasta el
índice del barrido** — `idx_webhook_deliveries_retry ON (next_retry_at) WHERE
status = 'pending'`, un índice construido para una consulta que no existía.
`markFailed` escribía la columna y **nadie la leía**. O sea: el esquema estaba
preparado para reintentar desde hacía años, la fecha del próximo intento se
calculaba y se guardaba, y el reintento no ocurría nunca. Una caída de treinta
segundos del receptor perdía el evento para siempre, en silencio.

Y había un segundo muerto encima: `webhook_subscriptions.retry_config` —JSONB
con la política de reintento POR SUSCRIPCIÓN, desde la 003— tampoco lo leía
nadie.

## Los tres del adversarial

1. **La política de 12 intentos no le llegaba a ninguna suscripción.**
   `retry_config` es `NOT NULL DEFAULT '{"max_retries": 5, …}'` y `createWebhook`
   no escribía la columna, así que **toda** suscripción nacía con el 5 y la
   ventana de más de veinte horas que el módulo argumentaba no existía en
   producción: el `WEBHOOK_MAX_RETRIES=12` de la configuración era código
   muerto. Las filas anteriores conservan su 5 — rellenarlas pide migración, y
   eso no es de este frente.
2. **Un cuerpo que la especificación declaraba VÁLIDO, la ruta lo rechazaba.**
   `POST /v1/webhooks` publicaba `events` como cadenas libres y contestaba 422
   a cualquier evento fuera de la lista, porque la regla vivía DENTRO del
   manejador y el censo sólo ve lo colgado de `validateBody`. Se movió la lista
   al esquema, así que ahora viaja en el contrato. Hay **40 `throw new
   ValidationError`** así en 8 archivos: validar contra el `requestBody` no
   prueba que la petición se acepte, y eso quedó dicho en la propia
   especificación.
3. **`requestBody` ausente se leía como «no lleva cuerpo», y 17 rutas que mutan
   sí lo llevan.** El caso caro: `POST /v1/invoices/:id/cfdi/cancel` —declarada
   `externo`, cancela ante el PAC y el SAT— exige `cancellation_reason` y
   publicaba cero. **Un cliente generado de ese documento no podía cancelar un
   CFDI.**

## Lo reportado y NO hecho, con domicilio

- **`POST /v1/webhooks/:id/test` no entrega nada a nadie**: ignora el `:id` y
  despacha un evento que no está en la lista, así que la consulta devuelve
  siempre cero filas — y contesta `{"sent": true}` con un UUID inventado. Cómo
  debe comportarse es diseño de la familia de salida, no del verificador.
- **La entrega nunca intentada es invisible para siempre**: se inserta con
  `next_retry_at` nulo y el reclamo exige que no lo sea, así que un despliegue
  en esa ventana deja la fila donde ningún barrido la mirará. Adoptarlas obliga
  a decidir a partir de cuándo una entrega sin intentar se considera perdida:
  es bifurcación, no defecto.
- Trece de las 17 rutas sin `requestBody` están en `payroll.ts`, de la sesión
  paralela.

## Lo que costó el instrumento

Los dos mutantes del criterio sobrevivieron a la primera, cada uno por su
trampa: el de la especificación porque `censarRutas` aparece tres veces y una
sustitución local deja la cadena viva —se ancla la IMPORTACIÓN, no el nombre—,
y el del barrido porque el predicado de la fecha vencida aparece **tres veces**
(el reclamo, el conteo y el informe) y mutar una deja las otras dos en pie. Se
cuentan.

## Veredicto

G4b **cierra, y con él G4**. La API publica su contrato desde su propia verdad
y deja de perder lo que no pudo entregar. Lo único que queda de la tarjeta es
la decisión sobre GraphQL, que no es código: con el freno por inquilino y los
permisos que ya ganó, o entra al inventario o sale del árbol, y eso lo decide
el despacho.
