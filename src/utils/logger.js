/**
 * logger — Journalisation applicative centralisée.
 *
 * Remplace le détournement global de `console` qui vivait dans WebServer :
 * le module web pilotait la journalisation de toute l'application, et le
 * niveau de chaque message était deviné en cherchant des sous-chaînes dans le
 * texte (« ATTENTION » dans une phrase française classait le log en
 * avertissement). Ici, le niveau est décidé au point d'appel.
 *
 * Le logger est autonome : il n'a aucune dépendance vers le serveur web, qui
 * s'y abonne pour retransmettre les entrées au tableau de bord.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

/** Sévérités comparables. `success` est un `info` distingué à l'affichage. */
const SEVERITY = {
    debug: 10,
    info: 20,
    success: 20,
    warn: 30,
    error: 40,
};

/** Taille de l'historique conservé pour les clients qui se connectent. */
const HISTORY_SIZE = 200;

/** Délai de regroupement des écritures fichier. */
const FLUSH_INTERVAL_MS = 250;

/** Nombre d'entrées au-delà duquel on écrit sans attendre le minuteur. */
const FLUSH_THRESHOLD = 64;

const pad = (n) => String(n).padStart(2, '0');

/**
 * Met un argument en forme pour l'affichage.
 * Les erreurs conservent leur pile : l'ancien JSON.stringify les réduisait à
 * « {} », ce qui rendait le tableau de bord inutilisable pour diagnostiquer.
 */
function formatArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    if (arg === null || arg === undefined || typeof arg !== 'object') return String(arg);
    try {
        return util.inspect(arg, { depth: 2, colors: false, breakLength: Infinity });
    } catch (e) {
        return String(arg);
    }
}

class Logger {
    constructor() {
        this.minSeverity = SEVERITY.debug;
        this.history = [];
        this.subscribers = new Set();

        this.logsDir = null;
        this.instanceFile = null;
        this.latestFile = null;

        this.buffer = [];
        this.flushTimer = null;
        this._onExit = () => this.flush();
        process.on('exit', this._onExit);
    }

    /**
     * Prépare la journalisation sur disque et le seuil de verbosité.
     * Sans appel à configure(), le logger n'écrit que sur la sortie standard.
     *
     * @param {object} options
     * @param {string} [options.dir] - Dossier des journaux
     * @param {string} [options.level] - Seuil : debug | info | warn | error
     * @param {number} [options.retention] - Nombre de journaux conservés
     */
    configure({ dir, level, retention = 20 } = {}) {
        if (level && SEVERITY[level] !== undefined) {
            this.minSeverity = SEVERITY[level];
        }
        if (!dir) return;

        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
            process.stderr.write(`[Logger] Dossier de journaux inaccessible : ${err.message}\n`);
            return;
        }

        this.logsDir = dir;

        const now = new Date();
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
            + `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        this.instanceFile = path.join(dir, `${stamp}.log`);
        this.latestFile = path.join(dir, 'latest.log');

        const header = `[${stamp}] [INFO   ] === Démarrage instance bot: ${stamp}.log ===\n`;
        try {
            fs.writeFileSync(this.latestFile, header, 'utf8');
            fs.writeFileSync(this.instanceFile, header, 'utf8');
        } catch (err) {
            process.stderr.write(`[Logger] Écriture du journal impossible : ${err.message}\n`);
        }

        // Purge après création du journal courant : le dossier contient alors
        // au plus `retention` fichiers, celui de cette instance compris.
        const removed = this.pruneOldLogs(dir, retention);
        if (removed > 0) {
            this.info(`[Logger] ${removed} ancien(s) journal(aux) supprimé(s) (rétention : ${retention}).`);
        }
    }

    /**
     * Ne conserve que les `keep` journaux les plus récents.
     * @returns {number} Nombre de fichiers supprimés
     */
    pruneOldLogs(dir, keep) {
        let removed = 0;
        try {
            const files = fs.readdirSync(dir)
                .filter(name => name.endsWith('.log') && name !== 'latest.log')
                .map(name => {
                    const full = path.join(dir, name);
                    let time = 0;
                    try { time = fs.statSync(full).mtimeMs; } catch (e) {}
                    return { full, time };
                })
                .sort((a, b) => b.time - a.time);

            for (const file of files.slice(keep)) {
                try {
                    fs.unlinkSync(file.full);
                    removed++;
                } catch (e) {}
            }
        } catch (e) {
            // Dossier illisible : rien à purger
        }
        return removed;
    }

    /**
     * S'abonne au flux d'entrées. Utilisé par le serveur web pour retransmettre
     * les journaux au tableau de bord.
     * @param {(entry: {timestamp: string, level: string, text: string}) => void} listener
     * @returns {() => void} Fonction de désabonnement
     */
    subscribe(listener) {
        this.subscribers.add(listener);
        return () => this.subscribers.delete(listener);
    }

    /** Historique récent, pour un client qui vient de se connecter. */
    getHistory() {
        return this.history.slice();
    }

    _write(level, args) {
        if (SEVERITY[level] < this.minSeverity) return;

        const now = new Date();
        const text = args.map(formatArg).join(' ');
        const entry = {
            timestamp: now.toLocaleTimeString('fr-FR', { hour12: false }),
            level: level.toUpperCase(),
            text,
        };

        // Sortie terminal — process.stdout directement, pour rester indépendant
        // de `console` et de tout détournement éventuel.
        const stream = SEVERITY[level] >= SEVERITY.warn ? process.stderr : process.stdout;
        stream.write(text + '\n');

        this.history.push(entry);
        if (this.history.length > HISTORY_SIZE) this.history.shift();

        for (const listener of this.subscribers) {
            try {
                listener(entry);
            } catch (e) {
                process.stderr.write(`[Logger] Abonné en erreur : ${e.message}\n`);
            }
        }

        if (this.instanceFile) {
            const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            this.buffer.push(`[${dateStr} ${entry.timestamp}] [${entry.level.padEnd(7)}] ${text}\n`);
            this._scheduleFlush();
        }

        return entry;
    }

    _scheduleFlush() {
        if (this.buffer.length >= FLUSH_THRESHOLD) {
            this.flush();
            return;
        }
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, FLUSH_INTERVAL_MS);
        if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
    }

    /**
     * Écrit immédiatement les lignes en attente.
     * Appelée à l'arrêt du process, y compris via process.exit().
     */
    flush() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.buffer.length === 0 || !this.instanceFile) return;

        const chunk = this.buffer.join('');
        this.buffer.length = 0;
        try {
            fs.appendFileSync(this.instanceFile, chunk, 'utf8');
            fs.appendFileSync(this.latestFile, chunk, 'utf8');
        } catch (e) {
            // Disque plein ou fichier verrouillé : on ne peut rien journaliser
            // de plus sans boucler.
        }
    }

    debug(...args) { return this._write('debug', args); }
    info(...args) { return this._write('info', args); }
    success(...args) { return this._write('success', args); }
    warn(...args) { return this._write('warn', args); }
    error(...args) { return this._write('error', args); }
}

module.exports = new Logger();
module.exports.Logger = Logger;
module.exports.SEVERITY = SEVERITY;
