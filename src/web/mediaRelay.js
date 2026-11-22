/**
 * mediaRelay — Servir un média en plages, qu'il soit ici ou ailleurs.
 *
 * ## Pourquoi la vidéo doit passer par le bot
 *
 * Le son passe par le bot depuis toujours : `/api/stream` va chercher la source
 * et verse les octets au tableau de bord. La vidéo, elle, ne faisait que se voir
 * remettre une adresse — `/api/video-info` rendait l'URL `*.googlevideo.com` que
 * `yt-dlp` venait de résoudre, et la balise `<video>` allait la chercher
 * elle-même.
 *
 * Cela marche tant que le navigateur est sur la même machine que le bot, et
 * cesse de marcher dès qu'il ne l'est plus. Ces adresses sont signées pour le
 * client qui les a demandées — c'est déjà ce qui faisait refuser les manifestes
 * à ffmpeg, voir `videoTracks` dans src/audio/videoSource.js. Résolue depuis la
 * connexion du bot, l'adresse vaut pour le bot ; l'invité qui la suit depuis son
 * réseau à lui se fait brider, ou refuser. D'où ce qu'on observait : une vidéo
 * qui met longtemps à venir, ne vient pas, puis vient au troisième rechargement
 * — celui qui tombe après l'expiration du cache, donc sur une adresse neuve.
 *
 * Les en-têtes comptent autant que l'adresse : la source peut exiger au moment
 * de servir ceux que `yt-dlp` a présentés en résolvant — `http_headers`, dans
 * ce qu'il rend. Un navigateur enverra toujours les siens. Le relais, lui,
 * rejoue exactement ceux que la source a demandés.
 *
 * ## Ce que le relais doit à Safari
 *
 * Une balise `<video>` ne lit un flux que si le serveur sait le découper. Safari
 * est le plus strict des trois : il commence par réclamer `bytes=0-1`, et si on
 * lui répond autre chose qu'un 206 portant `Content-Range` — taille totale
 * comprise — il abandonne sans un mot. C'est pourquoi la taille est sondée avant
 * la première réponse, et non devinée d'après ce que la source annonce.
 *
 * ## Pourquoi les octets sont repris par tranches en amont
 *
 * YouTube bride une requête continue au débit de lecture. Relayer une plage
 * ouverte — `bytes=0-`, la forme que tous les navigateurs envoient d'abord — en
 * une seule requête vers la source retomberait exactement dans ce piège, et le
 * relais serait plus lent que le lien direct qu'il remplace. `chunkedFetch`
 * redemande donc l'amont par tranches courtes ; l'aval, lui, ne voit qu'une
 * réponse continue et n'a rien à savoir de tout cela.
 *
 * ## La lecture des plages est ici, et pas ailleurs
 *
 * `parseRange` servait au serveur de fichiers, qui n'en demandait pas tant. Elle
 * vit désormais auprès de son lecteur le plus exigeant, et les deux la
 * partagent : une plage se lit de la même façon, que les octets viennent du
 * disque ou du bout du monde.
 */

const { chunkedFetch, openRequest } = require('../audio/rangeStream');

/** Faute de mieux : une balise <video> ne sait rien faire d'un type inconnu. */
const TYPE_PAR_DEFAUT = 'video/mp4';

/**
 * Analyse un en-tête Range.
 * @returns {{start: number, end: number}|{invalid: true}|null} null si absent ou illisible
 */
function parseRange(rangeHeader, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (!m) return null;

  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    // Forme suffixe : les N derniers octets
    const n = parseInt(rawEnd, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start > end) return { invalid: true };

  return { start, end: Math.min(end, size - 1) };
}

/**
 * Demande un octet à la source, pour savoir ce qu'elle a et ce qu'elle sait.
 *
 * Un seul octet : la réponse n'intéresse que par ses en-têtes. `Content-Range`
 * porte la taille totale — « bytes 0-0/24600694 » —, et c'est la seule façon
 * fiable de l'obtenir. `filesize_approx`, que la source annonce parfois à la
 * place de `filesize`, est une estimation : bâtir des plages dessus servirait
 * des octets qui n'existent pas.
 *
 * Une source qui répond 200 ne sait pas découper. On le note, et le relais s'en
 * accommode — `chunkedFetch` taille alors lui-même dans le flux entier.
 *
 * @param {string} url
 * @param {object} [headers]
 * @returns {Promise<{ size: number|null, contentType: string, ranges: boolean }>}
 */
async function probeRemote(url, headers = {}) {
  const res = await openRequest(url, Object.assign({}, headers, { Range: 'bytes=0-0' }));
  const ranges = res.statusCode === 206;
  const portee = /bytes \d+-\d+\/(\d+)/.exec(res.headers['content-range'] || '');

  // Détruire, et non `resume()` : sur une source qui ignore les plages, la
  // réponse est le fichier entier, qu'il ne s'agit pas de télécharger pour
  // connaître sa taille.
  res.destroy();

  const annoncee = Number(res.headers['content-length']);
  return {
    size: portee ? Number(portee[1]) : Number.isFinite(annoncee) && !ranges ? annoncee : null,
    contentType: res.headers['content-type'] || TYPE_PAR_DEFAUT,
    ranges,
  };
}

/**
 * Relaie une source distante au client, en honorant sa demande de plage.
 *
 * L'aval reçoit une réponse de serveur de fichiers ordinaire : 206 et
 * `Content-Range` s'il a demandé une plage, 200 et le tout sinon. Ce que le
 * relais fait en amont pour la remplir ne le regarde pas.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} source
 * @param {string} source.url - Adresse résolue chez la source.
 * @param {object} [source.headers] - En-têtes que la source exige.
 * @param {number} source.size - Taille totale, telle que `probeRemote` la rend.
 * @param {string} [source.contentType]
 * @param {number} [source.chunkBytes] - Taille d'une tranche en amont.
 * @param {(message: string) => void} [source.onError]
 */
function relayRemote(req, res, { url, headers = {}, size, contentType = TYPE_PAR_DEFAUT, chunkBytes, onError }) {
  const plage = parseRange(req.headers.range, size);

  if (plage && plage.invalid) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
    return res.end();
  }

  const start = plage ? plage.start : 0;
  const end = plage ? plage.end : size - 1;

  const entetes = {
    'Content-Type': contentType,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
  };
  if (plage) entetes['Content-Range'] = `bytes ${start}-${end}/${size}`;

  res.writeHead(plage ? 206 : 200, entetes);

  // Une balise <video> sonde parfois par un HEAD : les en-têtes suffisent, et
  // aller chercher le moindre octet en amont serait du trafic pour rien.
  if (req.method === 'HEAD') return res.end();

  const flux = chunkedFetch(url, { headers, start, end, chunkBytes });

  /*
   * Le client qui s'en va coupe l'amont.
   *
   * Sans cela, changer de piste ou fermer l'onglet laisserait la boucle de
   * tranches réclamer un fichier que plus personne n'attend — et une vidéo,
   * ce sont des dizaines de mégaoctets tirés dans le vide.
   */
  res.on('close', () => flux.destroy());

  flux.on('error', (err) => {
    if (onError) onError(err.message);
    // Les en-têtes sont partis : il ne reste qu'à couper, ce que le client
    // lit comme un flux tronqué — et il redemandera la plage manquante.
    res.destroy();
  });

  flux.pipe(res);
}

module.exports = { parseRange, probeRemote, relayRemote, TYPE_PAR_DEFAUT };
