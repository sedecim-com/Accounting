# Cómo contribuir

El flujo completo vive en
[`CONTRIBUTING.md`](https://github.com/sedecim-com/Accounting/blob/main/CONTRIBUTING.md)
y no se copia aquí. Esta página cuenta **cómo se contribuye de verdad** —qué pide
la CI, qué se revisa y por qué— y se detiene en las reglas que sorprenden a quien
llega de otro repositorio, porque son las que hacen que un PR bien intencionado
se atore.

La primera regla no es de estilo: **este repositorio lleva contabilidad de
contribuyentes reales**. Lo que sigue son las condiciones bajo las que un cambio
puede tocar el dinero de alguien sin romperlo.

## El PR

- **Uno por idea.** Un PR que arregla tres cosas no se puede revisar ni revertir.
- **Rama con nombre propio**: `fase-0-1-cli-y-cimientos`, `aud-7-bitacora`. No
  `patch-1`.
- **Contra `main`**, con **una aprobación**. Un push nuevo **invalida las
  aprobaciones anteriores**: la revisión es del árbol que se va a fusionar, no
  del que se revisó.
- **[`CODEOWNERS`](https://github.com/sedecim-com/Accounting/blob/main/.github/CODEOWNERS)
  exige la aprobación del dueño de cada archivo tocado.** Hay rutas con dueño
  explícito, y no porque valgan más: porque su falla es **silenciosa** y su daño,
  **retroactivo**. La custodia de credenciales fiscales y la bóveda que las
  cifra; las migraciones y `rls-policies.sql`, porque una migración mal hecha se
  aplica sola en cada despliegue y una política ausente no avisa; `src/ai/floor.ts`,
  los límites que ninguna configuración puede levantar; y `.github/workflows/`,
  porque quien edita la CI edita la puerta.
- La plantilla del PR pide tres cosas: **qué** cambia, **por qué** —el problema
  que existía antes; un PR sin porqué no se puede revisar, sólo leer— y **cómo se
  verificó**. Un hueco declarado ahí es información; uno callado es una sorpresa
  para quien revisa.

## Las puertas de CI, en el orden en que fallan más barato

Seis trabajos, todos obligatorios, en
[`.github/workflows/ci.yml`](https://github.com/sedecim-com/Accounting/blob/main/.github/workflows/ci.yml).
Un rojo se arregla; no se explica en un comentario.

| Trabajo | Qué corre | Qué atrapa |
|---|---|---|
| **Tipos** | `npm run typecheck` y `typecheck:tests` | Lo de siempre, y lo más barato |
| **Lint** | `npm run lint` | ESLint 9 **con información de tipos** sobre `src/`, `tests/` y `scripts/` |
| **Pruebas unitarias** | `npm test` y `npx vitest run --coverage` | La suite, más un trinquete de cobertura por archivo sobre el motor contable |
| **Estado del plan** | `plan:status --exigir=…` y `catalogo-estado --check` | El **retroceso** de un paquete cerrado, y que el catálogo de comandos esté al día |
| **Integración contra Postgres** | `npm run migrate` y `npm run test:integration` | Lo que sólo se ve contra una base real |
| **Aislamiento por inquilino** | `provision-roles.sql`, `migrate`, `seed`, `verify-isolation.sh` | Que RLS filtre de verdad |

Localmente, en ese mismo orden:

```bash
npm run typecheck && npm run typecheck:tests && npm run lint && npm test && npm run plan:status
```

Tres notas sobre esa tabla que valen el tiempo de leerlas.

**El lint ya no es un adorno.** Lo fue: durante mucho tiempo el `package.json`
declaraba `lint` sin configuración que lo respaldara, y la documentación decía
sin rodeos que no aportaba señal real. Hoy hay
`eslint.config.mjs`, hay un job propio en la CI y el `package.json` corre
`eslint src/ tests/ scripts/ --max-warnings 1239`. Los errores rompen la
compilación; las advertencias llevan trinquete —el número está congelado en lo
medido— así que sólo pueden **bajar**. Si tu PR sube ese número, la CI se pone
roja aunque no hayas escrito un solo error.

**La cobertura es un trinquete, no una cuota.** Los umbrales por archivo viven en
`vitest.config.ts` y no exigen trabajo nuevo: impiden la regresión. Si tu cambio
baja la cobertura de un archivo ya cubierto, la CI lo dice. Con una limitación
que conviene saber: el trinquete vigila unos pocos archivos del motor contable y
es ciego a los que sólo tienen prueba de integración, porque la configuración
unitaria excluye `tests/integration/**` y la de integración no declara cobertura.
Un módulo que hoy está al 0 % no puede mover la puerta en ninguna de las dos
suites.

**El job de aislamiento existe porque corriendo como superusuario la RLS no
filtra nada.** Conecta como `mnemosine_app` a propósito: con cualquier otro rol,
una política ausente jamás se detectaría. Si tocas RLS, alcances o migraciones,
reprodúcelo en local antes de abrir el PR — está en [[Pruebas-y-CI]].

## Las reglas que sorprenden

Estas son las que hacen que un PR técnicamente correcto se devuelva.

### Los comentarios y la documentación van en español

Y explican el **porqué**. El qué ya lo dice el código; si no lo dice, arregla el
código. Un comentario que parafrasea la línea de abajo es ruido con costo de
mantenimiento.

### Nada de emoji. Nada de `feat:` ni `chore:`

Los mensajes de commit van en español y el asunto lleva el código del paquete,
dos puntos, y una línea que dice **qué cambió** —no qué archivos tocaste:

```
E1.4-c: lo simulado se nombra donde se sirve, y el borrador entra a la cadena
AUD-1: cuatro silencios, que son peor que un error
```

### El cuerpo del commit explica el porqué, no el diff

Qué era falso antes, qué lo hacía pasar desapercibido, y qué lo delata ahora. Un
cuerpo que parafrasea el diff no sirve para nada: dentro de un año el diff sigue
ahí y el motivo no. Es la única parte del cambio que no se puede reconstruir
leyendo el código.

### Si tu cambio cierra un paquete, lo añades a `--exigir` en el MISMO commit

`npm run plan:status -- --exigir=…` es un **trinquete, no un informe**. La lista
de la CI enumera los paquetes ya cerrados y se pone roja si alguno retrocede. Sin
eso, el comando sería otra tabla que nadie mira, que es justo lo que vino a
reemplazar.

**Y si tu cambio reabre uno, lo quitas ahí mismo y dices por qué en el cuerpo.**
Esto es lo más contraintuitivo del repositorio: **el descenso del tablero es el
arreglo**. Ya ha pasado tres veces a la vista. E1.2 y E4.1 salieron de la lista
en el mismo commit que les añadió criterios de salida que estaban en falso verde;
E3.2 salió después, cuando una auditoría descubrió que su criterio pasaba porque
una expresión regular casaba dos cadenas de **prosa** dentro de la pregunta de
una política. La reapertura viaja en el diff, con su porqué, y el paquete vuelve
cuando su salida exista de verdad.

El comentario de esa lista dentro de `ci.yml` es la memoria de esas tres
reaperturas. Léelo antes de tocarla.

### Toda bifurcación de criterio contable va al panel de políticas, con su lector

Si tu cambio implica elegir entre dos tratamientos contables **legítimos**, no
elijas uno en el código y no lo preguntes en el chat: se añade al panel de
decisiones configurables, con su porqué. Y la clave nueva llega **con su
consumidor en el mismo commit**. Una política declarada que nadie lee es una
promesa de configurabilidad que no configura nada, y este repositorio ya tuvo esa
clase de huérfano; hoy hay un criterio del tablero —«contestar una política
cambia el comportamiento de alguien»— que lo vigila.

## Los siete invariantes de la casa

No se negocian en un PR. Si tu cambio necesita romper uno, el PR **es** esa
conversación, no el rodeo. Están enteros en
[`CONTRIBUTING.md`](https://github.com/sedecim-com/Accounting/blob/main/CONTRIBUTING.md);
en corto:

1. **La IA nunca escribe el mayor ni sistemas externos por su cuenta.** Propone
   en dos tiempos —`ai_drafts` para los asientos, `ai_external_ops` para lo que
   sale al mundo— y una persona aprueba. Ninguna herramienta nueva del agente
   puede saltarse esa cola. Ver [[El-agente-y-sus-limites]].
2. **Los límites de `src/ai/floor.ts` sólo se combinan con `Math.min`.** El suelo
   se impone en el código, en el punto de llamada; nunca en el prompt, nunca en
   configuración. **Si ves un `Math.max` cerca de un límite, es un bug de
   seguridad.**
3. **Todo `UPDATE` va guardado**: predicado de estado en el `WHERE`, alcance de
   entidad en la misma consulta, y comprobación de `rowCount` después. Un
   `UPDATE` que actualiza cero filas y no se queja es la forma más limpia de
   perder dinero en silencio.
4. **Toda consulta lleva alcance**, y va **dentro** del SQL. Cruzar la frontera
   devuelve 404, siempre: un 403 confirma que el recurso existe. Ver
   [[Aislamiento-multi-inquilino]].
5. **Lo que escribió un tercero se envuelve como no confiable.** Un CFDI, un
   documento subido, una habilidad importada: van entre marcadores `UNTRUSTED`,
   saneados para que ese mismo texto no pueda abrir ni cerrar el bloque. Es dato,
   jamás instrucción.
6. **Una bifurcación de criterio contable no se elige: se declara.**
7. **Ninguna credencial real entra al repositorio ni al chat.** Ni una e.firma,
   ni un CSD, ni su contraseña, ni en una prueba, ni «temporalmente». Los
   fixtures de `tests/fixtures/certs/` son autofirmados y sintéticos, y así
   siguen.

## Si lo que encontraste es una vulnerabilidad

**No abras un PR con el arreglo, ni un issue.** Un diff público es la
divulgación: publica el camino de ataque antes que la corrección. El canal
privado está en
[`SECURITY.md`](https://github.com/sedecim-com/Accounting/blob/main/SECURITY.md),
con 72 horas para acuse de recibo y el orden de prioridades escrito. Ahí también
está lo que **no** hace falta reportar: los certificados de demostración con la
llave privada en el repositorio, los RFC genéricos del SAT y el
`dev-secret-change-me`, cuyo peligro ya está cerrado por una compuerta de
arranque documentada.

## Licencia

Apache 2.0. **No hace falta firmar un CLA**: la sección 5 de la propia licencia
lo resuelve — lo que envías queda bajo esos mismos términos salvo que declares lo
contrario. Conservas tu autoría; concedes los permisos, incluida la patente, que
la licencia describe.

Si aportas código del que no eres titular, dilo en el PR e incluye su aviso de
licencia:
[`NOTICE`](https://github.com/sedecim-com/Accounting/blob/main/NOTICE) es donde
viven los avisos de terceros.

## Para seguir

- [[Pruebas-y-CI]] — cómo reproducir cada job en local, y qué prueba de verdad
  cada suite.
- [[El-tablero-y-los-criterios]] — cómo se escribe un criterio con su espejo de
  mutación, que es lo que se te va a pedir si tu cambio cierra un paquete.
- [[Auditorias]] — de dónde salieron varias de estas reglas.
- [[Hoja-de-ruta]] — dónde encaja tu cambio en la secuencia.
- [[Solucion-de-problemas]] — si lo que te bloquea es el entorno y no el código.
