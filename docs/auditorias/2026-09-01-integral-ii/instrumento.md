> **Nota de estado del árbol.** El encargo fija HEAD = `a149e62`. Durante esta auditoría el árbol avanzó: HEAD real al cerrar es `6e280dd` ("El redactor deja de ser el portador"), con **A3 en vuelo sin commitear** en `src/plan/criterios.ts` (+140 líneas: tres criterios nuevos de E5.1). Todo lo que sigue está medido contra el árbol de trabajo tal como está HOY, y las cifras difieren de las del encargo por esa razón: **69 criterios** (no 66), **E5.1 12/15**, **10 de 15 paquetes verdes**, **119 invocables / 108 de fase 1** en el catálogo. Cada cifra la da el instrumento, no la memoria.

---

## FORTALEZAS

1. **El instrumento acepta bajar, y bajó tres veces con causa escrita en el mismo diff.** `.github/workflows/ci.yml:71-93` documenta las tres reaperturas (E1.2, E4.1, E3.2) y el porqué de cada una. El trinquete no es decorativo: hoy `--exigir` nombra exactamente los 10 paquetes verdes (`ci.yml:94`), ni uno más ni uno menos. Verificado corriendo la línea literal de CI: `exit=0`.

2. **El runner distingue «no se pudo medir» de «se midió y falló», y lo honra.** `src/plan/status.ts:110-135`: `bloqueadoPorEntorno` saca del cómputo de `--exigir` a los criterios que declararon `necesita` y no pudieron evaluarse, pero los sigue IMPRIMIENDO con su causa (`status.ts:157-160`). Es la diferencia entre una compuerta y un sorteo según dónde corra. El comentario de `status.ts:104-117` narra el accidente que lo produjo — hubo que BORRAR un criterio bueno para desatascar CI — y esa cicatriz está pagada.

3. **`--exigir` de un paquete inexistente ya no pasa en silencio.** `status.ts:214-224`: renombrar o borrar un paquete en `criterios.ts` para vaciar el trinquete ahora sale con 1. Es el único vector por el que el instrumento podía autolobotomizarse, y está tapado.

4. **El catálogo tiene tres invariantes estructurales antes del trinquete, no sólo el trinquete.** `scripts/catalogo-estado.ts:466-485`: toda fila declara fase ∈ {1,2,3} (la lección de `pac create`), ninguna fila cruda se pierde en el parseo (la lección de las 25 filas rotas por un pipe), y `celdasDe` (`:177-194`) parte por tuberías reales — 133 de 1 624 filas llevan `|` dentro de comillas. El suelo vive aparte (`docs/catalogo-minimos.json`) y sólo sube en el commit que gana el terreno.

5. **La guardia de «comando vivo sin fila» está viva y hoy vale cero.** `catalogo-estado.ts:498-509` + medición: `sinFila = 0`, `citas: 643 totales, 0 rotas`. El desajuste que hizo que `report` entregara ocho comandos y cerrara cero filas está cerrado y vigilado.

6. **La frontera por inquilino sí se mide por comportamiento, y no desde `criterios.ts`.** `scripts/verify-isolation.sh:68-113` comprueba contra Postgres real que **toda tabla con alcance tiene política** y que la app tiene permisos sobre todas — corriendo como `mnemosine_app`, no como superusuario (`ci.yml:150`, y el criterio `criterios.ts:223` lo vigila). Es el único lugar del sistema donde un medidor ejerce el producto en vez de leerlo.

7. **Los criterios llevan su propia arqueología de falsos verdes.** `criterios.ts:83-95` (`sinComentarios`, nacido de una política «consumida» sólo en prosa), `:140-152` (`codigoDe`, nacido de los dos errores simétricos), `:57-65` (`fuentes` excluye `src/plan` porque el instrumento se acusó a sí mismo en su estreno). Y `tests/plan/criterios.spec.ts:18-71` prueba esos ayudantes contra los errores ya cometidos.

8. **El costo por fila dejó de ser memoria.** `scripts/costo-por-fila.ts` corre y da hoy **423 líneas/fila sobre 31 filas invocables ganadas desde S0.1**, contra la referencia fundacional de ~390 medida una sola vez. El método declara sus tres límites en su propia salida.

---

## BRECHAS

### 1. NUEVA — **El trinquete protege PAQUETES, no criterios: 16 de los 62 criterios verdes pueden ponerse rojos sin que CI se entere, y entre ellos está la regla (b) de la casa.**

`--exigir` opera a granularidad de paquete (`src/plan/status.ts:226-234`: `incumplidos = exigir ∩ abiertos`). Un paquete que ya está abierto es invisible al trinquete **entero**, incluidos sus criterios verdes.

Reparto verificado hoy (`npm run plan:status`): E1.4 1/2, E3.2 0/1, E4.1 2/3, E4.2 1/2, E5.1 12/15 → **16 criterios verdes viven dentro de paquetes rojos**; los 46 restantes sí están cubiertos por los 10 paquetes de `ci.yml:94`.

Entre esos 16 desprotegidos:
- `criterios.ts:1928` — «Ninguna herramienta del agente alcanza el mayor ni ejecuta hacia fuera» (E5.1). **Es la regla (b) de la casa, cableada con tres cercas** (`criterios.ts:1952`), y ningún commit puede ponerla en rojo en CI.
- `criterios.ts:1871` — «Los importes sobreviven a la compactación por construcción».
- `criterios.ts:1289` — «Ninguna función reporta éxito de un acto externo que no realiza» (E1.4).
- `criterios.ts:1676` — «Postear no dispara el refresco de vistas materializadas» (E4.2).

**Prueba, no argumento:** corrí la línea exacta de CI con tres criterios de E5.1 en rojo vivo:
`npm run plan:status -- --exigir=E0.0,E0.1,E0.2,E0.3,E1.1,E1.2,E1.3,E2.1,E2.2,E3.1` → `exit=0`.
La compuerta ya está pasando por encima de tres rojos hoy; el cuarto le daría igual.

Etiqueta: **NUEVA**.

---

### 2. SIGUE-ABIERTA (mutada) — **La compuerta de la auditoría adversarial es vacua, y F01 y F02 se declararon cerrados por debajo de ella.**

Audit I la nombró dos veces (`doce-cobertura.md:21`, y como recomendación `:33`). S1 respondió con un criterio: `criterios.ts:234` «Un flujo no se declara cerrado sin su auditoría adversarial registrada». Pero su lista está **vacía**:

```
criterios.ts:243-245
      const FLUJOS_CERRADOS: Record<string, string> = {
        // 'F01': 'docs/auditorias/F01.md',
      };
```

El criterio sólo comprueba que `docs/auditorias/2026-08-31-integral/README.md` siga existiendo (`:246`). Mientras tanto **F01 (`a6932b1`) y F02 (`a149e62`) se commitearon como cierres** («17 filas cierran», «E1.2+E1.3 verdes») y `ls docs/auditorias/` devuelve **un solo directorio**: `2026-08-31-integral`. No hay `F01.md` ni `F02.md`.

La compuerta pide que cerrar un flujo sea *añadir una línea a mano* — que es exactamente la disciplina que decía venir a sustituir. Mutó de «no hay compuerta» a «hay una compuerta que no obliga a nada».

Etiqueta: **SIGUE-ABIERTA**.

---

### 3. SIGUE-ABIERTA — **La disciplina de mutación no está codificada en ninguna parte; vive en los comentarios y en la costumbre.**

Audit I: `doce-cobertura.md:20` («prosa sin mecanismo»). Hoy `tests/plan/criterios.spec.ts` sigue midiendo **98 líneas** y sus cuatro bloques prueban los *ayudantes* (`sinComentarios`, `fuentes`, `consumidoresDe`) y la *higiene* de la lista (`:74` cada criterio declara paquete y enunciado; `:87` el enunciado tiene ≥5 palabras; `:91` todo resultado trae detalle). **Ninguna prueba muta el código medido y exige que un criterio caiga en rojo.**

El costo está a la vista en la propia fuente: la familia del «ancla al símbolo equivocado» lleva seis variantes documentadas dentro de `criterios.ts`, todas descubiertas a mano:
- el **import** (`:1993-1996`, «el primo del import (AUD-6)»),
- la **firma vecina** (`:595-597`, «anclar al símbolo equivocado» en `añoDeDocumento`),
- la **firma como llamada** (`:685-687`, «El push, no el nombre… cuarta aparición»),
- el **sufijo** (`:712-713`, «`\b` tras el nombre… quinta variante»),
- la **presencia contra el conteo** (`:2058-2062` y `:2103-2107`, «mutar uno deja los demás y un chequeo de presencia lo bendice»),
- y la **ventana mágica** (brecha 9, abajo), que aún no está reconocida como miembro de la familia.

Seis apariciones de la misma clase en la misma serie de sprints no son mala suerte: son la ausencia de una herramienta.

Etiqueta: **SIGUE-ABIERTA**.

---

### 4. NUEVA — **El criterio de cobertura mide que EXISTAN umbrales, no cuáles ni a qué altura; y el universo medido son 17 de 266 archivos.**

```
criterios.ts:355-358
      const archivos = (c.match(/'src\/[^']+\.ts':/g) ?? []).length;
      return archivos >= 3 ? ok(...) : falla(...)
```

La vara es **≥ 3**, y hoy hay 4 (`vitest.config.ts:36-49`). Se puede **borrar el umbral de `posting.ts`** — el motor del mayor, 99/95/100/99 — y el criterio sigue verde y CI también.

Y el alcance: `vitest.config.ts:14` incluye sólo `src/services/accounting/**` + `src/utils/sequence.ts` = **17 archivos de los 266 `.ts` de `src/`**. Corrida real (`npx vitest run --coverage`) dentro de ese universo privilegiado:

| archivo | stmts | umbral |
|---|---:|---|
| `account-roles-backfill.ts` | **0 %** | ninguno |
| `iva-ppd-reclass.ts` | **0 %** | ninguno |
| `period-close.ts` | **6,77 %** | ninguno (declarado, `vitest.config.ts:27-31`) |
| `ledger-checks.ts` | 33,17 % | ninguno |
| `entity-accounting.ts` | 41,02 % | ninguno |
| `account-roles-service.ts` | 44,44 % | ninguno |
| conjunto medido | **69,35 %** | — |

`iva-ppd-reclass.ts` al 0 % es el reclasificador de IVA de PPD: el objeto de E1.2, hoy en verde 3/3.

Además el trinquete ya tiene holgura y nadie la retensa: `sequence.ts` con umbral 69 mide **79,12**; `validation.ts` con 90 mide 94,28. Diez puntos de caída silenciosa disponibles.

Etiqueta: **NUEVA**.

---

### 5. NUEVA — **La aritmética del cierre anual no la vigila nadie: la única prueba afirma «distinto de cero».**

`tests/integration/period-close.int.spec.ts:118-145` es todo lo que hay sobre el barrido anual. Verifica el destino (3200 y no 3100, NIF C-11), que Capital Social no se mueve, y luego:

```
tests/integration/period-close.int.spec.ts:144
    expect(acumulados).not.toBe(0);
```

Un barrido que lleve la mitad del resultado, o que lo lleve **con el signo invertido**, pasa esta prueba. Y `plan:status` no toca el cierre: `grep "carryForward\|hardClose\|cierre anual" src/plan/criterios.ts` da tres aciertos, todos ajenos — `:547` (el candado de periodo en ambas transacciones), `:1968` y `:1980` (la cerca que impide al agente llamar `hardClosePeriod`). **Ningún criterio afirma que el cierre anual cuadre.** Es el acto contable de mayor magnitud del año y el instrumento no lo mira.

Etiqueta: **NUEVA**.

---

### 6. NUEVA — **La vara del agente existe y jamás se ha usado como vara: el arnés tiene umbral y nadie lo invoca.**

`scripts/eval-clasificador.ts:289-293` implementa la compuerta completa: con `--umbral`, un global por debajo sale con código 1. Pero:
- `grep -rn "eval-clasificador" package.json .github/` → **vacío**. No hay script npm ni job.
- `find . -name "*clasificador.jsonl*"` → **vacío**. No hay bitácora de ninguna corrida.

Y el criterio que A1 añadió (`criterios.ts:2010-2044`) afirma **que el arnés existe y está bien construido** — golden set con esperado, proveedor fijado, bitácora, clase abstención — pero nunca que haya puntuado. Tenemos una vara de medir sin una sola medición registrada. La brecha madre de la auditoría integral («medir antes de soltar») pasó de *doctrina sin instrumento* a *instrumento sin lectura*.

Lo mismo con la latencia: la 044 persiste `duration_ms` (`criterios.ts:2092`) y `ai stats` publica buckets con delta (`:2047`), pero **ningún criterio ni compuerta fija un techo**. No hay p95 en ninguna parte del repositorio.

Etiqueta: **NUEVA**.

---

### 7. NUEVA — **La deuda de dependencias no la mide el tablero, y hoy no es cero.**

`grep -in "npm audit\|vulnerab" src/plan/criterios.ts .github/workflows/ci.yml` → **cero aciertos**. `npm audit --production` hoy:

```
14 vulnerabilities (9 moderate, 5 high)
  high  @xmldom/xmldom  — recursión no acotada (DoS) + inyección XML
  high  axios           — bypass de autenticación por prototype pollution
  high  kysely          — inyección SQL vía claves de ruta JSON
  high  form-data       — inyección CRLF en nombres de campo
  high  fast-xml-builder— comillas no escapadas en valores de atributo
```

Dos de las cinco (`@xmldom/xmldom`, `fast-xml-builder`) están en el camino del CFDI, que es por donde entra el documento fiscal del cliente. `.github/dependabot.yml` abre PRs agrupados semanalmente — pero abrir un PR no es una compuerta: nada pone la CI en rojo, y el tablero de 15 paquetes no tiene una casilla donde esto se vea.

Etiqueta: **NUEVA**.

---

### 8. NUEVA (y MUTACIÓN de una brecha fiscal de auditoría I) — **El censo de capacidad muerta es de TABLAS, no de columnas; hay una columna muerta hoy en el corazón fiscal, y su gemela viva lleva otro nombre.**

`criterios.ts:265` («Toda tabla muerta está enterrada o reclamada») recorre `CREATE TABLE` (`:288-291`). No hay equivalente para columnas. Consecuencia verificada:

- `src/database/migrations/037_etiquetado_que_encarece.sql:28-31` añade `accounts.codigo_agrupador_sat` con un COMMENT que promete: *«el checklist de F07 exigirá que ninguna cuenta con movimientos lo tenga vacío»*.
- `grep -rln "codigo_agrupador_sat" src/` → **sólo el archivo de migración**. Cero menciones en código.
- Mientras tanto F01 construyó la superficie estatutaria completa contra **otra columna**: `src/services/accounting/account-service.ts:447-451` mapea `'sat-agrupador' → 'mx_nif_code'`, y `setAccountMapping` (`:476`) escribe ahí. `mx_nif_code` viene de `001_core_schema.sql:130`.

Audit I (`practicas-fiscal-mx.md:15`) dijo «existe la columna, no existe un generador». Hoy el diagnóstico es peor y distinto: **existen dos columnas para el agrupador del Anexo 24, y la que la 037 creó y documentó para F07 es la muerta.** Cuando F07 llegue, encontrará los datos en la columna que su migración no nombra.

Etiqueta: **NUEVA** (la brecha de auditoría I **MUTÓ**).

---

### 9. NUEVA — **El suelo del catálogo mide la puerta, no el cuarto.**

`docs/catalogo-minimos.json` sólo pone piso a `invocables` (119) y `fase1Invocables` (108) — ambas cuentan **superficie**: que el binario responda a la ruta. `catalogo-estado.ts:512-519` compara exactamente esas dos claves y ninguna más.

Medición de hoy sobre las filas de fase 1:
- 85 vivas con motor ✅
- **22 vivas con motor 🟡**
- **1 viva con motor ❌**
- **47 con motor ✅ y sin comando**

Dos consecuencias. (a) Degradar una fila de ✅ a 🟡 sin tocar el comando **pasa el `--check`**: el suelo no ve el motor. `porEstado.ok` (191 filas hoy) se publica en el bloque generado y no tiene piso. (b) Esas **47 filas de fase 1 con motor completo y sin puerta** son el bolsón más barato del plan entero y ningún medidor lo publica como cifra rectora — hay que derivarlo a mano del `--json`, como hice aquí.

Etiqueta: **NUEVA**.

---

### 10. NUEVA — **La técnica del «tramo» está reinventada tres veces con tres terminaciones, una de ellas una constante mágica que ya admite código ajeno.**

Anclar una afirmación al cuerpo de una función concreta se hace a mano en cada criterio:

```
criterios.ts:599-600   const iNext = s.indexOf('export async function nextEntityNumber');
                       s.slice(iNext, s.indexOf('export', iNext + 10))
criterios.ts:672-673   const iPost = p.indexOf('export async function postJournalEntry');
                       p.slice(iPost, p.indexOf('export', iPost + 10))
criterios.ts:723-724   const iPrev = ingest.indexOf('export async function previewCfdiFiles');
                       ingest.slice(iPrev, iPrev + 2500)      ← ventana fija
```

Medido: el cuerpo de `previewCfdiFiles` tiene **2 142 caracteres** (es el último `export` del archivo, `src/ai/ingest-service.ts`), así que la ventana de 2 500 **ya admite 358 caracteres de fuera de la función**. Hoy no hay nada ahí y el criterio pasa (`entityId: string` en el offset 103, el dedupe en el 1084). El día que alguien añada un `export` detrás, el criterio empezará a leer código ajeno — y en la dirección peligrosa: **bendecirá** una firma que ya no está donde dice.

Es la sexta variante de la familia del ancla, y la única que todavía no está reconocida como tal en los comentarios.

Etiqueta: **NUEVA**.

---

### 11. NUEVA (menor) — **La cola correctiva que publica `costo-por-fila` es estructuralmente cero con el estilo de asuntos de esta casa.**

Salida real hoy: `Cola correctiva declarada (asuntos AUD-*/correctivos): 111 de 15025 líneas = 0.7%` contra una referencia fundacional de 12,3 %. El heurístico busca `AUD-*`, «falso verde», «corrig», «repara» en el **asunto** del commit (`scripts/costo-por-fila.ts`, declarado en su cabecera `:24-26`). Pero la corrección de estos sprints viajó **dentro** de S1, F01 y F02, cuyos asuntos son títulos literarios («el espejo por entidad, el SAT de verdad»). El instrumento se autolimita con honestidad, pero el número que publica se lee como un triunfo de 17× y es un punto ciego. Y no está en CI ni en ningún bloque generado, así que nadie lo va a leer para desmentirlo.

Etiqueta: **NUEVA**.

---

### 12. SIGUE-ABIERTA — **La cola larga F09–F12 sigue sin instrumento.**

Audit I (`doce-cobertura.md:24`): la regla «si tres sprints seguidos no bajan la cola, el orden se revisa» no es comprobable porque el medidor no publica el tamaño de la cola ni su serie. Hoy `render()` (`catalogo-estado.ts:355-440`) publica filas, invocables, motor por símbolo, fase 1, recorte S0.5, solapamientos, familias y citas — **nada por flujo, y ninguna serie temporal**. La regla sigue siendo prosa.

Etiqueta: **SIGUE-ABIERTA**.

---

### 13. NUEVA (menor) — **La ceguera declarada del catálogo cubre el 21 % del binario y el bloque generado no lo dice.**

`FUERA_DEL_CATALOGO` (`catalogo-estado.ts:76-83`) esconde de la guardia `sinFila` **28 de las 134 hojas vivas**: `jobs`(6), `webhooks`(4), `pending`(3), `approvals`(3), `skills`(3), `memory`(2), y una cada uno `entities`, `providers`, `sessions`, `drafts`, `prompt-size`, `ai`, `usage`.

Lo bueno: **ninguna entrada está caducada** — verifiqué que las 13 familias esconden al menos una hoja hoy, así que la lección de S0.7 (quince familias que ya estaban catalogadas y cegaban de más) se sostiene. Lo que falta es la publicación: el bloque generado dice «el binario ejecuta hoy **134 comandos**» sin decir que 28 de ellos no los vigila nada. Un lector externo lee 134 vigilados.

Etiqueta: **NUEVA**.

---

### Dictamen sobre las brechas de instrumento de la AUDITORÍA I

| # | Brecha de auditoría I | Dictamen | Evidencia |
|---|---|---|---|
| 1 | `doce-cobertura.md:19` — el costo por fila sin instrumento | **CERRADA** | `scripts/costo-por-fila.ts` corre: 423 líneas/fila. Residuo en brecha 11 |
| 2 | `doce-cobertura.md:20` — la mutación es prosa sin mecanismo | **SIGUE-ABIERTA** | brecha 3 |
| 3 | `doce-cobertura.md:21,33` — auditoría adversarial sin compuerta | **SIGUE-ABIERTA (mutada)** | brecha 2 — `criterios.ts:243-245` lista vacía |
| 4 | `doce-cobertura.md:22` / `maestro-vs-codigo.md:16` — «doctor sin huérfanos» como criterio | **CERRADA** | `criterios.ts:744-777`, tres huérfanos congelados que sólo pueden encoger |
| 5 | `doce-cobertura.md:23` / `maestro-vs-codigo.md:13` — cifras caducas en el Plan Maestro | **CERRADA (en el dato)** | el artefacto dice «suelo 110→119» y «fase 1 pasa a 379»: casa con el medidor de hoy. El mecanismo sigue siendo copia a mano |
| 6 | `doce-cobertura.md:24` — la cola larga sin instrumento | **SIGUE-ABIERTA** | brecha 12 |
| 7 | `maestro-vs-codigo.md:24` — `pac create` sin fase + invariante al `--check` | **CERRADA** | `catalogo-estado.ts:466-485`; `filasCompletas` da 0 filas sin fase legible |
| 8 | `cierre-cobertura.md:28` — E3.2 falso verde vivo en el tablero | **CERRADA** | `plan:status` da E3.2 ⬜ 0/1 con el porqué; fuera de `--exigir` (`ci.yml:86-92`) |

**5 cerradas · 3 siguen abiertas · 11 nuevas.**

---

## RECOMENDACIONES

### 1. (S) — Piso de criterios verdes, no sólo de paquetes cerrados. → gobernanza, el siguiente sprint, antes de F03

Cierra la brecha 1, que es la mayor. Mismo patrón que ya funciona en el catálogo: un `docs/criterios-minimos.json` con `{ "verdes": 62 }`, comprobado por `plan:status --piso`, que sale con 1 si el número de criterios `ok` cae — **da igual en qué paquete estén**. Sube en el mismo commit que gana el terreno; baja sólo con causa en el diff, igual que las tres reaperturas de `ci.yml:71-93`.

Es una función de diez líneas en `src/plan/status.ts` y una línea en `ci.yml`. A partir de ella, la cerca que impide que una herramienta del agente alcance el mayor (`criterios.ts:1928`) queda protegida por primera vez.

### 2. (S) — Obligar a la lista `FLUJOS_CERRADOS`, en vez de invitarla. → gobernanza, mismo commit que la #1

La lista de `criterios.ts:243` no puede depender de que alguien se acuerde. Derívala: un flujo está DECLARADO cerrado si su etiqueta `F0x` aparece como prefijo del asunto de un commit en `main`; el criterio exige entonces `docs/auditorias/F0x.md`. `git log --format=%s` ya está disponible en el proceso (`spawnSync` se usa en `criterios.ts:187`). Con eso, F01 y F02 se ponen en rojo hoy, que es la verdad, y el rojo se paga escribiendo las dos auditorías que faltan.

### 3. (M) — Un ayudante de anclaje, y el retiro de la ventana mágica. → gobernanza, mismo sprint

Seis variantes de la misma clase de error (brecha 3) piden herramienta, no disciplina. Un par de funciones exportadas desde `criterios.ts`:

- `cuerpoDe(archivo, 'nextEntityNumber')` — localiza la declaración y devuelve el cuerpo **por conteo de llaves**, no por `indexOf('export', …)` ni por ventana fija. Retira los tres tramos a mano de `:600`, `:673`, `:724` y mata la constante 2 500.
- `llamadaA('checkSoDViolations', 'permisos')` — casa la **forma de llamada**, no el identificador: inmune al import, a la firma vecina, a la firma-como-llamada y al sufijo, que son cuatro de las seis variantes.

Que las dos vivan probadas en `tests/plan/criterios.spec.ts` contra los seis casos históricos, que ya están documentados con nombre y línea dentro de `criterios.ts`.

### 4. (M) — Un arnés de mutación, aunque sea de tres casos. → gobernanza, sprint siguiente

No hace falta un mutador general. Basta un `tests/plan/mutacion.spec.ts` que, para los criterios de la lista `--exigir`, copie el archivo objetivo a un temporal, aplique **una** mutación declarada junto al criterio (`mutante: { archivo, de, a }` como campo opcional de `Criterio`) y exija que `evaluar()` devuelva `falla`. Empezar por los tres más caros de perder: la cerca del agente (`:1928`), el candado de periodo (`:533`) y el maker-checker (`:658`). Convierte la regla (c) de la casa en código y, de paso, es el único mecanismo que habría cazado las seis variantes del ancla el día que nacieron.

### 5. (S) — Poner en verde-o-rojo la vara del agente. → A-serie (A4), inmediata

`scripts/eval-clasificador.ts --umbral 0.8` ya sale con 1 (`:289-293`). Faltan tres líneas: script en `package.json`, job en `ci.yml` con proveedor fijado (o, si el costo por corrida lo desaconseja en cada PR, un job nocturno), y **el umbral como suelo versionado** que sólo sube. Hoy tenemos una vara sin una sola lectura registrada (brecha 6).

### 6. (S) — `npm audit --production --audit-level=high` como job. → gobernanza, inmediata

Cinco vulnerabilidades altas vivas (brecha 7), dos de ellas en el camino del CFDI. Con una línea de excepciones versionada (`audit-ci` o un `--json` filtrado contra una lista congelada, mismo patrón que `HUERFANOS_CONGELADOS` en `:762`) el rojo es accionable en vez de ruidoso, y cada excepción lleva fecha y dueño.

### 7. (M) — Criterio sobre la aritmética del cierre anual. → F09–F12 (reportes), o antes si algún cliente cierra ejercicio

Brecha 5. Dos actos: (a) endurecer `tests/integration/period-close.int.spec.ts:144` para que afirme el importe exacto — `acumulados` debe igualar Σ(ingresos) − Σ(gastos) del ejercicio, con signo; (b) un criterio `necesita: 'base-de-datos'` que compruebe sobre la base sellada que **ningún ejercicio cerrado tiene resultado sin barrer**. El campo `necesita` ya está honrado por el runner (`status.ts:110-117`), así que el criterio informa en la portátil y no rompe CI.

### 8. (S) — Umbrales de cobertura por archivo NOMBRADO, y ampliar el universo. → gobernanza, sprint siguiente

Brecha 4. Cambiar `archivos >= 3` (`criterios.ts:356`) por una lista de archivos **obligatorios** — `posting.ts`, `validation.ts`, `ar-ap-posting.ts` — de forma que borrar el umbral del motor del mayor ponga rojo. Y retensar la holgura ya ganada (`sequence.ts` 69→79, `validation.ts` 90→94) en el mismo commit: el trinquete se pone donde está el terreno, no diez puntos por detrás.

### 9. (M) — Un suelo sobre el MOTOR, no sólo sobre la puerta. → gobernanza + F09–F12

Brecha 9. Añadir `motorOk` a `docs/catalogo-minimos.json` con el valor de hoy (191) y compararlo en `catalogo-estado.ts:512-519` junto a los otros dos. Y publicar en el bloque generado las **47 filas de fase 1 con motor ✅ y sin comando**: es la cifra más accionable que el instrumento sabe calcular y hoy no imprime.

### 10. (S) — Publicar lo que el catálogo no vigila, y la cola por flujo. → gobernanza

Brechas 12 y 13. Dos líneas más en `render()`: «de los 134 comandos vivos, 28 quedan fuera de la guardia por declaración explícita (jobs, webhooks, …)», y un recuento de filas por flujo F01–F12 con su serie desde el commit anterior. Sin esto, la regla de los tres sprints del Plan Maestro no es comprobable y el 21 % de ceguera no es visible.

### 11. (S) — Extender el censo de capacidad muerta a COLUMNAS, y reconciliar el agrupador. → F07 (contabilidad electrónica), adelantando la parte de datos

Brecha 8. El censo de `criterios.ts:265` sabe leer `CREATE TABLE`; leer `ADD COLUMN` es el mismo párrafo de código. Y antes de que F07 escriba una línea de XML, decidir cuál de las dos columnas es el agrupador del Anexo 24 — `accounts.codigo_agrupador_sat` (037, documentada, muerta) o `accounts.mx_nif_code` (001, viva, mal nombrada) — y enterrar la otra con una migración. Dos nombres para un concepto fiscal es un partido de datos esperando a que alguien lo provoque.

---

## Lo que mediría un auditor externo y hoy no se mide

Más allá de las brechas ya numeradas, cinco huecos que un tercero buscaría primero y que no tienen ni instrumento ni casilla:

1. **Rendimiento y volumen.** Cero apariciones de `EXPLAIN`, índice o benchmark en `src/plan/criterios.ts` y en `tests/` (única excepción tangencial: `tests/services/rate-limit-degradacion.spec.ts`). Nadie sabe qué hace el mayor con un millón de líneas, ni si las vistas materializadas se refrescan en un tiempo tolerable a escala de despacho. El sistema se mide en corrección y nunca en carga.

2. **Restauración.** Hay migraciones probadas hacia adelante (job `integration`) y ninguna prueba de que una base se pueda **restaurar**. Para un sistema contable con obligación de conservación de cinco años, es la primera pregunta de un auditor externo y no hay nada que responderle.

3. **Reversibilidad de migraciones.** 46 migraciones, ninguna con camino de vuelta probado. La 038 «entierra» seis tablas y la 046 dropea una constraint de unicidad: dos actos irreversibles sin ensayo.

4. **Integridad referencial entre módulos.** `verify-isolation.sh` prueba magistralmente el aislamiento por inquilino, pero nada comprueba que no haya FKs huérfanas entre nómina, CFDI y el mayor. El censo de E0.2 mira vocabularios (`CHECK`) y tablas muertas; las relaciones quedan fuera.

5. **Que las políticas del panel estén CONTESTADAS.** El criterio E1.3 (`:1220`) afirma que toda política tiene **lector** — no que ningún inquilino esté operando con decisiones contables sin contestar. Es la mitad honesta del problema; la otra mitad (¿cuántas entidades vivas tienen políticas en blanco?) sólo se puede preguntar contra la base, y nadie la pregunta.

Los cinco son medibles con el vocabulario que el instrumento ya tiene. Ninguno tiene hoy una casilla en el tablero — y esa es, en una frase, la respuesta a la pregunta de este lente: **el tablero mide con excelencia lo que el código DICE, y casi nunca lo que el sistema HACE bajo carga, en el tiempo, o después de un desastre.** De 69 criterios, **68 leen texto fuente** y uno solo (`:373`, `necesita: 'base-de-datos'`) ejerce el producto.

---

## VERIFICACIÓN ADVERSARIA DEL HALLAZGO MAYOR

**Hallazgo:** El trinquete de CI es de granularidad PAQUETE, no criterio: 16 de los 62 criterios verdes viven dentro de paquetes rojos y ningún commit puede ponerlos en rojo — entre ellos «Ninguna herramienta del agente alcanza el mayor ni ejecuta hacia fuera» (src/plan/criterios.ts:1928), que es la regla (b) de la casa; probado corriendo la línea literal de .github/workflows/ci.yml:94, que sale exit=0 con tres criterios de E5.1 en rojo vivo.

**¿Refutado?** No: se sostiene

SE SOSTIENE el mecanismo, con los números mal. Verificado con evidencia propia y reproducido empíricamente.

1) Granularidad PAQUETE, confirmada en código: `src/plan/status.ts:204-238` parsea `--exigir` como lista de IDs de PAQUETE y compara contra `exigiblesAbiertos(todos)`, que en `src/plan/status.ts:129-135` filtra por paquete (`p.evaluaciones.filter(...)` → devuelve `p.id`). No existe ningún modo por criterio en todo el repo (`grep -rn "exigir" src scripts package.json` no arroja otra puerta).

2) La línea de CI `.github/workflows/ci.yml:94` exige `E0.0,E0.1,E0.2,E0.3,E1.1,E1.2,E1.3,E2.1,E2.2,E3.1`. Faltan E1.4, E3.2, E4.1, E4.2 y E5.1 — cinco paquetes abiertos cuyos criterios verdes nadie protege.

3) Corrí la línea literal en el repo real: sale EXIT=0 con seis criterios en rojo vivos (E1.4 depreciación sin llamador, E3.2 descarga SAT inexistente, E4.1 nómina sin escritura de impuestos, E4.2 cuatro copias del SQL de saldos, y dos de E5.1).

4) PRUEBA POSITIVA de que el criterio nombrado no está trinquetado: creé `src/ai/tools/zz-probe-auditoria.ts` con el identificador prohibido `postJournalEntry` (uno de los PROHIBIDOS de `src/plan/criterios.ts:1958-1972`). El criterio «Ninguna herramienta del agente alcanza el mayor ni ejecuta hacia fuera» pasó a rojo (E5.1 quedó 12/15) y la MISMA línea de CI siguió dando EXIT=0. Además `npx vitest run tests/plan tests/ai/tools tests/ai/frontera-desatendida.spec.ts` → 110 passed, y `npx tsx scripts/catalogo-estado.ts --check` → exit 0. Archivo de prueba borrado; `git status --porcelain src/ai/tools` limpio.

5) Por qué ninguna otra puerta lo atrapa: `tests/plan/criterios.spec.ts:96-102` EJECUTA todos los criterios pero sólo afirma que `r.detalle` no sea vacío — nunca afirma `estado === 'ok'`. Y `.github/workflows/ci.yml` es el único workflow del repo, con una sola invocación de `plan:status`.

LO QUE EL HALLAZGO EXAGERA O SE INVENTA:
- «tres criterios de E5.1 en rojo vivo»: FALSO. En a149e62 E5.1 tenía 12 criterios, 10 verdes y 2 rojos (herramientas derivadas del registro de riesgo, y --continue sin rehidratación). En HEAD actual (689458a) es 13/15, sigue siendo 2 rojos.
- «16 de los 62 criterios verdes»: números incorrectos. En a149e62 hay 66 criterios en total y los verdes dentro de paquetes no exigidos son 14 (E1.4 1, E3.2 0, E4.1 2, E4.2 1, E5.1 10). En HEAD actual son 17 sobre 69 criterios.
- Cita de línea: el enunciado está en `src/plan/criterios.ts:1926` en a149e62 (1929 en HEAD), no 1928.
- «regla (b) de la casa»: encuadre retórico del auditor. La frase «el agente propone y un humano dispone» sólo aparece dentro del comentario del propio criterio (`src/plan/criterios.ts:1936-1940`); no la encontré como regla numerada en docs/ ni en CLAUDE.md.

MATIZ A FAVOR DEL CÓDIGO: la granularidad de paquete sólo muerde en paquetes ABIERTOS. En un paquete exigido y verde, cada criterio SÍ queda trinquetado individualmente, porque `estadoDe` exige que todos pasen (`src/plan/status.ts:74`). Y el diseño es deliberado y confesado en `.github/workflows/ci.yml:71-93` («un paquete abierto es información, no un fallo»). El defecto es la consecuencia no advertida de esa elección, no la elección.

**Formulación corregida:** El trinquete de CI es de granularidad PAQUETE, no criterio (`src/plan/status.ts:129-135` y `:231-238`): el gate sólo pregunta si un paquete está abierto, y un paquete ya abierto absorbe cualquier regresión interna sin cambiar el veredicto. La línea `.github/workflows/ci.yml:94` omite E1.4, E3.2, E4.1, E4.2 y E5.1, así que 14 de los 60 criterios verdes de a149e62 (17 de 63 en HEAD 689458a — la cifra crece) viven en zona sin trinquete y ningún commit puede ponerlos en rojo ante la CI. Entre ellos «Ninguna herramienta del agente alcanza el mayor ni ejecuta hacia fuera» (`src/plan/criterios.ts:1926` en a149e62, `:1929` en HEAD), que es la garantía «el agente propone y un humano dispone» declarada en el propio comentario del criterio. Probado: añadiendo un archivo en `src/ai/tools` que sólo NOMBRA `postJournalEntry`, el criterio pasa a rojo y la línea literal de CI sale EXIT=0, con `vitest` de tests/plan+tests/ai/tools en verde (110 passed) y `catalogo-estado.ts --check` en 0 — porque `tests/plan/criterios.spec.ts:96-102` sólo verifica que el detalle no esté vacío, nunca que el criterio pase. Correcciones al hallazgo original: E5.1 tiene DOS criterios en rojo, no tres; los verdes desprotegidos son 14/66 en a149e62 (no 16/62); y la granularidad sólo es un hueco en paquetes abiertos — dentro de un paquete exigido y verde cada criterio sí queda protegido por `estadoDe` (`src/plan/status.ts:74`).

