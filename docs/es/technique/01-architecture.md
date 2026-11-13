# 01 — Arquitectura

[← Índice](README.md)

---

## Árbol de directorios

```
src/
├── index.js                  Punto de entrada: cliente Discord, player, ducking, parada
├── config.js                 Constantes y valores predeterminados (no modificados en ejecución)
├── deploy-commands.js        Script de registro de los comandos de barra
│
├── audio/
│   ├── PlaybackSession.js    Estado de reproducción por servidor (esquema declarado)
│   ├── DuckingManager.js     Detección de voz → gobierno del volumen
│   ├── VolumeController.js   Fundidos progresivos sobre el nodo de audio
│   ├── PlayerEvents.js       Escuchadores de eventos de discord-player
│   ├── PresenceManager.js    Llegada y salida del bot según la ocupación del canal
│   ├── PreloadManager.js     Caché en disco de las pistas remotas
│   ├── rangeStream.js        Descarga por tramos, para sortear la limitación
│   ├── LocalFilePlayer.js    Utilidades de escaneo de carpetas de audio
│   ├── LoudnessAnalyzer.js   Medición LUFS de un archivo, mediante FFmpeg
│   ├── loudness.js           Medición + objetivo → ganancia, sin saber nada de audio
│   ├── channelQueue.js       La cola, ordenada canal de voz por canal de voz
│   ├── transitions.js        Desvíos colocados entre dos títulos de una lista
│   ├── videoSource.js        Resolución del flujo de imagen de una pista
│   ├── playbackSettings.js   Velocidad y efectos de mezcla, sea cual sea la vía de audio
│   └── mix/                  Bus de mezcla: la difusión común, dos pistas superponibles
│       ├── format.js         Formato de intercambio PCM y troceado en tramas
│       ├── input.js          Resolución de una pista en entrada FFmpeg
│       ├── MixSource.js      Una canción decodificada, con ganancia y filtro
│       ├── MixBus.js         El flujo permanente enviado a Discord
│       ├── MixEngine.js      Orquestación por servidor y gobierno de la cola
│       ├── playerBridge.js   Encaminamiento de los métodos del reproductor hacia el bus
│       └── index.js          Registro de los buses, uno por servidor
│
├── broadcast/
│   └── BroadcastManager.js   Modos de difusión, canales personales
│
├── commands/                 Comandos de barra de Discord (uno por archivo)
│
├── database/
│   ├── Database.js           Ajustes por servidor + listas de reproducción globales
│   └── PlaybackStateManager.js  Instantánea y restauración de la reproducción
│
├── utils/
│   ├── logger.js             Registro de la aplicación
│   ├── atomicJson.js         Lectura/escritura JSON resistentes a los fallos
│   ├── mediaPaths.js         Salvaguarda de las rutas servidas al cliente
│   ├── downloadDir.js        Carpeta donde se escriben los archivos descargados
│   ├── downloadFormats.js    Contenedores ofrecidos → argumentos de FFmpeg
│   ├── mp3.js                Análisis de un MP3 parcial, para reanudar una precarga
│   ├── artwork.js            Carátula de reserva, servida por el bot y no por un tercero
│   ├── setAsideQueue.js      Cola apartada por una lista de reproducción
│   ├── historyOrder.js       Reinserción de un historial en una cola LIFO
│   ├── paths.js              Comparación y limpieza de rutas
│   ├── duration.js           Formateo y análisis de las duraciones
│   ├── embeds.js             Recuadros de Discord
│   └── permissions.js        Verificaciones de permisos de Discord
│
├── versioning/               Versiones del bot: catálogo, instalación, cambio
│   ├── index.js              Fachada consumida por el panel
│   ├── locations.js          Raíz compartida frente a raíz de instalación, salvaguardas
│   ├── github.js             Releases del repositorio y descarga de sus archivos
│   ├── installer.js          Extracción, dependencias, inventario del disco
│   └── targz.js              Extracción `.tar.gz` sin dependencia externa
│
└── web/
    ├── WebServer.js          Servidor HTTP + WebSocket, agregación del estado
    ├── auth.js               Testigo de acceso (HTTP y WebSocket)
    ├── oauth.js              Recorrido OAuth2 de Discord
    ├── sessions.js           Sesiones de pestaña, de corta duración
    ├── owner.js              Cuenta propietaria de la instalación
    ├── guests.js             Libro de los invitados ya venidos
    ├── permissions.js        Lo que un invitado tiene derecho a hacer
    ├── cloudflare.js         Publicación del panel en internet
    ├── oauthRelay.js         Relé de retorno OAuth del uso compartido rápido
    ├── uploadService.js      Recepción e integración de los archivos importados
    ├── chunkedUpload.js      Archivos enviados en trozos, recompuestos
    ├── routes/api.js         Rutas HTTP (stream, download, upload, video-info)
    ├── routes/auth.js        Recorrido de autenticación de un invitado
    ├── websocket/
    │   ├── wsHandler.js      Enrutador de los mensajes WebSocket
    │   ├── handlerUtils.js   Ayudantes compartidos por los handlers
    │   └── handlers/         Un módulo por dominio + tabla de enrutamiento
    └── public/               Frontend servido tal cual (HTML, CSS, JS)
```

La carpeta `data/`, creada en ejecución, no está versionada:

```
data/
├── settings.json           Ajustes por servidor + listas de reproducción globales
├── playback_state.json     Último estado de reproducción conocido
├── dashboard-token         Testigo de acceso generado en el primer arranque
├── owner.json              Cuenta propietaria de la instalación
├── guests.json             Libro de los invitados ya venidos
├── sessions.json           Sesiones de Discord abiertas
├── uploads/                Archivos importados, nombrados por huella
├── cache/                  Pistas remotas precargadas en MP3
├── downloads/              Archivos descargados, si no se elige otra carpeta
└── logs/                   Un registro por arranque + latest.log
```

Una segunda carpeta no versionada, `versions/`, alberga las releases instaladas
— una por etiqueta. Permanece vacía mientras se ejecute el repositorio de
desarrollo. Véase [10 — Versiones](10-versions.md).

La carpeta `tools/` alberga las herramientas de Windows, sin relación con el
proceso del bot — ningún módulo de `src/` la referencia:

```
Create shortcut.vbs       Punto de entrada de doble clic, en la raíz
Start bot.vbs             Arranque directo, sin pasar por un acceso directo
tools/
├── create-shortcut.ps1   Asistente WPF: elección de la ubicación, escritura del .lnk
├── start-bot.vbs         Destino del acceso directo: llama al .ps1 sin ventana
├── start-bot.ps1         Verificaciones, instalación, arranque del bot
└── icon.ico              Icono del acceso directo, redibujado si falta, no versionado
```

**Por qué archivos `.vbs`.** El acceso directo lanza `wscript.exe start-bot.vbs`,
que llama a PowerShell con un estilo de ventana `0`. Es el único modo, en
Windows, de arrancar un script sin que exista consola alguna: un `.bat`, o un
`.lnk` que apunte a `powershell.exe -WindowStyle Hidden`, siempre hace parpadear
un terminal — visible en pantalla y en la barra de tareas — antes de ocultarlo.
El `.lnk` apunta a `wscript.exe` explícitamente, y no al `.vbs`, porque algunas
máquinas asocian los `.vbs` a `cscript.exe`, que sí abriría una consola.

`Start bot.vbs` y `tools/start-bot.vbs` son deliberadamente la misma llamada,
salvo por una ruta relativa: el primero es el punto de entrada que se hace doble
clic en la carpeta del proyecto, el segundo el destino estable del `.lnk`.
Mantenerlos distintos evita que un acceso directo existente dependa de un
archivo de la raíz, donde el usuario es más propenso a renombrar o desplazar
algo. Ninguno de los dos lleva lógica: todo está en `start-bot.ps1`.

**La ventana de lanzamiento.** Como el bot funciona sin consola, lo que esta
llevaba se retoma en otra parte: el desarrollo del arranque y los errores por la
ventana WPF de `start-bot.ps1`, el detalle por `data/logs/`, la parada por el
botón de apagado del panel de control (`shutdownBot`, véase
[05](05-tableau-de-bord.md)).

Esta ventana se muestra en **cada** lanzamiento, y ya no solo en el primer uso.
Enumera las etapas realmente pendientes — las dependencias y el registro de los
comandos solo aparecen si falta `node_modules` — y marca cada una con un punto
en espera, un anillo que gira, una marca verde, una marca ámbar para un fallo no
bloqueante, o una cruz roja. Ante una cruz, el desarrollo se detiene y el pie de
la ventana lleva el motivo, un extracto del registro y el botón que desbloquea:
descargar Node.js, abrir `.env`, abrir los registros.

Tres puntos merecen conocerse antes de tocarlos:

- **La señal de «listo» es el puerto del panel de control.** El bot solo lo abre
  una vez conectado a Discord (`ClientReady` en `src/index.js`): una simple
  conexión TCP a `127.0.0.1:PORT` es, pues, el único testigo fiable, allí donde
  la existencia del proceso no prueba nada. La ventana se borra en cuanto el
  puerto responde, y el navegador lo abre el bot mismo (`WebServer.start`),
  nunca el script.
- **Un puerto ya abierto detiene el lanzamiento.** Sin esta verificación previa,
  un segundo arranque moriría en un puerto ocupado mientras la espera anterior
  tendría éxito de inmediato — un falso éxito. La ventana anuncia entonces que
  el bot ya está funcionando y ofrece tres tarjetas: abrir el panel de control,
  reiniciar, apagar.
- **La configuración se verifica antes de la instalación.** El orden no es
  indiferente: `npm run deploy` necesita el testigo de Discord, y solo se
  reproduce cuando falta `node_modules`. Verificarlo después habría condenado a
  los comandos de barra a no registrarse nunca en una carpeta recién obtenida.

Un fallo inmediato — testigo rechazado, módulo roto — quedaría invisible: la
etapa de arranque vigila por ello el proceso, y la del panel de control devuelve
el mando al cabo de noventa segundos en lugar de esperar sin fin.

**Gobernar un bot ya lanzado.** Las tarjetas «Reiniciar» y «Apagar» no añaden
ningún punto de acceso: toman prestado el canal del panel de control, un
WebSocket autenticado por el que transitan `restartBot` y `shutdownBot`
(`src/web/websocket/handlers/systemHandlers.js`). Exponer el apagado del proceso
una segunda vez, en HTTP, habría ampliado la superficie de ataque sin aportar
nada. El testigo viaja en la consulta — forma aceptada por `auth.extractToken`
tanto para `/api` como para el apretón de manos WebSocket.

El apagado pide confirmación, como la ventana de mantenimiento del panel de
control: cortar la reproducción de un servidor entero no debe depender de un
clic descuidado. El reinicio, en cambio, parte directamente — la reproducción
retoma donde estaba. Ambos dan cuenta de sí mismos reproduciendo el motor de
etapas: el puerto que cae, y luego que vuelve.

Una sola adición del lado del bot: `GET /api/clients`, que devuelve el número de
paneles de control conectados y la dirección en la que abrir uno. El clic abre
siempre una pestaña: la cuenta, que no distingue esta máquina de un invitado o
de un teléfono, solo informa a la tarjeta. La dirección es la de
`oauth.publicUrl()`, donde vive la sesión de Discord — abierta en la interfaz de
escucha, la pestaña volvía a pedir la conexión a un propietario ya conectado. El
token viaja en la cabecera `Authorization`: pasado en la query, provoca una
redirección a la dirección limpia, cuya cookie pierde `Invoke-RestMethod`.

Cuatro trampas de Windows PowerShell 5.1 y de GDI+ están desactivadas en estos
scripts, y deben seguir estándolo:

| Trampa | Consecuencia | Parada dispuesta |
|---|---|---|
| Un `.ps1` sin BOM se lee en página de códigos ANSI | Toda la interfaz pierde sus acentos | Ambos `.ps1` están en **UTF-8 con BOM**; los `.vbs`, en ASCII puro |
| `Start-Process -PassThru -RedirectStandardOutput` devuelve un `ExitCode` siempre nulo | Un comando exitoso se lee como un fallo | Ninguna redirección .NET: `cmd` redirige por sí mismo (`1> … 2>&1`) |
| Un bloque de script invocado por `&` se ejecuta en el ámbito de quien llama, no en el de su definición | Los bloques `Start`/`Poll` de una etapa no ven los parámetros de la función que los ha creado | Leen sus datos en la etapa actual (`CurrentStep`) y solo escriben en variables `$script:` |
| `GraphicsPath` y `GeometryGroup` rellenan en par-impar de manera predeterminada | Los solapamientos de la nota musical se perforan mutuamente | `FillMode = Winding` del lado GDI+, `FillRule="Nonzero"` del lado XAML |

Dos nombres deben también evitarse en estos scripts: `$host`, variable reservada
de solo lectura, y todo parámetro que retomara el nombre de un elemento de la
interfaz — PowerShell no distingue mayúsculas de minúsculas, y el parámetro
prevalece.

---

## Secuencia de arranque

`npm start` ejecuta [`src/index.js`](../../../src/index.js), en este orden:

**1. Corrección de Windows.** Antes de todo `require`, `child_process.spawn` se
envuelve para forzar `windowsHide: true`. Sin ello, cada llamada a FFmpeg o
yt-dlp hace aparecer una ventana de consola. La corrección debe preceder a las
demás importaciones para cubrir las bibliotecas de terceros.

**2. Registro de los filtros de velocidad.** Se declaran 286 filtros FFmpeg
`speed_x_xx` (véase
[02 — Reproducción de audio](02-lecture-audio.md#velocidad-de-reproducción)).

**3. Validación del entorno.** La ausencia de `DISCORD_TOKEN` interrumpe el
arranque.

**4. Creación del cliente Discord** con las intenciones `Guilds`,
`GuildVoiceStates` y `GuildMessages`.

**5. Carga de los comandos** desde `src/commands/`.

**6. Inicialización de discord-player**, registro de los extractores, de los
escuchadores de eventos y del gestor de precarga.

**7. Conexión a Discord.** En el evento `ClientReady`:
- anuncio de la versión en curso y barrido de las instalaciones interrumpidas;
- elección del canal de apertura — el favorito al encender, el último visitado
  al reanudar (véase [06](06-persistance.md#database));
- arranque del servidor web;
- restauración del estado de reproducción guardado, con la precarga suspendida
  hasta el final;
- programación del guardado periódico (cada 5 s) y de la red de seguridad de la
  regla de presencia (cada 30 s).

```
index.js
  ├─ patch spawn (win32)
  ├─ dieLoudly : uncaughtException, unhandledRejection
  ├─ AudioFilters : speed_0_20 … speed_3_05, muffled
  ├─ installBridge()            (nodo de discord-player → bus de mezcla)
  ├─ new Client(...)
  ├─ loadCommands()
  ├─ initPlayer()
  │    ├─ extractors.register(Youtubei, Spotify, SoundCloud, AppleMusic, Attachment)
  │    ├─ registerPlayerEvents()
  │    └─ preloadManager.init()
  └─ client.login()
       └─ ClientReady
            ├─ versioning.currentVersion() + cleanTempDirs()
            ├─ database.applyStartupChannel({ resuming })
            ├─ webServer.start(client, PORT, HOST)
            ├─ playbackStateManager.restoreAll()
            │    └─ finally : preloadManager.setSuspended(false)
            ├─ presenceManager.evaluate(guildId)   (para cada servidor)
            ├─ setInterval(saveState, 5000)
            └─ setInterval(presence.evaluate, 30000)
```

La precarga permanece suspendida durante toda la restauración: purga de la caché
toda pista ausente de las colas, y estas solo están completas una vez terminado
`restoreAll()`. El bucle de presencia que sigue recupera a quienes entraron en un
canal mientras tanto — ningún evento de voz los señalará después.

---

## Mapa de dependencias

Las flechas van del consumidor hacia el proveedor.

```
                    index.js
                       │
        ┌──────────────┼──────────────┬───────────────┐
        ▼              ▼              ▼               ▼
   commands/      audio/         web/WebServer   database/
        │              │              │               │
        └──────────────┴──────┬───────┴───────────────┘
                              ▼
                          utils/
              (logger, atomicJson, paths, duration, mediaPaths)
```

`utils/` no depende de nada más que de `config.js`. Es la capa hoja: todo puede
importarla sin riesgo de ciclo.

**Existen dos ciclos**, resueltos mediante `require()` diferidos en el interior
de las funciones:

- `DuckingManager` → `WebServer` (para redifundir el estado al detectar voz);
- `PlayerEvents` → `WebServer` → `wsHandler` → handlers → `PlaybackStateManager`.

Estos `require()` en línea son deliberados. Desplazarlos a la cabecera del
archivo provocaría importaciones circulares sin resolver.

---

## Ciclo de vida de una reproducción

Ejemplo: un usuario lanza una pista desde el panel de control.

```
Navegador ───WS {type:'play', data:{query}}──► wsHandler
                                                  │
                                     handlers/playbackHandlers.handlePlay
                                                  │
                              ┌───────────────────┼────────────────────┐
                              ▼                   ▼                    ▼
                    searchLocalAwareTrack   queue.connect()      queue.play()
                    (extractores)           (canal de voz)             │
                                                                      ▼
                                                          discord-player → FFmpeg
                                                                      │
                                                           evento 'playerStart'
                                                                      │
                              ┌───────────────────────────────────────┤
                              ▼                                       ▼
                     client.setupDucking()                  webServer.broadcastState()
                     (VolumeController + DuckingManager)              │
                                                                      ▼
                                                           Navegador ◄──WS {type:'state'}
```

---

## PlaybackSession

discord-player expone un objeto `GuildQueue` por servidor. El proyecto le
adjuntaba directamente sus propias propiedades, sin encapsulación:

| Propiedad | Función |
|---|---|
| `virtualCurrentTrack`, `virtualTracks`, `virtualHistory` | Reproductor virtual del modo personal |
| `virtualIsPlaying`, `virtualIsPaused`, `virtualProgressMs`, `virtualLastUpdated` | Estado del reproductor virtual |
| `channelStates` | Instantánea de reproducción por canal de voz |
| `activeChannelId` | Canal considerado activo |
| `silencePlayer`, `silenceStream` | Emisor de silencio del modo personal |
| `transitioningToEveryone`, `transitionTrack`, `transitionTargetProgress` | Cambio personal → común |
| `isPendingTransition`, `transitionTimeout` | Cerrojo antidoble salto |
| `restorePaused`, `restoreProgress`, `restoreShouldBePaused` | Restauración en el arranque |
| `isMixFadingOut`, `mixAppliedTrackId`, `trackStartedAt` | Encadenamiento tipo DJ |
| `absentEmptyChannel`, `frozenPositionMs`, `frozenIsPlaying` | Reproducción congelada mientras el bot está fuera de un canal vacío |
| `pauseOnNextTrack` | Pausa diferida |

**Por qué era un problema.** Ninguna de estas propiedades estaba declarada en
ningún sitio: su existencia se descubría leyendo los lugares de acceso. Cada
lectura debía protegerse
(`if (!queue.virtualTracks) queue.virtualTracks = []` — 18 apariciones). Una
subida de versión de discord-player que introdujera un nombre idéntico habría
roto el bot en silencio.

### El estado pertenece ahora al proyecto

[`PlaybackSession`](../../../src/audio/PlaybackSession.js) declara las 26
propiedades en un `SCHEMA` único, con su tipo y su valor inicial. El estado vive
en ese objeto; la cola ya no es su propietaria.

```
   queue.virtualTracks
          │  accesor instalado en GuildQueue.prototype
          ▼
   session.virtualTracks        ← PlaybackSession, propiedad del proyecto
```

**Asociación mediante `WeakMap`.** La sesión está ligada al objeto cola, no al
`guildId`: una nueva cola parte de un estado nuevo — comportamiento idéntico al
anterior — y el estado se libera con ella, sin fuga de memoria.

**Accesores en el prototipo.** Cubren todas las colas, sea cual sea la vía que
las haya creado, incluidas las que discord-player instancia por su cuenta —
fuera del alcance de una interceptación de `queues.create()`. Las propiedades
son **no enumerables**: ya no aparecen en una serialización accidental de la
cola.

### Interfaz unificada

La sesión expone accesores que enmascaran la distinción entre modo común y modo
personal:

| Método | Sustituye a |
|---|---|
| `getCurrentTrack()` | `isPersonal ? queue.virtualCurrentTrack : queue.currentTrack` |
| `getTracks()` | `isPersonal ? queue.virtualTracks : queue.tracks.toArray()` |
| `getHistory()` | `isPersonal ? queue.virtualHistory : queue.history.tracks.toArray()` |
| `getIsPlaying()` / `getIsPaused()` | derivación modo + transición |

Utilizada por `PreloadManager.getActivePreloadTracks` y
`WebServer.getPlaybackPosition`.

`isFrozen()` se suma a ese desvío. Cuando el bot se ha retirado de un canal
vaciado de sus humanos, la cola sigue viva en memoria pero el nodo de
discord-player ha desaparecido con la conexión de voz: la posición ya no viene
de él sino de `frozenPositionMs`. La congelación exige ambas cosas — la bandera
levantada **y** la ausencia de conexión —, pues la bandera puede seguir
levantada cuando el bot ya ha vuelto, y responder «congelada» fijaría entonces
el panel en una posición anterior a su regreso mientras el sonido avanza.

### Migración pendiente

Los 375 lugares de acceso existentes siguen funcionando mediante los accesores:
la sintaxis `queue.virtualTracks` no ha cambiado, solo se ha movido el
almacenamiento. Su reescritura en `session.virtualTracks`, y luego la retirada
de los accesores, puede hacerse archivo por archivo — lo esencial del beneficio
(esquema declarado, valores iniciales garantizados, protección contra las
colisiones) ya está conseguido.

---

## Puntos de atención para las modificaciones

**Añadir un comando de Discord** — crear un archivo en `src/commands/` que
exporte `{ data, execute }`, y luego relanzar `npm run deploy`. El cargador de
[`index.js`](../../../src/index.js) contiene un caso particular escrito a mano
para `queue.js`, que exporta cinco comandos.

**Añadir un mensaje WebSocket** — véase
[05 — Panel de control](05-tableau-de-bord.md#añadir-un-mensaje).

**Añadir un ajuste persistente** — añadirlo a `_defaults()` en
[`Database.js`](../../../src/database/Database.js); los servidores ya
registrados heredan automáticamente el valor predeterminado en la lectura.
