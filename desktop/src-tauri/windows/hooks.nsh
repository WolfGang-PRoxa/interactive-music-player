; Crochets de l'installeur NSIS (bundle.windows.nsis.installerHooks).
;
; Windows garde en cache l'icône d'un exécutable et des raccourcis qui le
; visent, sous leur chemin. Une mise à jour remplace l'exécutable au même
; endroit : sans prévenir l'Explorateur, le raccourci du bureau, l'épingle de
; la barre des tâches et le menu Démarrer gardaient l'icône de la version
; précédente — celle de la 0.0.1, sur fond noir, après la mise à jour vers
; la 0.0.3.
;
; SHChangeNotify(SHCNE_ASSOCCHANGED) demande à l'Explorateur de relire les
; icônes ; `ie4uinit -show` vide le cache d'icônes de l'utilisateur, ce que
; Windows 10 et 11 ne font pas toujours sur la seule notification. Les deux
; sont sans effet sur une première installation, et un échec n'interrompt rien.

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
  Pop $0
!macroend
