# 11 — Acceso remoto

[← Índice](README.md)

El bot escucha de manera predeterminada en `127.0.0.1`. Este capítulo cubre las
dos cosas que hay que hacer para que se le alcance desde otro sitio: darle una
dirección pública, y dejar entrar a alguien distinto de su propietario.

---

## La dirección pública

`PUBLIC_URL` es la dirección por la que los invitados alcanzan este panel de
control, sin barra final. **No se adivina**: el servidor escucha en `127.0.0.1`,
y la dirección útil — IP de la red local, túnel, nombre de dominio — solo la
conoce quien lo explota.

No sirve solo para mostrarse. Discord exige que la URL de retorno corresponda
**exactamente** a la declarada en el portal de desarrollador, pestaña *OAuth2 →
Redirects*:

```
PUBLIC_URL=http://192.168.1.20:3000
      └──► declarar   http://192.168.1.20:3000/auth/discord/callback
```

Sin `PUBLIC_URL`, la URL de retorno apunta a `127.0.0.1`: el recorrido funciona
desde la máquina anfitriona y falla en todas partes. En ese caso se registra un
aviso en el arranque.

Es también lo que explica el rodeo del testigo por el `state` de OAuth: el panel
se abre en `127.0.0.1`, donde se pone su cookie, mientras que Discord devuelve al
usuario a `PUBLIC_URL`. Dos anfitriones, dos tarros de cookies, y una llamada de
retorno que no tiene el testigo — véase
[07 — Seguridad](07-securite.md#autenticación).

---

## El túnel

Abrir el panel al exterior exigía cuatro gestos que nada anunciaba: instalar
Tailscale, autenticar la máquina, obtener del tailnet el derecho a publicar, y
después montar el Funnel. Cada uno falla a su manera, y ninguno dice lo que
falta — se descubría la etapa siguiente tropezando con ella. Peor: la dirección
pública obtenida debía copiarse a mano en `PUBLIC_URL`, y esa copia viajaba con
el repositorio. Una instalación en una segunda máquina heredaba así la dirección
de la primera, y el viaje de ida y vuelta de la conexión Discord devolvía al
usuario al ordenador de al lado.

[`tailscale.js`](../../../src/web/tailscale.js) no hace nada por sí solo:
**constata**. Responde «esto es donde estás, y esto es lo que falta», en un
vocabulario que la interfaz traduce en una frase. Los gestos que se automatizan
se le piden explícitamente, uno a uno.

### Los siete estados

Están **ordenados**: cada uno supone el anterior adquirido, lo que permite
presentarlos como una progresión y no como un diagnóstico.

| Estado | Lo que se constata | Gesto siguiente |
|---|---|---|
| `absent` | La orden `tailscale` no se encuentra | Instalar Tailscale |
| `unreachable` | Instalada, pero el demonio no responde | Arrancar el servicio |
| `needsLogin` | Máquina no autenticada en un tailnet | `tailscale up`, o una clave de autenticación |
| `needsCapability` | Autenticada, pero el tailnet no concede el derecho a publicar | Activar HTTPS y Funnel en la consola de administración |
| `ready` | Todo está en su sitio; queda montar el Funnel | `mount()` — deliberadamente |
| `serving` | El Funnel publica efectivamente este panel | — |
| `otherTarget` | El Funnel publica **otra cosa** | No sobrescribirlo sin decirlo |

Toda la decisión cabe en `decide()`, separada de lo que la alimenta: trabaja
sobre dos objetos ya leídos, lo que permite ponerla a prueba en los siete estados
sin instalar Tailscale, ni desconectarlo, ni retirar un derecho al tailnet para
ver qué pasa. `inspect()` ya no hace más que acarrear los cubos.

Una orden que se demora vale tanto como una orden ausente — el demonio puede
estar congelado —, de ahí un plazo de ocho segundos. Y cuando el `PATH` no lleva
aún la orden, se visitan las ubicaciones conocidas: una instalación reciente no
actualiza el `PATH` de los procesos ya lanzados, y el bot arrancado antes que
ella no vería nada, lo que el usuario tomaría por una instalación fallida.

### Lo que no se automatiza

Tres cosas, y más vale decirlo que sortearlo:

- **La instalación** exige derechos de administrador. Un servicio en cuenta de
  usuario no los toma sin una solicitud del sistema.
- **La cuenta Tailscale** no se crea mediante ninguna API. Una clave de
  autenticación elimina la interactividad, pero hace falta ya una cuenta para
  emitirla.
- **El derecho a publicar** (`funnel`, `https`) lo concede la política del
  tailnet, por tanto desde la consola de administración.

### Montar el Funnel sigue siendo un gesto

El Funnel expone el panel **a internet entero**, no a la red local. Montarlo sin
haberlo pedido publicaría el reproductor de alguien sin que lo sepa: es la única
etapa que el módulo se niega a hacer por defecto, incluso cuando todo está listo.
`mount()` existe, hay que llamarlo.

La llamada se hace en `--bg` — la forma en primer plano bloquearía el arranque
del bot — y en `--yes`, pues una solicitud de confirmación dentro de un servicio
no tiene lector.

### El estado no está en la difusión ordinaria

Constatarlo lanza dos procesos. Hacerlo cada segundo, para un valor que solo se
mueve al gesto de alguien, sería pagar caro una visualización que nadie mira la
mayor parte del tiempo. La ventana lo pide al abrirse, mediante `tunnelState`.

Los cuatro mensajes del dominio — `tunnelState`, `tunnelLogin`, `tunnelMount`,
`tunnelUnmount` — están **reservados al maestro de sesión**. Hacer el panel
alcanzable desde el exterior, o dejar de serlo, no es una orden de reproducción
que se comparta.

En el arranque, `announce()` escribe una línea en el registro, y cada una lleva
**la acción y no la constatación**: «no instalado» no enseña nada a quien acaba
de abrir una consola, «instálalo aquí» sí. Es la contrapartida del rastro OAuth,
y por la misma razón — son las dos únicas cosas que no se pueden adivinar al
instalar el bot en una máquina nueva.

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
- `decide()` debe seguir siendo una función pura de sus dos argumentos. Es lo que
  la hace comprobable sin Tailscale instalado.
