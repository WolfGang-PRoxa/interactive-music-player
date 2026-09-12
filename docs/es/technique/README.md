# Documentación técnica

Documentación de ingeniería del bot **Música Interactiva**: un bot de Discord de
reproducción musical con atenuación automática del volumen al hablar
(*ducking*), gobernado por un panel de control web en tiempo real.

Esta carpeta se dirige a quienes modifican el código. Para el uso corriente,
véase la [guía de usuario](../GUIDE.md).

---

## Índice

| Documento | Contenido |
|---|---|
| [01 — Arquitectura](01-architecture.md) | Visión de conjunto, secuencia de arranque, mapa de módulos, ciclo de vida |
| [02 — Reproducción de audio](02-lecture-audio.md) | discord-player, extractores, filtros FFmpeg, velocidad, fundidos, precarga |
| [03 — Ducking](03-ducking.md) | Detección de voz, máquina de estados, control del volumen |
| [04 — Modos de difusión](04-diffusion.md) | Modo común y modo personal, reproductor virtual, transiciones |
| [05 — Panel de control](05-tableau-de-bord.md) | Servidor web, protocolo WebSocket, rutas HTTP, frontend |
| [06 — Persistencia](06-persistance.md) | Ajustes, estado de reproducción, escritura atómica, almacenamiento de importaciones |
| [07 — Seguridad](07-securite.md) | Autenticación, restricción de rutas, topes |
| [08 — Registro](08-journalisation.md) | Logger, niveles, difusión hacia el panel de control |
| [09 — Configuración](09-configuration.md) | Variables de entorno, `config.js`, despliegue de los comandos |
| [10 — Versiones](10-versions.md) | Raíces compartida y de instalación, releases de GitHub, cambio de versión |
| [11 — Acceso remoto](11-acces-distant.md) | Túnel Tailscale, `PUBLIC_URL`, compartición del control |
| [12 — Pruebas](12-tests.md) | Las baterías de `tests/`, qué cubren, cómo escribir una |

---

## Vista a 10 000 pies

El bot es un **único proceso Node.js** que hace funcionar tres cosas en
paralelo:

```
                    ┌─────────────────────────────┐
                    │       Proceso Node.js       │
                    │                             │
   Discord  ◄──────►│  Cliente discord.js         │
   (gateway         │    └─ discord-player        │──► Canal de voz (Opus/UDP)
    + voz)          │         └─ FFmpeg           │
                    │                             │
                    │  Servidor HTTP + WebSocket  │◄─► Navegador
                    │    └─ Express               │    (panel de control)
                    │                             │
                    │  Persistencia archivos JSON │──► data/
                    └─────────────────────────────┘
```

**No hay base de datos externa, ni servicio anexo, ni build**: `npm start`
basta. La contrapartida es que todo el estado vive en memoria dentro de este
proceso, con instantáneas en disco (véase
[06 — Persistencia](06-persistance.md)).

---

## Principios estructurantes

**El proceso es de instancia única, y el bot pertenece a alguien.**
El bot está pensado para alojarse en la máquina de su propietario. El testigo de
acceso abre la página, pero no nombra a nadie: los derechos van unidos a una
**cuenta de Discord**. La primera cuenta que vuelve de Discord presentando el
testigo se convierte en el maestro de sesión; las demás son invitados, que solo
tienen lo que el maestro les concede, gesto a gesto. Véase
[07 — Seguridad](07-securite.md).

**El estado de reproducción pertenece al proyecto.**
Las 26 propiedades de estado (`virtualCurrentTrack`, `channelStates`,
`transitioningToEveryone`…) se declaran en
[`PlaybackSession`](../../../src/audio/PlaybackSession.js), y ya no se injertan
sin esquema sobre el objeto `GuildQueue` de discord-player. Véase
[01 — Arquitectura](01-architecture.md#playbacksession).

**El panel de control es un espejo, no una fuente de verdad.**
El servidor difunde un estado completo; el cliente lo muestra. Toda acción del
cliente es un mensaje WebSocket que modifica el estado del servidor, el cual
vuelve a difundir.

**Nada se transpila.**
CommonJS del lado del servidor, scripts globales del lado del navegador. Sin
bundler, sin TypeScript. Express sirve los archivos del frontend tal cual.

---

## Convenciones

- **Idioma**: comentarios, registros y documentación en francés; identificadores
  en inglés.
- **Módulos**: CommonJS (`require`). Los singletons se exportan ya instanciados
  (`module.exports = new Foo()`).
- **Registro**: nunca `console.*`, siempre
  `log.debug|info|success|warn|error` (véase [08 — Registro](08-journalisation.md)).
- **Rutas de disco expuestas al cliente**: nunca en bruto, siempre a través de
  `resolveMediaPath()` (véase [07 — Seguridad](07-securite.md)).
- **Escritura de archivos JSON**: nunca `writeFileSync` directo, siempre
  `writeJsonAtomic()` (véase [06 — Persistencia](06-persistance.md)).

---

## Limitaciones conocidas

Estos puntos son deudas identificadas, no errores que haya que notificar.

| Tema | Descripción | Véase |
|---|---|---|
| Estado de reproducción | Los 375 sitios acceden todavía al estado mediante `queue.xxx`, ahora accesores hacia `PlaybackSession`. Queda por hacer su reescritura en `session.xxx`. | [01](01-architecture.md#playbacksession) |
| Bucle de difusión de 1 s | El intervalo nunca se detiene — no existe un `stop()` en `WebServer`. La carga útil periódica, en cambio, se ha reducido a ~200 bytes. | [05](05-tableau-de-bord.md#el-bucle-de-actualización) |
| Doble modelo de reproducción | Los modos común y personal están entrelazados por ternarios `isPersonal ? … : …` en todo el código de estado. | [04](04-diffusion.md#el-coste-del-doble-modelo) |
| Parada ante un error inesperado | `uncaughtException` y `unhandledRejection` registran y luego dejan morir el proceso — es lo buscado, pero nada lo levanta de nuevo. `SIGTERM` sigue sin tratarse. | [05](05-tableau-de-bord.md#robustez) |
| Troceado del frontend inacabado | `app.js` concentra todavía 3 819 líneas que la carpeta `js/` ha empezado a extraer. | [05](05-tableau-de-bord.md#troceado-inacabado) |
