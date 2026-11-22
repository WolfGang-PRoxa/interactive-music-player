# Identité visuelle

Les images de l'application Discord, telles qu'elles sont posées dans le
portail des développeurs (onglet **Bot**).

| Fichier                              | Usage                                                                                                       | Taille                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| `icon.svg` / `icon-1024.png`         | Ancienne icône du bot (jusqu'au 2026-11-21)                                                                 | 1024 × 1024              |
| `banner.svg` / `banner-1360x480.png` | Bannière du profil du bot                                                                                   | 1360 × 480 (format 17:6) |
| `app-icon.svg` / `app-icon-1024.png` | Icône de l'application de bureau et, depuis le 2026-11-21, du bot sur le portail Discord (fond transparent) | 1024 × 1024              |

Les SVG sont les sources : les PNG en sont le rendu à taille réelle. Pour en
refaire un après une retouche, ouvrir le SVG dans un navigateur et en faire une
capture à sa taille, ou passer par un convertisseur (`rsvg-convert`, Inkscape).

L'idée : une note de musique au-dessus d'un égaliseur dont les barres
s'abaissent au centre, là où quelqu'un parle. C'est l'atténuation automatique
du volume, la fonction qui distingue le bot.

`app-icon.svg` est la source de l'icône « verre » de l'application : le dessin
de `src/web/public/favicons/favicon-glassmorphism.svg`, figé, sur fond
transparent, avec la double croche retouchée (le commentaire en tête du fichier
dit quoi). `app-icon-1024.png` en est le rendu. Les icônes de
`desktop/src-tauri/icons/` s'en régénèrent avec
`npx tauri icon ../branding/app-icon-1024.png -o <dossier>` lancé dans
`desktop/`, en ne gardant que les fichiers listés dans `tauri.conf.json`. La
fenêtre de lancement affiche `desktop/ui/logo.png`, sa version 256 px.

Ce dossier n'entre pas dans l'installeur Windows (voir
`desktop/scripts/build-payload.js`).
