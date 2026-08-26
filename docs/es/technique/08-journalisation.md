# 08 — Registro

[← Índice](README.md)

---

## Uso

```js
const log = require('../utils/logger');   // ruta relativa al archivo

log.debug('[Ducking Debug] Détection parole - Début');
log.info('[Player] ▶ En lecture : ' + track.title);
log.success('[Bot] Connecté à Discord');
log.warn('[Upload] Extension refusée : ' + name);
log.error('[Player] Erreur de lecture :', err);   // un Error conserva su pila
```

**`console.*` ya no debe usarse en `src/`** (salvo en `web/public/`, que se
ejecuta en el navegador). El logger es el único punto de entrada.

---

## Niveles

| Nivel | Gravedad | Uso |
|---|---|---|
| `debug` | 10 | Trazas internas, detalle de diagnóstico |
| `info` | 20 | Desarrollo normal |
| `success` | 20 | Etapa lograda notable — variante de `info`, distinguida en la visualización |
| `warn` | 30 | Anomalía no bloqueante |
| `error` | 40 | Fallo |

`LOG_LEVEL` fija el umbral (por defecto `debug`, luego pasa todo). `success`
comparte la gravedad de `info`: filtrar a `info` conserva ambos.

Las salidas de gravedad `warn` y superior van a `stderr`, las demás a `stdout`.

---

## Lo que este módulo ha sustituido

Antes, [`WebServer.js`](../../../src/web/WebServer.js) **sustituía
`console.log`, `console.warn`, `console.error` y `console.info`** al cargarse el
módulo, para captar los mensajes y enviarlos al panel de control. De ello se
derivaban dos defectos.

**Un acoplamiento invertido.** El módulo web gobernaba el registro de toda la
aplicación. Cargar `WebServer` tenía como efecto secundario modificar `console`
globalmente.

**Un nivel adivinado a partir del texto.** El nivel se deducía por búsqueda de
subcadenas:

```js
else if (u.includes('WARN') || u.includes('WARNING') || u.includes('ATTENTION'))
    detectedLevel = 'WARN';
```

Un mensaje francés perfectamente normal que contuviera «attention» se clasificaba
así como advertencia. La misma heurística existía **por duplicado** del lado del
cliente, en `logs.js`, donde reescribía el nivel de toda entrada `INFO`.

El nivel se fija ahora en el punto de llamada, y ambas heurísticas se han
retirado.

---

## Arquitectura

El logger es **autónomo**: no tiene ninguna dependencia hacia el servidor web. El
acoplamiento está invertido — `WebServer` se suscribe a él.

```
   módulos de la aplicación
          │  log.info(...)
          ▼
   ┌──────────────┐
   │   Logger     │
   └──────┬───────┘
          ├──► process.stdout / stderr        (terminal)
          ├──► historial en memoria (200)      (clientes nuevos)
          ├──► suscriptores                    (WebServer → WebSocket)
          └──► búfer → data/logs/*.log         (agrupado)
```

### Suscripción

```js
log.subscribe((entry) => { /* entry = { timestamp, level, text } */ });
```

Devuelve una función para darse de baja. `WebServer` la utiliza en su constructor
para difundir cada entrada a los clientes WebSocket conectados.

`log.getHistory()` devuelve las 200 últimas entradas, enviadas al conectarse un
cliente bajo el tipo `logsHistory`.

### Formateo de los argumentos

| Tipo | Representación |
|---|---|
| `string` | tal cual |
| `Error` | `err.stack`, mensaje y pila conservados |
| objeto | `util.inspect(obj, { depth: 2, breakLength: Infinity })`, en una línea |
| otro | `String(arg)` |

El tratamiento de los `Error` es una corrección notable: el formateo antiguo
utilizaba `JSON.stringify`, que reduce un `Error` a `{}`. El panel de control no
mostraba, por tanto, nada aprovechable para diagnosticar una avería.

### Escritura en disco

Dos archivos por ejecución:

- `data/logs/<AAAA-MM-DD_HH-MM-SS>.log` — registro de la instancia;
- `data/logs/latest.log` — reescrito en cada arranque, siempre el más reciente.

Las líneas se **agrupan**: escritura tras 250 ms o 64 entradas, en lugar de dos
`appendFileSync` síncronos por línea. `flush()` fuerza la escritura y está
conectado a `process.on('exit')`, lo que cubre los reinicios por
`process.exit()`.

Formato de línea:

```
[2026-08-02 21:05:07] [ERROR  ] [Player] Erreur de lecture : ...
```

### Retención

`LOG_RETENTION` registros conservados (por defecto 20). La purga se ejecuta
**después** de la creación del registro actual, de modo que la carpeta contiene
como mucho `N` archivos, incluido el de la instancia en curso. `latest.log` nunca
se purga.

---

## Configuración

`log.configure()` se invoca una vez, al cargarse
[`WebServer.js`](../../../src/web/WebServer.js):

```js
log.configure({
    dir: path.join(process.cwd(), 'data/logs'),
    level: process.env.LOG_LEVEL || 'debug',
    retention: Number(process.env.LOG_RETENTION) || 20,
});
```

Sin llamada a `configure()`, el logger funciona pero solo escribe en la salida
estándar. Es el caso de
[`deploy-commands.js`](../../../src/deploy-commands.js), que no carga el servidor
web.

---

## Registros del lado del cliente

El panel de control puede devolver sus propios mensajes al servidor mediante el
mensaje WebSocket `clientLog`:

```js
window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'Video', message: '…' } });
```

Se registran en `info` con el prefijo suministrado, y luego se redifunden como
cualquier otra entrada.
