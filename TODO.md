- [x] Actuellement, on ne propose pas de formats de vidéo, dans le menu déroulant "format" de la box "ajouter un fichier". Si un format vidéo est sélectionné et que le lien inséré dans l'input correspond uniquement à un audio, alors on créé une vidéo noire combinée avec l'audio. Sinon, la vidéo se télécharge normalement.

- [x] Sur téléphone et tablette, on a déjà fait en sorte que lors du drag and drop, les éléments soient réellement drag par la souris (ils sont dessinés dans la souris de l'utilisateur lors du drag), mais pas sur PC. Il faudrait faire la même chose sur PC.

- [x] Dans le dashboard, recense tous les endroits dans le code ou on se sert de l'image de itunes qui vient de wikipedia il me semble : "https://upload.wikimedia.org/wikipedia/commons/2/2a/ITunes_12.2_logo.png" pour qu'à partir de maintenant, on utilise l'image qu'on a en local qui se trouve ici : src\web\public\img\itunes-fallback.png. Si tu en trouves une de meilleure qualité sur internet, tu peux la télécharger et la mettre dans le dossier src\web\public\img\

- [x] les indicateurs de décibels dans la box volume et diffusion doivent constitués des boutons qui ouvre la même type de vue (avec slider et LUFS mesuré) que le sous-menu du volume LUFS d'un menu clic droit pour l'élément (le fichier) qui est en cours de lecture.

- [x] Dans le menu clic droit des éléments, sous-menu « insérer une transition » : fait pour les playlists — destination au choix (autre playlist ou file d attente), insertion avant ou après la ligne cliquée, déplaçable seulement dans sa playlist, consommée à la lecture.

- [ ] La même chose dans la file d attente. Elle n a pas de forme rangée où inscrire un aiguillage : ses titres vivent dans le lecteur, et n y sont recopiés que le temps qu une playlist lui prenne la place. Il lui faut donc d abord une liste persistante, comme en ont les playlists.
