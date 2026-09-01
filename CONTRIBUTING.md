# Cómo contribuir

Este repositorio lleva contabilidad de contribuyentes reales. Las reglas de
abajo no son estilo: son las condiciones bajo las que un cambio puede tocar el
dinero de alguien sin romperlo.

Lee también [SECURITY.md](SECURITY.md). Si lo que encontraste es una
vulnerabilidad, **no abras un PR con el arreglo**: repórtala en privado
primero, porque un diff público es la divulgación.

## Levantar el proyecto

Node 20 o superior (`engines` lo exige) y Postgres 15 para la suite de
integración.

```bash
npm ci
```

## Las puertas, en el orden en que fallan más barato

```bash
npm run typecheck          # tsc --noEmit sobre src/
npm run typecheck:tests    # tsc -p tsconfig.test.json --noEmit
npm test                   # vitest run (unitarias)
npm run plan:status        # el estado del plan no se escribe: se pregunta
```

El estado de un paquete de trabajo **nunca se afirma a mano en prosa**. Se
consulta con `npm run plan:status`, que lo deriva de criterios comprobables. La
CI corre además `npm run plan:status -- --exigir=...` sobre la lista de
paquetes ya cerrados: es un trinquete, no un informe. Ese comando se pone rojo
si algo que estaba cerrado retrocede.

`npm run lint` existe en el `package.json`, pero hoy no aporta señal real. Las
puertas de verdad son las cuatro de arriba, más las de integración.

### Cobertura

`npm test` no basta para la CI: el job de unitarias corre también
`npx vitest run --coverage`, con umbrales por archivo sobre el motor contable
declarados en `vitest.config.ts`. No exigen trabajo nuevo; impiden la regresión.
Si tu cambio baja la cobertura de un archivo cubierto, la CI lo dirá.

### Integración (necesita Postgres)

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemosine_test
export MIGRATION_DATABASE_URL="$DATABASE_URL"
# Un rol con permiso de CREATE DATABASE: el global-setup crea y destruye una
# base efímera por corrida. Sin esta variable la suite se niega a arrancar.
export TEST_ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

npm run migrate
npm run test:integration
```

Corre en serie a propósito: varias pruebas cuentan filas sobre una base
compartida.

### Aislamiento por inquilino

La CI tiene un job aparte porque **corriendo como superusuario la RLS no filtra
nada**: una política ausente jamás se detectaría. La aplicación conecta como el
rol `mnemosine_app`. Si tocas RLS, alcances o migraciones, reproduce ese job
localmente:

```bash
psql "$SUPERUSER_URL" -v app_pw=... -v owner_pw=... -f scripts/provision-roles.sql
npm run migrate      # con MIGRATION_DATABASE_URL: las migraciones sí necesitan al dueño
npm run seed
bash scripts/verify-isolation.sh
```

## Flujo de trabajo

1. Haz fork y crea una rama con nombre propio (`fase-0-1-cli-y-cimientos`,
   `aud-7-bitacora`, no `patch-1`).
2. Un PR por idea. Un PR que arregla tres cosas no se puede revisar ni revertir.
3. PR contra `main`. Se exige **1 aprobación**, y los pushes nuevos invalidan
   las aprobaciones anteriores.
4. La CI debe estar en verde: **Tipos**, **Pruebas unitarias**, **Integración
   contra Postgres**, **Aislamiento por inquilino** y **Estado del plan**. Un
   rojo se arregla, no se explica en un comentario.
5. Si el cambio cierra un paquete del plan, añádelo a la lista `--exigir` de
   `.github/workflows/ci.yml` **en el mismo commit que lo cierra**. Si reabre
   uno, quítalo de la lista ahí mismo y di por qué en el cuerpo: la reapertura
   viaja en el diff, a la vista.

## Mensajes de commit

En español. El asunto lleva el código del paquete, dos puntos, y una línea que
dice **qué cambió** — no qué archivos tocaste:

```
E1.4-c: lo simulado se nombra donde se sirve, y el borrador entra a la cadena
CLI-5: el agente vuelve a saber qué comandos existen
AUD-1: cuatro silencios, que son peor que un error
IVA-5 (cableado): el REP deja de morir como nota de crédito
```

El cuerpo explica **por qué**: qué era falso antes, qué lo hacía pasar
desapercibido, y qué lo delata ahora. Un cuerpo que parafrasea el diff no sirve
para nada; dentro de un año el diff sigue ahí y el motivo no.

Nada de emoji. Nada de `feat:` ni `chore:`.

## Los invariantes de la casa

Estos no se negocian en un PR. Si tu cambio necesita romper uno, el PR es esa
conversación — no el rodeo.

**1. La IA nunca escribe el mayor ni sistemas externos por su cuenta.**
Propone en dos tiempos: `ai_drafts` para los asientos, `ai_external_ops` para
todo lo que sale al mundo (timbrar, enviar, pagar). Una persona aprueba, y la
aprobación es un registro con integridad, no una bandera. Ninguna herramienta
nueva del agente puede saltarse esa cola.

**2. Los límites de `src/ai/floor.ts` sólo se combinan con `Math.min`.**
El suelo se impone **en el código, en el punto de llamada** — nunca en el
prompt, nunca en configuración. Ningún fichero de umbrales, política guardada,
bandera de la CLI ni regla futura de «aprobar siempre» puede subirlo. Si ves un
`Math.max` cerca de un límite, es un bug de seguridad.

**3. Todo `UPDATE` va guardado.**
Predicado de estado en el `WHERE` (`... AND status = 'pendiente'`), alcance de
entidad en la misma consulta, y comprobación de `rowCount` después. Un `UPDATE`
que actualiza cero filas y no se queja es la forma más limpia de perder dinero
en silencio.

**4. Toda consulta lleva alcance.**
`entity_id` (y el `tenant_id` que le corresponde) va **dentro del SQL**, no en
un filtro posterior en TypeScript. Usa los ayudantes de
`src/database/scope.ts`. Cruzar la frontera devuelve 404, siempre: un 403
confirma que el recurso existe.

**5. Lo que escribió un tercero se envuelve como no confiable.**
El contenido de un CFDI, de un documento subido o de una habilidad importada va
entre marcadores `UNTRUSTED`, saneado para que ese mismo texto no pueda abrir
ni cerrar el bloque. Es dato, jamás instrucción.

**6. Una bifurcación de criterio contable no se elige: se declara.**
Si tu cambio implica decidir entre dos tratamientos contables legítimos, no
elijas uno en el código ni preguntes en el chat. Se añade al panel de decisiones
configurables, con su porqué.

**7. Ninguna credencial real entra al repositorio ni al chat.**
Ni una e.firma, ni un CSD, ni su contraseña, ni en una prueba, ni «temporalmente».
Los fixtures de `tests/fixtures/certs/` son autofirmados y sintéticos, y así
siguen.

## Documentación

Los comentarios y la documentación van en español, y explican el **porqué**. El
qué ya lo dice el código; si no lo dice, arregla el código.

## Licencia de lo que aportas

El proyecto se distribuye bajo la **Licencia Apache 2.0** (ver [LICENSE](LICENSE)).

No hace falta firmar un CLA. La propia licencia lo resuelve en su sección 5: lo
que envías como contribución a este repositorio queda bajo esos mismos términos,
salvo que declares lo contrario de forma explícita. Conservas tu autoría y tus
derechos; concedes los permisos —incluida la patente— que la licencia describe.

Si aportas código del que no eres titular, dilo en el PR e incluye su aviso de
licencia. Apache 2.0 exige preservar los avisos de terceros: el archivo
[NOTICE](NOTICE) es donde viven.
