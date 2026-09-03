; NSIS hooks compiled into the Windows installer and its uninstaller
; (`bundle.windows.nsis.installerHooks` in tauri.conf.json). tauri-bundler's installer.nsi includes
; this file and inserts each macro it finds at a fixed point. NSIS_HOOK_PREINSTALL and
; NSIS_HOOK_POSTINSTALL wrap the install section, NSIS_HOOK_PREUNINSTALL and NSIS_HOOK_POSTUNINSTALL
; wrap the uninstall section. Only the pre-uninstall one is defined here.
;
; The two variables it reads, $DeleteAppDataCheckboxState and $UpdateMode, belong to the template,
; not to this file. If a tauri-cli bump renames either, makensis fails on an undeclared variable and
; the Windows release legs go red, which is the wanted outcome. A hook that quietly stopped running
; would put the data loss below back without anything saying so.

!macro NSIS_HOOK_PREUNINSTALL
    ; The uninstaller's confirm page carries a "Delete the application data" checkbox the template
    ; adds. Ticked, it removes %APPDATA%\com.kavynex.app and %LOCALAPPDATA%\com.kavynex.app whole.
    ; That is the database, every automatic .bak generation, the .pre-import undo copy and the
    ; cache, in one click, and the checkbox text says none of that. The comments in the database
    ; cannot be fetched again for a video YouTube has since removed. It happened once, on the
    ; v1.5.0 install of 2026-08-26, and the database came back only through file recovery software.
    ;
    ; So this asks once more, naming what goes, before the section that deletes runs. "No" clears
    ; the state and the uninstall proceeds keeping the data, exactly as an unticked box would.
    ;
    ; The updater runs the uninstaller with /UPDATE and never shows the confirm page, and the
    ; template guards its own deletion on $UpdateMode too. The same guard here means an update can
    ; never prompt.
    ${If} $DeleteAppDataCheckboxState = 1
    ${AndIf} $UpdateMode <> 1
        MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "You ticked Delete the application data.$\r$\n$\r$\nThat removes the Kavynex database and every automatic backup of it. Your channels, titles, watched state and every saved comment go with it, and comments saved for a video that is no longer on YouTube cannot be downloaded again.$\r$\n$\r$\nYour library folder (the media files, thumbnails and live chat replays) is not touched either way, but without the database Kavynex cannot tell which video each file belongs to.$\r$\n$\r$\nDelete the database and its backups?" IDYES +2
        StrCpy $DeleteAppDataCheckboxState 0
    ${EndIf}
!macroend
