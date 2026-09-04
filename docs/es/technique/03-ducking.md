# 03 — Ducking

[← Índice](README.md)

El *ducking* es la función central del bot: la música se atenúa en cuanto alguien
habla, y luego vuelve a subir tras un silencio.

---

## Principio

Discord transmite a los bots eventos de voz por canal de voz. No hace falta
ningún análisis de señal: `connection.receiver.speaking` emite `start` y `end`
con el identificador del usuario.

```
        voz detectada                      silencio
              │                               │
              ▼                               ▼
     ┌─────────────────┐              ┌─────────────────┐
     │ Set de hablantes│              │ Set de hablantes│
     │   vacío → 1     │              │   1 → vacío     │
     └────────┬────────┘              └────────┬────────┘
              │                                │
      anular la restauración          esperar `duckingDelay`
              │                                │
              ▼                                ▼
       duckDown(nivel, fundido)          duckUp(fundido)
```

Dos clases se reparten el trabajo:

- [`DuckingManager`](../../../src/audio/DuckingManager.js) — *cuándo* atenuar;
- [`VolumeController`](../../../src/audio/VolumeController.js) — *cómo* hacer variar el volumen.

Existe una instancia de cada una **por servidor**, almacenada en
`client.duckingManagers` (un `Map` indexado por `guildId`).

---

## DuckingManager

### Estado interno

| Campo | Función |
|---|---|
| `activeSpeakers` | `Set<userId>` de las personas que están hablando |
| `_restoreTimer` | Temporizador de restauración diferida |
| `_active` | Indica si los escuchadores están conectados |
| `channelId` | Canal vigilado, para la lista de exclusiones |

### Inicio de la voz

```
_handleSpeakingStart(userId)
  ├─ activeSpeakers.add(userId)
  ├─ si ducking activado Y usuario no excluido:
  │    ├─ anular el temporizador de restauración pendiente
  │    └─ si es el PRIMER hablante no excluido:
  │         └─ volumeController.duckDown(duckingLevel, duckingFade)
  └─ redifundir el estado al panel de control
```

La condición «primer hablante no excluido» evita relanzar un fundido cada vez que
una nueva persona toma la palabra cuando el volumen ya está bajado.

### Fin de la voz

```
_handleSpeakingEnd(userId)
  ├─ activeSpeakers.delete(userId)
  ├─ si ducking activado Y no queda ningún hablante no excluido:
  │    └─ programar la restauración dentro de `duckingDelay` ms
  └─ redifundir el estado al panel de control
```

El plazo es un **antirrebote**. Sin él, el volumen volvería a subir durante las
respiraciones en mitad de una frase, produciendo un efecto de bombeo. Al
dispararse, una segunda comprobación (`activeSpeakers.size === 0`) evita una
subida si alguien ha vuelto a hablar entretanto.

### Exclusiones por usuario

`database.isVoiceDetectionDisabled(guildId, channelId, userId)` permite ignorar a
determinadas personas. La lista se almacena **por canal** en los ajustes:

```json
"ignoredVoiceUsers": { "<channelId>": ["<userId>", "…"] }
```

Un usuario excluido sí se añade a `activeSpeakers` — el panel de control lo
muestra como hablante — pero no lo cuenta `_countActiveNonIgnored()` y no
desencadena, por tanto, ninguna atenuación.

La clave es **el canal que el panel de control muestra**
(`ws.selectedVoiceChannelId`), y no el canal donde el bot se encuentra: es bajo
esa clave donde `getState()` vuelve a leer la lista. Ambos coinciden la mayoría
de las veces, pero no cuando el bot no está conectado a ninguna parte — el
interruptor quedaba entonces guardado en un sitio distinto de aquel donde se
releía, y volvía a su posición de origen en el estado siguiente.

### Reconfiguración en caliente

`refresh()` se invoca tras una modificación de los ajustes:

- ducking desactivado → restauración inmediata del volumen, sin fundido;
- ducking activado y alguien habla → atenuación inmediata;
- ducking activado y silencio → restauración inmediata.

`updateConnection()` gestiona el cambio de canal del bot: los escuchadores se
retiran de la antigua conexión y se reconectan a la nueva. Omitir esta etapa
dejaría el ducking silenciosamente inoperante tras un desplazamiento.

### Duración de la escucha

**La escucha de la voz pertenece a la conexión de voz, no a la reproducción.** Se
monta sobre el evento `connection` del player — un único punto de paso, venga la
conexión de un comando, de una importación, del panel de control o de la regla de
presencia — y se desmonta con ella (`PresenceManager.detacher()`, apagado del
bot).

Antes estaba enganchada al arranque de una pista, y se desmontaba en `emptyQueue`
únicamente en el modo «todo el mundo». Dos consecuencias: el panel de control
dejaba de animar a los oyentes en cuanto terminaba la última pista aunque el bot
siguiera allí, y una conexión establecida en difusión personal — donde ninguna
pista arranca del lado del bot, pues el sonido sale del navegador — permanecía
sorda. La actividad vocal se capta ahora en ambos modos, con la cola vacía o no.

### Remonte al panel de control

Cada inicio y cada fin de la voz emite un mensaje ligero `speakers`
(`WebServer.broadcastSpeakers()`), siguiendo el modelo de `progress`: la voz va y
viene varias veces por segundo y por persona, y responder a ello con un estado
completo reserializaría cada vez la cola, el historial y las listas de
reproducción. El mensaje solo lleva la lista de los hablantes, y se dirige
únicamente a los paneles de control que muestran el canal que el bot escucha.

Este remonte estaba roto: el código llamaba a
`WebServer.instance.broadcastState()` cuando `require('../web/WebServer')`
devuelve **la instancia**, siendo `instance` una propiedad estática puesta sobre
la clase — luego siempre `undefined`. No partía ninguna notificación. El panel de
control solo se enteraba de quién hablaba en la siguiente difusión de estado
motivada por otra razón, de ahí una caja «Actividad vocal» que casi nunca se
animaba. En difusión personal, la consecuencia iba más lejos: allí el ducking lo
aplica **el navegador** sobre su propio elemento de audio (`clientDucking`, en
`app.js`), a partir de `state.speakers`. Sin estos mensajes, ninguna atenuación
era posible en ese modo.

### Hablantes fantasma

Discord anuncia los cambios de micrófono, no las salidas: alguien que abandona el
canal hablando no produce **ningún** «fin de voz». Quedaba entonces inscrito en
`activeSpeakers` para siempre — halo encendido en el panel de control, y volumen
mantenido bajo para un canal silencioso.

Dos limpiezas responden a ello: `oublierLocuteur(userId)` en la salida de un
usuario (escuchador `VoiceStateUpdate`), y `oublierLocuteurs()` cuando la conexión
cambia o el bot es desplazado — lo que una conexión desaparecida había visto ya
no vale nada.

---

## El oído de la conexión

Todo lo anterior supone que la conexión de voz sepa **recibir**. No está
garantizado: discord-player 7 ya no se apoya en `@discordjs/voice` sino en
`discord-voip`, una bifurcación reducida a la difusión cuyas conexiones no
tienen `receiver` — el símbolo `VoiceReceiver` ni siquiera existe allí.

El manifiesto del proyecto pide por tanto redirigir ese nombre a
`@discordjs/voice`, que sí lo tiene. Pero npm coloca igualmente una copia propia
bajo la carpeta de discord-player:

```
node_modules/
├── discord-voip/          ← el alias a @discordjs/voice, con receiver
└── discord-player/
    └── node_modules/
        └── discord-voip/  ← la verdadera discord-voip, sin él
```

Como Node busca primero en la carpeta de quien pide, gana la segunda, y los
`overrides` no pueden nada: discord-player declara `discord-voip: ^7.2.0`, un
rango que `@discordjs/voice@0.19.2` no satisface, y npm renuncia en silencio —
un archivo de bloqueo regenerado sale idéntico.

[`tools/keep-voice-receiver.js`](../../../tools/keep-voice-receiver.js),
enganchado a `postinstall`, aparta la copia anidada tras cada instalación. Node
sube entonces un nivel y encuentra la que oye. El gesto debe repetirse cada vez,
incluidas las instalaciones que el propio bot desencadena al cambiar de versión
([06 — Persistencia](06-persistance.md)).

La avería, al menos, ahora hace ruido. No lo hacía: leer `receiver.speaking`
lanzaba una excepción que subía por `setupDucking`, llevándose consigo el
controlador de volumen y el emisor de silencio, y el registro solo mostraba un
«Cannot read properties of undefined» sin relación aparente con el sonido. El
`DuckingManager` comprueba ahora el oído antes de engancharse a él, y lo dice.

---

## VolumeController

Encapsula el `queue.node` de discord-player para ofrecer transiciones
progresivas.

### Noción de volumen de base

`baseVolume` es el volumen cuando nadie habla (0–100). `duckLevel` es un
**porcentaje de ese volumen**, no un valor absoluto:

```js
volumenAtenuado = round(baseVolume × duckLevel / 100)
```

Con `baseVolume: 70` y `duckingLevel: 20`, la música baja a 14, no a 20. Eso es
lo que permite ajustar el volumen general sin desajustar el equilibrio del
ducking.

### Fundido

`_fadeTo(objetivo, duración)` trocea la transición en escalones de
`config.ducking.fadeStepInterval` (20 ms) y aplica un incremento lineal. Dos
atajos evitan el trabajo inútil: una duración nula o una diferencia inferior a 1
punto se aplican de inmediato.

Todo fundido nuevo anula el anterior (`_cancelFade()`), a fin de que una
alternancia rápida de voz y silencio no haga convivir dos temporizadores
contradictorios.

### Encadenamiento de pista

`updateQueueNode()` debe invocarse en cada cambio de pista: el nodo de audio lo
recrea discord-player, y la referencia antigua queda inerte. El método vuelve a
aplicar el volumen actual — 0 si la cola está restaurándose o en transición, si
no `targetVolume` o `baseVolume` según se esté atenuado o no.

El controlador se reutiliza también fuera del ducking, para los fundidos de
entrada, de salida y los encadenamientos DJ, mediante llamadas directas a
`_fadeTo()`.

---

## Ajustes

| Clave | Predeterminado | Efecto |
|---|---|---|
| `duckingEnabled` | `true` | Activa la atenuación |
| `duckingLevel` | `20` | Porcentaje del volumen de base mientras se habla |
| `duckingDelay` | `800` | Milisegundos de silencio antes de la restauración |
| `duckingFade` | `200` | Duración del fundido, en milisegundos |
| `baseVolume` | `70` | Volumen fuera de la voz |

Modificables con `/ducking …`, `/volume` o el panel de control. Las constantes
predeterminadas viven en [`config.js`](../../../src/config.js), los valores
efectivos en `data/settings.json`.

---

## Diagnóstico

Los registros de nivel `DEBUG` trazan cada etapa:

```
[Ducking Debug] Détection parole - Début pour l'utilisateur : 1234…
[Ducking Debug] Baisse du volume (duckDown) vers 20%
[Ducking Debug] Détection parole - Fin pour l'utilisateur : 1234…
[Ducking Debug] Restauration du volume planifiée dans 800ms
```

Si el ducking no reacciona, verificar por este orden:

1. ¿Está el bot conectado al canal? Sin conexión de voz no se crea ningún
   `DuckingManager`.
2. ¿Se ha llamado a `setupDucking()`? Se llama en `playerStart`, no en la
   conexión.
3. ¿Está el usuario en `ignoredVoiceUsers` para ese canal?
4. ¿Está el bot silenciado del lado del servidor? Las colas se crean con
   `selfDeaf: false` precisamente para seguir recibiendo la voz.
