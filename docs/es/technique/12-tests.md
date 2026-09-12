# 12 — Pruebas

[← Índice](README.md)

Cincuenta baterías viven en [`tests/`](../../../tests/), todas lanzadas por
`npm test`. No siguen ningún marco de pruebas: son scripts Node corrientes, que
se ejecutan y devuelven un código de salida.

---

## El partido tomado

**Ninguna dependencia de prueba.** Ni Jest, ni Mocha, ni `node:test`. Cada
batería es un archivo que cuenta sus aciertos y sus fallos, los imprime y luego
sale con `0` o con `1`:

```js
let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// …

console.log(`=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
```

Es coherente con el resto del proyecto — nada se transpila, nada se ensambla — y
responde a una restricción real: lo esencial de lo que hay que comprobar aquí es
JavaScript de navegador servido sin módulos, que se comunica mediante
`window.MusicPlayer`. Un marco que supone importaciones ES no tendría nada que
hacer con ello. Las baterías de frontend cargan por tanto el archivo, lo evalúan
en un contexto preparado a mano y miran lo que deja.

**Una batería cuenta por qué existe.** La cabecera de cada archivo describe el
defecto que atrapa, y lo que ese defecto costó. Es la parte que merece leerse
primero cuando una batería cae: a menudo dice directamente lo que se acaba de
romper.

---

## Las tres familias

| Familia | Lo que se comprueba | Ejemplos |
|---|---|---|
| **Unitarias** | Una función, sin nada alrededor | `loudness`, `downloadFormats`, `historyOrder`, `rangeStream` |
| **De comportamiento** | Un módulo del lado servidor, con dobles | `channelQueue`, `transitions`, `pilotElection`, `shareGrant` |
| **Frontend** | Un script de `public/js/`, evaluado en un contexto ficticio | `speedPadPointer`, `toastSwipe`, `scrollFade`, `themeBlend` |

A lo que se añaden dos baterías que no versan sobre el código de la aplicación:
`docsIntegrity` y `docsLanguages`, descritas más abajo.

---

## La prueba de humo

[`tests/smoke.js`](../../../tests/smoke.js) es la única que arranca el bot de
verdad. Procede en dos pisos, del más barato al más caro:

1. **Carga** — cada módulo de `src/` se requiere. Atrapa los `require()` rotos,
   las exportaciones desaparecidas y los errores de sintaxis. Los dos puntos de
   entrada (`src/index.js`, `src/deploy-commands.js`) quedan excluidos: cargarlos
   arrancaría el bot.
2. **Integración** — el bot se arranca y luego se interroga en HTTP y en
   WebSocket. Atrapa lo que la carga no ve: un campo del protocolo renombrado de
   un solo lado, una ruta que ya no responde.

Lleva una lista `STATE_FIELDS` de los campos de primer nivel del mensaje `state`.
**Hay que actualizarla a sabiendas** cuando se renombra un campo del protocolo —
es precisamente el tipo de olvido que esta prueba existe para atrapar, pues un
renombrado hecho de un solo lado no produce ningún error, solo una visualización
vacía.

> La prueba de humo necesita el puerto del panel de control. Si el bot ya está
> corriendo en la máquina, su piso de integración falla por un puerto ocupado:
> no es una regresión, es el entorno. Apagar la instancia en curso antes de
> lanzarla.

---

## Las dos baterías de documentación

Guardan este mismo corpus, y merecen conocerse antes de tocarlo.

[`docsIntegrity.js`](../../../tests/docsIntegrity.js) verifica tres cosas que se
rompen en silencio y que ninguna relectura de una traducción muestra:

- **Las anclas.** Un enlace hacia `05-tableau-de-bord.md#robustez` designa un
  título. Traducir el título sin traducir el ancla, o al revés, da un enlace que
  no lleva a ninguna parte — solo en ese idioma. El cálculo del ancla reproduce
  el de `js/docs.js`, que sigue la convención de GitHub.
- **La armazón.** Una traducción debe tener **tantos títulos, bloques de código y
  filas de tabla** como su original francés. Una diferencia señala una sección
  olvidada o una tabla truncada, cosa que un archivo de 15 KB no muestra.
- **Los enlaces al código.** Atraviesan `docs/<idioma>/technique/` para remontar
  a `src/`. Desplazar la documentación un nivel los rompe todos a la vez, sin que
  nada lo señale: son enlaces de repositorio, que el lector del panel ni siquiera
  abre.

[`docsLanguages.js`](../../../tests/docsLanguages.js) monta el verdadero
enrutador de API en un puerto efímero y verifica el servicio: el inventario parte
de `docs/<idioma>/` y nunca de `docs/`, los identificadores no llevan el idioma,
y nada de lo que viene del cliente se ensambla en ruta.

**Consecuencia práctica.** Toda modificación de la documentación francesa debe
repercutirse en las tres traducciones con la **misma armazón**: el mismo número
de títulos, de bloques de código y de filas de tabla. Añadir una fila a una tabla
francesa sin añadirla a las otras tres hace caer `docsIntegrity`.

---

## Lanzar las pruebas

| Orden | Efecto |
|---|---|
| `npm test` | Las cincuenta baterías, en fila. Se detiene en la primera que falla. |
| `npm run smoke` | Solo la prueba de humo |
| `npm run test:<nombre>` | Una batería concreta — un script por batería en `package.json` |

El encadenamiento de `npm test` se hace con `&&`: la primera batería que sale con
`1` interrumpe el resto. Es lo querido — una regresión transversal haría caer
treinta baterías, y leer la primera es más útil que desplazarse por las demás.

---

## Escribir una batería

1. Crear `tests/<nombre>.js`.
2. En cabecera, describir **el defecto que la batería atrapa** y lo que costó. No
   lo que hace el código: lo que se rompía sin ella.
3. Retomar el contador `check()` de más arriba, y salir con
   `process.exit(failed === 0 ? 0 : 1)`.
4. Añadir `"test:<nombre>": "node tests/<nombre>.js"` en `package.json`, **y**
   insertarlo en la cadena del script `test`. Ambas cosas: el script individual
   sirve para el desarrollo, la cadena para la verificación de conjunto.

Una batería que necesita el servidor monta el enrutador verdadero en un puerto
efímero (`server.listen(0, '127.0.0.1')`) con un `webServer` ficticio, como hace
`docsLanguages`. Arrancar el bot entero solo es necesario para la prueba de humo.
