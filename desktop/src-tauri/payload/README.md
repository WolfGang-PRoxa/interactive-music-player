# Charge utile de l'installeur

Ce dossier est rempli par `npm run payload` (voir `desktop/scripts/build-payload.js`)
juste avant `tauri build` : il reçoit `bot.tar.gz`, qui contient le runtime Node
et le code du bot avec ses dépendances, et `manifest.json`, qui l'identifie.

Rien de cela n'est versionné. Ce fichier n'existe que pour que le dossier soit
présent, Tauri refusant une ressource introuvable — y compris en `tauri dev`, où
la charge utile est absente et où l'application lance le dépôt lui-même.
