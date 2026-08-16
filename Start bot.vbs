' ============================================================================
'  Start bot.vbs - Double-cliquez sur ce fichier.
'
'  Demarre le bot sans passer par un raccourci : meme comportement que le .lnk
'  cree par l'assistant, mais depuis le dossier du projet. Utile quand aucun
'  raccourci n'a ete pose, ou apres avoir deplace le projet.
'
'  Ce fichier est un .vbs et non un .bat pour une seule raison : lance par
'  wscript.exe, il n'ouvre aucune console, meme brievement, et n'apparait pas
'  dans la barre des taches. Toute la logique - verifications, installation,
'  demarrage - tient dans tools\start-bot.ps1, qui peut aussi etre lance
'  directement.
' ============================================================================
Option Explicit

Dim shell, fileSystem, folder, command

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
folder = fileSystem.GetParentFolderName(WScript.ScriptFullName)

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Sta -File """ & folder & "\tools\start-bot.ps1"""

' 0 = fenetre masquee, False = ne pas attendre la fin du script.
shell.Run command, 0, False
