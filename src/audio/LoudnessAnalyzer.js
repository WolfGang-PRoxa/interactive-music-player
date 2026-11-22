/**
 * LoudnessAnalyzer — mesure la sonie d'une piste, une fois pour toutes.
 *
 * ## Le problème
 *
 * Régler le niveau d'un morceau suppose de savoir d'où il part. Cette mesure
 * n'est pas dans les métadonnées : elle ne s'obtient qu'en écoutant le fichier
 * d'un bout à l'autre, ce qui coûte quelques secondes de processeur — pendant
 * lesquelles le bot décode par ailleurs le son qu'il diffuse.
 *
 * ## L'approche
 *
 * Un seul FFmpeg à la fois, en file : le décodage de la lecture passe toujours
 * avant l'analyse d'un morceau qu'on ne joue pas encore. Le résultat est écrit
 * en base et n'est jamais recalculé — un fichier ne change pas de sonie.
 *
 * L'analyse porte sur un fichier local : le morceau en cache, ou le fichier
 * disque de l'utilisateur. Une source distante non préchargée n'est pas
 * analysée ; la télécharger pour la mesurer coûterait le prix d'un
 * préchargement que l'utilisateur n'a pas demandé.
 *
 * Le filtre `loudnorm` rend, en une passe, la sonie intégrée et le pic réel :
 * les deux valeurs dont dépend tout le reste. `ebur128` donnerait la première
 * mais impose de lire son résumé en texte, quand `loudnorm` sait écrire du JSON.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const cp = require('child_process');
const ffmpeg = require('ffmpeg-static');

const database = require('../database/Database');
const preloadManager = require('./PreloadManager');
const log = require('../utils/logger');

/**
 * Délai au-delà duquel une analyse est abandonnée.
 *
 * Une heure de musique s'analyse en une poignée de secondes ; passé deux
 * minutes, c'est que FFmpeg attend quelque chose qui ne viendra pas.
 */
const ANALYSIS_TIMEOUT_MS = 120000;

/**
 * Sonie en deçà de laquelle la mesure est tenue pour non significative.
 *
 * `loudnorm` rend −70 LUFS — sa borne basse — sur un fichier silencieux ou trop
 * court pour que la fenêtre d'intégration se remplisse (moins de trois
 * secondes). Retenir cette valeur ferait calculer un gain de cinquante
 * décibels sur du silence.
 */
const MIN_MEANINGFUL_LUFS = -69;

class LoudnessAnalyzer extends EventEmitter {
  constructor() {
    super();

    /** @type {Map<string, Promise>} Analyses engagées, par URL. */
    this._running = new Map();

    /** @type {Array<{url: string, filePath: string, resolve: Function}>} */
    this._waiting = [];

    /** Une analyse à la fois : le reste du processeur appartient au son. */
    this._busy = false;

    /**
     * Pistes dont l'analyse a échoué. Réessayer en boucle sur un fichier
     * que FFmpeg ne sait pas lire tiendrait la file occupée pour rien.
     * @type {Set<string>}
     */
    this._failed = new Set();
  }

  /**
   * Fichier local sur lequel porter l'analyse, s'il y en a un.
   *
   * @param {object} track
   * @returns {string|null}
   */
  _fileFor(track) {
    if (!track || !track.url) return null;

    const cached = preloadManager.getCachedPath(track);
    if (cached) return cached;

    // Fichier de l'utilisateur : jamais mis en cache, lu tel quel.
    if (/^https?:\/\//i.test(track.url)) return null;
    try {
      return fs.existsSync(track.url) ? track.url : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * État de la mesure d'une piste, tel que le tableau de bord l'affiche.
   *
   * @param {object} track
   * @param {boolean} [measurable] - Le fichier est-il sur le disque ? À
   *   fournir dès que l'appelant le sait déjà : ce chemin est emprunté pour
   *   chaque piste à chaque diffusion d'état, et le déduire ici coûterait un
   *   accès disque par piste et par seconde.
   * @returns {'measured'|'analyzing'|'pending'|'failed'|'unavailable'}
   */
  statusFor(track, measurable) {
    const url = track && track.url;
    if (!url) return 'unavailable';

    const entry = database.getTrackLoudness(url);
    if (entry && Number.isFinite(entry.measured)) return 'measured';
    if (this._running.has(url)) return 'analyzing';
    if (this._failed.has(url)) return 'failed';

    // Mesurable, mais pas encore demandée : c'est l'ouverture du menu ou le
    // démarrage du morceau qui l'engagera.
    const onDisk = measurable === undefined ? !!this._fileFor(track) : !!measurable;
    return onDisk ? 'pending' : 'unavailable';
  }

  /**
   * Mesure une piste si ce n'est pas déjà fait, sans attendre le résultat.
   *
   * Appelée au démarrage d'un morceau et à l'ouverture du menu de niveau : le
   * réglage est ainsi prêt quand l'utilisateur y arrive, et le gain s'applique
   * de lui-même dès que la mesure tombe.
   *
   * @param {object} track
   * @returns {boolean} true si une mesure est en cours à la sortie
   */
  ensure(track) {
    const url = track && track.url;
    if (!url) return false;

    const entry = database.getTrackLoudness(url);
    if (entry && Number.isFinite(entry.measured)) return false;
    if (this._running.has(url)) return true;
    if (this._failed.has(url)) return false;

    const filePath = this._fileFor(track);
    if (!filePath) return false;

    const promise = new Promise((resolve) => {
      this._waiting.push({ url, filePath, resolve });
      this._pump();
    });
    this._running.set(url, promise);
    return true;
  }

  /** Efface la marque d'échec d'une piste, pour qu'une prochaine mesure reparte. */
  forget(url) {
    this._failed.delete(url);
  }

  /** Lance l'analyse suivante si le poste est libre. */
  _pump() {
    if (this._busy || this._waiting.length === 0) return;
    this._busy = true;

    const job = this._waiting.shift();
    this._measure(job.filePath)
      .then((result) => {
        if (result) {
          database.setTrackLoudnessMeasure(job.url, result);
          log.info(`[Loudness] ${job.url}: ${result.measured} LUFS, ` + `true peak ${result.peak} dBTP.`);
        } else {
          this._failed.add(job.url);
        }
        return result;
      })
      .catch((err) => {
        this._failed.add(job.url);
        log.error('[Loudness] Measurement failed:', err.message);
        return null;
      })
      .then((result) => {
        this._running.delete(job.url);
        this._busy = false;
        job.resolve(result);
        // Annoncé même en cas d'échec : l'interface attend une réponse,
        // fût-elle « pas de mesure possible ».
        this.emit('measured', { url: job.url, result });
        this._pump();
      });
  }

  /**
   * Fait tourner FFmpeg sur un fichier et en tire sonie et pic réel.
   *
   * @param {string} filePath
   * @returns {Promise<{measured: number, peak: number}|null>}
   */
  _measure(filePath) {
    return new Promise((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-nostdin',
        '-i',
        filePath,
        // La source peut porter une pochette : sans « -vn », le filtre
        // audio se voit offrir un flux d'images et le graphe est refusé.
        '-vn',
        '-af',
        'loudnorm=print_format=json',
        '-f',
        'null',
        '-',
      ];

      const analysis = cp.spawn(ffmpeg, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });

      let stderr = '';
      analysis.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const deadline = setTimeout(() => {
        try {
          analysis.kill('SIGKILL');
        } catch (e) {}
        reject(new Error(`Analysis abandoned after ${ANALYSIS_TIMEOUT_MS / 1000} s.`));
      }, ANALYSIS_TIMEOUT_MS);
      if (deadline.unref) deadline.unref();

      analysis.on('error', (err) => {
        clearTimeout(deadline);
        reject(err);
      });

      analysis.on('close', () => {
        clearTimeout(deadline);
        resolve(parseLoudnorm(stderr));
      });
    });
  }
}

/**
 * Extrait la mesure du rapport de `loudnorm`.
 *
 * Le filtre écrit son JSON sur la sortie d'erreur, après les lignes de
 * diagnostic de FFmpeg : c'est le dernier bloc accolé qu'il faut lire, jamais
 * le premier — un avertissement de décodage peut en précéder d'autres.
 *
 * @param {string} stderr
 * @returns {{measured: number, peak: number}|null}
 */
function parseLoudnorm(stderr) {
  const start = String(stderr || '').lastIndexOf('{');
  const end = String(stderr || '').lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let report;
  try {
    report = JSON.parse(stderr.slice(start, end + 1));
  } catch (e) {
    return null;
  }

  const measured = Number.parseFloat(report.input_i);
  const peak = Number.parseFloat(report.input_tp);
  if (!Number.isFinite(measured) || measured < MIN_MEANINGFUL_LUFS) return null;

  return {
    measured: Math.round(measured * 10) / 10,
    // Un pic illisible est supposé au plafond : c'est l'hypothèse prudente,
    // celle qui prévient l'utilisateur plutôt que de le laisser écrêter.
    peak: Number.isFinite(peak) ? Math.round(peak * 10) / 10 : 0,
  };
}

module.exports = new LoudnessAnalyzer();
module.exports.parseLoudnorm = parseLoudnorm;
