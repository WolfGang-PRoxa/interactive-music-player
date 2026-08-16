' ============================================================================
'  Create shortcut.vbs - Double-cliquez sur ce fichier.
'
'  Ouvre l'assistant graphique qui pose, a l'endroit de votre choix, un
'  raccourci de demarrage du bot.
'
'  Ce fichier est un .vbs et non un .bat pour une seule raison : lance par
'  wscript.exe, il n'ouvre aucune console, meme brievement, et n'apparait pas
'  dans la barre des taches. Toute la logique tient dans le fichier
'  tools\create-shortcut.ps1, qui peut aussi etre lance directement.
' ============================================================================
Option Explicit

Dim shell, fileSystem, folder, command

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
folder = fileSystem.GetParentFolderName(WScript.ScriptFullName)

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Sta -File """ & folder & "\tools\create-shortcut.ps1"""

' 0 = fenetre masquee, False = ne pas attendre la fin du script.
shell.Run command, 0, False
