/**
 * Consultation des versions publiées et bascule de l'une à l'autre.
 *
 * Le catalogue est relu sur GitHub à chaque ouverture du menu déroulant : une
 * release publiée entre-temps y apparaît sans avoir à redémarrer le bot.
 *
 * L'installation, elle, est une opération longue qui se termine par un
 * redémarrage. Elle rend compte de son avancement au fil de l'eau
 * (`versionProgress`) pour que le tableau de bord montre autre chose qu'un
 * écran figé pendant le téléchargement.
 */

const versioning = require('../../../versioning');
const { redemarrerProcessus } = require('./systemHandlers');
const log = require('../../../utils/logger');

/**
 * Une installation à la fois. Deux téléchargements concurrents viseraient le
 * même dossier temporaire de destination et se disputeraient le redémarrage.
 */
let installationEnCours = null;

/** Diffuse à tous les onglets ouverts : l'opération concerne le bot entier. */
function diffuser(webServer, type, data) {
    const charge = JSON.stringify({ type, data });
    webServer.wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            try {
                client.send(charge);
            } catch (e) {}
        }
    });
}

async function handleListVersions(ctx) {
    const { ws } = ctx;

    let charge;
    try {
        charge = await versioning.catalogue();
    } catch (err) {
        log.error('[Versions] Lecture du catalogue impossible :', err.message);
        charge = { releases: [], erreur: { message: err.message, statut: null } };
    }

    // Une installation lancée depuis un autre onglet doit apparaître ici aussi.
    charge.installationEnCours = installationEnCours;

    try {
        ws.send(JSON.stringify({ type: 'versionCatalog', data: charge }));
    } catch (e) {}
}

/**
 * Installe si nécessaire la version demandée, puis redémarre dessus.
 *
 * Une version déjà présente sur le disque n'est jamais retéléchargée : on passe
 * directement au redémarrage. C'est ce qui garantit qu'une version installée —
 * à commencer par celle en cours d'exécution — ne peut pas être écrasée par une
 * bascule.
 */
async function handleInstallVersion(ctx) {
    const { webServer, data } = ctx;

    const tag = String((data && data.tag) || '').trim();
    if (!tag) {
        return diffuser(webServer, 'versionProgress', {
            phase: 'erreur',
            message: 'Aucune version sélectionnée.',
        });
    }

    if (installationEnCours) {
        return diffuser(webServer, 'versionProgress', {
            phase: 'erreur',
            tag,
            message: `Une installation est déjà en cours (${installationEnCours}).`,
        });
    }

    if (versioning.estCourante(tag)) {
        return diffuser(webServer, 'versionProgress', {
            phase: 'deja',
            tag,
            message: 'Cette version est déjà celle qui tourne.',
        });
    }

    installationEnCours = tag;
    try {
        if (tag !== versioning.TAG_DEV) {
            const resultat = await versioning.installer(tag, (etape) => {
                diffuser(webServer, 'versionProgress', { tag, ...etape });
            });
            log.info(
                `[Versions] Bascule vers ${tag} (${resultat.dejaInstallee ? 'déjà installée' : 'fraîchement installée'}).`
            );
        }

        const cible = versioning.pointEntree(tag);

        diffuser(webServer, 'versionProgress', { phase: 'redemarrage', tag });
        // Le tableau de bord sait déjà afficher le voile de redémarrage sur ce
        // message : la bascule de version réutilise le même chemin que le
        // redémarrage ordinaire.
        diffuser(webServer, 'status', { status: 'restarting' });

        log.info(`[Versions] Redémarrage sur ${cible.type === 'dev' ? 'la version de développement' : tag}.`);
        // Laisse aux sockets le temps d'écouler les deux messages ci-dessus
        // avant que le serveur ne se ferme sous eux.
        setTimeout(() => redemarrerProcessus(webServer, { entree: cible.entree }), 250);
    } catch (err) {
        installationEnCours = null;
        log.error(`[Versions] Échec de l'installation de ${tag} :`, err.message);
        diffuser(webServer, 'versionProgress', { phase: 'erreur', tag, message: err.message });
    }
}

/**
 * Retire du disque une version installée.
 *
 * Opération courte et sans redémarrage : elle n'a donc pas besoin du rapport
 * d'avancement de l'installation. Elle diffuse en revanche un catalogue frais à
 * tous les onglets, pour que l'entrée disparaisse de leur menu déroulant sans
 * qu'ils aient à le rouvrir.
 *
 * Les refus qui comptent — dépôt de développement, version en cours
 * d'exécution — sont prononcés par `versioning` lui-même ; ceux d'ici ne font
 * qu'éviter un travail inutile et rendre le message plus clair.
 */
async function handleUninstallVersion(ctx) {
    const { webServer, data } = ctx;

    const tag = String((data && data.tag) || '').trim();
    if (!tag) {
        return diffuser(webServer, 'versionRemoved', { tag, message: 'Aucune version sélectionnée.' });
    }

    if (installationEnCours) {
        return diffuser(webServer, 'versionRemoved', {
            tag,
            message: `Une installation est en cours (${installationEnCours}) : réessayez ensuite.`,
        });
    }

    if (tag === versioning.TAG_DEV) {
        return diffuser(webServer, 'versionRemoved', {
            tag,
            message: "La version de développement ne s'installe ni ne se désinstalle.",
        });
    }

    if (versioning.estCourante(tag)) {
        return diffuser(webServer, 'versionRemoved', {
            tag,
            message: "Impossible de désinstaller la version en cours d'exécution.",
        });
    }

    try {
        versioning.desinstaller(tag);
    } catch (err) {
        log.error(`[Versions] Échec de la désinstallation de ${tag} :`, err.message);
        return diffuser(webServer, 'versionRemoved', { tag, message: err.message });
    }

    diffuser(webServer, 'versionRemoved', { tag, ok: true });

    try {
        const charge = await versioning.catalogue();
        charge.installationEnCours = installationEnCours;
        diffuser(webServer, 'versionCatalog', charge);
    } catch (err) {
        // Le catalogue n'est qu'un rafraîchissement de confort : la
        // désinstallation, elle, a bien eu lieu et a déjà été annoncée.
        log.warn(`[Versions] Catalogue illisible après désinstallation : ${err.message}`);
    }
}

module.exports = {
    handleListVersions,
    handleInstallVersion,
    handleUninstallVersion,
};
