# 04 — Modos de difusión

[← Índice](README.md)

El bot dispone de dos modos de reproducción radicalmente distintos. Comprender su
diferencia es indispensable antes de tocar el código de estado.

---

## Los dos modos

| | `everyone` (común) | `personal` |
|---|---|---|
| Por dónde sale el sonido | Canal de voz de Discord | Navegador del usuario |
| Quién decodifica | discord-player + FFmpeg | Etiqueta `<audio>` del panel de control |
| Posición de reproducción | `queue.node.getTimestamp()` | Contador calculado del lado del servidor |
| Ducking | Activo | Sin objeto |
| Pista actual | `queue.currentTrack` | `queue.virtualCurrentTrack` |
| Cola de espera | `queue.tracks` | `queue.virtualTracks` |

El ajuste es `broadcastMode`, por servidor.

---

## Modo común

El funcionamiento esperado de un bot musical: discord-player decodifica el flujo
y lo emite en el canal de voz. Todo el mundo oye lo mismo, el ducking se aplica.

---

## Modo personal: el reproductor virtual

En modo personal, **el bot no decodifica sonido alguno**. Mantiene al día un
estado de reproducción ficticio, y es el navegador quien reproduce realmente el
audio mediante `/api/stream`.

### Por qué un reproductor virtual

El panel de control debe seguir mostrando una pista, un progreso, una cola de
espera y un historial coherentes. En lugar de crear un segundo modelo de datos,
el proyecto replica la forma de la cola en propiedades con el prefijo `virtual`.

### Avance de la posición

El progreso no se mide, se **calcula** en el bucle de actualización del servidor
web, cada segundo:

```js
const elapsed = (now - queue.virtualLastUpdated) * velocidad;
queue.virtualProgressMs += elapsed;
queue.virtualLastUpdated = now;

if (queue.virtualProgressMs >= duración) handleVirtualSkip(queue, guildId);
```

El factor `velocidad` retoma `playbackSpeed`, a fin de que el contador siga la
reproducción acelerada o ralentizada del navegador. El cliente devuelve
periódicamente su posición real mediante el mensaje `syncProgress`, lo que
corrige la deriva.

### Fin de pista

`handleVirtualSkip()` en [`WebServer.js`](../../../src/web/WebServer.js)
reproduce el comportamiento de un reproductor real: gestión del modo de
repetición, apilado en `virtualHistory`, desapilado de `virtualTracks`, y
sincronización de `playlistCurrentIndex` si hay una lista de reproducción activa.

### El emisor de silencio

Problema: sin flujo de audio, Discord cierra la conexión UDP al cabo de unos
segundos, y la vuelta al modo común exigiría una reconexión completa.

Solución — `startSilencePlayer()` en [`index.js`](../../../src/index.js): un
`Readable` en `objectMode` emite una trama de silencio Opus cada 20 ms.

```js
silenceStream.push(Buffer.from([0xF8, 0xFF, 0xFE]));  // trama de silencio Opus
```

`objectMode: true` es esencial: sin él, Node concatena las tramas en un solo
bloque, que Discord rechaza. La conexión permanece así abierta y el bot visible
en el canal, sin emitir ningún sonido audible.

---

## Cambio entre modos

### Común → personal

`BroadcastManager.setMode()`:

1. copia `currentTrack`, la posición, la cola y el historial en las propiedades
   `virtual*`;
2. vacía `queue.tracks` y `queue.history` para detener la reproducción real;
3. termina el `dispatcher` sin desconectar el bot;
4. arranca el emisor de silencio.

### Personal → común

La operación inversa es la más delicada del proyecto, pues hay que **retomar la
reproducción en la posición exacta** en la que el navegador iba.

```
transitioningToEveryone = true
transitionTrack         = pista que retomar
transitionTargetProgress = posición en ms
        │
        ▼
  queue.play(track)  ── volumen forzado a 0
        │
        ▼
  evento 'playerStart'
        │
        ├─ esperar 100 ms (dejar que el flujo se establezca)
        ├─ queue.node.seek(progress)
        ├─ retirar la pista del historial (el seek la añade allí por error)
        ├─ retirar el eventual duplicado de la cola
        ├─ transitioningToEveryone = false
        └─ restaurar el volumen (o fundido de entrada si está configurado)
```

El volumen se mantiene a 0 durante toda la maniobra: sin ello, el usuario oiría
el comienzo de la pista antes del salto a la posición correcta. Las banderas
`restorePaused` y `transitioningToEveryone` las consulta
[`VolumeController`](../../../src/audio/VolumeController.js) en su construcción y
en cada cambio de nodo, para no subir el volumen prematuramente.

---

## Canales personales

Con independencia del reproductor virtual, `BroadcastManager` sabe crear un canal
de voz temporal privado:

- nombre: prefijo `config.broadcast.personalChannelPrefix` (🎵) seguido del
  nombre mostrado del miembro;
- permisos: `@everyone` denegado, miembro y bot autorizados;
- seguimiento en `personalChannels`: `Map<guildId, Map<userId, channelId>>`;
- eliminación automática cuando el miembro abandona el canal de voz, mediante el
  escuchador `VoiceStateUpdate` de [`index.js`](../../../src/index.js).

> Este seguimiento está **solo en memoria**. Un reinicio del bot mientras existen
> canales personales los deja huérfanos: habrá que eliminarlos a mano.

---

## El coste del doble modelo

Cada lugar que lee o escribe el estado debe distinguir los dos modos. El patrón
se repite por todo el código:

```js
const currentTrack = isPersonal ? queue.virtualCurrentTrack : queue.currentTrack;
const tracks       = isPersonal ? queue.virtualTracks       : queue.tracks.toArray();
const isPlaying    = isPersonal ? !!queue.virtualIsPlaying  : queue.node.isPlaying();
```

`getChannelPlaybackState()` en [`WebServer.js`](../../../src/web/WebServer.js) es
su expresión más densa: un solo `return` combina tres ejes (`isPersonal` ×
`transitioningToEveryone` × presencia de una marca de tiempo) en ternarios
anidados.

Una interfaz única que enmascarara la distinción — evocada en
[01 — Arquitectura](01-architecture.md#playbacksession) — suprimiría este patrón.
Toda modificación del código de estado debería, como mínimo, no agravarlo.

---

## Estado por canal de voz

El bot memoriza una instantánea de reproducción **por canal**, en
`queue.channelStates`:

```js
queue.channelStates[channelId] = {
    isPlaying, isPaused, repeatMode,
    currentTrack, currentProgress,
    queue: [...], history: [...],
    savedAt
};
```

Cambiar de canal desde el panel de control (`selectChannel`) guarda el estado del
canal abandonado antes de restaurar el del canal al que se llega. El panel de
control puede así mostrar una cola de espera para un canal donde el bot no está
conectado: `getChannelPlaybackState()` sirve entonces los datos de la caché en
lugar del estado en directo.

En difusión común, abandonar un canal **suspende** allí la reproducción: el
reproductor se pone en pausa antes del cambio — lo que hace callar el canal
durante la espera de `queue.connect()` — y la instantánea se registra en pausa en
su posición. El bot se desconecta en todos los casos: sigue al panel de control
hacia el canal al que llega, o `detacher()` lo retira si este está desierto.
Volver más tarde al canal abandonado encuentra, pues, allí la canción en pausa,
en el segundo en que se la había dejado, y no una reproducción que habría corrido
sin oyente.

La entrada en el canal al que se llega sigue sujeta a la regla de presencia: el
bot solo va allí si hay alguien. Un canal desierto cuya instantánea lleva una
reproducción permanece congelado, y el panel de control lo explica (véase más
abajo).

---

## Presencia en los canales de voz

El bot solo se instala en un canal de voz si hay alguien para oírlo. La regla la
sostiene [`PresenceManager`](../../../src/audio/PresenceManager.js), y vale para
ambos modos de difusión — en modo personal, la conexión solo sirve para captar la
voz para el ducking, pero no tiene mayor razón de ser en una sala vacía.

| Evento | Efecto |
|---|---|
| Arranque, canal previsto desierto | Sin conexión. La reproducción se restaura y luego se **congela**. |
| Primer humano que entra en el canal vinculado | Conexión, ducking reconectado, reproducción retomada en su posición. |
| Último humano que sale | Salida tras `config.presence.departureDelay` (30 s por defecto). |
| Regreso antes del fin del plazo | Salida anulada, nada se mueve. |

El **canal vinculado** es, por orden: el vínculo en curso
(`queue.activeChannelId`), el canal donde el bot se encuentra, el último canal
utilizado. Tres maneras de decir «aquel que se le ha designado», de la más
reciente a la más antigua: el bot no sigue, pues, a los oyentes de canal en
canal. A falta de todo vínculo (primer uso), se posa en el primer canal donde
aparezca alguien.

El **canal favorito no figura ahí**, y es deliberado: solo vale en el arranque
(véase más abajo). Consultado aquí, se aplicaba en cada movimiento vocal y cada
30 segundos; en cuanto faltaba el vínculo — cola creada por `/play`, por una
importación, o restaurada sin canal —, devolvía al bot a casa, y el primer oyente
que entraba en el favorito lo llamaba allí fuera cual fuera el canal donde se lo
hubiera instalado. Un canal marcado con una estrella se convertía así en una
prisión: ya no había modo de trabajar de forma duradera en otra parte.

### El canal favorito: un valor de arranque, y nada más

El favorito (`defaultVoiceChannelId`) designa el canal sobre el que el bot y el
panel de control se posan cuando el proceso arranca o se reinicia. Se lee en dos
lugares, ambos en el arranque:

- [`Database.appliquerSalonFavori()`](../../../src/database/Database.js), llamado
  una vez en `ClientReady`, hace de él el **canal actual**
  (`setLastVoiceChannel`);
- [`PlaybackStateManager.restoreAll()`](../../../src/database/PlaybackStateManager.js)
  le da prioridad para elegir el canal que restaurar, y luego inscribe esa
  elección como vínculo — incluso cuando el canal está desierto y la conexión se
  aplaza, sin lo cual la regla de presencia iría a buscar al bot a otro sitio
  distinto de aquel donde el panel de control lo anuncia en espera.

Pasado ese punto, ya nadie lo lee. Marcar un canal con una estrella en plena
sesión no desplaza, pues, nada: el ajuste queda anotado para el siguiente
arranque. Todo lo demás — regla de presencia, selector de canal, `getState` —
sigue únicamente el canal actual, que cada cambio de canal actualiza.

### La reproducción congelada

Marcharse no quiere decir perderlo todo. La cola de espera, el historial y la
pista actual permanecen en memoria; solo el reproductor de discord-player
desaparece con la conexión de voz, y con él lo único que aún sabía: por dónde iba
la reproducción. La sesión toma el relevo mientras dura la ausencia:

```js
queue.absentSalonVide     // el bot se ha retirado, o no ha entrado nunca
queue.positionFigeeMs     // posición tomada justo antes de la salida
queue.lectureFigeeEnCours // ¿estaba la reproducción en curso?
```

`session.estGelee()` es la prueba que hay que hacer antes de interrogar a
`queue.node`: un reproductor desmontado solo devuelve ceros. El panel de control,
el guardado de estado y los comandos de reproducción pasan todos por ahí —
`commanderFige()` aplica pausa, reanudación, seek, stop, skip y previous
directamente sobre el estado congelado, de modo que el panel de control sigue
siendo utilizable durante la ausencia del bot.

Un punto de conexión que renuncia a conectarse llama a `marquerAbsent()`; a la
inversa, toda conexión de voz levanta la congelación, sea cual sea su origen (el
escuchador `connection` del player).

### Decírselo al panel de control

Una reproducción congelada sigue declarada *en curso* — se reanudará por sí sola
—, pero nada avanza. Vista desde el panel de control, aquello parecía una avería:
botón de pausa, carátula que gira, y una barra de progreso que ganaba un segundo
antes de volver a perderlo, indefinidamente — el cliente interpolaba localmente
mientras el servidor devolvía cada segundo la misma posición congelada.

`session.attenteAuditeur()` devuelve con qué explicarlo, y `WebServer` le añade el
nombre del canal afectado. El panel de control muestra entonces una banda encima
de la barra («Nadie en "X": la reproducción está en espera…»), deja de interpolar
la posición y suspende las animaciones de reproducción. El mensaje distingue las
dos congelaciones: una reproducción que se reanudará a la llegada de alguien, y
una reproducción en pausa, que el regreso del bot no relanzará.

### Dos trampas de discord-player

**La destrucción del flujo pasa por un fin de pista.** Destruir el dispatcher
hace pasar el reproductor de audio al estado *Idle*, lo que discord-player
interpreta como el fin de la canción: empuja la pista al historial y enlaza con
la siguiente. El modo «transición» se levanta, pues, durante la destrucción —
`performFinish` se abstiene allí de todo tratamiento.

**El gestor de estado vocal predeterminado destruye la cola.** `leaveOnEmpty`
llama a `queue.delete()`, lo que se lleva la cola de espera, el historial y el
estado por canal. Suscribirse a `voiceStateUpdate` en el player desactiva ese
gestor; `PresenceManager` retoma por su cuenta los casos que trataba con
utilidad (silenciado del servidor, canal de conferencia, desplazamiento del bot
por un moderador). `leaveOnEmpty` se ha puesto a `false` en todas partes, para
que el código no prometa ya un comportamiento que ha dejado de existir.
