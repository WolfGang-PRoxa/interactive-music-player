# 06 — Persistencia

[← Índice](README.md)

Ninguna base de datos: todo se almacena en archivos JSON en `data/`, con una
caché en memoria que hace fe durante la ejecución.

---

## Visión de conjunto

| Archivo | Contenido | Ritmo de escritura |
|---|---|---|
| `data/settings.json` | Ajustes por servidor + listas de reproducción globales | En cada modificación, agrupadas en 120 ms |
| `data/playback_state.json` | Último estado de reproducción conocido | Cada 5 s y ante un evento |
| `data/dashboard-token` | Testigo de acceso | Una vez, en el primer arranque |

> `better-sqlite3` figura en `optionalDependencies` pero **nunca se importa**. Es
> un vestigio de un enfoque abandonado: la compilación nativa daba problemas en
> Windows.

---

## Escritura atómica

[`utils/atomicJson.js`](../../../src/utils/atomicJson.js) es el único punto de
escritura JSON autorizado.

### El problema resuelto

`fs.writeFileSync` **trunca el archivo antes de reescribirlo**. Un corte durante
esa ventana deja un JSON incompleto, y por tanto ilegible. El comportamiento
anterior agravaba la pérdida: el error de análisis se interceptaba, la caché
partía vacía, y el primer guardado siguiente sobrescribía definitivamente el
archivo corrompido.

### La secuencia

```
1. escribir en  .<nombre>.<pid>.tmp   (misma carpeta, luego mismo sistema de archivos)
2. fsync                               (garantizar que los octetos están en el disco)
3. rename  →  <nombre>                 (operación atómica)
```

En todo instante, el archivo destino es o bien la versión antigua completa, o
bien la nueva. El `fsync` no es opcional: sin él, el renombrado puede preceder a
la escritura real de los octetos, y un corte de corriente deja un archivo vacío.

`renameSync` sí sobrescribe un destino existente en Windows, pues libuv utiliza
`MOVEFILE_REPLACE_EXISTING`.

### Lectura y puesta en cuarentena

`readJsonSafe()` renombra un archivo ilegible como `<nombre>.corrompu-<fecha>` en
lugar de dejar que se sobrescriba. El arranque prosigue con los valores
predeterminados, y el archivo sigue siendo recuperable.

`cleanStaleTemp()` elimina en el arranque los `.tmp` dejados por una parada
brutal.

### Serialización

`createSafeReplacer()` gestiona los `BigInt` (convertidos en cadena) y las
referencias repetidas. **Atención**: descarta todo objeto ya encontrado, no solo
los ciclos reales. Es el comportamiento histórico, conservado para no modificar
la salida; un objeto legítimamente presente en dos lugares quedaría omitido en su
segunda aparición.

El replacer conserva un estado interno — debe crearse para **cada**
serialización.

---

## Database

[`Database.js`](../../../src/database/Database.js) — singleton, ajustes por
servidor y listas de reproducción globales.

### Estructura del archivo

```json
{
  "__global__": {
    "playlists": [ { "id": "playlist_…", "name": "…", "tracks": [...] } ],
    "lastGuildId": "…",
    "lastVoiceChannelId": "…"
  },
  "<guildId>": { "duckingEnabled": true, "baseVolume": 70, ... }
}
```

Las listas de reproducción son **globales**, comunes a todos los servidores. Una
migración automática (`_migratePerGuildPlaylists`) desplaza las listas heredadas
de un almacenamiento por servidor hacia `__global__` en el primer arranque.

### Caché y escritura

La caché `Map` hace fe durante la ejecución; el archivo no es más que una
proyección suya. `_save()` **programa** una escritura agrupada en 120 ms: una
ráfaga de modificaciones solo provoca un paso por el disco.

`flush()` fuerza la escritura inmediata. Está conectada a `process.on('exit')`,
lo que cubre también los `process.exit()` de reinicio y de apagado — esas vías no
pasan por `close()`.

### Lectura sin efecto secundario

`getSettings()` devuelve `{ ...predeterminados, ...caché }`: los valores
predeterminados se vuelven a aplicar en cada lectura, de modo que añadir una
clave a `_defaults()` basta para que todos los servidores existentes la hereden.

Este método **no escribe** en disco para un servidor desconocido — antes lo
hacía, siendo así que se le invoca en bucle cada segundo. La entrada simplemente
se pone en caché; la primera modificación real la persistirá.

### Métodos principales

| Método | Efecto |
|---|---|
| `getSettings(guildId)` | Ajustes fusionados con los valores predeterminados |
| `updateSettings(guildId, patch)` | Fusión y guardado diferido |
| `getGlobalPlaylists()` | Lista de las listas de reproducción |
| `createPlaylist`, `renamePlaylist`, `deletePlaylist`, `reorderPlaylists` | Gestión de las listas de reproducción |
| `addTrackToPlaylist`, `removeTrackFromPlaylist`, `movePlaylistTrack` | Gestión de las pistas |
| `toggleVoiceDetection`, `isVoiceDetectionDisabled` | Exclusiones de ducking |
| `setLastVoiceChannel`, `getLastVoiceChannel` | Último canal visitado |
| `applyStartupChannel()` | Fija el canal de apertura — solo en el arranque |

`updateSettings` aplica una regla particular: definir un canal favorito
(`defaultVoiceChannelId`) lo retira de todos los demás servidores — solo hay un
favorito global.

`applyStartupChannel()` se invoca una vez, en `ClientReady`. Escribe el favorito
en el último canal visitado al encender, y lo deja de lado al reanudar: un
reinicio debe devolver a donde se estaba. Leerlo en otra parte lo convertiría en
una
preferencia permanente, que devolvería sin fin al bot y al panel de control sobre
él — véase
[Presencia en los canales de voz](04-diffusion.md#presencia-en-los-canales-de-voz).

---

## PlaybackStateManager

[`PlaybackStateManager.js`](../../../src/database/PlaybackStateManager.js) —
instantánea de reproducción, para retomar allí donde uno se había detenido.

### Contenido guardado

Por servidor, el estado de **cada canal** (`queue.channelStates`): pista actual,
posición, cola de espera, historial, modo de repetición, reproducción o pausa.

### Ritmo

Cada 5 segundos (temporizador de [`index.js`](../../../src/index.js)) y ante cada
evento notable: arranque y fin de pista, adición, cola vacía, cambio de estado
vocal del bot.

### Restauración

`restoreAll()` se invoca en `ClientReady`. Reconecta el bot, recrea las pistas
(`new Track(...)` con reasociación del extractor por su identificador), y luego
retoma la reproducción **en silencio**:

```
restorePaused = true, volume = 0
        │
        ▼
  arrancar la reproducción
        │
        ▼
  playerStart → seek(posición guardada)
        │
        ▼
  restaurar el volumen, aplicar la pausa si es necesario
```

Sin esta precaución, el usuario oiría el comienzo de la pista antes del salto a
la posición correcta.

### Fundido de salida

`fadeOutAndSaveState()` baja el volumen en 35 escalones según una curva
exponencial antes del guardado final. Invocada ante `SIGINT` y ante
`shutdownBot`, evita el corte seco. El tiempo transcurrido se añade a
`virtualProgressMs` para que la posición guardada siga siendo exacta.

---

## Almacenamiento de las importaciones

[`uploadService.js`](../../../src/web/uploadService.js) — véase también
[07 — Seguridad](07-securite.md).

### Nombrado por huella

Los archivos se almacenan como `<huella12>-<nombre original>`, donde la huella es
el prefijo de 12 caracteres del SHA-256 del **contenido**. Reimportar un archivo
ya presente reutiliza el ejemplar existente, sin copia adicional.

Este mecanismo corrige una acumulación observada: sin él, una misma canción
reimportada producía tantas copias como importaciones.

### Nombrado diferido

La transferencia transita por `.incoming-<pid>-<marca de tiempo>-<azar>`,
renombrado solo una vez completa. Una transferencia interrumpida no deja, pues,
ningún medio truncado en la biblioteca. Los huérfanos de una parada brutal se
purgan en el arranque mediante `cleanIncomingUploads()`.

### Nombre mostrado

`getCleanFilename()` de [`utils/paths.js`](../../../src/utils/paths.js) retira el
prefijo técnico. Gestiona ambas formas: la huella actual y la marca de tiempo de
los archivos importados antes de la deduplicación, todavía referenciados por las
listas de reproducción existentes.
