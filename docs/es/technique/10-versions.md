# 10 — Versiones

[← Índice](README.md)

El bot sabe listar las releases publicadas en GitHub, instalar una junto a la que
está funcionando y cambiar de una a otra sin que se mueva ningún ajuste ni
ninguna lista de reproducción. Todo cabe en
[`src/versioning/`](../../../src/versioning/), cinco módulos y ninguna
dependencia añadida.

---

## Dos raíces

Es la idea de la que se deriva todo lo demás. En desarrollo se confunden; en
cuanto se instala una release, se separan.

| Raíz | Contenido | Valor |
|---|---|---|
| Raíz **compartida** | `.env`, `data/`, `node_modules/`, `versions/` | `process.cwd()` |
| Raíz **de instalación** | el código ejecutado | el repositorio, o `versions/<tag>/` |

Todos los módulos del bot resuelven sus datos desde `process.cwd()` —
`Database`, `auth`, `mediaPaths`, `uploadService`: es la raíz compartida la que
decide dónde están las listas, los ajustes y el testigo del panel de control.

Cambiar de versión se reduce por tanto a ejecutar `versions/<tag>/src/index.js`
**dejando `cwd` en la raíz compartida**: el código cambia, los datos no.

```
raíz compartida/                 ← process.cwd(), y por tanto los datos
├── .env
├── data/                        ajustes, listas, caché, registros
├── node_modules/                dependencias, vistas por todas las versiones
├── src/                         el repositorio de desarrollo — etiqueta «dev»
└── versions/
    ├── v1.4.0/
    │   ├── .imp-version.json    marcador de integridad
    │   └── src/index.js         ← raíz de instalación cuando esta versión corre
    └── v1.5.0/
```

Como Node remonta las carpetas padre en busca de `node_modules`, una release
anidada en la raíz compartida **hereda de paso sus dependencias sin la menor
copia**. No se instala nada mientras la release reclame los mismos paquetes que
la raíz; un `npm install` local solo ocurre cuando la lista diverge, y queda
entonces confinado a la carpeta de la versión.

[`locations.js`](../../../src/versioning/locations.js) es el único módulo que
sabe todo esto, y el único habilitado para decir si una carpeta puede
sobrescribirse o suprimirse. `assertTargetInstallable()` y
`assertTargetRemovable()` son las salvaguardas que ponen el repositorio de
desarrollo — y la versión en ejecución — fuera del alcance tanto del instalador
como de la desinstalación.

`IMP_VERSIONS_DIR` permite trasladar `versions/` a otro sitio, a un disco
secundario o fuera del repositorio. La salvaguarda comprueba de todos modos que
no se solape con el repositorio de desarrollo, sea cual sea su valor.

---

## Qué versión corre

`currentVersion()` devuelve `{ type, tag, packageVersion }`, donde `type` vale
`dev` o `release`. No lo adivina: lee el marcador `.imp-version.json` depositado
en la raíz de cada versión instalada. El marcador sirve dos veces — nombra la
versión, y su ausencia señala una extracción inacabada.

El valor se expone de tres maneras: el banner del registro en el arranque, la
ruta `GET /api/version`, y el pie del cajón del panel de control — de donde se
copia con un gesto.

---

## El catálogo

`catalog()` ensambla lo que muestra el menú desplegable: las releases publicadas,
las que ya están en el disco y la que está corriendo.

**El fallo de la llamada a GitHub no es un error fatal.** Se informa de él en
`error` y el catálogo sigue siendo utilizable, reducido a las versiones ya
presentes en el disco. Sin conexión se puede por tanto volver siempre a una
versión instalada o al desarrollo.

Una versión instalada cuya release ha desaparecido del repositorio sigue siendo
lanzable: se marca como `orphan` y figura igualmente en la lista. Está en el
disco, y el usuario debe poder volver a ella.

[`github.js`](../../../src/versioning/github.js) consulta la API pública. Un
repositorio público se consulta **sin credenciales**: es el modo nominal, y no
hay nada que configurar. Un testigo se acepta igualmente si se encuentra — en
`GITHUB_TOKEN`, luego `GH_TOKEN`, luego en la CLI `gh` si está instalada y
conectada —, lo que cubre el repositorio aún privado y eleva de paso la cuota
horaria de 60 a 5 000 peticiones.

La caché de las releases solo dura veinte segundos, y el menú fuerza su relectura
al abrirse: debe reflejar las releases publicadas en el instante en que el
usuario lo despliega, no las de su apertura anterior.

---

## Instalar

Regla directriz: **nunca se sobrescribe nada que ya esté en su sitio.** Cada
release vive en su propia carpeta `versions/<tag>/`, y una instalación no toca
ninguna otra.

```
listReleases()  ──►  archivo .tar.gz  ──►  .tmp-<azar>/  ──►  versions/<tag>/
                     (300 MB como máx.)    extracción       renombrado final
                                                │
                                                └─ npm install, solo si la lista
                                                   de paquetes diverge
```

Tres consecuencias de esa regla:

- una versión ya instalada no se vuelve a descargar: basta con relanzarla, lo
  que pone la versión en ejecución a salvo de su propia reinstalación;
- el repositorio de desarrollo no es un destino posible — `locations` lo rechaza
  antes de la menor escritura;
- la extracción se hace en una carpeta temporal, renombrada a su destino
  definitivo una vez completa. Una descarga interrumpida no deja por tanto nunca
  una versión a medio instalar, sino un `.tmp-…` que el arranque siguiente
  barre (`cleanTempDirs()`, llamado en `ClientReady`).

Una instalación a la vez: dos descargas concurrentes apuntarían a la misma
carpeta temporal y se disputarían el reinicio. La operación informa de su avance
sobre la marcha, para que el panel muestre algo distinto de una pantalla
congelada.

### Extracción sin dependencia

[`targz.js`](../../../src/versioning/targz.js) descomprime el archivo en memoria
de una vez, y luego lo recorre bloque de 512 bytes a bloque de 512 bytes. Eso
evita añadir una biblioteca al proyecto y, sobre todo, depender de un `tar` del
sistema cuya presencia y dialecto no están garantizados de una máquina a otra.

Dos puntos merecen atención:

- **los nombres largos.** El formato ustar aloja un nombre en 100 bytes,
  completados por un prefijo de 155. Más allá, el archivador emite una entrada
  portadora del nombre real justo antes de la entrada que describe: `L` en GNU,
  `x` (cabecera pax) en los demás. GitHub emplea ambos según los repositorios,
  así que ambos se gestionan;
- **el recorrido de rutas.** Una entrada llamada `../../otro` saldría de la
  carpeta de destino. Cada ruta se resuelve pues y luego se verifica como
  descendiente estricto del destino antes de la menor escritura.

---

## Cambiar

`resolveEntryPoint(tag)` traduce una elección del usuario en archivo que lanzar,
y rechaza una versión que no esté disponible localmente.

El cambio en sí toma prestado el reinicio ordinario (`restartProcess` de
[`systemHandlers.js`](../../../src/web/websocket/handlers/systemHandlers.js)): el
nuevo proceso se lanza **desacoplado**, con `IMP_RESTART=1` en su entorno, y el
antiguo se apaga. Esa variable marca una reanudación y no un encendido — lo que
suprime el fundido de apertura y hace ignorar el canal favorito en beneficio del
último canal visitado (véase [06 — Persistencia](06-persistance.md#database)).

Los tres mensajes WebSocket del dominio — `listVersions`, `installVersion`,
`uninstallVersion` — están **reservados al maestro de sesión**. Cambiar la
versión en ejecución no es una orden de reproducción que se comparta. Véase
[07 — Seguridad](07-securite.md#derechos-compartidos).

---

## En caso de modificación

- No resolver nunca una ruta de datos desde `__dirname`: sería la raíz de
  instalación, y una release instalada escribiría sus ajustes en su propia
  carpeta en lugar de en la raíz compartida.
- Toda escritura o supresión que apunte a `versions/` debe pasar por
  `assertTargetInstallable()` o `assertTargetRemovable()`.
- Un nuevo campo del catálogo debe seguir siendo legible sin conexión: el menú
  funciona sin GitHub, y es una propiedad que no hay que perder.
