# Guía de usuario — Bot Música Interactiva

Esta guía detalla el uso del bot dentro de Discord así como el manejo de su
panel de control web.

Para la documentación de ingeniería, véase
[docs/es/technique/](technique/README.md).

---

## Índice

- [Primeros pasos](#primeros-pasos)
- [Acceso al panel de control](#acceso-al-panel-de-control)
- [Comandos de Discord](#referencia-completa-de-los-comandos-de-discord)
- [Panel de control web](#uso-del-panel-de-control-web)
- [Escenarios tipo](#escenarios-de-uso-típicos)
- [Preguntas frecuentes](#preguntas-frecuentes)

---

## Primeros pasos

### 1. Arranque del bot

El bot debe estar funcionando en su máquina para responder a los comandos. En
Windows, basta con hacer doble clic en `Start bot.vbs`, en la raíz del proyecto.

Para no tener que abrir esa carpeta nunca más, créese un acceso directo de una
vez por todas: haga doble clic en `Create shortcut.vbs` en la raíz del proyecto,
elija la ubicación deseada en el asistente, y el acceso directo se instala ahí.
Un doble clic en él arranca después el bot y abre el panel de control.

El bot arranca **en segundo plano**: no se abre ninguna ventana de terminal y
nada aparece en la barra de tareas. Una pequeña ventana le muestra por dónde va
el lanzamiento, marca las etapas a medida que avanzan, y luego desaparece sola
en cuanto el bot está listo — el panel de control se abre justo después en su
navegador. Si algo se atasca, la ventana permanece visible y le dice qué hacer:
instalar Node.js, rehacer la configuración, o consultar los
registros. El primer lanzamiento es más largo que los siguientes: instala las
dependencias.

**En el primer lanzamiento**, esa ventana no arranca nada: le acompaña. El bot
necesita su propia aplicación de Discord, y nadie puede crearla en su lugar — un
testigo designa una aplicación, y no se comparte. De todo lo demás se encarga
ella:

- un botón abre el portal de desarrolladores de Discord, donde usted crea la
  aplicación (*New Application*) y luego, en la pestaña *Bot*, pulsa *Reset
  Token* y *Copy*;
- no hay nada que pegar: en cuanto el testigo está en su portapapeles, la
  ventana lo reconoce, lo somete a Discord y le devuelve el nombre de la
  aplicación. El campo sigue ahí para los casos en que esa detección no llega a
  buen puerto;
- el identificador de la aplicación **no** se pide — se deduce del testigo. El
  archivo `.env` se escribe por usted, sin que tenga que abrirlo;
- un último botón invita al bot a su servidor, con los permisos ya marcados. El
  bot arranca mientras tanto, sin esperar a que usted termine.

Un testigo que Discord rechaza se señala en el acto, con su motivo — en lugar de
en el arranque siguiente, en forma de un bot que se detiene sin decir nada. Y si
el testigo registrado deja de ser aceptado, porque se ha regenerado desde
entonces en el portal, la ventana propone rehacer esta configuración.

**Para detener el bot**, use el botón de apagado del panel de control: es él
quien sustituye al cierre de la consola. El botón de reinicio también está
disponible ahí.

Si el bot ya está funcionando cuando lo relanza, la pequeña ventana se lo dice
en lugar de arrancar un segundo, y le propone allí mismo abrir el panel de
control, reiniciar o apagar. La apertura del panel de control comprueba primero
que no haya ya una pestaña conectada a él, para no apilar una más; el apagado,
por su parte, pide confirmación.

En línea de comandos, el equivalente del arranque es `npm start` desde la
carpeta del proyecto — con, esta vez, una consola y sus registros en directo.

### 2. Conexión a un canal de voz

Antes de solicitar al bot, conéctese a uno de los canales de voz de su servidor
de Discord. El bot requiere su presencia en un canal de voz para poder
conectarse a él y difundir allí flujos de audio.

### 3. Lanzamiento de una pista de audio

Escriba el siguiente comando de barra en cualquier canal de texto autorizado:

```
/play query:nombre de la canción o URL
```

El bot efectúa entonces las siguientes operaciones:

1. Conexión automática a su canal de voz actual.
2. Búsqueda y recuperación de los metadatos de la canción.
3. Inicialización de la reproducción de audio.
4. Envío de un recuadro resumen con el título, el autor, la duración y la
   miniatura de la canción.

---

## Acceso al panel de control

El panel de control está protegido por un **testigo de acceso**. Sin él, la
página muestra «Acceso denegado».

### Iniciar sesión con Discord

Al abrir, una ventana pide iniciar sesión con tu cuenta de Discord. No se
cierra: el panel gobierna un bot presente en tus servidores, y no obedece a
nadie que se niegue a decir quién es.

Solo se piden tu identificador, tu nombre y tu avatar — ni tus servidores ni tu
correo electrónico. Además, tu cuenta debe pertenecer a un servidor donde el bot
esté presente.

La **primera cuenta que inicie sesión presentando el token** se convierte en
propietaria de la instalación, de una vez por todas. Es quien ha lanzado el bot:
el token aparece en su consola, y el enlace de invitación enviado a los oyentes
no lo lleva. La persona propietaria conserva todos los derechos; las demás solo
tienen los que ella les concede (véase «Compartir el control»).

Para entregar la instalación a otra cuenta, elimina el archivo
`data/owner.json` y vuelve a conectarte con el token.

Si la aplicación de Discord no está configurada — falta `DISCORD_CLIENT_SECRET`
o `PUBLIC_URL` —, iniciar sesión es imposible: la ventana indica entonces lo que
queda por rellenar y deja entrar solo con el token, como antes. Nadie se queda
encerrado fuera de su propio bot por una variable olvidada.

### Recuperar el testigo

Se crea en el primer arranque y se le ofrece de tres maneras:

- el bot **abre automáticamente su navegador** en la dirección correcta, testigo
  incluido, cinco segundos después del arranque;
- la dirección completa se muestra en la consola al arrancar, si el bot se ha
  lanzado desde un terminal — el acceso directo, en cambio, arranca sin consola;
- el testigo se guarda en el archivo `data/dashboard-token`.

Una vez abierta la página con el testigo, este se memoriza en una cookie: las
visitas siguientes ya no necesitan nada. La dirección se limpia después
automáticamente para que el testigo no aparezca en la barra de direcciones.

Para abrir manualmente el panel de control:

```
http://localhost:3000/?token=SU_TESTIGO
```

### Acceder desde otro dispositivo

De manera predeterminada, el panel de control solo es accesible **desde la
máquina que aloja el bot**. Para consultarlo desde un teléfono u otro ordenador
de la red local, añada esta línea al archivo `.env` y reinicie:

```
HOST=0.0.0.0
```

El testigo de acceso protege entonces el acceso desde la red. No haga accesible
el panel de control desde Internet sin protección adicional.

### Reproducir archivos almacenados en otro lugar

El bot solo difunde al navegador los archivos situados en sus propias carpetas.
Para escuchar una biblioteca personal, declare sus carpetas en `.env`:

```
MEDIA_ROOTS=D:\Musica;E:\Peliculas
```

Sin esta declaración, la reproducción desde Discord funciona, pero el
reproductor del navegador mostrará un error para esos archivos.

---

## Referencia completa de los comandos de Discord

### Reproducción y listas de reproducción

#### `/play`

Busca una pista o reproduce un archivo concreto.

- **Búsqueda textual**: `/play query:nombre del artista o de la canción`
  (búsqueda predeterminada en YouTube).
- **Enlace directo**: `/play query:https://www.youtube.com/watch?v=...`
- **Archivo local**: `/play query:C:\musica\cancion.mp3` (ruta absoluta en la
  máquina que aloja el bot).

Plataformas admitidas: **YouTube**, **Spotify**, **SoundCloud** y **Apple
Music**. Para Spotify y Apple Music, el bot recupera los metadatos y reproduce
el equivalente de audio desde YouTube.

> Deezer y Qobuz no están admitidos, pese a la presencia de variables
> correspondientes en el archivo de configuración.

#### `/playlist`

Carga en la cola la totalidad de los archivos de audio de un directorio local.

- Comando estándar: `/playlist path:C:\musica\mi_album`
- Reproducción aleatoria: `/playlist path:C:\musica\mi_album shuffle:true`

Formatos reconocidos: MP3, FLAC, WAV, OGG, M4A, OPUS, AAC, WMA.

---

### Control de la reproducción

| Comando | Acción |
|---|---|
| `/pause` | Pausa la reproducción en curso. |
| `/resume` | Reanuda la reproducción de la pista suspendida. |
| `/skip` | Pasa a la siguiente pista de la cola. |
| `/stop` | Detiene la música y vacía la cola. |
| `/nowplaying` | Muestra la canción en curso con una barra de progreso. |

---

### Cola de espera

#### `/queue`

Consulta las pistas programadas. La lista se pagina en grupos de diez.

- Primera página: `/queue`
- Página concreta: `/queue page:2`

Añadir una pista mediante `/play` durante una reproducción la inserta al final
de la cola.

---

### Volumen sonoro

#### `/volume`

Ajusta el nivel sonoro general (0 a 100).

```
/volume level:60
```

Este valor sirve de **referencia**. El ducking calcula la atenuación aplicando
un porcentaje sobre esa base: con un volumen de 70 y un nivel de ducking del
20 %, la música baja a 14 mientras se habla.

---

### Ducking — atenuación automática

El ducking es el corazón funcional del bot: disminuye temporalmente el volumen
de la música cuando los usuarios hablan, y lo restaura después de un tiempo de
silencio.

| Comando | Efecto |
|---|---|
| `/ducking status` | Muestra el estado y el conjunto de parámetros del servidor. |
| `/ducking toggle` | Activa o desactiva la atenuación automática. |
| `/ducking level percent:<0-100>` | Porcentaje del volumen conservado mientras se habla. |
| `/ducking delay ms:<n>` | Retardo de silencio antes de la restauración. |
| `/ducking fade ms:<n>` | Duración de la transición entre los dos volúmenes. |

**Elegir un nivel** — `15` para una bajada fuerte, `50` para una atenuación a la
mitad, `0` para un corte completo mientras se habla.

**Elegir un retardo** — `400` ms para un retorno reactivo, `800` ms como
estándar, `1500` ms para un restablecimiento progresivo. Un retardo suficiente
evita el efecto de bombeo en las pausas breves de respiración en mitad de una
frase.

**Elegir un fundido** — `100` ms para una transición franca, `200` ms como
estándar, `500` ms para un efecto muy suave.

---

### Difusión y canales privados

El comando `/broadcast`, **reservado a los administradores**, modifica el canal
de destino:

- **Modo público (`everyone`)** — la música se difunde en el canal de voz común.
  Todo el mundo escucha el mismo flujo y el ducking se aplica.
- **Modo privado (`personal`)** — la música se difunde **en su navegador**, por
  el reproductor del panel de control. El bot permanece presente en el canal de
  voz sin emitir allí ningún sonido. El bot sabe también crear un canal de voz
  privado temporal, llamado `🎵 <su nombre>`, eliminado automáticamente al
  desconectarse.

---

## Uso del panel de control web

### Controles generales

- **Control multimedia** — los botones centrales suspenden, reanudan o detienen
  la reproducción. El botón «siguiente» dispone de un bloqueo de dos segundos
  contra el clic repetido. Un selector de tres posiciones permite elegir:
  - *Normal* — reproducción secuencial de la cola;
  - *Reanudar el historial* — devuelve a la cola las canciones ya reproducidas y
    vacía el historial;
  - *Bucle* — repite indefinidamente la pista actual.
- **Desplazamiento dentro de la pista** — haga clic o arrastre el cursor de la
  barra de progreso.
- **Selector de canal de voz** — cambia instantáneamente el bot de un canal a
  otro. Cada canal conserva su propia cola y su historial.
- **Canal favorito** — un canal puede marcarse como favorito (la estrella, en el
  selector); ahí es donde el bot y el panel de control se colocan cuando
  **enciende** el bot. Marcarlo no desplaza nada en el momento y nunca le retiene
  durante la sesión. Un **reinicio**, en cambio, no lo recupera: le devuelve al
  canal donde estaba escuchando, ya que la reproducción no se ha interrumpido.
  Solo hay uno, para todos los servidores.

### Actividad vocal

La sección dedicada muestra los miembros conectados al canal seleccionado.
Cuando un miembro habla, su perfil se ilumina en tiempo real. Puede **excluir a
un miembro de la detección**: su voz ya no atenuará la música, lo que resulta
útil para un micrófono ruidoso o una fuente de audio permanente.

### Listas de reproducción

El panel de control gestiona listas de reproducción **comunes a todos sus
servidores**, organizadas en pestañas. Puede crearlas, renombrarlas,
reordenarlas y eliminarlas, añadirles pistas arrastrando y soltando, y definir
una lista como fuente de reproducción activa en lugar de la cola.

Una lista que suena deja la cola a un lado — sigue mostrándose, pero nada sale
de ella mientras la lista dure. **Terminada su última pista, la cola retoma el
mando por sí sola** y enlaza con su primer título, sin preguntarle nada. La
reproducción, por tanto, solo se detiene si la cola está vacía. La reproducción
en bucle tiene prioridad: mientras esté activa, la lista vuelve a empezar por su
primer título y la cola sigue esperando su turno.

### Cola e historial

- **Arrastrar y soltar** — reorganice el orden de paso arrastrando las pistas.
  También puede arrastrar una pista desde el historial, desde una lista de
  reproducción o desde la miniatura de reproducción en curso.
- **Reproducción inmediata** — el icono de reproducción de cada elemento suena
  el título en el acto, sin nueva petición de red.
- **Eliminación y limpieza** — retire un elemento concreto o vacíe íntegramente
  la cola o el historial.

### Historial del campo de adición

El campo de adición conserva lo que usted valida — las últimas veinticinco
entradas, y una ya conocida vuelve a la cabeza en lugar de inscribirse una
segunda vez — también la misma pista pegada de otra forma, enlace corto o
parámetros de compartir. El panel se abre al recibir el foco y se filtra a medida que
escribe; la búsqueda examina el contenido y no el principio, de modo que un
enlace se reencuentra por el nombre de la pista que lleva.

- **Flechas arriba y abajo** — recorren la lista y llevan la entrada al campo.
  Subir por encima de la primera restituye lo que estaba escribiendo, apartado
  en el primer desplazamiento: una escritura interrumpida por una flecha nunca
  se pierde.
- **Clic** — elige directamente una entrada.
- **Cruz** — retira una entrada del historial.
- **Escape** — cierra el panel y devuelve al campo lo que allí se había escrito.

Cada línea lleva la imagen de la pista y su nombre, en lugar de la dirección
escrita: un enlace no dice nada de lo que contiene. El nombre de un archivo local
sustituye a su ruta, y la dirección o la ruta completa reaparece al pasar por
encima. A falta de imagen — pista aún no reconocida, fuente que no la
proporciona —, una nota musical ocupa el lugar, de modo que los nombres quedan
alineados.

Esas imágenes y esos nombres vienen de lo que el bot ha resuelto: una dirección
recién pegada se muestra tal cual, y se completa en cuanto la pista aparece en la
cola, el historial o una lista de reproducción.

Este historial **vive en el navegador**, no en el bot: es propio del dispositivo
y del navegador desde los que usted consulta, y dos dispositivos que pilotan el
mismo bot no comparten el mismo. Sustituye a la lista que el navegador ofrecía
por su cuenta, la cual ignoraba el tema del panel y no ofrecía ningún modo de
olvidar una entrada.

El menú de destino, junto al campo, también recuerda, pero en otro sitio: su
posición la retiene **el bot**, y por servidor, como los dos menús de calidad de
importación. Sobrevive así a una recarga de la página, a un reinicio del bot, y
le sigue a otro dispositivo.

### Importación de archivos

Suelte un archivo de audio o de vídeo sobre la interfaz para añadirlo a la cola,
a una lista de reproducción, o reproducirlo inmediatamente. El bot **detecta los
duplicados**: un archivo ya importado no se almacena una segunda vez.

El tamaño máximo es de 1 GB de manera predeterminada, ajustable mediante
`MAX_UPLOAD_MB`.

**Calidad de importación** — dos menús, bajo el campo de adición, fijan la
calidad de los medios recuperados desde una fuente remota:

- **Audio**: tasa de bits del archivo puesto en caché (320 a 96 kbps);
- **Vídeo**: definición del flujo de vídeo mostrado (2160p a 360p).

Estos ajustes **no se aplican a los archivos locales**, importados tal cual sin
recodificación. Cuando escribe una ruta local en el campo de adición, ambos
menús se atenúan para señalarlo.

### Descarga

Cada pista puede descargarse en una treintena de formatos y calidades: MP3, M4A,
FLAC, WAV, OGG, OPUS, WEBM, así como MP4 para el vídeo. La conversión se efectúa
sobre la marcha.

**Hacia el disco del bot** — el menú de destino, a la derecha del campo de
adición, cuenta con una cuarta entrada: «Hacia `data/downloads/`». No envía nada
al reproductor: escribe el archivo en la máquina que aloja el bot. Su etiqueta
lleva la carpeta de destino, lo que evita tener que abrirla para saber dónde
caen los archivos.

El botón con forma de carpeta, a la derecha de esa línea del menú, abre un
explorador de la máquina anfitriona — y no un campo donde teclear una ruta, ya
que esa máquina no es necesariamente aquella desde la que usted mira. En Windows
las unidades se ofrecen en la parte alta de la ventana: sin ellas, subir desde
una carpeta de `C:` lleva a `C:\` y nunca a `D:`. Dos pastillas las
preceden: **Carpeta predeterminada**, que devuelve a `data/downloads/`, y
**Descargas**, que conduce a la carpeta de descargas del sistema — la del
navegador, a menudo el destino correcto y cuatro o cinco pasos más abajo en el
árbol. Una y otra llevan allí el explorador en lugar de validar: se ve lo que la
carpeta contiene, y aún se puede bajar un nivel antes de confirmar. El campo «O
introducir una ruta» permanece para los casos que el explorador no cubre.

La carpeta la retiene **el bot**, y no el navegador: es común a todos sus
servidores y a todos sus dispositivos. Una ruta que no existe, que no es una
carpeta o que rechaza la escritura se descarta en el momento de la elección y se
muestra el motivo — en lugar de hacer fracasar la descarga más tarde, lejos de
la decisión que la causó.

Una fuente remota se transcodifica al formato del menú **Formato**, al caudal
del menú **Audio** — MP3, M4A, OGG, OPUS o WEBM; FLAC y WAV son sin pérdida e
ignoran ese caudal. Este tercer menú solo aparece, deslizándose junto a los
otros dos, para este destino: los otros tres no escriben archivo alguno, y una
extensión no designaría nada allí. Solo ofrece formatos de audio, pues el vídeo
tiene su propia vía — el botón de descarga de una pista.

Los tres menús no tratan de lo mismo, y lo que no viene al caso se atenúa: la
definición de vídeo para este destino, que solo escribe sonido, y el caudal de
audio para FLAC y WAV, sin pérdida, que conservan todo lo que se les da. Una
frase bajo la fila dice cada vez por qué.

Por último, de qué se compone una fuente solo se descubre al codificarla. Si el
formato pedido no llega a buen puerto, el archivo se escribe en MP3 — el que
nada rechaza — y una notificación lo indica, en lugar de devolver un fracaso
donde un archivo era posible. Un archivo ya presente en el disco del bot se copia tal
cual, sin recodificación: usted pidió tenerlo en su carpeta, no perder calidad
por el camino. Dos garantías, por último: volver a descargar una pista no
sustituye a la anterior — el nuevo archivo se numera — y una descarga
interrumpida no deja ningún archivo truncado en la carpeta, pues la escritura se
hace bajo un nombre provisional que solo se renombra una vez lograda la
transcodificación.

La operación transcurre en segundo plano y se anuncia mediante notificaciones:
la pista debe resolverse primero y transcodificarse después, lo que lleva el
tiempo que lleva.

### Vídeo

Cuando una pista posee un vídeo asociado, el panel de control puede mostrarlo de
fondo. Los archivos de audio locales disponen de un visualizador gráfico.

### Nivel sonoro (LUFS)

Dos pistas ajustadas al mismo volumen no se oyen al mismo nivel: un máster
reciente ronda los −7 LUFS, una grabación clásica los −25. El control de volumen
no cambia nada, ya que actúa sobre ambas a la vez.

El clic derecho sobre una pista — en la cola, el historial o una lista — abre un
menú cuya entrada **Nivel sonoro** despliega un ajuste:

- **El deslizador** apunta a una sonoridad, en LUFS, y no a un volumen. El valor
  se muestra encima y sigue al deslizador en tiempo real; la corrección se oye
  mientras se desplaza, sin reiniciar la reproducción.
- **La marca del raíl** señala la sonoridad medida del archivo: con el
  deslizador encima, la pista suena tal como fue grabada. La medida también se
  indica con todas sus letras bajo el raíl.
- **El botón circular** devuelve a la pista ese nivel original.
- **La barra degradada** anuncia lo que la corrección le cuesta al sonido. Subir
  el nivel más allá del margen que deja el archivo recorta los picos: la barra
  pasa del verde al rojo a medida que el recorte se agrava.

Medir exige leer el archivo de principio a fin, algo que solo el bot puede
hacer. Por eso se lanza cuando la pista arranca o cuando este menú se abre, y
nunca se vuelve a calcular. Una pista remota sin precargar no es medible: el
ajuste espera su precarga.

La caja **Encadenamiento Mix** lleva un interruptor **Sincronizar los LUFS**,
desactivado por defecto, y su propio deslizador. Activado, alinea todas las
pistas sobre un mismo objetivo — cada una corregida según su propia medida. Los
ajustes hechos pista por pista no se borran por ello: solo quedan cubiertos, y
desmarcar el interruptor los devuelve tal cual. Ajustar una pista a mano
mientras la sincronización está activa la desactiva, y solo esa pista conserva
el nuevo valor.

En difusión personal, la corrección la aplica el navegador. Una atenuación es
exacta allí, pero una amplificación solo dispone del margen que deja el control
de volumen principal: pedir +6 dB cuando ya está al máximo solo dará una parte.
En difusión compartida, donde el bot mezcla el sonido él mismo, la corrección se
aplica por completo.

### Velocidad y encadenamiento

- **Velocidad de reproducción** — ajustable de 0,20× a 3,05×, en pasos de 0,01.
- **Encadenamiento tipo DJ** — fundido automático entre dos pistas, con dos
  variantes: fundido de volumen solo, o fundido acompañado de un efecto de
  filtro.
- **Fundidos de entrada y de salida** — activables por separado, con duración
  ajustable.

### Precarga

Las pistas venideras se descargan por adelantado en segundo plano. Un indicador
de progreso aparece en cada pista. Esto hace instantáneo el arranque y la
reproducción resistente a los cortes de red. El número de pistas precargadas es
ajustable para la cola, el historial y las listas de reproducción.

Para no parecer un robot ante YouTube, la precarga se toma su tiempo: un vídeo
cada vez, con unos quince segundos de intervalo, y media hora de pausa si
YouTube se niega. Lo que usted mismo pide — una adición, una reproducción, un
vídeo — pasa siempre sin esperar.

### Registros y estadísticas

Un terminal integrado muestra los registros del bot en tiempo real, filtrables
por nivel (info, advertencia, error, éxito, depuración). Un panel lateral
presenta el consumo de memoria, el tiempo de funcionamiento y la actividad de
red.

**Copiar líneas de registro**

| Gesto | Efecto |
|---|---|
| Pasar el cursor sobre una línea | Hace aparecer un botón de copia a su derecha |
| Clic en una línea | La selecciona |
| **Mayús + clic** en otra | Selecciona todo el rango entre ambas |
| **Ctrl + clic** (Cmd en Mac) | Añade o retira una línea aislada |
| **Ctrl + C** | Copia la selección |
| **Esc** | Cancela la selección |

En cuanto se selecciona una línea, aparece una barra en la parte inferior de la
ventana con el número de líneas y un botón **Copiar**. El botón de la parte
superior de la ventana copia de una vez **todas las líneas mostradas**, filtros
activos incluidos — un nivel oculto nunca se copia.

La selección de texto con el ratón sigue disponible: un arrastre que selecciona
texto no se interpreta como un clic de selección.

### Mantenimiento

El menú de alimentación permite **reiniciar** o **apagar** el bot desde la
interfaz. El apagado aplica un fundido de salida y guarda el estado de
reproducción, que se restaurará en el siguiente arranque.

### Personalización visual

- **Estilos** — *Glassmorphism* (paneles translúcidos), *Neon Cyberpunk* (bordes
  de neón), *Minimalist* (colores planos y sobrios), *Retro Synthwave*
  (degradados cálidos).
- **Modo claro / oscuro** — el conjunto de los estilos se adapta.
- **Idiomas** — francés, inglés, español, alemán.
- **Disposición** — agarre un panel por su título para moverlo: un hueco
  punteado muestra dónde se posará. Soltado sobre otro panel, ambos intercambian
  su sitio; nada más se mueve, y un espacio vacío sigue vacío. La esquina
  inferior derecha redimensiona, Escape cancela el gesto en curso, y el candado
  fija un panel en su sitio. La disposición puede guardarse.

Estas preferencias se conservan en su navegador.

---

## Escenarios de uso típicos

### Juego en línea cooperativo

Volumen moderado para no enmascarar las señales del juego, ducking reactivo:

```
/volume level:50
/ducking level percent:20
/ducking delay ms:500
/ducking fade ms:150
```

### Sesión de trabajo o de estudio

Música de ambiente muy discreta, que se desvanece casi por completo durante los
intercambios:

```
/volume level:30
/ducking level percent:5
/ducking delay ms:2000
/ducking fade ms:500
```

### Escucha musical dedicada

Prioridad a la señal musical, con una atenuación ligera para que las
intervenciones sigan siendo audibles:

```
/volume level:85
/ducking level percent:70
/ducking delay ms:300
/ducking fade ms:100
```

---

## Preguntas frecuentes

**¿El bot admite los enlaces de Spotify?**
Sí. El bot extrae los metadatos de la pista y busca automáticamente el
equivalente de audio en YouTube. Indicar `SPOTIFY_CLIENT_ID` y
`SPOTIFY_CLIENT_SECRET` mejora la fiabilidad de la resolución.

**¿Por qué el volumen tarda en subir tras una frase?**
Es el retardo de restauración. Impide que el volumen suba durante las pausas
breves en mitad de una frase. Redúzcalo con `/ducking delay ms:200` o desde el
panel de control.

**¿El ducking se aplica también a mi propia voz?**
Sí, a todos los participantes no bot del canal. No obstante, puede excluir a un
miembro concreto de la detección desde el panel de control.

**¿Puedo escuchar música solo sin molestar al servidor?**
Sí, en modo `personal`: la música se difunde en su navegador y no en el canal de
voz. El bot puede también crear un canal de voz privado temporal.

**¿Se conservan los ajustes tras un reinicio?**
Sí. Volumen, ducking, modo de difusión y listas de reproducción se guardan en
archivos JSON locales (`data/settings.json`). El estado de reproducción también
se restaura: el bot retoma la pista interrumpida en su posición exacta. Las
preferencias visuales del panel de control se conservan en su navegador.

**He perdido el testigo del panel de control.**
Figura en `data/dashboard-token` y en la consola al arrancar. También puede
imponer uno de su elección mediante la variable `DASHBOARD_TOKEN` del archivo
`.env`.

**El reproductor del navegador muestra un error con mis archivos locales.**
El bot solo difunde los archivos situados en sus carpetas o en los directorios
declarados por `MEDIA_ROOTS`. Véase
[Reproducir archivos almacenados en otro lugar](#reproducir-archivos-almacenados-en-otro-lugar).

**La carpeta `data/` ocupa mucho espacio.**
`data/cache` contiene las pistas precargadas. Se purga según la pertinencia pero
no tiene tope de tamaño: puede vaciarla sin riesgo, con el bot detenido.
`data/uploads` contiene sus importaciones — eliminarlas dejará inoperantes las
listas de reproducción que las referencian.
