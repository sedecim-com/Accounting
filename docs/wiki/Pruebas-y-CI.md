# Dos suites, seis trabajos y tres trinquetes

Esta página explica cómo se verifica mnemosine: qué prueba cada suite, qué hace cada trabajo de la integración continua, y —la parte que suele faltar— **qué queda fuera de medición y por qué**.

El arranque rápido está en el [README](https://github.com/sedecim-com/Accounting/blob/main/README.md). Aquí va el porqué.

---

## Las dos suites

Están deliberadamente separadas en dos configuraciones de Vitest, y la separación es un criterio del tablero: sin ella, una prueba con base de datos contamina el bucle rápido.

### Unitaria: rápida y sin base

```bash
npm test
```

**2 205 casos en 143 archivos.** Corre con [`vitest.config.ts`](https://github.com/sedecim-com/Accounting/blob/main/vitest.config.ts), que incluye `tests/**/*.spec.ts` y **excluye `tests/integration/**`**. No necesita Postgres, no necesita variables de entorno, y es la puerta que hay que correr en cada guardado.

### Integración: contra Postgres de verdad

```bash
npm run test:integration
```

**28 archivos**, con el sufijo `.int.spec.ts`, bajo [`vitest.integration.config.ts`](https://github.com/sedecim-com/Accounting/blob/main/vitest.integration.config.ts). Tres decisiones de esa configuración merecen explicación:

**Base efímera por corrida.** El `globalSetup` en [`tests/integration/global-setup.ts`](https://github.com/sedecim-com/Accounting/blob/main/tests/integration/global-setup.ts) hace `CREATE DATABASE mnemosine_it_<aleatorio>`, corre la cadena de migraciones sobre ella, y al terminar la destruye. Nadie limpia nada porque la base entera desaparece. Los dos scripts que esto reemplazó dependían de una base de desarrollo con UUID fijos y **reparaban a mano los saldos** al limpiar, que es la clase de prueba que sobrevive a sus propios defectos.

**Pide `TEST_ADMIN_DATABASE_URL` y se niega a arrancar sin ella.** Es un rol con permiso de `CREATE DATABASE`, que deliberadamente **no** tiene `mnemosine_owner`: crear bases no es una atribución del dueño del esquema. El setup lanza un error con ese nombre exacto si falta, en vez de caer contra una base cualquiera.

**Corre en serie a propósito.** `singleFork` y `fileParallelism: false`. Comparten base y **varias pruebas cuentan filas**: en paralelo, un conteo esperado de tres se convierte en un conteo de siete y el fallo es intermitente, que es la peor clase de fallo. Se paga tiempo de corrida a cambio de un veredicto determinista.

Un detalle que sorprende al leer el setup: crea dos roles de **clúster** si no existen, `mnemosine_verifier` y `mnemosine_refresher`. Los roles no son objetos de esquema y por tanto no viven en la cadena de migraciones; un clúster de CI nace sin ellos. Sin el verifier, el bloque correspondiente de las políticas de RLS se salta y el camino público de verificación quedaría sin probar. Sin el refresher —que lleva `BYPASSRLS` y `NOLOGIN`— el `REFRESH MATERIALIZED VIEW` reconstruiría la vista filtrada por el inquilino casual de la sesión, o vacía. Ver [[Aislamiento-multi-inquilino]].

### Para correrla en local

```bash
export TEST_ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
```

Más `DATABASE_URL` y `MIGRATION_DATABASE_URL` apuntando a tu Postgres. El detalle completo está en [`CONTRIBUTING.md`](https://github.com/sedecim-com/Accounting/blob/main/CONTRIBUTING.md) y en [[Puesta-en-marcha]].

---

## El typecheck doble

No es redundancia. Son dos proyectos con propósitos distintos:

```bash
npm run typecheck
```

`tsc --noEmit` sobre [`tsconfig.json`](https://github.com/sedecim-com/Accounting/blob/main/tsconfig.json), que incluye **solo `src/`** y excluye `tests`. Es el proyecto que **construye**: su `rootDir` es `./src` y su `outDir` es `./dist`, así que nada de `tests/` ni de `scripts/` puede colarse en el artefacto que se embarca.

```bash
npm run typecheck:tests
```

`tsc -p tsconfig.test.json --noEmit` sobre [`tsconfig.test.json`](https://github.com/sedecim-com/Accounting/blob/main/tsconfig.test.json), que extiende al anterior y añade `tests/` y `scripts/` con `noEmit`. Es el proyecto que **cubre todo el código escrito a mano**, y es el que usa ESLint para su análisis con tipos.

La razón de mantener el primero limitado a `src` está escrita en la configuración de lint: `scripts/` no debe alcanzar `dist/`.

---

## ESLint 9, con información de tipos

```bash
npm run lint
```

`npm run lint` fue durante mucho tiempo un adorno —el `package.json` lo declaraba y no había configuración que lo respaldara— y esa frase todavía anda suelta en documentación vieja. Hoy corre ESLint 9 con `typescript-eslint` 8 en configuración plana, con **información de tipos**, sobre `src/`, `tests/` y `scripts/`, y la CI lo exige en un trabajo propio.

La configuración es [`eslint.config.mjs`](https://github.com/sedecim-com/Accounting/blob/main/eslint.config.mjs), y no es un preset: es una **triage deliberada** en tres niveles, cada uno con su razón escrita al lado.

| Nivel | Qué contiene | Ejemplo |
|---|---|---|
| `error` | Clases de defecto que se encontraron, se arreglaron y ahora bloquean la CI | `no-unused-vars` con la convención del guion bajo bajo; `no-namespace` permitiendo declaraciones, porque aumentar el tipo `Request` de Express es la única forma soportada |
| `warn` | Insensatez que entra por **tipos de terceros** | Express 4 tipa `Request.body` como `any` y `fast-xml-parser` devuelve `any`, así que cada lectura de cuerpo y cada nodo de CFDI parseado es inseguro por construcción |
| `off` | Reglas que pelean con una decisión de diseño **de aquí** | `require-await`: el sistema se apoya en interfaces que devuelven promesas cuyas implementaciones a veces son síncronas a propósito — la bóveda de desarrollo local, los adaptadores de PAC, la jerarquía de validadores |

Se eligió el conjunto **con tipos** y no el barato precisamente porque `no-floating-promises` y `no-misused-promises` son las reglas que encontraron los errores reales de este repositorio. Y esas dos siguen **encendidas en `tests/`**: una prueba que olvida un `await` es una prueba que pasa por la razón equivocada.

### El trinquete de advertencias

Las advertencias no se ignoran, se topan:

```bash
eslint src/ tests/ scripts/ --max-warnings 1239
```

Los errores rompen la compilación; las advertencias fallan si su número **sube**. El tope está congelado en lo medido, y la instrucción escrita es explícita: bajarlo conforme se tipen las fronteras, nunca subirlo para que pase un build.

Hay una inconsistencia menor que conviene conocer antes de tropezarse con ella: el comentario de cabecera de `eslint.config.mjs` cita el tope antiguo (1 067, repartido en 436 de `src` y 631 de `tests`). El número que manda es el de `package.json`, y hoy es **1 239**. El comentario está desactualizado, no el trinquete.

Dos apagados que solo aplican a `tests/` y que ilustran la disciplina: `no-unnecessary-type-assertion` está apagado ahí porque su `--fix` **rompió literalmente** el typecheck de una prueba —ESLint cree que la aserción sobra, `tsc` dice lo contrario, y `tsc` es la autoridad— y `unbound-method` porque `expect(obj.metodo).toHaveBeenCalled()` es la forma normal de aserción en Vitest y no hay plugin instalado que la reconozca. Ninguna regla está apagada solo para llegar a cero.

---

## Los seis trabajos de CI, uno por uno

Hay **un solo** archivo de workflow, [`.github/workflows/ci.yml`](https://github.com/sedecim-com/Accounting/blob/main/.github/workflows/ci.yml), y esa unicidad es un criterio del tablero: los paquetes de trabajo **añaden** trabajos ahí, ninguno vuelve a crear el archivo.

Antes de los trabajos, tres decisiones del encabezado:

- **`push` solo sobre `main`.** Sin filtro, los mismos trabajos corrían en cada rama **y otra vez** en el pull request. En un repositorio público eso es el doble de bitácoras publicadas por el mismo trabajo, y las de Actions las lee cualquiera.
- **Concurrencia con cancelación.** Un push nuevo cancela la corrida anterior de la misma rama; sin esto, empujar tres veces deja tres corridas compitiendo por el mismo veredicto.
- **`permissions: contents: read`, dicho y no heredado.** Hoy el ajuste del repositorio ya lo dice, pero eso se cambia con un clic en una página de configuración, y el día que cambie cada trabajo de un repositorio público le entregaría un token con escritura al árbol de dependencias que `npm ci` ejecuta.

| Trabajo | Qué corre | Por qué existe |
|---|---|---|
| **Tipos** | `npm run typecheck` y `npm run typecheck:tests` | Las dos vistas del compilador, la que construye y la que cubre todo |
| **Lint** | `npm run lint` | Errores rompen; advertencias con trinquete |
| **Pruebas unitarias** | `npm test` y después `npx vitest run --coverage` | La suite, y el trinquete de cobertura por archivo |
| **Estado del plan** | `npm run plan:status -- --exigir=…` y `npx tsx scripts/catalogo-estado.ts --check` | Los dos marcadores de la casa, como compuerta y no como informe |
| **Integración contra Postgres** | Servicio `postgres:15`, `npm run migrate`, `npm run test:integration` | La conducta contra una base real |
| **Aislamiento por inquilino** | Servicio propio, aprovisiona roles, migra, siembra, y `scripts/verify-isolation.sh` | Comprobar la RLS **como rol no privilegiado** |

Dos trabajos merecen detalle.

### Estado del plan

Es un **trinquete, no un informe**. Imprime siempre la salida completa —un paquete abierto es información— pero `--exigir` convierte en rojo el **retroceso** de los paquetes ya cerrados. Sin eso, el comando sería otra tabla que nadie mira, que es justo lo que vino a reemplazar. El mecanismo completo, incluida la disciplina de reabrir un paquete en el mismo commit que lo saca de la lista, está en [[El-tablero-y-los-criterios]]. El segundo paso del trabajo verifica el catálogo de comandos y su suelo; ver [[Catalogo-de-comandos]].

### Aislamiento por inquilino

Es el trabajo que más cuidado tiene, y es el único requisito que dos planes distintos levantaron por separado y ninguno había cerrado.

La aplicación conecta como `mnemosine_app`, **no como superusuario**, y ése es el punto entero: corriendo como superusuario la RLS no filtra nada y una política ausente jamás se detectaría. Hay un criterio del tablero que vigila precisamente esa línea del YAML.

El trabajo aprovisiona primero los roles con `psql` —son objetos de nivel clúster, así que no están en la cadena de migraciones, y sin ese paso el bucle de `GRANT` de las políticas no encuentra a quién otorgar y **sale sin hacer nada**—, migra con el dueño del esquema, y **siembra**: `verify-isolation.sh` necesita un inquilino con entidad contra el cual comparar el que él mismo crea, porque sin siembra su primera comprobación compara contra vacío y no prueba nada.

El script comprueba tres fronteras: sin contexto no se ve ninguna entidad, con contexto no se ven entidades de otro inquilino, y una escritura fuera de contexto la rechaza la política de seguridad a nivel de fila. Ver [[Aislamiento-multi-inquilino]].

---

## El trinquete de cobertura, y su alcance real

Esta es la parte donde conviene decir la limitación antes que la virtud, porque descubrirla leyendo `vitest.config.ts` sería peor.

```bash
npm run test:coverage
```

**La cobertura no mide el proyecto. Mide el motor contable.** El `include` es exactamente `src/services/accounting/**` más un archivo suelto, `src/utils/sequence.ts`. Son **17 archivos** de los **267** que tiene `src/`. El resto —el CLI, el agente, la API REST y GraphQL, los servicios fiscales, la nómina, la bóveda— **no aparece en la medición en absoluto**.

El razonamiento está escrito en la configuración y es defendible: medir todo el árbol produce un porcentaje global que baja cuando alguien agrega un archivo y sube cuando lo borra, **y que por eso nadie mira**.

**Y los umbrales no son un porcentaje global, son por archivo.** Hoy hay cuatro:

```ts
thresholds: {
  'src/services/accounting/posting.ts': {
    statements: 99, branches: 95, functions: 100, lines: 99,
  },
  'src/services/accounting/validation.ts': {
    statements: 90, branches: 77, functions: 100, lines: 90,
  },
  'src/services/accounting/ar-ap-posting.ts': {
    statements: 96, branches: 74, functions: 100, lines: 96,
  },
  'src/utils/sequence.ts': {
    statements: 69, branches: 100, functions: 75, lines: 69,
  },
},
```

El argumento contra el umbral global está en el comentario del archivo, y es el mismo que sostiene «el estado de un paquete es el peor de sus criterios»: **un umbral global es un promedio**, y deja que la cobertura de una pieza crítica caiga mientras otra sube. Estos están puestos justo debajo de lo ya medido, así que **no exigen trabajo nuevo y sí impiden la regresión**.

Lo que queda fuera, dicho sin adornos:

- **Trece de los dieciséis archivos** de `src/services/accounting/` no tienen umbral propio. Se miden, se reportan, y su caída no rompe nada.
- **`period-close.ts` no lleva umbral, deliberadamente.** Mide 8 % en esta corrida y el número es engañoso: sus pruebas son de **integración** y esta configuración las excluye. Ponerle un umbral en el proyecto unitario obligaría a duplicar con dobles lo que ya se prueba contra Postgres real.
- **`sequence.ts` está en 69 % contra un objetivo de 100 %.** El trinquete se dejó en lo medido en vez de fingir que el objetivo se cumple. Subirlo es trabajo con nombre, no un número en un archivo de configuración.
- **250 de los 267 archivos de `src/`** no entran en la medición.

Una nota de costo, por si alguien se pregunta por qué el trabajo de unitarias tarda: corre la suite **dos veces**, una desnuda y otra con instrumentación de cobertura.

---

## Los tres trinquetes, juntos

La casa gobierna con trinquetes: instrumentos que no exigen trabajo nuevo pero impiden el retroceso, y cuyo relajamiento tiene que viajar en el diff.

| Trinquete | Dónde vive | Qué congela |
|---|---|---|
| Paquetes cerrados | La lista `--exigir` de `ci.yml` | Un paquete cerrado no puede reabrirse en silencio |
| Suelo del catálogo | `docs/catalogo-minimos.json` | Los comandos invocables solo pueden subir |
| Cobertura por archivo | `vitest.config.ts` | Cuatro archivos del motor no pueden perder cobertura |

Y un cuarto, más chico pero de la misma familia: `--max-warnings 1239` en `package.json`, que congela la deuda de tipado en fronteras.

---

## Lo que la CI no cubre

**Ningún criterio vigila dos de los seis trabajos.** El criterio del tablero exige que exista un solo archivo de workflow y que declare `typecheck`, `unit`, `integration` y `aislamiento`. Los trabajos `lint` y `plan` **no** están en esa lista: borrar el trabajo de lint del YAML no pondría rojo ningún criterio del tablero. La compuerta se caería en silencio.

**La base que el trabajo de integración migra no es la que usan las pruebas.** El trabajo corre `npm run migrate` sobre `mnemosine_test`, y después el `globalSetup` crea su propia base efímera a partir de `TEST_ADMIN_DATABASE_URL` y migra **ésa**. La migración previa no es inútil —falla el trabajo temprano si la cadena no aplica limpio sobre una base vacía— pero no es la base contra la que se prueba, y leer el YAML sin saberlo confunde.

**El plan se evalúa sin base de datos.** El trabajo `plan` no levanta Postgres, así que todo criterio que declare `necesita: 'base-de-datos'` se reporta como no evaluable ahí. Está manejado a propósito —esos criterios no cuentan para `--exigir`— pero significa que la parte del tablero que observa el sistema corriendo **no se comprueba en CI**.

**La suite unitaria no prueba conducta contra base.** Es su definición, no un defecto, pero conviene tenerlo presente al leer un número de cobertura: 99 % de sentencias en `posting.ts` es cobertura contra dobles, no contra Postgres. Lo que prueba el asiento real es `tests/integration/`.

**Las pruebas del tablero no verifican que sus criterios pasen.** `tests/plan/criterios.spec.ts` comprueba que cada criterio tenga enunciado, que su detalle no venga vacío y que los ayudantes se comporten. Un criterio en rojo es información legítima, no una prueba rota — pero eso implica que un criterio puede volverse rojo sin que la suite unitaria se entere.

---

## La consistencia del CLI, que también es una prueba

Vale la pena nombrarla aparte porque no es una prueba de conducta sino de **forma**, y es lo único que mantendrá coherente una superficie de cientos de comandos editada por muchas manos.

`auditProgram`, en `src/cli/kernel/audit.ts`, recorre el árbol de comandos real y rechaza verbos fuera de la lista cerrada de 76, sustantivos en plural, profundidad mayor a 3, el uso de `-f` —que jamás se asigna, porque se lee como `--file` y como `--force` a la vez— y listas sin `--limit` o `--format`.

Un detalle de diseño que conviene copiar: la función **no vive en el archivo de pruebas**. Vivía ahí, y eso hacía que el binario que se embarca no pasara nunca por ella; peor, importarla desde otra prueba arrastraba la suite entera, cuyos `resetDeclarations()` vaciaban el registro de riesgo para el resto del proceso y dejaban el programa real con cero declaraciones. Hoy `tests/cli/kernel/consistency.spec.ts` prueba que cada regla **detecte** lo suyo, y otra prueba comprueba que el programa embarcado las **cumpla**.

El registro de riesgo que ese núcleo sostiene es lo que impide que un comando irreversible nazca invocable por el agente; ver [[El-agente-y-sus-limites]] y [[Seguridad-y-credenciales]].

---

## Para seguir

- [[El-tablero-y-los-criterios]] — el trinquete del plan, y por qué es de granularidad paquete
- [[Catalogo-de-comandos]] — el trinquete del catálogo y sus cinco compuertas
- [[Aislamiento-multi-inquilino]] — qué comprueba exactamente el trabajo de aislamiento
- [[Base-de-datos-y-migraciones]] — la cadena que la suite de integración aplica en cada corrida
- [[Solucion-de-problemas]] — qué hacer cuando la suite de integración se niega a arrancar
- [[Como-contribuir]] — el orden en que fallan las puertas, de la más barata a la más cara
