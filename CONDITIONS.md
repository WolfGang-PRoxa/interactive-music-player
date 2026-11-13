# Conditions d'utilisation

**Interactive Music Player**
Dernière mise à jour : 13 novembre 2026

---

## 1. Objet

Interactive Music Player (« le Logiciel ») est un bot Discord de lecture
musicale, distribué sous forme de code source et d'installeur Windows sur
[GitHub](https://github.com/WolfGang-PRoxa/interactive-music-player). Il lit de
la musique dans un salon vocal Discord, atténue automatiquement le volume
lorsqu'une personne prend la parole, et propose un tableau de bord web pour le
piloter.

Les présentes conditions régissent l'obtention, l'installation et l'usage du
Logiciel. Elles complètent — sans les remplacer — les
[Conditions d'utilisation de Discord](https://discord.com/terms), les
[Règles de la communauté Discord](https://discord.com/guidelines) et la
[Politique des développeurs Discord](https://discord.com/developers/docs/policies-and-agreements/developer-policy).

---

## 2. La distribution par auto-hébergement

Ce point conditionne la lecture de tout le reste du document.

Le Logiciel **n'est pas un service en ligne**. Aucune instance publique n'est
proposée : il n'existe aucun lien d'invitation officiel, aucun bot exploité par
l'auteur, aucun compte à créer. Le seul service que l'auteur fait tourner est un
relais de connexion facultatif, qui ne garde rien (voir la
[Politique de confidentialité](CONFIDENTIALITE.md#le-relais-de-connexion)).

Pour utiliser le Logiciel, chaque personne :

1. récupère le code source ou l'installeur Windows depuis le dépôt GitHub ;
2. crée **sa propre application Discord** sur le
   [portail développeur](https://discord.com/developers/applications), avec ses
   propres identifiants ;
3. exécute le Logiciel **sur sa propre machine ou son propre serveur**.

Il en découle une répartition des rôles qui ne varie jamais :

| Rôle | Qui | Responsabilité |
|---|---|---|
| **Auteur** | Le mainteneur du dépôt | Publier le code source. Rien d'autre. |
| **Exploitant** | Toute personne qui installe et fait tourner une instance | L'application Discord, la machine, la configuration, les données, l'usage |
| **Utilisateur final** | Les membres d'un serveur Discord où une instance est invitée | Son propre usage du bot et du tableau de bord |

L'auteur n'exploite aucune instance, n'a accès aux données d'aucune instance, et
n'est partie à aucune relation entre un exploitant et ses utilisateurs. Une
instance rencontrée sur un serveur Discord est exploitée par la personne qui l'y
a invitée — c'est vers elle qu'il faut se tourner pour toute question la
concernant.

---

## 3. Acceptation

Récupérer, installer, exécuter ou modifier le Logiciel vaut acceptation des
présentes conditions. Qui ne les accepte pas doit s'abstenir de l'utiliser et
supprimer les copies en sa possession.

Un exploitant qui invite son instance sur un serveur Discord accepte ces
conditions **pour le compte de ce serveur** et déclare disposer de
l'autorisation nécessaire pour l'y ajouter.

---

## 4. Éligibilité

L'usage du Logiciel suppose de remplir les conditions d'âge de Discord : treize
ans révolus, ou l'âge minimum supérieur exigé par la loi du pays de résidence.

Exploiter une instance suppose en outre la capacité juridique de conclure un
contrat, ou l'accord du représentant légal.

---

## 5. Licence

Le Logiciel est publié sous **licence MIT**. Elle autorise l'usage, la copie, la
modification et la redistribution, y compris à titre commercial, à la condition
de conserver la mention de copyright et le texte de la licence.

Les présentes conditions ne restreignent aucun des droits accordés par la
licence MIT. En cas de contradiction entre les deux textes sur l'étendue des
droits concédés sur le code, **la licence MIT prévaut**.

---

## 6. Obligations de l'exploitant

Faire tourner une instance engage sur les points suivants.

### Secrets et accès

- Le jeton Discord (`DISCORD_TOKEN`) et le secret client
  (`DISCORD_CLIENT_SECRET`) sont **strictement confidentiels**. Leur divulgation
  permet à un tiers de prendre le contrôle du bot sur tous les serveurs où il
  est présent.
- Le tableau de bord est protégé par un jeton unique et partagé
  (`data/dashboard-token`), qui donne **un accès complet** : lecture, réglages,
  fichiers médias, extinction du bot. Le diffuser revient à céder ce contrôle.
- Le tableau de bord n'écoute que sur `127.0.0.1` par défaut. Le passer en
  `HOST=0.0.0.0`, ou l'exposer sur Internet, est une décision de l'exploitant,
  qui en assume les conséquences. Une exposition publique doit passer par un
  proxy inverse avec TLS.
- La variable `MEDIA_ROOTS` élargit le périmètre des fichiers que le tableau de
  bord peut lire sur le disque. Chaque racine ajoutée est un choix explicite.

### Serveurs Discord

- N'inviter le bot que sur des serveurs où l'exploitant en a le droit.
- Informer les membres qu'un bot est présent dans le salon vocal et qu'il réagit
  à la prise de parole.
- Respecter les permissions et l'organisation du serveur hôte.

### Conformité

- Respecter les conditions de Discord, les lois applicables et les droits des
  tiers.
- Assumer la qualité de responsable de traitement au sens du RGPD pour les
  données que son instance manipule (voir la
  [Politique de confidentialité](CONFIDENTIALITE.md)).

---

## 7. Contenu et droits d'auteur

Le Logiciel lit des contenus que **l'exploitant et ses utilisateurs
fournissent** : URL, résultats de recherche, fichiers importés, dossiers locaux.
Il n'héberge, ne distribue et ne met à disposition aucun catalogue musical.

En conséquence :

- L'exploitant et ses utilisateurs sont seuls responsables des droits attachés
  aux contenus qu'ils lisent, importent ou mettent en file d'attente.
- Diffuser une œuvre protégée dans un salon vocal peut relever de la
  représentation publique et exiger une autorisation ou le paiement de droits,
  selon le pays et le contexte. Cette appréciation revient à l'exploitant.
- La récupération de flux depuis des plateformes tierces peut contrevenir aux
  conditions d'utilisation de ces plateformes. Le Logiciel fournit un moyen
  technique ; il ne confère aucun droit et ne se prononce pas sur la licéité
  d'un usage particulier.
- Aucun contournement de mesure technique de protection n'est autorisé.

L'auteur ne procède à aucune modération : il n'a accès à aucune instance et ne
peut ni voir, ni filtrer, ni retirer un contenu lu par une instance tierce.

---

## 8. Usages interdits

Il est interdit d'utiliser le Logiciel pour :

- enfreindre les conditions de Discord, ses règles de communauté ou sa politique
  développeur ;
- diffuser des contenus illicites, ou porter atteinte aux droits d'un tiers ;
- harceler, menacer ou nuire à une personne ou à un groupe ;
- perturber un serveur Discord : spam, raid, contournement de sanction,
  saturation d'un salon vocal ;
- automatiser un compte utilisateur Discord (*self-bot*), pratique interdite par
  Discord ;
- collecter des données de membres Discord au-delà de ce que le fonctionnement
  décrit exige ;
- contourner les protections d'accès du tableau de bord, ou accéder à des
  fichiers hors des racines autorisées ;
- présenter une instance modifiée comme officielle, ou laisser croire à une
  affiliation avec l'auteur, avec Discord ou avec une plateforme musicale.

---

## 9. Services tiers

Le Logiciel dialogue avec des services indépendants, chacun régi par ses propres
conditions :

| Service | Rôle |
|---|---|
| Discord | Plateforme hôte, connexion vocale, authentification OAuth2 |
| YouTube, Spotify, SoundCloud, Apple Music | Résolution des recherches et des flux |
| GitHub | Distribution du code et de l'installeur, vérification des mises à jour |
| Cloudflare | Partage du tableau de bord par un tunnel, relais de connexion |

Aucun de ces services n'est affilié au Logiciel, ne le parraine ni ne le
soutient. Les marques citées appartiennent à leurs détenteurs respectifs.

Ces services peuvent modifier leurs interfaces, restreindre ou interrompre
l'accès à tout moment, sans préavis et sans recours. Une fonctionnalité qui
cesse de fonctionner pour cette raison ne constitue ni un défaut du Logiciel, ni
un manquement de l'auteur.

---

## 10. Données personnelles

Le traitement des données est décrit dans la
[Politique de confidentialité](CONFIDENTIALITE.md), qui fait partie intégrante
des présentes conditions.

En résumé : **l'auteur ne collecte rien**. Toutes les données restent sur la
machine de l'exploitant, dans le dossier `data/`. Le Logiciel n'envoie aucune
télémétrie, aucune statistique d'usage, aucun rapport d'erreur.

---

## 11. Disponibilité, support et mises à jour

Le Logiciel est fourni **en l'état**, sans engagement de niveau de service.

- Aucune obligation de maintenance, de correction ou de compatibilité future.
- Aucun support garanti. Les
  [issues GitHub](https://github.com/WolfGang-PRoxa/interactive-music-player/issues)
  sont le seul canal, sans délai de réponse promis.
- Le développement peut être suspendu ou abandonné à tout moment. La licence MIT
  laisse alors chacun libre de reprendre le code.
- Une mise à jour peut modifier ou retirer une fonctionnalité, changer un format
  de fichier, ou rendre une configuration existante caduque. Il appartient à
  l'exploitant de sauvegarder son dossier `data/` avant toute montée de version.

---

## 12. Garanties et responsabilité

**Absence de garantie.** Le Logiciel est fourni « tel quel », sans garantie
d'aucune sorte, expresse ou implicite, notamment de qualité marchande,
d'adéquation à un usage particulier ou d'absence de contrefaçon. Aucune garantie
n'est donnée quant à un fonctionnement ininterrompu, exempt d'erreur, ou à
l'absence de perte de données.

**Limitation de responsabilité.** Dans la mesure permise par la loi, l'auteur ne
saurait être tenu responsable d'un quelconque dommage — direct, indirect,
accessoire, spécial ou consécutif — découlant de l'usage ou de l'impossibilité
d'user du Logiciel : perte de données, perte d'exploitation, sanction infligée
par Discord ou par une plateforme tierce, réclamation d'un ayant droit, atteinte
à la sécurité d'une machine, ou compromission d'un jeton.

**Garantie de l'exploitant.** L'exploitant garantit l'auteur contre toute
réclamation d'un tiers née de l'usage qu'il fait du Logiciel ou des contenus
qu'il diffuse.

Ces limitations ne s'appliquent pas en cas de dol ou de faute lourde, ni aux
préjudices que la loi interdit d'exclure. Les droits impératifs reconnus aux
consommateurs demeurent réservés.

---

## 13. Résiliation

Ces conditions s'appliquent tant que le Logiciel est détenu ou exploité.

Un exploitant y met fin en retirant le bot des serveurs Discord, en arrêtant
l'instance, en supprimant le dossier `data/` et en désinstallant le Logiciel.

Les articles 7, 9, 10 et 12 survivent à la résiliation.

---

## 14. Modifications

Ces conditions peuvent être révisées. La version applicable est celle publiée
sur la branche `main` du dépôt, dont l'historique Git tient lieu de journal des
modifications. La date en tête de document signale la dernière révision.

Continuer d'utiliser le Logiciel après une révision vaut acceptation de
celle-ci.

---

## 15. Divers

**Droit applicable.** Droit français, sans préjudice des règles impératives de
protection des consommateurs du pays de résidence de l'utilisateur.

**Autonomie des clauses.** L'invalidité d'une clause n'affecte pas les autres,
qui demeurent applicables.

**Absence de renonciation.** Ne pas se prévaloir d'une clause ne vaut pas
renonciation à s'en prévaloir ultérieurement.

**Intégralité.** Ces conditions et la
[Politique de confidentialité](CONFIDENTIALITE.md) constituent l'accord complet
relatif à l'usage du Logiciel, la licence MIT régissant les droits sur le code.

---

## 16. Contact

Toute question relative aux présentes conditions passe par les
[issues GitHub du dépôt](https://github.com/WolfGang-PRoxa/interactive-music-player/issues).

Pour une question portant sur une instance particulière rencontrée sur un
serveur Discord, s'adresser à la personne qui l'y a invitée : elle seule en est
l'exploitant.

---

*[English version](TERMS.md) · [Politique de confidentialité](CONFIDENTIALITE.md)*
