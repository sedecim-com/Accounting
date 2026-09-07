# Auditoría adversarial de T3a «La frontera de inquilino» (#90)

**Objeto:** `--tenant` se aceptaba y se ignoraba, y la precedencia publicada
—bandera > entorno > config— estaba invertida justo en la bandera que gobierna
el RLS.
**Fecha:** 2026-09-07.
**Método:** censo sobre el binario real → tres motores en paralelo → un
verificador adversarial por pieza. T3 tiene cinco defectos; **este tramo cierra
sólo el primero** (ver «Lo que no entra»).

## El diagnóstico que traía el issue era medio, y el mío también

Yo medí esto y concluí que «el valor no llega a la base»:

```
entity list --tenant <ceros>     → 3 filas del inquilino del .env
mnemosine -T <ceros> entity list → 3 filas
MNEMOSINE_TENANT=basura          → 0 filas    (el entorno SÍ manda)
```

**Era falso.** El valor llega, el gancho lo aplica, y **la hoja lo pisa**:

```
mnemosine -T <ceros> entities     → «No active entities in this tenant.»   ← el gancho funciona
mnemosine -T <ceros> entity list  → 3 filas                                ← la hoja lo deshace
```

Mismo proceso, misma bandera, **una línea de diferencia**: `entities` no vuelve
a llamar a `bootstrapTenant`; `entity list` sí (`entity-command.ts:93`).

Son **dos averías encajadas**:

**1 · `--tenant` y `-t` no eran dos grafías de una bandera: eran dos banderas.**
La raíz declara `-T, --tenant`; 199 hojas declaran `-t, --tenant`. El
`parseOptions` de la raíz recorre la línea entera antes de despachar y su
`_findOption('--tenant')` acierta, así que **la forma larga se la queda la
raíz**, la teclee quien la teclee. La corta `-t` no la reconoce —el corto de la
raíz es `-T` y la comparación distingue mayúsculas—, así que viaja como
desconocida y **la reclama la hoja**. Por eso `-t <uuid>` funcionaba siempre y
`--tenant <uuid>` no funcionaba nunca.

**2 · El `||`.** `bootstrapTenant(tenantFlag)` era
`tenantFlag || process.env.MNEMOSINE_TENANT`. Con `opts.tenant` undefined en las
81 llamadas, ese `undefined` no significaba «no me han dicho nada»: era una
**orden** de usar el entorno. El entorno no ganaba por omisión — ganaba pisando.

## La reparación

No toca las 199 hojas ni `kernel/flags.ts` (territorio de otra sesión). Dos
cambios:

- **`bootstrapTenant` deja de degradar.** Un valor explícito manda; la ausencia
  re-entra lo que la raíz ya resolvió y no consulta el entorno. Los 81 sitios
  quedan arreglados sin abrirlos.
- **La raíz resuelve una vez**, recogiendo las tres grafías (`-T` antes,
  `--tenant` después, `-t` después).

La medición que cierra el caso, sobre `account list` —una hoja que **nunca** usó
`globalsOf`—:

| | antes | ahora |
|---|---|---|
| sin bandera | 50 cuentas · exit 0 | 50 cuentas · exit 0 |
| `--tenant <otro despacho>` | **50 cuentas · exit 0** | **exit 1** |
| `-T <otro despacho>` | **50 cuentas · exit 0** | **exit 1** |

Publicar la balanza del despacho A rotulada como la que se pidió para B ya no
ocurre.

## Lo que el adversarial tumbó, y cómo quedó

Resistió el ataque central —no consiguió que la bandera volviera a ignorarse—,
pero encontró seis cosas. Las seis se arreglaron:

1. **`mnemosine init` seguía leyendo el entorno por su cuenta** y creaba la
   sociedad bajo el inquilino del `.env` aunque se pidiera otro. Ahora usa el
   inquilino efectivo.
2. **Dos reglas de precedencia contrarias en el mismo parche**: el gancho
   rotulaba con el valor de la raíz (`optsWithGlobals` da globales sobre
   locales) y la consulta corría con el de la hoja. Una sola regla: manda la
   hoja. Y si se teclean las dos grafías con valores distintos, **se dice** en
   vez de elegir por dentro.
3. **La comprobación de existencia sólo miraba la bandera** — justo el escalón
   que el README manda usar quedaba mudo. Ahora mira todos.
4. **El tercer escalón no honraba la precedencia**: `loadConfigFile` devuelve el
   primer *fichero* que existe, no una mezcla, así que un config de proyecto que
   sólo fijara `language` anulaba el `tenant` del de usuario. Ahora se resuelve
   **por clave**.
5. **Efecto secundario en todos los comandos**: leer la config pasaba por
   `quarantineInvalidConfig`, que **escribe** una copia `.rejected-<hash>`. Un
   comando que nunca tocaba la configuración dejaba un fichero nuevo en el árbol
   del usuario y callaba. Ahora se lee sin ese camino.
6. **El criterio no venía en el parche.** Se escribió aquí.

## Tres cosas que se aprendieron arreglándolo

**Un instrumento de aviso no puede cambiar el desenlace de lo que observa.**
La comprobación de existencia corre en el gancho, **antes** de que la hoja valide
sus argumentos. Al principio dejaba escapar el fallo de conexión, y entonces
`usage --since 7w` —un error de USO, que debe salir 2 sin tocar la base— salía 1
por no poder conectar. Siete pruebas lo cazaron. `estadoDelInquilino` calla ante
permiso denegado, tabla ausente y **base inalcanzable**; ante cualquier otro
motivo sí lanza, porque tragarse un fallo genuino la dejaría muda para siempre.

**Duro para lo que se tecleó, ruidoso para lo que se heredó.** Hacer fallar
también al escalón del entorno rompió 76 pruebas cuyas fixtures usan inquilinos
ficticios. La bandera es donde vive la errata —se escribió hace un segundo— y
ahí se falla; un `.env` que sobrevive a un re-seed es una **condición** del
despliegue, y convertirla en muerte súbita deja al operador sin poder correr ni
las lecturas con que averiguaría qué pasó. Ahí se avisa por stderr y se sigue.
Y `init` y `doctor` quedan exentos: son los comandos a los que se acude cuando
el inquilino está mal, y tumbarlos cierra el único camino de salida.

**Una prueba puede afirmar el principio correcto con el ejemplar equivocado.**
`context.spec.ts` usaba el código `08006` como ejemplo de «error desconocido que
debe propagarse»… y `08006` es `connection_failure`, justo la familia que tiene
que callarse. Se cambió por un error de sintaxis.

## El criterio, y las dos anclas que se pagaron

`E2.1 · El inquilino que se pide es el inquilino que se consulta, y una hoja no
puede deshacerlo`. Cinco espejos, los cinco mueren.

Dos anclas mal puestas costaron una vuelta cada una, y las dos son la misma
lección —**anclar en la línea que el mutante toca, no en un símbolo cercano**:

- perseguir `tenantFlag || process.env…` dejaba pasar el mismo defecto escrito
  con `??`. Se ancla en `const pedido = limpio(tenantFlag);`, que es la línea que
  decide.
- mirar si aparece `SIN_COMPROBAR_INQUILINO` no veía al mutante que deja la
  constante en pie y estrecha el `if`. Y buscar `if (inquilino.tenantId`
  agarraba **otra** guarda —la del validador de uuid, que va antes en el
  archivo—, con lo que el criterio se ponía rojo por su propio arreglo.

## Lo que NO entra

T3 tiene cinco defectos. Éste cierra el primero. Los otros cuatro quedan, con su
trabajo hecho y su adversarial en contra:

- **R11 y la llave de idempotencia.** El núcleo muerde —el cruce del ámbito
  declarado contra el fuente no se puede fingir—, pero su adversarial lo tumbó:
  `receipt record --on-account` se acusa de reuso en vez de devolver el resultado
  grabado, la llave se consulta demasiado tarde para el reintento más común, el
  manual del agente quedó sin regenerar, y **su criterio es un ancla de texto**,
  que es literalmente el defecto que el tramo repara.
- **La salida que miente.** El arreglo funciona y está medido, pero el parche
  **introduce una regresión**: `emit('')` en la rama de cero filas trunca el
  archivo, y `cfdi show` hace dos `render` consecutivos.

Van a tramo propio con esas correcciones, no aquí a medias.

## Batería

247 archivos y 5 267 pruebas unitarias · 87 y 1 188 de integración · 125
mutantes, todos muertos · piso y `--exigir` en verde · lint 1119/1161.
