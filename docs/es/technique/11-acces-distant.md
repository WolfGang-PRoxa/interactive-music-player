# 11 — Acceso remoto

[← Índice](README.md)

El bot escucha por defecto en `127.0.0.1`. Este capítulo cubre las dos cosas que
hay que hacer para alcanzarlo desde otro lugar: darle una dirección pública, y
dejar entrar a alguien que no sea su propietario.

---

## La dirección pública

Dos casos, según la dirección sea fija o no.

**Sin dirección fija** — el caso por defecto —, no hay nada que declarar. El uso
compartido rápido (véase [el túnel](#el-túnel)) recibe de Cloudflare una
dirección nueva en cada arranque, y el relé de retorno se ocupa de Discord.

**Con una dirección fija** — un dominio detrás de un túnel con nombre, una IP de
red local —, `PUBLIC_URL` la lleva, sin barra final. No se adivina, y Discord
exige que la URL de retorno coincida **exactamente** con la declarada en el
portal de desarrolladores, pestaña *OAuth2 → Redirects*:

```
PUBLIC_URL=https://imp.romainpiau.dev
      └──► declarar   https://imp.romainpiau.dev/auth/discord/callback
```

`PUBLIC_URL` siempre gana: en cuanto se escribe, el relé se aparta y el
recorrido vuelve a ser directo. También es lo que explica el rodeo del token por
el `state` OAuth: el panel se abre en `127.0.0.1`, donde está su cookie,
mientras que Discord redirige a `PUBLIC_URL`. Dos hosts, dos tarros de cookies,
y un retorno que no tiene el token — véase
[07 — Seguridad](07-securite.md#autenticación).

### El relé de retorno

Discord solo acepta devolver a un visitante a una dirección declarada de
antemano. La del uso compartido rápido cambia en cada arranque: habría que
volver al portal en cada inicio. El relé
([`oauthRelay.js`](../../../src/web/oauthRelay.js), y el Worker de
`tools/oauth-relay/`) es una etapa fija entre ambos:

```
panel ──/auth/discord──► Discord ──► relé (dirección fija, declarada una vez)
  ▲                                        │
  └──── /auth/discord/callback?code=… ◄────┘  hacia el origen leído en el state
```

El `state` lleva, tras su parte aleatoria, el origen desde el que partió la
conexión. El relé devuelve allí al visitante con el código. El retorno llega,
pues, donde viven las cookies del navegador — el token, el `nonce` de la
conexión —, tanto si el panel se abrió en `localhost` como por el enlace del
túnel.

El relé solo ve pasar un código de un solo uso, inservible sin el secreto de la
aplicación, que solo el bot posee. No guarda nada ni registra nada. Hay un relé
por defecto desplegado para todas las instalaciones; `OAUTH_RELAY_URL` designa
otro, y `OAUTH_RELAY_URL=off` prescinde de él.

| Destino | Aceptado | Por qué |
|---|---|---|
| `https://….trycloudflare.com` | Sí | El uso compartido rápido, cuya dirección cambia |
| `http://localhost:<puerto>`, `http://127.0.0.1:<puerto>` | Sí | La propia máquina |
| Un dominio, una IP de red local | No | Una dirección fija se declara directamente en Discord |
| Cualquier otra dirección | No | Un relé abierto llevaría los códigos a quien quisiera |

La regla está escrita dos veces — en el bot y en el Worker, que no importa nada
del repositorio —, y [`tests/oauthRelay.js`](../../../tests/oauthRelay.js)
pone a prueba ambas sobre los mismos casos.

---

## El túnel

Abrir el panel al exterior pasaba por Tailscale Funnel, y exigía cuatro gestos
que nada anunciaba: instalar Tailscale con derechos de administrador, crear una
cuenta, obtener de la red el derecho a publicar, montar el Funnel. Cada usuario
del bot tenía que repetir los cuatro.

[`cloudflare.js`](../../../src/web/cloudflare.js) los sustituye por dos, que el
bot hace con un clic. `cloudflared` es un ejecutable único: no se instala, se
deja en `data/bin/` y se lanza, sin derechos especiales. El bot lo descarga de
las publicaciones oficiales de Cloudflare y luego abre el túnel. Como el módulo
al que sustituye, primero **constata**, y solo actúa cuando se le pide.

### Los estados

| Estado | Lo que se constata | Gesto siguiente |
|---|---|---|
| `absent` | No se encuentra `cloudflared` | Descargarlo (un clic) |
| `downloading` | La descarga está en curso | — |
| `needsAddress` | Token de túnel con nombre, pero sin `PUBLIC_URL` | Declarar la dirección del túnel |
| `ready` | Todo está listo; queda abrir el túnel | `mount()` — deliberadamente |
| `starting` | Lanzado, Cloudflare aún no lo ha confirmado | Esperar unos segundos |
| `serving` | El panel es accesible desde internet | — |
| `failed` | El túnel se detuvo por sí solo | Reintentar, se indica la causa |

Toda la decisión cabe en `decide()`, función pura de lo constatado: cada estado
se pone a prueba sin descargar `cloudflared` ni abrir un túnel. No se lanza nada
para constatar — todo está ya en el proceso del bot —, de modo que la ventana
puede pedir el estado tantas veces como quiera.

### El uso compartido rápido

Es el modo por defecto, y no exige ninguna cuenta. `cloudflared tunnel --url`
abre un túnel y Cloudflare le asigna una dirección
`https://….trycloudflare.com`, leída en su salida — nunca adivinada.
`api.trycloudflare.com`, que aparece en sus errores, no es una de ellas.

La dirección cambia en cada arranque. Los invitados no lo sufren, puesto que el
bot les publica el enlace; Discord pasa por el relé. **Nunca se copia en
`PUBLIC_URL`**: las cookies pasarían a `Secure`, y la sesión de quien está ante
la máquina, en `http://localhost`, dejaría de funcionar.

Cloudflare presenta estos túneles como una herramienta de prueba: sin garantía
de disponibilidad, y con un tope de peticiones simultáneas. Para un canal entre
amigos basta de sobra; la dirección fija sigue ahí si se queda corto.

### La dirección fija

Quien tenga un dominio en Cloudflare crea un túnel con nombre en su panel
(*Zero Trust → Networks → Tunnels*), le da un nombre de host que lleve a
`http://localhost:<puerto>`, y copia dos valores en `.env`:

```
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi…
PUBLIC_URL=https://imp.romainpiau.dev
```

El bot lanza entonces ese túnel en lugar del uso compartido rápido. El token
pasa por el entorno de `cloudflared` (`TUNNEL_TOKEN`) y nunca por su línea de
comandos, donde cualquier proceso de la máquina lo leería. Un túnel con nombre
no conoce su propio nombre de host — vive en el panel de Cloudflare —, de ahí el
estado `needsAddress` cuando falta `PUBLIC_URL`.

Un mismo túnel solo debe funcionar en una máquina a la vez: lanzado en dos,
Cloudflare repartiría a los visitantes entre ellas.

### Lo que nunca ocurre solo

Publicar expone el panel a **internet entero**. Hacerlo sin haberlo pedido
publicaría el reproductor de alguien sin que lo sepa: `mount()` solo se llama
ante un gesto del maestro. Ese gesto se recuerda (`data/tunnel.json`), y el
túnel se reabre en el siguiente arranque — como el Funnel, que sobrevivía a los
reinicios. Retirar el uso compartido lo olvida.

El túnel vive con el proceso del bot y se detiene con él.

Los cuatro mensajes del dominio — `tunnelState`, `tunnelInstall`,
`tunnelMount`, `tunnelUnmount` — están **reservados al maestro de sesión**.
Hacer el panel accesible, o traer un ejecutable a la máquina del anfitrión, no
es una orden que se comparta.

### Los límites de Cloudflare

- **100 MB por petición** en el plan gratuito, más allá de los cuales
  Cloudflare responde 413 sin que el bot vea nada. El navegador divide, pues,
  todo archivo de más de 64 MB, y el servidor recompone los trozos
  ([`chunkedUpload.js`](../../../src/web/chunkedUpload.js)). `MAX_UPLOAD_MB`
  se aplica al total y conserva todo su sentido.
- **Una sola dirección de origen.** Todas las peticiones llegan de
  `cloudflared`, es decir, de la propia máquina: el limitador de tasa lee la
  dirección real en `CF-Connecting-IP`, en la que solo confía en una conexión
  que venga de la máquina.
- **El vídeo.** Las condiciones del CDN de Cloudflare reservan en principio la
  difusión de vídeo a sus ofertas de pago. Un uso personal entre amigos sigue
  siendo modesto, pero el relé de vídeo del panel está en zona gris.

---

## Hacer entrar a alguien

El recorrido completo, del enlace publicado al invitado que pilota:

```
maestro ──sendInviteLink──► el bot publica el enlace en el chat del canal de voz
                                            │
                     el invitado pulsa ─────┴──► GET /auth/discord
                                                       │
                                             Discord lo identifica
                                                       │
                                            GET /auth/discord/callback
                                                       │
                                       sesión abierta, ficha en el libro
                                                       │
                                      panel **inerte**: ningún derecho
                                                       │
maestro ──admitGuest─────────────────────────────► el invitado es admitido
maestro ──shareControl───────────────────────────► derechos concedidos, gesto a gesto
```

El orden es querido: el maestro solo puede marcar casillas para gente que se ha
presentado. Un invitado reconocido pero sin derechos ve un panel que lo muestra
todo y no ordena nada.

El enlace publicado en el chat **no lleva el testigo de acceso**. Es lo que
permite publicarlo: el testigo aparece en la consola de quien ha lanzado el bot,
y vale el control total. El invitado que pulsa no aporta más que su cuenta de
Discord.

Una cuenta que no es miembro de ningún servidor del bot es rechazada — en la
puerta como en todas partes.

### Recordar a un invitado

Una sesión de Discord no cruza la frontera entre dos navegadores, y dura menos
que los derechos que se conceden. Dos preguntas se separan por tanto, y esa
separación basta: **¿quién es esta persona?** corresponde al libro
([`guests.js`](../../../src/web/guests.js), `data/guests.json`), **¿es suya esta
pestaña?** corresponde a la sesión
([`sessions.js`](../../../src/web/sessions.js)).

El libro no contiene **ningún secreto**: ni testigo de acceso, ni testigo de
Discord, nada que permita hacerse pasar por alguien. Figurar en él significa
«esta cuenta se ha autenticado al menos una vez», nunca «esta cuenta tiene
derecho a…».

Véase [07 — Seguridad](07-securite.md#recordar-a-un-invitado) para el
reconocimiento mudo (`prompt=none`) y sus salvaguardas.

---

## En caso de modificación

- Un nuevo mensaje que toque el túnel o la compartición debe declararse
  `MASTER_ONLY` en [`permissions.js`](../../../src/web/permissions.js). Un
  mensaje desconocido para la tabla ya lo está por defecto, pero confiarse al
  repliegue vuelve ilegible la intención.
- No fabricar nunca la URL de retorno del lado del cliente: el portal de Discord
  espera la que construye el servidor, y una diferencia de un carácter hace
  fracasar todo el recorrido.
- Tocar los destinos del relé es tocar las dos copias de la regla —
  `oauthRelay.js` y `tools/oauth-relay/src/index.js` — y volver a desplegar el
  Worker.
- `decide()` debe seguir siendo una función pura de lo que recibe. Es lo que la
  hace comprobable sin `cloudflared`.
