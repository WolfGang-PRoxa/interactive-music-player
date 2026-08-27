/**
 * LocalFilePlayer — Gestion des fichiers audio locaux et des dossiers-playlists.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

class LocalFilePlayer {
    /**
     * Vérifie si un chemin est un fichier audio supporté.
     * @param {string} filePath
     * @returns {boolean}
     */
    static isAudioFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        return config.supportedExtensions.includes(ext);
    }

    /**
     * Scanne un dossier pour trouver tous les fichiers audio.
     * @param {string} dirPath - Chemin du dossier
     * @param {boolean} recursive - Scanner les sous-dossiers
     * @returns {string[]} Liste des chemins absolus des fichiers audio
     */
    static scanDirectory(dirPath, recursive = true) {
        const resolvedPath = path.resolve(dirPath);

        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`The folder does not exist: ${resolvedPath}`);
        }

        const stat = fs.statSync(resolvedPath);
        if (!stat.isDirectory()) {
            // C'est un fichier unique
            if (LocalFilePlayer.isAudioFile(resolvedPath)) {
                return [resolvedPath];
            }
            throw new Error(`The file is not a supported audio format: ${path.basename(resolvedPath)}`);
        }

        const audioFiles = [];
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(resolvedPath, entry.name);

            if (entry.isFile() && LocalFilePlayer.isAudioFile(fullPath)) {
                audioFiles.push(fullPath);
            } else if (entry.isDirectory() && recursive) {
                audioFiles.push(...LocalFilePlayer.scanDirectory(fullPath, true));
            }
        }

        // Trier par nom
        audioFiles.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

        return audioFiles;
    }

    /**
     * Mélange un tableau (Fisher-Yates shuffle).
     * @param {any[]} array
     * @returns {any[]} Le tableau mélangé (in-place)
     */
    static shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    /**
     * Extrait un nom lisible depuis un chemin de fichier.
     * @param {string} filePath
     * @returns {string} Nom du fichier sans extension
     */
    static getTrackName(filePath) {
        return path.basename(filePath, path.extname(filePath));
    }

    /**
     * Récupère les métadonnées basiques d'un fichier audio.
     * @param {string} filePath
     * @returns {{ title: string, path: string, duration: null }}
     */
    static getTrackInfo(filePath) {
        return {
            title: LocalFilePlayer.getTrackName(filePath),
            path: filePath,
            duration: null, // Pourrait être implémenté avec ffprobe
            source: 'local',
        };
    }
}

module.exports = LocalFilePlayer;
