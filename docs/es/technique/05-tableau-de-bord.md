# 05 — Panel de control

[← Índice](README.md)

El panel de control es una aplicación web servida por el propio bot. Gobierna la
reproducción en tiempo real y duplica la totalidad de los comandos de Discord.

---

## Servidor

[`WebServer.js`](../../../src/web/WebServer.js) es un singleton que ensambla:

- un servidor **HTTP** Express: archivos estáticos y rutas `/api/*`;
- un servidor **WebSocket** (`ws`) que comparte el mismo puerto;
- la agregación del estado completo (`getState`) y su difusión.

La escucha se hace en `HOST:PORT`, **`127.0.0.1:3000` de manera
predeterminada**. En el arranque, el navegador se abre automáticamente al cabo
de 5 segundos si no hay ningún cliente conectado, en una URL que contiene el
testigo de acceso.

### Reparto de responsabilidades

| Archivo | Función |
|---|---|
| [`WebServer.js`](../../../src/web/WebServer.js) | Ciclo de vida, agregación de estado, difusión |
| [`auth.js`](../../../src/web/auth.js) | Testigo de acceso HTTP y WebSocket |
| [`oauth.js`](../../../src/web/oauth.js), [`sessions.js`](../../../src/web/sessions.js) | Recorrido OAuth de Discord, sesiones de pestaña |
| [`owner.js`](../../../src/web/owner.js), [`guests.js`](../../../src/web/guests.js) | Propietario de la instalación, libro de invitados |
| [`permissions.js`](../../../src/web/permissions.js) | Lo que un invitado tiene derecho a hacer |
| [`tailscale.js`](../../../src/web/tailscale.js) | Publicación del panel en internet |
| [`routes/api.js`](../../../src/web/routes/api.js) | Rutas HTTP |
| [`routes/auth.js`](../../../src/web/routes/auth.js) | Recorrido de autenticación de un invitado |
| [`uploadService.js`](../../../src/web/uploadService.js) | Recepción e integración de las importaciones |
| [`websocket/wsHandler.js`](../../../src/web/websocket/wsHandler.js) | Enrutador de mensajes |
| [`websocket/handlers/`](../../../src/web/websocket/handlers/) | Lógica de negocio, un módulo por dominio |

---

## Rutas HTTP

Todas están protegidas por el testigo ([07 — Seguridad](07-securite.md)).

| Ruta | Función |
|---|---|
| `GET /api/state` | Estado completo, como recurso si el WebSocket no está disponible |
| `GET /api/invite` | Enlace de invitación del bot a un nuevo servidor de Discord |
| `GET /api/stream` | Flujo de audio de una pista, para el reproductor del navegador |
| `GET /api/download` | Descarga transcodificada, 32 combinaciones formato/calidad (MP3, M4A, FLAC, WAV, OGG, OPUS, WEBM, MP4) |
| `GET /api/video-info` | Resolución de una URL de vídeo mediante yt-dlp, caché en memoria de una hora |
| `POST /api/upload` | Importación de archivo, flujo en bruto con cabecera `X-File-Name` |
| `GET /api/docs` | Índice de la documentación embebida, en el idioma pedido |
| `GET /api/docs/content` | Fuente Markdown de un documento, designado por su identificador y su idioma |
| `GET /api/download-dir` | Carpeta de descarga actual, y el valor por defecto con el que se compara |
| `POST /api/download-dir` | Elección de la carpeta, validada antes de retenerse; cuerpo vacío para volver al valor por defecto |
| `GET /api/browse-dirs` | Subcarpetas de una ruta de la máquina anfitriona, para el selector |
| `GET /api/version` | Versión en ejecución — `dev` o la etiqueta de la release |
| `GET /api/clients` | Número de paneles conectados, y dirección en la que abrir el panel; consultado por la ventana de lanzamiento |

`/api/docs` inventaría `docs/` en cada llamada, desde la **versión en curso de
ejecución** y no desde la raíz compartida: la documentación mostrada es, pues, la
del código que está funcionando. Los identificadores devueltos forman la lista
blanca del servicio de contenido — este nunca construye una ruta a partir de la
petición, busca el identificador en el inventario que acaba de establecer. Eso es
lo que deja un ascenso de carpeta fuera de lugar en vez de fuera de la ley.

Ambas rutas aceptan un parámetro `lang`, el del panel de control: `docs/` está
ordenado por idioma — `docs/fr/`, `docs/en/`… —, los identificadores siguen
siendo los mismos en todas partes, y el lector nunca pide otra cosa que el idioma
de su interfaz. El valor recibido recibe el mismo trato que el identificador: se
compara con las carpetas que el propio servidor ha leído, jamás se ensambla en
una ruta. El inventario parte de la carpeta del idioma retenido, y **nunca de
`docs/`**: recorrido desde la raíz compartida, el árbol devolvería las propias
carpetas de idioma como otros tantos grupos, y el índice del lector se
convertiría en un selector de idioma — cuando el idioma solo se elige en los
ajustes. Un idioma ausente de `docs/` recae en el francés, en bloque.

`/api/invite` ensambla la dirección desde la aplicación realmente conectada
(`client.generateInvite`, alcances `bot` y `applications.commands`): un
identificador escrito a mano en la página acaba designando otra aplicación, y
Discord responde entonces «aplicación desconocida». Es una ruta HTTP y no un
campo del estado, pues `/api/state` se niega a responder mientras el bot no se
haya unido a ningún servidor — precisamente el caso en que este enlace es el
único recurso.

`/api/stream` sirve, por orden: el archivo de caché de precarga si existe, si no
el archivo local si está bajo una raíz autorizada, y si no una transcodificación
MP3 al vuelo del flujo remoto.

### Peticiones Range

Las dos primeras ramas pasan por `serveFileWithRange()`, que responde
`206 Partial Content` con el `Content-Range` correcto, acota los finales fuera de
límites, gestiona la forma de sufijo (`bytes=-500`), y devuelve `416` ante un
rango inalcanzable. Un rango ilegible se ignora: se sirve el archivo entero.

**Esto es indispensable para desplazarse dentro de la pista.** Sin respuesta
`206`, el navegador debe descargar desde el principio para alcanzar la posición
pedida. La rama de la caché de precarga anunciaba `Accept-Ranges: bytes` mientras
ignoraba la cabecera `Range`: al recargar el panel de control, la reproducción
solo se reanudaba una vez que la descarga había llegado a la posición registrada.

La transcodificación remota, en cambio, es intrínsecamente secuencial
(`Transfer-Encoding: chunked`) y no puede honrar ningún rango — razón de más para
que la precarga alimente la caché.

### Rutas de autenticación

Cuatro rutas escapan al prefijo `/api` y las lleva
[`routes/auth.js`](../../../src/web/routes/auth.js):

| Ruta | Función |
|---|---|
| `GET /auth/discord` | Salida hacia `discord.com`, testigo constatado y guardado en el `state` |
| `GET /auth/discord/callback` | Regreso de Discord: código canjeado, sesión abierta, vuelta al panel |
| `GET /auth/state` | Quién está conectado en esta pestaña, y qué tiene derecho a hacer |
| `POST /auth/logout` | Cierra la sesión de esta pestaña |

Las dos primeras están **abiertas sin testigo** (`PUBLIC_PATHS` en
[`auth.js`](../../../src/web/auth.js)): quien pulsa el enlace publicado en el
chat del canal de voz no tiene por definición nada con lo que autenticarse, que
es justamente lo que viene a buscar. Véase
[07 — Seguridad](07-securite.md#autenticación).

---

## Protocolo WebSocket

### Mensajes servidor → cliente

| Tipo | Carga útil |
|---|---|
| `state` | Estado completo (véase más abajo), emitido ante un evento |
| `progress` | `{ progress, isPlaying, isPaused, botStats }` — emitido cada segundo, ~200 bytes |
| `log` | Una entrada de registro `{ timestamp, level, text }` |
| `logsHistory` | Las 200 últimas entradas, en la conexión |
| `error` | `{ message }`, mostrado como notificación |
| `status` | `{ status: 'restarting' \| 'shutting_down', … }` |
| `memory` | Muestras de memoria, mientras el panel lateral las pida |
| `speakers` | Quién habla en este instante, para el recuadro de actividad vocal |
| `permissionDenied` | Un mensaje ha sido rechazado a un invitado — el derecho que faltaba |
| `shareResult`, `controlRevoked` | Consecuencias de un gesto de compartición, para el maestro y el invitado |
| `rightRequestResult`, `rightRequestAnswered`, `rightRequested` | Una solicitud de derecho: la respuesta al invitado que la pide, la decisión del administrador, y el aviso en el lado de este |
| `tunnelState` | Estado del túnel, al abrirse su ventana |
| `versionCatalog` | Catálogo de versiones, releído de GitHub cada vez que se abre el menú |
| `trackFormats` | Formatos y tasas realmente disponibles para una pista |

### Mensajes cliente → servidor

54 tipos, declarados en la tabla de enrutamiento
[`handlers/index.js`](../../../src/web/websocket/handlers/index.js). Cada
dominio corresponde a un módulo de `handlers/`:

| Dominio | Mensajes |
|---|---|
| Reproducción | `play`, `pause`, `resume`, `skip`, `previous`, `stop`, `seek`, `setPlayMode`, `syncProgress`, `startPlaybackSource` |
| Cola de espera | `removeTrack`, `playNow`, `moveOrInsertTrack`, `clearQueue`, `removeFromHistory`, `clearHistory` |
| Listas de reproducción | `createPlaylist`, `renamePlaylist`, `deletePlaylist`, `reorderPlaylists`, `addPlaylistTrack`, `addTrackToPlaylist`, `removeTrackFromPlaylist`, `movePlaylistTrack`, `setActivePlaybackSource`, `insertTransition`, `setTransitionTarget` |
| Servidor de Discord | `selectChannel`, `setDefaultChannel`, `updateSettings`, `toggleVoiceDetection`, `leaveGuild` |
| Pista | `setTrackQuality`, `requestTrackFormats`, `requestTrackLoudness`, `setTrackLoudness`, `downloadTrack` |
| Compartición del control | `sendInviteLink`, `admitGuest`, `shareControl`, `revokeControl`, `requestRight`, `answerRightRequest`, `muteRightRequests` |
| Túnel | `tunnelState`, `tunnelLogin`, `tunnelMount`, `tunnelUnmount` |
| Versiones | `listVersions`, `installVersion`, `uninstallVersion` |
| Sistema | `requestState`, `clientLog`, `memoryStream`, `startupFadeinConsumed`, `restartBot`, `shutdownBot` |

Los cuatro últimos dominios están **reservados al maestro de sesión**: no
aparecen en la ventana de compartición y un invitado que los enviara a mano
sería rechazado por [`permissions.js`](../../../src/web/permissions.js) (véase
[07 — Seguridad](07-securite.md#derechos-compartidos)). Compartir, publicar el
panel en internet, cambiar la versión en ejecución o apagar el bot no son
órdenes de reproducción.

`leaveGuild` hace que el bot abandone un servidor de Discord — la papelera de los
ajustes, tras confirmación del nombre. La cola de reproducción se destruye antes
de la salida, y luego los paneles de control que se hayan quedado en ese servidor
se recolocan en otro (`WebServer.reassignClients`), sin lo cual ya no
recibirían ningún estado. A distinguir del interruptor vecino, que solo oculta el
servidor en las listas de ese navegador — un ajuste local, sin efecto sobre el
bot.

El menú contextual de una pista local no abre su carpeta: un navegador no puede
gobernar el explorador de archivos de la máquina que lo muestra. Ofrece en su
lugar «Copiar la ruta de acceso», que pone `track.url` en el portapapeles — el
usuario pega esa ruta donde quiera. Todo está del lado del cliente, no se
intercambia ningún mensaje WebSocket.

### Estructura del estado

```js
{
  guildId, selectedVoiceChannelId,
  guilds: [ { id, name, voiceChannels: [ { id, name, userCount, botConnected, isPlaying } ] } ],
  currentTrack, progress: { current, currentMs, total, totalMs, percent },
  mixTransition: null | { sortante: { url, positionMs, dureeMs, ratio },
                          entrante: { url, positionMs, dureeMs, ratio, track } },
  isPlaying, isPaused, isTransitioning, repeatMode, volume,
  listenerWait: null | { playing },   // reproducción congelada, canal sin humanos
  settings: { duckingEnabled, duckingLevel, duckingDelay, duckingFade,
              broadcastMode, playbackSpeed, mixEnabled, mixDuration, mixType, … },
  queue: [...], history: [...], playlists: [...],
  activePlaybackSource, playlistCurrentIndex,
  speakers: [userId], ignoredVoiceUsers: [userId],
  members: [ { id, displayName, avatar } ],
  botStats: { memory, uptime, timestamp }
}
```

Cada pista se enriquece mediante `formatTrackWithPreload()` con `isPreloaded`,
`isPreloading` y `preloadProgress`.

`progress.currentMs` y `progress.totalMs` se expresan siempre en el tiempo del
archivo, sin aplicar la velocidad de reproducción — sea cual sea el modo de
difusión. Es el navegador quien divide por `playbackSpeed` en el momento de
mostrar las dos duraciones, y es también en esa escala donde se esperan las
peticiones de reposicionamiento. La razón `currentMs / totalMs` da, pues,
directamente la barra de progreso. La posición que devuelve
`queue.node.getTimestamp()` sigue la misma escala, pero no su duración total, ya
dividida por la velocidad: `buildProgress()` la recalcula a partir de la pista.

`mixTransition` solo se rellena en difusión común, durante un fundido encadenado
del bus de mezcla: dos canciones suenan entonces juntas, y la cola del servidor no
declara la segunda como actual hasta el término de la superposición. El panel de
control se sirve de ello para anunciar el título entrante desde el comienzo del
fundido y para animar las dos líneas de la lista de reproducción a la vez — lo
que la difusión personal deduce por sí sola de sus dos elementos `<audio>`.

---

## Enrutamiento de los mensajes

[`wsHandler.js`](../../../src/web/websocket/wsHandler.js) no contiene **ninguna
lógica de negocio**. Ensambla un contexto y delega:

```js
await handler({
    ws, data, webServer, player,
    queue: player.queues.get(currentGuildId),
    currentGuildId,
    dispatch: (payload) => handleMessage(ws, payload, webServer),
});
```

`dispatch` permite a un handler reutilizar otro — `playNow` se apoya en `play`.
`data` se sustituye sistemáticamente por `{}` si falta, lo que dispensa a cada
handler de protegerse de ello.

### Añadir un mensaje

1. Escribir la función en el módulo de
   [`handlers/`](../../../src/web/websocket/handlers/) correspondiente al
   dominio, con la firma `(ctx)`.
2. Exportarla.
3. Añadir la línea `miMensaje: miModulo.handleMiMensaje,` en
   [`handlers/index.js`](../../../src/web/websocket/handlers/index.js).

El enrutador no se modifica nunca.

---

## El bucle de actualización

`WebServer.start()` instala un `setInterval` de un segundo que, para cada
servidor:

1. hace avanzar la posición del reproductor virtual en modo personal;
2. detecta el disparo de un encadenamiento DJ;
3. llama a `preloadManager.update()`;
4. difunde **únicamente el progreso** (`broadcastProgress`).

El estado completo parte ante un evento — pista cambiada, cola modificada, ajuste
tocado — mediante `broadcastState`. Esta separación se apoya en
`getPlaybackPosition()`, que calcula la posición sin reformatear las pistas.

### Lo que hacía costosa la vuelta de segundo

Antes de esta separación, cada tic redifundía el estado completo: todos los
canales de voz, todos los miembros, la cola, el historial y **todas las listas de
reproducción**. Cada pista pasaba por `getTrackPreloadInfo()`, que encadenaba
alrededor de cuatro `fs.existsSync` y un `fs.statSync`.

| Pistas | Antes — bloqueo / mensaje | Después |
|---|---|---|
| 10 | 0,3 ms / 8 KB | ~0 ms / 216 bytes |
| 50 | 1,6 ms / 40 KB | ~0 ms / 216 bytes |
| 200 | 6,5 ms / 119 KB | ~0 ms / 216 bytes |
| 500 | 16,2 ms / 277 KB | ~0 ms / 216 bytes |

La carga útil periódica ya no depende del número de pistas.

### Las tres medidas aplicadas

1. **Solo el progreso en la vuelta de segundo** — `broadcastProgress` únicamente
   envía `{ progress, isPlaying, isPaused, botStats }`.
2. **Índice en memoria de la caché de precarga** — `PreloadManager.cacheIndex`
   sustituye a la relectura del disco; el estado de una pista pasa de 32,4 µs a
   1,3 µs. Una URL `http(s)` cortocircuita ahora la prueba de archivo local, que
   de todos modos no podía encontrar nada.
3. **Sin reemisión idéntica** — `broadcastState` compara una firma del estado,
   `botStats` excluido (su marca de tiempo cambia en cada llamada y volvería
   inútil toda comparación), y no envía nada si no ha cambiado.

Este intervalo no se detiene nunca: no existe ningún método `stop()`.

---

## Robustez

La inicialización de un cliente está aislada en `_initClient()`, invocada bajo
`try/catch` desde `wss.on('connection')`. Una excepción sobrevenida ahí — por
ejemplo `getState()` sobre un estado inesperado — era antes una excepción no
capturada que **terminaba el proceso**: una conexión al panel de control en mal
momento bastaba para detener el bot. El cliente culpable recibe ahora un mensaje
de error y luego se le desconecta; el bot prosigue.

Los mensajes entrantes están protegidos del mismo modo: `ws.on('message')`
envuelve la llamada al enrutador.

Más arriba, `uncaughtException` y `unhandledRejection` están conectados a
`dieLoudly()` en [`index.js`](../../../src/index.js). Estos dos gestores **no
recuperan nada**: escriben `[FATAL]` en el registro y luego dejan morir al
proceso. Es deliberado — continuar tras un error cuya forma nadie ha previsto
dejaría funcionando un bot en un estado desconocido, lo que es peor que la
parada. Lo que aportan es el **rastro**: como el bot funciona sin consola, lo
que Node escribe por sí mismo en `stderr` antes de morir no se ve en ninguna
parte, y un testigo rechazado al iniciar sesión salía así sin una palabra en
`data/logs/`.

> `SIGTERM` sigue sin tratarse — solo lo está `SIGINT`, con el fundido de salida
> de [06 — Persistencia](06-persistance.md#fundido-de-salida).

Un *heartbeat* de 30 segundos (`ping`/`pong`) cierra las conexiones muertas.

---

## Frontend

Alrededor de 28 000 líneas de JavaScript, servidas sin transformación. Sin módulos
ES, sin bundler: 43 etiquetas `<script>` cargadas secuencialmente en
[`index.html`](../../../src/web/public/index.html) — 41 módulos de `js/`, las
traducciones y `app.js` — que se comunican mediante el espacio de nombres global
`window.MusicPlayer`.

| Archivo | Función |
|---|---|
| `state.js` | Estado compartido, preferencias, internacionalización |
| `websocket.js` | Conexión, reconexión automática, envío |
| `app.js` | Director de orquesta: reproductor, ajustes, reproducción personal |
| `player.js`, `mediaSession.js`, `loudnessGain.js` | Barra de progreso, duraciones, mandos del sistema, ganancia de nivel |
| `queue.js`, `searchHistory.js`, `downloadTarget.js` | Cola, historial, campo de añadido y su destino |
| `playlists.js`, `playlistTabsScroll.js`, `transitions.js` | Pestañas de listas y desvíos |
| `video.js`, `qualityMenu.js` | Reproducción de vídeo, visualizador, menús de calidad y formato |
| `logs.js`, `clientErrors.js` | Terminal de registros, reporte de los errores del navegador |
| `drawer.js`, `drawerWidgets.js`, `memoryBreakdown.js` | Panel lateral de estadísticas |
| `docs.js` | Lector de esta documentación, paginación en columnas |
| `loginGate.js`, `account.js`, `sharedControl.js`, `shareTunnel.js` | Conexión Discord, cuenta, compartición del control, túnel |
| `versions.js`, `githubMenu.js` | Menú de versiones y gestos de GitHub |
| `settingsModal.js`, `speedPad.js`, `customSelect.js`, `outputLevel.js` | Controles de interfaz |
| `deviceMode.js`, `touchDrawers.js`, `touchDragDrop.js`, `dragPreview.js`, `scrollLock.js`, `scrollFade.js` | Adaptación al táctil y a la pantalla pequeña |
| `layoutPersistence.js` | Disposición de las cajas: desplazamiento, intercambio, redimensionado, guardado |
| `tooltipSystem.js`, `faviconAnimator.js`, `headerButtonAnimations.js`, `particlePath.js`, `themeBlend.js` | Ornamentación |

Las trece hojas de estilo se ensamblan mediante `@import` en
[`style.css`](../../../src/web/public/style.css), única hoja referenciada por
`index.html`.

El orden de carga es una dependencia implícita: `state.js` debe preceder a todos
los demás, `app.js` debe venir en último lugar.

### Disposición de las cajas

[`layoutPersistence.js`](../../../src/web/public/js/layoutPersistence.js) coloca
las cajas sobre una cuadrícula de 48 columnas de celdas cuadradas. La caja que se
arrastra sigue al puntero píxel a píxel, y un hueco punteado, ajustado a la
cuadrícula, muestra dónde se posará. Lo demás obedece a cinco reglas:

- **ningún imán** — una caja con la que nada choca no se mueve, y un espacio
  vacío sigue vacío;
- **sobre un espacio libre**, la caja se ajusta a él, o se desliza hacia el hueco
  libre más cercano, sin empujar nada;
- **sobre otra caja**, en cuanto queda cubierta la mitad de la más pequeña de las
  dos, ambas **intercambian su sitio**; si sus tamaños difieren, lo que estorba
  baja, lo justo;
- **una caja bloqueada nunca se mueve** — apuntar a ella se rechaza, y detiene un
  redimensionado como un muro;
- **todo parte de la disposición del inicio del gesto** — volver atrás devuelve
  las vecinas a su sitio, y Escape cancela.

Las vecinas solo se reorganizan tras 150 ms de una misma decisión: cruzar el
panel con un gesto rápido no lo desordena. El sistema anterior lo recalculaba
todo en cada movimiento a partir de la disposición que acababa de desordenar, y
luego apretaba todas las cajas hacia arriba — incluida la que se acababa de
soltar.

El motor de colocación, `MusicPlayer.layoutEngine`, es puro: ni DOM ni
almacenamiento. [`tests/cardLayout.js`](../../../tests/cardLayout.js) lo verifica
fuera del navegador, disposiciones sorteadas al azar incluidas. Dos trampas
dependen de las hojas de estilo, y ninguna se ve en un diff:

- las animaciones pasan por `translate`, `scale` y la API Web Animations, nunca
  por `transform`. `.card` declara una transición `!important` sobre
  `transform`, que se impone a toda transición puesta en línea: era ella la que
  volvía instantáneos los desplazamientos;
- una caja redimensionada se estira mediante márgenes negativos, nunca mediante
  una anchura explícita. Esta contaría en el tamaño de las columnas `1fr`, que se
  ensancharían todas mientras dura el gesto y harían desbordar la cuadrícula.

### Troceado inacabado

[`app.js`](../../../src/web/public/app.js) tiene 3 819 líneas y concentra
responsabilidades que la carpeta `js/` ya ha empezado a extraer. Es el equivalente
en el frontend del troceado efectuado del lado del servidor, que queda por
terminar.

### Duplicación que vigilar

`window.MusicPlayer.formatMs` en
[`player.js`](../../../src/web/public/js/player.js) debe permanecer alineado con
`formatMs` de [`src/utils/duration.js`](../../../src/utils/duration.js): es el
cliente quien dibuja la línea de tiempo, a partir de los milisegundos y no de la
cadena enviada por el servidor.
