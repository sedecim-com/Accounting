# Auditoría integral II · 2026-09-01 · HEAD `689458a`

Doce lentes sobre el árbol completo, cada hallazgo mayor sometido a un escéptico
con el encargo de refutarlo. **Ninguno de los nueve se cayó.**

El árbol se movió durante la auditoría: empezó en `a149e62` y terminó en
`689458a` — A3–A4 se comprometió (`1ff9ca8`) mientras los lentes medían. Por eso
hay tres informes suplementarios que re-miden la capa de agente y el instrumento
sobre la cabeza nueva. Cada afirmación lleva `archivo:línea` verificado.

| Informe | Lente | Hallazgo mayor |
|---|---|---|
| [maestro-vs-codigo](maestro-vs-codigo.md) | El plan contra el código, afirmación por afirmación | **Las dos compuertas que §7 declara «ahora con mecanismo» están inertes**: `FLUJOS_CERRADOS` está vacío y el meta-criterio de espejos no existe |
| [cierre-cobertura](cierre-cobertura.md) | Herencia del plan de cierre (147 partidas) | La documentación del agente se dio por ABSORBIDA por F02; F02 corrió y no la entregó — y ese doc le enseña al agente el IVA que otro módulo existe para reparar |
| [doce-cobertura](doce-cobertura.md) | El modelo de costes y la velocidad real | El modelo acierta el TOTAL (389,6 medidas contra 390) y se equivoca en la composición; y su instrumento imprime 0,7 % de cola correctiva donde lo honesto da 11,8–51,7 % |
| [practicas-ledger](practicas-ledger.md) | Núcleo contable contra las mejores prácticas | `ledger check --check balance` es **ciego a `ending_balance`**: le inyectaron 99 999 de deriva y devolvió cero hallazgos |
| [practicas-fiscal-mx](practicas-fiscal-mx.md) | Cumplimiento fiscal mexicano | El único PAC **no simulado** del repositorio es inalcanzable por una línea que falta en el registro |
| [agentic-ai-first](agentic-ai-first.md) | Estado del agente y AI-first | El piso de evidencia de la sombra guarda **una de las tres puertas** al auto-posteo |
| [seguridad-multitenant](seguridad-multitenant.md) | Seguridad, multi-inquilino y credenciales | El DML de migración bajo RLS forzada **rellena cero filas en silencio** — probado, y alcanza a tres migraciones que el repo cree aplicadas |
| [instrumento](instrumento.md) | ¿El tablero mide lo que importa? | El trinquete es de granularidad **paquete**: 16 criterios verdes viven en paquetes rojos y ningún commit puede ponerlos en rojo |
| [producto-y-operacion](producto-y-operacion.md) | De proyecto a producto | **No existe respaldo ni restauración** — cero líneas en todo el árbol |
| [a3a4-entregado](a3a4-entregado.md) | ¿A3–A4 entregó lo que su tarjeta afirma? | 15 afirmaciones: 9 verdaderas, 5 parciales, 0 falsas — y el archivo del operador enciende el auto-posteo sin peaje |
| [agentic-ii](agentic-ii.md) | Las 12 brechas de la auditoría I, re-medidas | 8 cerradas · 4 vivas · 9 nuevas |
| [instrumento-ii](instrumento-ii.md) | El instrumento sobre la cabeza nueva | **66 de 69 criterios son regex sobre el fuente**, no conducta |

**Aritmética de la auditoría: 70 brechas cerradas · 104 siguen abiertas · 110 nuevas.**
Que aparezcan 110 nuevas con 70 cerradas no es un retroceso: es lo que pasa
cuando doce lentes miran más hondo que siete y el sistema tiene más superficie
que auditar. Lo que importa es la forma de las nuevas, y tienen forma.

---

## Los cinco temas, en orden de consecuencia

### 1 · El instrumento no se mide a sí mismo (la meta-brecha)

Todo el gobierno de este proyecto descansa en que el tablero diga la verdad. La
auditoría encontró que el instrumento tiene los mismos vicios que persigue:

- **`FLUJOS_CERRADOS` está vacío** (`src/plan/criterios.ts:243-245`, su único
  renglón comentado). §7 promete que «un flujo no entra a `--exigir` sin su
  registro en `docs/auditorias/`». El criterio itera un objeto vacío, así que
  siempre da verde. **F01, F02 y A3–A4 se declararon hechos y E1.2/E1.3 entraron
  al trinquete sin un solo registro.**
- **El trinquete es de granularidad PAQUETE, no criterio.** 16 criterios verdes
  viven dentro de paquetes rojos y ningún commit puede ponerlos en rojo — entre
  ellos «Ninguna herramienta del agente alcanza el mayor», que es la regla (b)
  de la casa. Verificado: la línea literal de CI sale `exit=0` con tres
  criterios de E5.1 en rojo vivo.
- **66 de 69 criterios son regex sobre el fuente**, no sobre la conducta. El
  único que declara `necesita: 'base-de-datos'` no ha juzgado nada nunca: en CI
  el job corre sin Postgres, y con base vacía devuelve verde por no mirar.
- **El «meta-criterio que cuenta criterios sin espejo» no existe.** `tests/plan/`
  no contiene un solo mutante.
- **El medidor de cola correctiva miente por 17× a 74×**: imprime 0,7 % donde la
  medición honesta de la misma ventana da entre 11,8 % y 51,7 %.

### 2 · Tres puertas al auto-posteo, una custodiada

A4 construyó el piso de evidencia —siete días, diez decididos, acuerdo ≥0,90—
y `resolvePolicy` lo cobra. Pero es la única puerta con peaje:

- `--auto-post` en la bandera lo enciende sin tocarlo.
- **`{"ingest":{"auto_post":true}}` en el archivo del operador también** — y ése
  es el caso grave: es persistente, es de máquina y gobierna corridas
  desatendidas. Verificado ejecutando `resolverUmbralesConPanel`.
- El peor caso, también ejecutado: **panel en `'shadow'` + archivo en `true` →
  el despacho postea de verdad y no se registra ni un veredicto de sombra.**
  Contestó «mídelo primero» y obtuvo posteo real con cero evidencia, en silencio.
- La asimetría correcta ya existe en el mismo módulo — el archivo sólo puede ser
  **más estricto** que el panel — pero se aplica al tope de monto y no al
  interruptor.

Además: **la sombra mide un modo real que ya no existe.** Registra el veredicto
del umbral, pero A3 añadió un segundo autorizador que corre justo cuando el
umbral dice que no. Con una política otorgada, el modo real postea casos que la
sombra apuntó como «no habría posteado» — y `matchApproval` casa sólo por tipo y
monto, así que hace saltables la confianza mínima y el proveedor conocido.

Y **la evidencia se mide por entidad mientras la decisión se escribe por
inquilino**: siete días de sombra en una entidad de prueba encienden el
auto-posteo para todas las demás.

### 3 · El DML de migración bajo RLS rellena cero filas, en silencio

Probado empíricamente: mismo SQL, mismo rol, `UPDATE 0` sin contexto de
inquilino contra `UPDATE 1` con él. Ya cobró una víctima real —la siembra de la
043 sembró vacío y provocó una colisión de folios— y alcanza a otras dos
migraciones que el repositorio cree aplicadas: la **037** (etiquetado) y la
**040**, que es una **purga de seguridad**.

Matiz verificado en esta base: la 040 **no dejó residuo** aquí (cero filas con
el marcador). El riesgo es estructural, no una fuga confirmada — pero un
despliegue donde esa migración corriera bajo RLS forzada con el rol de la
aplicación tendría la purga sin purgar y no lo sabría.

### 4 · Un sistema contable sin restauración no es un sistema contable

No existe **ni una línea** de respaldo o restauración en todo el árbol.
Agravado por lo que el propio proyecto construyó bien: `audit_log` es
append-only y el mayor es físicamente inmutable desde la 041 — así que un
error de datos **no se puede reparar a mano**. La única salida sería restaurar,
y no hay de dónde. El catálogo ya diseñó las cuatro filas y las puso en fase 2/3.

### 5 · Bloqueos que resultaron ser más pequeños de lo que el plan creía

- **El PAC real está a una línea.** `SovosReachcoreAdapter` es el único adaptador
  no simulado del repositorio, con su `configure()` completo — y nunca se
  registra. `integrationRegistry.get()` muere en `PROVIDER_NOT_FOUND`. El plan
  trata «contratar un PAC» como decisión de negocio bloqueante; la mitad del
  bloqueo es un renglón que falta.
- **`ledger check` es ciego justo donde el arrastre vive.** El check `balance`
  no mira `ending_balance` ni `beginning_balance` —las dos columnas que
  propagan saldos entre ejercicios— y el nombre `continuity`, que el catálogo
  reservó para esa invariante, se gastó en detectar huecos de folio.
- **La documentación del agente está caducada** y le enseña tratamientos que el
  código ya corrige: `src/ai/docs/mexico-cfdi.md` sigue en la línea base de
  agosto y promete una cancelación por REST que responde 501.

---

## Qué le falta a mnemosine para ser AI-first de verdad

La auditoría I dijo que la brecha madre era **no tener evals**. Eso se cerró
(A1–A2) y lo que apareció debajo es más fino: mnemosine ya sabe *medirse*, y lo
que le falta es **que la medición sea la única puerta**. Hoy la evidencia se
puede rodear por un archivo de configuración; la sombra valida un clasificador
distinto del que se va a encender; y el tablero que gobierna todo esto se mide
a sí mismo con regex sobre su propio texto.

El replanteamiento que exige el plan maestro no es «más capacidad de agente».
Es **cerrar el lazo entre lo que se mide y lo que se permite**, y hacerlo con
instrumentos que juzguen conducta y no prosa. Eso es lo que ordena la secuencia
del Plan Maestro v3.
