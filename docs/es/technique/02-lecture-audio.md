# 02 — Reproducción de audio

[← Índice](README.md)

Esta página cubre la cadena que va de una petición del usuario al flujo Opus
emitido en el canal de voz, así como la caché de precarga.

---

## Cadena de tratamiento

```
petición ──► extractor ──► flujo ──► FFmpeg ──► Opus ──► UDP Discord
             (resolución)  (HTTP     (filtros,  (codificación)
                            o         volumen)
                            archivo)
```

El proyecto no manipula el audio por sí mismo: configura
[discord-player](https://discord-player.js.org/), que orquesta FFmpeg y
`@discordjs/voice`. El binario de FFmpeg proviene del paquete `ffmpeg-static`, lo
que evita cualquier instalación en el sistema.

---

## Extractores

Registrados en el arranque en [`index.js`](../../../src/index.js):

| Extractor | Fuente | Observación |
|---|---|---|
| `YoutubeiExtractor` | YouTube | Configurado con `useYoutubeDL: false` |
| `SpotifyExtractor` | Spotify | Solo metadatos, audio tomado de YouTube |
| `SoundCloudExtractor` | SoundCloud | |
| `AppleMusicExtractor` | Apple Music | Solo metadatos |
| `AttachmentExtractor` | Archivos locales y adjuntos | Usado para las importaciones |

> **Deezer y Qobuz no están admitidos**, pese a las variables presentes en
> `.env.example`. No hay ningún extractor correspondiente instalado ni
> registrado. Esas variables son un vestigio.

### Resolución de una petición

`searchLocalAwareTrack()` en
[`handlerUtils.js`](../../../src/web/websocket/handlerUtils.js) encapsula la
búsqueda:

1. Si la petición apunta a un archivo existente → búsqueda forzada en
   `QueryType.FILE`.
2. Las URL `music.youtube.com` se reescriben como `www.youtube.com`, pues el
   extractor no las resuelve de otro modo.
3. Si no hay ningún resultado y la URL es de tipo YouTube, repliegue sobre
   **yt-dlp** (`youtube-dl-exec`) en modo `flatPlaylist`, y luego resolución
   pista por pista. Esta vía cubre los álbumes de YouTube Music (`OLAK5uy_…`).
4. Para un archivo local, el título se sustituye por el nombre de archivo
   limpiado de su prefijo técnico.

---

## Velocidad de reproducción

FFmpeg limita el filtro `atempo` al intervalo `[0.5, 2.0]`. Para cubrir de 0,20×
a 3,05×, [`index.js`](../../../src/index.js) registra 286 filtros llamados
`speed_<valor>` encadenando dos `atempo` fuera de ese intervalo:

```js
si velocidad < 0.5   →  atempo=0.5,atempo=(v / 0.5)
si velocidad > 2.0   →  atempo=2.0,atempo=(v / 2.0)
si no                →  atempo=v
```

El nombre del filtro codifica el valor con un guion bajo: `1.25` se convierte en
`speed_1_25`. La velocidad elegida se persiste en los ajustes (`playbackSpeed`) y
se **reaplica en cada `playerStart`**, pues los filtros de FFmpeg se reinician
con cada nueva pista.

Un filtro adicional, `muffled` (`lowpass=f=400`), sirve para las transiciones de
tipo DJ.

---

## Fundidos y encadenamientos

Tres mecanismos distintos actúan sobre el volumen, todos mediante
[`VolumeController`](../../../src/audio/VolumeController.js) cuando está
disponible.

### Fundido de entrada

Se desencadena en `playerStart` si `fadeinEnabled` o `mixEnabled` está activo. El
volumen parte de 0 y alcanza `baseVolume` en `fadeinDuration` segundos. El
cerrojo `queue.mixAppliedTrackId` evita aplicar dos veces el fundido a la misma
pista.

### Fundido de salida

Se aplica al detenerse (`shutdownBot`) y al apagar el proceso, mediante
`fadeOutAndSaveState()` en
[`PlaybackStateManager.js`](../../../src/database/PlaybackStateManager.js): 35
escalones, curva exponencial (`factor^2.5`) para un decrecimiento percibido como
lineal.

### Encadenamiento tipo DJ

En difusión personal, el fundido encadenado lo lleva el navegador, que dispone de
dos elementos `<audio>` y puede, por tanto, superponerlos.

En difusión común, es el **bus de mezcla** quien se encarga (véase la sección
siguiente). Cuando el tiempo restante de la pista baja de `mixDuration`
segundos, la canción siguiente se vierte en el bus por encima de la actual:

- `mixType: 'volume'` → las dos ganancias se cruzan según una ley de potencia
  constante;
- `mixType: 'effects'` → **además** un barrido de paso bajo, que cierra la
  canción saliente hacia los 400 Hz mientras la entrante se abre.

---

## Bus de mezcla (difusión común)

Una conexión de voz de Discord solo transporta un flujo: dos canciones no pueden
superponerse en él si la segunda solo puede existir sustituyendo el recurso de
audio de la primera. Por eso el encadenamiento de mezcla estuvo largo tiempo
vedado en difusión común.

[`src/audio/mix/`](../../../src/audio/mix/) levanta esta limitación interponiendo
un flujo único y permanente entre las canciones y Discord:

```
pista A ──► FFmpeg ──► PCM ──┐
                             ├──► MixBus ──► AudioResource ──► Opus ──► UDP
pista B ──► FFmpeg ──► PCM ──┘   (suma,      (permanente)
 (durante la transición)          ganancias)
```

| Módulo | Función |
|---|---|
| [`format.js`](../../../src/audio/mix/format.js) | Formato de intercambio: PCM s16le, 48 kHz, estéreo, tramas de 20 ms |
| [`input.js`](../../../src/audio/mix/input.js) | Reduce una pista a una entrada FFmpeg (caché, archivo local, extractor) |
| [`MixSource.js`](../../../src/audio/mix/MixSource.js) | Una canción decodificada: búfer, envolvente de ganancia, barrido de filtro |
| [`MixBus.js`](../../../src/audio/mix/MixBus.js) | El flujo permanente: suma las fuentes trama a trama |
| [`MixEngine.js`](../../../src/audio/mix/MixEngine.js) | Orquestación por servidor, gobierno de la cola de discord-player |
| [`playerBridge.js`](../../../src/audio/mix/playerBridge.js) | Envuelve los métodos de `GuildQueuePlayerNode` para encaminarlos hacia el bus |

**Reloj.** El bus solo produce una trama cuando el reproductor de voz se la
reclama, es decir cada 20 ms. Todas las fuentes avanzan, pues, el mismo número
exacto de muestras en cada vuelta: ninguna deriva puede instalarse entre dos
canciones superpuestas, sea cual sea la duración del fundido. Si a una fuente le
faltan datos, el bus se detiene por completo en lugar de rellenar una de ellas
con silencio — un tropiezo cuesta un blanco, nunca un desfase.

**Transparencia.** Fuera de un fundido, con una sola fuente a plena ganancia y un
volumen nominal, los octetos decodificados se transmiten sin aritmética alguna:
el sonido difundido es exactamente el que FFmpeg ha producido.

**Posición de reproducción.** El bus fabrica sus tramas en cuanto se le piden, y
el codificador Opus guarda algunas de antemano: lo que se fabrica no es lo que se
oye. `MixEngine.positionMs()` resta por ello ese adelanto, medido comparando las
tramas fabricadas con `AudioResource.playbackDuration`, que solo cuenta los
paquetes realmente emitidos. Sin esta corrección, la barra de progreso saltaba al
arrancar — la cadena se llena de varios segundos en un instante — y luego se
quedaba en el sitio mientras la reproducción alcanzaba.

**Reparto de funciones.** discord-player conserva la cola de espera, el
historial, los modos de repetición y sus eventos. El motor le señala el fin de
una canción emitiendo en su repartidor las mismas señales que habría producido el
fin de un recurso, y le presenta un `AudioResource` permanente que
`queue.currentTrack` sigue consultando. Todo lo que pasaba por la cadena FFmpeg
de discord-player, en cambio, lo retoma el bus: volumen y ducking (ganancia
maestra), pausa, reposicionamiento, velocidad de reproducción, y la posición de
reproducción — contada ahora en muestras emitidas en lugar de estimada.

**Repliegue.** `activeEngine()` devuelve `null` cuando no hay ningún bus montado,
y cada método envuelto recae entonces sobre la implementación de origen. La
difusión personal, donde el sonido sale del navegador, nunca monta un bus.

---

## Precarga

[`PreloadManager`](../../../src/audio/PreloadManager.js) descarga y transcodifica
por adelantado las pistas remotas a MP3 en `data/cache/`, por tres razones:
arranque instantáneo, resistencia a los cortes de red, y alimentación del
reproductor de audio del navegador en modo personal.

### Interceptación

En la inicialización, el método `stream()` de cada extractor registrado se
sustituye:

```js
extractor.stream = async (track, ...args) => {
    const cachedPath = this.getCachedPath(track);
    if (cachedPath) return fs.createReadStream(cachedPath);
    return originalStream.apply(extractor, [track, ...args]);
};
```

Toda reproducción de una pista ya en caché se sirve, pues, desde el disco, sin
petición de red, de manera transparente para discord-player.

### Nombrado y validez

La clave es el **SHA-256 de la URL** de la pista, y el archivo
`data/cache/<clave>.<tasa>.mp3` (`<clave>.mp3` para los archivos anteriores a la
elección de calidad, cuya tasa se desconoce). Un archivo de menos de 10 KB se
considera incompleto y se ignora. Los archivos locales nunca se ponen en caché
(`getTrackKey()` devuelve `null`).

Una descarga en curso escribe en `<clave>.<tasa>.tmp`, acompañado de
`<clave>.<tasa>.tmp.src` que memoriza la URL realmente codificada. El archivo
solo se renombra a `.mp3` una vez completo y validado.

### Selección de los objetivos

`getActivePreloadTracks()` construye la lista que hay que precargar:

| Fuente | Cantidad (ajustable de 0 a 5, o «todo») |
|---|---|
| Pista actual | siempre |
| Siguientes pistas de la cola | `preloading.queueCount` (por defecto 3) |
| Comienzo de la cola apartada por una lista de reproducción | `preloading.queueCount` (por defecto 3) |
| Pistas recientes del historial | `preloading.historyCount` (por defecto 3) |
| Continuación de la lista de reproducción activa | `preloading.playlistCount` (por defecto 3) |
| Comienzo de **cada** lista de reproducción guardada | `preloading.playlistCount` (por defecto 3) |

El reproductor solo tiene una lista física de pistas: cuando una lista de
reproducción la ocupa, es ella la que `session.getTracks()` devuelve, y la cola
de espera del usuario queda apartada en los ajustes (véase
[setAsideQueue](../../../src/utils/setAsideQueue.js)). La precarga va, pues, a
buscarla allí, sin lo cual perdería su caché en cuanto una lista de reproducción
arrancara. Es una simple lista, la misma en ambos modos de difusión y la misma
que muestra el panel: la ventana `queueCount` recae, por tanto, exactamente sobre
los títulos anunciados.

El historial se devuelve de la pista más reciente a la más antigua — el orden de
una cola LIFO, y el del panel. Son, pues, sus **primeros** títulos los que hay
que retener: los únicos que alcanzará una vuelta atrás.

Las dos últimas líneas se suman, no se excluyen: la precarga de una lista de
reproducción no depende de lo que suena. Lanzar una lista no debe vaciar la caché
de las demás — volver a ellas costaría entonces una recarga completa, y la
reproducción arrancaría sobre un corte. La lista en curso se evalúa en primer
lugar: son sus títulos venideros los que hay que tener a mano antes que nada.

Los duplicados entre estas fuentes no tienen efecto: `update()` indexa los
objetivos por clave de pista antes de actuar.

### Ciclo de actualización

`update(guildId)` se invoca en cada difusión de estado. Esta:

1. compara la lista de objetivos con la anterior y sale de inmediato si es
   idéntica — eso es lo que hace soportable la llamada cada segundo. Salvo si uno
   de los objetivos no está ni en caché ni descargándose: un fallo de red o una
   transcodificación interrumpida lo dejarían si no ausente hasta la siguiente
   reorganización de la cola, es decir nunca en una cola estable. El reintento
   respeta un plazo que se duplica en cada fallo (30 s, luego 1 min… limitado a
   15 min), para que una URL muerta no se retome a cada segundo;
2. cancela las descargas que han dejado de ser objetivo, salvo las iniciadas hace
   menos de 5 segundos (protección contra las cancelaciones prematuras);
3. elimina los archivos de caché que no son objetivo para **ningún** servidor,
   así como los archivos parciales que han dejado de ser útiles (pista fuera de
   objetivo, o pista ya enteramente en caché);
4. lanza las descargas que faltan.

El progreso se remonta al panel de control mediante la llamada de retorno
`preloadManager.onProgress`, limitada a un envío cada 150 ms.

**Cuando nada llega de la red.** La fuente puede rechazar la conexión: ffmpeg no
escribe entonces ningún octeto, y el archivo obtenido no supera el umbral de
10 KB. El fallo se anuncia por lo que es — el rechazo y su código HTTP — y no
como un archivo corrompido: el disco no tiene nada que ver, y decirlo evita
buscar por el lado de la caché. En una pista de YouTube, un 403 señala casi
siempre un yt-dlp periclitado, que `npm run update-ytdlp` pone al día: las URL
que YouTube entrega están ligadas al cliente que las ha pedido, y sus reglas
cambian más deprisa que el binario entregado con el paquete.

### Descarga por tramos

Una precarga tardaba doce minutos para un archivo de veinticinco. El registro
mostraba a FFmpeg escribiendo unos 32 KB/s, apenas el doble del tiempo real, allí
donde una transcodificación MP3 corre a cien veces. No era ni el disco, ni el
procesador, ni el códec:

```
GET simple, sin cabecera Range      →     32 754 B/s
la misma URL en tramos de 4 MB      → 38 000 000 B/s
```

YouTube **limita una descarga progresiva continua al ritmo de reproducción**. No
es una avería: es lo que hace falta para que un navegador que reproduce un vídeo
no tire cien veces más rápido de lo que consume. Pero aquí no escuchamos,
archivamos — y FFmpeg, que abre una única petición y la mantiene abierta de
principio a fin, cae justo en ese caso.

[`rangeStream.js`](../../../src/audio/rangeStream.js) vuelve a pedir la misma
dirección trozo a trozo, con una cabecera `Range`, y recose las respuestas en un
flujo único. Ninguna petición permanece abierta el tiempo suficiente para ser
limitada, y FFmpeg recibe el conjunto por su entrada estándar sin saber de dónde
viene. El tramo es de cuatro megabytes: lo bastante corto para pasar bajo la
limitación, lo bastante largo para que el coste de establecer la conexión se
diluya en él.

Un flujo antes que un archivo temporal, porque permite empezar a codificar antes
del final de la descarga y porque la cadena ya sabe recibir «una URL o un flujo»
— no hay nada que reorganizar, ni que limpiar después. Un servidor que no sabe
trocear responde `200` en lugar de `206` y lo envía todo: el módulo vierte esa
respuesta y se detiene, de modo que ningún llamante ha de saber si la fuente
gestiona los rangos.

Lo que se pierde: sobre una URL, FFmpeg puede saltar al medio del archivo sin
descargar su principio, de lo que se aprovechaba la reanudación de más abajo.
Sobre una entrada estándar debe leer y descartar — pero leer y descartar
veinticinco megabytes a 38 MB/s lleva menos de un segundo, frente a los doce
minutos que costaba la limitación.

### Reanudación tras un reinicio

Los archivos parciales se eliminaban en el arranque: una precarga interrumpida al
95 % partía de cero, y en las pistas largas un ritmo normal de reinicios bastaba
para que nunca llegaran a la caché. Ahora se conservan y se completan.

Un MP3 no es más que una sucesión de tramas independientes, cada una precedida de
una cabecera de 4 octetos que lleva su propia longitud.
[`analyzePartial()`](../../../src/utils/mp3.js) las recorre para determinar hasta
qué octeto el archivo está íntegro — la última trama está casi siempre amputada,
al haber sido matado el proceso en plena escritura — y a qué posición temporal
corresponde ese octeto.

`startDownload()` trunca entonces el parcial en esa frontera de trama, lanza
FFmpeg con `-ss <posición>` **antes** de `-i` (sobre una URL directa, el comienzo
ni siquiera se vuelve a descargar) y añade el resultado a continuación del
archivo. El empalme es exacto hasta la muestra. Dos opciones son necesarias:
`-id3v2_version 0` y `-write_xing 0`, sin las cuales cada segmento codificado se
abriría con una etiqueta ID3 que acabaría en medio del archivo.

Dos salvaguardas enmarcan la reanudación:

- **Fuente verificada.** La clave deriva de la URL *pedida*, no de la que acabó
  codificándose: un título de Spotify se puentea hacia YouTube, y nada garantiza
  que la búsqueda vuelva a dar con el mismo vídeo. El parcial solo se reanuda si
  `.tmp.src` se corresponde con la URL resuelta; si no, se recodifica desde cero.
- **Integridad verificada.** Un flujo que se rompe deja que FFmpeg termine
  limpiamente con lo que ha recibido: el tamaño del archivo ya no dice si está
  entero, puesto que un parcial reanudado supera forzosamente el mínimo. La
  duración codificada se compara con la duración anunciada por la pista (95 % de
  tolerancia); por debajo, el archivo sigue siendo un parcial en lugar de
  promoverse a caché.

Un fallo conserva, pues, lo que se ha codificado, para el siguiente intento. Una
cancelación (pista que ha dejado de ser objetivo) elimina, en cambio, el parcial,
igual que la purga retira su archivo de caché.

### Tope de tamaño

La purga por pertinencia no basta: solo retira las pistas que no son objetivo
para ningún servidor. Con varias listas de reproducción voluminosas, el conjunto
de los objetivos puede por sí solo superar cualquier límite razonable.

`enforceCacheLimit()` devuelve la caché por debajo de `MAX_CACHE_MB` (2048 MB de
manera predeterminada) desalojando los archivos **más antiguos primero**, con la
excepción de las pistas en curso de reproducción — protegidas explícitamente para
no provocar una nueva descarga inmediata.

El índice en memoria `cacheIndex` (clave → `{ size, mtime }`) permite aplicar el
tope sin volver a interrogar el sistema de archivos. Se reconstruye en el
arranque, y luego se mantiene al día en cada descarga terminada y en cada purga.

Si el tope se supera cuando **todas** las pistas están protegidas, se registra un
aviso y no se elimina nada: más vale superarlo temporalmente que cortar una
reproducción en curso.

---

## Nivel sonoro (LUFS)

El LUFS (EBU R128) mide la sonoridad *percibida*, no la amplitud: dos archivos
con el mismo LUFS se oyen al mismo nivel, sea cual sea su dinámica. Tres módulos
se reparten el asunto, y la separación importa.

[`loudness.js`](../../../src/audio/loudness.js) solo hace la conversión: no
conoce ni FFmpeg ni la cadena de audio. Una pista lleva una **medida**
(`measured`, `peak`) y, eventualmente, un **objetivo** (`target`); la ganancia
en decibelios es su diferencia, acotada. Sin medida la ganancia es nula — un
objetivo por sí solo no significa nada, y corregir a ojo sería peor que no hacer
nada.

[`LoudnessAnalyzer`](../../../src/audio/LoudnessAnalyzer.js) produce la medida
lanzando `ffmpeg -af loudnorm=print_format=json` sobre el archivo — la caché de
precarga si existe, el archivo del disco si no. Un análisis a la vez: la
decodificación de la reproducción pasa antes. El resultado se escribe en la base
y no se vuelve a calcular, ya que un archivo no cambia de sonoridad. Una fuente
remota sin precargar no se analiza; descargarla para medirla costaría el precio
de una precarga que nadie ha pedido.

La aplicación difiere según la cadena de audio:

- **Bus de mezcla** — [`MixSource`](../../../src/audio/mix/MixSource.js) lleva
  un `levelGain` separado de la envolvente de fundido. Separado, porque puede
  superar 1 cuando la envolvente no puede, y porque describe otra cosa: la
  envolvente dice dónde está un fundido, la ganancia de nivel dice a qué nivel
  se oye la pista. Ambos se multiplican por trama. Un cambio se reparte en diez
  tramas (200 ms), sin lo cual cada paso del deslizador se oiría como un chasquido.
- **Navegador** —
  [`loudnessGain.js`](../../../src/web/public/js/loudnessGain.js) envuelve la
  propiedad `volume` de los dos elementos `<audio>`. El resto del panel sigue
  escribiendo el volumen *deseado* — rampas de fundido, ducking, apagado — y la
  envoltura coloca el producto. Un `<audio>` no supera el volumen 1: la
  atenuación es exacta, la amplificación solo dispone del margen que deja el
  control principal.

La sincronización es una **capa**, nunca una escritura. Cuando `lufsSyncEnabled`
está activo, `effectiveTarget()` devuelve el objetivo común sin tocar los
objetivos individuales, que permanecen en la base. Es esa distinción, y solo
ella, la que permite desmarcar la opción y devolver a cada pista el ajuste que
tenía.

---

## Archivos locales

[`LocalFilePlayer`](../../../src/audio/LocalFilePlayer.js) proporciona el escaneo
de carpetas usado por el comando `/playlist`: recorrido recursivo, filtrado sobre
`config.supportedExtensions`, orden por nombre, mezcla Fisher-Yates opcional.

Las extensiones reconocidas se declaran en
[`config.js`](../../../src/config.js): `supportedExtensions` para el audio,
`supportedVideoExtensions` para el vídeo. Estas listas sirven también a la
salvaguarda de seguridad de las rutas ([07 — Seguridad](07-securite.md)).
