/**
 * targz — Extraction d'une archive `.tar.gz` sans dépendance externe.
 *
 * Les archives de code source de GitHub tiennent en quelques mégaoctets : elles
 * sont décompressées en mémoire d'un bloc, puis parcourues bloc de 512 octets
 * par bloc de 512 octets. Cela évite d'ajouter une bibliothèque d'extraction au
 * projet, et surtout de dépendre d'un `tar` système dont ni la présence ni le
 * dialecte ne sont garantis d'une machine à l'autre.
 *
 * Deux points méritent l'attention :
 *
 *   - **les noms longs.** Le format ustar loge un nom sur 100 octets, complétés
 *     par un préfixe de 155. Au-delà, l'archiveur émet une entrée porteuse du
 *     nom réel juste avant l'entrée qu'elle décrit : `L` chez GNU, `x`
 *     (en-tête pax) chez les autres. GitHub emploie les deux selon les dépôts,
 *     donc les deux sont gérés ;
 *   - **la traversée de chemin.** Une entrée nommée `../../autre` sortirait du
 *     dossier de destination. Chaque chemin est donc résolu puis vérifié comme
 *     descendant strict de la destination avant la moindre écriture.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TAILLE_BLOC = 512;

/** Le bloc est-il entièrement nul ? Deux de suite marquent la fin de l'archive. */
function blocVide(bloc) {
    for (let i = 0; i < bloc.length; i++) {
        if (bloc[i] !== 0) return false;
    }
    return true;
}

/** Chaîne terminée par un octet nul, telle que stockée dans un en-tête tar. */
function chaine(bloc, debut, longueur) {
    const zone = bloc.subarray(debut, debut + longueur);
    const fin = zone.indexOf(0);
    return zone.toString('utf8', 0, fin === -1 ? zone.length : fin).trim();
}

/**
 * Champ numérique d'un en-tête tar.
 *
 * Octal ASCII dans le cas courant. Les archiveurs basculent en base 256 —
 * signalée par le bit de poids fort du premier octet — pour les valeurs qui ne
 * tiennent plus en octal ; le cas ne se présente pas sur une archive de code
 * source, mais l'ignorer donnerait une taille nulle et décalerait silencieusement
 * la lecture de toute la suite de l'archive.
 */
function nombre(bloc, debut, longueur) {
    const zone = bloc.subarray(debut, debut + longueur);
    if (zone.length && (zone[0] & 0x80) !== 0) {
        let valeur = 0;
        for (let i = 1; i < zone.length; i++) valeur = valeur * 256 + zone[i];
        return valeur;
    }
    const texte = chaine(bloc, debut, longueur).replace(/[^0-7]/g, '');
    if (!texte) return 0;
    return parseInt(texte, 8) || 0;
}

/**
 * Lit les enregistrements d'un en-tête pax et en retire le chemin, seul champ
 * qui nous intéresse. Format : `<longueur totale> <clé>=<valeur>\n`.
 */
function cheminPax(donnees) {
    const texte = donnees.toString('utf8');
    let position = 0;
    while (position < texte.length) {
        const espace = texte.indexOf(' ', position);
        if (espace === -1) break;
        const longueur = parseInt(texte.slice(position, espace), 10);
        if (!Number.isFinite(longueur) || longueur <= 0) break;
        const enregistrement = texte.slice(espace + 1, position + longueur - 1);
        const egal = enregistrement.indexOf('=');
        if (egal !== -1 && enregistrement.slice(0, egal) === 'path') {
            return enregistrement.slice(egal + 1);
        }
        position += longueur;
    }
    return null;
}

/**
 * Retire les `n` premiers segments d'un chemin d'archive.
 *
 * GitHub enveloppe tout le contenu dans un dossier `owner-repo-<sha>` : sans ce
 * retrait, la version installée serait imbriquée d'un niveau et son point
 * d'entrée introuvable.
 */
function retirerComposants(chemin, n) {
    const segments = chemin.split('/').filter((s) => s !== '' && s !== '.');
    if (segments.length <= n) return null;
    return segments.slice(n).join('/');
}

/**
 * Décompresse et extrait une archive tar.gz.
 *
 * @param {Buffer} archive - Contenu `.tar.gz`
 * @param {string} destination - Dossier d'accueil, créé si absent
 * @param {{ retirerComposants?: number }} [options]
 * @returns {{ fichiers: number, octets: number }}
 */
function extraireTarGz(archive, destination, options = {}) {
    const aRetirer = options.retirerComposants !== undefined ? options.retirerComposants : 1;
    const racine = path.resolve(destination);
    fs.mkdirSync(racine, { recursive: true });

    const tar = zlib.gunzipSync(archive);

    let position = 0;
    let nomEnAttente = null;
    let fichiers = 0;
    let octets = 0;

    while (position + TAILLE_BLOC <= tar.length) {
        const entete = tar.subarray(position, position + TAILLE_BLOC);
        if (blocVide(entete)) break;

        const typeFlag = String.fromCharCode(entete[156]);
        const taille = nombre(entete, 124, 12);
        position += TAILLE_BLOC;

        const donnees = tar.subarray(position, position + taille);
        // Le contenu est complété jusqu'au bloc suivant.
        position += Math.ceil(taille / TAILLE_BLOC) * TAILLE_BLOC;

        // Entrées porteuses du nom de l'entrée suivante : mémorisées, jamais écrites.
        if (typeFlag === 'L') {
            nomEnAttente = donnees.toString('utf8').replace(/\0+$/, '');
            continue;
        }
        if (typeFlag === 'x') {
            const chemin = cheminPax(donnees);
            if (chemin) nomEnAttente = chemin;
            continue;
        }
        // En-tête pax global et noms de liens longs : sans objet ici.
        if (typeFlag === 'g' || typeFlag === 'K') continue;

        const prefixe = chaine(entete, 345, 155);
        const nomCourt = chaine(entete, 0, 100);
        const nomBrut = nomEnAttente || (prefixe ? `${prefixe}/${nomCourt}` : nomCourt);
        nomEnAttente = null;

        // Liens matériels et symboliques : ignorés. Une archive de code source
        // n'en contient pas, et Windows exige des privilèges pour les recréer.
        if (typeFlag === '1' || typeFlag === '2') continue;
        // Périphériques et FIFO : hors sujet pour du code source.
        if (typeFlag === '3' || typeFlag === '4' || typeFlag === '6') continue;

        const relatif = retirerComposants(nomBrut, aRetirer);
        if (!relatif) continue;

        const cible = path.resolve(racine, relatif);
        const dansLaCible = path.relative(racine, cible);
        const evasion =
            !dansLaCible ||
            path.isAbsolute(dansLaCible) ||
            dansLaCible === '..' ||
            dansLaCible.startsWith(`..${path.sep}`);
        if (evasion) {
            throw new Error(`Entrée d'archive hors du dossier de destination : ${nomBrut}`);
        }

        if (typeFlag === '5') {
            fs.mkdirSync(cible, { recursive: true });
            continue;
        }

        if (typeFlag === '0' || typeFlag === '\0' || entete[156] === 0) {
            fs.mkdirSync(path.dirname(cible), { recursive: true });
            fs.writeFileSync(cible, donnees);
            fichiers++;
            octets += taille;
        }
    }

    if (fichiers === 0) {
        throw new Error('Archive vide ou illisible : aucun fichier extrait.');
    }

    return { fichiers, octets };
}

module.exports = { extraireTarGz };
