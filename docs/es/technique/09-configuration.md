# 09 — Configuración

[← Índice](README.md)

---

## Dos niveles de configuración

| Nivel | Archivo | Modificable en caliente |
|---|---|---|
| Entorno | `.env` | No — se requiere reinicio |
| Constantes de la aplicación | [`src/config.js`](../../../src/config.js) | No — valores predeterminados en el código |
| Ajustes por servidor | `data/settings.json` | Sí — comandos o panel de control |

`config.js` no contiene más que **valores predeterminados**: en cuanto se conoce
un servidor, sus ajustes efectivos viven en `settings.json` (véase
[06 — Persistencia](06-persistance.md)).

---

## Variables de entorno

Copiar `.env.example` a `.env` e indicar como mínimo `DISCORD_TOKEN`.

### Discord

| Variable | Requerida | Función |
|---|---|---|
| `DISCORD_TOKEN` | **Sí** | Testigo del bot. Su ausencia interrumpe el arranque. |
| `DISCORD_CLIENT_ID` | Para `npm run deploy` | Identificador de la aplicación |
| `DISCORD_CLIENT_SECRET` | Para la conexión Discord | Secreto OAuth2. Dejado vacío, nadie puede identificarse: el panel lo dice y recae en el solo testigo de acceso. |
| `GUILD_ID` | Para un despliegue local | Registra las órdenes en ese único servidor, sin plazo de propagación |

### Panel de control

| Variable | Predeterminado | Función |
|---|---|---|
| `PORT` | `3000` | Puerto de escucha |
| `HOST` | `127.0.0.1` | Interfaz de escucha. `0.0.0.0` para exponer a la red local. |
| `PUBLIC_URL` | — | Dirección por la que los invitados alcanzan este panel, sin barra final. No se adivina, y la URL de retorno `<PUBLIC_URL>/auth/discord/callback` debe declararse idéntica en el portal de Discord. |
| `AUTO_OPEN_DASHBOARD` | `true` | Apertura del navegador en el arranque. `false` cuando el bot corre en una máquina pilotada a distancia — ese panel reproduciría la música por duplicado. |
| `DASHBOARD_TOKEN` | generado | Testigo de acceso. Si está vacío, se genera y se guarda en `data/dashboard-token`. |

### Versiones

| Variable | Predeterminado | Función |
|---|---|---|
| `GITHUB_TOKEN`, `GH_TOKEN` | — | Testigo de la API de GitHub. Opcional en un repositorio público; eleva la cuota de 60 a 5 000 peticiones por hora. En su defecto se consulta la CLI `gh` si está instalada y conectada. |
| `IMP_REPO` | repositorio de `package.json` | Repositorio cuyas releases se ofrecen, en `owner/repo` o en URL |
| `IMP_VERSIONS_DIR` | `versions/` | Traslada las releases instaladas a otro sitio — disco secundario, carpeta fuera del repositorio |
| `IMP_RESTART` | — | Puesto por la instancia que se relanza. Marca una reanudación, lo que suprime el fundido de apertura y hace ignorar el canal favorito. |

Las tres últimas no son ajustes de usuario: el bot las pone él mismo al relanzar
otra versión. Véase [10 — Versiones](10-versions.md).

### Medios

| Variable | Predeterminado | Función |
|---|---|---|
| `MEDIA_ROOTS` | — | Carpetas locales autorizadas para la difusión en flujo, además de `data/uploads` y `data/cache`. Separador `;` o `,`. |
| `MAX_UPLOAD_MB` | `1024` | Tamaño máximo de un archivo importado |
| `MAX_CACHE_MB` | `2048` | Tope de la caché de precarga en `data/cache` |

### Registro

| Variable | Predeterminado | Función |
|---|---|---|
| `LOG_LEVEL` | `debug` | Umbral: `debug`, `info`, `warn`, `error` |
| `LOG_RETENTION` | `20` | Número de registros conservados en `data/logs` |

### Variables sin efecto

`SPOTIFY_CLIENT_ID` y `SPOTIFY_CLIENT_SECRET` las lee
`@discord-player/extractor` si están presentes, y mejoran la resolución de
Spotify.

`DEEZER_ARL`, `QOBUZ_EMAIL` y `QOBUZ_PASSWORD` **no tienen efecto alguno**: no
hay ningún extractor correspondiente instalado ni registrado. Son vestigios.

---

## config.js

```js
ducking: {
    enabled: true,          // ducking activo de manera predeterminada
    level: 20,              // % del volumen de base mientras se habla
    restoreDelay: 800,      // ms de silencio antes de la restauración
    fadeDuration: 200,      // ms de transición
    fadeStepInterval: 20,   // ms entre dos escalones de fundido
},
volume: { defaultBase: 70, min: 0, max: 100 },
presence: {
    enabled: true,          // entrar en un canal de voz solo si está habitado
    departureDelay: 30000,  // ms de espera antes de abandonar un canal vaciado (repliegue)
},
broadcast: { defaultMode: 'everyone', personalChannelPrefix: '🎵' },
supportedExtensions:      ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.opus', '.aac', '.wma'],
supportedVideoExtensions: ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.m4v', '.3gp', '.ogv', '.wmv'],
colors: { … },   // colores de los recuadros de Discord
```

`fadeStepInterval` es la única constante no expuesta al usuario: determina la
granularidad de los fundidos de
[`VolumeController`](../../../src/audio/VolumeController.js).

`presence.enabled` a `false` devuelve al bot su comportamiento antiguo:
permanece conectado de continuo, con el canal vacío o no. Véase
[04 — Modos de difusión](04-diffusion.md#presencia-en-los-canales-de-voz).

`presence.departureDelay` no es más que un valor de repliegue: cada servidor fija
el suyo desde el panel de control (*Parámetros → Parámetros del bot → Plazo antes
de abandonar un canal vacío*), guardado por servidor bajo
`presenceDepartureDelay` — **en segundos**, la unidad del deslizador, que
`PresenceManager._departureDelayMs()` reconvierte en milisegundos. El deslizador va de
0 a 300 s, y el servidor vuelve a acotar el valor recibido; cero significa una
salida sin plazo, lo que prohíbe el `||` habitual en este ajuste. Cambiar el
plazo rearma una cuenta atrás ya lanzada, para no esperar al siguiente canal
vaciado.

Las listas de extensiones tienen un doble papel: filtrado de las carpetas
escaneadas por `/playlist`, y **perímetro de la salvaguarda de seguridad** de las
rutas servidas al cliente (véase [07 — Seguridad](07-securite.md)).

---

## Ajustes por servidor

Valores predeterminados definidos en `_defaults()` de
[`Database.js`](../../../src/database/Database.js). Añadir una clave aquí basta:
todos los servidores existentes la heredan, pues `getSettings()` fusiona los
valores predeterminados en cada lectura.

| Clave | Predeterminado | Descripción |
|---|---|---|
| `duckingEnabled` | `true` | Atenuación al hablar |
| `duckingLevel` | `20` | % del volumen de base mientras se habla |
| `duckingDelay` | `800` | ms antes de la restauración |
| `duckingFade` | `200` | ms de transición |
| `baseVolume` | `70` | Volumen fuera de la voz |
| `broadcastMode` | `'everyone'` | Modo de difusión |
| `playbackSpeed` | `'1.0'` | Velocidad de reproducción |
| `defaultVoiceChannelId` | `null` | Canal favorito — uno solo, para todos los servidores; leído solo en el arranque |
| `lastVoiceChannelId` | `null` | Último canal visitado — es a él a quien todo el mundo sigue en sesión |
| `mixEnabled` | `false` | Encadenamiento tipo DJ |
| `mixDuration` | `5` | Duración del encadenamiento, en segundos |
| `mixType` | `'volume'` | `'volume'` o `'effects'` |
| `lufsSyncEnabled` | `false` | Alinear todos los temas en una misma sonoridad |
| `lufsSyncTarget` | `-14` | Objetivo común, en LUFS |
| `fadeinEnabled` | `false` | Fundido de entrada |
| `fadeinDuration` | `5` | Segundos |
| `fadeoutEnabled` | `true` | Fundido de salida al apagar |
| `fadeoutDuration` | `5` | Segundos |
| `addTarget` | `'queue'` | Destino del campo de añadido: `queue`, `playlist`, `play` o `download` |
| `importFormat` | `'mp3'` | Contenedor de los archivos escritos en el disco |
| `importAudioQuality` | `'320'` | Tasa MP3 de la precarga, en kbps |
| `importVideoQuality` | `'720'` | Altura objetivo del flujo de vídeo, en píxeles |
| `presenceDepartureDelay` | `30` | Plazo antes de abandonar un canal vaciado, **en segundos** |
| `ignoredVoiceUsers` | `{}` | Exclusiones de ducking, por canal |
| `sharedControl` | `{}` | Derechos concedidos a los invitados, por cuenta de Discord |
| `rightRequests` | `{}` | Derechos solicitados por los invitados, a la espera de respuesta: cuenta → derecho → marca de tiempo |
| `mutedRightRequests` | `[]` | Invitados cuyas solicitudes de derechos están silenciadas |
| `preloading` | véase más abajo | Precarga: `enabled`, `queueCount`, `historyCount`, `playlistCount` |
| `activePlaybackSource` | `'queue'` | `'queue'` o identificador de lista de reproducción |
| `playlistCurrentIndex` | `0` | Posición en la lista de reproducción activa |
| `loopPlaylist` | `false` | Volver a leer la lista activa desde su primer título |
| `shuffle` | `false` | Sortear la siguiente canción en cada enlace |
| `channelQueues` | `{}` | La cola de espera, ordenada canal de voz por canal de voz |
| `queueBackupPersonal` | `null` | Guardado de antes del ordenamiento por canal |
| `queueBackupEveryone` | `null` | Ídem, modo común |

`channelQueues` es `{ "<channelId>": [pista | desvío, …] }`. Un canal «fiesta» y
un canal «tranquilo» tienen cada uno la suya y la recuperan al volver, allí donde
una cola única por servidor seguía al bot a todas partes. Es además el único
lugar donde un desvío puede esperar su turno: necesita una lista ordenada para
designar una posición, cosa que el reproductor no le ofrecía. Véase
[`channelQueue`](../../../src/audio/channelQueue.js).

Las dos últimas claves son **heredadas**, y permanecen a `null`: llevaban la cola
apartada antes del ordenamiento por canal.
[`channelQueue`](../../../src/audio/channelQueue.js) las relee una vez para
verter lo que una versión anterior hubiera dejado allí, y luego las borra. Todo
pasa ahora por [`setAsideQueue`](../../../src/utils/setAsideQueue.js): una simple
lista de pistas, en la que nada es «actual» puesto que nada suena de ella
mientras la lista ocupa el reproductor. Las formas antiguas (`{ tracks }`,
`{ virtualCurrentTrack, virtualTracks }`) siguen aceptándose en lectura.

`loopPlaylist` es distinto del modo de repetición de discord-player, que solo
conoce la cola realmente cargada: volver a reproducir «la lista» supone
recargarla desde su primer título, aunque la reproducción hubiera empezado por
la mitad.

`shuffle` excluye ambos bucles, y el sorteo ocurre en el enlace, nunca por
adelantado: la difusión común se apoya en la mezcla **dinámica** de
discord-player (`enableShuffle(true)`), que deja la cola en su orden, y la
difusión personal sortea ella misma en `WebServer.drawNextVirtualTrack()`.
Barajar la cola de una vez por todas sería irreversible, y dejaría de anunciar
lo que viene. A cambio, ya nada se deduce del orden: el fundido encadenado del
navegador deja de preparar la canción siguiente, y solo un `preloading` sin
límite mantiene el enlace inmediato — lo que el botón del modo propone él mismo,
desde su información emergente.

`activePlaybackSource` no vuelve a `'queue'` por la sola decisión del usuario:
una lista de reproducción que termina sin bucle devuelve el mando a la cola
apartada, que arranca entonces por su primer título
(`WebServer.advanceToQueue()`). El cambio se intenta en los dos puntos de
agotamiento — la cola virtual del modo personal y el evento `emptyQueue` del modo
común —, siempre después del relanzamiento en bucle: es ese orden, y no una
prueba sobre `loopPlaylist`, lo que da prioridad al bucle. Una cola apartada
vacía deja que la reproducción se detenga, como antes.

El subobjeto `preloading` (`enabled`, `queueCount`, `historyCount`,
`playlistCount`) se ajusta desde el panel de control pero se **consume en el
lado del servidor** por [`PreloadManager.js`](../../../src/audio/PreloadManager.js):
el valor debe por tanto vivir aquí, y no solo en el `localStorage` del navegador.

Los tres contadores van de 0 a 5, más una última muesca que ya no cuenta y toma
toda la sección. Esta se registra como **`-1`**, nunca como la posición del
deslizador: esta solo vale en relación con el máximo del día, y el día en que los
deslizadores ganaran una muesca, un `6` registrado dejaría de querer decir «todo»
sin que nada lo señalara. Un recuento negativo, en cambio, no lo es en ningún
mundo. Se relee como `Infinity`, que los `slice(0, n)` y `Math.min(n, …)` de
después ya tratan correctamente.

---

## Comandos npm

| Comando | Efecto |
|---|---|
| `npm start` | Arranca el bot |
| `npm run dev` | Arranca con `--watch` (reinicio al cambiar un archivo) |
| `npm run deploy` | Registra los comandos de barra en Discord |
| `npm run update-ytdlp` | Actualiza yt-dlp — a hacer cuando la precarga falla con un 403 |

### Despliegue de los comandos

[`deploy-commands.js`](../../../src/deploy-commands.js) recoge los comandos de
`src/commands/` y los registra **globalmente**. La propagación puede tardar hasta
una hora. Para una prueba inmediata, definir `GUILD_ID` en `.env`: los comandos
se registran entonces en ese único servidor, sin demora.

Este script debe relanzarse en cada adición, supresión o modificación de la firma
de un comando. Modificar únicamente el cuerpo de un comando no lo requiere.

---

## Comandos de Discord

| Comando | Opciones | Derechos |
|---|---|---|
| `/play` | `query` — búsqueda, URL, o ruta local | Todos |
| `/playlist` | `path`, `shuffle` | Todos |
| `/queue` | `page` | Todos |
| `/skip`, `/pause`, `/resume`, `/stop` | — | Todos |
| `/nowplaying` | — | Todos |
| `/volume` | `level` (0–100) | Todos |
| `/ducking toggle\|level\|delay\|fade\|status` | según la subcomando | Todos |
| `/broadcast` | `mode` — `everyone` o `personal` | **Administrador** |

Las verificaciones de derechos utilizan
[`utils/permissions.js`](../../../src/utils/permissions.js).

---

## Requisitos previos

- **Node.js 18 o superior** — el proyecto utiliza `fs.promises`, el operador de
  encadenamiento opcional y `structuredClone` indirectamente a través de sus
  dependencias. No se declara ningún campo `engines` en `package.json`.
- **FFmpeg** — proporcionado por `ffmpeg-static`, no se requiere instalación en
  el sistema.
- **yt-dlp** — proporcionado por `youtube-dl-exec`, usado como repliegue de
  resolución y para la extracción de vídeo.

Las intenciones de Discord requeridas (`Guilds`, `GuildVoiceStates`,
`GuildMessages`) deben activarse en el portal de desarrolladores.
