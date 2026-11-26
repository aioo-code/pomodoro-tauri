; A private copy of the accepted binary handles update preparation without
; creating a webview or touching application preferences. No process-name kill.
!ifndef POMODORO_UPDATE_ARGS
!define POMODORO_UPDATE_ARGS ""
!endif
!ifndef POMODORO_ICON_VERSION
!define POMODORO_ICON_VERSION "fixture"
!endif
!ifndef POMODORO_ICON_EXTRA_ARGS
!define POMODORO_ICON_EXTRA_ARGS ""
!endif
Var PomodoroUpdateHelper
Var PomodoroUpdateInteractive
!macro PomodoroPrepareUpdate executablePath
  Push $0
  Push $1
  !ifdef __UNINSTALL__
    StrCpy $PomodoroUpdateHelper "${executablePath}"
  !else
    InitPluginsDir
    ${IfNot} ${FileExists} "$PLUGINSDIR\pomodoro-update.exe"
      File /oname=$PLUGINSDIR\pomodoro-update.exe "${POMODORO_UPDATE_BINARY}"
    ${EndIf}
    StrCpy $PomodoroUpdateHelper "$PLUGINSDIR\pomodoro-update.exe"
  !endif
  nsExec::ExecToStack /TIMEOUT=60000 '$\"$PomodoroUpdateHelper$\" --prepare-update $\"${executablePath}$\" ${POMODORO_UPDATE_ARGS} --check'
  Pop $0
  Pop $1
  ${If} $0 == 10
    StrCpy $PomodoroUpdateInteractive 1
    IfSilent 0 +2
      StrCpy $PomodoroUpdateInteractive 0
    ClearErrors
    ${GetOptions} $CMDLINE "/P" $1
    ${IfNot} ${Errors}
      StrCpy $PomodoroUpdateInteractive 0
    ${EndIf}
    ${If} $PomodoroUpdateInteractive == 1
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "继续安装需要关闭正在运行的番茄时钟。当前计时将结束，设置和使用记录会保留。是否关闭并继续？" IDOK +3
      SetErrorLevel 1
      Quit
    ${EndIf}
    DetailPrint "正在保存记录并关闭番茄时钟…"
    nsExec::ExecToStack /TIMEOUT=60000 '$\"$PomodoroUpdateHelper$\" --prepare-update $\"${executablePath}$\" ${POMODORO_UPDATE_ARGS}'
    Pop $0
    Pop $1
  ${EndIf}
  ${If} $0 != 0
    IfSilent +2 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "番茄时钟未能正常退出，请手动关闭后重试。安装尚未覆盖程序文件。"
    SetErrorLevel 2
    Abort
  ${EndIf}
  Pop $1
  Pop $0
!macroend

; Before the maintenance page can launch an older uninstaller, close its app.
; Older uninstallers only know how to refuse a running instance.
!ifdef POMODORO_UPDATE_BINARY
!define MUI_CUSTOMFUNCTION_GUIINIT PomodoroUpdateGuiInit
Function PomodoroUpdateGuiInit
  IfSilent 0 +2
    Return
  !insertmacro PomodoroPrepareUpdate "$INSTDIR\pomodoro-connected.exe"
FunctionEnd
!endif

; Final guards also cover files held by unrelated programs. Never force-kill them.
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executablePath productName
  !insertmacro PomodoroPrepareUpdate "${executablePath}"
  System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "${BUNDLEID}-sim") p .r0'
  ${If} $0 P<> 0
    System::Call 'kernel32::CloseHandle(p r0)'
    IfSilent +2 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "仍有番茄时钟实例未能正常关闭，请从系统托盘退出后重试。"
    SetErrorLevel 2
    Abort
  ${EndIf}
  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 != ""
    !insertmacro RestartManager_RegisterFile $R0 "${executablePath}"
    ${If} $0 = 0
      System::Call 'RSTRTMGR::RmGetList(p R0, *i .r1, *i .r2, p 0, *i .r3) i .r0'
      ${If} $0 = 234
        !insertmacro RestartManager_EndSession $R0
        IfSilent +2 0
          MessageBox MB_OK|MB_ICONEXCLAMATION "程序文件仍在使用中，请先退出番茄时钟后重试。"
        SetErrorLevel 2
        Abort
      ${EndIf}
    ${EndIf}
    !insertmacro RestartManager_EndSession $R0
  ${EndIf}
!macroend

; Migration is local to the installing user. No user data is shipped in the installer.
!ifndef POMODORO_OLD_ROAMING
!define POMODORO_OLD_ROAMING "$LOCALAPPDATA\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\${BUNDLEID}"
!endif
!ifndef POMODORO_NEW_ROAMING
!define POMODORO_NEW_ROAMING "$APPDATA\${BUNDLEID}"
!endif
!ifndef POMODORO_OLD_LOCAL
!define POMODORO_OLD_LOCAL "$LOCALAPPDATA\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\${BUNDLEID}"
!endif
!ifndef POMODORO_NEW_LOCAL
!define POMODORO_NEW_LOCAL "$LOCALAPPDATA\${BUNDLEID}"
!endif

!macro PomodoroCopyProfileIfAbsent source destination
  ${IfNot} ${FileExists} "${destination}\."
  ${AndIf} ${FileExists} "${source}\."
    CreateDirectory "${destination}"
    ClearErrors
    CopyFiles /SILENT "${source}\*.*" "${destination}"
    ${If} ${Errors}
      DetailPrint "旧版数据接续未能全部完成，原始数据仍保留在原位置。"
    ${Else}
      DetailPrint "已接续旧开发版数据，原始目录保留。"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro PomodoroCopyProfileIfAbsent "${POMODORO_OLD_ROAMING}" "${POMODORO_NEW_ROAMING}"
  !insertmacro PomodoroCopyProfileIfAbsent "${POMODORO_OLD_LOCAL}" "${POMODORO_NEW_LOCAL}"
  StrCpy $PomodoroIconInstalled 1
  Call PomodoroRefreshShortcutIcons
!macroend

Var PomodoroIconInstalled
Function PomodoroRefreshShortcutIcons
  ${If} $PomodoroIconInstalled == 1
  ${AndIf} $INSTDIR != ""
  ${AndIf} ${FileExists} "$INSTDIR\scripts\refresh-shortcut-icons.ps1"
  ${AndIf} ${FileExists} "$INSTDIR\pomodoro-app-icon-${POMODORO_ICON_VERSION}.ico"
    Push $0
    Push $1
    nsExec::ExecToStack /TIMEOUT=15000 '$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $\"$INSTDIR\scripts\refresh-shortcut-icons.ps1$\" -InstallDirectory $\"$INSTDIR$\" -IconPath $\"$INSTDIR\pomodoro-app-icon-${POMODORO_ICON_VERSION}.ico$\" ${POMODORO_ICON_EXTRA_ARGS}'
    Pop $0
    Pop $1
    ${If} $0 != 0
      DetailPrint "快捷方式图标刷新未完成，程序文件已安装。"
    ${EndIf}
    Pop $1
    Pop $0
  ${EndIf}
FunctionEnd

; The finish page may create a desktop link after POSTINSTALL ran.
Function .onGUIEnd
  Call PomodoroRefreshShortcutIcons
FunctionEnd
