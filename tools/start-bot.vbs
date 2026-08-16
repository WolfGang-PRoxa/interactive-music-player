' ============================================================================
'  start-bot.vbs - Cible du raccourci cree par l'assistant.
'
'  Seul role : appeler start-bot.ps1 avec un style de fenetre 0, c'est-a-dire
'  sans creer la moindre console. C'est le seul moyen, sous Windows, de lancer
'  un script sans qu'une fenetre n'apparaisse ne serait-ce qu'un instant a
'  l'ecran ou dans la barre des taches : un .bat ou un .lnk vers powershell.exe
'  fait toujours clignoter un terminal avant de le masquer.
'
'  Toute la logique - verifications, installation, demarrage - est dans le
'  fichier start-bot.ps1 voisin, qui peut aussi etre lance directement.
' ============================================================================
Option Explicit

Dim shell, fileSystem, folder, command

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
folder = fileSystem.GetParentFolderName(WScript.ScriptFullName)

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Sta -File """ & folder & "\start-bot.ps1"""

' 0 = fenetre masquee, False = ne pas attendre la fin du script.
shell.Run command, 0, False
