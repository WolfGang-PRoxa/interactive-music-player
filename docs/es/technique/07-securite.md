# 07 — Seguridad

[← Índice](README.md)

El bot expone un servidor web que gobierna la reproducción, lee archivos del
disco y puede detener el proceso. Esta página describe las protecciones
dispuestas y el modelo de amenaza adoptado.

---

## Modelo de amenaza

El bot está pensado para funcionar en la máquina de su propietario. El panel de
control **no** tiene gestión de cuentas: un testigo único da acceso a todo.

Lo que queda cubierto:

- acceso desde otra máquina de la red local;
- lectura de archivos arbitrarios del disco mediante las rutas de medios;
- agotamiento de memoria o de disco por una única petición;
- parada del proceso por un tercero no autenticado.

Lo que no lo está:

- separación de privilegios entre varios usuarios del panel de control;
- exposición directa en Internet — colocar el bot detrás de un proxy inverso con
  TLS si hace falta;
- protección frente a un usuario legítimo malintencionado.

---

## Autenticación

[`auth.js`](../../../src/web/auth.js) protege **HTTP y WebSocket**.

### Origen del testigo

`DASHBOARD_TOKEN` si está definido, y si no un testigo de 32 octetos generado en
el primer arranque y guardado en `data/dashboard-token` (permisos `0600`).
También se muestra en la consola al arrancar.

### Por qué una cookie

El panel de control carga sus medios mediante `<audio src>`, `<video src>` y
enlaces de descarga. **Esos elementos no pueden llevar una cabecera
`Authorization`.** La cookie es, pues, el único vector que funciona para el
conjunto de los casos.

Presenta una ventaja adicional: el navegador la transmite también durante el
apretón de manos WebSocket del mismo origen, lo que protege el WebSocket sin
modificación alguna del código del cliente.

### Recorrido

```
GET /?token=<testigo>
   │
   ├─ testigo válido → pone la cookie (httpOnly, sameSite=lax, 1 año)
   │                   y luego redirige a la URL sin el parámetro
   │
   └─ testigo ausente o inválido → 401 + página de explicación
```

Retirar el testigo de la URL evita que subsista en la barra de direcciones, en el
historial o en la cabecera `Referer`.

Se aceptan tres fuentes, por orden: parámetro `token`, cookie `dashboard_token`,
cabecera `Authorization: Bearer`.

La comparación utiliza `crypto.timingSafeEqual`, para no revelar el testigo
octeto a octeto midiendo el tiempo de respuesta.

### Colocación del middleware

`auth.middleware` se monta **antes** de `express.static`. Los archivos del panel
de control quedan, pues, protegidos igual que las rutas `/api`. El WebSocket se
filtra mediante la opción `verifyClient` de `ws`.

---

## Restricción de las rutas

[`utils/mediaPaths.js`](../../../src/utils/mediaPaths.js) decide qué archivos
pueden servirse.

### El problema resuelto

Las rutas `/api/stream` y `/api/download` aceptaban una ruta en bruto del cliente
y la servían si existía:

```js
if (fs.existsSync(decodedUrl)) {
    track = { url: decodedUrl, queryType: 'file', ... };
}
```

Una petición `?trackUrl=…/.env` devolvía, por tanto, el testigo de Discord. Toda
lectura de archivo pasa ahora por `resolveMediaPath()`.

### Las tres condiciones

Una ruta solo se acepta si cumple **todas** las condiciones:

1. **extensión de medio conocida** — procedente de `supportedExtensions` y
   `supportedVideoExtensions` de [`config.js`](../../../src/config.js);
2. **existencia real**, resuelta por `fs.realpathSync` — lo que neutraliza los
   enlaces simbólicos que apunten fuera del perímetro;
3. **ubicación bajo una raíz autorizada**.

Se rechazan también de entrada las rutas que contienen un octeto nulo (que trunca
la ruta a la altura de las llamadas al sistema) y las URL remotas.

### Raíces autorizadas

| Raíz | Origen |
|---|---|
| `data/uploads` | Archivos importados |
| `data/cache` | Precarga |
| `MEDIA_ROOTS` | Bibliotecas locales, separadas por `;` o `,` |

Sin `MEDIA_ROOTS`, un archivo reproducido desde `D:\Musica` será **rechazado para
la difusión en flujo**. Es un endurecimiento deliberado: ampliar el perímetro es
una decisión explícita de quien lo explota.

La comparación no distingue mayúsculas de minúsculas en Windows.

### Defensa en profundidad

La salvaguarda se aplica en dos niveles: en la resolución de la pista pedida, y
luego antes de la lectura efectiva del archivo — incluso para una pista
procedente de la cola de espera. Una pista cuya ruta está fuera del perímetro
produce un `403`, nunca una lectura.

### La escritura, en cambio, no está encerrada

[`utils/downloadDir.js`](../../../src/utils/downloadDir.js) guarda la carpeta
donde el cuarto destino de la caja de adición escribe sus archivos, y no tiene
raíces autorizadas. La asimetría es deliberada, y merece enunciarse en lugar de
padecerse:

- **`mediaPaths` protege la lectura.** El riesgo allí es servir al cliente un
  archivo que no tiene por qué ver — de ahí un perímetro cerrado, y `.env` fuera
  de alcance.
- **La carpeta de descarga es un destino.** El riesgo ya no es divulgar, sino
  escribir donde no se debe. Ahora bien, encerrarla bajo una raíz autorizada
  equivaldría a retirar la función: quien guarda su música en `D:\Musica` quiere
  descargarla allí.

Lo que sostiene la seguridad está, pues, en otra parte. La ruta elegida se
valida antes de retenerse — existe, es una carpeta, acepta la escritura, no
contiene ningún octeto nulo —, el nombre del archivo se deriva del título de la
pista y no lo proporciona el cliente, y la escritura pasa por un nombre
provisional que solo se renombra en caso de éxito. `GET /api/browse-dirs`
permite además recorrer el árbol de la máquina anfitriona, lo que es una
capacidad nueva.

Todo ello se sostiene dentro del modelo de amenaza anterior: el bot funciona en
la máquina de su propietario, estas rutas se montan después de
`auth.middleware`, y ese mismo panel ya puede apagar el proceso. Un testigo
robado no abre, por tanto, nada que no abriera ya.

---

## Topes

| Límite | Valor | Razón |
|---|---|---|
| Carga útil WebSocket | 1 MB | El panel de control solo intercambia pequeños mensajes JSON |
| Cuerpo JSON HTTP | 1 MB | Ídem; los archivos pasan por `/api/upload` |
| Tamaño de importación | `MAX_UPLOAD_MB`, por defecto 1024 MB | Evitar que un solo POST llene el disco |
| Extensiones de importación | Lista de medios | Rechazo con `415` |

La importación se limita **durante la transferencia**: el flujo se interrumpe en
cuanto se rebasa el tope y el archivo parcial se elimina, sin esperar al fin de
la petición.

> Históricamente, el límite del WebSocket era de **1 GB**, para un mensaje
> `uploadPlay` que transportaba archivos codificados en base64. Ese mensaje ya no
> lo usaba el cliente; se ha suprimido, lo que ha permitido devolver el límite a
> un valor razonable.

---

## Exposición en red

`HOST` vale `127.0.0.1` de manera predeterminada: el panel de control solo es
accesible desde la máquina anfitriona. Para acceder a él desde un teléfono u otro
puesto, definir `HOST=0.0.0.0` — la autenticación cobra entonces todo su sentido.
En ese caso se registra un aviso en el arranque.

---

## En caso de modificación

- No transmitir nunca una ruta procedente del cliente a `fs.createReadStream`,
  `fs.statSync` o FFmpeg sin pasar por `resolveMediaPath()`.
- No montar nunca una ruta antes de `auth.middleware`.
- Todo nuevo mensaje WebSocket capaz de escribir en el disco debe validar sus
  entradas: el enrutador solo garantiza la presencia de `data`.
