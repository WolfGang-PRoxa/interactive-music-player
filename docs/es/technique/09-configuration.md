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

### Panel de control

| Variable | Predeterminado | Función |
|---|---|---|
| `PORT` | `3000` | Puerto de escucha |
| `HOST` | `127.0.0.1` | Interfaz de escucha. `0.0.0.0` para exponer a la red local. |
| `DASHBOARD_TOKEN` | generado | Testigo de acceso. Si está vacío, se genera y se guarda en `data/dashboard-token`. |

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
`PresenceManager._delaiDepart()` reconvierte en milisegundos. El deslizador va de
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
| `fadeinEnabled` | `false` | Fundido de entrada |
| `fadeinDuration` | `5` | Segundos |
| `fadeoutEnabled` | `true` | Fundido de salida al apagar |
| `fadeoutDuration` | `5` | Segundos |
| `ignoredVoiceUsers` | `{}` | Exclusiones de ducking, por canal |
| `activePlaybackSource` | `'queue'` | `'queue'` o identificador de lista de reproducción |
| `playlistCurrentIndex` | `0` | Posición en la lista de reproducción activa |
| `queueBackupPersonal` | `null` | Cola apartada, escrita en modo personal |
| `queueBackupEveryone` | `null` | Cola apartada, escrita en modo común |

Las dos últimas claves llevan **la misma** cola de espera — la que una lista de
reproducción ha apartado —, guardada bajo la del modo de difusión en curso; la
otra se borra. Todo pasa por
[`setAsideQueue`](../../../src/utils/setAsideQueue.js): una simple lista de
pistas, `{ pistes: [...] }`, en la que nada es «actual» puesto que nada suena de
ella mientras la lista ocupa el reproductor. Estas claves llevaban antes dos
formas distintas, y cambiar de modo hacía que la interfaz leyera de un guardado
vacío — la cola parecía perdida. Las formas antiguas (`{ tracks }`,
`{ virtualCurrentTrack, virtualTracks }`) siguen aceptándose en lectura.

`activePlaybackSource` no vuelve a `'queue'` por la sola decisión del usuario:
una lista de reproducción que termina sin bucle devuelve el mando a la cola
apartada, que arranca entonces por su primer título
(`WebServer.enchainerSurLaFile()`). El cambio se intenta en los dos puntos de
agotamiento — la cola virtual del modo personal y el evento `emptyQueue` del modo
común —, siempre después del relanzamiento en bucle: es ese orden, y no una
prueba sobre `loopPlaylist`, lo que da prioridad al bucle. Una cola apartada
vacía deja que la reproducción se detenga, como antes.

El subobjeto `preloading` (`enabled`, `queueCount`, `historyCount`,
`playlistCount`) no está declarado en `_defaults()`: lo escribe el panel de
control y se lee con valores de repliegue en
[`PreloadManager.js`](../../../src/audio/PreloadManager.js).

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
